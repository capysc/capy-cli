/**
 * Batch deploy (CAP-704), from `capy secrets`: deploy the Dokploy targets of the
 * selected secrets WITHOUT a project checkout.
 *
 * "Deploy" is exactly what `capy deploy <target>` does for a Dokploy target in CI
 * mode: push the current values into the Dokploy service's env (Capy's managed
 * block, plain KEY=value lines), record the delivery on the Capy server, and open
 * the keep.lock PR whose merge triggers Dokploy's own auto-deploy. Capy never
 * triggers a deploy itself here. Everything else is skipped with a coded reason:
 * a target that is not Dokploy, not CI mode, or not on the default branch.
 *
 * Nothing here needs a clone:
 *  - TARGET CONFIG is read from `.capy/deploy.json` on the repo's DEFAULT branch
 *    through the GitHub API. A target only in an unmerged discover PR does not count.
 *  - VALUES are decrypted with the one run-wide key resolver (one unlock per run)
 *    from the Capy service's blob for the target's project and branch.
 *  - PREFLIGHT is the adapter's own, given keep.lock's repo-relative path.
 *  - The RECORD on the Capy server is built from the SERVER's keep
 *    (`deliveryRecord.ts`), never from a local keep.lock.
 *  - The PR is opened through the GitHub API (`openKeepLockPullRequest`), with the
 *    same description `capy deploy` writes for the target.
 *
 * A run has three phases, each stoppable the way the multi-edit is: values are
 * pushed (targets run `BATCH_DEPLOY_CONCURRENCY` at a time, results in input
 * order), then every delivery is recorded (one server write per project and
 * branch, so two targets of one branch never overwrite each other's record), then
 * one PR is opened per target (one Dokploy service is one target; two targets in
 * one repo are two PRs).
 *
 * A value is never printed, returned, logged or put in an error: it lives inside
 * `pushTarget` and is gone when it returns. Failures are codes.
 */
import { FileManager } from '../files/fileManager';
import { CapyError, ERROR_CODES, KeepFile } from '../types/index';
import type { DeployAdapter, TargetConfig } from './adapter';
import type { OrgRepoLink, SecretIndexLocation, ServiceClient } from '../service/serviceClient';
import type { GithubApi, RepoRef } from './githubApi';
import type { ResolveDokployApiKeyResult } from './adapters/dokploy';
import { createDokployAdapter } from './adapters/dokploy';
import { resolveDokployApiKeyOnce } from './dokployApiKeyOnce';
import { RecordClient, RecordResult, deliveryFor, recordDeliveriesOnServer } from './deliveryRecord';
import { buildDeployPrBody } from './deployPrBody';
import { foldDeployKeep, hashValue } from './keepGate';
import { parseTargets } from './configuredTargets';
import { TargetDeliveryDescriptor, VarDelivery, deliveryWorthGating } from './targetsGate';
import { callWithBackoff, retryOnRateLimit } from '../service/capyCalls';
import { PACING_RESERVE, PoolItem, RateInfo, runPool } from '../utils/pool';
import type { Sleep } from '../utils/backoff';
import { KeepLockFileSpec, codeForApiFailure, newPrBranchName, openKeepLockPullRequest, readKeepLockBases } from '../commands/keepLockPr';
import { GITHUB_HOST, KeyResolver, RepoTarget, keepLockPathOf, realGithub, repoKey, repoLabel, resolveBases } from '../commands/secretsSet';
import { createRunKeyResolver } from '../crypto/keyResolver';
import { deployJsonPathOf } from '../commands/deployDiscover/facts';

// ---------------------------------------------------------------------------
// Constants and codes
// ---------------------------------------------------------------------------

/** Targets pushed to Dokploy at once, and PRs opened at once. */
export const BATCH_DEPLOY_CONCURRENCY = 4;
/** `.capy/deploy.json` files read from GitHub at once. */
export const CONFIG_READ_CONCURRENCY = 4;

/** Why a target was not deployed. A reason, not a failure. */
export const SKIP_CODES = {
  /** The location has no Capy deploy target at all. */
  NO_TARGET: 'NO_TARGET',
  /** Capy knows the target (it delivered to it), but `.capy/deploy.json` on the default branch does not list it. */
  TARGET_NOT_ON_DEFAULT_BRANCH: 'TARGET_NOT_ON_DEFAULT_BRANCH',
  /** The target is not a Dokploy target. */
  NOT_DOKPLOY: 'NOT_DOKPLOY',
  /** The target is a direct-mode target. */
  NOT_CI_MODE: 'NOT_CI_MODE',
  /** Capy's keep.lock on the PR base already records exactly these values for this target. */
  NOTHING_TO_DEPLOY: 'NOTHING_TO_DEPLOY',
} as const;
export type SkipCode = (typeof SKIP_CODES)[keyof typeof SKIP_CODES];

/** Where a failure happened. `pr` and `record` come after the values reached Dokploy. */
export type FailStage = 'github' | 'preflight' | 'values' | 'push' | 'pr';

// ---------------------------------------------------------------------------
// The plan: what would be deployed
// ---------------------------------------------------------------------------

/** One (project, branch) a selected secret lives in. */
export interface DeployLocation {
  readonly project_id: string;
  readonly project_name: string;
  readonly branch: string;
  /** The (provider, target) pairs the Capy server lists for this location: targets Capy has delivered to. */
  readonly known: ReadonlyArray<{ readonly provider: string; readonly target: string }>;
}

/** The locations of one `capy secrets` row, with the targets Capy has delivered to at each. */
export const deployLocationsOf = (row: { readonly locations: readonly SecretIndexLocation[] }): readonly DeployLocation[] =>
  row.locations.map((l) => ({
    project_id: l.project_id,
    project_name: l.project_name,
    branch: l.branch,
    known: (l.targets ?? []).map((t) => ({ provider: t.provider, target: t.target })),
  }));

export interface DeployRequest {
  /** The selected secret names: a target is relevant when it ships at least one of them. */
  readonly names: readonly string[];
  readonly locations: readonly DeployLocation[];
}

/** One Dokploy CI target that can be deployed. */
export interface BatchTarget {
  readonly project_id: string;
  readonly project_name: string;
  /** The Capy branch. */
  readonly branch: string;
  readonly repo: RepoRef;
  /** The project's folder in the repo (`.` for the root). */
  readonly path: string;
  /** The PR base: the target's `gitBaseBranch`, else the repo's default branch. */
  readonly base: string;
  readonly config: TargetConfig;
}

export interface PlanSkipped {
  readonly project: string;
  readonly branch: string;
  readonly target: string | null;
  readonly provider: string | null;
  readonly code: SkipCode;
}

export interface PlanReadFailure {
  readonly repo: string;
  readonly code: string;
}

export interface BatchPlan {
  readonly targets: readonly BatchTarget[];
  readonly skipped: readonly PlanSkipped[];
  /** Repos whose default branch or `.capy/deploy.json` could not be read: their locations are not decided either way. */
  readonly read_failed: readonly PlanReadFailure[];
}

export const EMPTY_PLAN: BatchPlan = { targets: [], skipped: [], read_failed: [] };

const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)];

/** The same target reached twice (two selected rows, two locations) is one target. */
export const targetKeyOf = (t: BatchTarget): string => [t.project_id, repoKey({ host: GITHUB_HOST, ...t.repo }), t.path, t.config.name].join('\u0000');

/**
 * The plan restricted to the targets whose key (`targetKeyOf`) is in `selectedKeys`. The skipped
 * locations and the repos that could not be read stay: they were never deployable, and the result
 * still lists them. Pure; the plan it is given is not changed.
 */
export const restrictPlan = (plan: BatchPlan, selectedKeys: readonly string[]): BatchPlan => ({
  ...plan,
  targets: plan.targets.filter((t) => selectedKeys.includes(targetKeyOf(t))),
});

const refOf = (repo: RepoRef): RepoTarget => ({ host: GITHUB_HOST, owner: repo.owner, name: repo.name, files: [] });

interface LinkRead {
  readonly link: OrgRepoLink;
  /** The targets in the project's deploy.json on the default branch, or why they could not be read. */
  readonly read: { readonly ok: true; readonly targets: readonly TargetConfig[]; readonly base: string } | { readonly ok: false; readonly code: string };
}

/** What one location comes to, given what its links' deploy.json files hold. */
function classifyLocation(
  loc: DeployLocation,
  reads: readonly LinkRead[],
  names: readonly string[],
): { readonly targets: readonly BatchTarget[]; readonly skipped: readonly PlanSkipped[] } {
  const skip = (target: string | null, provider: string | null, code: SkipCode): PlanSkipped => ({
    project: loc.project_name,
    branch: loc.branch,
    target,
    provider,
    code,
  });
  const readable = reads.flatMap((r) => (r.read.ok ? [{ link: r.link, targets: r.read.targets, base: r.read.base }] : []));
  // A location whose deploy.json could not be read is not decided: it is in `read_failed`, not here.
  if (readable.length < reads.length) return { targets: [], skipped: [] };

  const found = readable.flatMap(({ link, targets, base }) =>
    targets
      .filter((t) => t.branch === loc.branch && t.vars.some((v) => names.includes(v)))
      .map((config) => ({ link, config, base })),
  );
  const notOnDefault = loc.known
    .filter((k) => !found.some((f) => f.config.kind === k.provider && f.config.name === k.target))
    .map((k) => skip(k.target, k.provider, SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH));
  const foundSkips = found.flatMap(({ config }): PlanSkipped[] => {
    if (config.kind !== 'dokploy') return [skip(config.name, config.kind, SKIP_CODES.NOT_DOKPLOY)];
    // `capy deploy` treats a target saved without a mode as direct.
    return (config.mode ?? 'direct') === 'ci' ? [] : [skip(config.name, config.kind, SKIP_CODES.NOT_CI_MODE)];
  });
  const targets = found
    .filter(({ config }) => config.kind === 'dokploy' && (config.mode ?? 'direct') === 'ci')
    .map(({ link, config, base }): BatchTarget => ({
      project_id: loc.project_id,
      project_name: loc.project_name,
      branch: loc.branch,
      repo: { owner: link.owner, name: link.name },
      path: link.path,
      base: config.gitBaseBranch ?? base,
      config,
    }));
  const skipped = [...notOnDefault, ...foundSkips];
  return {
    targets,
    skipped: targets.length === 0 && skipped.length === 0 ? [skip(null, null, SKIP_CODES.NO_TARGET)] : skipped,
  };
}

/**
 * What a batch deploy of `req` would do. Reads only: the repos' default branches and each
 * project's `.capy/deploy.json` on that branch, from GitHub. It decrypts nothing and writes
 * nothing, so a dry run is this and nothing else. `links` are the org's project to repo
 * links; only GitHub repos count. Never throws.
 */
export async function planBatchDeploy(
  github: GithubApi | undefined,
  req: DeployRequest,
  links: readonly OrgRepoLink[],
  signal?: AbortSignal,
): Promise<BatchPlan> {
  const linksOf = (loc: DeployLocation): readonly OrgRepoLink[] =>
    links.filter((l) => l.project_id === loc.project_id && l.host.toLowerCase() === GITHUB_HOST);
  const used = req.locations.flatMap(linksOf);
  const repos = unique(used.map((l) => repoKey(l))).map((k) => refOf(used.find((l) => repoKey(l) === k) as OrgRepoLink));
  if (repos.length > 0 && github === undefined) {
    return { ...EMPTY_PLAN, read_failed: [{ repo: GITHUB_HOST, code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE }] };
  }

  const bases = await resolveBases(github, repos, signal);
  const fileKeys = unique(used.map((l) => `${repoKey(l)}\u0000${l.path}`));
  const files = await runPool({
    items: fileKeys,
    limit: CONFIG_READ_CONCURRENCY,
    run: async (key): Promise<PoolItem<readonly [string, LinkRead['read']]>> => {
      const link = used.find((l) => `${repoKey(l)}\u0000${l.path}` === key) as OrgRepoLink;
      const base = bases[repoKey(link)];
      if (github === undefined || base === undefined) {
        return { result: [key, { ok: false, code: ERROR_CODES.KEEP_PR_BASE_UNRESOLVED }] };
      }
      const got = await github.getFile({ owner: link.owner, name: link.name }, deployJsonPathOf(link.path), base);
      if (!got.ok) return { result: [key, { ok: false, code: codeForApiFailure(got, ERROR_CODES.KEEP_PR_READ_FAILED) }] };
      return { result: [key, { ok: true, targets: got.value === null ? [] : parseTargets(got.value), base }] };
    },
  });
  const readByKey = Object.fromEntries(files.results);

  const perLocation = req.locations.map((loc) =>
    classifyLocation(
      loc,
      linksOf(loc).map((link): LinkRead => ({ link, read: readByKey[`${repoKey(link)}\u0000${link.path}`] })),
      req.names,
    ),
  );
  const allTargets = perLocation.flatMap((p) => p.targets);
  const targets = allTargets.filter((t, i) => allTargets.findIndex((o) => targetKeyOf(o) === targetKeyOf(t)) === i);
  const failures = used
    .flatMap((l) => {
      const read = readByKey[`${repoKey(l)}\u0000${l.path}`];
      return read !== undefined && !read.ok ? [{ repo: repoLabel(l), code: read.code }] : [];
    })
    .filter((f, i, all) => all.findIndex((o) => o.repo === f.repo && o.code === f.code) === i);
  return { targets, skipped: perLocation.flatMap((p) => p.skipped), read_failed: failures };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The part of a target a person or an agent reads. */
export interface TargetRef {
  readonly project: string;
  readonly branch: string;
  readonly target: string;
  readonly provider: string;
  readonly repo: string;
  readonly path: string;
  readonly vars: number;
}

export const targetRefOf = (t: BatchTarget): TargetRef => ({
  project: t.project_name,
  branch: t.branch,
  target: t.config.name,
  provider: t.config.kind,
  repo: repoLabel(t.repo),
  path: t.path,
  vars: t.config.vars.length,
});

export type TargetResult =
  | {
      readonly kind: 'delivered';
      readonly target: TargetRef;
      /** `null`: the PR base already carried this keep.lock, so none was needed. */
      readonly pr_url: string | null;
      readonly base: string;
      /** `false`: the values are in Dokploy but Capy's server could not record the delivery (`record_code` says why). */
      readonly recorded: boolean;
      readonly record_code?: string;
      /** Names the target lists that had no value in Capy, so were not delivered. Absent when none. */
      readonly missing_vars?: readonly string[];
    }
  | { readonly kind: 'skipped'; readonly target: TargetRef; readonly code: SkipCode }
  | {
      readonly kind: 'failed';
      readonly target: TargetRef;
      readonly code: string;
      readonly stage: FailStage;
      /** `true`: the values are already in Dokploy (only the PR failed). */
      readonly values_pushed: boolean;
    }
  | { readonly kind: 'cancelled'; readonly target: TargetRef; readonly stage: 'push' | 'pr'; readonly values_pushed: boolean };

export interface BatchResult {
  /** One per planned target, in plan order. */
  readonly targets: readonly TargetResult[];
  /** The plan's own skips (no target, not on the default branch, not Dokploy, not CI). */
  readonly skipped: readonly PlanSkipped[];
  readonly read_failed: readonly PlanReadFailure[];
}

/** `true` when every target was delivered or skipped and none was cancelled or failed. */
export const batchSucceeded = (result: BatchResult): boolean =>
  result.targets.every((t) => t.kind === 'delivered' || t.kind === 'skipped');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Everything external, injected: tests pass fakes; `createBatchEnv` builds the real one. */
export interface BatchEnv {
  readonly client: Pick<ServiceClient, 'getDecryptData'> & RecordClient;
  readonly orgId: string;
  /** Unlocks ONCE for one run and returns the project-key resolver for it. Called once per run, and only when a key will be needed. */
  readonly openKeys: () => KeyResolver;
  /** `undefined` when `gh` is not installed. */
  readonly github: () => GithubApi | undefined;
  readonly branchName: () => string;
  /** The Dokploy adapter: its own preflight and delivery. */
  readonly adapter: DeployAdapter;
  /** The Dokploy API key for a target, from the org system store (never prompts). `undefined`: the adapter finds it itself. */
  readonly resolveApiKey: (target: TargetConfig) => Promise<ResolveDokployApiKeyResult | undefined>;
  readonly devMode?: boolean;
  readonly sleep?: Sleep;
  /** The clock, epoch ms (also the pacing clock). */
  readonly now?: () => number;
}

export type BatchPhase = 'pushing' | 'recording' | 'prs';

export interface BatchProgress {
  readonly phase: BatchPhase;
  readonly done: number;
  readonly inFlight: number;
  readonly total: number;
}

/**
 * Cooperative cancel, checked BETWEEN items so a Dokploy write or a PR call is never cut in half.
 * `stopPushes`: push no further target. `stopPrs`: open no further PR. Every item already running
 * finishes. (A stop of the pushes still records and opens the PRs for what WAS pushed.)
 */
export interface BatchHooks {
  readonly onProgress?: (progress: BatchProgress) => void;
  readonly onStopping?: (stopping: { readonly phase: BatchPhase; readonly inFlight: number }) => void;
  readonly stopPushes?: AbortSignal;
  readonly stopPrs?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const codeOf = (err: unknown): string => (err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR);

type Tried<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const settled = <T>(promise: Promise<T>): Promise<Tried<T>> =>
  promise.then(
    (value): Tried<T> => ({ ok: true, value }),
    (error: unknown): Tried<T> => ({ ok: false, error }),
  );

function attempt<T>(f: () => T): Tried<T> {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return { ok: false, error };
  }
}

const withRate = <R>(result: R, rate: RateInfo | undefined): PoolItem<R> => ({ result, ...(rate === undefined ? {} : { rate }) });

/** Never called: stands in for the resolver of a run that pushes nothing. */
const NO_KEYS: KeyResolver = async () => {
  throw new CapyError('no keys were opened', ERROR_CODES.SERVICE_ERROR);
};

const parseKeep = (raw: string | undefined): KeepFile | undefined => {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    const vars = obj?.variables;
    return typeof vars === 'object' && vars !== null && !Array.isArray(vars) ? (parsed as KeepFile) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The target's variables, decrypted from the branch's blob. A listed name with no value on the
 * branch is left out and named in `missing`, the way `capy deploy` drops it; only a target with
 * NO deliverable variable at all fails. Throws nothing; the value is never in a failure.
 */
function decryptVars(
  blob: string,
  vars: readonly string[],
  projectKey: string,
):
  | { readonly ok: true; readonly values: Readonly<Record<string, string>>; readonly missing: readonly string[] }
  | { readonly ok: false; readonly code: string } {
  const fm = new FileManager();
  const stored = fm.parseEnvContent(blob);
  const present = vars.filter((v) => stored[v] !== undefined);
  const missing = vars.filter((v) => stored[v] === undefined);
  if (present.length === 0) return { ok: false, code: ERROR_CODES.DEPLOY_VARS_MISSING };
  const decrypted = attempt(() => Object.fromEntries(present.map((v) => [v, fm.decryptValue(stored[v], projectKey)])));
  return decrypted.ok ? { ok: true, values: decrypted.value, missing } : { ok: false, code: codeOf(decrypted.error) };
}

/** The Dokploy API keys of a run, resolved once per distinct `tokenEnv` (a target without one uses the org store's). */
export interface ApiKeys {
  readonly forTarget: (target: TargetConfig) => ResolveDokployApiKeyResult | undefined;
}

const tokenEnvOf = (t: TargetConfig): string => String((t.options as { tokenEnv?: unknown }).tokenEnv ?? '');

async function resolveApiKeys(env: BatchEnv, targets: readonly BatchTarget[]): Promise<ApiKeys> {
  const groups = unique(targets.map((t) => tokenEnvOf(t.config)));
  const resolved = await Promise.all(
    groups.map(async (group): Promise<readonly [string, ResolveDokployApiKeyResult | undefined]> => {
      const representative = targets.find((t) => tokenEnvOf(t.config) === group) as BatchTarget;
      const key = await settled(env.resolveApiKey(representative.config));
      return [group, key.ok ? key.value : undefined];
    }),
  );
  const byGroup = Object.fromEntries(resolved);
  return { forTarget: (target) => byGroup[tokenEnvOf(target)] };
}

const NO_API_KEYS: ApiKeys = { forTarget: () => undefined };

// ---------------------------------------------------------------------------
// Phase 1: one target's values reach Dokploy
// ---------------------------------------------------------------------------

/** What a pushed target carries to the record and PR phases. Hashes only: no value. */
export interface Pushed {
  readonly kind: 'pushed';
  readonly item: BatchTarget;
  readonly delivery: TargetDeliveryDescriptor;
  readonly values: readonly VarDelivery[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly deliveredAt: string;
  /** keep.lock as the Capy server has it, with no variables: the identity a missing keep.lock on the base is scaffolded from. */
  readonly scaffold: KeepFile;
  /** Names the target lists but the branch has no value for: left out of this delivery. */
  readonly missing: readonly string[];
}

/** The target with only the names that have a value; unchanged when nothing is missing. */
const effectiveTarget = (item: BatchTarget, missing: readonly string[]): BatchTarget =>
  missing.length === 0 ? item : { ...item, config: { ...item.config, vars: item.config.vars.filter((v) => !missing.includes(v)) } };

export type PushOutcome =
  | Pushed
  | { readonly kind: 'skipped'; readonly item: BatchTarget; readonly code: SkipCode }
  | { readonly kind: 'failed'; readonly item: BatchTarget; readonly code: string; readonly stage: FailStage };

const failedPush = (item: BatchTarget, code: string, stage: FailStage, rate?: RateInfo): PoolItem<PushOutcome> =>
  withRate<PushOutcome>({ kind: 'failed', item, code, stage }, rate);

/** The keep.lock spec for a target's PR: its delivery folded into whatever the base holds. */
function specFor(p: Pushed): KeepLockFileSpec {
  return {
    path: keepLockPathOf(p.item.path),
    records: [],
    localKeep: p.scaffold,
    fold: (base) => foldDeployKeep(base, p.hashes, p.item.config.vars, p.item.branch, p.delivery, p.deliveredAt),
  };
}

/**
 * One target, up to and including the delivery to Dokploy: preflight, read and decrypt its
 * variables, check against the PR base's keep.lock that something would change, push.
 * Never throws; reports the rate-limit reading it saw.
 */
export async function pushTarget(env: BatchEnv, keys: KeyResolver, apiKeys: ApiKeys, item: BatchTarget): Promise<PoolItem<PushOutcome>> {
  const config = item.config;
  const github = env.github();
  if (github === undefined) return failedPush(item, ERROR_CODES.KEEP_PR_GH_UNAVAILABLE, 'github');
  const callCtx = { orgId: env.orgId, devMode: env.devMode, interactive: false, resolvedApiKey: apiKeys.forTarget(config) };

  // Fail before anything is decrypted, like `capy deploy`.
  const preflight = await settled(
    env.adapter.preflight(config, { cwd: process.cwd(), keepLockPath: keepLockPathOf(item.path), ...callCtx }),
  );
  if (!preflight.ok) return failedPush(item, codeOf(preflight.error), 'preflight');
  if (!preflight.value.ok) return failedPush(item, preflight.value.code ?? ERROR_CODES.DEPLOY_PREFLIGHT_FAILED, 'preflight');

  const key = await settled(keys(item.project_id));
  if (!key.ok) return failedPush(item, codeOf(key.error), 'values');
  const read = await callWithBackoff((onRate) => env.client.getDecryptData(item.project_id, item.branch, undefined, true, onRate), env.sleep);
  if (!read.ok) return failedPush(item, codeOf(read.error), 'values', read.rate);
  const serverKeep = parseKeep(read.value.keep_file);
  if (serverKeep === undefined) return failedPush(item, ERROR_CODES.NO_KEEP_FILE, 'values', read.rate);
  const decrypted = decryptVars(read.value.env_content ?? '', config.vars, key.value);
  if (!decrypted.ok) return failedPush(item, decrypted.code, 'values', read.rate);
  // From here on the target carries only the names that have a value (`capy deploy` does the same).
  const effective = effectiveTarget(item, decrypted.missing);
  const hashes = Object.fromEntries(effective.config.vars.map((v) => [v, hashValue(decrypted.values[v])]));
  const { delivery, values } = deliveryFor(effective.config, env.adapter, undefined, false, hashes);

  // Nothing is pushed unless the PR can be opened afterwards: the base exists, and its keep.lock would change.
  const scaffold: KeepFile = { ...serverKeep, variables: {} };
  const repo = item.repo;
  const head = await github.getBranchHead(repo, item.base);
  if (!head.ok) {
    return failedPush(
      item,
      codeForApiFailure(head, head.kind === 'NOT_FOUND' ? ERROR_CODES.KEEP_PR_BASE_UNRESOLVED : ERROR_CODES.KEEP_PR_READ_FAILED),
      'github',
      read.rate,
    );
  }
  const base = await readKeepLockBases(github, repo, item.base, [{ path: keepLockPathOf(item.path), records: [], localKeep: scaffold }]);
  if (!base.ok) return failedPush(item, base.code, 'github', read.rate);
  if (!deliveryWorthGating(base.bases[0].keep, item.branch, delivery.provider, config.name, undefined, values)) {
    return withRate<PushOutcome>({ kind: 'skipped', item, code: SKIP_CODES.NOTHING_TO_DEPLOY }, read.rate);
  }

  // CI mode: secrets only. Merging the PR is what triggers Dokploy's own auto-deploy.
  const delivered = await settled(
    env.adapter.deploy(effective.config, { env: decrypted.values, dryRun: false, secretsOnly: true, noDeploy: false, cwd: process.cwd(), ...callCtx }),
  );
  if (!delivered.ok) return failedPush(item, codeOf(delivered.error), 'push', read.rate);
  if (!delivered.value.ok) {
    const stepCode = delivered.value.steps.find((s) => s.status === 'fail' && s.code !== undefined)?.code;
    return failedPush(item, stepCode ?? ERROR_CODES.DEPLOY_PUSH_FAILED, 'push', read.rate);
  }
  return withRate<PushOutcome>(
    { kind: 'pushed', item: effective, delivery, values, hashes, deliveredAt: new Date((env.now ?? Date.now)()).toISOString(), scaffold, missing: decrypted.missing },
    read.rate,
  );
}

// ---------------------------------------------------------------------------
// Phase 2: the delivery is recorded on the Capy server
// ---------------------------------------------------------------------------

const groupKey = (p: Pushed): string => `${p.item.project_id}\u0000${p.item.branch}`;

/** The recorder's client, with a 429 waited out (bounded) like every other bulk call. */
const patientClient = (env: BatchEnv): RecordClient => ({
  getLatestSecrets: (projectId, branch) => retryOnRateLimit(() => env.client.getLatestSecrets(projectId, branch), env.sleep),
  pushSecrets: (projectId, keepFile, envBlob, branch) => retryOnRateLimit(() => env.client.pushSecrets(projectId, keepFile, envBlob, branch), env.sleep),
});

/** Records every pushed target of ONE (project, branch) with ONE server write. */
async function recordGroup(env: BatchEnv, group: readonly Pushed[]): Promise<RecordResult> {
  return recordDeliveriesOnServer(
    patientClient(env),
    group[0].item.project_id,
    group[0].item.branch,
    group.map((p) => ({ delivery: p.delivery, values: p.values, deliveredAt: p.deliveredAt })),
  );
}

/**
 * Records the deliveries on the Capy server, built from the SERVER's keep. Targets of one
 * project and branch share one read-modify-write (two writers would drop each other's record);
 * different (project, branch) groups run `BATCH_DEPLOY_CONCURRENCY` at a time. The result of
 * each target is its group's, in `pushed` order.
 */
export async function recordPushed(
  env: BatchEnv,
  pushed: readonly Pushed[],
  onChange?: (progress: { readonly done: number; readonly inFlight: number; readonly total: number }) => void,
): Promise<readonly RecordResult[]> {
  const groups = unique(pushed.map(groupKey)).map((k) => pushed.filter((p) => groupKey(p) === k));
  const recorded = await runPool({
    items: groups,
    limit: BATCH_DEPLOY_CONCURRENCY,
    run: async (group): Promise<PoolItem<RecordResult>> => ({ result: await recordGroup(env, group) }),
    onChange,
  });
  const byGroup = Object.fromEntries(groups.map((g, i) => [groupKey(g[0]), recorded.results[i]]));
  return pushed.map((p) => byGroup[groupKey(p)]);
}

// ---------------------------------------------------------------------------
// Phase 3: the PR
// ---------------------------------------------------------------------------

type PrOutcome =
  | { readonly ok: true; readonly pr_url: string | null }
  | { readonly ok: false; readonly code: string };

/**
 * Opens the target's keep.lock PR through the GitHub API, on the target's base, with the
 * description `capy deploy` writes for it. One PR per target.
 */
export async function openTargetPr(env: BatchEnv, pushed: Pushed): Promise<PrOutcome> {
  const github = env.github();
  if (github === undefined) return { ok: false, code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE };
  const { config, branch } = pushed.item;
  const label = `${config.name} → ${branch} (${config.kind})`;
  const opened = await openKeepLockPullRequest(
    {
      command: 'deploy',
      repo: pushed.item.repo,
      files: [specFor(pushed)],
      base: pushed.item.base,
      wording: { commitMessage: `chore(deploy): ${label}`, title: `deploy: ${label}`, body: buildDeployPrBody(config) },
    },
    { github, branchName: env.branchName },
  );
  if (opened.ok) return { ok: true, pr_url: opened.pr_url };
  // The base already carries this keep.lock: the values are in Dokploy and there is nothing to merge.
  return opened.reason === 'NO_DIFF_VS_BASE' ? { ok: true, pr_url: null } : { ok: false, code: opened.code };
}

// ---------------------------------------------------------------------------
// One target, whole
// ---------------------------------------------------------------------------

const deliveredResult = (p: Pushed, pr: Extract<PrOutcome, { ok: true }>, recorded: RecordResult): TargetResult => ({
  kind: 'delivered',
  target: targetRefOf(p.item),
  pr_url: pr.pr_url,
  base: p.item.base,
  recorded: recorded.ok,
  ...(recorded.ok ? {} : { record_code: recorded.code }),
  ...(p.missing.length > 0 ? { missing_vars: p.missing } : {}),
});

/**
 * ONE target, whole and with no checkout: push its values to Dokploy, record the delivery
 * on the Capy server, open its PR. `capy secrets deploy` runs many of these in phases
 * (`runBatchDeploy`); this is the same three steps for one. Never throws.
 */
export async function deployTarget(env: BatchEnv, keys: KeyResolver, apiKeys: ApiKeys, item: BatchTarget): Promise<TargetResult> {
  const pushed = (await pushTarget(env, keys, apiKeys, item)).result;
  if (pushed.kind === 'skipped') return { kind: 'skipped', target: targetRefOf(item), code: pushed.code };
  if (pushed.kind === 'failed') {
    return { kind: 'failed', target: targetRefOf(item), code: pushed.code, stage: pushed.stage, values_pushed: false };
  }
  const [recorded] = await recordPushed(env, [pushed]);
  const pr = await openTargetPr(env, pushed);
  return pr.ok
    ? deliveredResult(pushed, pr, recorded)
    : { kind: 'failed', target: targetRefOf(item), code: pr.code, stage: 'pr', values_pushed: true };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Deploys every target of `plan`: pushes `BATCH_DEPLOY_CONCURRENCY` at a time after ONE
 * unlock, records the deliveries, then opens one PR per pushed target. One failure never
 * blocks another, and nothing waits forever (every GitHub call and every service call has a
 * timeout; a rate limit is waited out a bounded number of times). `hooks` reports progress
 * and lets the caller stop: a stop starts nothing further and lets every item already running
 * finish; what it left unstarted is `cancelled`. Everything is in plan order.
 */
export async function runBatchDeploy(plan: BatchPlan, env: BatchEnv, hooks: BatchHooks = {}): Promise<BatchResult> {
  const stoppedAtStart = hooks.stopPushes?.aborted === true;
  const keys = plan.targets.length === 0 || stoppedAtStart ? NO_KEYS : env.openKeys();
  const apiKeys = plan.targets.length === 0 || stoppedAtStart ? NO_API_KEYS : await resolveApiKeys(env, plan.targets);

  const pushedPhase = await runPool({
    items: plan.targets,
    limit: BATCH_DEPLOY_CONCURRENCY,
    run: (item) => pushTarget(env, keys, apiKeys, item),
    stop: hooks.stopPushes,
    reserve: PACING_RESERVE,
    now: env.now,
    sleep: env.sleep,
    onChange: (p) => hooks.onProgress?.({ phase: 'pushing', ...p }),
    onStopping: (inFlight) => hooks.onStopping?.({ phase: 'pushing', inFlight }),
  });
  const outcomes = pushedPhase.results;
  const pushed = outcomes.filter((o): o is Pushed => o.kind === 'pushed');

  const recorded = await recordPushed(env, pushed, (p) => hooks.onProgress?.({ phase: 'recording', ...p }));
  const recordedFor = (p: Pushed): RecordResult => recorded[pushed.indexOf(p)];

  const opened = await runPool({
    items: pushed,
    limit: BATCH_DEPLOY_CONCURRENCY,
    run: async (p): Promise<PoolItem<PrOutcome>> => ({ result: await openTargetPr(env, p) }),
    stop: hooks.stopPrs,
    onChange: (p) => hooks.onProgress?.({ phase: 'prs', ...p }),
    onStopping: (inFlight) => hooks.onStopping?.({ phase: 'prs', inFlight }),
  });
  const prOf = (p: Pushed): PrOutcome | undefined => opened.results[pushed.indexOf(p)];

  const targets = plan.targets.map((item, i): TargetResult => {
    const ref = targetRefOf(item);
    const outcome = outcomes[i];
    if (outcome === undefined) return { kind: 'cancelled', target: ref, stage: 'push', values_pushed: false };
    if (outcome.kind === 'skipped') return { kind: 'skipped', target: ref, code: outcome.code };
    if (outcome.kind === 'failed') return { kind: 'failed', target: ref, code: outcome.code, stage: outcome.stage, values_pushed: false };
    const pr = prOf(outcome);
    if (pr === undefined) return { kind: 'cancelled', target: ref, stage: 'pr', values_pushed: true };
    return pr.ok
      ? deliveredResult(outcome, pr, recordedFor(outcome))
      : { kind: 'failed', target: ref, code: pr.code, stage: 'pr', values_pushed: true };
  });
  return { targets, skipped: plan.skipped, read_failed: plan.read_failed };
}

// ---------------------------------------------------------------------------
// Real environment
// ---------------------------------------------------------------------------

/** The Dokploy adapter, with its progress lines turned off: stdout belongs to the caller. */
export const quietDokployAdapter = (): DeployAdapter => createDokployAdapter({ log: () => undefined });

/** The real `BatchEnv`: one unlock per run through the same co-decrypt path `capy edit` uses, the real `gh`, the org system store for the Dokploy key. */
export function createBatchEnv(orgId: string, userId: string, client: ServiceClient, devMode: boolean = false): BatchEnv {
  const adapter = quietDokployAdapter();
  return {
    client,
    orgId,
    openKeys: () =>
      createRunKeyResolver(orgId, userId, {
        // The unlock is one call: a 429 on it is waited out (bounded) before every target fails with the same code.
        coDecrypt: (oid, ct) => retryOnRateLimit(() => client.coDecrypt(oid, ct).then((r) => r.plaintext)),
        wrapOuterLayer: (oid, pt) => client.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
      }),
    github: realGithub,
    branchName: () => newPrBranchName(undefined, undefined, 'deploy'),
    adapter,
    resolveApiKey: (target) => resolveDokployApiKeyOnce(adapter, target, orgId, devMode, false),
    devMode,
  };
}
