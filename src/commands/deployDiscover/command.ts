/**
 * `capy deploy dokploy --discover` (CAP-703): create Dokploy deploy targets for
 * the services that match Capy projects, and push NO values.
 *
 * "Connect is for retrieval, target is for deploy": `capy connect dokploy
 * --discover` imports values and never touches a target; this command writes
 * targets and never touches a value.
 *
 * ALWAYS prints one JSON document on stdout (exactly what `--json` would
 * print), in a terminal or not. It never prompts and never opens a browser:
 * progress goes to stderr, every choice is a flag or a coded refusal. The
 * agent applies judgement, the human approves, this command checks and writes.
 *
 *   capy deploy dokploy --discover                              facts: services, projects, proposals
 *   capy deploy dokploy --discover --plan f.json --dry-run      validate the plan, change nothing
 *   capy deploy dokploy --discover --plan f.json --confirm ID   write deploy.json: ONE PR per repo
 *
 * The Capy service limits `/orgs` calls (30 a minute), so a run makes ONE
 * call for the repo links and ONE for the secret NAME index, however many
 * projects and services there are. GitHub is read in batches (one GraphQL
 * call for every default branch) and the rest is one read per repo.
 *
 * Names and ids only, everywhere. No Dokploy value and no Capy value is read,
 * printed or sent: the only things taken out of a Dokploy env are its names.
 *
 * Server-side recording: `capy deploy` records a target's DELIVERY in the
 * server's keep.lock (`recordDeployTargets`), after a delivery or a
 * `--no-deploy` run, and that needs the variables' value hashes. Writing a
 * target here delivers nothing, so there is nothing to record; the record
 * appears when the target is first run with `capy deploy <target>` (a
 * `--no-deploy` run records it as pending). The target exists in git first.
 */
import { ERROR_CODES } from '../../types/index';
import type { OrgRepoLink, OrgReposResponse, SecretIndexResponse, ServiceClient } from '../../service/serviceClient';
import { CapyError } from '../../types/index';
import { callWithBackoff } from '../../service/capyCalls';
import {
  DEFAULT_TOKEN_ENV,
  DOKPLOY_CONNECTOR_SECRET_NAME,
  DokployApiError,
  DokploySystemStoreCallOptions,
  describeDokployTokenProblem,
  resolveDokployApiKey,
} from '../../deploy/dokployApi';
import { BaseUrlNotice, BaseUrlStore, resolveDokployBaseUrl } from '../../deploy/dokployBaseUrl';
import type { GithubApi, RepoRef } from '../../deploy/githubApi';
import { codeForApiFailure } from '../keepLockPr';
import { runPool } from '../../utils/pool';
import { DiscoveryDokployClient, fetchAllServiceDetails } from '../connectors/dokployDiscovery';
import { applyTargets } from './apply';
import {
  DeployDiscovery,
  DiscoveryInput,
  Notice,
  PlanEntry,
  buildDeployDiscovery,
} from './discovery';
import {
  CapyProjectFacts,
  ExistingTarget,
  ServiceFacts,
  byText,
  capyProjectsOf,
  deployJsonPathOf,
  parseDeployJson,
  repoKey,
  serviceFactsOf,
  uniqueSorted,
} from './facts';
import {
  EvaluatedEntry,
  GithubReads,
  ReadFailure,
  evaluatePlan,
  fileKeyOf,
  githubNeeds,
  repoRefOf,
  resolveEntries,
  targetsToWrite,
} from './evaluate';
import {
  Plan,
  PlanError,
  alreadyConfiguredLine,
  normalizePlan,
  planEntriesOf,
  planIdOf,
  planShapeErrors,
  summaryLine,
} from './plan';
import { sortedCopy } from '../../deploy/dokployApi';

// ── Seams ────────────────────────────────────────────────────────────────────

export interface DeployDiscoverOpts {
  /** The program-level `--dry-run`. */
  readonly dryRun?: boolean;
  /** `--plan <file>` */
  readonly plan?: string;
  /** `--confirm <plan_id>` */
  readonly confirm?: string;
  /** `--base-url <url>` */
  readonly baseUrl?: string;
}

export type CapyReads = Pick<ServiceClient, 'getOrgRepos' | 'getSecretIndex'>;

export type ContextResult =
  | { readonly ok: true; readonly orgId: string; readonly client: CapyReads }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Everything external, injected: tests pass fakes; `realDeployDiscoverIo` builds the real one. */
export interface DeployDiscoverIo {
  readonly devMode: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The base URL of a Dokploy target already saved in this folder's deploy.json (the third place the shared resolver looks). */
  readonly savedBaseUrl: () => string | undefined;
  /** Opens the org system store for the Dokploy base URL variable. Absent: the variable is not consulted. Rejects with a coded error for a non-admin. */
  readonly openBaseUrlStore?: (orgId: string) => Promise<BaseUrlStore>;
  /** Reads the plan file; throws when it cannot. */
  readonly readFile: (path: string) => string;
  /** Silent auth only: never a prompt, never a browser. */
  readonly context: () => Promise<ContextResult>;
  /** The org system store read for the Dokploy key. */
  readonly getConnectorSecret: (name: string, opts: DokploySystemStoreCallOptions) => Promise<string | null>;
  readonly dokploy: (baseUrl: string, token: string) => DiscoveryDokployClient;
  /** `undefined` when `gh` is not installed. */
  readonly github: () => GithubApi | undefined;
  readonly branchName: () => string;
  /** Progress, for stderr. Never stdout. */
  readonly progress: (line: string) => void;
}

export interface DeployDiscoverResult {
  readonly exitCode: number;
  /** The one JSON document the command prints. */
  readonly body: Readonly<Record<string, unknown>>;
}

/** Exit code for a refusal that needs a different invocation (the plan to confirm), not a retry. */
const EXIT_NEEDS_INPUT = 3;

function refuse(code: string, error: string, extra: Readonly<Record<string, unknown>> = {}): DeployDiscoverResult {
  return {
    exitCode: code === ERROR_CODES.PLAN_CONFIRM_REQUIRED || code === 'DOKPLOY_SETTINGS_MISSING' ? EXIT_NEEDS_INPUT : 1,
    body: { ok: false, code, error, ...extra },
  };
}

type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: DeployDiscoverResult };

const done = <T>(value: T): Step<T> => ({ ok: true, value });
const stop = (result: DeployDiscoverResult): Step<never> => ({ ok: false, result });

const codeOfError = (err: unknown): { readonly code: string; readonly message: string } =>
  err instanceof CapyError
    ? { code: err.code, message: err.message }
    : { code: ERROR_CODES.SERVICE_ERROR, message: 'The service request failed.' }; // COPY-FLAG

// ── Settings ─────────────────────────────────────────────────────────────────

/** What resolving the base URL leaves for the output: whether it was saved, and the notices. */
interface BaseUrlExtras {
  readonly saved?: { readonly base_url: true };
  readonly notices: readonly BaseUrlNotice[];
}

/** The shared resolver (`deploy/dokployBaseUrl.ts`): `--base-url`, then the system variable, then the folder's deploy.json, else a structured refusal. */
async function resolveBaseUrl(
  opts: DeployDiscoverOpts,
  io: DeployDiscoverIo,
  orgId: string,
): Promise<Step<{ readonly baseUrl: string; readonly extras: BaseUrlExtras }>> {
  const openStore = io.openBaseUrlStore;
  const resolved = await resolveDokployBaseUrl({
    flag: opts.baseUrl,
    dryRun: opts.dryRun === true,
    openStore: openStore === undefined ? undefined : () => openStore(orgId),
    savedTargetUrl: io.savedBaseUrl,
  });
  if (!resolved.ok) {
    return stop(refuse(resolved.code, resolved.error, resolved.unanswered === undefined ? {} : { unanswered: resolved.unanswered }));
  }
  return done({ baseUrl: resolved.baseUrl, extras: { saved: resolved.saved, notices: resolved.notices } });
}

const extrasBody = (extras: BaseUrlExtras): Readonly<Record<string, unknown>> => ({
  ...(extras.saved === undefined ? {} : { saved: extras.saved }),
  ...(extras.notices.length === 0 ? {} : { notices: extras.notices }),
});

// ── The world: Dokploy, Capy ─────────────────────────────────────────────────

interface World {
  readonly orgId: string;
  readonly services: readonly ServiceFacts[];
  readonly links: readonly OrgRepoLink[];
  readonly projects: ReadonlyMap<string, CapyProjectFacts>;
}

async function dokployClient(io: DeployDiscoverIo, baseUrl: string, orgId: string): Promise<Step<DiscoveryDokployClient>> {
  const resolved = await resolveDokployApiKey({
    tokenEnv: DEFAULT_TOKEN_ENV,
    env: io.env,
    // Never a prompt: a missing key is a coded refusal that says where to get it.
    interactive: false,
    orgId,
    devMode: io.devMode,
    storeName: DOKPLOY_CONNECTOR_SECRET_NAME,
    deps: { getConnectorSecret: io.getConnectorSecret },
  });
  if (!resolved.ok) {
    const { reason, hint } = describeDokployTokenProblem(resolved.code, DEFAULT_TOKEN_ENV, DOKPLOY_CONNECTOR_SECRET_NAME);
    return stop(refuse(resolved.code, `${reason}.`, { hint, dashboard: baseUrl }));
  }
  return done(io.dokploy(baseUrl, resolved.value));
}

function dokployFailure(err: unknown): DeployDiscoverResult {
  if (err instanceof DokployApiError) {
    return err.code === 'unauthorized'
      ? refuse('DOKPLOY_AUTH_FAILED', `Dokploy rejected the API token (HTTP ${err.status}).`) // COPY-FLAG
      : refuse('DOKPLOY_API_ERROR', err.message);
  }
  return refuse('DOKPLOY_API_ERROR', 'The Dokploy request failed.'); // COPY-FLAG
}

/** A Capy call that waits out a 429 (bounded) and reports a failure as its code. */
async function capyCall<T>(call: () => Promise<T>): Promise<Step<T>> {
  const answer = await callWithBackoff(() => call());
  if (answer.ok) return done(answer.value);
  const { code, message } = codeOfError(answer.error);
  return stop(refuse(code, message));
}

async function loadWorld(
  io: DeployDiscoverIo,
  client: CapyReads,
  orgId: string,
  dokploy: DiscoveryDokployClient,
  only?: ReadonlySet<string>,
): Promise<Step<World>> {
  io.progress('Reading Dokploy services…'); // COPY-FLAG
  const details = await fetchAllServiceDetails(
    dokploy,
    (readCount, total) => {
      if (readCount === total || readCount % 10 === 0) io.progress(`Read ${readCount} of ${total} Dokploy services`); // COPY-FLAG
    },
    only,
  ).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  if (!details.ok) return stop(dokployFailure(details.err));

  // ONE call each, however many projects there are: the service limits /orgs.
  io.progress('Reading Capy projects…'); // COPY-FLAG
  const repos = await capyCall<OrgReposResponse>(() => client.getOrgRepos(orgId));
  if (!repos.ok) return repos;
  const index = await capyCall<SecretIndexResponse>(() => client.getSecretIndex(orgId));
  if (!index.ok) return index;
  return done({
    orgId,
    services: details.value.map(serviceFactsOf),
    links: repos.value.repos,
    projects: capyProjectsOf(repos.value.repos, index.value.rows),
  });
}

// ── GitHub reads ─────────────────────────────────────────────────────────────

const GITHUB_CONCURRENCY = 4;

/** `fn` over `items`, a few at a time, results in input order. `fn` must not reject. */
async function readEach<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<readonly R[]> {
  const pooled = await runPool({ items, limit: GITHUB_CONCURRENCY, run: async (item) => ({ result: await fn(item) }) });
  return pooled.results;
}

const refKey = (repo: RepoRef): string => `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;

/** The default branch of each repo, or the code of why they could not be read. Keyed by `refKey`. */
async function readDefaultBranches(
  github: GithubApi,
  repos: readonly RepoRef[],
): Promise<{ readonly ok: true; readonly branches: ReadonlyMap<string, string | null> } | { readonly ok: false; readonly code: string }> {
  if (repos.length === 0) return { ok: true, branches: new Map() };
  const answer = await github.getDefaultBranches(repos);
  if (!answer.ok) return { ok: false, code: codeForApiFailure(answer, ERROR_CODES.KEEP_PR_BASE_UNRESOLVED) };
  return { ok: true, branches: new Map(repos.map((r, i): [string, string | null] => [refKey(r), answer.value[i] ?? null])) };
}

/** A deploy.json at `ref`: its targets, or the code of why it could not be read. */
async function readDeployJson(
  github: GithubApi,
  repo: RepoRef,
  path: string,
  ref: string,
): Promise<readonly ExistingTarget[] | ReadFailure> {
  const read = await github.getFile(repo, path, ref);
  if (!read.ok) return { code: codeForApiFailure(read, ERROR_CODES.KEEP_PR_READ_FAILED) };
  const parsed = parseDeployJson(read.value);
  return parsed.ok ? parsed.targets : { code: ERROR_CODES.KEEP_PR_READ_FAILED };
}

const isFailure = (v: readonly ExistingTarget[] | ReadFailure): v is ReadFailure => !Array.isArray(v);

// ── Discovery ────────────────────────────────────────────────────────────────

/** Default branches and deploy.json targets for the repos some Dokploy service tracks. */
async function discoveryGithubFacts(
  io: DeployDiscoverIo,
  world: World,
): Promise<{
  readonly defaultBranches: Readonly<Record<string, string | null>>;
  readonly existingTargets: Readonly<Record<string, readonly ExistingTarget[]>>;
  readonly notices: readonly Notice[];
}> {
  const serviceRepoKeys = new Set(world.services.flatMap((s) => (s.repo === null ? [] : [repoKey(s.repo)])));
  const links = world.links.filter((l) => serviceRepoKeys.has(repoKey(l)));
  if (links.length === 0) return { defaultBranches: {}, existingTargets: {}, notices: [] };
  const github = io.github();
  if (github === undefined) {
    return { defaultBranches: {}, existingTargets: {}, notices: [{ code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE }] };
  }
  io.progress('Reading GitHub…'); // COPY-FLAG
  const repos = uniqueSorted(links.map(repoKey)).map((k) => repoRefOf(links.find((l) => repoKey(l) === k) as OrgRepoLink));
  const defaults = await readDefaultBranches(github, repos);
  if (!defaults.ok) return { defaultBranches: {}, existingTargets: {}, notices: [{ code: defaults.code }] };
  const defaultBranches = Object.fromEntries(
    uniqueSorted(links.map(repoKey)).map((k) => [k, defaults.branches.get(refKey(repoRefOf(links.find((l) => repoKey(l) === k) as OrgRepoLink))) ?? null]),
  );
  const fileKeys = uniqueSorted(links.map(fileKeyOf));
  const reads = await readEach(fileKeys, async (key) => {
    const link = links.find((l) => fileKeyOf(l) === key) as OrgRepoLink;
    const ref = defaultBranches[repoKey(link)];
    return { key, targets: ref === null ? ({ code: ERROR_CODES.KEEP_PR_BASE_UNRESOLVED } as ReadFailure) : await readDeployJson(github, repoRefOf(link), deployJsonPathOf(link.path), ref) };
  });
  const byFile = new Map(reads.map((r) => [r.key, r.targets] as const));
  // A project's targets are known only when EVERY one of its deploy.json files was read.
  const projectIds = uniqueSorted(links.map((l) => l.project_id));
  const existingTargets = Object.fromEntries(
    projectIds.flatMap((id): Array<[string, readonly ExistingTarget[]]> => {
      const mine = links.filter((l) => l.project_id === id).map((l) => byFile.get(fileKeyOf(l)));
      return mine.every((t) => t !== undefined && !isFailure(t))
        ? [[id, mine.flatMap((t) => (t === undefined || isFailure(t) ? [] : t))]]
        : [];
    }),
  );
  const failures = uniqueSorted(reads.flatMap((r) => (isFailure(r.targets) ? [r.targets.code] : [])));
  return { defaultBranches, existingTargets, notices: failures.map((code) => ({ code })) };
}

async function runDiscovery(opts: DeployDiscoverOpts, io: DeployDiscoverIo): Promise<DeployDiscoverResult> {
  const ctx = await io.context();
  if (!ctx.ok) return refuse(ctx.code, ctx.message);
  const base = await resolveBaseUrl(opts, io, ctx.orgId);
  if (!base.ok) return base.result;
  const { baseUrl, extras } = base.value;
  const dokploy = await dokployClient(io, baseUrl, ctx.orgId);
  if (!dokploy.ok) return dokploy.result;
  const world = await loadWorld(io, ctx.client, ctx.orgId, dokploy.value);
  if (!world.ok) return world.result;
  const github = await discoveryGithubFacts(io, world.value);
  const input: DiscoveryInput = {
    baseUrl,
    services: world.value.services,
    projects: world.value.projects,
    defaultBranches: github.defaultBranches,
    existingTargets: github.existingTargets,
    notices: [...extras.notices, ...github.notices],
  };
  const discovery: DeployDiscovery = buildDeployDiscovery(input);
  return { exitCode: 0, body: { ok: true, ...(extras.saved === undefined ? {} : { saved: extras.saved }), ...discovery } };
}

// ── The plan ─────────────────────────────────────────────────────────────────

interface ParsedPlan {
  readonly entries: readonly PlanEntry[];
  readonly plan: Plan;
}

function readPlan(opts: DeployDiscoverOpts, io: DeployDiscoverIo): Step<ParsedPlan> {
  const text = (() => {
    try {
      return { ok: true as const, text: io.readFile(opts.plan as string) };
    } catch {
      return { ok: false as const };
    }
  })();
  if (!text.ok) return stop(refuse(ERROR_CODES.PLAN_FILE_UNREADABLE, 'The plan file could not be read.')); // COPY-FLAG
  const raw = (() => {
    try {
      return { ok: true as const, value: JSON.parse(text.text) as unknown };
    } catch {
      return { ok: false as const };
    }
  })();
  const errors: readonly PlanError[] = raw.ok ? planShapeErrors(raw.value) : [{ path: '', code: ERROR_CODES.INVALID_FORMAT }];
  if (!raw.ok || errors.length > 0) return stop(invalidPlan(errors));
  const entries = planEntriesOf(raw.value);
  const plan = normalizePlan(entries);
  return done({ entries, plan });
}

function invalidPlan(errors: readonly PlanError[], extra: Readonly<Record<string, unknown>> = {}): DeployDiscoverResult {
  return refuse(ERROR_CODES.PLAN_INVALID, 'The plan has errors. Nothing was changed.', { errors, ...extra }); // COPY-FLAG
}

/** GitHub reads a plan needs: each repo's branches, each deploy.json at its repo's default branch. */
async function planGithubReads(io: DeployDiscoverIo, needs: ReturnType<typeof githubNeeds>): Promise<GithubReads & { readonly defaultBranches: ReadonlyMap<string, string | null> }> {
  const github = io.github();
  const unavailable: ReadFailure = { code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE };
  if (github === undefined || needs.repos.length === 0) {
    return {
      branches: new Map(needs.repos.map((r): [string, ReadFailure] => [r.key, unavailable])),
      deployJson: new Map(needs.files.map((f): [string, ReadFailure] => [f.key, unavailable])),
      defaultBranches: new Map(),
    };
  }
  io.progress('Reading GitHub…'); // COPY-FLAG
  const defaults = await readDefaultBranches(github, needs.repos.map((r) => r.repo));
  const defaultBranches = defaults.ok ? defaults.branches : new Map<string, string | null>();
  const branchReads = await readEach(needs.repos, async ({ repo, key }) => {
    const listed = await github.listBranches(repo);
    return [key, listed.ok ? (new Set(listed.value) as ReadonlySet<string>) : { code: codeForApiFailure(listed, ERROR_CODES.KEEP_PR_READ_FAILED) }] as const;
  });
  const fileReads = await readEach(needs.files, async (file) => {
    const ref = defaults.ok ? defaultBranches.get(refKey(file.repo)) : undefined;
    const targets: readonly ExistingTarget[] | ReadFailure =
      ref === undefined || ref === null
        ? { code: defaults.ok ? ERROR_CODES.KEEP_PR_BASE_UNRESOLVED : defaults.code }
        : await readDeployJson(github, file.repo, file.path, ref);
    return [file.key, targets] as const;
  });
  return { branches: new Map(branchReads), deployJson: new Map(fileReads), defaultBranches };
}

function summaryOf(evaluated: readonly EvaluatedEntry[]): readonly string[] {
  const sorted = sortedCopy(
    evaluated,
    (a, b) =>
      byText(a.resolved.entry.project_id, b.resolved.entry.project_id) ||
      byText(a.resolved.entry.branch, b.resolved.entry.branch) ||
      byText(a.resolved.entry.service_id, b.resolved.entry.service_id),
  );
  return sorted.map((e) => {
    const { project, service, entry } = e.resolved;
    const normalized: PlanEntry = { ...entry, vars: uniqueSorted(entry.vars) };
    return e.status === 'already_configured'
      ? alreadyConfiguredLine({ project_name: project.project_name, entry: normalized, target_name: e.existingTargetName ?? '' })
      : summaryLine({ project_name: project.project_name, kind: service.kind, entry: normalized });
  });
}

async function runPlan(opts: DeployDiscoverOpts, io: DeployDiscoverIo, parsed: ParsedPlan): Promise<DeployDiscoverResult> {
  const { entries, plan } = parsed;
  const confirming = opts.confirm !== undefined && opts.dryRun !== true;

  const ctx = await io.context();
  if (!ctx.ok) return refuse(ctx.code, ctx.message);
  const base = await resolveBaseUrl(opts, io, ctx.orgId);
  if (!base.ok) return base.result;
  const { baseUrl, extras } = base.value;
  // The id covers the RESOLVED URL, so a dry run and its confirm agree wherever the URL came from.
  const planId = planIdOf(plan, baseUrl);
  // A plan that moved since it was confirmed: nothing more is looked up, nothing is done.
  if (confirming && opts.confirm !== planId) {
    return refuse(ERROR_CODES.PLAN_CHANGED, 'The plan is not the one that was confirmed. Nothing was changed.', { plan_id: planId, plan }); // COPY-FLAG
  }

  const dokploy = await dokployClient(io, baseUrl, ctx.orgId);
  if (!dokploy.ok) return dokploy.result;
  const world = await loadWorld(io, ctx.client, ctx.orgId, dokploy.value, new Set(entries.map((e) => e.service_id)));
  if (!world.ok) return world.result;

  const resolved = resolveEntries(entries, new Map(world.value.services.map((s) => [s.service_id, s])), world.value.projects);
  const needs = githubNeeds(resolved);
  const reads = await planGithubReads(io, needs);
  const evaluation = evaluatePlan(resolved, reads);
  if (evaluation.errors.length > 0) return invalidPlan(evaluation.errors, { plan_id: planId });

  const toWrite = targetsToWrite(evaluation.entries, reads, baseUrl);
  const configured = evaluation.entries
    .filter((e) => e.status === 'already_configured')
    .map((e) => ({
      project_id: e.resolved.entry.project_id,
      branch: e.resolved.entry.branch,
      service_id: e.resolved.entry.service_id,
      target_name: e.existingTargetName ?? '',
    }));
  const summary = summaryOf(evaluation.entries);
  const prPreview = uniqueSorted(toWrite.map((t) => t.repoKey)).map((k) => {
    const mine = toWrite.filter((t) => t.repoKey === k);
    return {
      repo: `${mine[0].repo.owner}/${mine[0].repo.name}`,
      base: reads.defaultBranches.get(refKey(mine[0].repo)) ?? null,
      files: uniqueSorted(mine.map((t) => t.file)),
      targets: mine.map((t) => t.target.name),
    };
  });
  const dryBody = { plan, plan_id: planId, summary_lines: summary, already_configured: configured, prs: prPreview, ...extrasBody(extras) };

  if (!confirming) {
    if (opts.dryRun === true) {
      return {
        exitCode: 0,
        body: {
          ok: true,
          dry_run: true,
          ...dryBody,
          next_steps: [
            { action: 'relay', field: 'summary_lines' },
            { action: 'get_approval' },
            { run: `capy deploy dokploy --discover --plan ${opts.plan} --confirm ${planId}` },
          ],
        },
      };
    }
    return refuse(
      ERROR_CODES.PLAN_CONFIRM_REQUIRED,
      `A real run needs --confirm ${planId}. Run with --dry-run to see the plan.`, // COPY-FLAG
      { ...dryBody, unanswered: [{ id: 'confirm', flag: '--confirm', value: planId }] },
    );
  }

  const applied = await applyTargets(toWrite, { github: io.github(), branchName: io.branchName });
  const failed = applied.failed.length > 0;
  return {
    exitCode: failed ? 1 : 0,
    body: {
      ok: !failed,
      ...(failed ? { code: ERROR_CODES.DISCOVER_PARTIAL } : {}),
      plan_id: planId,
      summary_lines: summary,
      prs: applied.prs,
      failed: applied.failed,
      already_configured: configured,
      ...extrasBody(extras),
    },
  };
}

// ── The command ──────────────────────────────────────────────────────────────

/** Runs the command and returns what it prints. Never prints, never exits, never prompts. */
export async function runDeployDokployDiscover(opts: DeployDiscoverOpts, io: DeployDiscoverIo): Promise<DeployDiscoverResult> {
  if (opts.confirm !== undefined && opts.plan === undefined) {
    return refuse(ERROR_CODES.PLAN_REQUIRED, '--confirm needs --plan <file>.'); // COPY-FLAG
  }
  if (opts.plan === undefined) return runDiscovery(opts, io);
  const parsed = readPlan(opts, io);
  if (!parsed.ok) return parsed.result;
  return runPlan(opts, io, parsed.value);
}
