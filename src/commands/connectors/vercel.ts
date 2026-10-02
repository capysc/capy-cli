/**
 * `capy connect vercel` — a ONE-TIME IMPORT of a Vercel project's environment
 * variables into this project's `.env`, then encrypted + synced the same way
 * every other connector's write lands (CAP-696). It mirrors
 * `capy connect dokploy` (`./dokploy.ts`): same flags, same outcomes, same
 * safety rules, same discovery sequence.
 *
 * Import is READ-ONLY on the Vercel side — see `deploy/vercelApi.ts`, whose
 * client type has no way to write. The Vercel token is never stored by THIS
 * file: it resolves from the org system store's `_CONNECTOR_VERCEL_TOKEN`
 * (which the store may prompt for and save, once, on an admin's first use),
 * or the variable named by `--token-env` / `$VERCEL_TOKEN`. It is resolved
 * before any Vercel request and never prompted for under `--dry-run`,
 * `--json` or `--web`.
 *
 * Environment → Capy branch: `production`, `preview`, `development`, or a
 * custom environment's slug. One Vercel record that targets several
 * environments counts in each. What is NOT imported is reported by stable
 * reason, names only: `git_branch_scoped` (a preview record scoped to one git
 * branch — it is not an all-branches preview var), `sensitive_unreadable`,
 * `legacy_secret_unreadable`, `vercel_system`, `unsupported_type`,
 * `duplicate_key`, `empty_value`.
 *
 * Every refusal for a missing or rejected token carries the Vercel token page
 * (`link`) and what to do (`remedy`), with the team's slug when `--team` names it.
 *
 * Deploy targets: like Dokploy, a target is OFFERED only after a single
 * import, only interactively (never under `--json`, `--dry-run`, or
 * non-interactive). Discovery never saves one by itself.
 */
import { join } from 'node:path';
import { TargetConfig } from '../../deploy/adapter';
import { classifyImportCandidates } from '../../deploy/dokployApi';
import {
  DEFAULT_VERCEL_TOKEN_ENV,
  VERCEL_TARGET_SECRET_NAME,
  VercelApiError,
  VercelClient,
  VercelCustomEnvironment,
  VercelEnvRecord,
  VercelEnvironmentInfo,
  VercelFetchLike,
  VercelImportSource,
  VercelProject,
  VercelSkippedRecord,
  VercelSystemStoreCallOptions,
  VercelTeam,
  availableEnvironments,
  buildEnvironmentPlans,
  createVercelClient,
  describeVercelTokenProblem,
  mapVercelApiError,
  parseVarList,
  resolveEnvValues,
  resolveTeam,
  resolveVercelToken,
  vercelSecretsMayPrompt,
} from '../../deploy/vercelApi';
import { keyHelpFields, teamSlugOf, vercelKeyHelp } from '../../deploy/keyHelp';
import { ConnectorMetadata, ERROR_CODES } from '../../types/index';
import { isInteractive } from '../../ui/interactive';
import { listOrgProjectsOrUnavailable } from '../capyCommand';
import { defaultDiscoveryCommitBranchName, snapshotPathStatus } from '../../git/discoveryCommit';
import { fingerprint, ResolvedContext } from './shared';
import {
  ConnectFailure,
  ConnectOpts,
  ConnectorModule,
  ConnectResult,
  ImportOutcome,
  ImportSkip,
  ImportWarning,
  RotateResult,
} from './registry';
import {
  CandidateRepo,
  DiscoveryCollision,
  DiscoveryContext,
  DiscoveryOutcome,
  DiscoveryPlan,
  DiscoveryDeployTarget,
  DiscoveryFolderResult,
  DiscoveryPlanFolder,
  applyCollisionResolutions,
  findCandidateReposResult,
  orderEnvironments,
  resolveCollisions,
  runDiscoverySequences,
} from './dokployDiscovery';
import {
  ExistingProjectsSnapshot,
  buildRealDiscoverySequenceDeps,
  commitForAppliedRepos,
  commitPreviewForFolders,
  computeOverwritePlan,
  computeSameRunNameCollisions,
  OverwritePlan,
  defaultAskDiscoveryCommitBranchName,
  defaultAskDiscoveryProjectName,
  defaultAskExistingOrNewProject,
  defaultConfirm,
  defaultPickCollisionWinner,
  discoveryCommitPathsFor,
  peekLocalKeepForFolder,
} from './dokploy';
import { buildVercelDiscoveryPlan, reportVercelDiscovery } from './vercelDiscovery';
import { VERCEL_CONNECTOR_SECRET_NAME } from '../../deploy/vercelApi';

const VERCEL_COMMIT_MESSAGE = 'chore(capy): import Vercel environments';

type Failure = ConnectFailure;

// ── Prompts (real `inquirer`; every one is injectable) ──────────────────────

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultSelectVars(candidates: readonly string[]): Promise<readonly string[]> {
  if (candidates.length === 0) return [];
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'picked',
      message: 'Which variables to import from Vercel:',
      choices: candidates.map((name) => ({ name, value: name, checked: true })),
    },
  ]);
  return picked;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultPickTeam(teams: readonly VercelTeam[]): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    { type: 'list', name: 'picked', message: 'Which Vercel team:', choices: teams.map((t) => ({ name: t.slug, value: t.id })) },
  ]);
  return picked;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultAskProject(): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { project } = await inquirer.prompt([
    {
      type: 'input',
      name: 'project',
      message: 'Vercel project (id or name):',
      validate: (v: string) => (v.trim() ? true : 'required'),
      filter: (v: string) => v.trim(),
    },
  ]);
  return project;
}

export interface VercelConnectorDeps {
  fetch?: VercelFetchLike;
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => Date;
  /** Injectable so a 429 test never really waits. */
  sleep?: (ms: number) => Promise<void>;
  confirm?: (message: string, defaultValue: boolean) => Promise<boolean>;
  selectVars?: (candidates: readonly string[]) => Promise<readonly string[]>;
  pickTeam?: (teams: readonly VercelTeam[]) => Promise<string>;
  askProject?: () => Promise<string>;
  pickCollisionWinner?: (collision: DiscoveryCollision) => Promise<string>;
  askExistingOrNewProject?: (existing: ReadonlyArray<{ id: string; name: string }>, defaultName: string) => Promise<string>;
  askDiscoveryProjectName?: (defaultName: string) => Promise<string>;
  askDiscoveryCommitBranchName?: (defaultName: string) => Promise<string>;
  /**
   * Reads the org system store's `_CONNECTOR_VERCEL_TOKEN` entry. Defaults to
   * a no-op that never touches the network; the exported `vercelConnector`
   * singleton wires the real `system/systemStore.ts` lookup.
   */
  getConnectorSecret?: (name: string, opts: VercelSystemStoreCallOptions) => Promise<string | null>;
}

// ── Connector entry (keep.lock metadata) ────────────────────────────────────

/**
 * The keep.lock connector entry for one vercel-imported value. Additive:
 * `vercel_project_id`, `vercel_project`, `team_id`, `env_id`,
 * `configuration_id` (when Vercel set one), plus the generic `provider`,
 * `source`, `environment`, `imported_at`, `fingerprint`.
 */
export function buildVercelConnectorEntry(
  record: VercelEnvRecord,
  value: string,
  meta: { project: { id: string; name: string }; teamId?: string; environment: string; createdAtSec: number; importedAt: string },
): ConnectorMetadata {
  return {
    provider: 'vercel',
    source: 'import',
    created_at: meta.createdAtSec,
    fingerprint: fingerprint(value),
    imported_at: meta.importedAt,
    vercel_project_id: meta.project.id,
    vercel_project: meta.project.name,
    ...(meta.teamId ? { team_id: meta.teamId } : {}),
    environment: meta.environment,
    env_id: record.id,
    ...(record.configurationId ? { configuration_id: record.configurationId } : {}),
  };
}

// ── Source resolution (token, team, project, environment, records) ──────────

interface SourceRead {
  teamId: string | undefined;
  project: { id: string; name: string; productionBranch?: string };
  environment: VercelEnvironmentInfo;
  importable: readonly VercelEnvRecord[];
  skipped: readonly VercelSkippedRecord[];
  truncated: boolean;
}

async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | Failure> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, ...mapVercelApiError(err) };
  }
}

/** `getProject` with a 404 as `VERCEL_PROJECT_NOT_FOUND` (checked on the typed error's code, never its text). */
async function fetchProject(client: VercelClient, idOrName: string, teamId: string | undefined): Promise<{ ok: true; project: VercelProject } | Failure> {
  try {
    return { ok: true, project: await client.getProject(idOrName, teamId) };
  } catch (err) {
    if (err instanceof VercelApiError && err.code === 'not_found') {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      return { ok: false, code: ERROR_CODES.VERCEL_PROJECT_NOT_FOUND, message: `No Vercel project ${idOrName}.` };
    }
    return { ok: false, ...mapVercelApiError(err) };
  }
}

/** Which environment a single import reads: `--environment`, else the one named like the current Capy branch. */
function chooseEnvironment(
  available: readonly VercelEnvironmentInfo[],
  requested: string | undefined,
  branch: string,
): { ok: true; environment: VercelEnvironmentInfo } | Failure {
  const names = available.map((e) => e.name).join(', ');
  const want = requested?.trim();
  if (want) {
    const hit = available.find((e) => e.name === want);
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    return hit
      ? { ok: true, environment: hit }
      : { ok: false, code: ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND, message: `No Vercel environment "${want}". Environments: ${names}.` };
  }
  const byBranch = available.find((e) => e.name === branch);
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  return byBranch
    ? { ok: true, environment: byBranch }
    : {
        ok: false,
        code: ERROR_CODES.VERCEL_ENVIRONMENT_REQUIRED,
        message: `The current branch "${branch}" is not a Vercel environment. Pass --environment <name>. Environments: ${names}.`,
      };
}

async function pickProjectArg(opts: ConnectOpts, promptable: boolean, askProject: () => Promise<string>): Promise<string | null> {
  const given = opts.project?.trim();
  if (given) return given;
  return promptable ? (await askProject()).trim() || null : null;
}

// ── --overwrite ──────────────────────────────────────────────────────────────

// COPY-FLAG: new user-facing string, minimal/neutral wording.
function overwriteConfirmMessage(plan: OverwritePlan): string {
  const lines = [
    'Overwrite local vars to match Vercel exactly?',
    plan.toImport.length > 0 ? `  Import (${plan.toImport.length}): ${plan.toImport.map((e) => e.name).join(', ')}` : null,
    plan.toReplace.length > 0 ? `  Replace (${plan.toReplace.length}): ${plan.toReplace.map((e) => e.name).join(', ')}` : null,
    plan.toClear.length > 0 ? `  Clear (${plan.toClear.length}): ${plan.toClear.join(', ')}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
function discoveryConfirmMessage(folders: readonly DiscoveryPlanFolder[], overwrite: boolean, environmentFilter?: readonly string[]): string {
  const totalSteps = folders.reduce((n, f) => n + f.environments.length, 0);
  const filterNote = environmentFilter && environmentFilter.length > 0 ? ` (--environment ${environmentFilter.join(',')})` : '';
  const header = `Run ${totalSteps} step(s) across ${folders.length} folder(s) from Vercel${overwrite ? ' (--overwrite)' : ''}${filterNote}?`;
  const rows = folders.flatMap((f) => [
    `  ${f.folder || '.'} (${f.projectName})${f.initialized ? '' : ' — capy (init)'}`,
    ...orderEnvironments(f.environments).map((e) => {
      const checkoutCmd = e.branchExists === true ? `capy checkout ${e.environmentName}` : `capy checkout -b ${e.environmentName}`;
      const importCmd = `capy connect vercel --project ${e.serviceId} --environment ${e.environmentName}${overwrite || e.willAutoOverwrite ? ' --overwrite' : ''}`;
      return `    ${checkoutCmd} && ${importCmd}  (${e.variableCount} var(s), ${e.skippedCount} skipped)${e.willAutoOverwrite && !overwrite ? ' [auto-overwrite]' : ''}`;
    }),
  ]);
  return [header, ...rows].join('\n');
}

// ── Deploy-target offer ─────────────────────────────────────────────────────

function uniqueTargetName(existing: readonly TargetConfig[], base: string): string {
  const names = new Set(existing.map((t) => t.name));
  const numbered = (n: number): string => (names.has(`${base}-${n}`) ? numbered(n + 1) : `${base}-${n}`);
  return names.has(base) ? numbered(2) : base;
}

/** The name a new `vercel-<environment>` target for this project + environment gets; `null` when one already exists. */
function newTargetName(allTargets: readonly TargetConfig[], projectId: string, environmentName: string): string | null {
  const already = allTargets.some((t) => {
    const o = t.options as { projectId?: string; vercelEnv?: string };
    return t.kind === 'vercel' && o.projectId === projectId && o.vercelEnv === environmentName;
  });
  return already ? null : uniqueTargetName(allTargets, `vercel-${environmentName}`);
}

interface TargetArgs {
  importedNames: readonly string[];
  project: { id: string; name: string; productionBranch?: string };
  teamId: string | undefined;
  environment: VercelEnvironmentInfo;
  allTargets: readonly TargetConfig[];
}

/**
 * The `vercel-<environment>` deploy target for the SAME project + environment
 * an import just read — API mode, all-branches vars (no `gitBranch`), CI mode,
 * `gitBaseBranch` the project's production branch for `production`. `null`
 * when nothing was imported or the project + environment already has a target.
 * The one definition both the interactive offer and `--targets` save.
 */
function buildDeployTarget(args: TargetArgs): TargetConfig | null {
  if (args.importedNames.length === 0) return null;
  const name = newTargetName(args.allTargets, args.project.id, args.environment.name);
  if (name === null) return null;
  return {
    name,
    kind: 'vercel',
    branch: args.environment.name,
    vars: [...args.importedNames],
    mode: 'ci',
    ...(args.environment.name === 'production' && args.project.productionBranch ? { gitBaseBranch: args.project.productionBranch } : {}),
    options: {
      projectDir: '.',
      vercelEnv: args.environment.name,
      projectId: args.project.id,
      ...(args.teamId ? { teamId: args.teamId } : {}),
      ...(args.environment.customEnvironmentId ? { customEnvironmentId: args.environment.customEnvironmentId } : {}),
    },
  };
}

interface TargetOfferArgs extends TargetArgs {
  promptable: boolean;
  dir: string;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
}

/**
 * After a successful single import, offer to save a Vercel deploy target for
 * the SAME project + environment. Only asked interactively; non-interactive,
 * `--json` and `--dry-run` never ask and never save (`--targets` is the way to
 * save one without asking).
 */
async function maybeOfferDeployTarget(args: TargetOfferArgs): Promise<boolean> {
  if (args.importedNames.length === 0 || !args.promptable) return false;
  const target = buildDeployTarget(args);
  if (!target) return false;

  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const yes = await args.confirm(
    `Save a Vercel deploy target for ${args.project.name} (${args.environment.name}), so \`capy deploy\` can ship the runtime pair to it?`,
    false,
  );
  if (!yes) return false;

  const { upsertTarget } = await import('../../deploy/config');
  upsertTarget(args.dir, target);
  return true;
}

/**
 * `--targets`: the target this import would write, and where — planned here,
 * saved by `writeImportOutcome` once the import itself is written (never under
 * a dry run, which only reports it).
 */
function planTargetsOutcome(
  args: TargetArgs & { dir: string; dryRun: boolean },
): Pick<Extract<ImportOutcome, { ok: true }>, 'deployTarget' | 'deployTargetToWrite'> {
  const target = buildDeployTarget(args);
  if (!target) return {};
  const deployTarget = { name: target.name, environment: args.environment.name, written: !args.dryRun };
  return args.dryRun ? { deployTarget } : { deployTarget, deployTargetToWrite: { dir: args.dir, target } };
}

// ── Connector ────────────────────────────────────────────────────────────────

export function createVercelConnector(deps: VercelConnectorDeps = {}): ConnectorModule {
  const cwd = () => deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const env = () => deps.env ?? process.env;
  const confirm = deps.confirm ?? defaultConfirm;
  const selectVars = deps.selectVars ?? defaultSelectVars;
  const pickTeam = deps.pickTeam ?? defaultPickTeam;
  const askProject = deps.askProject ?? defaultAskProject;
  const pickCollisionWinner = deps.pickCollisionWinner ?? defaultPickCollisionWinner;
  const askExistingOrNewProject = deps.askExistingOrNewProject ?? defaultAskExistingOrNewProject;
  const askDiscoveryProjectName = deps.askDiscoveryProjectName ?? defaultAskDiscoveryProjectName;
  const askDiscoveryCommitBranchName = deps.askDiscoveryCommitBranchName ?? defaultAskDiscoveryCommitBranchName;

  /** Where to get a token: the page, the Scope instruction, and the team's slug when `--team` names it. */
  const tokenHelp = (opts: ConnectOpts) => keyHelpFields(vercelKeyHelp(VERCEL_CONNECTOR_SECRET_NAME, { team: opts.team }));

  /** The token, then a client — or the coded refusal. Resolved BEFORE any Vercel request, so a missing token means zero requests. */
  const openClient = async (
    orgId: string,
    opts: ConnectOpts,
    interactive: boolean,
  ): Promise<{ ok: true; client: VercelClient; tokenEnv: string } | Failure> => {
    const tokenEnv = opts.tokenEnv?.trim() || DEFAULT_VERCEL_TOKEN_ENV;
    // `--web`, `--json` and `--dry-run` each suppress ONLY the system store's
    // hidden prompt: a raw terminal prompt must not hang a browser run, be
    // interleaved with machine output, or save a key as a preview's side effect.
    const mayPrompt = vercelSecretsMayPrompt(interactive, !!opts.web || !!opts.json || !!opts.dryRun);
    const resolved = await resolveVercelToken({
      tokenEnv,
      env: env(),
      interactive: mayPrompt,
      orgId,
      devMode: opts.devMode,
      getConnectorSecret: deps.getConnectorSecret,
      ...(teamSlugOf(opts.team) ? { helpTeam: teamSlugOf(opts.team) } : {}),
    });
    if (!resolved.ok) {
      const { reason } = describeVercelTokenProblem(resolved.code, tokenEnv);
      return { ok: false, code: resolved.code, message: `${reason}.`, ...tokenHelp(opts) };
    }
    return {
      ok: true,
      tokenEnv,
      client: createVercelClient(resolved.value, { fetch: deps.fetch, sleep: deps.sleep }),
    };
  };

  /** Team scope: `--team`, the token's only team, a pick (only when this run can ask), or a coded refusal. */
  const chooseTeam = async (
    client: VercelClient,
    opts: ConnectOpts,
    promptable: boolean,
  ): Promise<{ ok: true; teamId: string | undefined; teamSlug?: string } | Failure> => {
    const teams = await guard(() => client.listTeams());
    if (!teams.ok) return teams;
    const team = await resolveTeam(teams.value, opts.team, promptable ? pickTeam : null);
    return team;
  };

  const readSource = async (
    client: VercelClient,
    ctx: ResolvedContext,
    opts: ConnectOpts,
    promptable: boolean,
  ): Promise<({ ok: true } & SourceRead) | Failure> => {
    // Discovery's per-environment call hands over the team and project it
    // already resolved; a plain import resolves both here.
    const team = opts.vercelTeam ? { ok: true as const, teamId: opts.vercelTeam.id } : await chooseTeam(client, opts, promptable);
    if (!team.ok) return team;

    const projectInfo = opts.vercelProject
      ? ({ ok: true, project: opts.vercelProject } as const)
      : await resolveProjectInfo(client, opts, promptable, team.teamId);
    if (!projectInfo.ok) return projectInfo;

    const custom = await guard<readonly VercelCustomEnvironment[]>(() => client.listCustomEnvironments(projectInfo.project.id, team.teamId));
    if (!custom.ok) return custom;
    const chosen = chooseEnvironment(availableEnvironments(custom.value), opts.environment, ctx.branch);
    if (!chosen.ok) return chosen;
    const list = await guard(() => client.listEnvs(projectInfo.project.id, team.teamId));
    if (!list.ok) return list;

    const plan = buildEnvironmentPlans(list.value.envs, custom.value).find((p) => p.environment.name === chosen.environment.name);
    return {
      ok: true,
      teamId: team.teamId,
      project: projectInfo.project,
      environment: chosen.environment,
      importable: plan?.importable ?? [],
      skipped: plan?.skipped ?? [],
      truncated: list.value.truncated,
    };
  };

  const resolveProjectInfo = async (
    client: VercelClient,
    opts: ConnectOpts,
    promptable: boolean,
    teamId: string | undefined,
  ): Promise<{ ok: true; project: { id: string; name: string; productionBranch?: string } } | Failure> => {
    const arg = await pickProjectArg(opts, promptable, askProject);
    if (!arg) {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      return { ok: false, code: ERROR_CODES.VERCEL_PROJECT_REQUIRED, message: 'No Vercel project. Pass --project <id|name>, or run this interactively.' };
    }
    const found = await fetchProject(client, arg, teamId);
    if (!found.ok) return found;
    const productionBranch = found.project.link?.productionBranch;
    return { ok: true, project: { id: found.project.id, name: found.project.name, ...(productionBranch ? { productionBranch } : {}) } };
  };

  /** `--targets` only: the target this import writes (dry run: would write). Nothing when the flag is off. */
  const plannedTargets = async (
    opts: ConnectOpts,
    source: SourceRead,
    importedNames: readonly string[],
    dryRun: boolean,
  ): Promise<Pick<Extract<ImportOutcome, { ok: true }>, 'deployTarget' | 'deployTargetToWrite'>> => {
    if (!opts.targets) return {};
    const dir = opts.projectDir ?? cwd();
    return planTargetsOutcome({
      importedNames,
      project: source.project,
      teamId: source.teamId,
      environment: source.environment,
      allTargets: await listTargetsAt(dir),
      dir,
      dryRun,
    });
  };

  /** `--overwrite`'s own run: plan from Vercel's FULL readable set (never `--var`-restricted), confirm, return the outcome for the caller to write. */
  const runOverwriteImport = async (a: {
    ctx: ResolvedContext;
    opts: ConnectOpts;
    source: SourceRead;
    importSource: VercelImportSource;
    client: VercelClient;
    promptable: boolean;
    dryRun: boolean;
  }): Promise<ImportOutcome> => {
    const { ctx, opts, source, importSource, client, promptable, dryRun } = a;
    const values = await guard(() => resolveEnvValues(client, source.project.id, source.teamId, source.importable));
    if (!values.ok) return values;
    const fullCandidates = values.value.entries.map((e) => ({ name: e.record.key, value: e.value }));
    // A name Vercel HAS but will not show us (sensitive, scoped, empty, …) is
    // never cleared locally just because it is unreadable.
    const protectedNames = [...source.skipped, ...values.value.empty].map((s) => s.name);
    const plan = computeOverwritePlan(fullCandidates, protectedNames, ctx.localPlaintext);
    const warnings = truncationWarnings(source);

    const hasWrite = plan.toClear.length > 0 || plan.toReplace.length > 0 || plan.toImport.length > 0;
    if (!dryRun && hasWrite) {
      if (promptable && !opts.yes) {
        const proceed = await confirm(overwriteConfirmMessage(plan), false);
        if (!proceed) {
          return { ok: true, source: importSource, imported: [], cleared: [], replacedNames: [], unchanged: plan.unchanged, skipped: [], warnings, deployTargetSaved: false };
        }
      } else if (!promptable && !opts.yes) {
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        return { ok: false, code: ERROR_CODES.VERCEL_CONFIRMATION_REQUIRED, message: 'Pass --yes to overwrite non-interactively, or run this interactively.' };
      }
    }

    const importedAt = now().toISOString();
    const createdAtSec = Math.floor(now().getTime() / 1000);
    const recordByName = new Map(values.value.entries.map((e) => [e.record.key, e.record] as const));
    const entryFor = (name: string, value: string) => importedEntry(recordByName.get(name)!, name, value, source, createdAtSec, importedAt);
    const written = [...plan.toImport, ...plan.toReplace].map(({ name, value }) => entryFor(name, value));
    const unchangedEntries = plan.unchanged.map((name) => entryFor(name, fullCandidates.find((c) => c.name === name)!.value));
    return {
      ok: true,
      source: importSource,
      imported: written,
      cleared: plan.toClear,
      replacedNames: plan.toReplace.map((e) => e.name),
      unchanged: plan.unchanged,
      unchangedEntries,
      // The names Vercel has but will not show are reported here too: an
      // overwrite leaves them alone, and saying so is the point of the list.
      skipped: [...source.skipped, ...values.value.empty].map(toImportSkip),
      warnings,
      deployTargetSaved: false,
      ...(await plannedTargets(opts, source, [...written.map((w) => w.varName), ...plan.unchanged], dryRun)),
    };
  };

  /** Everything after the client exists: read the source, plan, classify, return the outcome. */
  const importFrom = async (ctx: ResolvedContext, opts: ConnectOpts, client: VercelClient, interactive: boolean): Promise<ImportOutcome> => {
    // A dry run changes nothing; `--json` never has a prompt interleaved.
    const dryRun = !!opts.dryRun;
    const promptable = interactive && !opts.json;

    const source = await readSource(client, ctx, opts, promptable);
    if (!source.ok) return source;

    const importSource: VercelImportSource = {
      kind: 'vercel',
      projectId: source.project.id,
      projectName: source.project.name,
      ...(source.teamId ? { teamId: source.teamId } : {}),
      environment: source.environment.name,
    };

    if (opts.overwrite) {
      return runOverwriteImport({ ctx, opts, source, importSource, client, promptable, dryRun });
    }

    const restrict = parseVarList(opts.var);
    const restricted = source.importable.filter((r) => !restrict || restrict.includes(r.key));
    const values = await guard(() => resolveEnvValues(client, source.project.id, source.teamId, restricted));
    if (!values.ok) return values;
    const candidates = values.value.entries.map((e) => ({ name: e.record.key, value: e.value }));

    // A dry run previews the WHOLE plan rather than a hand-picked subset.
    const selectedNames = restrict || !promptable || dryRun ? candidates.map((c) => c.name) : await selectVars(candidates.map((c) => c.name));
    const selected = candidates.filter((c) => selectedNames.includes(c.name));

    const { unchanged, skipped: conflictSkipped, toImport, wouldAsk } = await classifyImportCandidates(selected, ctx.localPlaintext, {
      dryRun,
      interactive: promptable,
      confirm,
      providerLabel: 'Vercel',
    });

    const importedAt = now().toISOString();
    const createdAtSec = Math.floor(now().getTime() / 1000);
    const recordByName = new Map(values.value.entries.map((e) => [e.record.key, e.record] as const));
    const entryFor = (name: string, value: string) => importedEntry(recordByName.get(name)!, name, value, source, createdAtSec, importedAt);
    const imported = toImport.map(({ name, value }) => entryFor(name, value));
    // A re-import over a name whose value already matches still refreshes
    // its connector metadata — never populated under a dry run.
    const unchangedEntries = dryRun ? [] : unchanged.map((name) => entryFor(name, selected.find((c) => c.name === name)!.value));

    const inScope = (name: string): boolean => !restrict || restrict.includes(name);
    const skipped: readonly ImportSkip[] = [
      ...[...source.skipped, ...values.value.empty].filter((s) => inScope(s.name)).map(toImportSkip),
      ...conflictSkipped,
    ];

    const importedNames = [...imported.map((i) => i.varName), ...unchanged];
    const dir = opts.projectDir ?? cwd();
    // `--targets` writes without asking; otherwise the target is only offered, and only interactively.
    const planned = await plannedTargets(opts, source, importedNames, dryRun);
    const deployTargetSaved =
      !dryRun &&
      !opts.targets &&
      (await maybeOfferDeployTarget({
        importedNames,
        project: source.project,
        teamId: source.teamId,
        environment: source.environment,
        allTargets: await listTargetsAt(dir),
        promptable,
        dir,
        confirm,
      }));

    return {
      ok: true,
      source: importSource,
      imported,
      unchanged,
      unchangedEntries,
      skipped,
      warnings: truncationWarnings(source),
      deployTargetSaved,
      ...planned,
      ...(dryRun ? { wouldAsk } : {}),
    };
  };

  /** `--targets` under `--dry-run`: the target each plan environment would get, by folder. Names only. */
  const plannedTargetsFor = async (folders: readonly DiscoveryPlanFolder[]): Promise<readonly DiscoveryDeployTarget[]> => {
    const perFolder = await Promise.all(
      folders.map(async (f) => {
        const existing = await listTargetsAt(f.folder ? join(f.repoDir, f.folder) : f.repoDir);
        return orderEnvironments(f.environments).flatMap((e): readonly DiscoveryDeployTarget[] => {
          const name = e.variableCount > 0 ? newTargetName(existing, e.serviceId, e.environmentName) : null;
          return name === null ? [] : [{ repoDir: f.repoDir, folder: f.folder, branch: e.environmentName, name, written: false }];
        });
      }),
    );
    return perFolder.flat();
  };

  /** Everything after the client exists: resolve the team, build the plan, apply it. */
  const discoverFrom = async (
    ctx: DiscoveryContext,
    opts: ConnectOpts,
    client: VercelClient,
    tokenEnv: string,
    interactive: boolean,
  ): Promise<DiscoveryOutcome> => {
    const dryRun = !!opts.dryRun;
    const promptable = interactive && !opts.json;

    const team = await chooseTeam(client, opts, promptable);
    if (!team.ok) return team;

    const scan = findCandidateReposResult(cwd());
    const environmentFilter = parseVarList(opts.environment) ?? undefined;
    const built = await guard(() =>
      buildVercelDiscoveryPlan(
        client,
        team.teamId,
        scan.repos as readonly CandidateRepo[],
        { peekLocalKeep: peekLocalKeepForFolder, listServerBranches: (projectId) => ctx.serviceClient.listBranches(projectId) },
        environmentFilter,
      ),
    );
    if (!built.ok) return built;
    const plan: DiscoveryPlan = {
      ...built.value,
      unreadableRepos: scan.unreadable,
      ...(team.teamId ? { team: { id: team.teamId, ...(team.teamSlug ? { slug: team.teamSlug } : {}) } } : {}),
    };

    if (environmentFilter) {
      const unknown = environmentFilter.filter((name) => !plan.allEnvironmentNames.includes(name));
      if (unknown.length > 0) {
        return {
          ok: false,
          code: ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND,
          // COPY-FLAG: new user-facing string, minimal/neutral wording.
          message: `No such environment(s): ${unknown.join(', ')}. Environments found: ${plan.allEnvironmentNames.join(', ') || '(none)'}.`,
        };
      }
    }

    if (dryRun) {
      // A dry run never asks for a branch name either; the DEFAULT is what it previews.
      // `--targets`: the targets it would write are listed, and their file is part of the previewed commit.
      const targets = opts.targets ? await plannedTargetsFor(plan.folders) : [];
      const hasTargets = (folder: DiscoveryPlanFolder): boolean => targets.some((t) => t.repoDir === folder.repoDir && t.folder === folder.folder);
      const commits = commitPreviewForFolders(plan.folders, defaultDiscoveryCommitBranchName(new Date(), 'vercel'), VERCEL_COMMIT_MESSAGE, hasTargets);
      return { ok: true, dryRun: true, plan, ...(commits.length > 0 ? { commits } : {}), ...(opts.targets ? { deployTargets: targets } : {}) };
    }

    // `--project` under `--discover` is the collision-winner hint (an id or a name), not an import source.
    const preferredServiceId = preferredProjectId(plan, opts.project);
    const resolution = await resolveCollisions(orderEnvironments(plan.collisions), {
      preferredServiceId,
      interactive: promptable,
      askWinner: pickCollisionWinner,
    });
    if (!resolution.ok) {
      return {
        ok: false,
        code: ERROR_CODES.VERCEL_MAPPING_COLLISION,
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        message: 'Several Vercel projects map to the same folder + branch. Pass --project to pick one, or run this interactively.',
      };
    }

    const resolvedFolders = applyCollisionResolutions(plan.folders, resolution.resolutions);
    if (resolvedFolders.length === 0) return { ok: true, dryRun: false, plan, applied: [] };

    // A real run never writes without a yes: `--yes` skips the ask regardless of TTY.
    if (promptable && !opts.yes) {
      const proceed = await confirm(discoveryConfirmMessage(resolvedFolders, !!opts.overwrite, environmentFilter), false);
      if (!proceed) return { ok: true, dryRun: false, plan, applied: [], cancelled: true };
    } else if (!promptable && !opts.yes) {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      return { ok: false, code: ERROR_CODES.VERCEL_CONFIRMATION_REQUIRED, message: 'Pass --yes to apply non-interactively, or run this interactively.' };
    }

    const commitBranchName =
      promptable && !opts.yes
        ? await askDiscoveryCommitBranchName(defaultDiscoveryCommitBranchName(new Date(), 'vercel'))
        : defaultDiscoveryCommitBranchName(new Date(), 'vercel');

    // Snapshotted BEFORE any write, per repo, so the commit step can tell
    // "discovery made this change" from "already dirty before the run".
    const beforeStatusByRepo = new Map(
      [...new Set(resolvedFolders.map((f) => f.repoDir))].map((repoDir) => {
        const paths = resolvedFolders.filter((f) => f.repoDir === repoDir).flatMap((f) => discoveryCommitPathsFor(f.folder, { deployConfig: !!opts.targets }));
        return [repoDir, snapshotPathStatus(repoDir, paths)] as const;
      }),
    );

    // Same snapshot-once rule as Dokploy's non-interactive `--yes` auto-create.
    const existingProjectsSnapshot: ExistingProjectsSnapshot | undefined =
      !promptable && !!opts.yes ? await listOrgProjectsOrUnavailable(ctx.serviceClient) : undefined;
    const sameRunNameCollisions: ReadonlySet<string> = !promptable && !!opts.yes ? computeSameRunNameCollisions(resolvedFolders) : new Set();

    const sequenceDeps = buildRealDiscoverySequenceDeps(ctx, connector.import!, {
      noPush: !!opts.noPush,
      interactive: promptable,
      json: !!opts.json,
      yes: !!opts.yes,
      baseUrl: '',
      tokenEnv,
      importOptsFor: (env, projectName, folderPath) => ({
        project: env.serviceId,
        vercelProject: { id: env.serviceId, name: projectName, ...(env.gitBranch ? { productionBranch: env.gitBranch } : {}) },
        vercelTeam: { id: team.teamId },
        environment: env.environmentName,
        tokenEnv,
        projectDir: folderPath,
        ...(opts.targets ? { targets: true } : {}),
      }),
      askExistingOrNewProject,
      askProjectName: askDiscoveryProjectName,
      existingProjectsSnapshot,
      sameRunNameCollisions,
    });
    const applied = await runDiscoverySequences(resolvedFolders, { overwrite: !!opts.overwrite }, sequenceDeps);
    // `--targets`: a folder that wrote a deploy target commits its `.capy/deploy.json` with its keep.lock.
    const wroteTarget = (folder: DiscoveryFolderResult): boolean => folder.environments.some((e) => e.outcome.deployTarget?.written === true);
    const commits = commitForAppliedRepos(applied, beforeStatusByRepo, commitBranchName, VERCEL_COMMIT_MESSAGE, wroteTarget);
    return { ok: true, dryRun: false, plan, applied, ...(commits.length > 0 ? { commits } : {}) };
  };

  const connector: ConnectorModule = {
    name: 'vercel',
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    description: 'One-time import of env vars from a Vercel project',
    kind: 'import',
    displayName: 'Vercel',

    // Never reached: `connectCommand.ts` routes `kind === 'import'` to import().
    async connect(): Promise<ConnectResult> {
      throw new Error('vercel is import-only; connectCommand should have routed to import() instead.');
    },
    async rotate(): Promise<RotateResult> {
      throw new Error('vercel is import-only; rotateCommand should have refused before calling rotate().');
    },

    async import(ctx: ResolvedContext, opts: ConnectOpts): Promise<ImportOutcome> {
      const interactive = isInteractive(opts.nonTty);

      const opened = await openClient(ctx.orgId, opts, interactive);
      if (!opened.ok) return opened;

      const outcome = await importFrom(ctx, opts, opened.client, interactive);
      return withTokenHelp(outcome, opts);
    },

    /**
     * `capy connect vercel --discover`: find every Vercel project whose git
     * link matches a repo reachable from `cwd`, then run Dokploy discovery's
     * own sequence (`runDiscoverySequences`) over the plan. See
     * `vercelDiscovery.ts`.
     */
    async discover(ctx: DiscoveryContext, opts: ConnectOpts): Promise<DiscoveryOutcome> {
      const interactive = isInteractive(opts.nonTty);

      const opened = await openClient(ctx.orgId, opts, interactive);
      if (!opened.ok) return opened;

      const outcome = await discoverFrom(ctx, opts, opened.client, opened.tokenEnv, interactive);
      return withTokenHelp(outcome, opts);
    },

    reportDiscovery: reportVercelDiscovery,
  };
  return connector;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** A token Vercel rejected: say where to get another. (A missing token already carries it, from `openClient`.) */
function withTokenHelp<T extends ImportOutcome | DiscoveryOutcome>(outcome: T, opts: ConnectOpts): T {
  if (outcome.ok || outcome.link || outcome.code !== ERROR_CODES.VERCEL_AUTH_FAILED) return outcome;
  return { ...outcome, ...keyHelpFields(vercelKeyHelp(VERCEL_CONNECTOR_SECRET_NAME, { team: opts.team })) } as T;
}


async function listTargetsAt(dir: string): Promise<readonly TargetConfig[]> {
  const { listTargets } = await import('../../deploy/config');
  return listTargets(dir);
}

const toImportSkip = (s: VercelSkippedRecord): ImportSkip => ({ name: s.name, code: s.reason, ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}) });

function truncationWarnings(source: SourceRead): readonly ImportWarning[] {
  // The env list documents no paging parameter, so a "next page" it reports cannot be fetched: say so rather than import silently partial.
  return source.truncated ? [{ code: 'VERCEL_ENV_LIST_TRUNCATED', names: [] }] : [];
}

function importedEntry(
  record: VercelEnvRecord,
  name: string,
  value: string,
  source: SourceRead,
  createdAtSec: number,
  importedAt: string,
): { varName: string; value: string; entry: ConnectorMetadata } {
  return {
    varName: name,
    value,
    entry: buildVercelConnectorEntry(record, value, {
      project: source.project,
      teamId: source.teamId,
      environment: source.environment.name,
      createdAtSec,
      importedAt,
    }),
  };
}

/** `--project` (id or name) → the id of a project in the plan, else the raw value. */
function preferredProjectId(plan: DiscoveryPlan, project: string | undefined): string | undefined {
  const want = project?.trim();
  if (!want) return undefined;
  const ids = plan.folders.flatMap((f) => f.environments.map((e) => ({ id: e.serviceId, name: f.projectName })));
  return ids.find((p) => p.id === want || p.name === want)?.id ?? want;
}

/**
 * The `capy connect vercel` production instance — the only place this file
 * wires the org system store for real (every other construction, including
 * every test, gets the safe env-only default — see `VercelConnectorDeps`).
 */
export const vercelConnector: ConnectorModule = createVercelConnector({
  getConnectorSecret: async (name, opts) => {
    // Import's own direction: `_CONNECTOR_VERCEL_TOKEN`, borrowing from
    // `_TARGET_VERCEL_TOKEN` (the deploy side) the same way Dokploy's does.
    const { getDirectionalConnectorSecret } = await import('../../system/systemStore');
    return getDirectionalConnectorSecret(name, VERCEL_TARGET_SECRET_NAME, {
      ...opts,
      missingWithFallbackCode: ERROR_CODES.VERCEL_CONNECTOR_KEY_MISSING,
    });
  },
});
