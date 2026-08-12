/**
 * CAP-409 (hardened) — `resolveGrantedMaterialFromAnswer`'s pure ceremony
 * logic. Mirrors `tests/auth/deviceKey/grant.test.ts`'s own style exactly
 * (FakeOps, a real wrap/unwrap round trip via the production crypto
 * primitives) — this file only exercises the pure core (injected `ops`), so
 * it needs no mock.module and is not registered in run-tests.sh's
 * ISOLATED_FILES. `resolvePairedKeyMaterial` (the production wrapper that
 * builds a real AuthService/ServiceClient) is exercised end to end instead
 * by `tests/auth/pairing/pairE2E.e2e.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { resolveGrantedMaterialFromAnswer } from '../../../src/auth/pairing/pairKeyMaterial';
import type { PairMachineAnswer } from '../../../src/auth/pairing/pairContract';
import type { GrantOps } from '../../../src/auth/deviceKey/grant';
import { createDeviceKeyServiceOps } from '../../../src/auth/deviceKey/serviceOps';
import {
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  wrapKLocal,
  DEVICE_KEY_KDF_VERSION,
} from '../../../src/auth/deviceKey/crypto';
import { CapyError, ERROR_CODES } from '../../../src/types/index';
import type { ServiceClient, KeyWrapperMetadata, KeyWrapperPayload } from '../../../src/service/serviceClient';
import type { AuthService } from '../../../src/auth/authService';

const USER_ID = 'user-pair-key-1';
const ORG_ID = 'org-pair-key-1';
const CREDENTIAL_ID = 'cred-pair-key-1';

interface BuiltAnswer {
  answer: PairMachineAnswer;
  kLocal: Buffer;
  metadata: KeyWrapperMetadata;
  payload: KeyWrapperPayload;
}

function buildAnswer(overrides: Partial<PairMachineAnswer['keyMaterial']> = {}): BuiltAnswer {
  const kLocal = randomBytes(32);
  const prfSalt = randomBytes(32);
  const prfOutput = randomBytes(32);
  const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
  const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, CREDENTIAL_ID));

  const metadata: KeyWrapperMetadata = {
    id: 'door-pair-key-1',
    type: 'wrapped_k_local',
    credential_id: CREDENTIAL_ID,
    kdf_version: DEVICE_KEY_KDF_VERSION,
    is_seed: true,
    verified_at: new Date().toISOString(),
    organization_id: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
    mirror_state: 'pending',
  };
  const payload: KeyWrapperPayload = {
    ...metadata,
    wrapped_k_local: wrapped.wrappedKLocal,
    iv: wrapped.iv,
    prf_salt: prfSalt.toString('base64'),
  };

  const answer: PairMachineAnswer = {
    v: 1,
    flow: 'pair',
    ceremony: 'machine-pair',
    session: {
      user: { id: USER_ID, email: 'u@example.com' },
      refresh_token: 'rt_1',
      organizations: [{ id: ORG_ID, name: 'Org One' }],
    },
    keyMaterial: {
      orgId: ORG_ID,
      prfOutput: prfOutput.toString('base64'),
      credentialId: CREDENTIAL_ID,
      ...overrides,
    },
  };

  return { answer, kLocal, metadata, payload };
}

class FakeOps implements GrantOps {
  constructor(private rows: KeyWrapperMetadata[], private payloads: Map<string, KeyWrapperPayload>) {}
  async listWrappers(): Promise<KeyWrapperMetadata[]> {
    return this.rows;
  }
  async fetchWrapper(id: string): Promise<KeyWrapperPayload> {
    const p = this.payloads.get(id);
    if (!p) throw new Error(`no such wrapper ${id}`);
    return p;
  }
}

describe('resolveGrantedMaterialFromAnswer', () => {
  // The type itself proves K_local never rides the answer: `PairMachineAnswer
  // ['keyMaterial']` has no `kLocal` field to read (see pairContract.ts).
  // This suite proves the RUNTIME behavior matches: `buildAnswer()` below
  // never constructs one, and resolution still lands on the right K_local
  // purely via the door fetch + local unwrap.
  it('unwraps K_local from the account\'s own door, using only the answer\'s prfOutput/credentialId', async () => {
    const { answer, kLocal, metadata, payload } = buildAnswer();
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));

    const resolved = await resolveGrantedMaterialFromAnswer(answer, ops);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.material.userId).toBe(USER_ID);
      expect(resolved.material.credentialId).toBe(CREDENTIAL_ID);
      expect(resolved.material.kLocal.equals(kLocal)).toBe(true);
    }
  });

  it('no live doors on the account -> coded failure, not a crash', async () => {
    const { answer } = buildAnswer();
    const ops = new FakeOps([], new Map());

    const resolved = await resolveGrantedMaterialFromAnswer(answer, ops);
    expect(resolved).toEqual({ ok: false, code: ERROR_CODES.WRAPPER_NOT_FOUND });
  });

  it('a tampered/wrong PRF output fails the AEAD unwrap closed', async () => {
    const { answer, metadata, payload } = buildAnswer();
    const tampered: PairMachineAnswer = {
      ...answer,
      keyMaterial: { ...answer.keyMaterial, prfOutput: randomBytes(32).toString('base64') },
    };
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));

    const resolved = await resolveGrantedMaterialFromAnswer(tampered, ops);
    expect(resolved).toEqual({ ok: false, code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED });
  });

  it('a credentialId the account never enrolled fails closed, never falls back to a different door', async () => {
    const { answer, metadata, payload } = buildAnswer();
    const spoofed: PairMachineAnswer = {
      ...answer,
      keyMaterial: { ...answer.keyMaterial, credentialId: 'cred-not-enrolled' },
    };
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));

    const resolved = await resolveGrantedMaterialFromAnswer(spoofed, ops);
    expect(resolved).toEqual({ ok: false, code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED });
  });
});

/**
 * THE THING THIS TASK FLAGGED AS "VERIFY, NOT ASSUME": `installPairedSession`
 * can return WITHOUT ever calling `authenticateSilent` when the sealed
 * `PairMachineAnswerSession.sessions[orgId]` payload already carries an
 * access token that hasn't hit its own ~10-minute `expires_at` yet (see
 * `installPairedSession.ts`'s `cached.expires_at > Date.now()` branch) — and
 * that token can already be several minutes old by the time it reaches this
 * process, since it originated in the browser's own session. This process's
 * own `authenticateSilent(orgId)` call in `resolvePairedKeyMaterial` does
 * NOT fix that on its own either: `SessionLifecycle.acquireSilent` accepts
 * that SAME cached token as good enough (it only checks the token's full
 * expiry, not the service's separate, much narrower fresh-auth window) and
 * can return it without ever touching the network. So the token that
 * reaches `GET /wrappers/:id` can legitimately already be stale relative to
 * the server's fresh-auth gate on the very first attempt.
 *
 * This suite proves the fix actually fires for THIS call site: `ops` here
 * is built through the REAL `createDeviceKeyServiceOps` — the exact
 * production factory `resolvePairedKeyMaterial` uses — wired to a fake
 * `ServiceClient` whose `fetchWrapper` refuses once with the coded
 * `FRESH_AUTH_REQUIRED` 403 before succeeding, and a fake `AuthService`
 * whose `refreshToken()` is the forced-refresh hook `withFreshAuthRetry`
 * calls. If `resolveGrantedMaterialFromAnswer`/`runGrantCeremony` ever
 * regressed to calling `serviceClient.fetchWrapper` directly instead of
 * routing through `ops.fetchWrapper`, this test would fail with an
 * unhandled 403 instead of resolving successfully after exactly one retry.
 */
describe('resolveGrantedMaterialFromAnswer survives a stale (not-yet-expired, but fresh-auth-stale) cached token', () => {
  const freshAuth403 = () =>
    new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
      status: 403,
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED, remediation: 'refresh_and_retry', max_token_age_seconds: 300 },
    });

  it('retries once via a forced refresh and resolves K_local on the second attempt', async () => {
    const { answer, kLocal, metadata, payload } = buildAnswer();

    let listCalls = 0;
    let fetchCalls = 0;
    let refreshCalls = 0;
    const fakeServiceClient = {
      listWrappers: async () => {
        listCalls++;
        return [metadata];
      },
      fetchWrapper: async (id: string) => {
        fetchCalls++;
        // First attempt: simulate the door fetch hitting the server's
        // fresh-auth gate because the session's cached token (installed
        // straight from the sealed answer, per installPairedSession.ts's
        // early-return branch) is already stale relative to the service's
        // narrower fresh-auth window, even though it hasn't fully expired.
        if (fetchCalls === 1) throw freshAuth403();
        expect(id).toBe(metadata.id);
        return payload;
      },
    } as unknown as ServiceClient;
    const fakeAuthService = {
      refreshToken: async () => {
        refreshCalls++;
        return true;
      },
    } as unknown as AuthService;

    // The exact production wiring `resolvePairedKeyMaterial` uses —
    // `createDeviceKeyServiceOps(serviceClient, authService)` — just with
    // fakes standing in for the real network/session singletons.
    const { ops } = createDeviceKeyServiceOps(fakeServiceClient, fakeAuthService);

    const resolved = await resolveGrantedMaterialFromAnswer(answer, ops);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.material.kLocal.equals(kLocal)).toBe(true);
    }
    expect(listCalls).toBe(1);
    // Exactly the CAP-379 contract: one refusal, one forced refresh, one retry.
    expect(fetchCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('a SECOND coded refusal (refresh did not help) propagates as a coded failure, never a crash or a silent fallback', async () => {
    const { answer, metadata } = buildAnswer();

    let fetchCalls = 0;
    let refreshCalls = 0;
    const fakeServiceClient = {
      listWrappers: async () => [metadata],
      fetchWrapper: async () => {
        fetchCalls++;
        throw freshAuth403();
      },
    } as unknown as ServiceClient;
    const fakeAuthService = {
      refreshToken: async () => {
        refreshCalls++;
        return true;
      },
    } as unknown as AuthService;

    const { ops } = createDeviceKeyServiceOps(fakeServiceClient, fakeAuthService);

    const resolved = await resolveGrantedMaterialFromAnswer(answer, ops);

    expect(resolved).toEqual({ ok: false, code: ERROR_CODES.PERMISSION_DENIED });
    expect(fetchCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });
});
