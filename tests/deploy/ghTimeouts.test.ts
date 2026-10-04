/**
 * Every `gh` call is bounded: a `gh` that connects and never answers is killed
 * after a timeout and comes back as a structured timeout (a flag, not text), which
 * maps to the coded failure GITHUB_TIMEOUT. A stalled GitHub never hangs a flow:
 * the base read gives unknown bases and the run goes on. A real child process
 * stands in for the stalled `gh` (tests/helpers/fake-gh-hang.cjs); no network.
 */
import { describe, test, expect, mock } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  GH_GRAPHQL_TIMEOUT_MS,
  GH_TIMEOUT_MS,
  createGhApi,
  spawnGhRunner,
  spawnGhRunnerAsync,
  type GhRunResult,
  type GhRunner,
  type RepoRef,
} from '../../src/deploy/githubApi';
import { resolveBases, runSecretSet, repoKey, type RepoTarget } from '../../src/commands/secretsSet';
import { openKeepLockPullRequest } from '../../src/commands/keepLockPr';
import { ERROR_CODES } from '../../src/types/index';
import { LOCATIONS, NAME, PROJECT_NAMES, SENTINEL, fakeService, makeEnv, type ProjectId } from '../helpers/secretsWorld';

const HANG = join(import.meta.dir, '../helpers/fake-gh-hang.cjs');
chmodSync(HANG, 0o755);

const REPO: RepoRef = { owner: 'acme', name: 'app' };
const timedOut: GhRunResult = { spawned: true, status: null, stdout: '', timedOut: true };

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

describe('the runners kill a gh that never answers', () => {
  test('async: killed after the timeout, `timedOut` set, status null, back in about the bound', async () => {
    const { value, ms } = await timed(() => spawnGhRunnerAsync(HANG, 250)(['api', 'x']));
    expect(value).toMatchObject({ spawned: true, status: null, timedOut: true });
    expect(ms).toBeGreaterThanOrEqual(220);
    expect(ms).toBeLessThan(2500);
  });

  test('sync: the same flag from spawnSync\'s own timeout', () => {
    const t0 = Date.now();
    const value = spawnGhRunner(HANG, 250)(['api', 'x']);
    expect(value).toMatchObject({ spawned: true, status: null, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  test('a per-call timeout overrides the default; the defaults are bounded constants', async () => {
    expect(GH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GH_GRAPHQL_TIMEOUT_MS).toBeGreaterThanOrEqual(GH_TIMEOUT_MS);
    const { value } = await timed(() => spawnGhRunnerAsync(HANG, 60_000)(['api'], undefined, { timeoutMs: 200 }));
    expect(value.timedOut).toBe(true);
  });

  test('a call that finishes in time is not flagged; a gh that cannot start is spawned:false, not a timeout', async () => {
    const ok = await spawnGhRunnerAsync(process.execPath, 5_000)(['-e', 'process.stdout.write("hi")']);
    expect(ok).toEqual({ spawned: true, status: 0, stdout: 'hi' });
    expect(await spawnGhRunnerAsync('/definitely/not/gh', 5_000)(['x'])).toEqual({ spawned: false, status: null, stdout: '' });
  });

  test('an aborted signal kills the call at once and says so (not a timeout); an already-aborted one never starts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const { value, ms } = await timed(() => spawnGhRunnerAsync(HANG, 60_000)(['api'], undefined, { signal: controller.signal }));
    expect(value).toMatchObject({ status: null, aborted: true });
    expect(value.timedOut).toBeUndefined();
    expect(ms).toBeLessThan(2500);
    const done = await spawnGhRunnerAsync(HANG, 60_000)(['api'], undefined, { signal: controller.signal });
    expect(done).toMatchObject({ aborted: true });
  });
});

describe('a timed-out call is the coded failure TIMEOUT', () => {
  const api = (run: GhRunner) => createGhApi(run);
  const timing = () => mock(() => timedOut);

  test('every read and write the PR step makes', async () => {
    const run = timing();
    const gh = api(run);
    const results = await Promise.all([
      gh.getRepo(REPO),
      gh.getBranchHead(REPO, 'main'),
      gh.getFile(REPO, 'keep.lock', 'main'),
      gh.createBlob(REPO, 'x'),
      gh.createTree(REPO, { baseTree: 't', path: 'p', blobSha: 'b' }),
      gh.createCommit(REPO, { message: 'm', tree: 't', parent: 'p' }),
      gh.createRef(REPO, 'b', 's'),
      gh.createPull(REPO, { title: 't', body: 'b', head: 'h', base: 'm' }),
      gh.listBranches(REPO),
      gh.getDefaultBranches([REPO]),
    ]);
    results.forEach((r) => expect(r).toEqual({ ok: false, kind: 'TIMEOUT' }));
  });

  test('the batched read gets the longer bound and the caller\'s signal; the others use the default', async () => {
    const run = mock((_a: readonly string[], _s?: string, _o?: unknown): GhRunResult => timedOut);
    const controller = new AbortController();
    await api(run as unknown as GhRunner).getDefaultBranches([REPO], { signal: controller.signal });
    await api(run as unknown as GhRunner).getRepo(REPO);
    const [graphql, plain] = run.mock.calls;
    expect(graphql[2]).toMatchObject({ timeoutMs: GH_GRAPHQL_TIMEOUT_MS, signal: controller.signal });
    expect(plain[2]).toBeUndefined();
  });

  test('the keep.lock PR step reports it as GITHUB_TIMEOUT, whichever call stalled (decided by the flag, never by text)', async () => {
    const stalledAt = (call: 'getRepo' | 'getBranchHead' | 'createPull') => {
      const ok = <T>(value: T) => ({ ok: true as const, value });
      const gh = {
        getRepo: async () => (call === 'getRepo' ? { ok: false as const, kind: 'TIMEOUT' as const } : ok({ defaultBranch: 'main' })),
        getDefaultBranches: async () => ok([]),
        listBranches: async () => ok([]),
        getBranchHead: async () => (call === 'getBranchHead' ? { ok: false as const, kind: 'TIMEOUT' as const } : ok({ commitSha: 'h', treeSha: 't' })),
        getFile: async () => ok(null),
        createBlob: async () => ok({ sha: 'b' }),
        createTree: async () => ok({ sha: 't2' }),
        createCommit: async () => ok({ sha: 'c' }),
        createRef: async () => ok({ ref: 'r' }),
        createPull: async () => (call === 'createPull' ? { ok: false as const, kind: 'TIMEOUT' as const } : ok({ url: 'u' })),
      };
      const keep = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'n', variables: { V: [{ resource_id: 'r', branch: 'b', value_hash: 'h' }] } };
      return openKeepLockPullRequest(
        { command: 'secrets', repo: REPO, files: [{ path: 'keep.lock', records: [{ branch: 'b', entries: [{ variable: 'V', entry: keep.variables.V[0] }] }], localKeep: keep }] },
        { github: gh, branchName: () => 'capy/x' },
      );
    };
    expect(await stalledAt('getRepo')).toEqual({ ok: false, code: ERROR_CODES.GITHUB_TIMEOUT });
    expect(await stalledAt('getBranchHead')).toEqual({ ok: false, code: ERROR_CODES.GITHUB_TIMEOUT });
    expect(await stalledAt('createPull')).toEqual({ ok: false, code: ERROR_CODES.GITHUB_TIMEOUT });
  });
});

// ── a stalled GitHub, end to end through the engine ─────────────────────────

const target = (project: ProjectId, name: string): RepoTarget => ({
  host: 'github.com',
  owner: 'Acme',
  name,
  files: [{ project_id: project, project_name: PROJECT_NAMES[project], path: '.' }],
});

/** The stalled gh with every call's bound clamped to 250ms (the production bounds are 20s and 30s). */
const stalledGh = (): GhRunner => {
  const run = spawnGhRunnerAsync(HANG, 250);
  return (args, stdin, opts) => run(args, stdin, { ...opts, timeoutMs: 250 });
};

describe('a gh that never answers: the flow goes on with unknown bases and never hangs', () => {
  test('the base read times out within the bound and yields unknown bases (no per-repo fallback storm)', async () => {
    const gh = createGhApi(stalledGh());
    const { value, ms } = await timed(() => resolveBases(gh, [target('pA', 'one'), target('pC', 'two'), target('pB', 'three')]));
    expect(value).toEqual({});
    expect(ms).toBeLessThan(2500); // one timed-out call, not one per repo
  });

  test('the run still pushes every location and each repo\'s PR fails with GITHUB_TIMEOUT, each bounded', async () => {
    const service = fakeService();
    const gh = createGhApi(stalledGh());
    const env = makeEnv(service, gh);
    const locations = LOCATIONS.filter((l) => l.project === 'pA' || l.project === 'pC').map((l) => ({
      project_id: l.project,
      project_name: PROJECT_NAMES[l.project],
      branch: l.branch,
      protected: l.protected === true,
    }));
    const repos = [target('pA', 'one'), target('pC', 'two')];
    const { value: result, ms } = await timed(() => runSecretSet({ name: NAME, value: SENTINEL, locations, repos, bases: {} }, env));
    expect(result.updated).toHaveLength(locations.length); // the values were pushed regardless
    expect(result.prs).toEqual([]);
    expect(result.failed).toEqual([
      { kind: 'repo', repo: 'Acme/one', code: ERROR_CODES.GITHUB_TIMEOUT },
      { kind: 'repo', repo: 'Acme/two', code: ERROR_CODES.GITHUB_TIMEOUT },
    ]);
    expect(ms).toBeLessThan(4000);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test('resolveBases: a TIMEOUT or an aborted signal never falls back to per-repo reads', async () => {
    const getRepo = mock(async () => ({ ok: true as const, value: { defaultBranch: 'main' } }));
    const stalled = { getRepo, getDefaultBranches: async () => ({ ok: false as const, kind: 'TIMEOUT' as const }) } as never;
    expect(await resolveBases(stalled, [target('pA', 'one')])).toEqual({});
    const aborted = new AbortController();
    aborted.abort();
    expect(await resolveBases({ getRepo, getDefaultBranches: async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const }) } as never, [target('pA', 'one')], aborted.signal)).toEqual({});
    expect(getRepo.mock.calls).toHaveLength(0);
    // …while an ordinary failure still falls back
    const ordinary = { getRepo, getDefaultBranches: async () => ({ ok: false as const, kind: 'REQUEST_FAILED' as const }) } as never;
    expect(await resolveBases(ordinary, [target('pA', 'one')])).toEqual({ [repoKey(target('pA', 'one'))]: 'main' });
  });
});
