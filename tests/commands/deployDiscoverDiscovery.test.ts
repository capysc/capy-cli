/**
 * `capy deploy dokploy --discover` (CAP-703): the discovery document.
 *
 * Fakes only: a fake Dokploy, fake Capy reads and a fake GitHub (see
 * `tests/helpers/deployDiscoverWorld.ts`). Nothing touches a network or `gh`.
 *
 * The properties under test: repo + repo-relative path + branch matching (never a
 * local path), per-field confidence, the branch mapping, the variable overlap, the
 * unresolved reasons, idempotence (`already_configured`), ONE round of Capy calls
 * however many projects there are, JSON on stdout (in a terminal too) with progress on
 * stderr, and NO value anywhere in the output.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { runDeployDokployDiscover } from '../../src/commands/deployDiscover/command';
import { deployDokployDiscoverCommand } from '../../src/commands/deployDiscover/index';
import { routeDeployDiscover } from '../../src/commands/deployDiscover/route';
import {
  BASE_URL,
  GITHUB_REPOS,
  P_API,
  P_CONF,
  P_NOBR,
  P_SOLO,
  P_TWIN1,
  P_TWIN2,
  P_WEAK,
  P_WEB,
  PROJECTS,
  SENTINEL_CAPY,
  SENTINEL_DOKPLOY,
  SERVICES,
  githubFake,
  makeWorld,
} from '../helpers/deployDiscoverWorld';
import { withTty } from '../helpers/processState';

const discover = async (world = makeWorld()) => {
  const result = await runDeployDokployDiscover({ baseUrl: BASE_URL }, world.io);
  return { world, ...result, body: result.body as any };
};

const proposalFor = (body: any, serviceId: string, projectId?: string): any =>
  body.proposals.find((p: any) => p.service_id === serviceId && (projectId === undefined || p.project_id === projectId));

const unresolvedFor = (body: any, reason: string, serviceId: string): any =>
  body.unresolved.find((u: any) => u.reason === reason && u.service_id === serviceId);

describe('discovery: an exact repo + path + branch match is certain', () => {
  test('the standalone repo: its default branch maps to production, every field certain, the target is the CI target shape', async () => {
    const { body, exitCode } = await discover();
    expect(exitCode).toBe(0);
    expect(body.ok).toBe(true);
    const p = proposalFor(body, 'cmp_solo');
    expect(p.project_id).toBe(P_SOLO);
    expect(p.branch).toBe('production');
    expect(p.git_branch).toBe('main');
    expect(p.evidence).toEqual({
      repo_match: true,
      path_match: true,
      branch_match: true,
      var_overlap: { shared: 4, only_in_service: [], only_in_project: [] },
      conflicting_target: null,
    });
    expect(p.confidence).toEqual({ project: 'certain', branch: 'certain', vars: 'certain' });
    expect(p.competing_proposal_ids).toEqual([]);
    expect(p.target).toEqual({
      kind: 'dokploy',
      baseUrl: BASE_URL,
      composeId: 'cmp_solo',
      branch: 'production',
      gitBaseBranch: 'main',
      mode: 'ci',
      vars: ['A', 'B', 'C', 'D'],
    });
    expect(p.plan_entry).toEqual({ project_id: P_SOLO, branch: 'production', service_id: 'cmp_solo', git_branch: 'main', vars: ['A', 'B', 'C', 'D'] });
  });

  test('an Application is matched on its build path and carries applicationId, not composeId', async () => {
    const { body } = await discover();
    const p = proposalFor(body, 'app_api_stg');
    expect(p.project_id).toBe(P_API);
    expect(p.evidence.path_match).toBe(true);
    expect(p.target.applicationId).toBe('app_api_stg');
    expect(p.target).not.toHaveProperty('composeId');
  });
});

describe('discovery: a monorepo with two services at two paths', () => {
  test('each service lands on the project linked to ITS folder of the same repo', async () => {
    const { body } = await discover();
    const api = proposalFor(body, 'cmp_api');
    const web = proposalFor(body, 'cmp_web');
    expect(api.project_id).toBe(P_API);
    expect(web.project_id).toBe(P_WEB);
    expect(api.evidence.path_match).toBe(true);
    expect(web.evidence.path_match).toBe(true);
    expect(api.competing_proposal_ids).toEqual([]);
    expect(web.competing_proposal_ids).toEqual([]);
  });

  test('services report the repo-relative path, the branch and variable NAMES', async () => {
    const { body } = await discover();
    const api = body.services.find((s: any) => s.service_id === 'cmp_api');
    expect(api).toMatchObject({
      kind: 'compose',
      name: 'api',
      repo: { host: 'github.com', owner: 'acme', name: 'backend' },
      branch: 'main',
      path: 'api',
    });
    expect(api.env_var_names).toEqual(['API_KEY', 'DATABASE_URL', 'JWT_SECRET', 'ONLY_IN_SERVICE', 'REDIS_URL']);
    const stg = body.services.find((s: any) => s.service_id === 'app_api_stg');
    expect(stg.path).toBe('api');
    const solo = body.services.find((s: any) => s.service_id === 'cmp_solo');
    expect(solo.path).toBe('.');
  });

  test('projects list every linked repo + path, the branches and the variable names per branch', async () => {
    const { body } = await discover();
    const project = body.projects.find((p: any) => p.project_id === P_API);
    expect(project.repos).toEqual([{ host: 'github.com', owner: 'acme', name: 'backend', path: 'api' }]);
    expect(project.branches).toEqual(['production', 'staging']);
    expect(project.var_names_by_branch.staging).toEqual(['API_KEY', 'DATABASE_URL', 'REDIS_URL']);
    expect(project.existing_targets_read).toBe(true);
    expect(project.existing_targets.map((t: any) => t.name)).toEqual(['ssm-prod']);
    // A project with no repo link cannot be matched or written to: it is not listed.
    expect(body.projects.some((p: any) => p.project_id === 'proj_nolink')).toBe(false);
  });
});

describe('discovery: what cannot be matched is unresolved, with a code', () => {
  test('a service with no git source: SERVICE_HAS_NO_GIT_SOURCE', async () => {
    const { body } = await discover();
    expect(unresolvedFor(body, 'SERVICE_HAS_NO_GIT_SOURCE', 'cmp_raw')).toEqual({ reason: 'SERVICE_HAS_NO_GIT_SOURCE', service_id: 'cmp_raw', candidates: [] });
    expect(body.services.find((s: any) => s.service_id === 'cmp_raw')).toMatchObject({ repo: null, path: null });
  });

  test('a repo no Capy project is linked to: NO_REPO_LINK', async () => {
    const { body } = await discover();
    expect(unresolvedFor(body, 'NO_REPO_LINK', 'cmp_nolink')).toBeDefined();
  });

  test('a linked repo but a folder under none of its projects: NO_MATCHING_PROJECT, naming the repo\'s projects', async () => {
    const { body } = await discover();
    const u = unresolvedFor(body, 'NO_MATCHING_PROJECT', 'cmp_nomatch');
    expect(u.candidates.map((c: any) => [c.project_id, c.path])).toEqual([[P_API, 'api'], [P_WEB, 'web']]);
  });

  test('two projects match the same repo + path: AMBIGUOUS, and each candidate is a proposal that needs review', async () => {
    const { body } = await discover();
    const u = unresolvedFor(body, 'AMBIGUOUS', 'cmp_twin');
    expect(u.candidates.map((c: any) => c.project_id)).toEqual([P_TWIN1, P_TWIN2]);
    const proposals = body.proposals.filter((p: any) => p.service_id === 'cmp_twin');
    expect(proposals.map((p: any) => p.project_id)).toEqual([P_TWIN1, P_TWIN2]);
    expect(proposals.every((p: any) => p.confidence.project === 'needs_review')).toBe(true);
    const review = body.next_steps.find((s: any) => s.action === 'review');
    expect(review.proposal_ids).toEqual(expect.arrayContaining(proposals.map((p: any) => p.proposal_id)));
  });

  test('a git branch the project has no branch for: BRANCH_UNMAPPED, listing the project\'s branches', async () => {
    const { body } = await discover();
    const u = unresolvedFor(body, 'BRANCH_UNMAPPED', 'cmp_feature');
    expect(u.project_id).toBe(P_NOBR);
    expect(u.candidates).toEqual([{ project_id: P_NOBR, branch: 'production' }]);
    expect(proposalFor(body, 'cmp_feature')).toBeUndefined();
  });
});

describe('discovery: branch mapping', () => {
  test('the repo\'s default branch is production; any other branch is the same-named Capy branch', async () => {
    const { body } = await discover();
    expect(proposalFor(body, 'cmp_api').branch).toBe('production');
    expect(proposalFor(body, 'cmp_api').git_branch).toBe('main');
    const staging = proposalFor(body, 'app_api_stg');
    expect(staging.branch).toBe('staging');
    expect(staging.git_branch).toBe('staging');
    expect(staging.confidence.branch).toBe('certain');
  });

  test('a default branch GitHub could not tell: the branch is only reached through the Dokploy environment name, needs_review, and the notice says why', async () => {
    const gh = githubFake(GITHUB_REPOS);
    const world = makeWorld({
      io: { github: () => ({ ...gh.api, getDefaultBranches: async () => ({ ok: false, kind: 'REQUEST_FAILED' as const }) }) as never },
    });
    const { body } = await discover(world);
    // "main" is not a Capy branch of the solo project and the default is unknown, so production is NOT derived
    // from it; the Dokploy environment is named "production", which the project does have.
    const p = proposalFor(body, 'cmp_solo');
    expect(p.branch).toBe('production');
    expect(p.evidence.branch_match).toBe(false);
    expect(p.confidence.branch).toBe('needs_review');
    expect(body.notices).toEqual([{ code: 'KEEP_PR_BASE_UNRESOLVED' }]);
  });

  test('a repo whose default branch is develop: the develop service in the "staging" environment goes to staging, never production', async () => {
    const project = {
      id: 'proj_mono',
      name: 'mono',
      repos: [{ owner: 'acme', name: 'mono', path: 'deploy' }],
      branches: { production: ['P1', 'S1'], staging: ['P1', 'S1'] },
    };
    const service = (id: string, environment: string, branch: string) => ({
      id,
      kind: 'compose' as const,
      name: id,
      environment,
      owner: 'acme',
      repository: 'mono',
      sourceType: 'github',
      branch,
      composePath: 'deploy/docker-compose.yml',
      envNames: ['P1', 'S1'],
    });
    const world = makeWorld({
      projects: [project],
      services: [service('cmp_stg', 'staging', 'develop'), service('cmp_prod', 'production', 'main')],
      repos: { 'acme/mono': { defaultBranch: 'develop', branches: ['develop', 'main'] } },
    });
    const { body } = await discover(world);
    const stg = proposalFor(body, 'cmp_stg');
    expect(stg.branch).toBe('staging');
    expect(stg.git_branch).toBe('develop');
    expect(stg.evidence.branch_match).toBe(false);
    expect(stg.confidence.branch).toBe('needs_review');
    const prod = proposalFor(body, 'cmp_prod');
    expect(prod.branch).toBe('production');
    // The two services no longer compete for one Capy branch.
    expect(stg.competing_proposal_ids).toEqual([]);
    expect(prod.competing_proposal_ids).toEqual([]);
  });

  test('a git branch with no Capy branch of its name, on a service whose environment names none either: BRANCH_UNMAPPED, not a guess', async () => {
    const { body } = await discover();
    expect(unresolvedFor(body, 'BRANCH_UNMAPPED', 'cmp_feature')).toBeDefined();
  });
});

describe('discovery: the variable overlap', () => {
  test('shared names are the proposed vars; the rest are listed on each side', async () => {
    const { body } = await discover();
    const api = proposalFor(body, 'cmp_api');
    expect(api.evidence.var_overlap).toEqual({ shared: 4, only_in_service: ['ONLY_IN_SERVICE'], only_in_project: [] });
    expect(api.target.vars).toEqual(['API_KEY', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL']);
    expect(api.confidence.vars).toBe('certain');
    const web = proposalFor(body, 'cmp_web');
    expect(web.evidence.var_overlap).toEqual({ shared: 3, only_in_service: [], only_in_project: [] });
  });

  test('an overlap under half of the service\'s variables is needs_review', async () => {
    const { body } = await discover();
    const weak = proposalFor(body, 'cmp_weak', P_WEAK);
    expect(weak.evidence.var_overlap.shared).toBe(1);
    expect(weak.evidence.var_overlap.only_in_service).toEqual(['Y1', 'Y2', 'Y3']);
    expect(weak.evidence.var_overlap.only_in_project).toHaveLength(9);
    expect(weak.confidence.vars).toBe('needs_review');
    expect(weak.confidence.project).toBe('certain');
    expect(body.next_steps.find((s: any) => s.action === 'review').proposal_ids).toContain(weak.proposal_id);
  });

  test('a service with no variables in common is needs_review with an empty overlap', async () => {
    const world = makeWorld({
      services: [{ ...SERVICES[0], id: 'cmp_disjoint', envNames: ['NOT_IN_PROJECT'] }],
    });
    const { body } = await discover(world);
    const p = proposalFor(body, 'cmp_disjoint');
    expect(p.evidence.var_overlap.shared).toBe(0);
    expect(p.target.vars).toEqual([]);
    expect(p.confidence.vars).toBe('needs_review');
  });
});

describe('discovery: idempotent', () => {
  test('a project branch that already has this service\'s Dokploy target is already_configured, not proposed again', async () => {
    const { body } = await discover();
    expect(body.already_configured).toEqual([{ project_id: P_CONF, branch: 'production', service_id: 'cmp_conf', target_name: 'dokploy-production' }]);
    expect(proposalFor(body, 'cmp_conf')).toBeUndefined();
  });

  test('another service for a branch that already has a Dokploy target is proposed, flagged with the conflicting target and needs_review', async () => {
    const { body } = await discover();
    const other = proposalFor(body, 'cmp_conf_other');
    expect(other.project_id).toBe(P_CONF);
    expect(other.evidence.conflicting_target).toBe('dokploy-production');
    expect(other.confidence.project).toBe('needs_review');
  });

  test('without GitHub the existing targets are unknown, and discovery still answers with a coded notice', async () => {
    const world = makeWorld({ io: { github: () => undefined } });
    const { body, exitCode } = await discover(world);
    expect(exitCode).toBe(0);
    expect(body.notices).toEqual([{ code: 'KEEP_PR_GH_UNAVAILABLE' }]);
    expect(body.projects.every((p: any) => p.existing_targets_read === false)).toBe(true);
    expect(body.already_configured).toEqual([]);
  });
});

describe('discovery: the structured answer', () => {
  test('next_steps are structured actions, not prose, and the plan schema is referenced', async () => {
    const { body } = await discover();
    expect(body.plan_schema_ref).toEqual({ command: 'capy help --json', pointer: '/schemas/deploy_dokploy_plan' });
    expect(body.next_steps).toContainEqual({ action: 'write_plan', schema: body.plan_schema_ref });
    expect(body.next_steps).toContainEqual({ run: 'capy deploy dokploy --discover --plan <file> --dry-run' });
    const resolve = body.next_steps.find((s: any) => s.action === 'resolve');
    expect(resolve.service_ids).toEqual(expect.arrayContaining(['cmp_raw', 'cmp_nolink', 'cmp_nomatch', 'cmp_feature', 'cmp_twin']));
  });

  test('--dry-run alone (no --plan) is discovery', async () => {
    const world = makeWorld();
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL, dryRun: true }, world.io);
    expect(result.exitCode).toBe(0);
    expect((result.body as any).proposals.length).toBeGreaterThan(0);
  });
});

describe('discovery: one round of calls, however many projects and services', () => {
  test('Capy is asked ONCE for the repo links and ONCE for the secret index; GitHub reads default branches in ONE batched call', async () => {
    const world = makeWorld();
    await discover(world);
    expect(world.capy.getOrgRepos).toHaveBeenCalledTimes(1);
    expect(world.capy.getSecretIndex).toHaveBeenCalledTimes(1);
    expect(world.github.getDefaultBranches).toHaveBeenCalledTimes(1);
    expect(world.github.getRepo).toHaveBeenCalledTimes(0);
    expect(world.github.listBranches).toHaveBeenCalledTimes(0);
    // Dokploy: the tree once, then each service exactly once, never per project.
    expect(world.dokploy.listProjects).toHaveBeenCalledTimes(1);
    expect(world.dokploy.getCompose.mock.calls.length + world.dokploy.getApplication.mock.calls.length).toBe(SERVICES.length);
    // One deploy.json read per linked folder that a service tracks, never more.
    expect(world.github.getFile.mock.calls.length).toBeLessThanOrEqual(8);
  });

  test('adding projects adds no Capy calls', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `proj_extra_${i}`,
      name: `extra-${i}`,
      repos: [{ owner: 'acme', name: 'solo', path: `extra/${i}` }],
      branches: { production: ['E1'] },
    }));
    const world = makeWorld({ projects: [...PROJECTS, ...many] });
    await discover(world);
    expect(world.capy.getOrgRepos).toHaveBeenCalledTimes(1);
    expect(world.capy.getSecretIndex).toHaveBeenCalledTimes(1);
    expect(world.github.getDefaultBranches).toHaveBeenCalledTimes(1);
  });
});

describe('discovery: refusals are coded', () => {
  test('no base URL: DOKPLOY_SETTINGS_MISSING, before anything is read', async () => {
    const world = makeWorld();
    const result = await runDeployDokployDiscover({}, world.io);
    // A refusal only a flag can answer exits 3 (needs input), so an agent branches on it.
    expect(result.exitCode).toBe(3);
    expect((result.body as any).code).toBe('DOKPLOY_SETTINGS_MISSING');
    expect(world.dokploy.listProjects).not.toHaveBeenCalled();
  });

  test('a saved Dokploy target\'s base URL is used when --base-url is not passed (the way connect --discover reads it)', async () => {
    const world = makeWorld({ io: { savedBaseUrl: () => BASE_URL } });
    const result = await runDeployDokployDiscover({}, world.io);
    expect(result.exitCode).toBe(0);
    expect((result.body as any).base_url).toBe(BASE_URL);
  });

  test('a missing Dokploy key: DOKPLOY_TOKEN_MISSING with where to get it, zero Dokploy requests, no prompt', async () => {
    const world = makeWorld();
    const io = { ...world.io, getConnectorSecret: async () => null };
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL }, io);
    const body = result.body as any;
    expect(result.exitCode).toBe(1);
    expect(body.code).toBe('DOKPLOY_TOKEN_MISSING');
    expect(typeof body.hint).toBe('string');
    expect(body.dashboard).toBe(BASE_URL);
    expect(world.dokploy.listProjects).not.toHaveBeenCalled();
  });

  test('the key is asked for without a prompt (interactive false) and from the connector entry', async () => {
    const world = makeWorld();
    await discover(world);
    expect(world.getConnectorSecret).toHaveBeenCalledTimes(1);
    const [name, opts] = world.getConnectorSecret.mock.calls[0] as [string, { interactive: boolean }];
    expect(name).toBe('_CONNECTOR_DOKPLOY_API_KEY');
    expect(opts.interactive).toBe(false);
  });

  test('--confirm without --plan: PLAN_REQUIRED', async () => {
    const world = makeWorld();
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL, confirm: 'abc' }, world.io);
    expect((result.body as any).code).toBe('PLAN_REQUIRED');
    expect(result.exitCode).toBe(1);
  });

  test('a repo-links 404 from an older service is a coded refusal', async () => {
    const world = makeWorld();
    const { CapyError } = await import('../../src/types/index');
    const client = { ...world.capy.client, getOrgRepos: async () => { throw new CapyError('x', 'REPO_LINKS_UNSUPPORTED'); } };
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL }, { ...world.io, context: async () => ({ ok: true, orgId: 'org_1', client: client as never }) });
    expect((result.body as any).code).toBe('REPO_LINKS_UNSUPPORTED');
  });
});

describe('discovery: JSON on stdout (terminal or not), progress on stderr', () => {
  test('in a fake terminal the command still prints exactly one JSON document and exits 0: no refusal, no prompt', async () => {
    const world = makeWorld();
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      const code = await withTty({ stdin: true, stdout: true }, () => deployDokployDiscoverCommand({ baseUrl: BASE_URL }, false, world.io));
      expect(code).toBe(0);
      expect(out).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(String(out.mock.calls[0][0]));
      expect(printed.ok).toBe(true);
      expect(printed.proposals.length).toBeGreaterThan(0);
      expect(printed).not.toHaveProperty('code');
    } finally {
      out.mockRestore();
    }
  });

  test('progress goes to the progress sink (stderr), never into the JSON on stdout', async () => {
    const world = makeWorld();
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      await deployDokployDiscoverCommand({ baseUrl: BASE_URL }, false, world.io);
      const stdoutText = String(out.mock.calls[0][0]);
      const lines = world.progress.mock.calls.map(([line]) => String(line));
      expect(lines.length).toBeGreaterThan(0);
      lines.forEach((line) => expect(stdoutText).not.toContain(line));
      expect(() => JSON.parse(stdoutText)).not.toThrow();
    } finally {
      out.mockRestore();
    }
  });

  test('a refusal is JSON on stdout too', async () => {
    const world = makeWorld();
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      const code = await deployDokployDiscoverCommand({}, false, world.io);
      expect(code).toBe(3);
      expect(JSON.parse(String(out.mock.calls[0][0])).code).toBe('DOKPLOY_SETTINGS_MISSING');
    } finally {
      out.mockRestore();
    }
  });
});

describe('discovery: routing from `capy deploy <target> --discover`', () => {
  test('only the dokploy target has a discovery: any other is DISCOVER_UNSUPPORTED_TARGET', async () => {
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      const code = await routeDeployDiscover('aws-ssm', { discover: true }, false, false);
      expect(code).toBe(1);
      expect(JSON.parse(String(out.mock.calls[0][0])).code).toBe('DISCOVER_UNSUPPORTED_TARGET');
    } finally {
      out.mockRestore();
    }
  });

  test('--plan, --confirm and --base-url without --discover are refused INVALID_FORMAT', async () => {
    const out = spyOn(console, 'log').mockImplementation((() => undefined) as never);
    try {
      const code = await routeDeployDiscover('dokploy', { plan: 'p.json' }, false, false);
      expect(code).toBe(1);
      expect(JSON.parse(String(out.mock.calls[0][0])).code).toBe('INVALID_FORMAT');
    } finally {
      out.mockRestore();
    }
  });

  test('no discover flags at all: not ours (undefined), so `capy deploy dokploy` keeps its own flow', async () => {
    expect(await routeDeployDiscover('dokploy', {}, false, false)).toBeUndefined();
    expect(await routeDeployDiscover(undefined, {}, true, false)).toBeUndefined();
  });
});

describe('discovery: no value appears anywhere', () => {
  test('neither the Dokploy sentinel nor the Capy sentinel is in the document, the progress lines or the refusals', async () => {
    const world = makeWorld();
    const { body } = await discover(world);
    const everything = JSON.stringify(body) + world.progress.mock.calls.map(([l]) => String(l)).join('\n');
    expect(everything).not.toContain(SENTINEL_DOKPLOY);
    expect(everything).not.toContain(SENTINEL_CAPY);
    expect(everything).not.toContain('SENTINEL');
    // The check bites: the planted values ARE in what the fakes returned, and the NAMES do appear in the output.
    expect((await world.dokploy.getCompose('cmp_solo')).env).toContain(SENTINEL_DOKPLOY);
    expect((await world.capy.getSecretIndex('org_1')).rows[0].value_hash).toContain(SENTINEL_CAPY);
    expect(JSON.stringify(body)).toContain('DATABASE_URL');
  });
});

