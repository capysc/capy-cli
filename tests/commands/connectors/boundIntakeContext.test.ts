import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { KeepFile } from '../../../src/types';
import type { AuthService } from '../../../src/auth/authService';
import type { ServiceClient } from '../../../src/service/serviceClient';

const keep: KeepFile = { version: '3.0', org_id: 'org_test', project_id: 'project', project_name: 'default', variables: {} };
const readKeep = mock<() => KeepFile | null>(() => null);
const readEnv = mock(() => ({ LOCAL: 'local-value' }));
const readBranch = mock(() => 'development');
const readMeta = mock(() => ({ org_id: 'org_test', project_id: 'project', branch: 'development' }));
const decrypt = mock((_value: string, _key: string) => 'decrypted-value');
const resolveKey = mock(async () => 'fixture-key');
mock.module('../../../src/core/projectManager', () => ({ ProjectManager: class {
  readKeepFile() { return readKeep(); }
  deriveActiveBranch() { return readBranch(); }
} }));
mock.module('../../../src/files/fileManager', () => ({ FileManager: class {
  readEnvFile() { return readEnv(); }
  readEnvMeta() { return readMeta(); }
  parseEnvContent(value: string) { return Object.fromEntries(value.split('\n').filter(Boolean).map((line) => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  })); }
  decryptValue(value: string, key: string) { return decrypt(value, key); }
} }));
mock.module('../../../src/sync/projectKeyResolver', () => ({ resolveConfiguredProjectKey: resolveKey }));
const { resolveBoundIntakeContext } = await import('../../../src/commands/connectors/boundIntakeContext');
const target = { org_id: 'org_test', project_id: 'project', project_name: 'default', branch: 'development', sync_mode: 'free' as const };
function dependencies() {
  const authenticateSilent = mock(async (_org?: string) => ({ success: true, user_id: 'user_test', organization_id: 'org_test' }));
  const getBillingStatus = mock(async () => ({ tier: 'free', grandfathered: false }));
  const listProjects = mock(async () => [{ id: 'project', organization_id: 'org_test', name: 'default' }]);
  const getDecryptData = mock(async () => ({ keep_file: JSON.stringify(keep), env_content: 'REMOTE=capy:encrypted' }));
  const auth = { authenticateSilent } as unknown as AuthService;
  const service = { getBillingStatus, listProjects, getDecryptData } as unknown as ServiceClient;
  return { auth, service, authenticateSilent, getBillingStatus, listProjects, getDecryptData };
}
beforeEach(() => {
  readKeep.mockReset().mockReturnValue(null);
  readEnv.mockReset().mockReturnValue({ LOCAL: 'local-value' });
  readBranch.mockReset().mockReturnValue('development');
  readMeta.mockReset().mockReturnValue({ org_id: 'org_test', project_id: 'project', branch: 'development' });
  decrypt.mockReset().mockReturnValue('decrypted-value');
  resolveKey.mockClear();
});
describe('same-repository bound intake context', () => {
  test('changed branch and foreign encrypted environment refuse before key access', async () => {
    readKeep.mockReturnValue(keep);
    readBranch.mockReturnValue('other');
    const paid = dependencies();
    await expect(resolveBoundIntakeContext({ target: { ...target, sync_mode: 'paid' }, expectedUserId: 'user_test', ...paid })).rejects.toThrow('Repository binding changed');
    readKeep.mockReturnValue(keep);
    readBranch.mockReturnValue('development');
    readEnv.mockReturnValue({ LOCAL: 'capy:foreign' });
    readMeta.mockReturnValue({ org_id: 'different', project_id: 'project', branch: 'development' });
    const free = dependencies();
    await expect(resolveBoundIntakeContext({ target, expectedUserId: 'user_test', ...free })).rejects.toThrow('encrypted environment belongs to another target');
    expect(resolveKey).not.toHaveBeenCalled();
  });
  test('configured project preserves remote plus local snapshot', async () => {
    readKeep.mockReturnValue(keep);
    const deps = dependencies();
    const ctx = await resolveBoundIntakeContext({ target, expectedUserId: 'user_test', ...deps });
    expect(ctx.lockless).toBe(false);
    expect(ctx.localPlaintext).toEqual({ REMOTE: 'decrypted-value', LOCAL: 'local-value' });
    expect(deps.authenticateSilent).toHaveBeenCalledWith('org_test');
    expect(resolveKey.mock.calls[0]?.slice(0, 3)).toEqual(['org_test', 'project', 'user_test']);
  });
  test('paid pins the existing manifest and retains paid behavior', async () => {
    readKeep.mockReturnValue(keep);
    const deps = dependencies();
    deps.getBillingStatus.mockResolvedValue({ tier: 'team', grandfathered: false });
    const ctx = await resolveBoundIntakeContext({ target: { ...target, sync_mode: 'paid' }, expectedUserId: 'user_test', ...deps });
    expect(ctx.lockless).toBe(false);
    expect(ctx.keep).toEqual(keep);
    expect(deps.listProjects).not.toHaveBeenCalled();
  });
  test('a missing or mismatched manifest fails before auth or key resolution', async () => {
    readKeep.mockReturnValue(keep);
    readBranch.mockReturnValue('other');
    const mismatched = dependencies();
    await expect(resolveBoundIntakeContext({ target, expectedUserId: 'user_test', ...mismatched })).rejects.toThrow('Repository binding changed');
    expect(mismatched.authenticateSilent).not.toHaveBeenCalled();
    readKeep.mockReturnValue(null);
    const absent = dependencies();
    await expect(resolveBoundIntakeContext({ target: { ...target, sync_mode: 'paid' }, expectedUserId: 'user_test', ...absent })).rejects.toThrow('Repository binding changed');
    expect(resolveKey).not.toHaveBeenCalled();
  });
  test('wrong user cannot resolve project keys', async () => {
    readKeep.mockReturnValue(keep);
    const wrong = dependencies();
    wrong.authenticateSilent.mockResolvedValue({ success: true, user_id: 'other', organization_id: 'org_test' });
    await expect(resolveBoundIntakeContext({ target, expectedUserId: 'user_test', ...wrong })).rejects.toThrow('Resume sign-in');
    expect(resolveKey).not.toHaveBeenCalled();
  });
  test('unreadable encrypted values fail instead of silently deleting remote keys', async () => {
    readKeep.mockReturnValue(keep);
    const deps = dependencies();
    decrypt.mockImplementation(() => { throw new Error('fixture-secret-must-not-escape'); });
    await expect(resolveBoundIntakeContext({ target, expectedUserId: 'user_test', ...deps })).rejects.toThrow('A stored value cannot be decrypted');
  });
  test('paid stale manifest refuses before canonical write', async () => {
    readKeep.mockReturnValue({ ...keep, variables: { OLD: [{ branch: 'development', resource_id: 'resource', value_hash: 'hash' }] } });
    const deps = dependencies();
    deps.getBillingStatus.mockResolvedValue({ tier: 'team', grandfathered: false });
    await expect(resolveBoundIntakeContext({ target: { ...target, sync_mode: 'paid' }, expectedUserId: 'user_test', ...deps })).rejects.toThrow('local Keep manifest is stale');
  });
});
