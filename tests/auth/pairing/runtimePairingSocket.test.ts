import { describe, expect, mock, test } from 'bun:test';
import { resolveRuntimePairingSocket } from '../../../src/auth/pairing/runtimePairingSocket';
import type { RuntimePairingRecordV1 } from '../../../src/auth/pairing/runtimePairing';

const record: RuntimePairingRecordV1 = {
  version: 1, userId: 'user_test', credentialId: 'cred_test', socketPath: '/old.sock',
  expiresAt: 0, pairedAt: '2026-09-06T00:00:00.000Z',
  filesystemCustody: { environment: 'development', orgId: 'org_test', path: '/private/local.key', sha256: '0'.repeat(64) },
};

describe('runtime pairing socket composition', () => {
  test('restores the bound socket using the caller identity and current environment', async () => {
    const recover = mock(async () => ({ ...record, socketPath: '/restored.sock' }));
    const socket = await resolveRuntimePairingSocket('/old.sock', 'user_test', {
      read: () => record, recover, environment: () => 'development',
    });
    expect(socket).toBe('/restored.sock');
    expect(recover.mock.calls).toEqual([[{ expectedUserId: 'user_test', environment: 'development' }]]);
  });

  test.each([null, { ...record, filesystemCustody: undefined }])('does not infer custody from missing or legacy metadata: %j', async (binding) => {
    const recover = mock(async () => record);
    expect(await resolveRuntimePairingSocket('/old.sock', 'user_test', {
      read: () => binding, recover, environment: () => 'development',
    })).toBe('/old.sock');
    expect(recover).not.toHaveBeenCalled();
  });

  test('does not replace an explicit unrelated ephemeral grant', async () => {
    const recover = mock(async () => record);
    expect(await resolveRuntimePairingSocket('/other.sock', 'user_test', {
      read: () => record, recover, environment: () => 'development',
    })).toBe('/other.sock');
    expect(recover).not.toHaveBeenCalled();
  });

  test('does not swallow identity, environment, or custody failures', async () => {
    const failure = new Error('custody refused');
    const recover = mock(async () => { throw failure; });
    await expect(resolveRuntimePairingSocket('/old.sock', 'user_other', {
      read: () => record, recover, environment: () => 'staging',
    })).rejects.toBe(failure);
    expect(recover.mock.calls).toEqual([[{ expectedUserId: 'user_other', environment: 'staging' }]]);
  });
});
