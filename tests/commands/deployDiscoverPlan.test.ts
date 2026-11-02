/**
 * `capy deploy dokploy --discover --plan <file> --dry-run` (CAP-703): validating a plan.
 *
 * Every check has a coded, PATH-PRECISE error (`{ path: "entries[3].service_id", code: "SERVICE_NOT_FOUND" }`),
 * a valid plan gets a stable `plan_id` and the summary lines an agent relays to the human, and a dry run
 * changes nothing. Fakes only (`tests/helpers/deployDiscoverWorld.ts`).
 */
import { describe, test, expect } from 'bun:test';
import { runDeployDokployDiscover } from '../../src/commands/deployDiscover/command';
import {
  BASE_URL,
  ENTRY_API,
  ENTRY_API_STG,
  ENTRY_SOLO,
  ENTRY_WEB,
  P_API,
  P_CONF,
  P_NOLINK,
  SENTINEL_CAPY,
  SENTINEL_DOKPLOY,
  makeWorld,
  planFile,
} from '../helpers/deployDiscoverWorld';

const PLAN = 'plan.json';

async function check(text: string, over: { dryRun?: boolean; confirm?: string; baseUrl?: string; world?: ReturnType<typeof makeWorld> } = {}) {
  const world = over.world ?? makeWorld({ files: { [PLAN]: text } });
  const result = await runDeployDokployDiscover(
    { baseUrl: over.baseUrl ?? BASE_URL, plan: PLAN, dryRun: over.dryRun ?? true, ...(over.confirm === undefined ? {} : { confirm: over.confirm }) },
    world.io,
  );
  return { world, exitCode: result.exitCode, body: result.body as any };
}

const errorsOf = async (entries: readonly unknown[]) => (await check(planFile(entries))).body.errors as Array<{ path: string; code: string }>;

describe('plan: the shape is checked first, path-precisely', () => {
  test('a file that is not JSON: INVALID_FORMAT at the root', async () => {
    const { body, exitCode } = await check('{nope');
    expect(exitCode).toBe(1);
    expect(body).toMatchObject({ ok: false, code: 'PLAN_INVALID', errors: [{ path: '', code: 'INVALID_FORMAT' }] });
  });

  test('a file that cannot be read: PLAN_FILE_UNREADABLE', async () => {
    const world = makeWorld({ files: {} });
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL, plan: 'missing.json', dryRun: true }, world.io);
    expect((result.body as any).code).toBe('PLAN_FILE_UNREADABLE');
  });

  test('a wrong version, an unknown key and a bad variable name each name their own path', async () => {
    const text = JSON.stringify({
      version: 2,
      extra: true,
      entries: [{ ...ENTRY_SOLO }, { ...ENTRY_API, vars: ['DATABASE_URL', 'bad name'], extra: 1 }, { project_id: '', branch: 'production', service_id: 'x', git_branch: 'main', vars: [] }],
    });
    const { body } = await check(text);
    expect(body.code).toBe('PLAN_INVALID');
    expect(body.errors).toEqual([
      { path: 'extra', code: 'INVALID_FORMAT' },
      { path: 'version', code: 'INVALID_FORMAT' },
      { path: 'entries[1].extra', code: 'INVALID_FORMAT' },
      { path: 'entries[1].vars[1]', code: 'INVALID_FORMAT' },
      { path: 'entries[2].project_id', code: 'INVALID_FORMAT' },
      { path: 'entries[2].vars', code: 'INVALID_FORMAT' },
    ]);
  });

  test('no entries: INVALID_FORMAT at entries', async () => {
    const { body } = await check(JSON.stringify({ version: 1, entries: [] }));
    expect(body.errors).toEqual([{ path: 'entries', code: 'INVALID_FORMAT' }]);
  });

  test('a shape error stops before anything is read from Dokploy, Capy or GitHub', async () => {
    const world = makeWorld({ files: { [PLAN]: '{nope' } });
    await check('{nope', { world });
    expect(world.dokploy.listProjects).not.toHaveBeenCalled();
    expect(world.capy.getOrgRepos).not.toHaveBeenCalled();
    expect(world.github.getDefaultBranches).not.toHaveBeenCalled();
  });
});

describe('plan: every lookup has its own coded error at a precise path', () => {
  test('SERVICE_NOT_FOUND at entries[1].service_id', async () => {
    expect(await errorsOf([ENTRY_SOLO, { ...ENTRY_API, service_id: 'cmp_missing' }])).toContainEqual({ path: 'entries[1].service_id', code: 'SERVICE_NOT_FOUND' });
  });

  test('PROJECT_NOT_FOUND at entries[2].project_id (a project the caller cannot see is not found)', async () => {
    expect(await errorsOf([ENTRY_SOLO, ENTRY_API, { ...ENTRY_WEB, project_id: 'proj_nobody' }])).toContainEqual({ path: 'entries[2].project_id', code: 'PROJECT_NOT_FOUND' });
  });

  test('BRANCH_NOT_FOUND for a Capy branch (entries[0].branch) and for a git branch GitHub does not have (entries[0].git_branch)', async () => {
    const errors = await errorsOf([{ ...ENTRY_SOLO, branch: 'no-such-branch', git_branch: 'no-such-git-branch' }]);
    expect(errors).toContainEqual({ path: 'entries[0].branch', code: 'BRANCH_NOT_FOUND' });
    expect(errors).toContainEqual({ path: 'entries[0].git_branch', code: 'BRANCH_NOT_FOUND' });
  });

  test('VAR_NOT_FOUND at the exact variable', async () => {
    expect(await errorsOf([{ ...ENTRY_SOLO, vars: ['A', 'NOT_IN_PROJECT', 'B'] }])).toEqual([{ path: 'entries[0].vars[1]', code: 'VAR_NOT_FOUND' }]);
  });

  test('DUPLICATE_ENTRY at the later entry that assigns the same project + branch', async () => {
    const errors = await errorsOf([ENTRY_SOLO, ENTRY_API, { ...ENTRY_SOLO, service_id: 'cmp_weak' }]);
    expect(errors).toContainEqual({ path: 'entries[2]', code: 'DUPLICATE_ENTRY' });
  });

  test('TARGET_EXISTS at the branch: a Dokploy target for a DIFFERENT service is already on that project branch', async () => {
    const errors = await errorsOf([{ project_id: P_CONF, branch: 'production', service_id: 'cmp_conf_other', git_branch: 'main', vars: ['C1'] }]);
    expect(errors).toEqual([{ path: 'entries[0].branch', code: 'TARGET_EXISTS' }]);
  });

  test('NO_REPO_LINK: a project with no GitHub repo link has nowhere for a PR to go', async () => {
    expect(await errorsOf([{ project_id: P_NOLINK, branch: 'production', service_id: 'cmp_solo', git_branch: 'main', vars: ['Z1'] }])).toContainEqual({
      path: 'entries[0].project_id',
      code: 'NO_REPO_LINK',
    });
  });

  test('REPO_MISMATCH: a service that tracks a repo the project is not linked to', async () => {
    const errors = await errorsOf([{ project_id: P_API, branch: 'production', service_id: 'cmp_solo', git_branch: 'main', vars: ['DATABASE_URL'] }]);
    expect(errors).toContainEqual({ path: 'entries[0].service_id', code: 'REPO_MISMATCH' });
  });

  test('several problems at once are all reported, each at its own path, in entry order', async () => {
    const errors = await errorsOf([
      { ...ENTRY_SOLO, vars: ['A', 'NOPE'] },
      { ...ENTRY_API, service_id: 'cmp_missing' },
      { ...ENTRY_WEB, project_id: 'proj_nobody' },
    ]);
    expect(errors.map((e) => `${e.path}:${e.code}`)).toEqual([
      'entries[0].vars[1]:VAR_NOT_FOUND',
      'entries[1].service_id:SERVICE_NOT_FOUND',
      'entries[2].project_id:PROJECT_NOT_FOUND',
    ]);
  });

  test('GitHub unavailable: the git branch and the existing targets cannot be checked, and that is a coded error, not a pass', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile([ENTRY_SOLO]) }, io: { github: () => undefined } });
    const { body } = await check(planFile([ENTRY_SOLO]), { world });
    expect(body.errors).toEqual([
      { path: 'entries[0].git_branch', code: 'KEEP_PR_GH_UNAVAILABLE' },
      { path: 'entries[0].project_id', code: 'KEEP_PR_GH_UNAVAILABLE' },
    ]);
  });

  test('an invalid plan opens nothing on GitHub', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile([{ ...ENTRY_SOLO, vars: ['NOPE'] }]) } });
    await check(planFile([{ ...ENTRY_SOLO, vars: ['NOPE'] }]), { world, dryRun: false, confirm: 'whatever' });
    expect(world.github.createPull).not.toHaveBeenCalled();
    expect(world.github.createBlob).not.toHaveBeenCalled();
  });
});

describe('plan: a valid plan', () => {
  const ENTRIES = [ENTRY_SOLO, ENTRY_API, ENTRY_API_STG, ENTRY_WEB];

  test('is normalized (entries sorted by project, branch, service; vars sorted) and carries a plan_id and the summary lines', async () => {
    const { body, exitCode } = await check(planFile(ENTRIES));
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.dry_run).toBe(true);
    expect(body.plan.version).toBe(1);
    expect(body.plan.entries.map((e: any) => `${e.project_id}/${e.branch}`)).toEqual(['proj_api/production', 'proj_api/staging', 'proj_solo/production', 'proj_web/production']);
    expect(body.plan.entries[2].vars).toEqual(['A', 'B', 'C', 'D']);
    expect(body.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.summary_lines).toEqual([
      'backend-api · production → Dokploy compose cmp_api (main), 4 vars',
      'backend-api · staging → Dokploy application app_… (staging), 2 vars',
      'solo-app · production → Dokploy compose cmp_solo (main), 4 vars',
      'backend-web · production → Dokploy compose cmp_web (main), 3 vars',
    ]);
  });

  test('plan_id is stable across runs and across entry and variable order, and moves when the plan, or the base URL, does', async () => {
    const first = (await check(planFile(ENTRIES))).body.plan_id;
    const second = (await check(planFile(ENTRIES))).body.plan_id;
    const shuffled = (
      await check(planFile([ENTRY_WEB, ENTRY_SOLO, { ...ENTRY_API, vars: ['JWT_SECRET', 'API_KEY', 'REDIS_URL', 'DATABASE_URL'] }, ENTRY_API_STG]))
    ).body.plan_id;
    expect(second).toBe(first);
    expect(shuffled).toBe(first);
    const fewerVars = (await check(planFile([ENTRY_SOLO, ENTRY_API, ENTRY_API_STG, { ...ENTRY_WEB, vars: ['SESSION_SECRET'] }]))).body.plan_id;
    expect(fewerVars).not.toBe(first);
    const otherUrl = (await check(planFile(ENTRIES), { baseUrl: 'https://other.example.com' })).body.plan_id;
    expect(otherUrl).not.toBe(first);
  });

  test('shows the PRs a confirm would open: one per repo, the deploy.json paths and the target names', async () => {
    const { body } = await check(planFile(ENTRIES));
    expect(body.prs).toEqual([
      { repo: 'acme/backend', base: 'main', files: ['api/.capy/deploy.json', 'web/.capy/deploy.json'], targets: ['dokploy-production', 'dokploy-staging', 'dokploy-production'] },
      { repo: 'acme/solo', base: 'main', files: ['.capy/deploy.json'], targets: ['dokploy-production'] },
    ]);
    expect(body.already_configured).toEqual([]);
  });

  test('its next step is the confirm command, with the file and the plan_id', async () => {
    const { body } = await check(planFile(ENTRIES));
    expect(body.next_steps).toContainEqual({ run: `capy deploy dokploy --discover --plan ${PLAN} --confirm ${body.plan_id}` });
  });

  test('an entry whose target is already there is not an error: it is already_configured and says so', async () => {
    const entry = { project_id: P_CONF, branch: 'production', service_id: 'cmp_conf', git_branch: 'main', vars: ['C1', 'C2'] };
    const { body } = await check(planFile([entry]));
    expect(body.ok).toBe(true);
    expect(body.already_configured).toEqual([{ project_id: P_CONF, branch: 'production', service_id: 'cmp_conf', target_name: 'dokploy-production' }]);
    expect(body.summary_lines).toEqual(['configured · production: already configured (dokploy-production), nothing to do']);
    expect(body.prs).toEqual([]);
  });

  test('a dry run writes nothing, and reads only the services the plan names', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile(ENTRIES) } });
    await check(planFile(ENTRIES), { world });
    expect(world.github.createBlob).not.toHaveBeenCalled();
    expect(world.github.createTree).not.toHaveBeenCalled();
    expect(world.github.createCommit).not.toHaveBeenCalled();
    expect(world.github.createRef).not.toHaveBeenCalled();
    expect(world.github.createPull).not.toHaveBeenCalled();
    expect(world.dokploy.getCompose.mock.calls.length + world.dokploy.getApplication.mock.calls.length).toBe(4);
  });

  test('without --dry-run and without --confirm: PLAN_CONFIRM_REQUIRED (exit 3), carrying the plan_id and the plan', async () => {
    const { body, exitCode } = await check(planFile(ENTRIES), { dryRun: false });
    expect(exitCode).toBe(3);
    expect(body.code).toBe('PLAN_CONFIRM_REQUIRED');
    expect(body.unanswered).toEqual([{ id: 'confirm', flag: '--confirm', value: body.plan_id }]);
    expect(body.summary_lines).toHaveLength(4);
  });
});

describe('plan: no value appears anywhere', () => {
  test('neither sentinel is in the dry-run document or the progress lines', async () => {
    const world = makeWorld({ files: { [PLAN]: planFile([ENTRY_SOLO, ENTRY_API]) } });
    const { body } = await check(planFile([ENTRY_SOLO, ENTRY_API]), { world });
    const everything = JSON.stringify(body) + world.progress.mock.calls.map(([l]) => String(l)).join('\n');
    expect(everything).not.toContain(SENTINEL_DOKPLOY);
    expect(everything).not.toContain(SENTINEL_CAPY);
    expect(everything).toContain('cmp_api');
  });
});
