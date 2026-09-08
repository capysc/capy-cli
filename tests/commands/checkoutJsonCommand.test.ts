import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutJson, guardedCheckoutSnapshot, type CheckoutJsonDeps } from '../../src/commands/checkoutJsonCommand';
import { syncAndWriteBranch } from '../../src/commands/checkoutCommand';
import { hashValue } from '../../src/commands/statusCommand';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { Encryptor } from '../../src/crypto/encryptor';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';

const keep: KeepFile = {
  version: '3.0', org_id: 'org-fixture', project_id: 'project-fixture', project_name: 'checkout-fixture',
  variables: { PLACEHOLDER: [{ resource_id: 'fixture-variable', branch: 'development', value_hash: hashValue('') }] },
};
const options = { nonTty: true, expectedUserId: 'user-fixture', expectedOrgId: keep.org_id, expectedProjectId: keep.project_id } as const;
const success = { kind: 'ok', varCount: 0, seededFromCurrent: false } as const;
const dirtyEnvironments: readonly Record<string, string>[] = [
  {}, { PLACEHOLDER: 'edited' }, { PLACEHOLDER: '', ADDED: 'fixture' },
];

function fixture(overrides: Partial<CheckoutJsonDeps> = {}) {
  const authenticate = mock(async () => ({ success: true, user_id: options.expectedUserId, organization_id: keep.org_id }));
  const resolveKey = mock(async () => 'fixture-key');
  const apply = mock<CheckoutJsonDeps['apply']>(async (_keep, _branch, _key, recheck) => { recheck(); return success; });
  const deps: CheckoutJsonDeps = {
    readKeep: () => keep, activeBranch: () => 'development', envBranch: () => 'development', syncState: () => null,
    authenticate, branches: async () => [{ name: 'preview' }], resolveKey,
    localValues: () => ({ PLACEHOLDER: '' }), apply, ...overrides,
  };
  return { deps, authenticate, resolveKey, apply };
}

describe('non-interactive existing-branch checkout', () => {
  test('clean empty placeholder is valid and output contains no values or key', async () => {
    const run = fixture();
    const result = await checkoutJson('preview', options, run.deps);
    expect(result).toEqual({ ok: true, code: 'BRANCH_SWITCHED', project_id: keep.project_id, branch: 'preview', variable_count: 0 });
    expect(run.authenticate).toHaveBeenCalledWith(keep.org_id);
    expect(run.apply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER');
  });

  test.each([
    { ...options, expectedUserId: undefined },
    { ...options, expectedOrgId: undefined },
    { ...options, expectedProjectId: undefined },
  ])('requires the complete hosted target before authentication', async (input) => {
    const run = fixture();
    expect((await checkoutJson('preview', input, run.deps)).code).toBe('CHECKOUT_TARGET_REQUIRED');
    expect(run.authenticate).not.toHaveBeenCalled();
  });

  test.each([{ create: true }, { refresh: true }, { protected: false }, { protected: true }])('cannot silently use a force/create path: %j', async (flags) => {
    const run = fixture();
    expect((await checkoutJson('preview', { ...options, ...flags }, run.deps)).code).toBe('CHECKOUT_OPTIONS_UNSUPPORTED');
    expect(run.authenticate).not.toHaveBeenCalled();
  });

  test.each([
    { readKeep: () => null, code: 'NO_KEEP_FILE' },
    { readKeep: () => ({ ...keep, org_id: 'other-org' }), code: 'CHECKOUT_PROJECT_MISMATCH' },
    { readKeep: () => ({ ...keep, project_id: 'other-project' }), code: 'CHECKOUT_PROJECT_MISMATCH' },
  ])('does not infer a repository binding from .capy: $code', async ({ readKeep, code }) => {
    const run = fixture({ readKeep });
    expect((await checkoutJson('preview', options, run.deps)).code).toBe(code);
    expect(run.authenticate).not.toHaveBeenCalled();
    expect(run.apply).not.toHaveBeenCalled();
  });

  test.each([
    { success: false },
    { success: true, user_id: 'other-user', organization_id: keep.org_id },
    { success: true, user_id: options.expectedUserId, organization_id: 'other-org' },
  ])('refuses the wrong or missing identity before key access', async (auth) => {
    const run = fixture({ authenticate: async () => auth });
    expect((await checkoutJson('preview', options, run.deps)).ok).toBe(false);
    expect(run.resolveKey).not.toHaveBeenCalled();
    expect(run.apply).not.toHaveBeenCalled();
  });

  test('refuses a missing branch before unlocking', async () => {
    const run = fixture({ branches: async () => [] });
    expect((await checkoutJson('preview', options, run.deps)).code).toBe('BRANCH_NOT_FOUND');
    expect(run.resolveKey).not.toHaveBeenCalled();
  });

  test.each([...dirtyEnvironments])('preserves local additions, edits and deletions', async (values) => {
    const run = fixture({ localValues: () => values });
    expect((await checkoutJson('preview', options, run.deps)).code).toBe(ERROR_CODES.SYNC_CONFLICT);
    expect(run.apply).not.toHaveBeenCalled();
  });

  test('unreadable ciphertext is not treated as an empty environment', async () => {
    const run = fixture({ localValues: () => { throw new Error('private decrypt detail'); } });
    const result = await checkoutJson('preview', options, run.deps);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private decrypt detail');
    expect(run.apply).not.toHaveBeenCalled();
  });

  test('keep hash drift stops before apply', async () => {
    const run = fixture({ syncState: () => ({ last_sync: '', synced_variables: [], keep_hash: { development: 'stale' } }) });
    expect((await checkoutJson('preview', options, run.deps)).code).toBe(ERROR_CODES.STALE_KEEP_HASH);
    expect(run.apply).not.toHaveBeenCalled();
  });

  test.each(['keep', 'active', 'header', 'sync', 'values'] as const)('rechecks %s after remote wait', async (changed) => {
    const readKeep = mock(() => keep).mockReturnValueOnce(keep).mockReturnValueOnce(keep);
    const activeBranch = mock(() => 'development');
    const envBranch = mock(() => 'development');
    const syncState = mock<CheckoutJsonDeps['syncState']>(() => null);
    const localValues = mock(() => ({ PLACEHOLDER: '' }));
    const run = fixture({ readKeep, activeBranch, envBranch, syncState, localValues,
      apply: async (_keep, _branch, _key, recheck) => {
        if (changed === 'keep') readKeep.mockReturnValue({ ...keep, project_name: 'changed' });
        if (changed === 'active') activeBranch.mockReturnValue('changed');
        if (changed === 'header') envBranch.mockReturnValue('changed');
        if (changed === 'sync') syncState.mockReturnValue({ last_sync: 'changed', synced_variables: [] });
        if (changed === 'values') localValues.mockReturnValue({ PLACEHOLDER: 'edited during fetch' });
        recheck();
        return success;
      },
    });
    expect((await checkoutJson('preview', options, run.deps)).code).toBe(ERROR_CODES.SYNC_CONFLICT);
  });
});

describe('guarded snapshot with the actual filesystem writer', () => {
  const key = 'ab'.repeat(32);
  const remote: KeepFile = { ...keep, variables: {
    TARGET: [{ resource_id: 'fixture-target', branch: 'preview', value_hash: hashValue('synthetic-target') }],
  } };
  function files() {
    const dir = mkdtempSync(join(tmpdir(), 'capy-checkout-json-'));
    const fm = new FileManager(dir);
    const pm = new ProjectManager(dir);
    fm.writeKeepFile(keep);
    fm.writeEncryptedEnvFile({ PLACEHOLDER: '' }, key, undefined, keep, 'development');
    pm.writeActiveBranch('development');
    return { dir, fm, pm, before: readFileSync(join(dir, '.env'), 'utf8'), keepBefore: readFileSync(join(dir, 'keep.lock'), 'utf8') };
  }

  test('successful fetch validates and writes encrypted target, retaining other branch pins', async () => {
    const run = files();
    const recheck = mock(() => {});
    const fetch = guardedCheckoutSnapshot({ getDecryptData: async () => ({
      keep_file: JSON.stringify(remote), env_content: `TARGET=${Encryptor.encrypt('synthetic-target', key)}`,
      decrypt_key: '', expires_at: '',
    }) }, run.fm, keep, key, recheck);
    const result = await syncAndWriteBranch({ projectManager: run.pm, fileManager: run.fm, serviceClient: { getDecryptData: fetch } }, keep.project_id, 'preview', key, false);
    expect(result.kind).toBe('ok');
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(run.pm.readActiveBranch()).toBe('preview');
    expect(run.fm.readEnvMeta().branch).toBe('preview');
    expect(run.fm.readEncryptedEnvFile(key)).toEqual({ TARGET: 'synthetic-target' });
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).not.toContain('synthetic-target');
    expect(run.pm.readKeepFile()?.variables.PLACEHOLDER).toEqual(keep.variables.PLACEHOLDER);
  });

  test.each(['wrong-project', 'bad-ciphertext', 'short-envelope', 'wrong-branch', 'wrong-header', 'fetch-drift', 'empty-drift'] as const)('%s changes no repository files', async (failure) => {
    const run = files();
    const fetch = guardedCheckoutSnapshot({ getDecryptData: async () => {
      if (failure === 'empty-drift') throw new CapyError('No snapshot', ERROR_CODES.SERVICE_ERROR, { status: 404 });
      const value = failure === 'bad-ciphertext' ? 'enc:invalid' : failure === 'short-envelope' ? 'capy:broken'
        : Encryptor.encrypt(failure === 'wrong-branch' ? 'other-branch-value' : 'synthetic-target', key);
      return { keep_file: JSON.stringify({ ...remote, project_id: failure === 'wrong-project' ? 'wrong' : keep.project_id }),
        env_content: `${failure === 'wrong-header' ? '# capy:branch=other\n' : ''}TARGET=${value}`, decrypt_key: '', expires_at: '' };
    } }, run.fm, keep, key, () => {
      if (failure === 'fetch-drift' || failure === 'empty-drift') throw new CapyError('Changed', ERROR_CODES.SYNC_CONFLICT);
    });
    const result = await syncAndWriteBranch({ projectManager: run.pm, fileManager: run.fm, serviceClient: { getDecryptData: fetch } }, keep.project_id, 'preview', key, false);
    expect(result.kind).toBe('sync_error');
    expect(run.pm.readActiveBranch()).toBe('development');
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(run.before);
    expect(readFileSync(join(run.dir, 'keep.lock'), 'utf8')).toBe(run.keepBefore);
  });

  test.each([ERROR_CODES.BRANCH_NOT_FOUND, ERROR_CODES.PROJECT_NOT_FOUND, ERROR_CODES.SNAPSHOT_NOT_FOUND])('propagated %s 404 never clears .env', async (code) => {
    const run = files();
    const fetch = guardedCheckoutSnapshot({ getDecryptData: async () => {
      throw new CapyError('Deleted after listing', code, { status: 404 });
    } }, run.fm, keep, key, () => {});
    expect((await syncAndWriteBranch({ projectManager: run.pm, fileManager: run.fm, serviceClient: { getDecryptData: fetch } }, keep.project_id, 'preview', key, false)).kind).toBe('sync_error');
    expect(run.pm.readActiveBranch()).toBe('development');
    expect(readFileSync(join(run.dir, '.env'), 'utf8')).toBe(run.before);
    expect(readFileSync(join(run.dir, 'keep.lock'), 'utf8')).toBe(run.keepBefore);
  });

  test('an actual successful empty snapshot can switch to an empty branch', async () => {
    const run = files();
    const fetch = guardedCheckoutSnapshot({ getDecryptData: async () => ({ env_content: '', decrypt_key: '', expires_at: '' }) }, run.fm, keep, key, () => {});
    expect((await syncAndWriteBranch({ projectManager: run.pm, fileManager: run.fm, serviceClient: { getDecryptData: fetch } }, keep.project_id, 'preview', key, false)).kind).toBe('ok');
    expect(run.pm.readActiveBranch()).toBe('preview');
    expect(run.fm.readEncryptedEnvFile(key)).toEqual({});
  });
});
