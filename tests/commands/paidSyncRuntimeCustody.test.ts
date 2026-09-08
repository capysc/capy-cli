/** Isolated module-mock test: a fresh paired runtime has no legacy key.enc. */
import { afterEach, expect, mock, test } from 'bun:test';
const report = mock((_value: unknown) => undefined);
const write = mock(() => undefined);
const decryptData = mock(async () => ({ keep_file: JSON.stringify({ version: '3.0', org_id: 'org', project_id: 'project', variables: {} }), env_content: '' }));
const legacyKey = mock(async () => { throw new Error('LEGACY_KEY_ENC_ABSENT'); });
const runtimeKey = mock(async () => 'fixture-key');
const grantOps = { fetchKeyEnc: async () => '', coDecrypt: async () => '' };

mock.module('../../src/core/projectManager', () => ({ ProjectManager: mock(() => ({
  detectProjectState: async () => ({ initialized: true, organizationId: 'org', projectId: 'project', projectName: 'default', userId: 'user_fixture' }),
  readActiveBranch: () => 'development', getEnvPath: () => '/nonexistent-capy-paid-fixture/.env',
  readSyncState: () => null, writeActiveBranch: write,
})) }));
mock.module('../../src/files/fileManager', () => ({ FileManager: mock(() => ({
  readEnvMeta: () => ({ branch: 'development' }), readEnvFile: () => ({}), parseEnvContent: () => ({}),
  writeKeepFile: write, writeEncryptedEnvFile: write, writeSyncState: write, ensureCapyGitignore: write,
})) }));
mock.module('../../src/auth/authService', () => ({ AuthService: mock(() => ({
  setSessionUserId: () => undefined, getValidToken: async () => 'synthetic-token',
  authenticateSilent: async () => ({ success: true, user_id: 'user_fixture', organizations: [{ id: 'org', name: 'fixture-org' }] }),
})) }));
mock.module('../../src/service/serviceClient', () => ({ ServiceClient: mock(() => ({
  setTokenProvider: () => undefined, getDecryptData: decryptData, coDecrypt: async () => ({ plaintext: '' }), wrapOuterLayer: async () => ({ ciphertext: '' }),
})) }));
mock.module('../../src/sync/syncEngine', () => ({ SyncEngine: { DEFAULT_BRANCH: 'development', computeKeepHash: () => 'a'.repeat(64) } }));
mock.module('../../src/git/installGitHooks', () => ({ installGitHooks: write }));
mock.module('../../src/config/globalConfig', () => ({ writeKeepCache: write }));
mock.module('../../src/crypto/keyResolver', () => ({ resolveProjectKey: legacyKey }));
mock.module('../../src/sync/freeSyncKeyResolver', () => ({ resolveFreeSyncProjectKey: runtimeKey }));
mock.module('../../src/auth/deviceKey/grantResolver', () => ({ createGrantResolutionOps: () => grantOps }));

import { SyncCommand } from '../../src/commands/syncCommand';
import { CapyError, ERROR_CODES } from '../../src/types/index';

afterEach(() => {
  for (const fn of [report, write, decryptData, legacyKey, runtimeKey]) fn.mockClear();
  runtimeKey.mockImplementation(async () => 'fixture-key');
});

test('paid sync plan uses the configured runtime grant without requiring legacy key.enc', async () => {
  await new SyncCommand({ expectedUserId: 'user_fixture' }, true, report).execute({ plan: true });
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ ok: true, sync_mode: 'paid', action: 'sync' }));
  expect(runtimeKey).toHaveBeenCalledWith('org', 'project', 'user_fixture', expect.any(Object), grantOps);
  expect(legacyKey).not.toHaveBeenCalled();
  expect(decryptData).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
});

test('unavailable paired custody fails closed before fetch/writes, with no legacy fallback', async () => {
  runtimeKey.mockImplementation(async () => { throw new CapyError('Fixture grant unavailable', ERROR_CODES.PERMISSION_DENIED); });
  await new SyncCommand({ expectedUserId: 'user_fixture' }, true, report).execute();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: ERROR_CODES.PERMISSION_DENIED }));
  expect(runtimeKey).toHaveBeenCalledTimes(1);
  expect(legacyKey).not.toHaveBeenCalled();
  expect(decryptData).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
