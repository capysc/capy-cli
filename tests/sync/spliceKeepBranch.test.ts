import { describe, test, expect } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';
import { KeepFile } from '../../src/types/index';

/**
 * spliceKeepBranch is the CAP-303 primitive: any adoption of server keep
 * state into the git-owned keep.lock goes through it, replacing exactly one
 * branch's entries and leaving every other branch byte-identical.
 */

function makeKeep(variables: KeepFile['variables']): KeepFile {
  return {
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    variables,
  };
}

describe('SyncEngine.spliceKeepBranch', () => {
  test('adopts the server keep wholesale when there is no local keep (bootstrap)', () => {
    const server = makeKeep({
      FOO: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1' }],
    });
    expect(SyncEngine.spliceKeepBranch(null, server, 'development')).toBe(server);
  });

  test('replaces only the target branch, preserving other branches', () => {
    const local = makeKeep({
      FOO: [
        { resource_id: 'rd', branch: 'development', value_hash: 'old' },
        { resource_id: 'rm', branch: 'main', value_hash: 'hm' },
      ],
    });
    const server = makeKeep({
      FOO: [
        { resource_id: 'rd', branch: 'development', value_hash: 'new' },
        { resource_id: 'rm-stale', branch: 'main', value_hash: 'hm-stale' },
      ],
    });

    const result = SyncEngine.spliceKeepBranch(local, server, 'development');
    expect(result.variables.FOO).toEqual([
      { resource_id: 'rm', branch: 'main', value_hash: 'hm' },
      { resource_id: 'rd', branch: 'development', value_hash: 'new' },
    ]);
  });

  test('honors deletions on the target branch', () => {
    const local = makeKeep({
      GONE: [
        { resource_id: 'r1', branch: 'development', value_hash: 'h1' },
        { resource_id: 'r2', branch: 'main', value_hash: 'h2' },
      ],
      FULLY_GONE: [{ resource_id: 'r3', branch: 'development', value_hash: 'h3' }],
    });
    const server = makeKeep({});

    const result = SyncEngine.spliceKeepBranch(local, server, 'development');
    expect(result.variables.GONE).toEqual([{ resource_id: 'r2', branch: 'main', value_hash: 'h2' }]);
    expect(result.variables.FULLY_GONE).toBeUndefined();
  });

  test('preserves local entries with no branch field', () => {
    const local = makeKeep({
      LEGACY: [{ resource_id: 'r1', value_hash: 'h1' } as any],
    });
    const server = makeKeep({
      LEGACY: [{ resource_id: 'r2', branch: 'development', value_hash: 'h2' }],
    });
    const result = SyncEngine.spliceKeepBranch(local, server, 'development');
    expect(result.variables.LEGACY).toHaveLength(2);
  });

  test('keeps local top-level metadata', () => {
    const local = makeKeep({});
    const server = { ...makeKeep({}), project_name: 'server-name' };
    expect(SyncEngine.spliceKeepBranch(local, server, 'development').project_name).toBe('demo');
  });

  // The incident (CAP-303): the server's latest keep was written by a machine
  // whose keep.lock lacked other branches' entries. A splice scoped to the
  // branch being synced must never import or erase anything outside it.
  test('regression: syncing one branch leaves the other branch\'s local pins untouched', () => {
    const localWithMain = makeKeep({
      DEPLOY_KEY: [{ resource_id: 'rmm', branch: 'main', value_hash: 'hmm' }],
    });
    const devServer = makeKeep({
      API_KEY: [{ resource_id: 'rd1', branch: 'development', value_hash: 'hd1' }],
    });
    const spliced = SyncEngine.spliceKeepBranch(localWithMain, devServer, 'development');
    expect(spliced.variables.DEPLOY_KEY).toEqual([{ resource_id: 'rmm', branch: 'main', value_hash: 'hmm' }]);
    expect(spliced.variables.API_KEY).toEqual([{ resource_id: 'rd1', branch: 'development', value_hash: 'hd1' }]);
  });

  test('regression: a main-flavored server keep cannot leak main entries into a development splice', () => {
    const local = makeKeep({
      API_KEY: [{ resource_id: 'rd1', branch: 'development', value_hash: 'hd1' }],
    });
    const mainOnlyServer = makeKeep({
      API_KEY: [{ resource_id: 'rm1', branch: 'main', value_hash: 'hm1' }],
      MAIN_ONLY: [{ resource_id: 'rm2', branch: 'main', value_hash: 'hm2' }],
    });
    const result = SyncEngine.spliceKeepBranch(local, mainOnlyServer, 'development');
    expect(result.variables.API_KEY?.find(e => e.branch === 'main')).toBeUndefined();
    expect(result.variables.MAIN_ONLY).toBeUndefined();
  });
});
