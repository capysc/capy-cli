import { describe, test, expect } from 'bun:test';
import {
  resolveBranchFromLocalState,
  branchesFromKeep,
  syncedBranchNames,
  autoSelectBranch,
  defaultBranchChoice,
  selectBranchWithServer,
} from '../../src/core/branchResolver';
import { Branch, CapyError, ERROR_CODES, KeepFile, SyncState } from '../../src/types/index';

const branch = (name: string, is_protected = false): Branch => ({
  id: `id-${name}`,
  name,
  project_id: 'proj-1',
  is_protected,
});

const keepWith = (branchNames: string[]): KeepFile => ({
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'test',
  variables: {
    API_KEY: branchNames.map((b, i) => ({
      resource_id: `res-${i}`,
      branch: b,
      value_hash: `hash-${i}`,
    })),
  },
});

const syncStateWith = (keepHash: SyncState['keep_hash']): SyncState => ({
  last_sync: '2026-01-01T00:00:00Z',
  synced_variables: [],
  keep_hash: keepHash,
});

describe('resolveBranchFromLocalState (state-matrix rows 1–6)', () => {
  // Rows 1–2: .env + .capy/branch both present
  test('row 1/2: header and branch file agree → resolved, no rebuild', () => {
    const r = resolveBranchFromLocalState({ envBranch: 'production', fileBranch: 'production' });
    expect(r).toEqual({ kind: 'resolved', branch: 'production', source: 'env-header', rebuildBranchFile: false });
  });

  test('row 1/2: header and branch file genuinely differ → conflict', () => {
    const r = resolveBranchFromLocalState({ envBranch: 'production', fileBranch: 'staging' });
    expect(r).toEqual({ kind: 'conflict', envBranch: 'production', fileBranch: 'staging' });
  });

  // Rows 3–4: .env present, .capy/branch missing — the CAP state that used
  // to invent 'development' and abort with "Local state is inconsistent".
  test('row 3/4: header only → resolved from header, branch file rebuilt', () => {
    const r = resolveBranchFromLocalState({ envBranch: 'production', fileBranch: undefined });
    expect(r).toEqual({ kind: 'resolved', branch: 'production', source: 'env-header', rebuildBranchFile: true });
  });

  test('row 3/4: empty/whitespace branch file is treated as missing', () => {
    const r = resolveBranchFromLocalState({ envBranch: 'production', fileBranch: '  ' });
    expect(r).toEqual({ kind: 'resolved', branch: 'production', source: 'env-header', rebuildBranchFile: true });
  });

  // Rows 5–6: .capy/branch present, no .env
  test('row 5/6: branch file only → resolved from branch file', () => {
    const r = resolveBranchFromLocalState({ envBranch: undefined, fileBranch: 'staging' });
    expect(r).toEqual({ kind: 'resolved', branch: 'staging', source: 'branch-file', rebuildBranchFile: false });
  });

  // Rows 7–8: no local signal at all
  test('row 7/8: nothing known → unknown (caller consults server; never a made-up name)', () => {
    expect(resolveBranchFromLocalState({})).toEqual({ kind: 'unknown' });
    expect(resolveBranchFromLocalState({ envBranch: '', fileBranch: '' })).toEqual({ kind: 'unknown' });
  });

  test('never resolves to a fabricated development branch', () => {
    const r = resolveBranchFromLocalState({});
    expect(r.kind).not.toBe('resolved');
  });
});

describe('branchesFromKeep', () => {
  test('collects distinct branch names across variable entries', () => {
    expect(branchesFromKeep(keepWith(['production', 'staging']))).toEqual(['production', 'staging']);
  });

  test('empty for null keep or keep without branch entries', () => {
    expect(branchesFromKeep(null)).toEqual([]);
    expect(branchesFromKeep(keepWith([]))).toEqual([]);
  });
});

describe('syncedBranchNames', () => {
  test('returns branch keys of the per-branch keep_hash record', () => {
    expect(syncedBranchNames(syncStateWith({ production: 'abc', staging: 'def' }))).toEqual(['production', 'staging']);
  });

  test('legacy string keep_hash carries no branch info', () => {
    expect(syncedBranchNames(syncStateWith('abc'))).toEqual([]);
  });

  test('empty for missing sync-state or keep_hash', () => {
    expect(syncedBranchNames(null)).toEqual([]);
    expect(syncedBranchNames(syncStateWith(undefined))).toEqual([]);
  });
});

describe('autoSelectBranch (protected-branch guard)', () => {
  test('sole branch is selected even when protected (no alternative)', () => {
    expect(autoSelectBranch([branch('production', true)], [])).toBe('production');
  });

  test('row 7: sole synced branch is selected when non-protected', () => {
    const list = [branch('production', true), branch('staging')];
    expect(autoSelectBranch(list, ['staging'])).toBe('staging');
  });

  test('row 7: sole synced branch that is protected is NEVER auto-selected', () => {
    const list = [branch('production', true), branch('staging')];
    expect(autoSelectBranch(list, ['production'])).toBeNull();
  });

  test('synced branch that no longer exists on the server is ignored', () => {
    const list = [branch('production', true), branch('staging')];
    expect(autoSelectBranch(list, ['deleted-branch'])).toBeNull();
  });

  test('multiple synced branches are ambiguous → prompt', () => {
    const list = [branch('production'), branch('staging')];
    expect(autoSelectBranch(list, ['production', 'staging'])).toBeNull();
  });

  test('row 8: multiple branches, no sync hint → prompt', () => {
    expect(autoSelectBranch([branch('production'), branch('staging')], [])).toBeNull();
  });
});

describe('defaultBranchChoice', () => {
  test('first non-protected branch — a protected branch is never the preselection', () => {
    const list = [branch('production', true), branch('staging'), branch('development')];
    expect(defaultBranchChoice(list)).toBe('staging');
  });

  test('undefined when every branch is protected (explicit pick required)', () => {
    expect(defaultBranchChoice([branch('production', true), branch('release', true)])).toBeUndefined();
  });
});

describe('selectBranchWithServer (rows 7–8 + offline)', () => {
  test('sole branch → selected without prompting, even when protected', async () => {
    const selected = await selectBranchWithServer({
      listBranches: async () => [branch('production', true)],
      promptPick: async () => { throw new Error('must not prompt'); },
      syncedBranches: [],
    });
    expect(selected).toBe('production');
  });

  test('row 7: sole non-protected synced branch → selected without prompting', async () => {
    const selected = await selectBranchWithServer({
      listBranches: async () => [branch('production', true), branch('staging')],
      promptPick: async () => { throw new Error('must not prompt'); },
      syncedBranches: ['staging'],
    });
    expect(selected).toBe('staging');
  });

  test('row 8: ambiguous → prompts with a non-protected default', async () => {
    let promptedDefault: string | undefined;
    let promptedNames: string[] = [];
    const selected = await selectBranchWithServer({
      listBranches: async () => [branch('production', true), branch('staging'), branch('development')],
      promptPick: async (branches, defaultName) => {
        promptedNames = branches.map(b => b.name);
        promptedDefault = defaultName;
        return 'development';
      },
      syncedBranches: [],
    });
    expect(selected).toBe('development');
    expect(promptedNames).toEqual(['production', 'staging', 'development']);
    expect(promptedDefault).toBe('staging');
  });

  test('offline (branch list unreachable) → typed NETWORK_ERROR, no auto-pick', async () => {
    const attempt = selectBranchWithServer({
      listBranches: async () => { throw new Error('ECONNREFUSED'); },
      promptPick: async () => { throw new Error('must not prompt'); },
      syncedBranches: ['production'],
    });
    await expect(attempt).rejects.toBeInstanceOf(CapyError);
    await attempt.catch((err: CapyError) => {
      expect(err.code).toBe(ERROR_CODES.NETWORK_ERROR);
    });
  });

  test('project with zero branches → typed BRANCH_NOT_FOUND', async () => {
    const attempt = selectBranchWithServer({
      listBranches: async () => [],
      promptPick: async () => { throw new Error('must not prompt'); },
      syncedBranches: [],
    });
    await expect(attempt).rejects.toBeInstanceOf(CapyError);
    await attempt.catch((err: CapyError) => {
      expect(err.code).toBe(ERROR_CODES.BRANCH_NOT_FOUND);
    });
  });
});
