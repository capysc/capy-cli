/**
 * The canned CeremonyTransport implementations (CAP-451): the PRF result is
 * already in hand (bundled into the sandbox-session sealed answer), so these
 * hand it straight back instead of running a second WebAuthn round trip.
 *
 * "Already in hand" is not "well-formed". The result was produced by the same
 * page over the same PRF extension as a relayed answer — it just travelled
 * inside the sealed envelope — so it can arrive empty or short for exactly the
 * reasons a relayed one can, and it reaches deriveDeviceKeyKek just the same.
 * On this rail the resulting throw is swallowed by sandboxCeremony's
 * best-effort catch, so an unguarded payload surfaces as an unexplained
 * key_not_on_device with no trace of the cause. Hence the guard — and hence a
 * realistic 32-byte PRF in the happy paths below, rather than a placeholder
 * string that could never have come off an authenticator.
 */
import { describe, test, expect } from 'bun:test';
import { cannedEnrollmentTransport, cannedUnlockTransport } from '../../../src/auth/deviceKey/cannedCeremony';

/** A PRF evaluation the KDF would actually accept: 32 bytes, base64. */
const PRF = Buffer.alloc(32, 9).toString('base64');

describe('cannedEnrollmentTransport', () => {
  test('requestEnrollment resolves immediately to the pre-obtained result, ignoring the request', async () => {
    const transport = cannedEnrollmentTransport({
      credentialId: 'cred-1',
      prfOutput: PRF,
      backupEligible: true,
      backupState: false,
    });

    const result = await transport.requestEnrollment({ userId: 'user-1', prfSalt: 'irrelevant-salt' });

    expect(result).toEqual({
      ok: true,
      credentialId: 'cred-1',
      prfOutput: PRF,
      backupEligible: true,
      backupState: false,
    });
  });

  test('an empty prfOutput is a transport_error, never a success', async () => {
    const transport = cannedEnrollmentTransport({
      credentialId: 'cred-1',
      prfOutput: '',
      backupEligible: true,
      backupState: false,
    });
    expect(await transport.requestEnrollment({ userId: 'user-1', prfSalt: 'salt' })).toEqual({
      ok: false,
      code: 'transport_error',
    });
  });

  test('requestUnlock is not implemented — the create_org path never calls it', async () => {
    const transport = cannedEnrollmentTransport({
      credentialId: 'cred-1',
      prfOutput: PRF,
      backupEligible: false,
      backupState: false,
    });
    await expect(
      transport.requestUnlock({ userId: 'user-1', candidates: [] }),
    ).rejects.toThrow();
  });
});

describe('cannedUnlockTransport', () => {
  test('requestUnlock resolves immediately to the pre-obtained result, ignoring the candidate list', async () => {
    const transport = cannedUnlockTransport({ credentialId: 'cred-2', prfOutput: PRF });

    const result = await transport.requestUnlock({
      userId: 'user-1',
      candidates: [{ credentialId: 'some-other-cred', prfSalt: 'salt' }],
    });

    expect(result).toEqual({ ok: true, credentialId: 'cred-2', prfOutput: PRF });
  });

  // The regression this guard exists for: a zero-length PRF buffer the page
  // mistook for a real evaluation, arriving as ''. Unguarded it reached the
  // KDF and threw "malformed PRF result" three layers from the cause.
  test('an empty prfOutput is a transport_error, never a success', async () => {
    const transport = cannedUnlockTransport({ credentialId: 'cred-2', prfOutput: '' });
    expect(
      await transport.requestUnlock({ userId: 'user-1', candidates: [] }),
    ).toEqual({ ok: false, code: 'transport_error' });
  });

  test('a short prfOutput is a transport_error — anything but 32 bytes is unusable to the KDF', async () => {
    const transport = cannedUnlockTransport({
      credentialId: 'cred-2',
      prfOutput: Buffer.alloc(16, 9).toString('base64'),
    });
    expect(
      await transport.requestUnlock({ userId: 'user-1', candidates: [] }),
    ).toEqual({ ok: false, code: 'transport_error' });
  });

  test('requestEnrollment is not implemented — the unlock path never calls it', async () => {
    const transport = cannedUnlockTransport({ credentialId: 'cred-2', prfOutput: PRF });
    await expect(
      transport.requestEnrollment({ userId: 'user-1', prfSalt: 'salt' }),
    ).rejects.toThrow();
  });
});
