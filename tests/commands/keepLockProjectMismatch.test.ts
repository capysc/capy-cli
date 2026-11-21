/**
 * The write point of every keep.lock PR (`readBase` in src/commands/keepLockPr.ts): a base branch
 * file that carries ANOTHER project's `project_id` is never written into. The step refuses with
 * `KEEP_LOCK_PROJECT_MISMATCH` and creates nothing. Covers `capy add`, `capy edit` and
 * `capy remove` (the single-file step), and a file with no readable project id (not refused).
 * Everything external is injected.
 */
import { describe, test, expect, mock } from 'bun:test';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import { runKeepLockPrStep, type KeepLockPrDeps, type KeepLockPrRequest } from '../../src/commands/keepLockPr';
import type { ApiResult, GithubApi } from '../../src/deploy/githubApi';
import type { EditSaveRecord } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const entry = (branch: string, hash: string) => ({ resource_id: `r-${branch}-${hash}`, branch, value_hash: hash });
const keepOf = (projectId: string): KeepFile => ({
  version: '3',
  org_id: 'org-1',
  project_id: projectId,
  project_name: projectId,
  variables: { KEEP_ME: [entry('development', 'k1')] },
});
const RECORDS: readonly EditSaveRecord[] = [{ branch: 'development', entries: [{ variable: 'NEW_VAR', entry: entry('development', 'n1') }] }];

function fakes(baseFile: string | null) {
  const api = {
    getRepo: mock(async () => ok({ defaultBranch: 'main' })),
    listBranches: mock(async () => ok(['main'])),
    getBranchHead: mock(async () => ok({ commitSha: 'head', treeSha: 'tree' })),
    getFile: mock(async () => ok(baseFile)),
    createBlob: mock(async () => ok({ sha: 'blob' })),
    createTree: mock(async () => ok({ sha: 'tree2' })),
    createCommit: mock(async () => ok({ sha: 'commit' })),
    createRef: mock(async () => ok({ ref: 'refs/heads/x' })),
    createPull: mock(async () => ok({ url: 'https://github.com/acme/app/pull/1' })),
  } satisfies Record<keyof GithubApi, unknown>;
  const deps: KeepLockPrDeps = {
    tracksKeepLock: () => true,
    hasTerminal: () => false,
    confirm: mock(async () => true),
    pickBase: mock(async (branches: readonly string[]) => branches[0]),
    isGitRepo: () => true,
    originUrl: () => 'git@github.com:acme/app.git',
    keepLockPath: () => 'keep.lock',
    github: () => api as unknown as GithubApi,
    branchName: () => 'capy/keep-lock-20260101-000000-ab12',
  };
  return { api, deps };
}

const request = (command: KeepLockPrRequest['command'], localProject: string): KeepLockPrRequest => ({
  command,
  cwd: '/repo',
  records: RECORDS,
  localKeep: keepOf(localProject),
  flags: { pr: true, prBase: 'main' },
  json: false,
});

describe('a base keep.lock that belongs to another project', () => {
  test.each(['add', 'edit', 'remove'] as const)('capy %s: refused with KEEP_LOCK_PROJECT_MISMATCH, nothing is written', async (command) => {
    const f = fakes(serializeKeep(keepOf('proj-other')));

    const out = await runKeepLockPrStep(request(command, 'proj-1'), f.deps);

    expect(out.keep_lock).toMatchObject({ changed: true, committed: false, error: { code: ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH } });
    expect(f.api.createBlob.mock.calls).toHaveLength(0);
    expect(f.api.createTree.mock.calls).toHaveLength(0);
    expect(f.api.createRef.mock.calls).toHaveLength(0);
    expect(f.api.createPull.mock.calls).toHaveLength(0);
  });

  test('the same project\'s keep.lock is written as before', async () => {
    const f = fakes(serializeKeep(keepOf('proj-1')));

    const out = await runKeepLockPrStep(request('edit', 'proj-1'), f.deps);

    expect(out.keep_lock).toMatchObject({ changed: true, committed: true });
  });

  test.each([['an empty', ''], ['a missing', undefined]])('%s local project_id against a base that has one is not a mismatch: the rule needs both ids', async (_label, id) => {
    const f = fakes(serializeKeep(keepOf('proj-other')));
    const local = { ...keepOf('x'), project_id: id } as unknown as KeepFile;

    const out = await runKeepLockPrStep({ ...request('edit', 'x'), localKeep: local }, f.deps);

    expect(out.keep_lock).toMatchObject({ changed: true, committed: true });
  });

  test('a base file with no readable project id is not a mismatch: it is handled as before', async () => {
    const withoutId = JSON.stringify({ version: '3', variables: { KEEP_ME: [entry('development', 'k1')] } });
    const f = fakes(withoutId);

    const out = await runKeepLockPrStep(request('edit', 'proj-1'), f.deps);

    expect(out.keep_lock).toMatchObject({ changed: true, committed: true });
  });

  test('no keep.lock on the base yet is first-time setup: created as before', async () => {
    const f = fakes(null);

    const out = await runKeepLockPrStep(request('add', 'proj-1'), f.deps);

    expect(out.keep_lock).toMatchObject({ changed: true, committed: true });
    expect(f.api.createBlob.mock.calls).toHaveLength(1);
  });
});
