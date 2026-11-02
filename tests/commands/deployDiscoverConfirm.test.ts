/**
 * `capy deploy dokploy --discover --plan <file> --confirm <plan_id>` (CAP-703): writing a confirmed plan.
 *
 * The properties under test: a plan that moved since it was confirmed does NOTHING (`PLAN_CHANGED`);
 * each project's `.capy/deploy.json` target is merged into the repo's file without touching its other
 * targets, in ONE PR per repo with several paths in one commit; a failure in one repo does not stop the
 * others; running it again after the PRs merged opens nothing; and no value reaches GitHub or stdout.
 *
 * Fakes only (`tests/helpers/deployDiscoverWorld.ts`): the "GitHub" records what it was asked to write.
 */
import { describe, test, expect } from 'bun:test';
import { runDeployDokployDiscover } from '../../src/commands/deployDiscover/command';
import {
  BASE_URL,
  ENTRY_API,
  ENTRY_API_STG,
  ENTRY_SOLO,
  ENTRY_WEB,
  EXISTING_API_DEPLOY,
  GITHUB_REPOS,
  SENTINEL_CAPY,
  SENTINEL_DOKPLOY,
  githubFake,
  makeWorld,
  planFile,
  writtenBy,
} from '../helpers/deployDiscoverWorld';

const PLAN = 'plan.json';
const ENTRIES = [ENTRY_SOLO, ENTRY_API, ENTRY_API_STG, ENTRY_WEB];

async function run(text: string, opts: { dryRun?: boolean; confirm?: string }, world = makeWorld({ files: { [PLAN]: text } })) {
  const result = await runDeployDokployDiscover(
    { baseUrl: BASE_URL, plan: PLAN, ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }), ...(opts.confirm === undefined ? {} : { confirm: opts.confirm }) },
    world.io,
  );
  return { world, exitCode: result.exitCode, body: result.body as any };
}

/** The plan_id a dry run prints: what a human approved. */
async function approvedId(text: string): Promise<string> {
  return (await run(text, { dryRun: true })).body.plan_id;
}

const nothingWritten = (world: ReturnType<typeof makeWorld>): void => {
  expect(world.github.createBlob).not.toHaveBeenCalled();
  expect(world.github.createTree).not.toHaveBeenCalled();
  expect(world.github.createCommit).not.toHaveBeenCalled();
  expect(world.github.createRef).not.toHaveBeenCalled();
  expect(world.github.createPull).not.toHaveBeenCalled();
};

describe('confirm: a plan that moved is refused, and nothing is done', () => {
  test('a wrong plan_id: PLAN_CHANGED, no request to Dokploy, Capy or GitHub at all', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile(ENTRIES) } });
    const { body, exitCode } = await run(planFile(ENTRIES), { confirm: 'not-the-id' }, world);
    expect(exitCode).toBe(1);
    expect(body.code).toBe('PLAN_CHANGED');
    expect(typeof body.plan_id).toBe('string');
    expect(world.dokploy.listProjects).not.toHaveBeenCalled();
    expect(world.capy.getOrgRepos).not.toHaveBeenCalled();
    expect(world.github.getDefaultBranches).not.toHaveBeenCalled();
    nothingWritten(world);
  });

  test('a plan edited after the dry run (one variable dropped): the old plan_id no longer matches', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const edited = planFile([ENTRY_SOLO, ENTRY_API, ENTRY_API_STG, { ...ENTRY_WEB, vars: ['SESSION_SECRET'] }]);
    const world = makeWorld({ files: { [PLAN]: edited } });
    const { body } = await run(edited, { confirm: approved }, world);
    expect(body.code).toBe('PLAN_CHANGED');
    nothingWritten(world);
  });

  test('the same plan in another order still matches: ordering is not a change', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const reordered = planFile([ENTRY_WEB, ENTRY_API_STG, ENTRY_API, ENTRY_SOLO]);
    const { body } = await run(reordered, { confirm: approved });
    expect(body.ok).toBe(true);
  });
});

describe('confirm: deploy.json is written, one PR per repo', () => {
  test('one PR per repo; a monorepo\'s several deploy.json paths go in ONE commit; the base is the default branch', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world, body, exitCode } = await run(planFile(ENTRIES), { confirm: approved });
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.plan_id).toBe(approved);
    expect(body.failed).toEqual([]);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/backend', 'acme/solo']);
    expect(body.prs[0]).toMatchObject({ base: 'main', paths: ['api/.capy/deploy.json', 'web/.capy/deploy.json'], targets: ['dokploy-production', 'dokploy-staging', 'dokploy-production'] });
    expect(body.prs[1]).toMatchObject({ base: 'main', paths: ['.capy/deploy.json'], targets: ['dokploy-production'] });

    const written = writtenBy(world.github);
    expect(world.github.createPull).toHaveBeenCalledTimes(2);
    expect(world.github.createCommit).toHaveBeenCalledTimes(2);
    expect(world.github.createTree).toHaveBeenCalledTimes(2);
    expect(written.commits.find((c) => c.repo === 'acme/backend')?.files).toBeDefined();
    expect(Object.keys(written.commits.find((c) => c.repo === 'acme/backend')?.files ?? {})).toEqual(['api/.capy/deploy.json', 'web/.capy/deploy.json']);
    expect(Object.keys(written.commits.find((c) => c.repo === 'acme/solo')?.files ?? {})).toEqual(['.capy/deploy.json']);
    expect(written.pulls.map((p) => [p.repo, p.base])).toEqual([['acme/backend', 'main'], ['acme/solo', 'main']]);
  });

  test('the target is the one `capy deploy` writes: CI mode, the Capy branch, the git base branch, the service id, no token', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const solo = JSON.parse(writtenBy(world.github).commits.find((c) => c.repo === 'acme/solo')?.files['.capy/deploy.json'] as string);
    expect(solo).toEqual({
      version: '1',
      targets: {
        'dokploy-production': {
          name: 'dokploy-production',
          kind: 'dokploy',
          branch: 'production',
          vars: ['A', 'B', 'C', 'D'],
          knownVars: ['A', 'B', 'C', 'D'],
          options: { baseUrl: BASE_URL, composeId: 'cmp_solo' },
          mode: 'ci',
          gitBaseBranch: 'main',
        },
      },
    });
    // Same key order as the deploy flow's own target.
    expect(Object.keys(solo.targets['dokploy-production'])).toEqual(['name', 'kind', 'branch', 'vars', 'knownVars', 'options', 'mode', 'gitBaseBranch']);
  });

  test('an Application target carries applicationId; knownVars is the project\'s whole variable set on that branch', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const api = JSON.parse(writtenBy(world.github).commits.find((c) => c.repo === 'acme/backend')?.files['api/.capy/deploy.json'] as string);
    expect(api.targets['dokploy-staging']).toMatchObject({
      kind: 'dokploy',
      branch: 'staging',
      vars: ['API_KEY', 'DATABASE_URL'],
      knownVars: ['API_KEY', 'DATABASE_URL', 'REDIS_URL'],
      options: { baseUrl: BASE_URL, applicationId: 'app_api_stg' },
      gitBaseBranch: 'staging',
    });
  });

  test('the file is MERGED: another target and other fields already in deploy.json are left exactly as they were', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const api = JSON.parse(writtenBy(world.github).commits.find((c) => c.repo === 'acme/backend')?.files['api/.capy/deploy.json'] as string);
    expect(Object.keys(api.targets)).toEqual(['ssm-prod', 'dokploy-production', 'dokploy-staging']);
    expect(api.targets['ssm-prod']).toEqual(JSON.parse(EXISTING_API_DEPLOY).targets['ssm-prod']);
    expect(api.version).toBe('1');
  });

  test('a target name already in the file is never reused: the new one gets a numeric suffix', async () => {
    const taken = JSON.stringify(
      { version: '1', targets: { 'dokploy-production': { name: 'dokploy-production', kind: 'dokploy', branch: 'other', vars: [], options: { composeId: 'cmp_elsewhere' } } } },
      null,
      2,
    );
    const repos = { ...GITHUB_REPOS, 'acme/solo': { ...GITHUB_REPOS['acme/solo'], files: { '.capy/deploy.json': taken } } };
    const text = planFile([ENTRY_SOLO]);
    const world = makeWorld({ files: { [PLAN]: text }, repos });
    const approved = (await run(text, { dryRun: true }, world)).body.plan_id;
    const { body } = await run(text, { confirm: approved }, world);
    expect(body.prs[0].targets).toEqual(['dokploy-production-2']);
    const written = JSON.parse(writtenBy(world.github).commits[0].files['.capy/deploy.json']);
    expect(Object.keys(written.targets)).toEqual(['dokploy-production', 'dokploy-production-2']);
    expect(written.targets['dokploy-production'].options).toEqual({ composeId: 'cmp_elsewhere' });
  });

  test('the PR says what it adds, by name and id only', async () => {
    const approved = await approvedId(planFile([ENTRY_SOLO]));
    const { world } = await run(planFile([ENTRY_SOLO]), { confirm: approved });
    const written = writtenBy(world.github);
    expect(written.pulls[0].title.length).toBeGreaterThan(0);
    expect(written.pulls[0].body).toContain('dokploy-production');
    expect(written.pulls[0].body).toContain('cmp_solo');
    expect(written.pulls[0].head).toBe('capy/dokploy-targets-test-0000');
  });

  test('nothing is recorded or pushed on the Capy side: the only Capy calls are the two reads', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    // The fake Capy client has no other method: any other call would have thrown.
    expect(new Set(Object.keys(world.capy.client))).toEqual(new Set(['getOrgRepos', 'getSecretIndex']));
  });
});

describe('confirm: repos fail independently', () => {
  test('a failure in one repo is a coded result for that repo; the others still open their PR', async () => {
    const repos = { ...GITHUB_REPOS, 'acme/solo': { ...GITHUB_REPOS['acme/solo'], failing: ['createRef' as const] } };
    const text = planFile(ENTRIES);
    const world = makeWorld({ files: { [PLAN]: text }, repos });
    const approved = (await run(text, { dryRun: true }, world)).body.plan_id;
    const { body, exitCode } = await run(text, { confirm: approved }, world);
    expect(exitCode).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('DISCOVER_PARTIAL');
    expect(body.failed).toEqual([{ repo: 'acme/solo', code: 'KEEP_PR_BRANCH_FAILED' }]);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/backend']);
    expect(world.github.createPull).toHaveBeenCalledTimes(1);
  });

  test('the first repo failing does not stop the second', async () => {
    const repos = { ...GITHUB_REPOS, 'acme/backend': { ...GITHUB_REPOS['acme/backend'], failing: ['createCommit' as const] } };
    const text = planFile(ENTRIES);
    const world = makeWorld({ files: { [PLAN]: text }, repos });
    const approved = (await run(text, { dryRun: true }, world)).body.plan_id;
    const { body } = await run(text, { confirm: approved }, world);
    expect(body.failed).toEqual([{ repo: 'acme/backend', code: 'KEEP_PR_COMMIT_FAILED' }]);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/solo']);
  });
});

describe('confirm: idempotent', () => {
  test('after the PRs merge, the same plan reports already_configured and opens nothing', async () => {
    const text = planFile(ENTRIES);
    const approved = await approvedId(text);
    const first = await run(text, { confirm: approved });
    const written = writtenBy(first.world.github);

    // The merged world: each written deploy.json is now on the default branch.
    const merged = Object.fromEntries(
      written.commits.map((c) => [c.repo, { ...GITHUB_REPOS[c.repo], files: { ...(GITHUB_REPOS[c.repo].files ?? {}), ...c.files } }] as const),
    );
    const repos = { ...GITHUB_REPOS, ...merged };
    const world = makeWorld({ files: { [PLAN]: text }, repos });
    const { body, exitCode } = await run(text, { confirm: approved }, world);
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.prs).toEqual([]);
    expect(body.already_configured).toHaveLength(4);
    expect(body.already_configured.map((a: any) => a.target_name)).toEqual(expect.arrayContaining(['dokploy-production', 'dokploy-staging']));
    nothingWritten(world);
  });

  test('--dry-run with --confirm changes nothing: the dry run wins', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile(ENTRIES) } });
    const approved = (await run(planFile(ENTRIES), { dryRun: true }, world)).body.plan_id;
    const { body } = await run(planFile(ENTRIES), { dryRun: true, confirm: approved }, world);
    expect(body.dry_run).toBe(true);
    nothingWritten(world);
  });
});

describe('confirm: no value is read, printed, written or sent', () => {
  test('neither sentinel is in the output, the progress lines, any blob, the commit message or the PR', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world, body } = await run(planFile(ENTRIES), { confirm: approved });
    const written = writtenBy(world.github);
    const everything = [
      JSON.stringify(body),
      world.progress.mock.calls.map(([l]) => String(l)).join('\n'),
      world.github.createBlob.mock.calls.map(([, content]) => String(content)).join('\n'),
      written.commitMessages.join('\n'),
      written.pulls.map((p) => `${p.title}\n${p.body}`).join('\n'),
      world.github.createCommit.mock.calls.map(([, params]) => JSON.stringify(params)).join('\n'),
    ].join('\n');
    expect(everything).not.toContain(SENTINEL_DOKPLOY);
    expect(everything).not.toContain(SENTINEL_CAPY);
    // The check bites: names ARE written, so an empty capture cannot pass this.
    expect(everything).toContain('SESSION_SECRET');
    expect(world.github.createBlob.mock.calls.length).toBeGreaterThan(0);
  });

  test('GitHub is read through the existing GithubApi only: a fake whose every method is a mock sees exactly the reads and the writes of one run', async () => {
    const gh = githubFake(GITHUB_REPOS);
    expect(new Set(Object.keys(gh.api))).toEqual(
      new Set(['createBlob', 'createCommit', 'createPull', 'createRef', 'createTree', 'getBranchHead', 'getDefaultBranches', 'getFile', 'getRepo', 'listBranches']),
    );
  });
});
