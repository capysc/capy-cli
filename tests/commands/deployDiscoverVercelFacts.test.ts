/**
 * `capy deploy vercel --discover` (CAP-696): the facts document.
 *
 * The properties under test: a Vercel project becomes one service per ENVIRONMENT that holds variables
 * (production, preview, a preview scoped to a git branch, each custom environment; `development` only when
 * it is the only one); a project is matched to a Capy project by its GitHub link and root directory; the
 * proposal's target is exactly the shape the Vercel setup saves; an existing target for the same project +
 * environment is `already_configured`; the token is read from the system store, never asked for; and no
 * value is ever read, asked for or printed.
 *
 * Fakes only (`tests/helpers/deployDiscoverVercelWorld.ts`).
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { runDeployVercelDiscover } from '../../src/commands/deployDiscover/vercel';
import { routeDeployDiscover } from '../../src/commands/deployDiscover/route';
import {
  P_CONF,
  P_DUO,
  P_MADMIN,
  P_MWEB,
  P_SHOP,
  SENTINEL_VERCEL,
  SVC,
  VERCEL_DATA,
  VERCEL_TOKEN,
  makeVercelWorld,
} from '../helpers/deployDiscoverVercelWorld';
import { SENTINEL_CAPY } from '../helpers/deployDiscoverWorld';

async function facts(world = makeVercelWorld()) {
  const result = await runDeployVercelDiscover({}, world.io);
  return { world, exitCode: result.exitCode, body: result.body as any };
}

describe('facts: services are the environments that hold variables', () => {
  test('one service per environment with variables: production, preview, a branch-scoped preview, a custom environment; development is left out when others exist', async () => {
    const { body, exitCode } = await facts();
    expect(exitCode).toBe(0);
    const ids = body.services.map((s: any) => s.service_id);
    expect(ids).toEqual(
      expect.arrayContaining([SVC.shopProd, SVC.shopPreview, SVC.shopPreviewFeature, SVC.shopStaging, SVC.mwebProd, SVC.madmProd, SVC.aProd, SVC.bProd, SVC.cfgProd, SVC.personalProd]),
    );
    // prj_shop also has DB_URL on `development`, but it has other environments: no development service.
    expect(ids).not.toContain('prj_shop:development');
  });

  test('development is a service when it is the project\'s only environment with variables', async () => {
    const { body } = await facts();
    expect(body.services.find((s: any) => s.service_id === SVC.devOnly)).toMatchObject({ environment: 'development', env_var_names: ['DEV_KEY'] });
  });

  test('a service carries names only: sorted, de-duplicated, Vercel\'s own `system` variables left out, a sensitive one still named', async () => {
    const { body } = await facts();
    const prod = body.services.find((s: any) => s.service_id === SVC.shopProd);
    expect(prod.env_var_names).toEqual(['API_KEY', 'DB_URL', 'STRIPE_KEY']);
    expect(prod.env_var_names).not.toContain('VERCEL_URL');
  });

  test('the branch-scoped preview and the custom environment are their own services with their own names', async () => {
    const { body } = await facts();
    expect(body.services.find((s: any) => s.service_id === SVC.shopPreviewFeature)).toMatchObject({
      environment: 'preview',
      git_branch_scope: 'feature-x',
      env_var_names: ['DB_URL'],
    });
    expect(body.services.find((s: any) => s.service_id === SVC.shopPreview)).toMatchObject({ git_branch_scope: null, env_var_names: ['API_KEY', 'DB_URL'] });
    expect(body.services.find((s: any) => s.service_id === SVC.shopStaging)).toMatchObject({
      environment: 'staging',
      custom_environment_id: 'env_stg',
      env_var_names: ['DB_URL'],
    });
  });

  test('a service names its repo, production branch, team, and its folder relative to the repo root', async () => {
    const { body } = await facts();
    expect(body.services.find((s: any) => s.service_id === SVC.mwebProd)).toMatchObject({
      kind: 'vercel',
      name: 'mono-web',
      vercel_project_id: 'prj_mweb',
      team: { id: 'team_1', slug: 'acme-team' },
      root_directory: 'apps/web',
      path: 'apps/web',
      branch: 'main',
      repo: { host: 'github.com', owner: 'acme', name: 'mono' },
    });
    expect(body.services.find((s: any) => s.service_id === SVC.shopProd)).toMatchObject({ root_directory: null, path: '.' });
    // A personal-account project has no team.
    expect(body.services.find((s: any) => s.service_id === SVC.personalProd)).toMatchObject({ team: null, branch: 'trunk' });
  });

  test('a project that is not connected to GitHub is skipped and reported by name; its environments are never read', async () => {
    const { body, world } = await facts();
    expect(body.services.some((s: any) => s.vercel_project_id === 'prj_nolink')).toBe(false);
    expect(body.notices).toContainEqual({ code: 'VERCEL_PROJECT_NOT_GITHUB', detail: 'nolink' });
    expect(world.vercelCalls().some((c) => c.url.includes('prj_nolink'))).toBe(false);
  });

  test('the teams the token sees are listed', async () => {
    const { body } = await facts();
    expect(body.teams).toEqual([{ id: 'team_1', slug: 'acme-team' }]);
  });
});

describe('facts: matching a service to a Capy project', () => {
  test('a root directory matches the Capy project linked at that folder of the repo', async () => {
    const { body } = await facts();
    const web = body.proposals.find((p: any) => p.service_id === SVC.mwebProd);
    const admin = body.proposals.find((p: any) => p.service_id === SVC.madmProd);
    expect(web).toMatchObject({ project_id: P_MWEB, branch: 'production', git_branch: 'main' });
    expect(admin).toMatchObject({ project_id: P_MADMIN, branch: 'production' });
    expect(web.evidence).toMatchObject({ repo_match: true, path_match: true });
    expect(web.confidence).toEqual({ project: 'certain', branch: 'certain', vars: 'certain' });
  });

  test('several Vercel projects (one per root directory) under ONE Capy project are two proposals, each needs_review, each naming the other', async () => {
    const { body } = await facts();
    const a = body.proposals.find((p: any) => p.service_id === SVC.aProd);
    const b = body.proposals.find((p: any) => p.service_id === SVC.bProd);
    expect(a.project_id).toBe(P_DUO);
    expect(b.project_id).toBe(P_DUO);
    expect(a.competing_proposal_ids).toEqual([b.proposal_id]);
    expect(b.competing_proposal_ids).toEqual([a.proposal_id]);
    expect(a.confidence.project).toBe('needs_review');
    expect(a.evidence.path_match).toBe(false);
  });

  test('the Capy branch is the one named like the environment; a scoped preview uses its git branch', async () => {
    const { body } = await facts();
    const byService = (id: string) => body.proposals.find((p: any) => p.service_id === id);
    expect(byService(SVC.shopProd).branch).toBe('production');
    expect(byService(SVC.shopPreview).branch).toBe('preview');
    expect(byService(SVC.shopPreviewFeature).branch).toBe('feature-x');
    expect(byService(SVC.shopStaging).branch).toBe('staging');
    expect(byService(SVC.devOnly).branch).toBe('development');
  });

  test('a service whose environment has no Capy branch is unresolved BRANCH_UNMAPPED, naming the branches the project has', async () => {
    const projects = [{ id: P_SHOP, name: 'shop', repos: [{ owner: 'acme', name: 'shop', path: '.' }], branches: { production: ['DB_URL'] } }];
    const { body } = await facts(makeVercelWorld({ projects }));
    const unmapped = body.unresolved.filter((u: any) => u.reason === 'BRANCH_UNMAPPED' && u.project_id === P_SHOP);
    expect(unmapped.map((u: any) => u.service_id).sort()).toEqual([SVC.shopPreview, SVC.shopPreviewFeature, SVC.shopStaging].sort());
    expect(unmapped[0].candidates).toEqual([{ project_id: P_SHOP, branch: 'production' }]);
  });

  test('a repo no Capy project is linked to is unresolved NO_REPO_LINK', async () => {
    const { body } = await facts(makeVercelWorld({ projects: [] }));
    expect(body.proposals).toEqual([]);
    expect(body.unresolved.some((u: any) => u.reason === 'NO_REPO_LINK' && u.service_id === SVC.shopProd)).toBe(true);
  });
});

describe('facts: the proposal\'s target is the shape the Vercel setup saves', () => {
  test('production: project, team, environment, the production branch as the PR base, CI mode, the shared names', async () => {
    const { body } = await facts();
    const p = body.proposals.find((x: any) => x.service_id === SVC.shopProd);
    expect(p.target).toEqual({
      kind: 'vercel',
      projectId: 'prj_shop',
      teamId: 'team_1',
      vercelEnv: 'production',
      branch: 'production',
      gitBaseBranch: 'main',
      mode: 'ci',
      vars: ['API_KEY', 'DB_URL', 'STRIPE_KEY'],
    });
    expect(p.plan_entry).toEqual({ project_id: P_SHOP, branch: 'production', service_id: SVC.shopProd, git_branch: 'main', vars: ['API_KEY', 'DB_URL', 'STRIPE_KEY'] });
  });

  test('custom environment adds customEnvironmentId; a scoped preview adds gitBranch; a personal project has no teamId; its PR base is its own production branch', async () => {
    const { body } = await facts();
    const byService = (id: string) => body.proposals.find((p: any) => p.service_id === id).target;
    expect(byService(SVC.shopStaging)).toMatchObject({ vercelEnv: 'staging', customEnvironmentId: 'env_stg' });
    expect(byService(SVC.shopPreviewFeature)).toMatchObject({ vercelEnv: 'preview', gitBranch: 'feature-x' });
    expect(byService(SVC.shopPreview)).not.toHaveProperty('gitBranch');
    expect(byService(SVC.personalProd)).not.toHaveProperty('teamId');
    expect(byService(SVC.personalProd)).toMatchObject({ gitBaseBranch: 'trunk' });
  });

  test('only variables the Capy branch also holds are proposed; the rest are overlap evidence', async () => {
    const { body } = await facts();
    const web = body.proposals.find((p: any) => p.service_id === SVC.mwebProd);
    expect(web.target.vars).toEqual(['WEB_KEY', 'WEB_OTHER']);
    expect(web.evidence.var_overlap).toEqual({ shared: 2, only_in_service: [], only_in_project: [] });
  });
});

describe('facts: already configured', () => {
  test('a deploy.json target with the same project and environment is already_configured and gets no proposal', async () => {
    const { body } = await facts();
    expect(body.already_configured).toEqual([{ project_id: P_CONF, branch: 'production', service_id: SVC.cfgProd, target_name: 'vercel-production' }]);
    expect(body.proposals.some((p: any) => p.service_id === SVC.cfgProd)).toBe(false);
  });

  test('another environment of the same project is not covered by it', async () => {
    const existing = JSON.stringify({
      version: '1',
      targets: { 'vercel-preview': { name: 'vercel-preview', kind: 'vercel', branch: 'preview', vars: [], options: { projectId: 'prj_shop', vercelEnv: 'preview', gitBranch: 'feature-x' } } },
    });
    const repos = { 'acme/shop': { defaultBranch: 'main', branches: ['main'], files: { '.capy/deploy.json': existing } } };
    const { body } = await facts(makeVercelWorld({ repos }));
    // Only the branch-scoped preview is configured: the unscoped preview and production are not.
    expect(body.already_configured.map((a: any) => a.service_id)).toEqual([SVC.shopPreviewFeature]);
    expect(body.proposals.some((p: any) => p.service_id === SVC.shopPreview)).toBe(true);
  });

  test('a custom environment target is matched by its slug', async () => {
    const existing = JSON.stringify({
      version: '1',
      targets: { 'vercel-staging': { name: 'vercel-staging', kind: 'vercel', branch: 'staging', vars: [], options: { projectId: 'prj_shop', vercelEnv: 'staging', customEnvironmentId: 'env_stg' } } },
    });
    const repos = { 'acme/shop': { defaultBranch: 'main', branches: ['main'], files: { '.capy/deploy.json': existing } } };
    const { body } = await facts(makeVercelWorld({ repos }));
    expect(body.already_configured.map((a: any) => a.service_id)).toEqual([SVC.shopStaging]);
  });
});

describe('facts: what is asked of Vercel', () => {
  test('teams, then each team\'s projects page by page (`from` continues), then the token\'s own scope; team-scoped calls carry teamId, the personal ones none', async () => {
    const { world } = await facts();
    const urls = world.vercelCalls().map((c) => c.url);
    expect(urls[0]).toBe('https://api.vercel.com/v2/teams?limit=100');
    expect(urls.filter((u) => u.includes('/v10/projects?'))).toEqual([
      'https://api.vercel.com/v10/projects?limit=100&teamId=team_1',
      'https://api.vercel.com/v10/projects?limit=100&from=3&teamId=team_1',
      'https://api.vercel.com/v10/projects?limit=100&from=6&teamId=team_1',
      'https://api.vercel.com/v10/projects?limit=100',
    ]);
    // Every environment read of a team project says which team; the personal project's says none.
    expect(urls.filter((u) => u.includes('prj_shop') || u.includes('prj_mweb')).every((u) => u.includes('teamId=team_1'))).toBe(true);
    expect(urls.filter((u) => u.includes('prj_personal')).every((u) => !u.includes('teamId'))).toBe(true);
  });

  test('every request is a GET with the token as a bearer; the project, env and custom-environment routes are the documented ones', async () => {
    const { world } = await facts();
    const calls = world.vercelCalls();
    expect(calls.every((c) => c.method === 'GET' && c.authorization === `Bearer ${VERCEL_TOKEN}`)).toBe(true);
    const paths = new Set(calls.map((c) => new URL(c.url).pathname.replace(/prj_[a-z]+/, 'PRJ')));
    // CAP-730 adds the recent preview deployments (read-only, `target=preview`) to the routes asked.
    expect(paths).toEqual(new Set(['/v2/teams', '/v10/projects', '/v9/projects/PRJ/custom-environments', '/v10/projects/PRJ/env', '/v6/deployments']));
  });

  test('a project\'s variables are listed WITHOUT decrypt, and the per-id value route is never called', async () => {
    const { world } = await facts();
    const urls = world.vercelCalls().map((c) => c.url);
    expect(urls.some((u) => u.includes('decrypt'))).toBe(false);
    expect(urls.some((u) => /\/v1\/projects\//.test(u))).toBe(false);
    expect(urls.some((u) => /\/env\/[^?]/.test(u))).toBe(false);
  });

  test('an env list Vercel says has another page is reported: the names read may be incomplete', async () => {
    const data = { ...VERCEL_DATA, envListNext: 1700000000000 };
    const { body } = await facts(makeVercelWorld({ data }));
    expect(body.notices).toContainEqual({ code: 'VERCEL_ENV_LIST_TRUNCATED', detail: 'shop-web' });
  });

  test('GitHub is read for the repos some Vercel project tracks; Capy is asked ONCE for the links and ONCE for the name index', async () => {
    const { world } = await facts();
    expect(world.capy.getOrgRepos).toHaveBeenCalledTimes(1);
    expect(world.capy.getSecretIndex).toHaveBeenCalledTimes(1);
    expect(world.github.getDefaultBranches).toHaveBeenCalledTimes(1);
  });

  test('the output carries the plan schema ref and the next step is a dry run of a vercel plan', async () => {
    const { body } = await facts();
    expect(body.plan_schema_ref).toEqual({ command: 'capy help --json', pointer: '/schemas/deploy_vercel_plan' });
    expect(body.next_steps.at(-1)).toEqual({ run: 'capy deploy vercel --discover --plan <file> --dry-run' });
    expect(body).not.toHaveProperty('base_url');
  });
});

describe('facts: no value is read, asked for, printed or sent', () => {
  test('neither the Vercel nor the Capy sentinel is in the output or the progress lines', async () => {
    const { body, world } = await facts();
    const everything = [JSON.stringify(body), world.progress.mock.calls.map(([l]) => String(l)).join('\n')].join('\n');
    expect(everything).not.toContain(SENTINEL_VERCEL);
    expect(everything).not.toContain(SENTINEL_CAPY);
    expect(everything).not.toContain(VERCEL_TOKEN);
    // The check bites: names ARE printed.
    expect(everything).toContain('STRIPE_KEY');
  });

  test('a sensitive record (no value to give) and an encrypted one are named the same way as a plain one', async () => {
    const { body } = await facts();
    expect(body.services.find((s: any) => s.service_id === SVC.shopProd).env_var_names).toEqual(expect.arrayContaining(['STRIPE_KEY', 'API_KEY', 'DB_URL']));
  });
});

describe('facts: the token', () => {
  test('is read from the org system store, by the connector key name (discovery only reads), and never asked for', async () => {
    const { world } = await facts();
    expect(world.getSecret).toHaveBeenCalledTimes(1);
    const [name, opts] = world.getSecret.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(opts).toMatchObject({ interactive: false, orgId: 'org_1' });
  });

  test('missing everywhere: VERCEL_TOKEN_MISSING with where to get one (link, remedy), zero requests to Vercel, Capy or GitHub', async () => {
    const world = makeVercelWorld({ token: null });
    const { body, exitCode } = await facts(world);
    expect(exitCode).toBe(1);
    expect(body).toMatchObject({ ok: false, code: 'VERCEL_TOKEN_MISSING' });
    expect(body.link.url).toContain('vercel.com');
    expect(body.remedy).toContain('_CONNECTOR_VERCEL_TOKEN');
    expect(world.fetchMock).not.toHaveBeenCalled();
    expect(world.capy.getOrgRepos).not.toHaveBeenCalled();
    expect(world.github.getDefaultBranches).not.toHaveBeenCalled();
  });

  test('a store that refuses with a code is that code, with the same help', async () => {
    const world = makeVercelWorld({ io: { getSecret: (async () => Promise.reject(Object.assign(new Error('x'), { code: 'VERCEL_CONNECTOR_KEY_MISSING' }))) as never } });
    const { body } = await facts(world);
    expect(body).toMatchObject({ ok: false, code: 'VERCEL_CONNECTOR_KEY_MISSING' });
    expect(body.link).toBeDefined();
    expect(body.remedy).toBeDefined();
    expect(world.fetchMock).not.toHaveBeenCalled();
  });

  test('$VERCEL_TOKEN is used when the store has none', async () => {
    const world = makeVercelWorld({ token: null, io: { env: { VERCEL_TOKEN } as never } });
    const { body, exitCode } = await facts(world);
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
  });

  test('a token Vercel rejects (401): VERCEL_AUTH_FAILED with where to get another; the token is not in the output', async () => {
    const world = makeVercelWorld({ acceptedToken: 'some-other-token' });
    const { body, exitCode } = await facts(world);
    expect(exitCode).toBe(1);
    expect(body).toMatchObject({ ok: false, code: 'VERCEL_AUTH_FAILED' });
    expect(body.link.url).toContain('vercel.com');
    expect(body.remedy).toContain('_CONNECTOR_VERCEL_TOKEN');
    expect(JSON.stringify(body)).not.toContain(VERCEL_TOKEN);
    expect(world.capy.getOrgRepos).not.toHaveBeenCalled();
  });
});

describe('facts: routing from `capy deploy vercel --discover`', () => {
  test('--base-url is a Dokploy flag: refused with a code', async () => {
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      const code = await routeDeployDiscover('vercel', { discover: true, baseUrl: 'https://x.example.com' }, false, false);
      expect(code).toBe(1);
      expect(JSON.parse(String(out.mock.calls[0][0])).code).toBe('INVALID_FORMAT');
    } finally {
      out.mockRestore();
    }
  });
});

describe('facts: several teams', () => {
  test('every team the token sees is read with its own teamId; a project is attributed to the team that lists it; a project listed twice counts once', async () => {
    const data = {
      ...VERCEL_DATA,
      teams: [VERCEL_DATA.teams![0], { id: 'team_2', slug: 'other-team' }],
      projects: {
        ...VERCEL_DATA.projects,
        team_2: [VERCEL_DATA.projects.team_1[0], { ...VERCEL_DATA.projects.personal[0], id: 'prj_t2', name: 'team-two-site' }],
      },
      envs: { ...VERCEL_DATA.envs, prj_t2: VERCEL_DATA.envs.prj_personal },
    };
    const { body, world } = await facts(makeVercelWorld({ data }));
    expect(body.teams.map((t: any) => t.slug)).toEqual(['acme-team', 'other-team']);
    expect(body.services.filter((s: any) => s.vercel_project_id === 'prj_shop' && s.environment === 'production')).toHaveLength(1);
    expect(body.services.find((s: any) => s.vercel_project_id === 'prj_t2').team).toEqual({ id: 'team_2', slug: 'other-team' });
    const urls = world.vercelCalls().map((c) => c.url);
    expect(urls.filter((u) => u.includes('/v10/projects?') && u.includes('teamId=team_2'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('prj_t2')).every((u) => u.includes('teamId=team_2'))).toBe(true);
  });
});
