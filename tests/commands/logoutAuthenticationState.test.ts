import { afterAll, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const directory = mkdtempSync(join(tmpdir(), 'capy-logout-authentication-'));
const originalCwd = process.cwd();
mock.module('os', () => ({ ...require('os'), homedir: () => directory }));
afterAll(() => { process.chdir(originalCwd); mock.restore(); rmSync(directory, { recursive: true, force: true }); });

it('logout removes pending authentication credentials and receipts, not recovery custody', async () => {
  process.chdir(directory);
  const { getGlobalCapyDir } = await import('../../src/config/globalConfig');
  const { performLogoutCleanup } = await import('../../src/commands/logoutCommand');
  const pending = join(getGlobalCapyDir(), 'auth', 'authentication-flows');
  const custody = join(getGlobalCapyDir(), 'orgs', 'org_test', 'users', 'user_test');
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  mkdirSync(custody, { recursive: true, mode: 0o700 });
  writeFileSync(join(pending, 'pending.json'), JSON.stringify({ deviceCode: 'TEST_DEVICE_CODE' }), { mode: 0o600 });
  writeFileSync(join(pending, 'completed.json'), JSON.stringify({ completed: true }), { mode: 0o600 });
  writeFileSync(join(custody, 'local.key'), 'TEST_RECOVERY_CUSTODY', { mode: 0o600 });
  expect(await performLogoutCleanup()).toBe(true);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(join(custody, 'local.key'))).toBe(true);
});
