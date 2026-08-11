import { describe, it, expect } from 'bun:test';
import { isFreshAuthRequired, withFreshAuthRetry, createDeviceKeyServiceOps } from '../../src/auth/deviceKey/serviceOps';
import { runUnlock, OnboardingDeps } from '../../src/auth/deviceKey/onboarding';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal, DEVICE_KEY_KDF_VERSION } from '../../src/auth/deviceKey/crypto';
import type { CeremonyTransport, UnlockRequest, UnlockSuccess } from '../../src/auth/deviceKey/ceremonyTransport';
import type { ServiceClient, KeyWrapperMetadata, KeyWrapperPayload } from '../../src/service/serviceClient';
import type { AuthService } from '../../src/auth/authService';
import { CapyError, ERROR_CODES } from '../../src/types/index';

/** The exact error shape serviceClient mints from a 403 FreshAuthRequiredError body. */
const freshAuth403 = () =>
  new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
    status: 403,
    detail: 'token too old',
    code: ERROR_CODES.FRESH_AUTH_REQUIRED,
    data: {
      error: 'token too old',
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      remediation: 'refresh_and_retry',
      max_token_age_seconds: 300,
    },
  });

describe('FRESH_AUTH_REQUIRED retry dance (CAP-379 contract)', () => {
  it('recognises the coded 403 by structured fields only', () => {
    expect(isFreshAuthRequired(freshAuth403())).toBe(true);
  });

  it('does NOT match on the code alone when the remediation enum is absent', () => {
    const noRemediation = new CapyError('x', ERROR_CODES.PERMISSION_DENIED, {
      status: 403,
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED },
    });
    expect(isFreshAuthRequired(noRemediation)).toBe(false);
  });

  it('does not match other 403s, other codes, or non-CapyErrors', () => {
    expect(
      isFreshAuthRequired(
        new CapyError('x', ERROR_CODES.PERMISSION_DENIED, {
          status: 403,
          code: ERROR_CODES.MEMBERSHIP_REVOKED,
        }),
      ),
    ).toBe(false);
    expect(isFreshAuthRequired(new CapyError('x', ERROR_CODES.NETWORK_ERROR))).toBe(false);
    expect(isFreshAuthRequired(new Error('token too old'))).toBe(false);
  });

  it('forces one refresh and retries exactly once on the coded refusal', async () => {
    let refreshes = 0;
    let attempts = 0;
    const result = await withFreshAuthRetry(
      async () => {
        refreshes++;
        return true;
      },
      async () => {
        attempts++;
        if (attempts === 1) throw freshAuth403();
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
  });

  it('a second coded refusal propagates — the dance is one round, never a loop', async () => {
    let refreshes = 0;
    let attempts = 0;
    try {
      await withFreshAuthRetry(
        async () => {
          refreshes++;
          return true;
        },
        async () => {
          attempts++;
          throw freshAuth403();
        },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(isFreshAuthRequired(err)).toBe(true);
    }
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
  });

  it('unrelated failures pass through with no refresh', async () => {
    let refreshes = 0;
    try {
      await withFreshAuthRetry(
        async () => {
          refreshes++;
          return true;
        },
        async () => {
          throw new CapyError('down', ERROR_CODES.NETWORK_ERROR);
        },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.NETWORK_ERROR);
    }
    expect(refreshes).toBe(0);
  });
});

/**
 * Regression coverage for the CLI gap the service-side fix exposed
 * (audit-browser-direct-api.md, "CLI fresh-auth retry follow-up"): GET
 * /wrappers/:id now fresh-auth gates door rows the same as it always gated
 * key_enc rows, but `UserWrapperOps.fetchWrapper` — wired here in
 * `createDeviceKeyServiceOps`, and the only thing `runUnlock` calls to
 * download a door's wrapping parameters — was passed through to
 * `serviceClient.fetchWrapper` RAW, with no retry. Before the fix, any
 * `capy run`/`capy status` unlock on a session older than
 * CAPY_FRESH_AUTH_MAX_AGE_SECONDS (default 300s) would surface the coded
 * 403 as a hard failure instead of transparently refreshing and retrying.
 */
describe('createDeviceKeyServiceOps.ops.fetchWrapper — the fix', () => {
  const freshAuth403 = () =>
    new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
      status: 403,
      code: ERROR_CODES.FRESH_AUTH_REQUIRED,
      data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED, remediation: 'refresh_and_retry', max_token_age_seconds: 300 },
    });

  it('retries once on the coded fresh-auth 403 and returns the payload on success', async () => {
    let calls = 0;
    let refreshes = 0;
    const fakeServiceClient = {
      fetchWrapper: async (id: string) => {
        calls++;
        if (calls === 1) throw freshAuth403();
        return { id, type: 'wrapped_k_local' } as unknown as KeyWrapperPayload;
      },
    } as unknown as ServiceClient;
    const fakeAuthService = {
      refreshToken: async () => {
        refreshes++;
        return true;
      },
    } as unknown as AuthService;

    const { ops } = createDeviceKeyServiceOps(fakeServiceClient, fakeAuthService);
    const result = await ops.fetchWrapper('door-1');

    expect(result.id).toBe('door-1');
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
  });
});

describe('regression: an ordinary unlock survives a stale session', () => {
  it('runUnlock completes — not an error — when the door fetch is refused once for stale auth, then succeeds after refresh', async () => {
    const USER = 'user-stale-session';
    const credentialId = 'cred-stale-session';
    const prfSalt = Buffer.alloc(32, 1);
    const prfOutput = Buffer.alloc(32, 9);
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
    const wrapped = wrapKLocal(Buffer.alloc(32, 7), kek, deviceKeyWrapAAD(USER, credentialId));

    const doorMetadata: KeyWrapperMetadata = {
      id: 'door-1',
      type: 'wrapped_k_local',
      credential_id: credentialId,
      kdf_version: DEVICE_KEY_KDF_VERSION,
      is_seed: true,
      verified_at: new Date().toISOString(),
      organization_id: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'pending',
    };
    const doorPayload: KeyWrapperPayload = {
      ...doorMetadata,
      wrapped_k_local: wrapped.wrappedKLocal,
      iv: wrapped.iv,
      prf_salt: prfSalt.toString('base64'),
    };

    let fetchCalls = 0;
    let refreshCalls = 0;
    const fakeServiceClient = {
      listWrappers: async () => [doorMetadata],
      fetchWrapper: async (id: string) => {
        fetchCalls++;
        // First call: simulate the service-side fix — a stale session's
        // door read is now refused exactly like key_enc always was.
        if (fetchCalls === 1) {
          throw new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
            status: 403,
            code: ERROR_CODES.FRESH_AUTH_REQUIRED,
            data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED, remediation: 'refresh_and_retry', max_token_age_seconds: 300 },
          });
        }
        expect(id).toBe(doorMetadata.id);
        return doorPayload;
      },
    } as unknown as ServiceClient;
    const fakeAuthService = {
      refreshToken: async () => {
        refreshCalls++;
        return true;
      },
    } as unknown as AuthService;

    const { ops, opsForOrg } = createDeviceKeyServiceOps(fakeServiceClient, fakeAuthService);

    const ceremony: CeremonyTransport = {
      requestEnrollment: async () => {
        throw new Error('not exercised by this test');
      },
      requestUnlock: async (_req: UnlockRequest): Promise<UnlockSuccess> => ({
        ok: true,
        credentialId,
        prfOutput: prfOutput.toString('base64'),
      }),
    };

    const deps: OnboardingDeps = {
      userId: USER,
      organizations: [],
      activeOrgId: null,
      ceremony,
      ops,
      opsForOrg,
    };

    const result = await runUnlock(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentialId).toBe(credentialId);
      expect(result.orgs).toEqual([]);
    }
    // Exactly the CAP-379 contract: one refusal, one forced refresh, one retry.
    expect(fetchCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });
});
