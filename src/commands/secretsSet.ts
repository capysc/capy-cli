/**
 * `capy secrets` edit engine (CAP-698): set ONE secret NAME to a new value in
 * every chosen (project, branch) location, then open one keep.lock PR per repo.
 * Shared by the `capy secrets` TUI (`e`) and `capy secrets set NAME` (agents).
 *
 * The model: a `capy secrets` row is one NAME with one distinct value. The new
 * value is live in Capy as soon as it is pushed; the PR is only the pointer
 * (the keep.lock hash), so clones on the old keep.lock keep getting the old
 * value until they pull the merged PR.
 *
 * HOW A LOCATION IS PUSHED, with no project folder: the same sequence the org
 * system store uses (system/systemStore.ts) and `capy edit` uses — resolve the
 * project key, fetch the branch's blob + keep from the service, change only
 * this variable, push with the keep update through the same `pushSecrets`
 * route, `writeKeepCache`. Every OTHER variable's line in the blob is carried
 * over byte for byte (it is never decrypted and re-encrypted), so a push
 * touches this one variable and nothing else. Each branch is its own push.
 *
 * HOW A REPO IS UPDATED: one PR on the repo's default branch through
 * keepLockPr's `openKeepLockPullRequest` (blob per keep.lock, one tree, one
 * commit). Only this variable's entries, taken from the server's keep after
 * the push, are folded into GitHub's CURRENT keep.lock at each project's path.
 * When GitHub's keep.lock disagrees with the server's about OTHER variables,
 * the PR still carries only this change and the result says
 * `keep_lock_diverged: true`.
 *
 * Locations and repos fail independently. A failure is a code, never a message,
 * and nothing here ever prints, returns or throws the value or any hash of it.
 */
import { FileManager } from '../files/fileManager';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { SyncEngine } from '../sync/syncEngine';
import { hashValue } from '../deploy/keepGate';
import type { EditSaveRecord } from '../deploy/keepGate';
import { writeKeepCache } from '../config/globalConfig';
import { CapyError, ERROR_CODES, KeepFile, KeepVariableEntry } from '../types/index';
import type { OrgRepoLink, ServiceClient } from '../service/serviceClient';
import { GithubApi, RepoRef, createGhApi, spawnGhRunnerAsync } from '../deploy/githubApi';
import { resolveGh } from '../utils/gh';
import { createRunKeyResolver } from '../crypto/keyResolver';
import { callWithBackoff, retryOnRateLimit } from '../service/capyCalls';
import { PACING_RESERVE, PoolItem, RateInfo, mergeRates, runPool } from '../utils/pool';
import type { Sleep } from '../utils/backoff';
import {
  KeepLockFileSpec,
  newPrBranchName,
  openKeepLockPullRequest,
  readKeepLockBases,
  resolveDefaultBase,
} from './keepLockPr';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One (project, branch) a secret lives in. */
export interface SetLocation {
  readonly project_id: string;
  readonly project_name: string;
  readonly branch: string;
  readonly protected: boolean;
}

/** The part of a location a person or an agent reads. */
export interface LocationRef {
  readonly project: string;
  readonly branch: string;
  readonly protected: boolean;
}

/** One keep.lock folder (a project) inside a repo. `path` is `.` for the repo root. */
export interface RepoFile {
  readonly project_id: string;
  readonly project_name: string;
  readonly path: string;
}

/** A repo that will get one PR, and the keep.lock folders in it that change. */
export interface RepoTarget {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly files: readonly RepoFile[];
}

export interface SetRequest {
  readonly name: string;
  readonly value: string;
  readonly locations: readonly SetLocation[];
  readonly repos: readonly RepoTarget[];
  /** Each repo's PR base, by `repoKey`. Absent: the repo's default branch. */
  readonly bases?: Readonly<Record<string, string>>;
}

export interface PrResult {
  readonly repo: string;
  readonly url: string;
  readonly base: string;
  readonly keep_lock_paths: readonly string[];
  readonly keep_lock_diverged: boolean;
  readonly locations: readonly LocationRef[];
}

export type FailedItem =
  | ({ readonly kind: 'location'; readonly code: string } & LocationRef)
  | { readonly kind: 'repo'; readonly repo: string; readonly code: string };

export interface SecretSetResult {
  readonly name: string;
  readonly updated: readonly LocationRef[];
  readonly unchanged: readonly LocationRef[];
  readonly prs: readonly PrResult[];
  /** Repos whose keep.lock on the default branch already carries these entries: no PR was needed. */
  readonly no_pr: ReadonlyArray<{ readonly repo: string; readonly reason: 'NO_DIFF_VS_BASE' }>;
  readonly failed: readonly FailedItem[];
  /**
   * What a cancel left undone: locations never pushed and repos whose PR was never opened.
   * Empty (and left out of JSON) unless the run was stopped.
   */
  readonly cancelled?: readonly CancelledItem[];
}

export type CancelledItem = ({ readonly kind: 'location' } & LocationRef) | { readonly kind: 'repo'; readonly repo: string };

/** Where a running set is, for a live progress line. `done` counts FINISHED items; `inFlight` those running now. */
export interface RunProgress {
  readonly phase: 'pushing' | 'prs';
  readonly done: number;
  readonly inFlight: number;
  readonly total: number;
}

/**
 * Cooperative cancel, checked BETWEEN items so a push or a PR call is never cut
 * in half. `stopPushes`: start no further location pushes. `stopPrs`: start no
 * further PRs. Every item already running finishes. (A stop of the pushes still
 * lets the PRs for what WAS pushed go ahead.) `onStopping` fires once per phase when
 * a stop is noticed with items still running: how many will be waited for.
 */
export interface RunHooks {
  readonly onProgress?: (progress: RunProgress) => void;
  readonly onStopping?: (stopping: { readonly phase: RunProgress['phase']; readonly inFlight: number }) => void;
  readonly stopPushes?: AbortSignal;
  readonly stopPrs?: AbortSignal;
}

/** Location pushes running at once. */
export const LOCATION_CONCURRENCY = 6;
/** Repos getting their PR at once (the steps within one repo stay in order). */
export const PR_CONCURRENCY = 4;

/** A project key by project id, from the one unlock of a run. */
export type KeyResolver = (projectId: string) => Promise<string>;

/** Everything external, injected: tests pass fakes; `createSetEnv` builds the real one. */
export interface SetEnv {
  readonly client: Pick<ServiceClient, 'getDecryptData' | 'pushSecrets'>;
  readonly orgId: string;
  /**
   * Unlocks ONCE for one run and returns the project-key resolver for it (the org master
   * key is unwrapped once and kept in memory only for that run). Call it once per run, and
   * only when a key will be needed: the unwrap starts at once.
   */
  readonly openKeys: () => KeyResolver;
  readonly writeCache: (orgId: string, projectId: string, keepHash: string, envBlob: string) => void;
  /** `undefined` when `gh` is not installed. */
  readonly github: () => GithubApi | undefined;
  readonly branchName: () => string;
  /** Waits between retries of a rate-limited call, and the clock for pacing. Tests inject instant ones. */
  readonly sleep?: Sleep;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export const GITHUB_HOST = 'github.com';

export const locationRef = (l: SetLocation): LocationRef => ({
  project: l.project_name,
  branch: l.branch,
  protected: l.protected,
});

/** `owner/name`, as written by whoever reported the link. */
export const repoLabel = (t: { readonly owner: string; readonly name: string }): string => `${t.owner}/${t.name}`;

/** Case-insensitive identity of a repo: GitHub owners and names are. */
export const repoKey = (t: { readonly host: string; readonly owner: string; readonly name: string }): string =>
  `${t.host.toLowerCase()}/${t.owner.toLowerCase()}/${t.name.toLowerCase()}`;

/** The keep.lock path inside the repo for a project folder (`.` = root). */
export const keepLockPathOf = (folder: string): string => (folder === '.' ? 'keep.lock' : `${folder}/keep.lock`);

function codeOf(err: unknown): string {
  return err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR;
}

const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)];

// ---------------------------------------------------------------------------
// Repos: which repos a set of locations can get a PR in
// ---------------------------------------------------------------------------

export interface RepoPlanning {
  readonly targets: readonly RepoTarget[];
  /** Project names with no GitHub repo linked: no PR can be opened for them. */
  readonly notLinked: readonly string[];
}

/**
 * The repos (from `GET /orgs/:id/repos`) for the projects of `locations`.
 * Only GitHub repos can get a PR. A repo with several of these projects is one
 * target with one file per project folder.
 */
export function planRepos(
  locations: ReadonlyArray<{ readonly project_id: string; readonly project_name: string }>,
  links: readonly OrgRepoLink[],
): RepoPlanning {
  const projects = unique(locations.map((l) => l.project_id)).map((id) => ({
    id,
    name: locations.find((l) => l.project_id === id)?.project_name ?? id,
  }));
  const ids = new Set(projects.map((p) => p.id));
  const github = links.filter((l) => ids.has(l.project_id) && l.host.toLowerCase() === GITHUB_HOST);

  const keys = unique(github.map(repoKey));
  const targets = keys.map((key): RepoTarget => {
    const group = github.filter((l) => repoKey(l) === key);
    const files = group
      .filter((l, i) => group.findIndex((o) => o.project_id === l.project_id && o.path === l.path) === i)
      .map((l) => ({ project_id: l.project_id, project_name: l.project_name, path: l.path }));
    return { host: GITHUB_HOST, owner: group[0].owner, name: group[0].name, files };
  });

  const notLinked = projects.filter((p) => !github.some((l) => l.project_id === p.id)).map((p) => p.name);
  return { targets, notLinked: [...notLinked].sort() };
}

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

const hashOn = (keep: KeepFile, variable: string, branch: string): string | undefined =>
  keep.variables[variable]?.find((e) => e.branch === branch)?.value_hash;

/**
 * Whether GitHub's keep.lock disagrees with the server's about any variable OTHER
 * than `name`, on any of `branches` (present on one side only counts).
 */
export function keepDiverged(
  github: KeepFile,
  server: KeepFile,
  name: string,
  branches: readonly string[],
): boolean {
  const variables = unique([...Object.keys(github.variables), ...Object.keys(server.variables)]).filter((v) => v !== name);
  return variables.some((v) => branches.some((b) => hashOn(github, v, b) !== hashOn(server, v, b)));
}

// ---------------------------------------------------------------------------
// One location
// ---------------------------------------------------------------------------

type LocationOutcome =
  | { readonly kind: 'updated'; readonly location: SetLocation; readonly entry: KeepVariableEntry; readonly serverKeep: KeepFile }
  | { readonly kind: 'unchanged'; readonly location: SetLocation }
  | { readonly kind: 'failed'; readonly location: SetLocation; readonly code: string };

/** What a branch holds right now: its blob lines (kept verbatim), the server's keep, and the current plaintext of `name`. */
interface Current {
  readonly lines: readonly string[];
  readonly serverKeep: KeepFile;
  readonly index: number;
  readonly plaintext: string;
}

function parseKeepJson(raw: string | undefined): KeepFile | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    const vars = obj?.variables;
    return typeof vars === 'object' && vars !== null && !Array.isArray(vars) ? (parsed as KeepFile) : undefined;
  } catch {
    return undefined;
  }
}

const lineIndexOf = (lines: readonly string[], name: string): number =>
  lines.findIndex((l) => l.startsWith(`${name}=`));

type Tried<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** `f()` as a result instead of a throw. */
function attempt<T>(f: () => T): Tried<T> {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return { ok: false, error };
  }
}

const settled = <T>(promise: Promise<T>): Promise<Tried<T>> =>
  promise.then(
    (value): Tried<T> => ({ ok: true, value }),
    (error: unknown): Tried<T> => ({ ok: false, error }),
  );

type Fetched = Awaited<ReturnType<SetEnv['client']['getDecryptData']>>;

/** What a branch holds, from its fetched data: blob lines (kept verbatim), the server's keep, and the plaintext of `name`. Throws a coded `CapyError`; the value is never in what it throws. */
function currentFrom(data: Fetched, name: string, projectKey: string): Current {
  const lines = (data.env_content ?? '').split('\n').filter((l) => l.trim().length > 0);
  const serverKeep = parseKeepJson(data.keep_file);
  if (serverKeep === undefined) throw new CapyError('keep.lock unavailable', ERROR_CODES.NO_KEEP_FILE);
  const index = lineIndexOf(lines, name);
  if (index === -1) throw new CapyError('variable not found', ERROR_CODES.VARIABLE_NOT_FOUND);
  const raw = lines[index].slice(name.length + 1);
  const plaintext = new FileManager().decryptValue(raw, projectKey);
  return { lines, serverKeep, index, plaintext };
}

const withRate = <R>(result: R, rate: RateInfo | undefined): PoolItem<R> => ({ result, ...(rate === undefined ? {} : { rate }) });
const failedItem = (location: SetLocation, err: unknown, rate?: RateInfo): PoolItem<LocationOutcome> =>
  withRate<LocationOutcome>({ kind: 'failed', location, code: codeOf(err) }, rate);

/** One location: read the current branch, replace `name`, push, write the cache. Never throws; reports the rate-limit reading it saw. */
async function pushLocation(env: SetEnv, keys: KeyResolver, loc: SetLocation, name: string, value: string): Promise<PoolItem<LocationOutcome>> {
  const key = await settled(keys(loc.project_id));
  if (!key.ok) return failedItem(loc, key.error);
  const read = await callWithBackoff((onRate) => env.client.getDecryptData(loc.project_id, loc.branch, undefined, true, onRate), env.sleep);
  if (!read.ok) return failedItem(loc, read.error, read.rate);
  const current = attempt(() => currentFrom(read.value, name, key.value));
  if (!current.ok) return failedItem(loc, current.error, read.rate);
  if (current.value.plaintext === value) return withRate<LocationOutcome>({ kind: 'unchanged', location: loc }, read.rate);

  const write = attempt(() => {
    const existing = current.value.serverKeep.variables[name]?.find((e) => e.branch === loc.branch);
    const resourceId = existing?.resource_id ?? deriveResourceId(loc.branch, name);
    const newLine = `${name}=capy:${resourceId}:${Encryptor.encrypt(value, key.value)}`;
    return {
      envBlob: current.value.lines.map((l, i) => (i === current.value.index ? newLine : l)).join('\n'),
      merged: new SyncEngine().mergeWithKeep(
        current.value.serverKeep,
        { [name]: { resource_id: resourceId, value_hash: hashValue(value) } },
        loc.branch,
      ),
    };
  });
  if (!write.ok) return failedItem(loc, write.error, read.rate);

  const pushed = await callWithBackoff(
    (onRate) => env.client.pushSecrets(loc.project_id, JSON.stringify(write.value.merged), write.value.envBlob, loc.branch, onRate),
    env.sleep,
  );
  const rate = mergeRates(read.rate, pushed.rate, (env.now ?? Date.now)());
  if (!pushed.ok) return failedItem(loc, pushed.error, rate);

  const done = attempt(() => {
    env.writeCache(env.orgId, loc.project_id, pushed.value.keep_hash, write.value.envBlob);
    const adopted = SyncEngine.adoptServerKeep(pushed.value.keep_file, write.value.merged, loc.branch);
    return { adopted, entry: adopted.variables[name]?.find((e) => e.branch === loc.branch) };
  });
  if (!done.ok) return failedItem(loc, done.error, rate);
  return withRate<LocationOutcome>(
    done.value.entry === undefined
      ? { kind: 'failed', location: loc, code: ERROR_CODES.SERVICE_ERROR }
      : { kind: 'updated', location: loc, entry: done.value.entry, serverKeep: done.value.adopted },
    rate,
  );
}

export interface LocationPreview {
  readonly action: 'update' | 'unchanged';
  readonly serverKeep: KeepFile | undefined;
}

const UNKNOWN_PREVIEW: LocationPreview = { action: 'update', serverKeep: undefined };

/** One location's dry run. `keysFor` is asked only when a value is given (the only case that needs a key). */
async function previewItem(
  env: SetEnv,
  keysFor: () => KeyResolver,
  loc: SetLocation,
  name: string,
  value: string | undefined,
): Promise<PoolItem<LocationPreview>> {
  const key = value === undefined ? undefined : await settled(keysFor()(loc.project_id));
  if (key !== undefined && !key.ok) return withRate(UNKNOWN_PREVIEW, undefined);
  const read = await callWithBackoff((onRate) => env.client.getDecryptData(loc.project_id, loc.branch, undefined, true, onRate), env.sleep);
  if (!read.ok) return withRate(UNKNOWN_PREVIEW, read.rate);
  if (key === undefined || !key.ok) return withRate({ action: 'update', serverKeep: parseKeepJson(read.value.keep_file) }, read.rate);
  const current = attempt(() => currentFrom(read.value, name, key.value));
  return withRate<LocationPreview>(
    current.ok ? { action: current.value.plaintext === value ? 'unchanged' : 'update', serverKeep: current.value.serverKeep } : UNKNOWN_PREVIEW,
    read.rate,
  );
}

/** Dry run of one location: would pushing `value` change it? `serverKeep` is `undefined` when that cannot be known (no value, or the read failed). */
export async function previewLocation(
  env: SetEnv,
  loc: SetLocation,
  name: string,
  value: string | undefined,
): Promise<LocationPreview> {
  return (await previewItem(env, () => env.openKeys(), loc, name, value)).result;
}

/** Dry run of many locations: ONE unlock, `LOCATION_CONCURRENCY` at a time, in input order. */
export async function previewLocations(
  env: SetEnv,
  locations: readonly SetLocation[],
  name: string,
  value: string | undefined,
): Promise<readonly LocationPreview[]> {
  const keys = value === undefined || locations.length === 0 ? undefined : env.openKeys();
  const pooled = await runPool({
    items: locations,
    limit: LOCATION_CONCURRENCY,
    run: (loc) => previewItem(env, () => keys ?? env.openKeys(), loc, name, value),
    reserve: PACING_RESERVE,
    now: env.now,
    sleep: env.sleep,
  });
  return pooled.results;
}

// ---------------------------------------------------------------------------
// Repos: bases and the PRs
// ---------------------------------------------------------------------------

/** How many per-repo reads run at once when the batched one fails as a whole. */
export const FALLBACK_CONCURRENCY = 6;

const refOf = (t: RepoTarget): RepoRef => ({ owner: t.owner, name: t.name });

/**
 * Each repo's PR base (its default branch), by `repoKey`. A repo whose base cannot
 * be read is left out (an unknown base). ONE batched GraphQL call per 50 repos (see
 * `GithubApi.getDefaultBranches`); only if that call fails as a whole does it fall
 * back to one `getRepo` per repo, `FALLBACK_CONCURRENCY` at a time. It never
 * waits forever: every `gh` call has a timeout, and a TIMEOUT answer (GitHub is
 * stalled) or an aborted `signal` means no base is known and nothing more is tried.
 */
export async function resolveBases(
  github: GithubApi | undefined,
  targets: readonly RepoTarget[],
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  const stopped = (): boolean => signal?.aborted === true;
  if (github === undefined || targets.length === 0 || stopped()) return {};
  const batch = await github.getDefaultBranches(targets.map(refOf), { signal });
  if (!batch.ok && (batch.kind === 'TIMEOUT' || stopped())) return {};
  const bases: readonly (string | null)[] = batch.ok
    ? batch.value
    : (
        await runPool({
          items: targets,
          limit: FALLBACK_CONCURRENCY,
          run: async (t): Promise<PoolItem<string | null>> => {
            if (stopped()) return { result: null };
            const one = await resolveDefaultBase(github, refOf(t));
            return { result: one.ok ? one.base : null };
          },
        })
      ).results;
  return Object.fromEntries(targets.flatMap((t, i) => (bases[i] === null || bases[i] === undefined ? [] : [[repoKey(t), bases[i] as string]])));
}

const refsFor = (outcomes: readonly Extract<LocationOutcome, { kind: 'updated' }>[]): readonly LocationRef[] =>
  outcomes.map((o) => locationRef(o.location));

type RepoOutcome =
  | { readonly kind: 'pr'; readonly pr: PrResult }
  | { readonly kind: 'no_pr'; readonly repo: string }
  | { readonly kind: 'failed'; readonly repo: string; readonly code: string };

async function openRepoPr(
  env: SetEnv,
  target: RepoTarget,
  name: string,
  updated: readonly Extract<LocationOutcome, { kind: 'updated' }>[],
  base: string | undefined,
): Promise<RepoOutcome | undefined> {
  const label = repoLabel(target);
  const inRepo = (o: { readonly location: SetLocation }) => target.files.some((f) => f.project_id === o.location.project_id);
  const pushed = updated.filter(inRepo);
  if (pushed.length === 0) return undefined;

  const github = env.github();
  if (github === undefined) return { kind: 'failed', repo: label, code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE };

  const specs = target.files
    .map((file) => ({ file, mine: pushed.filter((o) => o.location.project_id === file.project_id) }))
    .filter(({ mine }) => mine.length > 0)
    .map(({ file, mine }): KeepLockFileSpec => ({
      path: keepLockPathOf(file.path),
      records: mine.map((o): EditSaveRecord => ({ branch: o.location.branch, entries: [{ variable: name, entry: o.entry }] })),
      localKeep: mine[0].serverKeep,
    }));

  const repo: RepoRef = { owner: target.owner, name: target.name };
  const opened = await openKeepLockPullRequest(
    { command: 'secrets', repo, files: specs, base },
    { github, branchName: env.branchName },
  );
  if (!opened.ok) {
    return opened.reason === 'NO_DIFF_VS_BASE'
      ? { kind: 'no_pr', repo: label }
      : { kind: 'failed', repo: label, code: opened.code };
  }

  const diverged = specs.some((spec, i) => {
    const before = opened.bases[i];
    const file = target.files.find((f) => keepLockPathOf(f.path) === spec.path);
    const mine = pushed.filter((o) => o.location.project_id === file?.project_id);
    return before.existed && mine.some((o) => keepDiverged(before.keep, o.serverKeep, name, [o.location.branch]));
  });
  return {
    kind: 'pr',
    pr: {
      repo: label,
      url: opened.pr_url,
      base: opened.base,
      keep_lock_paths: opened.paths,
      keep_lock_diverged: diverged,
      locations: refsFor(pushed),
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type Pushed = Extract<LocationOutcome, { kind: 'updated' }>;

/** Never called: stands in for the resolver of a run that pushes nothing. */
const NO_KEYS: KeyResolver = async () => {
  throw new CapyError('no keys were opened', ERROR_CODES.SERVICE_ERROR);
};

/**
 * Pushes `req.value` to every location, `LOCATION_CONCURRENCY` at a time after ONE
 * unlock, then opens one PR per repo (`PR_CONCURRENCY` at a time) for the locations
 * that were actually pushed. One failure never blocks another, and nothing here waits
 * forever (every GitHub call has a timeout, every service call too; a rate limit is
 * waited out a bounded number of times). `hooks` reports progress and lets the caller
 * stop: a stop starts nothing further and lets every item already running finish;
 * what it left unstarted is in `cancelled`. Everything in the result is in input order.
 */
export async function runSecretSet(req: SetRequest, env: SetEnv, hooks: RunHooks = {}): Promise<SecretSetResult> {
  const keys = req.locations.length === 0 || hooks.stopPushes?.aborted === true ? NO_KEYS : env.openKeys();
  const pushed = await runPool({
    items: req.locations,
    limit: LOCATION_CONCURRENCY,
    run: (loc) => pushLocation(env, keys, loc, req.name, req.value),
    stop: hooks.stopPushes,
    reserve: PACING_RESERVE,
    now: env.now,
    sleep: env.sleep,
    onChange: (p) => hooks.onProgress?.({ phase: 'pushing', ...p }),
    onStopping: (inFlight) => hooks.onStopping?.({ phase: 'pushing', inFlight }),
  });
  const outcomes = pushed.results;
  const updated = outcomes.filter((o): o is Pushed => o.kind === 'updated');
  const failedLocations = outcomes.flatMap((o): FailedItem[] =>
    o.kind === 'failed' ? [{ kind: 'location', ...locationRef(o.location), code: o.code }] : [],
  );

  // Only repos with a pushed location get a PR. A caller that read the default branches passes them (even an empty
  // map: then each PR resolves its own base, bounded); one that did not gets ONE batched read, not one `gh` call each.
  const planned = req.repos.filter((t) => updated.some((o) => t.files.some((f) => f.project_id === o.location.project_id)));
  const bases = req.bases ?? (planned.length > 0 ? await resolveBases(env.github(), planned, hooks.stopPrs) : {});

  const opened = await runPool({
    items: planned,
    limit: PR_CONCURRENCY,
    run: async (target): Promise<PoolItem<RepoOutcome | undefined>> => ({
      result: await openRepoPr(env, target, req.name, updated, bases[repoKey(target)]),
    }),
    stop: hooks.stopPrs,
    onChange: (p) => hooks.onProgress?.({ phase: 'prs', ...p }),
    onStopping: (inFlight) => hooks.onStopping?.({ phase: 'prs', inFlight }),
  });
  const present = opened.results.flatMap((o) => (o === undefined ? [] : [o]));

  const cancelled: readonly CancelledItem[] = [
    ...pushed.cancelled.map((l): CancelledItem => ({ kind: 'location', ...locationRef(l) })),
    ...opened.cancelled.map((t): CancelledItem => ({ kind: 'repo', repo: repoLabel(t) })),
  ];

  return {
    name: req.name,
    updated: refsFor(updated),
    unchanged: outcomes.flatMap((o) => (o.kind === 'unchanged' ? [locationRef(o.location)] : [])),
    prs: present.flatMap((o) => (o.kind === 'pr' ? [o.pr] : [])),
    no_pr: present.flatMap((o) => (o.kind === 'no_pr' ? [{ repo: o.repo, reason: 'NO_DIFF_VS_BASE' as const }] : [])),
    failed: [
      ...failedLocations,
      ...present.flatMap((o): FailedItem[] => (o.kind === 'failed' ? [{ kind: 'repo', repo: o.repo, code: o.code }] : [])),
    ],
    ...(cancelled.length > 0 ? { cancelled } : {}),
  };
}

// ---------------------------------------------------------------------------
// Real environment
// ---------------------------------------------------------------------------

/** The real GitHub API through the user's own `gh` login, or `undefined` when `gh` is not installed. */
export function realGithub(): GithubApi | undefined {
  const gh = resolveGh();
  // Asynchronous: the screen keeps drawing (and reading keys) while `gh` runs, and calls can overlap.
  return gh === null ? undefined : createGhApi(spawnGhRunnerAsync(gh));
}

/** The real `SetEnv`: one unlock per run through the same co-decrypt path `capy edit` uses, the real cache, the real `gh`. */
export function createSetEnv(orgId: string, userId: string, client: ServiceClient): SetEnv {
  return {
    client,
    orgId,
    openKeys: () =>
      createRunKeyResolver(orgId, userId, {
        // The unlock is one call: a 429 on it is waited out (bounded) before every location fails with the same code.
        coDecrypt: (oid, ct) => retryOnRateLimit(() => client.coDecrypt(oid, ct).then((r) => r.plaintext)),
        wrapOuterLayer: (oid, pt) => client.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
      }),
    writeCache: writeKeepCache,
    github: realGithub,
    branchName: () => newPrBranchName(),
  };
}

/**
 * Dry run: would the PR for `target` carry a keep.lock that disagrees with the
 * server's about other variables? Read-only. `false` when GitHub cannot be read
 * or the server's keep is unknown.
 */
export async function previewDivergence(
  github: GithubApi | undefined,
  target: RepoTarget,
  base: string | undefined,
  name: string,
  previews: ReadonlyArray<{ readonly location: SetLocation; readonly serverKeep: KeepFile | undefined }>,
): Promise<boolean> {
  if (github === undefined || base === undefined) return false;
  const files = target.files.filter((f) => previews.some((p) => p.location.project_id === f.project_id));
  if (files.length === 0) return false;
  const specs = files.map((f): KeepLockFileSpec => ({
    path: keepLockPathOf(f.path),
    records: [],
    localKeep: { version: '3.0', org_id: '', project_id: f.project_id, project_name: f.project_name, variables: {} },
  }));
  const read = await readKeepLockBases(github, { owner: target.owner, name: target.name }, base, specs);
  if (!read.ok) return false;
  return files.some((f, i) => {
    const before = read.bases[i];
    return (
      before.existed &&
      previews
        .filter((p) => p.location.project_id === f.project_id && p.serverKeep !== undefined)
        .some((p) => keepDiverged(before.keep, p.serverKeep as KeepFile, name, [p.location.branch]))
    );
  });
}
