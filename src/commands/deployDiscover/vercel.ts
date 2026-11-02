/**
 * `capy deploy vercel --discover` (CAP-696): create Vercel deploy targets for
 * the Vercel projects that match Capy projects, and push NO values.
 *
 * The same command as `capy deploy dokploy --discover`, with Vercel for the
 * provider: it ALWAYS prints one JSON document on stdout, never prompts and
 * never opens a browser; three modes (facts, `--plan f --dry-run`,
 * `--plan f --confirm ID`); ONE pull request per repo. The shared modules do
 * the matching, the plan checks, the GitHub reads and the PR writing; this
 * file is what is Vercel's own: reading the projects, the service facts, and
 * the `KindOverrides` that turn a plan entry into a Vercel target.
 *
 * A "service" is one ENVIRONMENT of one Vercel project that holds variables:
 * production, preview, each custom environment, and `development` only when
 * it is the project's only environment with variables. A preview whose
 * records are scoped to a git branch is its own service per branch. The
 * deploy target is one per service.
 *
 * Names and ids only. The env list is asked for WITHOUT `decrypt` and the
 * client drops any `value` the response carries (`dropValues`); the per-id
 * value route is never called. The token is read from the org system store
 * (`_TARGET_VERCEL_TOKEN`, which may be a reference to
 * `_CONNECTOR_VERCEL_TOKEN`) or `$VERCEL_TOKEN`, and never asked for.
 *
 * Vercel REST endpoints (docs checked 2026-11-02, see `deploy/vercelApi.ts`):
 *   GET /v2/teams                              teams[].{id,slug,name}, pagination.next (`until`)
 *   GET /v10/projects?teamId=                  projects[].{id,name,rootDirectory,link}, pagination.next (`from`)
 *   GET /v9/projects/{id}/custom-environments  environments[].{id,slug}
 *   GET /v10/projects/{id}/env?teamId=         envs[].{key,type,target,gitBranch,customEnvironmentIds}
 */
import { posix } from 'node:path';
import type { TargetConfig } from '../../deploy/adapter';
import {
  VercelApiError,
  VercelClient,
  VercelCustomEnvironment,
  VercelEnvRecord,
  VercelProject,
  VercelTeam,
  mapVercelApiError,
} from '../../deploy/vercelApi';
import { GetVercelStoreSecret, describeVercelTokenProblem, resolveVercelTargetToken, vercelTargetKeyHelp } from '../../deploy/vercelTargetApi';
import { ERROR_CODES } from '../../types/index';
import { runPool } from '../../utils/pool';
import { GITHUB_HOST } from '../secretsSet';
import {
  CommonIo,
  DeployDiscoverResult,
  Step,
  World,
  discoveryGithubFacts,
  done,
  finishPlan,
  loadCapySide,
  readPlan,
  refuse,
  stop,
} from './command';
import { DiscoveryInput, PlanEntry, buildDeployDiscovery } from './discovery';
import { targetBaseName } from './evaluate';
import {
  ExistingTarget,
  RepoOut,
  ServiceFacts,
  VercelServiceFacts,
  relPathOf,
  uniqueSorted,
  vercelServiceId,
} from './facts';
import type { BranchChoice, KindOverrides } from './kind';
import { planIdOf } from './plan';
import { DEPLOY_VERCEL_PLAN_SCHEMA, VERCEL_PLAN_SCHEMA_REF } from './schema';

export { DEPLOY_VERCEL_PLAN_SCHEMA };

// ── Seams ────────────────────────────────────────────────────────────────────

export interface DeployVercelDiscoverOpts {
  /** The program-level `--dry-run`. */
  readonly dryRun?: boolean;
  /** `--plan <file>` */
  readonly plan?: string;
  /** `--confirm <plan_id>` */
  readonly confirm?: string;
}

/** Everything external, injected: tests pass fakes; `realVercelDiscoverIo` builds the real one. */
export interface DeployVercelDiscoverIo extends CommonIo {
  /** The org system store read for the Vercel token. Never asked to prompt. */
  readonly getSecret: GetVercelStoreSecret;
  /** The READ-ONLY Vercel client for a token. Built with `dropValues: true`. */
  readonly vercel: (token: string) => VercelClient;
}

// ── Facts: Vercel projects → services ────────────────────────────────────────

/** One project, everything read for it. Names and ids only: the env records carry no value. */
export interface VercelProjectScan {
  readonly project: VercelProject;
  readonly team: { readonly id: string; readonly slug?: string } | null;
  readonly customEnvironments: readonly VercelCustomEnvironment[];
  readonly envs: readonly VercelEnvRecord[];
}

const namesOf = (records: readonly VercelEnvRecord[]): readonly string[] => uniqueSorted(records.map((r) => r.key));

/** The repo a project is connected to, when it is a GitHub one. */
function repoOfProject(project: VercelProject): RepoOut | null {
  return project.link?.kind === 'github' ? { host: GITHUB_HOST, owner: project.link.org, name: project.link.repo } : null;
}

interface EnvSlice {
  readonly environment: string;
  readonly customEnvironmentId: string | null;
  readonly gitBranchScope: string | null;
  readonly names: readonly string[];
}

/** The environments of a project that hold variables. `system` records (Vercel's own) are never a variable of the project. */
function slicesOf(scan: VercelProjectScan): readonly EnvSlice[] {
  const records = scan.envs.filter((r) => r.type !== 'system');
  const standard = (target: string, keep: (r: VercelEnvRecord) => boolean = () => true): readonly VercelEnvRecord[] =>
    records.filter((r) => r.targets.includes(target) && keep(r));
  const production = standard('production');
  const previewAll = standard('preview', (r) => !r.gitBranch);
  const previewScoped = standard('preview', (r) => !!r.gitBranch);
  const scopes = uniqueSorted(previewScoped.map((r) => r.gitBranch as string));
  const custom = scan.customEnvironments.map((c) => ({ c, records: records.filter((r) => r.customEnvironmentIds.includes(c.id)) }));
  const slices: readonly EnvSlice[] = [
    { environment: 'production', customEnvironmentId: null, gitBranchScope: null, names: namesOf(production) },
    { environment: 'preview', customEnvironmentId: null, gitBranchScope: null, names: namesOf(previewAll) },
    ...scopes.map((scope): EnvSlice => ({
      environment: 'preview',
      customEnvironmentId: null,
      gitBranchScope: scope,
      names: namesOf(previewScoped.filter((r) => r.gitBranch === scope)),
    })),
    ...custom.map(({ c, records: mine }): EnvSlice => ({ environment: c.slug, customEnvironmentId: c.id, gitBranchScope: null, names: namesOf(mine) })),
  ].filter((slice) => slice.names.length > 0);
  // `development` is a target only when it is the one environment with variables.
  const development: readonly EnvSlice[] =
    slices.length === 0
      ? [{ environment: 'development', customEnvironmentId: null, gitBranchScope: null, names: namesOf(standard('development')) }].filter((s) => s.names.length > 0)
      : [];
  return [...slices, ...development];
}

/** The services of one project: one per environment that has variables. */
export function vercelServicesOf(scan: VercelProjectScan): readonly VercelServiceFacts[] {
  const { project } = scan;
  const repo = repoOfProject(project);
  const root = project.rootDirectory;
  return slicesOf(scan).map(
    (slice): VercelServiceFacts => ({
      service_id: vercelServiceId(project.id, slice.environment, slice.gitBranchScope),
      kind: 'vercel',
      name: project.name,
      vercel_project_id: project.id,
      team: scan.team,
      environment: slice.environment,
      custom_environment_id: slice.customEnvironmentId,
      git_branch_scope: slice.gitBranchScope,
      root_directory: root,
      repo,
      branch: project.link?.productionBranch ?? null,
      path: repo === null ? null : relPathOf(root),
      env_var_names: slice.names,
    }),
  );
}

// ── Reading Vercel ───────────────────────────────────────────────────────────

const SCAN_CONCURRENCY = 3;

type Scope = { readonly team: { readonly id: string; readonly slug?: string } | null; readonly projects: readonly VercelProject[] };

/** Every team the token sees, then the token's own scope; a project listed twice counts once (the first listing wins). */
async function readScopes(client: VercelClient): Promise<readonly Scope[]> {
  const teams = await client.listTeams();
  const scopes = [...teams.map((t: VercelTeam) => ({ id: t.id as string | undefined, team: { id: t.id, slug: t.slug } as Scope['team'] })), { id: undefined, team: null as Scope['team'] }];
  const read = await scopes.reduce<Promise<readonly Scope[]>>(async (accPromise, scope) => {
    const acc = await accPromise;
    const seen = new Set(acc.flatMap((s) => s.projects.map((p) => p.id)));
    const projects = (await client.listProjects(scope.id)).filter((p) => !seen.has(p.id));
    return [...acc, { team: scope.team, projects }];
  }, Promise.resolve([]));
  // The token's own scope is only worth a mention when it holds a project no team listed.
  return read.filter((s) => s.team !== null || s.projects.length > 0);
}

interface ScanOutcome {
  readonly scan?: VercelProjectScan;
  readonly truncated: boolean;
  readonly error?: unknown;
}

async function scanProject(client: VercelClient, project: VercelProject, team: Scope['team']): Promise<ScanOutcome> {
  try {
    const teamId = team?.id;
    const customEnvironments = await client.listCustomEnvironments(project.id, teamId);
    const list = await client.listEnvs(project.id, teamId);
    return { scan: { project, team, customEnvironments, envs: list.envs }, truncated: list.truncated };
  } catch (error) {
    return { truncated: false, error };
  }
}

function vercelFailure(err: unknown): DeployDiscoverResult {
  const mapped = mapVercelApiError(err);
  // A rejected token says where to get another.
  const help = err instanceof VercelApiError && err.code === 'unauthorized' ? vercelTargetKeyHelp() : {};
  return refuse(mapped.code, mapped.message, help);
}

interface VercelWorld {
  readonly services: readonly ServiceFacts[];
  readonly teams: ReadonlyArray<{ readonly id: string; readonly slug: string }>;
  readonly notices: ReadonlyArray<{ readonly code: string; readonly detail?: string }>;
}

/**
 * The Vercel side. `only` (plan mode): the project ids the plan names, the only
 * ones whose environments are read; every project is listed (the list carries
 * the git link and root directory).
 */
async function loadVercel(
  io: Pick<CommonIo, 'progress'>,
  client: VercelClient,
  only?: ReadonlySet<string>,
): Promise<Step<VercelWorld>> {
  io.progress('Reading Vercel projects…'); // COPY-FLAG
  const listed = await readScopes(client).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  if (!listed.ok) return stop(vercelFailure(listed.err));
  const scopes = listed.value;
  const withScope = scopes.flatMap((scope) => scope.projects.map((project) => ({ project, team: scope.team })));
  const wanted = withScope.filter(({ project }) => (only === undefined ? true : only.has(project.id)));
  const readable = wanted.filter(({ project }) => repoOfProject(project) !== null);
  const notLinked = wanted.filter(({ project }) => repoOfProject(project) === null);
  const pooled = await runPool({
    items: readable,
    limit: SCAN_CONCURRENCY,
    run: async ({ project, team }) => ({ result: await scanProject(client, project, team) }),
    onChange: (p) => {
      if (p.done === p.total || p.done % 10 === 0) io.progress(`Read ${p.done} of ${p.total} Vercel projects`); // COPY-FLAG
    },
  });
  const failed = pooled.results.find((r) => r.error !== undefined);
  if (failed !== undefined) return stop(vercelFailure(failed.error));
  const scans = pooled.results.flatMap((r) => (r.scan === undefined ? [] : [r.scan]));
  return done({
    services: scans.flatMap(vercelServicesOf),
    teams: scopes.flatMap((s) => (s.team === null ? [] : [{ id: s.team.id, slug: s.team.slug as string }])),
    notices: [
      ...notLinked.map(({ project }) => ({ code: ERROR_CODES.VERCEL_PROJECT_NOT_GITHUB, detail: project.name })),
      ...pooled.results.flatMap((r) => (r.truncated && r.scan !== undefined ? [{ code: ERROR_CODES.VERCEL_ENV_LIST_TRUNCATED, detail: r.scan.project.name }] : [])),
    ],
  });
}

// ── The provider's overrides ─────────────────────────────────────────────────

const asVercel = (service: ServiceFacts): VercelServiceFacts => service as VercelServiceFacts;

/** The Capy branch named like the environment (a scoped preview: like its git branch first); production falls back to its production branch. */
function chooseVercelBranch(
  service: ServiceFacts,
  _defaultBranch: string | null | undefined,
  projectBranches: readonly string[],
): BranchChoice | null {
  const v = asVercel(service);
  const candidates: ReadonlyArray<BranchChoice> = [
    ...(v.git_branch_scope === null ? [] : [{ branch: v.git_branch_scope, standard: true }]),
    { branch: v.environment, standard: v.git_branch_scope === null },
    ...(v.environment === 'production' && v.branch !== null ? [{ branch: v.branch, standard: false }] : []),
  ];
  return candidates.find((c) => projectBranches.includes(c.branch)) ?? null;
}

/** An existing Vercel target for this project + environment (+ preview git branch). The Capy branch it ships is not part of the question. */
function vercelConfigured(targets: readonly ExistingTarget[], service: ServiceFacts): ExistingTarget | undefined {
  return targets.find((t) => t.kind === 'vercel' && t.service_id === service.service_id);
}

/** A project's folder relative to the folder the deploy.json lives in. */
function projectDirFor(linkPath: string, servicePath: string | null): string {
  const from = relPathOf(linkPath);
  const to = servicePath === null ? '.' : relPathOf(servicePath);
  return posix.relative(from === '.' ? '' : from, to === '.' ? '' : to) || '.';
}

const envLabel = (v: VercelServiceFacts): string => (v.git_branch_scope === null ? v.environment : `${v.environment}@${v.git_branch_scope}`);

function vercelTargetOf(args: {
  readonly name: string;
  readonly entry: PlanEntry;
  readonly service: ServiceFacts;
  readonly link: { readonly path: string };
  readonly knownVars: readonly string[];
}): TargetConfig {
  const { name, entry, knownVars } = args;
  const v = asVercel(args.service);
  return {
    name,
    kind: 'vercel',
    branch: entry.branch,
    vars: [...uniqueSorted(entry.vars)],
    knownVars: [...knownVars],
    options: {
      projectDir: projectDirFor(args.link.path, v.path),
      vercelEnv: v.environment,
      projectId: v.vercel_project_id,
      ...(v.team === null ? {} : { teamId: v.team.id }),
      ...(v.custom_environment_id === null ? {} : { customEnvironmentId: v.custom_environment_id }),
      ...(v.git_branch_scope === null ? {} : { gitBranch: v.git_branch_scope }),
    },
    mode: 'ci',
    gitBaseBranch: entry.git_branch,
  };
}

// COPY-FLAG: new user-facing strings below (summary line, PR title/body), minimal and neutral.
export const VERCEL_KIND: KindOverrides = {
  command: 'capy deploy vercel --discover',
  schemaRef: VERCEL_PLAN_SCHEMA_REF,
  planDomain: 'capy:deploy-vercel:plan:v1',
  chooseCapyBranch: chooseVercelBranch,
  configured: (targets, service) => vercelConfigured(targets, service),
  // Several Vercel projects (a monorepo) may ship one Capy branch: a target for another project is not a clash.
  conflicting: () => undefined,
  duplicateKey: (e) => [e.project_id, e.branch, e.service_id].join('\u0000'),
  proposalTarget: (service, branch, gitBranch, vars) => {
    const v = asVercel(service);
    return {
      kind: 'vercel',
      projectId: v.vercel_project_id,
      ...(v.team === null ? {} : { teamId: v.team.id }),
      vercelEnv: v.environment,
      ...(v.custom_environment_id === null ? {} : { customEnvironmentId: v.custom_environment_id }),
      ...(v.git_branch_scope === null ? {} : { gitBranch: v.git_branch_scope }),
      branch,
      gitBaseBranch: gitBranch,
      mode: 'ci',
      vars,
    };
  },
  baseName: (entry) => targetBaseName(entry.branch, 'vercel'),
  targetFor: vercelTargetOf,
  summaryLine: ({ project_name, service, entry }) => {
    const v = asVercel(service);
    return `${project_name} · ${entry.branch} → Vercel ${v.name} ${envLabel(v)} (${entry.git_branch}), ${entry.vars.length} vars`;
  },
  pr: {
    title: 'chore(capy): add Vercel deploy targets',
    intro: 'Adds Vercel deploy targets to `.capy/deploy.json`.',
    line: ({ target, path, service }) => {
      const v = asVercel(service);
      return `- \`${target.name}\` in \`${path}\`: Capy branch \`${target.branch}\`, Vercel project \`${v.vercel_project_id}\` (${envLabel(v)}), git branch \`${target.gitBaseBranch ?? ''}\``;
    },
  },
};

// ── The command ──────────────────────────────────────────────────────────────

/** The token, never asked for: the system store (`_TARGET_VERCEL_TOKEN`, or the connector token it refers to), then `$VERCEL_TOKEN`. */
async function vercelClient(io: DeployVercelDiscoverIo, orgId: string): Promise<Step<VercelClient>> {
  const resolved = await resolveVercelTargetToken({
    env: io.env,
    // Never a prompt: a missing token is a coded refusal that says where to get it.
    interactive: false,
    orgId,
    devMode: io.devMode,
    getSecret: io.getSecret,
  });
  if (!resolved.ok) {
    const { reason, hint } = describeVercelTokenProblem(resolved.code);
    return stop(refuse(resolved.code, `${reason}.`, { hint, ...vercelTargetKeyHelp() }));
  }
  return done(io.vercel(resolved.value));
}

async function runDiscovery(io: DeployVercelDiscoverIo): Promise<DeployDiscoverResult> {
  const ctx = await io.context();
  if (!ctx.ok) return refuse(ctx.code, ctx.message);
  const client = await vercelClient(io, ctx.orgId);
  if (!client.ok) return client.result;
  const vercel = await loadVercel(io, client.value);
  if (!vercel.ok) return vercel.result;
  const capy = await loadCapySide(io, ctx.client, ctx.orgId);
  if (!capy.ok) return capy.result;
  const world: World = { orgId: ctx.orgId, services: vercel.value.services, ...capy.value };
  const github = await discoveryGithubFacts(io, world);
  const input: DiscoveryInput = {
    baseUrl: '',
    header: { teams: vercel.value.teams },
    services: world.services,
    projects: world.projects,
    defaultBranches: github.defaultBranches,
    existingTargets: github.existingTargets,
    notices: [...vercel.value.notices, ...github.notices],
  };
  return { exitCode: 0, body: { ok: true, ...buildDeployDiscovery(input, VERCEL_KIND) } };
}

/** The project ids a plan names: a service id is `<project id>:<environment>`. */
const projectIdsOfPlan = (entries: readonly PlanEntry[]): ReadonlySet<string> =>
  new Set(entries.map((e) => e.service_id.slice(0, Math.max(0, e.service_id.indexOf(':')))));

async function runPlan(opts: DeployVercelDiscoverOpts, io: DeployVercelDiscoverIo): Promise<DeployDiscoverResult> {
  const parsed = readPlan(opts, io);
  if (!parsed.ok) return parsed.result;
  const { entries, plan } = parsed.value;
  const confirming = opts.confirm !== undefined && opts.dryRun !== true;

  const ctx = await io.context();
  if (!ctx.ok) return refuse(ctx.code, ctx.message);
  const planId = planIdOf(plan, '', VERCEL_KIND.planDomain);
  // A plan that moved since it was confirmed: nothing more is looked up, nothing is done.
  if (confirming && opts.confirm !== planId) {
    return refuse(ERROR_CODES.PLAN_CHANGED, 'The plan is not the one that was confirmed. Nothing was changed.', { plan_id: planId, plan }); // COPY-FLAG
  }
  const client = await vercelClient(io, ctx.orgId);
  if (!client.ok) return client.result;
  const vercel = await loadVercel(io, client.value, projectIdsOfPlan(entries));
  if (!vercel.ok) return vercel.result;
  const capy = await loadCapySide(io, ctx.client, ctx.orgId);
  if (!capy.ok) return capy.result;
  const world: World = { orgId: ctx.orgId, services: vercel.value.services, ...capy.value };
  return finishPlan({ opts, io, parsed: parsed.value, planId, world, scope: '', extras: {}, kind: VERCEL_KIND });
}

/** Runs the command and returns what it prints. Never prints, never exits, never prompts. */
export async function runDeployVercelDiscover(opts: DeployVercelDiscoverOpts, io: DeployVercelDiscoverIo): Promise<DeployDiscoverResult> {
  if (opts.confirm !== undefined && opts.plan === undefined) {
    return refuse(ERROR_CODES.PLAN_REQUIRED, '--confirm needs --plan <file>.'); // COPY-FLAG
  }
  return opts.plan === undefined ? runDiscovery(io) : runPlan(opts, io);
}
