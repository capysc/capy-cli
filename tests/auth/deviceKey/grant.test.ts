/**
 * CAP-384 — the grant ceremony (grant.ts). Pure ceremony logic, no disk: no
 * mock.module, no globalConfig import anywhere in the module under test, so
 * this file needs none of onboarding.ts's homedir mocking and is not
 * registered in run-tests.sh's ISOLATED_FILES.
 */
import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { runGrantCeremony, type GrantOps } from '../../../src/auth/deviceKey/grant';
import {
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  wrapKLocal,
  DEVICE_KEY_KDF_VERSION,
} from '../../../src/auth/deviceKey/crypto';
import type {
  CeremonyTransport,
  CeremonyFailureCode,
  EnrollmentRequest,
  UnlockRequest,
  GrantRequest,
} from '../../../src/auth/deviceKey/ceremonyTransport';
import { CapyError, ERROR_CODES } from '../../../src/types/index';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../../src/service/serviceClient';

const USER = 'user-grant-1';
const CREDENTIAL_ID = 'cred-grant-1';

function buildDoor(kLocal: Buffer): { metadata: KeyWrapperMetadata; payload: KeyWrapperPayload; prfOutput: Buffer } {
  const prfSalt = randomBytes(32);
  const prfOutput = randomBytes(32);
  const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
  const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER, CREDENTIAL_ID));
  const metadata: KeyWrapperMetadata = {
    id: 'door-1',
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
  return { metadata, payload, prfOutput };
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

class FakeCeremony implements CeremonyTransport {
  grantAnswer: { ok: true; credentialId: string; prfOutput: string } | { ok: false; code: CeremonyFailureCode } | null =
    null;

  async requestEnrollment(_req: EnrollmentRequest) {
    throw new Error('not exercised by grant.test.ts');
  }
  async requestUnlock(_req: UnlockRequest) {
    throw new Error('not exercised by grant.test.ts');
  }
  async requestGrant(_req: GrantRequest) {
    if (!this.grantAnswer) throw new Error('grantAnswer not set');
    return this.grantAnswer;
  }
}

describe('runGrantCeremony', () => {
  it('derives the exact same K_local the door was wrapped under, and writes nothing', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload, prfOutput } = buildDoor(kLocal);
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));
    const ceremony = new FakeCeremony();
    ceremony.grantAnswer = { ok: true, credentialId: CREDENTIAL_ID, prfOutput: prfOutput.toString('base64') };

    const outcome = await runGrantCeremony({ userId: USER, ceremony, ops });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.material.userId).toBe(USER);
      expect(outcome.material.credentialId).toBe(CREDENTIAL_ID);
      expect(outcome.material.kLocal.equals(kLocal)).toBe(true);
    }
  });

  it('throws WRAPPER_NOT_FOUND when the account has no live doors — nothing to grant against', async () => {
    const ops = new FakeOps([], new Map());
    const ceremony = new FakeCeremony();

    await expect(runGrantCeremony({ userId: USER, ceremony, ops })).rejects.toMatchObject({
      code: ERROR_CODES.WRAPPER_NOT_FOUND,
    });
  });

  it('a declined ceremony (cancelled) returns {ok:false}, not a throw', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload } = buildDoor(kLocal);
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));
    const ceremony = new FakeCeremony();
    ceremony.grantAnswer = { ok: false, code: 'cancelled' };

    const outcome = await runGrantCeremony({ userId: USER, ceremony, ops });
    expect(outcome).toEqual({ ok: false, code: 'cancelled' });
  });

  it('a ceremony answering with a credential that is not enrolled throws DEVICE_KEY_UNWRAP_FAILED', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload } = buildDoor(kLocal);
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));
    const ceremony = new FakeCeremony();
    ceremony.grantAnswer = { ok: true, credentialId: 'some-other-credential', prfOutput: randomBytes(32).toString('base64') };

    await expect(runGrantCeremony({ userId: USER, ceremony, ops })).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
    });
  });

  it('a tampered/wrong PRF output fails the AEAD unwrap closed — no plausible-looking wrong key is ever returned', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload } = buildDoor(kLocal);
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));
    const ceremony = new FakeCeremony();
    // Right credential id, WRONG prf output.
    ceremony.grantAnswer = { ok: true, credentialId: CREDENTIAL_ID, prfOutput: randomBytes(32).toString('base64') };

    await expect(runGrantCeremony({ userId: USER, ceremony, ops })).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
    });
  });

  it('a transport with no requestGrant implementation fails closed to transport_error, never throws', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload } = buildDoor(kLocal);
    const ops = new FakeOps([metadata], new Map([[metadata.id, payload]]));
    const ceremony = new FakeCeremony();
    (ceremony as { requestGrant?: unknown }).requestGrant = undefined;

    const outcome = await runGrantCeremony({ userId: USER, ceremony, ops });
    expect(outcome).toEqual({ ok: false, code: 'transport_error' });
  });

  it('skips doors with malformed payloads and still succeeds against a complete one', async () => {
    const kLocal = randomBytes(32);
    const { metadata, payload, prfOutput } = buildDoor(kLocal);
    const brokenMetadata: KeyWrapperMetadata = { ...metadata, id: 'door-broken', credential_id: 'cred-broken' };
    const brokenPayload: KeyWrapperPayload = { ...brokenMetadata }; // no wrapped_k_local/iv/prf_salt
    const ops = new FakeOps(
      [metadata, brokenMetadata],
      new Map([[metadata.id, payload], [brokenMetadata.id, brokenPayload]]),
    );
    const ceremony = new FakeCeremony();
    ceremony.grantAnswer = { ok: true, credentialId: CREDENTIAL_ID, prfOutput: prfOutput.toString('base64') };

    const outcome = await runGrantCeremony({ userId: USER, ceremony, ops });
    expect(outcome.ok).toBe(true);
  });
});
