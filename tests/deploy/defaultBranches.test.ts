/**
 * Default branches of MANY repos: one batched GraphQL read per 50 repos
 * (`GithubApi.getDefaultBranches`), null nodes as unknown bases, a whole-call
 * failure as a failure (decided by gh's exit status / HTTP status / the JSON
 * shape, never by text), the async `gh` runner, and `resolveBases` with its
 * bounded-concurrency per-repo fallback. No `gh`, no network: the runner is injected.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  DEFAULT_BRANCH_CHUNK,
  chunked,
  createGhApi,
  spawnGhRunnerAsync,
  type GhRunResult,
  type GhRunner,
  type GithubApi,
  type RepoRef,
} from '../../src/deploy/githubApi';
import { FALLBACK_CONCURRENCY, resolveBases, repoKey, type RepoTarget } from '../../src/commands/secretsSet';

const http = (status: number, body: unknown): GhRunResult => ({
  spawned: true,
  status: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} X\r\n\r\n${JSON.stringify(body)}`,
});

const repos = (n: number): readonly RepoRef[] => Array.from({ length: n }, (_, i) => ({ owner: `Owner${i}`, name: `repo-${i}` }));

/** A GraphQL answer for the repos in the request: each alias gets `branchOf(index)`; `null` is a missing node. */
function answerFor(stdin: string | undefined, branchOf: (i: number) => string | null) {
  const { variables } = JSON.parse(stdin ?? '{}') as { variables: Record<string, string> };
  const count = Object.keys(variables).length / 2;
  const data = Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const b = branchOf(Number(variables[`n${i}`].replace('repo-', '')));
      return [`r${i}`, b === null ? null : { defaultBranchRef: { name: b } }];
    }),
  );
  return http(200, { data });
}

function recorder(answer: (args: readonly string[], stdin: string | undefined) => GhRunResult) {
  const run = mock((args: readonly string[], stdin?: string) => answer(args, stdin));
  return { run: run as unknown as GhRunner, calls: () => run.mock.calls as unknown as Array<[readonly string[], string | undefined]> };
}

describe('chunked', () => {
  test('consecutive groups of at most `size`; nothing for nothing', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 3)).toEqual([]);
    expect(chunked([1, 2], 5)).toEqual([[1, 2]]);
  });
});

describe('getDefaultBranches: one GraphQL call per chunk', () => {
  test('N repos are ONE `gh api graphql` call, in order, with the names as variables (never in the query text) and the body on stdin', async () => {
    const { run, calls } = recorder((_a, stdin) => answerFor(stdin, (i) => `branch-${i}`));
    const result = await createGhApi(run).getDefaultBranches(repos(7));
    expect(result).toEqual({ ok: true, value: Array.from({ length: 7 }, (_, i) => `branch-${i}`) });
    expect(calls()).toHaveLength(1);
    const [args, stdin] = calls()[0];
    expect(args.slice(0, 3)).toEqual(['api', '--hostname', 'github.com']);
    expect(args).toContain('--input');
    expect(args[args.length - 1]).toBe('graphql');
    expect(args.join(' ')).not.toContain('Owner0');
    const body = JSON.parse(stdin ?? '') as { query: string; variables: Record<string, string> };
    expect(body.query).not.toContain('Owner0');
    expect(body.query).not.toContain('repo-0');
    expect(body.query).toContain('defaultBranchRef{name}');
    expect(body.variables.o0).toBe('Owner0');
    expect(body.variables.n6).toBe('repo-6');
    expect(Object.keys(body.variables)).toHaveLength(14);
  });

  test('chunking at the limit: 50 is one call, 51 is two, 120 is three (50 + 50 + 20), order kept across chunks', async () => {
    const countFor = async (n: number) => {
      const { run, calls } = recorder((_a, stdin) => answerFor(stdin, (i) => `b${i}`));
      const result = await createGhApi(run).getDefaultBranches(repos(n));
      expect(result.ok && result.value).toEqual(Array.from({ length: n }, (_, i) => `b${i}`));
      return calls().map(([, stdin]) => Object.keys((JSON.parse(stdin ?? '') as { variables: object }).variables).length / 2);
    };
    expect(DEFAULT_BRANCH_CHUNK).toBe(50);
    expect(await countFor(50)).toEqual([50]);
    expect(await countFor(51)).toEqual([50, 1]);
    expect(await countFor(120)).toEqual([50, 50, 20]);
    expect(await countFor(1)).toEqual([1]);
  });

  test('no repos, no call', async () => {
    const { run, calls } = recorder(() => http(200, { data: {} }));
    expect(await createGhApi(run).getDefaultBranches([])).toEqual({ ok: true, value: [] });
    expect(calls()).toHaveLength(0);
  });

  test('a missing, inaccessible or empty repo is a null node: an unknown base, not a failure (even with an errors array)', async () => {
    const { run } = recorder((_a, stdin) => {
      const answer = answerFor(stdin, (i) => (i === 1 ? null : 'main'));
      const body = JSON.parse(answer.stdout.slice(answer.stdout.indexOf('\r\n\r\n') + 4)) as { data: Record<string, unknown> };
      // r2 exists but has no commits: defaultBranchRef is null
      return http(200, { data: { ...body.data, r2: { defaultBranchRef: null } }, errors: [{ type: 'NOT_FOUND', path: ['r1'] }] });
    });
    const result = await createGhApi(run).getDefaultBranches(repos(4));
    expect(result).toEqual({ ok: true, value: ['main', null, null, 'main'] });
  });

  test('the call as a whole failing is a failure: no `data` at all, an HTTP error, gh missing, gh not logged in', async () => {
    const noData = await createGhApi(recorder(() => http(200, { errors: [{ message: 'whatever the wording' }] })).run).getDefaultBranches(repos(2));
    expect(noData).toEqual({ ok: false, kind: 'REQUEST_FAILED' });
    const serverError = await createGhApi(recorder(() => http(502, {})).run).getDefaultBranches(repos(2));
    expect(serverError.ok).toBe(false);
    const missing = await createGhApi(recorder(() => ({ spawned: false, status: null, stdout: '' })).run).getDefaultBranches(repos(2));
    expect(missing).toEqual({ ok: false, kind: 'GH_UNAVAILABLE' });
    const auth = await createGhApi(recorder(() => ({ spawned: true, status: 4, stdout: '' })).run).getDefaultBranches(repos(2));
    expect(auth).toEqual({ ok: false, kind: 'GH_UNAVAILABLE' });
  });

  test('if ANY chunk fails as a whole the result is that failure', async () => {
    // The first chunk (50 repos) is answered, the second (10) is refused.
    const { run } = recorder((_a, stdin) => {
      const size = Object.keys((JSON.parse(stdin ?? '') as { variables: object }).variables).length / 2;
      return size === DEFAULT_BRANCH_CHUNK ? answerFor(stdin, () => 'main') : http(500, {});
    });
    const result = await createGhApi(run).getDefaultBranches(repos(60));
    expect(result.ok).toBe(false);
  });

  test('an asynchronous runner works the same as a synchronous one', async () => {
    const run: GhRunner = async (_a, stdin) => answerFor(stdin, () => 'trunk');
    expect(await createGhApi(run).getDefaultBranches(repos(3))).toEqual({ ok: true, value: ['trunk', 'trunk', 'trunk'] });
  });
});

describe('spawnGhRunnerAsync (a real child process, not gh)', () => {
  test('passes argv and stdin through, reports the exit status and stdout, without blocking the event loop', async () => {
    const run = spawnGhRunnerAsync(process.execPath);
    const ticks = mock(() => undefined);
    const timer = setInterval(ticks, 5);
    const echoed = await run(['-e', 'process.stdin.pipe(process.stdout)'], 'hello stdin');
    const slow = await run(['-e', 'setTimeout(()=>process.exit(3), 120)']);
    clearInterval(timer);
    expect(echoed).toEqual({ spawned: true, status: 0, stdout: 'hello stdin' });
    expect(slow).toMatchObject({ spawned: true, status: 3, stdout: '' });
    expect(ticks.mock.calls.length).toBeGreaterThan(3); // the loop kept running while the child did
  });

  test('a binary that cannot be started is `spawned: false`, never a throw', async () => {
    const run = spawnGhRunnerAsync('/definitely/not/a/gh');
    expect(await run(['api'])).toEqual({ spawned: false, status: null, stdout: '' });
  });

  test('two calls overlap (the point of async)', async () => {
    const run = spawnGhRunnerAsync(process.execPath);
    const started = Date.now();
    await Promise.all([run(['-e', 'setTimeout(()=>{}, 300)']), run(['-e', 'setTimeout(()=>{}, 300)'])]);
    expect(Date.now() - started).toBeLessThan(560);
  });
});

// ── resolveBases ────────────────────────────────────────────────────────────

const target = (i: number): RepoTarget => ({
  host: 'github.com',
  owner: `Owner${i}`,
  name: `repo-${i}`,
  files: [{ project_id: `p${i}`, project_name: `proj-${i}`, path: '.' }],
});
const targets = (n: number): readonly RepoTarget[] => Array.from({ length: n }, (_, i) => target(i));

function fakeApi(over: Partial<GithubApi>): GithubApi {
  return {
    getRepo: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    getDefaultBranches: mock(async () => ({ ok: true as const, value: [] })),
    listBranches: mock(async () => ({ ok: true as const, value: [] })),
    getBranchHead: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    getFile: mock(async () => ({ ok: true as const, value: null })),
    createBlob: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    createTree: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    createCommit: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    createRef: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    createPull: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
    ...over,
  };
}

describe('resolveBases', () => {
  test('one batched read for N repos, no per-repo read; null nodes are left out (unknown base)', async () => {
    const getDefaultBranches = mock(async (rs: readonly RepoRef[]) => ({
      ok: true as const,
      value: rs.map((_, i) => (i === 2 ? null : `branch-${i}`)),
    }));
    const api = fakeApi({ getDefaultBranches });
    const bases = await resolveBases(api, targets(5));
    expect(getDefaultBranches.mock.calls).toHaveLength(1);
    expect((api.getRepo as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    expect(bases).toEqual({
      [repoKey(target(0))]: 'branch-0',
      [repoKey(target(1))]: 'branch-1',
      [repoKey(target(3))]: 'branch-3',
      [repoKey(target(4))]: 'branch-4',
    });
  });

  test('no gh, or no repos: nothing is read', async () => {
    expect(await resolveBases(undefined, targets(3))).toEqual({});
    const api = fakeApi({});
    expect(await resolveBases(api, [])).toEqual({});
    expect((api.getDefaultBranches as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('the batched call failing as a whole falls back to one getRepo per repo, at most 6 in flight at once', async () => {
    // Every read stamps when it starts and when it ends; the overlap is computed afterwards from those stamps.
    const stamp = mock((_phase: 'start' | 'end') => performance.now());
    const getRepo = mock(async (r: RepoRef) => {
      stamp('start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      stamp('end');
      return { ok: true as const, value: { defaultBranch: `db-${r.name}` } };
    });
    const api = fakeApi({
      getDefaultBranches: mock(async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const })),
      getRepo,
    });
    const bases = await resolveBases(api, targets(14));
    expect(FALLBACK_CONCURRENCY).toBe(6);
    expect(getRepo.mock.calls).toHaveLength(14);
    const events = stamp.mock.calls
      .map(([phase], i) => ({ phase, at: stamp.mock.results[i].value as number }))
      .toSorted((a, b) => a.at - b.at || (a.phase === 'end' ? -1 : 1));
    const maxInFlight = events.reduce(
      (acc, e) => {
        const now = acc.now + (e.phase === 'start' ? 1 : -1);
        return { now, max: Math.max(acc.max, now) };
      },
      { now: 0, max: 0 },
    ).max;
    expect(maxInFlight).toBe(6); // bounded, and actually concurrent (not one at a time)
    expect(Object.keys(bases)).toHaveLength(14);
    expect(bases[repoKey(target(13))]).toBe('db-repo-13');
  });

  test('in the fallback a repo that cannot be read is left out, not fatal', async () => {
    const api = fakeApi({
      getDefaultBranches: mock(async () => ({ ok: false as const, kind: 'GH_UNAVAILABLE' as const })),
      getRepo: mock(async (r: RepoRef) =>
        r.name === 'repo-1' ? ({ ok: false as const, kind: 'NOT_FOUND' as const }) : ({ ok: true as const, value: { defaultBranch: 'main' } }),
      ),
    });
    const bases = await resolveBases(api, targets(3));
    expect(Object.keys(bases).sort()).toEqual([repoKey(target(0)), repoKey(target(2))].sort());
  });
});
