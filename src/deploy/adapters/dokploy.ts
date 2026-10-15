/**
 * Dokploy Application/Compose adapter.
 *
 * CAP-682: delivery is PLAIN VALUES, not `_SECRETS_BLOB`/`_PROJECT_KEY` — no
 * deploy token is minted for Dokploy (`needsDeployToken: false`). Each
 * delivered var is written as its own `KEY=value` line inside Capy's managed
 * block, and every pre-existing ACTIVE line outside the block that defines
 * the same name is commented out (never deleted) with a stable marker, so
 * the platform never reads two definitions of one var — see
 * `dokployApi.ts`'s "Plaintext delivery" section
 * (`mergeManagedValuesBlock`/`syncCommentedLines`) for the byte-exact
 * mechanics. The app reads these values directly from its own process
 * environment; there is no `capy run` decrypt step for a Dokploy target.
 *
 * Default mode is CI (a keep.lock PR; merging it is the deploy signal and
 * triggers Dokploy's OWN auto-deploy — Capy never calls `compose.redeploy`/
 * `application.deploy` in that mode). Direct mode remains available and
 * still triggers + polls a real deploy, exactly as before.
 *
 * Dokploy stores an Application's environment as one text blob (plus
 * buildArgs / buildSecrets / createEnvFile) and only offers a whole-object
 * write, so every update is read → merge → write. Capy owns exactly one
 * marked block inside `env`; every other line is carried through verbatim
 * (or commented, per the above — never deleted). The write is NOT atomic per
 * key — a dashboard edit landing between our read and our write is lost. We
 * re-read after the write and fail loudly when the stored env is not the one
 * we wrote, AND when `dotenv.parse` of the stored env does not resolve every
 * delivered name to Capy's own value.
 *
 * Deploys are meant to be REVERSIBLE: Capy never deletes anything outside its
 * own block, so removing the block (by hand, or via `capy deploy
 * targets-remove`'s offer) returns the env to exactly its prior config,
 * byte-for-byte — including un-commenting whatever Capy commented.
 *
 * The API token is never written to `.capy/deploy.json`. The target stores
 * the NAME of the environment variable that holds it (default
 * DOKPLOY_API_KEY), read at deploy time.
 */
import {
  AdapterCallContext,
  DeployAdapter,
  DeployContext,
  DeployResult,
  DeployStep,
  DeployWarning,
  DetectedDefaults,
  PreflightResult,
  RemoveOfferContext,
  RemoveOfferResult,
  TargetConfig,
} from '../adapter';
import { ERROR_CODES, ErrorCode } from '../../types/index';
import {
  CAPY_OFF_MARKER,
  DEFAULT_TOKEN_ENV,
  DOKPLOY_CONNECTOR_SECRET_NAME,
  DOKPLOY_TARGET_SECRET_NAME,
  DokployApiError,
  DokployClient,
  DokployCompose,
  DokployDeployment,
  DokploySystemStoreCallOptions,
  FetchLike,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  ResolveDokployApiKeyResult,
  RUNTIME_PAIR,
  apiBase,
  createDokployClient,
  describeComposeEnvFileDisabled,
  describeDokployPlainMergeProblem,
  describeDokployTokenProblem,
  describeEnvProblem,
  describeEnvWarning,
  dokploySecretsMayPrompt,
  dokployVersionAtLeast,
  envKeys,
  envProblems,
  envWarnings,
  hasCommentedLines,
  mergeManagedBlock,
  mergeManagedValuesBlock,
  mismatchedDeliveredValues,
  outsideLines,
  removeManagedValuesBlock,
  resolveDokployApiKey,
  resolveDokployToken,
  sortedCopy,
  splitManagedBlock,
  stripManagedBlock,
  trackedGitBranch,
  watchPathsExcludeKeep,
} from '../dokployApi';
import { repoRelPath } from '../git';

/** Below this, a `composeType: 'stack'` target gets a WARNING, never a refusal — see `describeStackVersionWarning`. */
const STACK_ENV_FILE_FIX_VERSION = 'v0.30.3';

// Re-exported for back-compat: callers (tests, deployCommand.ts) import the
// client + env-merge primitives from this module today. New code should
// import them from `dokployApi` directly.
export {
  CAPY_OFF_MARKER,
  DEFAULT_TOKEN_ENV,
  DokployApiError,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  apiBase,
  createDokployClient,
  describeComposeEnvFileDisabled,
  describeDokployPlainMergeProblem,
  describeDokployTokenProblem,
  describeEnvProblem,
  describeEnvWarning,
  dokploySecretsMayPrompt,
  dokployVersionAtLeast,
  envKeys,
  envProblems,
  envWarnings,
  hasCommentedLines,
  mergeManagedBlock,
  mergeManagedValuesBlock,
  mismatchedDeliveredValues,
  outsideLines,
  removeManagedValuesBlock,
  resolveDokployApiKey,
  resolveDokployToken,
  splitManagedBlock,
  stripManagedBlock,
  trackedGitBranch,
  watchPathsExcludeKeep,
};
export type {
  DokployApplication,
  DokployClient,
  DokployCompose,
  DokployDeployment,
  DokployDeploymentStatus,
  DokployErrorCode,
  DokploySystemStoreCallOptions,
  DotenvEntry,
  EnvMergeProblem,
  EnvMergeProblemCode,
  EnvSplit,
  EnvWarning,
  EnvWarningCode,
  FetchLike,
  ImportableEnvEntry,
  ImportSkipReason,
  ResolveDokployApiKeyResult,
} from '../dokployApi';

export interface DokployOptions {
  /** Dokploy dashboard URL, e.g. https://dokploy.example.com. `/api` is appended. */
  baseUrl: string;
  /**
   * Application id from the Dokploy dashboard URL / API. Mutually exclusive
   * with `composeId` (CAP-679) — a target configures exactly one of the two,
   * matching whichever kind of Dokploy service it points at.
   */
  applicationId?: string;
  /**
   * Compose service id from the Dokploy dashboard URL / API (CAP-679).
   * Mutually exclusive with `applicationId`.
   */
  composeId?: string;
  /**
   * Name of the environment variable holding the Dokploy API token —
   * OPTIONAL (CAP-664). When set, an explicit env var still wins outright;
   * when absent, the org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry
   * (falling back to `$DOKPLOY_API_KEY`) is the source. See
   * `dokployApi.ts#resolveDokployApiKey`.
   */
  tokenEnv?: string;
  /** How long to wait for the deployment to finish. Defaults to 600. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 3000;

// ── Polling ────────────────────────────────────────────────────────────────

export type DeploymentOutcome =
  | { kind: 'succeeded'; deployment: DokployDeployment }
  | { kind: 'failed'; deployment: DokployDeployment }
  | { kind: 'timed_out'; deployment: DokployDeployment | null };

export interface PollDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onRunning?: (d: DokployDeployment) => void;
}

/**
 * Wait for the deployment our trigger created. Dokploy's deploy call returns
 * no id, so "ours" is the newest deployment whose id was not in the list
 * taken just before the trigger. `list` is a thunk rather than a
 * `(client, id)` pair so ONE poll loop serves both Applications
 * (`client.listDeployments`) and Compose services (CAP-679,
 * `client.listComposeDeployments`) — see `pollApplicationDeployment` /
 * `pollComposeDeployment` below.
 */
export async function pollDeployment(
  list: () => Promise<readonly DokployDeployment[]>,
  before: ReadonlySet<string>,
  deadline: number,
  deps: PollDeps,
  seenRunning: boolean = false,
): Promise<DeploymentOutcome> {
  const rows = await list();
  const ours =
    sortedCopy(
      rows.filter((d) => !before.has(d.deploymentId)),
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    )[0] ?? null;
  if (ours?.status === 'done') return { kind: 'succeeded', deployment: ours };
  if (ours?.status === 'error' || ours?.status === 'cancelled') {
    return { kind: 'failed', deployment: ours };
  }
  if (ours && !seenRunning) deps.onRunning?.(ours);
  if (deps.now() >= deadline) return { kind: 'timed_out', deployment: ours };
  await deps.sleep(POLL_INTERVAL_MS);
  return pollDeployment(list, before, deadline, deps, seenRunning || !!ours);
}

/** `pollDeployment`, bound to an Application's deployments. */
export function pollApplicationDeployment(
  client: DokployClient,
  applicationId: string,
  before: ReadonlySet<string>,
  deadline: number,
  deps: PollDeps,
): Promise<DeploymentOutcome> {
  return pollDeployment(() => client.listDeployments(applicationId), before, deadline, deps);
}

/** `pollDeployment`, bound to a Compose service's deployments (CAP-679). */
export function pollComposeDeployment(
  client: DokployClient,
  composeId: string,
  before: ReadonlySet<string>,
  deadline: number,
  deps: PollDeps,
): Promise<DeploymentOutcome> {
  return pollDeployment(() => client.listComposeDeployments(composeId), before, deadline, deps);
}

// ── Adapter ────────────────────────────────────────────────────────────────

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise as a value, so each call site branches without try/catch. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Why a Dokploy URL is unusable, or null. Shared with the setup prompts. */
export function baseUrlProblem(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return 'required';
  const url = parseUrl(raw.trim());
  if (!url) return 'not a URL';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return 'must start with https://';
  }
  return null;
}

/**
 * Why a token variable name is unusable, or null. Shared with the setup
 * prompts, where an EMPTY answer is still a mistake — required there. The
 * FIELD itself is optional (CAP-664): see `optionsProblem`, which only calls
 * this when `tokenEnv` is actually present.
 */
export function tokenEnvProblem(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return 'required';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.trim()) ? null : 'not a valid environment variable name';
}

/** Which kind of Dokploy service a parsed/verified URL points at. */
export type DokployServiceKind = 'compose' | 'application';

export interface DokployServiceUrlOk {
  ok: true;
  baseUrl: string;
  kind: DokployServiceKind;
  id: string;
}

export interface DokployServiceUrlErr {
  ok: false;
  /** Stable code — branch on this, never on `reason` (Rule 5). */
  code: typeof ERROR_CODES.DOKPLOY_URL_INVALID;
  /** Human-readable, for display only. */
  reason: string;
}

export type DokployServiceUrlParse = DokployServiceUrlOk | DokployServiceUrlErr;

/**
 * Every Dokploy dashboard route shape a service's "view" page has shipped
 * with, confirmed against Dokploy's own source (github.com/Dokploy/dokploy):
 *
 *  - v0.30.0 (current, `apps/dokploy/pages/dashboard/project/[projectId]/
 *    environment/[environmentId]/services/{compose,application}/[id].tsx`):
 *    `.../dashboard/project/:projectId/environment/:environmentId/services/(compose|application)/:id`
 *  - v0.20.0 and earlier (before Dokploy's "environments" feature existed;
 *    `apps/dokploy/pages/dashboard/project/[projectId]/services/{compose,
 *    application}/[id].tsx` at that tag): same shape MINUS the
 *    `environment/:environmentId` segment.
 *
 * Both are matched by making that segment optional. A capturing prefix
 * before `/dashboard/project/` absorbs a reverse-proxy subpath (Dokploy
 * mounted under e.g. `/tools/dokploy`) into `baseUrl` rather than rejecting
 * it — `apiBase()` (dokployApi.ts) appends `/api` to whatever `baseUrl`
 * ends up being, exactly as it does for a hand-typed one today.
 */
const SERVICE_URL_PATTERN =
  /^(.*)\/dashboard\/project\/[^/]+\/(?:environment\/[^/]+\/)?services\/(compose|application)\/([^/?#]+)\/?$/;

/**
 * Parse a Dokploy dashboard URL — the browser address of a Compose or
 * Application service's page — into the same `{ baseUrl, kind, id }` shape
 * `resolveAdapterOptions`'s Dokploy branch used to ask as three separate
 * questions. Pure: no I/O, no verification — `deployCommand.ts` calls the
 * live `compose.one`/`application.one` check separately, after this parses
 * successfully, using the API key.
 *
 * Accepts http/https (loopback-only for http, same rule as `baseUrlProblem`),
 * any port, a query string or `#hash` (Dokploy's own tab state — e.g.
 * `?tab=environment` — ignored), and a trailing slash. Rejects anything that
 * isn't a URL at all, the wrong scheme, or a path that doesn't match either
 * route shape above — callers fall back to asking for a bare id instead of
 * calling this at all when the input has no `scheme://`.
 */
export function parseDokployServiceUrl(raw: string): DokployServiceUrlParse {
  const trimmed = (raw ?? '').trim();
  const invalid = (reason: string): DokployServiceUrlErr => ({
    ok: false,
    code: ERROR_CODES.DOKPLOY_URL_INVALID,
    reason,
  });
  if (!trimmed) return invalid('required');
  const url = parseUrl(trimmed);
  if (!url) return invalid('not a URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return invalid('must start with https://');
  }
  const match = SERVICE_URL_PATTERN.exec(url.pathname);
  if (!match) {
    return invalid(
      'not a recognized Dokploy service URL — expected .../dashboard/project/<id>/[environment/<id>/]services/(compose|application)/<id>',
    );
  }
  const [, prefix, kindMatch, idMatch] = match;
  const id = decodeURIComponent(idMatch);
  if (!id) return invalid('missing service id');
  return {
    ok: true,
    baseUrl: `${url.protocol}//${url.host}${prefix}`,
    kind: kindMatch as DokployServiceKind,
    id,
  };
}

/**
 * Whether a raw setup-picker answer was meant as a URL at all — a leading
 * `scheme://`, same test browsers use to decide "this is an address, not a
 * search term". `capy deploy`'s picker uses this to route: a bare id
 * (nothing that looks like a URL) falls back to asking kind + base URL
 * exactly as before `parseDokployServiceUrl` existed; anything that DOES
 * look like a URL goes through `parseDokployServiceUrl` and, on a match
 * failure, is refused (`DOKPLOY_URL_INVALID`) and re-asked rather than
 * silently treated as an id.
 */
export function looksLikeUrl(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim());
}

/**
 * The subset of a live `compose.one`/`application.one` response the setup
 * picker shows back to the user to confirm before saving (CAP-657 follow-up:
 * "verify, don't just parse"). `environmentId` alone is rarely a human-
 * readable label — see `resolveDokployEnvironmentLabel`, which turns it into
 * one via `project.all` on a best-effort basis.
 */
export interface DokployServiceVerification {
  name?: string;
  appName?: string;
  environmentId?: string;
}

/**
 * Verify a parsed URL's `{ kind, id }` actually names a live service, using
 * the resolved Dokploy API key — the same read the deploy/preflight path
 * already does, just run once more, up front, so the picker can show a name
 * to confirm instead of saving an id nobody has looked at. Returns the
 * underlying `DokployApiError` on failure (never throws it) so the caller
 * can branch on its stable `.code` (`'not_found'` → refuse + re-ask;
 * anything else → best-effort skip, never a hard block — see
 * `resolveDokployServiceOptions` in deployCommand.ts).
 */
export async function verifyDokployService(
  client: DokployClient,
  kind: DokployServiceKind,
  id: string,
): Promise<{ ok: true; value: DokployServiceVerification } | { ok: false; error: DokployApiError }> {
  try {
    const service = kind === 'compose' ? await client.getCompose(id) : await client.getApplication(id);
    return {
      ok: true,
      value: { name: service.name, appName: service.appName, environmentId: service.environmentId },
    };
  } catch (err) {
    if (err instanceof DokployApiError) return { ok: false, error: err };
    throw err;
  }
}

/**
 * Best-effort "<project> · <environment>" label for a verified service's
 * `environmentId`, resolved via `project.all` (the only call that knows
 * project/environment NAMES — `compose.one`/`application.one` return only
 * the id). Never throws and never blocks the picker: a listing failure (rate
 * limit, a permission scope without `project:read`, …) just means the
 * confirmation line shows the service name alone.
 */
export async function resolveDokployEnvironmentLabel(
  client: DokployClient,
  environmentId: string | undefined,
): Promise<string | undefined> {
  if (!environmentId) return undefined;
  try {
    const projects = await client.listProjects();
    for (const project of projects) {
      const env = project.environments.find((e) => e.environmentId === environmentId);
      if (env) return `${project.name} · ${env.name}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this target's config is broken badly enough that even TALKING to
 * Dokploy (or asking for a token first) would be pointless: an unusable
 * `baseUrl`, a missing `applicationId`, or a malformed `tokenEnv`.
 *
 * Deliberately narrower than `optionsProblem`: `vars`/`timeoutSeconds` are
 * DEPLOY-time concerns that say nothing about whether the target is even
 * reachable. `resolveDokployApiKeyOnce` (`deployCommand.ts`) uses THIS check
 * — not `optionsProblem` — to decide whether to resolve (and possibly
 * prompt for) a token at all, because `onRemove` has no vars to ship and
 * must still be able to reach a target `optionsProblem` would otherwise
 * reject on that basis alone.
 */
export function dokployConnectionProblem(config: TargetConfig): PreflightResult | null {
  const opts = config.options as Partial<DokployOptions>;
  const hint = 'Run `capy deploy --edit ' + config.name + '` to fix.';
  const urlProblem = baseUrlProblem(opts.baseUrl);
  if (urlProblem) return { ok: false, reason: `dokploy baseUrl: ${urlProblem}`, hint };
  const hasAppId = !!opts.applicationId && !!opts.applicationId.trim();
  const hasComposeId = !!opts.composeId && !!opts.composeId.trim();
  if (hasAppId && hasComposeId) {
    return {
      ok: false,
      reason: 'dokploy target has both applicationId and composeId — exactly one is allowed',
      hint,
    };
  }
  if (!hasAppId && !hasComposeId) {
    // Preserves the pre-CAP-679 substring ("applicationId: required") that
    // existing callers match on, while covering the new alternative.
    return { ok: false, reason: 'dokploy applicationId: required (or composeId)', hint };
  }
  // tokenEnv is OPTIONAL (CAP-664) — the org system store is the default
  // source now (see `resolveDokployApiKey`). When one IS set (an explicit
  // `--token-env`, or a target saved before the system store existed), its
  // FORMAT still has to be a valid variable name.
  if (opts.tokenEnv && opts.tokenEnv.trim()) {
    const envProblem = tokenEnvProblem(opts.tokenEnv);
    if (envProblem) return { ok: false, reason: `dokploy tokenEnv: ${envProblem}`, hint };
  }
  return null;
}

/** Config-shape problems, checked before any network call. */
export function optionsProblem(config: TargetConfig): PreflightResult | null {
  const connectionProblem = dokployConnectionProblem(config);
  if (connectionProblem) return connectionProblem;
  const opts = config.options as Partial<DokployOptions>;
  const hint = 'Run `capy deploy --edit ' + config.name + '` to fix.';
  if (
    opts.timeoutSeconds !== undefined &&
    !(Number.isInteger(opts.timeoutSeconds) && opts.timeoutSeconds > 0)
  ) {
    return { ok: false, reason: 'dokploy timeoutSeconds: must be a positive whole number', hint };
  }
  if (config.vars.length === 0) {
    return {
      ok: false,
      reason: 'dokploy target has no vars to ship',
      hint: 'Re-run with `--edit` and select at least one var.',
    };
  }
  return null;
}

/**
 * CI-mode-only preflight (CAP-682): whether merging the deploy PR would
 * actually reach Dokploy's own auto-deploy at all. Checked AFTER the env is
 * readable (so a broken env still reports that problem first) but before
 * any write — refusing here costs nothing, since CI mode never triggers a
 * deploy itself either way. `null` (and skipped entirely) for direct mode,
 * where none of this applies: Capy itself calls `application.deploy`/
 * `compose.redeploy` directly.
 */
export function dokployCiPreflightProblem(
  config: TargetConfig,
  /** keep.lock's path relative to the repo root (`keep.lock`, or `<folder>/keep.lock`): what the service's watch paths must cover. */
  relKeep: string,
  entity: { autoDeploy?: boolean | null; branch?: string; customGitBranch?: string | null; watchPaths?: readonly string[] | null },
): PreflightResult | null {
  if (config.mode !== 'ci') return null;
  const hint = `Run \`capy deploy --edit ${config.name}\` to fix, or switch this target to direct mode.`;
  if (entity.autoDeploy !== true) {
    return {
      ok: false,
      code: ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF,
      // COPY-FLAG: minimal neutral wording.
      reason: 'this Dokploy service has auto-deploy turned off, so merging the deploy PR would never trigger a deploy',
      hint: `Turn on "Auto Deploy" for this service in the Dokploy dashboard, or switch this target to direct mode (\`capy deploy --edit ${config.name}\`).`,
    };
  }
  const tracked = trackedGitBranch(entity);
  const base = config.gitBaseBranch;
  if (!base || !tracked || tracked !== base) {
    return {
      ok: false,
      code: ERROR_CODES.DOKPLOY_BRANCH_MISMATCH,
      // COPY-FLAG: minimal neutral wording.
      reason: tracked
        ? `this Dokploy service tracks git branch "${tracked}", not this target's PR base "${base ?? '(unset)'}"`
        : `this Dokploy service has no tracked git branch Capy could confirm against this target's PR base "${base ?? '(unset)'}"`,
      hint,
    };
  }
  if (watchPathsExcludeKeep(entity.watchPaths, relKeep)) {
    return {
      ok: false,
      code: ERROR_CODES.DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP,
      // COPY-FLAG: minimal neutral wording.
      reason: `this Dokploy service's watch paths don't cover ${relKeep}, so merging the deploy PR would never trigger a deploy`,
      hint: `Add ${relKeep} to this service's watch paths in the Dokploy dashboard, or switch this target to direct mode.`,
    };
  }
  return null;
}

/**
 * keep.lock's repo-relative path for a preflight: the caller's own (`keepLockPath`, a caller with no
 * checkout such as the batch deploy), else worked out from `cwd` with git, as `capy deploy` always did.
 */
function keepLockPathFor(ctx: { cwd: string; keepLockPath?: string }): string {
  return ctx.keepLockPath ?? repoRelPath(ctx.cwd, 'keep.lock');
}

/** A failed Dokploy call as a reason (and fix-it hint) a person can act on. */
export function explainApiError(
  err: unknown,
  what: string,
  opts: DokployOptions,
): { reason: string; hint?: string } {
  if (!(err instanceof DokployApiError)) {
    return { reason: `${what}: ${err instanceof Error ? err.message : String(err)}` };
  }
  switch (err.code) {
    case 'unauthorized':
      return {
        reason: `${what}: Dokploy rejected the API token in $${opts.tokenEnv} (HTTP ${err.status})`,
        hint: `Create an API token in the Dokploy dashboard and export it as ${opts.tokenEnv}.`,
      };
    case 'not_found':
      return opts.composeId
        ? {
            reason: `${what}: no Dokploy compose service ${opts.composeId} at ${opts.baseUrl}`,
            hint: 'Check the compose id — it is part of the service URL in the Dokploy dashboard.',
          }
        : {
            reason: `${what}: no Dokploy application ${opts.applicationId} at ${opts.baseUrl}`,
            hint: 'Check the application id — it is part of the application URL in the Dokploy dashboard.',
          };
    default:
      return { reason: `${what}: ${err.message}` };
  }
}

/**
 * CAP-679 (follow-up): `composeType: 'stack'` on a Dokploy below v0.30.3
 * ships `env_file` values — every one in the file — to containers with
 * literal quotes (upstream fix d1830182). WARN, never refuse: Capy cannot
 * fix this on the Dokploy side, and the same problem already affects every
 * other var in the file.
 *
 * CAP-682: Capy's own delivered values are now PLAIN `KEY=value` lines like
 * everything else in the file — there is no more `capy run` decrypt step to
 * apply a mitigation on the container side, so this bug now affects Capy's
 * own values exactly the same as any other var in an old stack compose (the
 * text below was reworded for that — the code (`DOKPLOY_STACK_QUOTES`)
 * stays the same).
 *
 * The version check itself can fail two ways, and both are now WARNED about
 * rather than silently skipped (`null`) as before — guessing "not old" when
 * the version genuinely couldn't be read would hide a real risk:
 *   - the version can't be read/parsed at all → `DOKPLOY_VERSION_UNKNOWN`.
 *   - it CAN be read and is below the fix version → `DOKPLOY_STACK_QUOTES`.
 * `null` only when the compose isn't a `stack` at all — the version is never
 * even fetched in that case (see the tests: "docker-compose never checks the
 * version").
 */
async function composeStackVersionWarning(
  client: DokployClient,
  compose: DokployCompose,
): Promise<DeployWarning | null> {
  if (compose.composeType !== 'stack') return null;
  const version = await settle(client.getDokployVersion());
  if (!version.ok || version.value === null) {
    return {
      code: ERROR_CODES.DOKPLOY_VERSION_UNKNOWN,
      names: [],
      // COPY-FLAG: minimal neutral wording (unchanged by CAP-682 — see this
      // function's own doc).
      message:
        `could not read this Dokploy instance's version — this is a "stack" (Swarm) service, and env_file ` +
        `values may reach containers with literal quotes on Dokploy below ${STACK_ENV_FILE_FIX_VERSION}. ` +
        `The container's \`capy\` must be at least the release that strips a quote layer from ` +
        `_SECRETS_BLOB/_PROJECT_KEY (\`capy run\`) to be safe either way.`,
    };
  }
  if (dokployVersionAtLeast(version.value, STACK_ENV_FILE_FIX_VERSION)) return null;
  return {
    code: ERROR_CODES.DOKPLOY_STACK_QUOTES,
    names: [],
    // COPY-FLAG: reworded for CAP-682 (plain-value delivery) — minimal neutral wording.
    message:
      `this is a Dokploy "stack" (Swarm) service on ${version.value}, below ${STACK_ENV_FILE_FIX_VERSION} — ` +
      `env_file values, including the ones Capy just wrote, arrive at the container wrapped in literal ` +
      `quotes. Capy delivers plain values here now, so your app needs to strip the surrounding quotes ` +
      `itself until this Dokploy instance is upgraded.`,
  };
}

export interface DokployAdapterDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /**
   * Reads the org system store's Dokploy key — see
   * `dokployApi.ts#ResolveDokployApiKeyDeps`. Defaults to a no-op (never
   * touches the network), so a caller that constructs this adapter WITHOUT
   * this dep — every existing test, and any future direct call that doesn't
   * pre-resolve via `ctx.resolvedApiKey` — keeps the exact pre-CAP-664
   * env-only behavior. The real store is wired explicitly on the exported
   * `dokployAdapter` singleton below, and by `deployCommand.ts`'s own
   * pre-resolution (which is what production actually calls through).
   */
  getConnectorSecret?: (name: string, opts: DokploySystemStoreCallOptions) => Promise<string | null>;
}

function lastLogLines(logs: string, n = 30): string {
  return logs
    .trimEnd()
    .split('\n')
    .slice(-n)
    .map((l) => `    ${l}`)
    .join('\n');
}

/**
 * Printed once a plain-value Dokploy deploy succeeds (CAP-682). No deploy
 * token is minted for Dokploy anymore, so there is nothing to `capy deploy
 * revoke` — undo is `capy deploy targets-remove`, which removes Capy's block
 * and un-comments whatever it commented, restoring the env exactly.
 */
// COPY-FLAG: new user-facing string, minimal/neutral wording.
export function plainDeliveryEpilogue(targetName: string): string {
  return [
    '  Values are live in the Dokploy environment now — your app reads them',
    '  directly from its own process environment. No `capy run` step needed.',
    '',
    `  To undo this delivery:  capy deploy targets-remove ${targetName}`,
    "  That removes Capy's block and restores any line it commented out.",
  ].join('\n');
}

/** One line, printed either way, for `onRemove`'s manual fallback. */
function manualStripHint(opts: DokployOptions): string {
  return opts.composeId
    ? `In the Dokploy dashboard, open Compose → Environment for ${opts.composeId}, ` +
        `delete the block between "${MANAGED_BEGIN}" and "${MANAGED_END}" (inclusive), and save.`
    : `In the Dokploy dashboard, open Application → Environment for ` +
        `${opts.applicationId}, delete the block between "${MANAGED_BEGIN}" and ` +
        `"${MANAGED_END}" (inclusive), and save.`;
}

/**
 * `config.vars` resolved against the decrypted branch `env` — the plain
 * values BOTH the Application and Compose write paths deliver. Shared so
 * "a selected var is missing from this branch" is one failure mode, not two.
 */
function deliveredValuesFor(
  config: TargetConfig,
  env: Record<string, string>,
): { ok: true; values: ReadonlyArray<{ name: string; value: string }> } | { ok: false; missing: readonly string[] } {
  const missing = config.vars.filter((name) => !(name in env));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, values: config.vars.map((name) => ({ name, value: env[name] })) };
}

/**
 * The Compose sequence (CAP-679, plain-value delivery per CAP-682): read →
 * refuse on `createEnvFile: false` → merge delivered vars as plain values
 * into the Capy block, commenting/un-commenting matching outside lines,
 * byte-exact everywhere else → `compose.saveEnvironment` → re-read and
 * verify (byte match AND every delivered value reads back exactly via
 * `dotenv.parse`) → CI mode stops here (never calls `compose.redeploy` —
 * merging the PR is what triggers Dokploy's own auto-deploy); direct mode
 * takes a deployments baseline, redeploys, and polls to a real outcome,
 * fetching logs on `error`.
 *
 * Kept as its own function (rather than threaded through the Application
 * `deploy()` body above) so the two never share control flow — the
 * Application path is untouched by this feature.
 */
async function deployComposeFlow(
  client: DokployClient,
  config: TargetConfig,
  ctx: DeployContext,
  opts: DokployOptions,
  composeId: string,
  runtime: { sleep: (ms: number) => Promise<void>; now: () => number; log: (line: string) => void },
): Promise<DeployResult> {
  const { sleep, now, log } = runtime;
  const fail = (
    steps: readonly DeployStep[],
    step: DeployStep,
    epilogue?: string,
  ): DeployResult => ({ ok: false, steps: [...steps, step], ...(epilogue ? { epilogue } : {}) });

  const delivered = deliveredValuesFor(config, ctx.env);
  if (!delivered.ok) {
    return fail([], { label: 'compose.saveEnvironment', status: 'fail', detail: `missing in branch ${config.branch}: ${delivered.missing.join(', ')}` });
  }
  const { values } = delivered;

  // 1. Fresh read.
  const read = await settle(client.getCompose(composeId));
  if (!read.ok) {
    return fail([], { label: 'compose.one', status: 'fail', detail: explainApiError(read.error, 'read', opts).reason });
  }
  const current = read.value;
  const s1: readonly DeployStep[] = [
    { label: 'dokploy compose', status: 'ok', detail: current.name ?? current.composeId },
  ];
  if (current.createEnvFile === false) {
    return fail(s1, {
      label: 'env merge',
      status: 'fail',
      detail: describeComposeEnvFileDisabled().reason,
      code: ERROR_CODES.DOKPLOY_ENV_FILE_DISABLED,
    });
  }
  const problem = envProblems(current.env);
  if (problem) {
    return fail(s1, { label: 'env merge', status: 'fail', detail: describeEnvProblem(problem).reason });
  }
  const stackWarning = await composeStackVersionWarning(client, current);
  const warnings: readonly DeployWarning[] | undefined = stackWarning ? [stackWarning] : undefined;
  const withWarnings = (r: DeployResult): DeployResult => (warnings ? { ...r, warnings } : r);

  const merged = mergeManagedValuesBlock(current.env, values);
  if (!merged.ok) {
    const described = describeDokployPlainMergeProblem(merged.problem);
    return withWarnings(
      fail(s1, {
        label: 'env merge',
        status: 'fail',
        detail: described.reason,
        ...(described.code ? { code: described.code as ErrorCode } : {}),
      }),
    );
  }
  const nextEnv = merged.env;

  // 2. Write.
  const saved = await settle(
    client.saveComposeEnvironment({ composeId: current.composeId, env: nextEnv, createEnvFile: current.createEnvFile }),
  );
  if (!saved.ok) {
    return withWarnings(
      fail(s1, { label: 'compose.saveEnvironment', status: 'fail', detail: explainApiError(saved.error, 'write', opts).reason }),
    );
  }

  // 3. Verify: byte-exact AND every delivered value reads back exactly.
  const reread = await settle(client.getCompose(composeId));
  const byteIntact = reread.ok && reread.value.env === nextEnv && reread.value.createEnvFile === current.createEnvFile;
  if (!byteIntact) {
    return withWarnings(
      fail(s1, {
        label: 'compose.saveEnvironment',
        status: 'fail',
        detail:
          'the stored environment is not what Capy wrote — another edit may have landed at the ' +
          'same moment. Check the Environment tab in Dokploy, then re-run.',
      }),
    );
  }
  const mismatched = mismatchedDeliveredValues(nextEnv, values);
  if (mismatched.length > 0) {
    return withWarnings(
      fail(s1, {
        label: 'compose.saveEnvironment',
        status: 'fail',
        detail: `the stored environment does not read back as written for: ${mismatched.join(', ')}. Check the Environment tab in Dokploy, then re-run.`,
      }),
    );
  }
  const nextSplit = splitManagedBlock(nextEnv);
  const otherVarsCount = 'code' in nextSplit ? 0 : envKeys(outsideLines(nextSplit)).length;
  const s2: readonly DeployStep[] = [
    ...s1,
    { label: 'compose.saveEnvironment', status: 'ok', detail: `${values.length} var(s) written plaintext; ${otherVarsCount} other var(s) kept` },
  ];

  if (ctx.secretsOnly) {
    return withWarnings({
      ok: true,
      steps: [...s2, { label: 'compose.redeploy', status: 'skip', detail: 'CI mode — merging the deploy PR triggers Dokploy’s own auto-deploy' }],
      epilogue: plainDeliveryEpilogue(config.name),
    });
  }
  if (ctx.noDeploy) {
    return withWarnings({
      ok: true,
      steps: [...s2, { label: 'compose.redeploy', status: 'skip', detail: '--no-deploy' }],
      epilogue: plainDeliveryEpilogue(config.name),
    });
  }

  // 4. Baseline — remembered right before the trigger, since Dokploy's
  //    redeploy call returns no id.
  const baseline = await settle(client.listComposeDeployments(composeId));
  if (!baseline.ok) {
    return withWarnings(
      fail(s2, { label: 'deployment.allByCompose', status: 'fail', detail: explainApiError(baseline.error, 'list', opts).reason }),
    );
  }

  // 5. Redeploy — never `compose.deploy` (re-clones the branch head), never `freshVolumes`.
  const triggered = await settle(client.redeployCompose(composeId, `capy deploy ${config.name}`));
  if (!triggered.ok) {
    return withWarnings(
      fail(s2, { label: 'compose.redeploy', status: 'fail', detail: explainApiError(triggered.error, 'trigger', opts).reason }),
    );
  }
  const s3: readonly DeployStep[] = [...s2, { label: 'compose.redeploy', status: 'ok', detail: 'accepted' }];
  log('  · deployment accepted — waiting for Dokploy…');

  // 6. Poll to a real outcome.
  const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const polled = await settle(
    pollComposeDeployment(
      client,
      composeId,
      new Set(baseline.value.map((d) => d.deploymentId)),
      now() + timeoutMs,
      { sleep, now, onRunning: () => log('  · deployment running…') },
    ),
  );
  if (!polled.ok) {
    return withWarnings(fail(s3, { label: 'deployment', status: 'fail', detail: explainApiError(polled.error, 'status', opts).reason }));
  }
  const outcome = polled.value;
  switch (outcome.kind) {
    case 'succeeded':
      return withWarnings({
        ok: true,
        steps: [...s3, { label: 'deployment', status: 'ok', detail: `succeeded (${outcome.deployment.deploymentId})` }],
        epilogue: plainDeliveryEpilogue(config.name),
      });
    case 'failed': {
      const logs = await settle(client.readLogs(outcome.deployment.deploymentId));
      const logText = logs.ok ? logs.value.trim() : '';
      return withWarnings(
        fail(
          s3,
          {
            label: 'deployment',
            status: 'fail',
            detail:
              `${outcome.deployment.status} (${outcome.deployment.deploymentId})` +
              (outcome.deployment.errorMessage ? ` — ${outcome.deployment.errorMessage}` : ''),
          },
          logText
            ? `  Last lines of the Dokploy deployment log:\n\n${lastLogLines(logText)}`
            : '  Dokploy returned no deployment log — open the deployment in the Dokploy dashboard.',
        ),
      );
    }
    case 'timed_out':
      return withWarnings(
        fail(s3, {
          label: 'deployment',
          status: 'fail',
          detail: outcome.deployment
            ? `still running after ${timeoutMs / 1000}s (${outcome.deployment.deploymentId}) — check the Dokploy dashboard`
            : `Dokploy recorded no new deployment within ${timeoutMs / 1000}s — check the Dokploy dashboard`,
        }),
      );
  }
}

/**
 * `deploy remove`'s Compose undo (CAP-679): strip the Capy block via
 * `compose.saveEnvironment`, verify, then redeploy so the reverted config is
 * actually running — unless `ctx.noDeploy`. Mirrors the Application
 * `onRemove` above; kept separate so that path stays untouched.
 */
async function onRemoveCompose(
  client: DokployClient,
  config: TargetConfig,
  ctx: RemoveOfferContext,
  opts: DokployOptions,
  composeId: string,
): Promise<RemoveOfferResult> {
  const read = await settle(client.getCompose(composeId));
  if (!read.ok) {
    return {
      ok: false,
      code: 'api_error',
      detail: `Dokploy environment left untouched — ${explainApiError(read.error, 'read', opts).reason}`,
      manualHint: manualStripHint(opts),
    };
  }
  const compose = read.value;
  const split = splitManagedBlock(compose.env);
  if ('code' in split) {
    return {
      ok: false,
      code: 'malformed_block',
      detail:
        'Dokploy environment left untouched — the Capy block looks edited or duplicated; ' +
        'Capy will not guess which lines are its own.',
      manualHint: manualStripHint(opts),
    };
  }
  // CAP-682: a block being gone does not by itself mean nothing to do — a
  // hand-deleted block can leave `# capy:off ` lines stranded behind (they
  // are ordinary comments to Dokploy, so nothing else ever cleans them up).
  const strayMarkers = !split.hadBlock && hasCommentedLines(compose.env);
  if (!split.hadBlock && !strayMarkers) {
    return { ok: true, code: 'nothing_to_remove', detail: 'No Capy block found in the Dokploy environment — nothing to remove.' };
  }
  if (!ctx.interactive) {
    return {
      ok: false,
      code: 'non_interactive',
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      detail: strayMarkers
        ? 'Dokploy environment left untouched — not asking to un-comment Capy-marked lines outside a terminal.'
        : 'Dokploy environment left untouched — not asking to strip the Capy block outside a terminal.',
      manualHint: manualStripHint(opts),
    };
  }
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const confirmed = await ctx.confirm(
    strayMarkers
      ? `Also un-comment the lines Capy previously disabled in the Dokploy Compose env for "${config.name}"?`
      : `Also strip the Capy block from the Dokploy Compose env for "${config.name}"?`,
  );
  if (!confirmed) {
    return { ok: false, code: 'declined', detail: 'Dokploy environment left untouched.', manualHint: manualStripHint(opts) };
  }
  // CAP-682: also un-comments every line Capy marked — a byte-exact restore,
  // not just a block strip.
  const removed = removeManagedValuesBlock(compose.env);
  if (!removed.ok) {
    return {
      ok: false,
      code: 'malformed_block',
      detail:
        'Dokploy environment left untouched — the Capy block looks edited or duplicated; ' +
        'Capy will not guess which lines are its own.',
      manualHint: manualStripHint(opts),
    };
  }
  const strippedEnv = removed.env;
  const saved = await settle(
    client.saveComposeEnvironment({ composeId: compose.composeId, env: strippedEnv, createEnvFile: compose.createEnvFile }),
  );
  if (!saved.ok) {
    return {
      ok: false,
      code: 'api_error',
      detail: `Could not write the Dokploy environment — ${explainApiError(saved.error, 'write', opts).reason}`,
      manualHint: manualStripHint(opts),
    };
  }
  const reread = await settle(client.getCompose(composeId));
  const intact = reread.ok && reread.value.env === strippedEnv && reread.value.createEnvFile === compose.createEnvFile;
  if (!intact) {
    return {
      ok: false,
      code: 'verify_mismatch',
      detail: 'The stored environment after removal did not match what Capy wrote — check the Environment tab in Dokploy.',
      manualHint: manualStripHint(opts),
    };
  }
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const removedWhat = strayMarkers ? 'Un-commented the lines Capy had disabled' : 'Removed the Capy block';
  if (ctx.noDeploy) {
    return {
      ok: true,
      code: 'stripped',
      detail: `${removedWhat} in the Dokploy environment; everything else was left untouched. --no-deploy: not redeployed.`,
    };
  }
  const redeployed = await settle(client.redeployCompose(composeId, `capy deploy remove ${config.name}`));
  if (!redeployed.ok) {
    return {
      ok: false,
      code: 'api_error',
      detail:
        `${removedWhat}, but could not redeploy — ${explainApiError(redeployed.error, 'trigger', opts).reason}. ` +
        'The reverted config is saved but not yet running.',
      manualHint: manualStripHint(opts),
    };
  }
  return {
    ok: true,
    code: 'stripped',
    detail: `${removedWhat} in the Dokploy environment and redeployed; everything else was left untouched.`,
  };
}

export function createDokployAdapter(deps: DokployAdapterDeps = {}): DeployAdapter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));

  /**
   * The Dokploy API key for one adapter call. `ctx.resolvedApiKey` — set by a
   * caller that already resolved it once (`deployCommand.ts`) — always wins,
   * so preflight/deploy/onRemove never ask the store twice in the same
   * command. Absent that, resolves for itself (env-only unless this
   * adapter's own `deps.getConnectorSecret` was given).
   */
  const resolveApiKeyFor = (
    opts: DokployOptions,
    ctx: AdapterCallContext,
  ): Promise<ResolveDokployApiKeyResult> =>
    ctx.resolvedApiKey
      ? Promise.resolve(ctx.resolvedApiKey)
      : resolveDokployApiKey({
          tokenEnv: opts.tokenEnv,
          env: deps.env ?? process.env,
          interactive: ctx.interactive ?? false,
          orgId: ctx.orgId,
          devMode: ctx.devMode,
          storeName: DOKPLOY_TARGET_SECRET_NAME,
          deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
        });

  return {
    id: 'dokploy',
    label: 'Dokploy',
    description: 'Writes plain values into the managed env block; CI mode by default, direct mode still available',
    varKind: 'runtime',
    // CAP-682: CI (a keep.lock PR; merging it triggers Dokploy's own
    // auto-deploy) is the default — direct mode is still a picker choice,
    // so this is NOT `ciOnly`.
    defaultMode: 'ci',
    // CAP-682: Dokploy no longer ships `_SECRETS_BLOB`/`_PROJECT_KEY` — it
    // writes each delivered var as its own plaintext line, so no deploy
    // token is minted for it. The blob/token machinery itself is untouched
    // for adapters that still use it, and for `capy run`.
    needsDeployToken: false,
    requires: { binaries: [] },

    async detect(): Promise<DetectedDefaults> {
      // No default tokenEnv (CAP-664): a new target relies on the org system
      // store unless the user explicitly configures a `tokenEnv` override.
      return {};
    },

    async preflight(config: TargetConfig, ctx: { cwd: string; keepLockPath?: string } & AdapterCallContext): Promise<PreflightResult> {
      const shape = optionsProblem(config);
      if (shape) return shape;
      const opts = config.options as unknown as DokployOptions;
      const resolved = await resolveApiKeyFor(opts, ctx);
      if (!resolved.ok) {
        const { reason, hint } = describeDokployTokenProblem(resolved.code, opts.tokenEnv ?? DEFAULT_TOKEN_ENV, DOKPLOY_TARGET_SECRET_NAME);
        return { ok: false, reason, hint };
      }
      const client = createDokployClient(opts.baseUrl, resolved.value, deps.fetch);
      if (opts.composeId) {
        const compose = await settle(client.getCompose(opts.composeId));
        if (!compose.ok) return { ok: false, ...explainApiError(compose.error, 'compose.one', opts) };
        if (compose.value.createEnvFile === false) {
          return { ok: false, ...describeComposeEnvFileDisabled(), code: ERROR_CODES.DOKPLOY_ENV_FILE_DISABLED };
        }
        const problem = envProblems(compose.value.env);
        if (problem) return { ok: false, ...describeEnvProblem(problem) };
        // CAP-682: DOKPLOY_SHADOWED_VAR no longer applies here — a pre-existing
        // active line for a delivered var gets COMMENTED OUT at deploy time
        // (see `mergeManagedValuesBlock`), not silently shadowed, so warning
        // about it here would be actively misleading.
        const ciProblem = dokployCiPreflightProblem(config, keepLockPathFor(ctx), compose.value);
        if (ciProblem) return ciProblem;
        const stackWarning = await composeStackVersionWarning(client, compose.value);
        return { ok: true, ...(stackWarning ? { warnings: [stackWarning] } : {}) };
      }
      const app = await settle(client.getApplication(opts.applicationId!));
      if (!app.ok) return { ok: false, ...explainApiError(app.error, 'application.one', opts) };
      const problem = envProblems(app.value.env);
      if (problem) return { ok: false, ...describeEnvProblem(problem) };
      const ciProblem = dokployCiPreflightProblem(config, keepLockPathFor(ctx), app.value);
      if (ciProblem) return ciProblem;
      return { ok: true };
    },

    async deploy(config: TargetConfig, ctx: DeployContext): Promise<DeployResult> {
      const opts = config.options as unknown as DokployOptions;
      if (ctx.dryRun) {
        return {
          ok: true,
          steps: [
            {
              label: opts.composeId ? 'compose.saveEnvironment' : 'application.saveEnvironment',
              status: 'ok',
              detail: `${config.vars.length} var(s) would be written plaintext into the Capy block`,
            },
            { label: opts.composeId ? 'compose.redeploy' : 'application.deploy', status: 'skip', detail: 'dry-run' },
          ],
        };
      }
      const fail = (
        steps: readonly DeployStep[],
        step: DeployStep,
        epilogue?: string,
      ): DeployResult => ({
        ok: false,
        steps: [...steps, step],
        ...(epilogue ? { epilogue } : {}),
      });
      const delivered = deliveredValuesFor(config, ctx.env);
      if (!delivered.ok) {
        return fail([], {
          label: opts.composeId ? 'compose.saveEnvironment' : 'application.saveEnvironment',
          status: 'fail',
          detail: `missing in branch ${config.branch}: ${delivered.missing.join(', ')}`,
        });
      }
      const resolved = await resolveApiKeyFor(opts, ctx);
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, opts.tokenEnv ?? DEFAULT_TOKEN_ENV, DOKPLOY_TARGET_SECRET_NAME);
        return fail([], { label: 'dokploy auth', status: 'fail', detail: reason });
      }
      const client = createDokployClient(opts.baseUrl, resolved.value, deps.fetch);

      // CAP-679: Compose services take a completely separate sequence (see
      // `deployComposeFlow`'s own doc) — the Application path below is kept
      // exactly as it was.
      if (opts.composeId) {
        return deployComposeFlow(client, config, ctx, opts, opts.composeId, { sleep, now, log });
      }
      const applicationId = opts.applicationId;
      if (!applicationId) {
        return fail([], { label: 'dokploy target', status: 'fail', detail: 'no applicationId or composeId configured' });
      }

      // 1. Fresh read — what preflight saw may be stale by now.
      const read = await settle(client.getApplication(applicationId));
      if (!read.ok) {
        return fail([], {
          label: 'application.one',
          status: 'fail',
          detail: explainApiError(read.error, 'read', opts).reason,
        });
      }
      const current = read.value;
      const s1: readonly DeployStep[] = [
        { label: 'dokploy application', status: 'ok', detail: current.name ?? current.applicationId },
      ];
      const problem = envProblems(current.env);
      if (problem) {
        return fail(s1, { label: 'env merge', status: 'fail', detail: describeEnvProblem(problem).reason });
      }
      // CAP-682: DOKPLOY_SHADOWED_VAR no longer applies — see the identical
      // note in `deployComposeFlow`.
      const merged = mergeManagedValuesBlock(current.env, delivered.values);
      if (!merged.ok) {
        const described = describeDokployPlainMergeProblem(merged.problem);
        return fail(s1, {
          label: 'env merge',
          status: 'fail',
          detail: described.reason,
          ...(described.code ? { code: described.code as ErrorCode } : {}),
        });
      }
      const nextEnv = merged.env;

      // 2. Whole-object write: buildArgs / buildSecrets / createEnvFile ride
      //    through exactly as read.
      const saved = await settle(
        client.saveEnvironment({
          applicationId: current.applicationId,
          env: nextEnv,
          buildArgs: current.buildArgs,
          buildSecrets: current.buildSecrets,
          createEnvFile: current.createEnvFile,
        }),
      );
      if (!saved.ok) {
        return fail(s1, {
          label: 'application.saveEnvironment',
          status: 'fail',
          detail: explainApiError(saved.error, 'write', opts).reason,
        });
      }

      // 3. Dokploy has no conditional write, so a concurrent dashboard edit can
      //    only be detected, not prevented: re-read and compare — byte-exact,
      //    AND every delivered value reads back exactly via `dotenv.parse`.
      const reread = await settle(client.getApplication(applicationId));
      const byteIntact =
        reread.ok &&
        reread.value.env === nextEnv &&
        reread.value.buildArgs === current.buildArgs &&
        reread.value.buildSecrets === current.buildSecrets &&
        reread.value.createEnvFile === current.createEnvFile;
      if (!byteIntact) {
        return fail(s1, {
          label: 'application.saveEnvironment',
          status: 'fail',
          detail:
            'the stored environment is not what Capy wrote — another edit may have landed at the ' +
            'same moment. Check the Environment tab in Dokploy, then re-run.',
        });
      }
      const mismatched = mismatchedDeliveredValues(nextEnv, delivered.values);
      if (mismatched.length > 0) {
        return fail(s1, {
          label: 'application.saveEnvironment',
          status: 'fail',
          detail: `the stored environment does not read back as written for: ${mismatched.join(', ')}. Check the Environment tab in Dokploy, then re-run.`,
        });
      }
      const nextSplit = splitManagedBlock(nextEnv);
      const otherVarsCount = 'code' in nextSplit ? 0 : envKeys(outsideLines(nextSplit)).length;
      const s2: readonly DeployStep[] = [
        ...s1,
        {
          label: 'application.saveEnvironment',
          status: 'ok',
          detail: `${delivered.values.length} var(s) written plaintext; ${otherVarsCount} other var(s), build args and build secrets kept`,
        },
      ];

      if (ctx.secretsOnly) {
        return {
          ok: true,
          steps: [
            ...s2,
            { label: 'application.deploy', status: 'skip', detail: "CI mode — merging the deploy PR triggers Dokploy's own auto-deploy" },
          ],
          epilogue: plainDeliveryEpilogue(config.name),
        };
      }
      if (ctx.noDeploy) {
        return {
          ok: true,
          steps: [...s2, { label: 'application.deploy', status: 'skip', detail: '--no-deploy' }],
          epilogue: plainDeliveryEpilogue(config.name),
        };
      }

      // 4. Trigger, remembering which deployments already existed — Dokploy's
      //    deploy call does not say which deployment it created.
      const before = await settle(client.listDeployments(applicationId));
      if (!before.ok) {
        return fail(s2, {
          label: 'deployment.all',
          status: 'fail',
          detail: explainApiError(before.error, 'list', opts).reason,
        });
      }
      const triggered = await settle(client.deploy(applicationId, `capy deploy ${config.name}`));
      if (!triggered.ok) {
        return fail(s2, {
          label: 'application.deploy',
          status: 'fail',
          detail: explainApiError(triggered.error, 'trigger', opts).reason,
        });
      }
      const s3: readonly DeployStep[] = [
        ...s2,
        { label: 'application.deploy', status: 'ok', detail: 'accepted' },
      ];
      log('  · deployment accepted — waiting for Dokploy…');

      // 5. Poll to a real outcome; the trigger response alone proves nothing.
      const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const polled = await settle(
        pollApplicationDeployment(
          client,
          applicationId,
          new Set(before.value.map((d) => d.deploymentId)),
          now() + timeoutMs,
          { sleep, now, onRunning: () => log('  · deployment running…') },
        ),
      );
      if (!polled.ok) {
        return fail(s3, {
          label: 'deployment',
          status: 'fail',
          detail: explainApiError(polled.error, 'status', opts).reason,
        });
      }
      const outcome = polled.value;
      switch (outcome.kind) {
        case 'succeeded':
          return {
            ok: true,
            steps: [
              ...s3,
              { label: 'deployment', status: 'ok', detail: `succeeded (${outcome.deployment.deploymentId})` },
            ],
            epilogue: plainDeliveryEpilogue(config.name),
          };
        case 'failed': {
          const logs = await settle(client.readLogs(outcome.deployment.deploymentId));
          const logText = logs.ok ? logs.value.trim() : '';
          return fail(
            s3,
            {
              label: 'deployment',
              status: 'fail',
              detail:
                `${outcome.deployment.status} (${outcome.deployment.deploymentId})` +
                (outcome.deployment.errorMessage ? ` — ${outcome.deployment.errorMessage}` : ''),
            },
            logText
              ? `  Last lines of the Dokploy deployment log:\n\n${lastLogLines(logText)}`
              : '  Dokploy returned no deployment log — open the deployment in the Dokploy dashboard.',
          );
        }
        case 'timed_out':
          return fail(s3, {
            label: 'deployment',
            status: 'fail',
            detail: outcome.deployment
              ? `still running after ${timeoutMs / 1000}s (${outcome.deployment.deploymentId}) — ` +
                'check the Dokploy dashboard'
              : `Dokploy recorded no new deployment within ${timeoutMs / 1000}s — check the Dokploy dashboard`,
          });
      }
    },

    async onRemove(config: TargetConfig, ctx: RemoveOfferContext): Promise<RemoveOfferResult | null> {
      const opts = config.options as unknown as DokployOptions;
      const resolved = await resolveApiKeyFor(opts, ctx);
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, opts.tokenEnv ?? DEFAULT_TOKEN_ENV, DOKPLOY_TARGET_SECRET_NAME);
        return {
          ok: false,
          code: 'no_token',
          detail: `Dokploy environment left untouched — ${reason}, so Capy could not check for its block.`,
          manualHint: manualStripHint(opts),
        };
      }
      const client = createDokployClient(opts.baseUrl, resolved.value, deps.fetch);
      if (opts.composeId) {
        return onRemoveCompose(client, config, ctx, opts, opts.composeId);
      }
      const read = await settle(client.getApplication(opts.applicationId!));
      if (!read.ok) {
        return {
          ok: false,
          code: 'api_error',
          detail: `Dokploy environment left untouched — ${explainApiError(read.error, 'read', opts).reason}`,
          manualHint: manualStripHint(opts),
        };
      }
      const app = read.value;
      const split = splitManagedBlock(app.env);
      if ('code' in split) {
        return {
          ok: false,
          code: 'malformed_block',
          detail:
            'Dokploy environment left untouched — the Capy block looks edited or duplicated; ' +
            'Capy will not guess which lines are its own.',
          manualHint: manualStripHint(opts),
        };
      }
      // CAP-682: a block being gone does not by itself mean nothing to do —
      // a hand-deleted block can leave `# capy:off ` lines stranded behind
      // (ordinary comments to Dokploy, so nothing else ever cleans them up).
      const strayMarkers = !split.hadBlock && hasCommentedLines(app.env);
      if (!split.hadBlock && !strayMarkers) {
        return {
          ok: true,
          code: 'nothing_to_remove',
          detail: 'No Capy block found in the Dokploy environment — nothing to remove.',
        };
      }
      if (!ctx.interactive) {
        return {
          ok: false,
          code: 'non_interactive',
          // COPY-FLAG: new user-facing string, minimal/neutral wording.
          detail: strayMarkers
            ? 'Dokploy environment left untouched — not asking to un-comment Capy-marked lines outside a terminal.'
            : 'Dokploy environment left untouched — not asking to strip the Capy block outside a terminal.',
          manualHint: manualStripHint(opts),
        };
      }
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      const confirmed = await ctx.confirm(
        strayMarkers
          ? `Also un-comment the lines Capy previously disabled in the Dokploy Application env for "${config.name}"?`
          : `Also strip the Capy block from the Dokploy Application env for "${config.name}"?`,
      );
      if (!confirmed) {
        return {
          ok: false,
          code: 'declined',
          detail: 'Dokploy environment left untouched.',
          manualHint: manualStripHint(opts),
        };
      }
      // CAP-682: also un-comments every line Capy marked — a byte-exact
      // restore, not just a block strip.
      const removed = removeManagedValuesBlock(app.env);
      if (!removed.ok) {
        return {
          ok: false,
          code: 'malformed_block',
          detail:
            'Dokploy environment left untouched — the Capy block looks edited or duplicated; ' +
            'Capy will not guess which lines are its own.',
          manualHint: manualStripHint(opts),
        };
      }
      const strippedEnv = removed.env;
      const saved = await settle(
        client.saveEnvironment({
          applicationId: app.applicationId,
          env: strippedEnv,
          buildArgs: app.buildArgs,
          buildSecrets: app.buildSecrets,
          createEnvFile: app.createEnvFile,
        }),
      );
      if (!saved.ok) {
        return {
          ok: false,
          code: 'api_error',
          detail: `Could not write the Dokploy environment — ${explainApiError(saved.error, 'write', opts).reason}`,
          manualHint: manualStripHint(opts),
        };
      }
      const reread = await settle(client.getApplication(opts.applicationId!));
      const intact =
        reread.ok &&
        reread.value.env === strippedEnv &&
        reread.value.buildArgs === app.buildArgs &&
        reread.value.buildSecrets === app.buildSecrets &&
        reread.value.createEnvFile === app.createEnvFile;
      if (!intact) {
        return {
          ok: false,
          code: 'verify_mismatch',
          detail:
            'The stored environment after removal did not match what Capy wrote — check the ' +
            'Environment tab in Dokploy.',
          manualHint: manualStripHint(opts),
        };
      }
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      return {
        ok: true,
        code: 'stripped',
        detail: `${strayMarkers ? 'Un-commented the lines Capy had disabled' : 'Removed the Capy block'} in the Dokploy environment; everything else was left untouched.`,
      };
    },
  };
}

/**
 * The registry's production instance — the only construction of this
 * adapter that wires the org system store for real (every other
 * construction, including every test, gets the safe env-only default — see
 * `DokployAdapterDeps`). In the normal `capy deploy` / `capy deploy remove`
 * flow, `deployCommand.ts` already pre-resolves the key once and passes it
 * via `ctx.resolvedApiKey`, so this wiring is exercised only by a caller
 * that invokes `preflight`/`deploy`/`onRemove` directly without going
 * through that pre-resolution.
 */
export const dokployAdapter: DeployAdapter = createDokployAdapter({
  getConnectorSecret: async (name, opts) => {
    // CAP-679 follow-up: deploy's own direction — see
    // `system/systemStore.ts#getDirectionalConnectorSecret`'s doc and
    // `deployCommand.ts`'s identical wiring (the one actually exercised in
    // production; this is the fallback for a caller that bypasses it).
    const { getDirectionalConnectorSecret } = await import('../../system/systemStore');
    return getDirectionalConnectorSecret(name, DOKPLOY_CONNECTOR_SECRET_NAME, {
      ...opts,
      missingWithFallbackCode: ERROR_CODES.DOKPLOY_TARGET_KEY_MISSING,
    });
  },
});
