/**
 * The shared keep.lock PR step (src/commands/keepLockPr.ts), used by
 * `capy add`, `capy edit` and `capy remove`.
 *
 * Everything external is injected: the prompts, the git reads, and the GitHub
 * API. No `gh`, no network, no real git remote, no browser, and no
 * `mock.module` — so this file needs no process isolation.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  buildCommitMessage,
  buildPrBody,
  filterBranches,
  newPrBranchName,
  orderBranches,
  prFlagsFromCommand,
  readPrFlags,
  recordsForRemoval,
  recordsForWrite,
  refuseBadPrFlags,
  reportKeepLockHuman,
  runKeepLockPrStep,
  unansweredStops,
  withKeepLock,
  type KeepLockPrDeps,
  type KeepLockPrRequest,
} from '../../src/commands/keepLockPr';
import type { ApiResult, GithubApi } from '../../src/deploy/githubApi';
import { isValidBranchName } from '../../src/deploy/githubApi';
import type { EditSaveRecord } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import { EditScreen } from '../../src/ui/editScreen';
import type { KeepFile } from '../../src/types/index';

// ── fixtures ─────────────────────────────────────────────────────────────

const entry = (branch: string, hash: string) => ({ resource_id: `r-${branch}-${hash}`, branch, value_hash: hash });

function keepWith(variables: KeepFile['variables']): KeepFile {
  return { version: '3', org_id: 'org-1', project_id: 'proj-1', project_name: 'demo', variables };
}

/** What the base branch's keep.lock holds. */
const BASE_KEEP = keepWith({
  KEEP_ME: [entry('development', 'k1'), entry('production', 'k2')],
  GONE: [entry('development', 'g1')],
});

/** The local file differs from the base's on purpose: the PR must be built from the BASE. */
const LOCAL_KEEP = keepWith({ LOCAL_ONLY: [entry('development', 'l1')] });

const ADDED: readonly EditSaveRecord[] = [
  { branch: 'development', entries: [{ variable: 'NEW_VAR', entry: entry('development', 'n1') }] },
];

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

interface Fakes {
  readonly api: GithubApi;
  readonly deps: KeepLockPrDeps;
  readonly confirm: ReturnType<typeof mock>;
  readonly pickBase: ReturnType<typeof mock>;
  readonly github: ReturnType<typeof mock>;
  readonly isGitRepo: ReturnType<typeof mock>;
  readonly originUrl: ReturnType<typeof mock>;
}

function makeFakes(over: { api?: Partial<GithubApi>; deps?: Partial<KeepLockPrDeps>; baseFile?: string | null } = {}): Fakes {
  const baseFile = over.baseFile === undefined ? serializeKeep(BASE_KEEP) : over.baseFile;
  const api: GithubApi = {
    getRepo: mock(async () => ok({ defaultBranch: 'main' })),
    listBranches: mock(async () => ok(['dev', 'main', 'release/1', 'dev'])),
    getBranchHead: mock(async () => ok({ commitSha: 'head-sha', treeSha: 'tree-sha' })),
    getFile: mock(async () => ok(baseFile)),
    createBlob: mock(async () => ok({ sha: 'blob-sha' })),
    createTree: mock(async () => ok({ sha: 'new-tree' })),
    createCommit: mock(async () => ok({ sha: 'new-commit' })),
    createRef: mock(async () => ok({ ref: 'refs/heads/x' })),
    createPull: mock(async () => ok({ url: 'https://github.com/acme/app/pull/42' })),
    ...over.api,
  };
  const confirm = mock(async (): Promise<boolean | null> => true);
  const pickBase = mock(async (branches: readonly string[]): Promise<string | null> => branches[0]);
  const github = mock((): GithubApi | undefined => api);
  const isGitRepo = mock((_cwd: string) => true);
  const originUrl = mock((_cwd: string): string | null => 'git@github.com:acme/app.git');
  const deps: KeepLockPrDeps = {
    hasTerminal: () => false,
    confirm,
    pickBase,
    isGitRepo,
    originUrl,
    keepLockPath: () => 'keep.lock',
    github,
    branchName: () => 'capy/keep-lock-20260101-000000-ab12',
    ...over.deps,
  };
  return { api, deps, confirm, pickBase, github, isGitRepo, originUrl };
}

const request = (over: Partial<KeepLockPrRequest> = {}): KeepLockPrRequest => ({
  command: 'add',
  cwd: '/repo',
  records: ADDED,
  localKeep: LOCAL_KEEP,
  flags: {},
  json: false,
  ...over,
});

const terminal = { hasTerminal: () => true };

/** The JSON body of the keep.lock the blob call carried. */
function blobKeep(f: Fakes): KeepFile {
  const calls = (f.api.createBlob as ReturnType<typeof mock>).mock.calls;
  return JSON.parse(String(calls[0][1])) as KeepFile;
}

const callsOf = (fn: unknown) => (fn as ReturnType<typeof mock>).mock.calls;

// ── interactive ──────────────────────────────────────────────────────────

describe('interactive (a terminal, no --json)', () => {
  test('No: nothing is asked of git or GitHub', async () => {
    const f = makeFakes({ deps: { ...terminal, confirm: mock(async () => false) } });
    const out = await runKeepLockPrStep(request(), f.deps);
    expect(out.keep_lock).toEqual({ changed: true, committed: false });
    expect(out.declined).toBe(true);
    expect(out.unanswered).toBeUndefined();
    expect(callsOf(f.isGitRepo)).toHaveLength(0);
    expect(callsOf(f.originUrl)).toHaveLength(0);
    expect(callsOf(f.github)).toHaveLength(0);
    expect(callsOf(f.pickBase)).toHaveLength(0);
  });

  test('Yes: the list has the default branch first (de-duplicated), then the chosen base gets the PR', async () => {
    const f = makeFakes({ deps: { ...terminal, pickBase: mock(async () => 'release/1') } });
    const out = await runKeepLockPrStep(request(), f.deps);

    expect(callsOf(f.deps.pickBase)[0][0]).toEqual(['main', 'dev', 'release/1']);
    expect(out.keep_lock).toEqual({
      changed: true,
      committed: true,
      pr_url: 'https://github.com/acme/app/pull/42',
      base: 'release/1',
    });
    expect(callsOf(f.api.getBranchHead)[0].slice(1)).toEqual(['release/1']);
    expect(callsOf(f.api.getFile)[0].slice(1)).toEqual(['keep.lock', 'release/1']);
    expect(callsOf(f.api.createPull)[0][1]).toMatchObject({ base: 'release/1', head: 'capy/keep-lock-20260101-000000-ab12' });
  });

  test('the default branch leads even when it is not the first one GitHub lists', () => {
    expect(orderBranches('main', ['dev', 'zeta', 'main', 'alpha'])).toEqual(['main', 'dev', 'zeta', 'alpha']);
  });

  test('Esc / Ctrl-C on the confirm (null) is a quiet no PR', async () => {
    const f = makeFakes({ deps: { ...terminal, confirm: mock(async () => null) } });
    const out = await runKeepLockPrStep(request(), f.deps);
    expect(out.keep_lock).toEqual({ changed: true, committed: false });
    expect(out.declined).toBe(true);
    expect(callsOf(f.github)).toHaveLength(0);
  });

  test('Esc on the base-branch list (null): no PR, no commit, no branch', async () => {
    const f = makeFakes({ deps: { ...terminal, pickBase: mock(async () => null) } });
    const out = await runKeepLockPrStep(request(), f.deps);
    expect(out.keep_lock).toEqual({ changed: true, committed: false });
    expect(out.declined).toBe(true);
    for (const write of [f.api.createBlob, f.api.createTree, f.api.createCommit, f.api.createRef, f.api.createPull]) {
      expect(callsOf(write)).toHaveLength(0);
    }
  });

  test('--pr-base skips the list but the confirm is still asked', async () => {
    const f = makeFakes({ deps: terminal });
    const out = await runKeepLockPrStep(request({ flags: { prBase: 'dev' } }), f.deps);
    expect(callsOf(f.confirm)).toHaveLength(1);
    expect(callsOf(f.pickBase)).toHaveLength(0);
    expect(out.keep_lock).toMatchObject({ committed: true, base: 'dev' });
  });

  test('--pr skips the confirm but the list is still shown', async () => {
    const f = makeFakes({ deps: terminal });
    await runKeepLockPrStep(request({ flags: { pr: true } }), f.deps);
    expect(callsOf(f.confirm)).toHaveLength(0);
    expect(callsOf(f.pickBase)).toHaveLength(1);
  });

  test('--json never prompts, even on a terminal', async () => {
    const f = makeFakes({ deps: terminal });
    const out = await runKeepLockPrStep(request({ json: true }), f.deps);
    expect(callsOf(f.confirm)).toHaveLength(0);
    expect(out.unanswered).toHaveLength(2);
  });

  test('--non-tty never prompts, even on a terminal', async () => {
    const f = makeFakes({ deps: terminal });
    await runKeepLockPrStep(request({ nonTty: true }), f.deps);
    expect(callsOf(f.confirm)).toHaveLength(0);
  });

  test('type-to-filter: case-insensitive substring, empty term lists all, order kept', () => {
    const branches = ['main', 'dev', 'release/1', 'Release/2'];
    expect(filterBranches(branches, undefined)).toEqual(branches);
    expect(filterBranches(branches, '  ')).toEqual(branches);
    expect(filterBranches(branches, 'rel')).toEqual(['release/1', 'Release/2']);
    expect(filterBranches(branches, 'zzz')).toEqual([]);
  });
});

// ── flags ────────────────────────────────────────────────────────────────

describe('flags (no terminal)', () => {
  test('--pr --pr-base dev: no prompt, base dev, PR created', async () => {
    const f = makeFakes();
    const out = await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'dev' } }), f.deps);
    expect(out).toEqual({
      keep_lock: { changed: true, committed: true, pr_url: 'https://github.com/acme/app/pull/42', base: 'dev' },
    });
    expect(callsOf(f.confirm)).toHaveLength(0);
    expect(callsOf(f.pickBase)).toHaveLength(0);
    expect(callsOf(f.api.getRepo)).toHaveLength(0); // nothing to resolve: the base was given
  });

  test('--pr alone: the repo default branch is the base', async () => {
    const f = makeFakes({ api: { getRepo: mock(async () => ok({ defaultBranch: 'trunk' })) } });
    const out = await runKeepLockPrStep(request({ flags: { pr: true } }), f.deps);
    expect(out.keep_lock).toMatchObject({ committed: true, base: 'trunk' });
    expect(callsOf(f.api.getBranchHead)[0][1]).toBe('trunk');
  });

  test('--pr with an unresolvable default branch: KEEP_PR_BASE_UNRESOLVED, never a guessed "main"', async () => {
    const f = makeFakes({ api: { getRepo: mock(async () => ({ ok: false, kind: 'REQUEST_FAILED' }) as const) } });
    const out = await runKeepLockPrStep(request({ flags: { pr: true } }), f.deps);
    expect(out.keep_lock).toMatchObject({ changed: true, committed: false, error: { code: 'KEEP_PR_BASE_UNRESOLVED' } });
    expect(callsOf(f.api.getBranchHead)).toHaveLength(0);
  });

  test('--pr-base naming a branch that does not exist: KEEP_PR_BASE_UNRESOLVED', async () => {
    const f = makeFakes({ api: { getBranchHead: mock(async () => ({ ok: false, kind: 'NOT_FOUND', status: 404 }) as const) } });
    const out = await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'nope' } }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_BASE_UNRESOLVED' } });
  });

  test('--no-pr: changed, not committed, no unanswered, GitHub never touched', async () => {
    const f = makeFakes();
    const out = await runKeepLockPrStep(request({ flags: { noPr: true } }), f.deps);
    expect(out).toEqual({ keep_lock: { changed: true, committed: false } });
    expect(callsOf(f.github)).toHaveLength(0);
    expect(callsOf(f.isGitRepo)).toHaveLength(0);
  });

  test('--pr with --no-pr is refused (INVALID_FORMAT, exit 1) as pre-flight, before any change', () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => refuseBadPrFlags({ pr: true, noPr: true }, true)).toThrow('exit');
      expect(exit.mock.calls[0][0]).toBe(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test('an invalid --pr-base is refused as pre-flight; valid flags pass', () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => refuseBadPrFlags({ prBase: 'a..b' }, true)).toThrow('exit');
      expect(() => refuseBadPrFlags({ pr: true, prBase: 'release/1' }, true)).not.toThrow();
      expect(() => refuseBadPrFlags({ noPr: true }, true)).not.toThrow();
      expect(() => refuseBadPrFlags({}, true)).not.toThrow();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test('--pr and --no-pr are both read from argv even though Commander folds them into one attribute', () => {
    expect(readPrFlags(['node', 'capy', 'add', 'X', '--pr', '--no-pr'], undefined)).toMatchObject({ pr: true, noPr: true });
    expect(readPrFlags(['node', 'capy', 'add', 'X', '--no-pr'], undefined)).toMatchObject({ pr: false, noPr: true });
    expect(readPrFlags(['node', 'capy', 'add', 'X', '--', '--pr'], 'dev')).toEqual({ pr: false, noPr: false, prBase: 'dev' });
    const root = { rawArgs: ['node', 'capy', 'remove', 'A', '--pr'], parent: null };
    expect(prFlagsFromCommand({ parent: root }, 'dev')).toEqual({ pr: true, noPr: false, prBase: 'dev' });
  });
});

// ── non-TTY, no flags ────────────────────────────────────────────────────

describe('no terminal and no flags', () => {
  test('no PR, nothing asked, the change is reported with exactly the two unanswered questions', async () => {
    const f = makeFakes();
    const out = await runKeepLockPrStep(request({ json: true }), f.deps);
    expect(out).toEqual({
      keep_lock: { changed: true, committed: false },
      unanswered: [
        { id: 'create_pr', flag: '--pr' },
        { id: 'pr_base', flag: '--pr-base' },
      ],
    });
    expect(callsOf(f.confirm)).toHaveLength(0);
    expect(callsOf(f.github)).toHaveLength(0);
  });

  test('--pr-base alone leaves only create_pr; --pr alone leaves only pr_base', () => {
    expect(unansweredStops({ prBase: 'dev' })).toEqual([{ id: 'create_pr', flag: '--pr' }]);
    expect(unansweredStops({ pr: true })).toEqual([{ id: 'pr_base', flag: '--pr-base' }]);
    expect(unansweredStops({ noPr: true })).toEqual([{ id: 'pr_base', flag: '--pr-base' }]);
  });

  test('withKeepLock merges into a command JSON that stays pure (parses, secret-free)', async () => {
    const out = await runKeepLockPrStep(request({ json: true }), makeFakes().deps);
    const text = JSON.stringify(withKeepLock({ removed: ['A'], branch: 'development' }, out), null, 2);
    expect(JSON.parse(text)).toEqual({
      removed: ['A'],
      branch: 'development',
      keep_lock: { changed: true, committed: false },
      unanswered: [
        { id: 'create_pr', flag: '--pr' },
        { id: 'pr_base', flag: '--pr-base' },
      ],
    });
  });

  test('keep.lock unchanged: { changed: false }, no prompt, no unanswered, nothing touched', async () => {
    const f = makeFakes({ deps: terminal });
    const out = await runKeepLockPrStep(request({ records: [] }), f.deps);
    expect(out).toEqual({ keep_lock: { changed: false } });
    expect(callsOf(f.confirm)).toHaveLength(0);
    expect(callsOf(f.github)).toHaveLength(0);
  });
});

// ── building the commit remotely ─────────────────────────────────────────

describe('the remote commit', () => {
  test('records are folded into the BASE branch keep.lock, not the local file', async () => {
    const f = makeFakes();
    await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'main' } }), f.deps);
    const keep = blobKeep(f);
    expect(Object.keys(keep.variables).toSorted()).toEqual(['GONE', 'KEEP_ME', 'NEW_VAR']);
    expect(keep.variables.LOCAL_ONLY).toBeUndefined();
    expect(keep.variables.KEEP_ME).toEqual(BASE_KEEP.variables.KEEP_ME);
    expect(keep.variables.NEW_VAR).toEqual([entry('development', 'n1')]);
    // canonical serialisation
    expect(String(callsOf(f.api.createBlob)[0][1])).toBe(serializeKeep(keep));
  });

  test('remove: the entry is dropped from the target branch only; other branches keep theirs', async () => {
    const f = makeFakes();
    const records = recordsForRemoval('development', ['KEEP_ME', 'GONE']);
    await runKeepLockPrStep(request({ command: 'remove', records, flags: { pr: true, prBase: 'main' } }), f.deps);
    const keep = blobKeep(f);
    expect(keep.variables.GONE).toBeUndefined(); // last entry removed -> variable gone
    expect(keep.variables.KEEP_ME).toEqual([entry('production', 'k2')]);
  });

  test('the tree has one entry at the keep.lock path: repo root', async () => {
    const f = makeFakes();
    await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'main' } }), f.deps);
    expect(callsOf(f.api.createTree)[0][1]).toEqual({ baseTree: 'tree-sha', path: 'keep.lock', blobSha: 'blob-sha' });
  });

  test('the tree path follows a nested keep.lock folder, and the base file is read from the same path', async () => {
    const f = makeFakes({ deps: { keepLockPath: () => 'services/api/keep.lock' } });
    await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'main' } }), f.deps);
    expect(callsOf(f.api.createTree)[0][1]).toMatchObject({ path: 'services/api/keep.lock' });
    expect(callsOf(f.api.getFile)[0][1]).toBe('services/api/keep.lock');
  });

  test('commit has one parent (the base head), the new tree, and no attribution; ref then pull follow', async () => {
    const f = makeFakes();
    await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'main' } }), f.deps);
    const commit = callsOf(f.api.createCommit)[0][1] as { message: string; tree: string; parent: string };
    expect(commit.parent).toBe('head-sha');
    expect(commit.tree).toBe('new-tree');
    expect(commit.message.split('\n')[0]).toBe('chore(capy): update keep.lock');
    expect(commit.message).toContain('NEW_VAR');
    expect(commit.message).not.toMatch(/co-authored-by|generated/i);
    expect(callsOf(f.api.createRef)[0].slice(1)).toEqual(['capy/keep-lock-20260101-000000-ab12', 'new-commit']);
    const pull = callsOf(f.api.createPull)[0][1] as { title: string; body: string; head: string; base: string };
    expect(pull).toMatchObject({ title: 'chore(capy): update keep.lock', head: 'capy/keep-lock-20260101-000000-ab12', base: 'main' });
    expect(pull.body).toContain('capy add');
    expect(pull.body).toContain('development');
    expect(pull.body).toContain('NEW_VAR');
  });

  test('the commit message and PR body name variables and the Capy branch, never anything else', () => {
    const records: readonly EditSaveRecord[] = [
      { branch: 'development', entries: [{ variable: 'A', entry: entry('development', 'HASH_SHOULD_NOT_APPEAR') }] },
    ];
    expect(buildCommitMessage(records)).not.toContain('HASH_SHOULD_NOT_APPEAR');
    expect(buildPrBody('edit', records)).not.toContain('HASH_SHOULD_NOT_APPEAR');
    expect(buildPrBody('edit', records)).toContain('capy edit');
  });

  test('the base has no keep.lock yet: identity is scaffolded from the local keep, only the changed entries are added', async () => {
    const f = makeFakes({ baseFile: null });
    const out = await runKeepLockPrStep(request({ flags: { pr: true, prBase: 'main' } }), f.deps);
    expect(out.keep_lock).toMatchObject({ committed: true });
    const keep = blobKeep(f);
    expect(keep.org_id).toBe('org-1');
    expect(keep.project_id).toBe('proj-1');
    expect(Object.keys(keep.variables)).toEqual(['NEW_VAR']);
  });

  test('no diff vs the base (entry already pinned there): no PR, a structured reason, nothing created', async () => {
    const records: readonly EditSaveRecord[] = [
      { branch: 'development', entries: [{ variable: 'KEEP_ME', entry: entry('development', 'k1') }] },
    ];
    const f = makeFakes();
    const out = await runKeepLockPrStep(request({ records, flags: { pr: true, prBase: 'main' } }), f.deps);
    expect(out.keep_lock).toEqual({ changed: true, committed: false, reason: 'NO_DIFF_VS_BASE' });
    for (const write of [f.api.createBlob, f.api.createTree, f.api.createCommit, f.api.createRef, f.api.createPull]) {
      expect(callsOf(write)).toHaveLength(0);
    }
  });

  test('no diff when the base has no keep.lock and the records leave it empty', async () => {
    const records = recordsForRemoval('development', ['NOT_THERE']);
    const f = makeFakes({ baseFile: null });
    const out = await runKeepLockPrStep(request({ records, flags: { pr: true, prBase: 'main' } }), f.deps);
    expect(out.keep_lock).toMatchObject({ reason: 'NO_DIFF_VS_BASE' });
  });
});

// ── failures never fail the secret change ────────────────────────────────

describe('PR step failures are reported, never thrown', () => {
  const flags = { pr: true, prBase: 'main' } as const;
  const bad = { ok: false, kind: 'REQUEST_FAILED', status: 500 } as const;
  const authBad = { ok: false, kind: 'GH_UNAVAILABLE' } as const;

  const cases: ReadonlyArray<readonly [string, keyof GithubApi, string]> = [
    ['reading the base head', 'getBranchHead', 'KEEP_PR_READ_FAILED'],
    ['reading the base keep.lock', 'getFile', 'KEEP_PR_READ_FAILED'],
    ['creating the blob', 'createBlob', 'KEEP_PR_COMMIT_FAILED'],
    ['creating the tree', 'createTree', 'KEEP_PR_COMMIT_FAILED'],
    ['creating the commit', 'createCommit', 'KEEP_PR_COMMIT_FAILED'],
    ['creating the branch ref', 'createRef', 'KEEP_PR_BRANCH_FAILED'],
    ['opening the pull request', 'createPull', 'KEEP_PR_CREATE_FAILED'],
  ];

  test.each(cases)('%s failing is %s', async (_label, method, code) => {
    const f = makeFakes({ api: { [method]: mock(async () => bad) } as Partial<GithubApi> });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ changed: true, committed: false, error: { code } });
    expect(typeof (out.keep_lock as { error: { message: string } }).error.message).toBe('string');
  });

  test.each(cases)('%s with gh logged out is KEEP_PR_GH_UNAVAILABLE', async (_label, method) => {
    const f = makeFakes({ api: { [method]: mock(async () => authBad) } as Partial<GithubApi> });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_GH_UNAVAILABLE' } });
  });

  test('a later step is never attempted after an earlier one fails', async () => {
    const f = makeFakes({ api: { createTree: mock(async () => bad) } });
    await runKeepLockPrStep(request({ flags }), f.deps);
    expect(callsOf(f.api.createCommit)).toHaveLength(0);
    expect(callsOf(f.api.createRef)).toHaveLength(0);
    expect(callsOf(f.api.createPull)).toHaveLength(0);
  });

  test('not a git repository: KEEP_PR_NOT_GIT_REPO', async () => {
    const f = makeFakes({ deps: { isGitRepo: () => false } });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_NOT_GIT_REPO' } });
    expect(callsOf(f.github)).toHaveLength(0);
  });

  test.each([
    ['no origin remote', null],
    ['a non-GitHub origin', 'git@gitlab.com:acme/app.git'],
    ['a local-path origin', '/srv/git/app.git'],
  ])('%s: KEEP_PR_NO_GITHUB_REMOTE', async (_label, url) => {
    const f = makeFakes({ deps: { originUrl: () => url } });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_NO_GITHUB_REMOTE' } });
    expect(callsOf(f.github)).toHaveLength(0);
  });

  test('gh missing: KEEP_PR_GH_UNAVAILABLE', async () => {
    const f = makeFakes({ deps: { github: () => undefined } });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_GH_UNAVAILABLE' } });
  });

  test('a base keep.lock that is not a keep file: KEEP_PR_READ_FAILED, nothing is overwritten', async () => {
    const f = makeFakes({ baseFile: '{ not json' });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ error: { code: 'KEEP_PR_READ_FAILED' } });
    expect(callsOf(f.api.createBlob)).toHaveLength(0);
  });

  test('an unexpected throw inside the step is still a coded result, not an exception', async () => {
    const f = makeFakes({ api: { getBranchHead: mock(async () => Promise.reject(new Error('boom'))) } });
    const out = await runKeepLockPrStep(request({ flags }), f.deps);
    expect(out.keep_lock).toMatchObject({ changed: true, committed: false, error: { code: 'KEEP_PR_CREATE_FAILED' } });
  });

  test('the error carries a code decided by status, and the same code for any wording', async () => {
    const a = makeFakes({ api: { createPull: mock(async () => ({ ok: false, kind: 'REQUEST_FAILED', status: 422 }) as const) } });
    const b = makeFakes({ api: { createPull: mock(async () => ({ ok: false, kind: 'REQUEST_FAILED', status: 503 }) as const) } });
    const [x, y] = await Promise.all([runKeepLockPrStep(request({ flags }), a.deps), runKeepLockPrStep(request({ flags }), b.deps)]);
    expect(x.keep_lock).toEqual(y.keep_lock);
  });
});

// ── human output ─────────────────────────────────────────────────────────

describe('human output', () => {
  const capture = (fn: () => void) => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      fn();
      return { out: log.mock.calls.map((c) => c.join(' ')).join('\n'), err: err.mock.calls.map((c) => c.join(' ')).join('\n') };
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  };

  test('a created PR prints its URL (stdout for terminal flows, stderr when stdout is reserved)', () => {
    const outcome = { keep_lock: { changed: true, committed: true, pr_url: 'https://github.com/acme/app/pull/1', base: 'main' } } as const;
    expect(capture(() => reportKeepLockHuman(outcome, { successTo: 'stdout', noteUnanswered: false })).out).toContain('/pull/1');
    const piped = capture(() => reportKeepLockHuman(outcome, { successTo: 'stderr', noteUnanswered: false }));
    expect(piped.out).toBe('');
    expect(piped.err).toContain('/pull/1');
  });

  test('a failure is one short stderr line with the code; stdout stays empty', () => {
    const r = capture(() =>
      reportKeepLockHuman(
        { keep_lock: { changed: true, committed: false, error: { code: 'KEEP_PR_CREATE_FAILED', message: 'x' } } },
        { successTo: 'stdout', noteUnanswered: false },
      ),
    );
    expect(r.out).toBe('');
    expect(r.err.split('\n')).toHaveLength(1);
    expect(r.err).toContain('KEEP_PR_CREATE_FAILED');
  });

  test('unchanged keep.lock prints nothing; an unanswered run is silent unless the caller asks for the note', () => {
    expect(capture(() => reportKeepLockHuman({ keep_lock: { changed: false } }, { successTo: 'stdout', noteUnanswered: true }))).toEqual({ out: '', err: '' });
    const unanswered = { keep_lock: { changed: true, committed: false }, unanswered: unansweredStops({}) } as const;
    expect(capture(() => reportKeepLockHuman(unanswered, { successTo: 'stderr', noteUnanswered: false })).err).toBe('');
    expect(capture(() => reportKeepLockHuman(unanswered, { successTo: 'stderr', noteUnanswered: true })).err).not.toBe('');
  });

  test('declining prints the not-committed note on stderr', () => {
    const r = capture(() => reportKeepLockHuman({ keep_lock: { changed: true, committed: false }, declined: true }, { successTo: 'stdout', noteUnanswered: false }));
    expect(r.out).toBe('');
    expect(r.err).not.toBe('');
  });
});

// ── records ──────────────────────────────────────────────────────────────

describe('records from add / piped edit / remove', () => {
  test('a new entry is recorded; the variable and branch are named', () => {
    const after = keepWith({ ...BASE_KEEP.variables, NEW_VAR: [entry('development', 'n1')] });
    expect(recordsForWrite(BASE_KEEP, after, 'development', ['NEW_VAR'])).toEqual(ADDED);
  });

  test('keep.lock untouched (e.g. --no-push) or unchanged entry: no records', () => {
    expect(recordsForWrite(BASE_KEEP, BASE_KEEP, 'development', ['KEEP_ME'])).toEqual([]);
    expect(recordsForWrite(BASE_KEEP, null, 'development', ['KEEP_ME'])).toEqual([]);
  });

  test('only the names that actually changed are recorded', () => {
    const after = keepWith({ ...BASE_KEEP.variables, KEEP_ME: [entry('development', 'k9'), entry('production', 'k2')] });
    const [record] = recordsForWrite(BASE_KEEP, after, 'development', ['KEEP_ME', 'GONE']);
    expect(record.entries.map((e) => e.variable)).toEqual(['KEEP_ME']);
    expect(record.entries[0].entry).toEqual(entry('development', 'k9'));
  });

  test('remove: every name is recorded as a deletion (entry null)', () => {
    expect(recordsForRemoval('development', ['A', 'B'])).toEqual([
      { branch: 'development', entries: [{ variable: 'A', entry: null }, { variable: 'B', entry: null }] },
    ]);
    expect(recordsForRemoval('development', [])).toEqual([]);
  });
});

// ── branch names ─────────────────────────────────────────────────────────

describe('PR branch name', () => {
  test('capy/keep-lock-<UTC yyyymmdd-hhmmss>-<4 chars>, valid under git ref rules', () => {
    const name = newPrBranchName(new Date('2026-10-02T03:04:05Z'), 'a1b2');
    expect(name).toBe('capy/keep-lock-20261002-030405-a1b2');
    expect(isValidBranchName(name)).toBe(true);
  });

  test('the default random suffix is 4 hex characters and differs between runs', () => {
    const now = new Date('2026-10-02T03:04:05Z');
    const names = Array.from({ length: 20 }, () => newPrBranchName(now));
    expect(names.every((n) => /^capy\/keep-lock-20261002-030405-[0-9a-f]{4}$/.test(n))).toBe(true);
    expect(new Set(names).size).toBeGreaterThan(1);
  });
});

// ── the edit TUI hands the terminal back before any PR prompt ────────────

describe('after the edit TUI exits, before the PR prompts', () => {
  test('raw mode is off and the TUI key listener is gone when the confirm runs', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalRaw = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
    const setRawMode = mock((_on: boolean) => process.stdin);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRawMode, configurable: true, writable: true });
    const write = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const dataListenersBefore = process.stdin.listenerCount('data');
    const resizeListenersBefore = process.listenerCount('SIGWINCH');

    try {
      const done = new EditScreen().run(
        { projectName: 'demo', branch: 'development', rows: [], remoteAvailable: true },
        { saveLocalEdits: async () => ({}) },
      );
      // While the TUI runs it owns stdin: raw mode on and one key listener.
      expect(setRawMode.mock.calls.at(-1)?.[0]).toBe(true);
      expect(process.stdin.listenerCount('data')).toBe(dataListenersBefore + 1);

      process.stdin.emit('data', Buffer.from('q')); // quit, nothing pending
      await done;

      // What the PR prompt sees at the moment it starts, recorded by the mock library.
      const seen = mock((_state: { dataListeners: number; rawMode: boolean | undefined; paused: boolean }) => undefined);
      const deps = makeFakes({
        deps: {
          hasTerminal: () => true,
          confirm: async () => {
            seen({
              dataListeners: process.stdin.listenerCount('data'),
              rawMode: setRawMode.mock.calls.at(-1)?.[0],
              paused: process.stdin.isPaused(),
            });
            return false;
          },
        },
      }).deps;

      const out = await runKeepLockPrStep(request({ command: 'edit' }), deps);

      expect(out.keep_lock).toEqual({ changed: true, committed: false });
      expect(seen.mock.calls).toHaveLength(1);
      const [atPrompt] = seen.mock.calls[0];
      expect(atPrompt.dataListeners).toBe(dataListenersBefore); // the TUI's listener is detached
      expect(atPrompt.rawMode).toBe(false); // raw mode released
      expect(atPrompt.paused).toBe(true);
      expect(process.listenerCount('SIGWINCH')).toBe(resizeListenersBefore);
    } finally {
      write.mockRestore();
      if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (originalRaw) Object.defineProperty(process.stdin, 'setRawMode', originalRaw);
      else Reflect.deleteProperty(process.stdin, 'setRawMode');
    }
  });
});
