/**
 * `capy deploy vercel --discover --plan <file> --confirm <plan_id>` (CAP-696): writing a confirmed plan.
 *
 * The properties under test: a plan that moved since it was confirmed does NOTHING (`PLAN_CHANGED`, not
 * even a request to Vercel); each Capy project's `.capy/deploy.json` target is exactly the shape the Vercel
 * setup saves, merged into the repo's file without touching its other targets, in ONE PR per repo; a
 * monorepo's root directory shows up in `projectDir`; target names are unique per file; a failure in one
 * repo does not stop the others; running the plan again after the PRs merged opens nothing; and no value
 * reaches GitHub or stdout.
 *
 * Fakes only (`tests/helpers/deployDiscoverVercelWorld.ts`): the "GitHub" records what it was asked to write.
 */
import { describe, test, expect } from 'bun:test';
import { runDeployVercelDiscover } from '../../src/commands/deployDiscover/vercel';
import { writtenBy } from '../helpers/deployDiscoverWorld';
import { SENTINEL_CAPY } from '../helpers/deployDiscoverWorld';
import {
  ENTRY_CFG,
  ENTRY_DUO_A,
  ENTRY_DUO_B,
  ENTRY_MADMIN,
  ENTRY_MWEB,
  ENTRY_PERSONAL,
  ENTRY_SHOP,
  ENTRY_SHOP_FEATURE,
  ENTRY_SHOP_PREVIEW,
  ENTRY_SHOP_STAGING,
  EXISTING_MONO_DEPLOY,
  GITHUB_REPOS,
  SENTINEL_VERCEL,
  VERCEL_TOKEN,
  VercelWorld,
  makeVercelWorld,
  planFile,
} from '../helpers/deployDiscoverVercelWorld';

const PLAN = 'plan.json';
const ENTRIES = [ENTRY_SHOP, ENTRY_SHOP_PREVIEW, ENTRY_SHOP_FEATURE, ENTRY_SHOP_STAGING, ENTRY_MWEB, ENTRY_MADMIN, ENTRY_DUO_A, ENTRY_DUO_B, ENTRY_PERSONAL];

async function run(text: string, opts: { dryRun?: boolean; confirm?: string }, world: VercelWorld = makeVercelWorld({ files: { [PLAN]: text } })) {
  const result = await runDeployVercelDiscover(
    { plan: PLAN, ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }), ...(opts.confirm === undefined ? {} : { confirm: opts.confirm }) },
    world.io,
  );
  return { world, exitCode: result.exitCode, body: result.body as any };
}

/** The plan_id a dry run prints: what a human approved. */
async function approvedId(text: string, world?: VercelWorld): Promise<string> {
  return (await run(text, { dryRun: true }, world)).body.plan_id;
}

const nothingWritten = (world: VercelWorld): void => {
  expect(world.github.createBlob).not.toHaveBeenCalled();
  expect(world.github.createTree).not.toHaveBeenCalled();
  expect(world.github.createCommit).not.toHaveBeenCalled();
  expect(world.github.createRef).not.toHaveBeenCalled();
  expect(world.github.createPull).not.toHaveBeenCalled();
};

const fileOf = (world: VercelWorld, repo: string, path: string) => JSON.parse(writtenBy(world.github).commits.find((c) => c.repo === repo)?.files[path] as string);

describe('confirm: a plan that moved is refused, and nothing is done', () => {
  test('a wrong plan_id: PLAN_CHANGED, no request to Vercel, Capy or GitHub at all', async () => {
    const world = makeVercelWorld({ files: { [PLAN]: planFile(ENTRIES) } });
    const { body, exitCode } = await run(planFile(ENTRIES), { confirm: 'not-the-id' }, world);
    expect(exitCode).toBe(1);
    expect(body.code).toBe('PLAN_CHANGED');
    expect(typeof body.plan_id).toBe('string');
    expect(world.fetchMock).not.toHaveBeenCalled();
    expect(world.getSecret).not.toHaveBeenCalled();
    expect(world.capy.getOrgRepos).not.toHaveBeenCalled();
    expect(world.github.getDefaultBranches).not.toHaveBeenCalled();
    nothingWritten(world);
  });

  test('a plan edited after the dry run (one variable dropped): the old plan_id no longer matches', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const edited = planFile([...ENTRIES.slice(0, 4), { ...ENTRY_MWEB, vars: ['WEB_KEY'] }, ...ENTRIES.slice(5)].map((e) => (e === ENTRY_SHOP ? { ...e, vars: ['DB_URL'] } : e)));
    const world = makeVercelWorld({ files: { [PLAN]: edited } });
    const { body } = await run(edited, { confirm: approved }, world);
    expect(body.code).toBe('PLAN_CHANGED');
    nothingWritten(world);
  });

  test('the same plan in another order still matches: ordering is not a change', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { body } = await run(planFile([...ENTRIES].reverse()), { confirm: approved });
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
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/duo', 'acme/mono', 'acme/personal', 'acme/shop']);
    expect(body.prs.find((p: any) => p.repo === 'acme/mono')).toMatchObject({ base: 'main', paths: ['apps/admin/.capy/deploy.json', 'apps/web/.capy/deploy.json'] });
    expect(body.prs.find((p: any) => p.repo === 'acme/personal')).toMatchObject({ base: 'trunk' });

    const written = writtenBy(world.github);
    expect(world.github.createPull).toHaveBeenCalledTimes(4);
    expect(world.github.createCommit).toHaveBeenCalledTimes(4);
    expect(Object.keys(written.commits.find((c) => c.repo === 'acme/mono')?.files ?? {})).toEqual(['apps/admin/.capy/deploy.json', 'apps/web/.capy/deploy.json']);
    expect(written.pulls.map((p) => [p.repo, p.base])).toEqual([['acme/duo', 'main'], ['acme/mono', 'main'], ['acme/personal', 'trunk'], ['acme/shop', 'main']]);
  });

  test('every environment of a project is a target of its own: production, preview, a scoped preview, a custom environment', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const shop = fileOf(world, 'acme/shop', '.capy/deploy.json');
    expect(Object.keys(shop.targets)).toEqual(['vercel-feature-x', 'vercel-preview', 'vercel-production', 'vercel-staging']);
    expect(shop.targets['vercel-production']).toEqual({
      name: 'vercel-production',
      kind: 'vercel',
      branch: 'production',
      vars: ['API_KEY', 'DB_URL', 'STRIPE_KEY'],
      knownVars: ['API_KEY', 'DB_URL', 'STRIPE_KEY'],
      options: { projectDir: '.', vercelEnv: 'production', projectId: 'prj_shop', teamId: 'team_1' },
      mode: 'ci',
      gitBaseBranch: 'main',
    });
    // Same key order as the Vercel setup's own target.
    expect(Object.keys(shop.targets['vercel-production'])).toEqual(['name', 'kind', 'branch', 'vars', 'knownVars', 'options', 'mode', 'gitBaseBranch']);
    expect(Object.keys(shop.targets['vercel-production'].options)).toEqual(['projectDir', 'vercelEnv', 'projectId', 'teamId']);
  });

  test('a preview that is not scoped has no gitBranch; a scoped one has it; a custom environment has its id; the Capy branch is each target\'s own', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const shop = fileOf(world, 'acme/shop', '.capy/deploy.json').targets;
    expect(shop['vercel-preview'].options).toEqual({ projectDir: '.', vercelEnv: 'preview', projectId: 'prj_shop', teamId: 'team_1' });
    expect(shop['vercel-feature-x'].options).toEqual({ projectDir: '.', vercelEnv: 'preview', projectId: 'prj_shop', teamId: 'team_1', gitBranch: 'feature-x' });
    expect(shop['vercel-feature-x'].branch).toBe('feature-x');
    expect(shop['vercel-staging'].options).toEqual({ projectDir: '.', vercelEnv: 'staging', projectId: 'prj_shop', teamId: 'team_1', customEnvironmentId: 'env_stg' });
    expect(shop['vercel-staging'].branch).toBe('staging');
  });

  test('knownVars is the project\'s whole variable set on that branch; vars is what the plan picked', async () => {
    const approved = await approvedId(planFile([{ ...ENTRY_MWEB, vars: ['WEB_KEY'] }]));
    const { world } = await run(planFile([{ ...ENTRY_MWEB, vars: ['WEB_KEY'] }]), { confirm: approved });
    const web = fileOf(world, 'acme/mono', 'apps/web/.capy/deploy.json').targets['vercel-production'];
    expect(web.vars).toEqual(['WEB_KEY']);
    expect(web.knownVars).toEqual(['WEB_KEY', 'WEB_OTHER']);
  });

  test('a project in a monorepo: projectDir is its root directory relative to the folder the deploy.json lives in', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    // The Capy project is linked at apps/web, and so is the Vercel project's root directory: the same folder.
    expect(fileOf(world, 'acme/mono', 'apps/web/.capy/deploy.json').targets['vercel-production'].options.projectDir).toBe('.');
    // One Capy project at the repo root, two Vercel projects in folders below it: each target names its folder.
    const duo = fileOf(world, 'acme/duo', '.capy/deploy.json').targets;
    expect(duo['vercel-production'].options).toMatchObject({ projectDir: 'apps/a', projectId: 'prj_a' });
    expect(duo['vercel-production-2'].options).toMatchObject({ projectDir: 'apps/b', projectId: 'prj_b' });
  });

  test('a target name is unique in its deploy.json: a second Vercel project on the same Capy branch gets a numeric suffix', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { body } = await run(planFile(ENTRIES), { confirm: approved });
    expect(body.prs.find((p: any) => p.repo === 'acme/duo').targets).toEqual(['vercel-production', 'vercel-production-2']);
  });

  test('a personal-account project has no teamId in its target', async () => {
    const approved = await approvedId(planFile([ENTRY_PERSONAL]));
    const { world } = await run(planFile([ENTRY_PERSONAL]), { confirm: approved });
    const target = fileOf(world, 'acme/personal', '.capy/deploy.json').targets['vercel-production'];
    expect(target.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'prj_personal' });
    expect(target.gitBaseBranch).toBe('trunk');
  });

  test('the file is MERGED: another target already in deploy.json is left exactly as it was', async () => {
    const approved = await approvedId(planFile([ENTRY_MWEB]));
    const { world } = await run(planFile([ENTRY_MWEB]), { confirm: approved });
    const web = fileOf(world, 'acme/mono', 'apps/web/.capy/deploy.json');
    expect(Object.keys(web.targets)).toEqual(['ssm-prod', 'vercel-production']);
    expect(web.targets['ssm-prod']).toEqual(JSON.parse(EXISTING_MONO_DEPLOY).targets['ssm-prod']);
    expect(web.version).toBe('1');
  });

  test('a target name already in the file is never reused: the new one gets a numeric suffix', async () => {
    const taken = JSON.stringify({ version: '1', targets: { 'vercel-production': { name: 'vercel-production', kind: 'vercel', branch: 'other', vars: [], options: { projectId: 'prj_elsewhere', vercelEnv: 'production' } } } }, null, 2);
    const repos = { ...GITHUB_REPOS, 'acme/shop': { ...GITHUB_REPOS['acme/shop'], files: { '.capy/deploy.json': taken } } };
    const text = planFile([ENTRY_SHOP]);
    const world = makeVercelWorld({ files: { [PLAN]: text }, repos });
    const approved = await approvedId(text, world);
    const { body } = await run(text, { confirm: approved }, world);
    expect(body.prs[0].targets).toEqual(['vercel-production-2']);
    const written = fileOf(world, 'acme/shop', '.capy/deploy.json');
    expect(Object.keys(written.targets)).toEqual(['vercel-production', 'vercel-production-2']);
    expect(written.targets['vercel-production'].options).toEqual({ projectId: 'prj_elsewhere', vercelEnv: 'production' });
  });

  test('the PR says what it adds, by name and id only', async () => {
    const approved = await approvedId(planFile([ENTRY_SHOP]));
    const { world } = await run(planFile([ENTRY_SHOP]), { confirm: approved });
    const written = writtenBy(world.github);
    expect(written.pulls[0].title).toBe('chore(capy): add Vercel deploy targets');
    expect(written.pulls[0].body).toContain('vercel-production');
    expect(written.pulls[0].body).toContain('prj_shop');
    expect(written.pulls[0].head).toBe('capy/vercel-targets-test-0000');
  });

  test('nothing is recorded or pushed on the Capy side, and nothing is written to Vercel: every request is a read', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    expect(new Set(Object.keys(world.capy.client))).toEqual(new Set(['getOrgRepos', 'getSecretIndex']));
    expect(world.vercelCalls().every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('confirm: repos fail independently', () => {
  test('a failure in one repo is a coded result for that repo; the others still open their PR', async () => {
    const repos = { ...GITHUB_REPOS, 'acme/duo': { ...GITHUB_REPOS['acme/duo'], failing: ['createRef' as const] } };
    const text = planFile(ENTRIES);
    const world = makeVercelWorld({ files: { [PLAN]: text }, repos });
    const approved = await approvedId(text, world);
    const { body, exitCode } = await run(text, { confirm: approved }, world);
    expect(exitCode).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('DISCOVER_PARTIAL');
    expect(body.failed).toEqual([{ repo: 'acme/duo', code: 'KEEP_PR_BRANCH_FAILED' }]);
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/mono', 'acme/personal', 'acme/shop']);
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
    const world = makeVercelWorld({ files: { [PLAN]: text }, repos: { ...GITHUB_REPOS, ...merged } });
    const { body, exitCode } = await run(text, { confirm: approved }, world);
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.prs).toEqual([]);
    expect(body.already_configured).toHaveLength(ENTRIES.length);
    nothingWritten(world);
  });

  test('an environment that already has a target is skipped without a PR, even next to ones that are written', async () => {
    const text = planFile([ENTRY_CFG, ENTRY_SHOP]);
    const approved = await approvedId(text);
    const { body, world } = await run(text, { confirm: approved });
    expect(body.prs.map((p: any) => p.repo)).toEqual(['acme/shop']);
    expect(body.already_configured).toEqual([{ project_id: ENTRY_CFG.project_id, branch: 'production', service_id: ENTRY_CFG.service_id, target_name: 'vercel-production' }]);
    expect(world.github.createPull).toHaveBeenCalledTimes(1);
  });

  test('--dry-run with --confirm changes nothing: the dry run wins', async () => {
    const world = makeVercelWorld({ files: { [PLAN]: planFile(ENTRIES) } });
    const approved = await approvedId(planFile(ENTRIES), world);
    const { body } = await run(planFile(ENTRIES), { dryRun: true, confirm: approved }, world);
    expect(body.dry_run).toBe(true);
    nothingWritten(world);
  });
});

describe('confirm: no value is read, printed, written or sent', () => {
  test('no sentinel and no token is in the output, the progress lines, any blob, the commit message or the PR', async () => {
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
    expect(everything).not.toContain(SENTINEL_VERCEL);
    expect(everything).not.toContain(SENTINEL_CAPY);
    expect(everything).not.toContain(VERCEL_TOKEN);
    // The check bites: names ARE written, so an empty capture cannot pass this.
    expect(everything).toContain('STRIPE_KEY');
    expect(world.github.createBlob.mock.calls.length).toBeGreaterThan(0);
  });

  test('the env lists are read without decrypt and the per-id value route is never called, across a whole confirm run', async () => {
    const approved = await approvedId(planFile(ENTRIES));
    const { world } = await run(planFile(ENTRIES), { confirm: approved });
    const urls = world.vercelCalls().map((c) => c.url);
    expect(urls.some((u) => u.includes('/env'))).toBe(true);
    expect(urls.some((u) => u.includes('decrypt'))).toBe(false);
    expect(urls.some((u) => /\/v1\/projects\//.test(u) || /\/env\/[^?]/.test(u))).toBe(false);
  });
});
