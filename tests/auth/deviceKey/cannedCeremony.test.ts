/**
 * The canned CeremonyTransport implementations (CAP-451): the PRF result is
 * already in hand (bundled into the sandbox-session sealed answer), so these
 * hand it straight back instead of running a second WebAuthn round trip.
 */
import { describe, test, expect } from 'bun:test';
import { cannedEnrollmentTransport, cannedUnlockTransport } from '../../../src/auth/deviceKey/cannedCeremony';

describe('cannedEnrollmentTransport', () => {
  test('requestEnrollment resolves immediately to the pre-obtained result, ignoring the request', async () => {
    const transport = cannedEnrollmentTransport({
      credentialId: 'cred-1',
      prfOutput: 'prf-1',
      backupEligible: true,
      backupState: false,
    });

    const result = await transport.requestEnrollment({ userId: 'user-1', prfSalt: 'irrelevant-salt' });

    expect(result).toEqual({
      ok: true,
      credentialId: 'cred-1',
      prfOutput: 'prf-1',
      backupEligible: true,
      backupState: false,
    });
  });

  test('requestUnlock is not implemented — the create_org path never calls it', async () => {
    const transport = cannedEnrollmentTransport({
      credentialId: 'cred-1',
      prfOutput: 'prf-1',
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
    const transport = cannedUnlockTransport({ credentialId: 'cred-2', prfOutput: 'prf-2' });

    const result = await transport.requestUnlock({
      userId: 'user-1',
      candidates: [{ credentialId: 'some-other-cred', prfSalt: 'salt' }],
    });

    expect(result).toEqual({ ok: true, credentialId: 'cred-2', prfOutput: 'prf-2' });
  });

  test('requestEnrollment is not implemented — the unlock path never calls it', async () => {
    const transport = cannedUnlockTransport({ credentialId: 'cred-2', prfOutput: 'prf-2' });
    await expect(
      transport.requestEnrollment({ userId: 'user-1', prfSalt: 'salt' }),
    ).rejects.toThrow();
  });
});
