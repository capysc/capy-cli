/**
 * Vercel REST API client and env-var planner for the `vercel` deploy target's
 * API mode (CAP-696). A target whose `options` carry a `projectId` talks to
 * Vercel over HTTPS with a token from the org system store — no `vercel`
 * binary, no `vercel login`, no `.vercel/project.json`.
 *
 * Routes used (each checked against Vercel's published API reference):
 *   - GET    /v9/projects/{idOrName}                      — preflight: project exists, token has access
 *            https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
 *   - GET    /v9/projects/{idOrName}/custom-environments/{environmentSlugOrId}
 *            https://vercel.com/docs/rest-api/environment/retrieve-a-custom-environment
 *   - GET    /v10/projects/{idOrName}/env?decrypt=true    — list the project's env records
 *            https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name
 *   - POST   /v10/projects/{idOrName}/env                 — create ONE record
 *            https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
 *   - PATCH  /v9/projects/{idOrName}/env/{id}             — edit one record (value and/or target)
 *            https://vercel.com/docs/rest-api/projects/edit-an-environment-variable
 *   - GET    /v1/projects/{idOrName}/env/{id}             — read one record's decrypted value (verification)
 *            https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id
 * Every route takes `?teamId=` when the target has a `teamId`. Rate limiting
 * and the `{ error: { code } }` body shape: https://vercel.com/docs/rest-api/errors
 *
 * Why this file never sends `upsert=true` and never deletes: one Vercel
 * record can serve several environments at once (`target: ['production',
 * 'preview']`). `upsert=true` would overwrite such a shared record's value for
 * EVERY environment it serves, and a delete would remove it for all of them.
 * Writing one environment must never change what another sees, so a shared
 * record is split (this environment removed from it) and a fresh record is
 * created for this environment alone — see `planVar`.
 *
 * Sensitive vars: Vercel never returns their value, so they cannot be read
 * back; they are reported as written-unverified, never as verified. A team
 * policy can turn every new Production/Preview var sensitive
 * (https://vercel.com/docs/environment-variables/sensitive-environment-variables).
 * The docs describe that as an automatic conversion, not an error code, so
 * there is nothing to retry on: we send `encrypted` and accept whatever type
 * Vercel stored.
 *
 * Nothing here ever logs or returns a token or a value in an error: failures
 * carry a stable `code`, the HTTP status, and Vercel's own `error.code` field.
 */
import { createHash } from 'crypto';
import { ERROR_CODES, ErrorCode } from '../types/index';
import { keyHelpFields, vercelKeyHelp, vercelTokenProblemHelp } from './keyHelp';

// ── Token: system store, same shape as Dokploy's ───────────────────────────

// The store names and the env fallback are defined once, in `vercelApi.ts`
// (the import side); `_TARGET_VERCEL_TOKEN` may be a one-level reference to
// `_CONNECTOR_VERCEL_TOKEN`.
import { VERCEL_TARGET_SECRET_NAME, VERCEL_CONNECTOR_SECRET_NAME, DEFAULT_VERCEL_TOKEN_ENV } from './vercelApi';
export { VERCEL_TARGET_SECRET_NAME, VERCEL_CONNECTOR_SECRET_NAME, DEFAULT_VERCEL_TOKEN_ENV };

export type VercelTokenSource = 'system' | 'env';

export type ResolveVercelTokenResult =
  | { ok: true; value: string; source: VercelTokenSource }
  | { ok: false; code: string };

/** What the system store's secret getter needs — same shape as Dokploy's. */
export interface VercelSystemStoreCallOptions {
  orgId?: string;
  interactive: boolean;
  devMode?: boolean;
  apiUrl?: string;
  /** The slug of the team that owns the project, when known: the hidden prompt's token instructions name it. */
  helpTeam?: string;
}

export type GetVercelStoreSecret = (
  name: string,
  opts: VercelSystemStoreCallOptions,
) => Promise<string | null>;

/**
 * The real system-store read for the deploy direction: `_TARGET_VERCEL_TOKEN`
 * first; when only `_CONNECTOR_VERCEL_TOKEN` exists, interactive runs are
 * asked whether to reuse it and non-interactive runs are refused with
 * `VERCEL_TARGET_KEY_MISSING`. Exactly Dokploy's behaviour — see
 * `system/systemStore.ts#getDirectionalConnectorSecret`.
 */
export const getVercelTargetSecretFromStore: GetVercelStoreSecret = async (name, opts) => {
  const { getDirectionalConnectorSecret } = await import('../system/systemStore');
  return getDirectionalConnectorSecret(name, VERCEL_CONNECTOR_SECRET_NAME, {
    ...opts,
    missingWithFallbackCode: ERROR_CODES.VERCEL_TARGET_KEY_MISSING,
  });
};

/** A typed store error (`{ code: string }`) as its code — never its message. */
function storeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : ERROR_CODES.VERCEL_TOKEN_MISSING;
}

type StoreOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'empty' }
  | { kind: 'error'; code: string };

async function readStore(
  getSecret: GetVercelStoreSecret,
  callOpts: VercelSystemStoreCallOptions,
): Promise<StoreOutcome> {
  try {
    const value = await getSecret(VERCEL_TARGET_SECRET_NAME, callOpts);
    return value ? { kind: 'value', value } : { kind: 'empty' };
  } catch (err) {
    return { kind: 'error', code: storeErrorCode(err) };
  }
}

export interface ResolveVercelTokenOptions {
  env: Record<string, string | undefined>;
  interactive: boolean;
  orgId?: string;
  devMode?: boolean;
  apiUrl?: string;
  /** See `VercelSystemStoreCallOptions.helpTeam`. */
  helpTeam?: string;
  /** Defaults to a getter that never touches the store (env-only). Real callers pass `getVercelTargetSecretFromStore`. */
  getSecret?: GetVercelStoreSecret;
}

async function neverReachesTheStore(): Promise<null> {
  return null;
}

/**
 * The Vercel token for one command: the system store's
 * `_TARGET_VERCEL_TOKEN` (a one-level reference to `_CONNECTOR_VERCEL_TOKEN`
 * resolves inside the store), then `$VERCEL_TOKEN`. When nothing has a value
 * the refusal carries the STORE's own code if the store refused (admin-only,
 * connector-key-only, …), else `VERCEL_TOKEN_MISSING`.
 */
export async function resolveVercelTargetToken(
  opts: ResolveVercelTokenOptions,
): Promise<ResolveVercelTokenResult> {
  const outcome = await readStore(opts.getSecret ?? neverReachesTheStore, {
    orgId: opts.orgId,
    interactive: opts.interactive,
    devMode: opts.devMode,
    apiUrl: opts.apiUrl,
    ...(opts.helpTeam ? { helpTeam: opts.helpTeam } : {}),
  });
  if (outcome.kind === 'value') return { ok: true, value: outcome.value, source: 'system' };
  const fallback = opts.env[DEFAULT_VERCEL_TOKEN_ENV];
  if (fallback) return { ok: true, value: fallback, source: 'env' };
  return outcome.kind === 'error'
    ? { ok: false, code: outcome.code }
    : { ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING };
}

/** Where to get the deploy-side Vercel token: the `link` + `remedy` fields of a key refusal. */
export function vercelTargetKeyHelp(team?: string): { link: { label: string; url: string }; remedy: string } {
  return keyHelpFields(vercelKeyHelp(VERCEL_TARGET_SECRET_NAME, { team }));
}

/** The two steps for a deploy token that is valid but has no access: the token page and `capy system set` for the deploy-side name. */
export function vercelTargetTokenProblemHelp(): { link: { label: string; url: string }; remedy: string } {
  return keyHelpFields(vercelTokenProblemHelp(VERCEL_TARGET_SECRET_NAME));
}

/** A token refusal as a printable reason + hint. Names only, never a value. */
export function describeVercelTokenProblem(code: string): { reason: string; hint: string } {
  if (code === ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `only an org owner or admin can set ${VERCEL_TARGET_SECRET_NAME} in the system store, and $${DEFAULT_VERCEL_TOKEN_ENV} is not set`,
      // COPY-FLAG
      hint: `Ask an org owner/admin to run \`capy system set ${VERCEL_TARGET_SECRET_NAME}\`, or export ${DEFAULT_VERCEL_TOKEN_ENV} yourself.`,
    };
  }
  if (code === ERROR_CODES.VERCEL_TARGET_KEY_MISSING) {
    return {
      // COPY-FLAG
      reason: `${VERCEL_TARGET_SECRET_NAME} is not set, but ${VERCEL_CONNECTOR_SECRET_NAME} already holds a Vercel token`,
      // COPY-FLAG
      hint: `Run this interactively to choose whether to reuse it, or run \`capy system set ${VERCEL_TARGET_SECRET_NAME}\` to set a dedicated one.`,
    };
  }
  if (code === ERROR_CODES.VERCEL_TOKEN_MISSING) {
    return {
      // COPY-FLAG
      reason: `${VERCEL_TARGET_SECRET_NAME} is not set`,
      // COPY-FLAG
      hint: `Run \`capy system set ${VERCEL_TARGET_SECRET_NAME}\`, or export ${DEFAULT_VERCEL_TOKEN_ENV}=… first.`,
    };
  }
  return {
    // COPY-FLAG
    reason: `could not resolve the Vercel token (${code})`,
    // COPY-FLAG
    hint: `Run \`capy system set ${VERCEL_TARGET_SECRET_NAME}\`, or export ${DEFAULT_VERCEL_TOKEN_ENV}=… first.`,
  };
}

// ── Options ────────────────────────────────────────────────────────────────

export type StandardVercelEnv = 'production' | 'preview' | 'development';

const STANDARD_ENVS: readonly string[] = ['production', 'preview', 'development'];

/** The API-mode option set. `projectId` is what switches a target into API mode. */
export interface VercelApiOptions {
  projectDir?: string;
  /** `production`, `preview`, `development`, or a custom environment's slug. */
  vercelEnv: string;
  projectId: string;
  teamId?: string;
  /**
   * The team's slug. Saved by `capy deploy`'s setup ONLY when the project could
   * not be checked against Vercel (so no `teamId` was learned): requests then
   * scope by slug. Also lets the token instructions name the team.
   */
  teamSlug?: string;
  /** Preview only. Absent means every preview branch. */
  gitBranch?: string;
  customEnvironmentId?: string;
}

/** Whether a target's options put it in API mode. The one switch; everything else follows it. */
export function isVercelApiMode(options: Record<string, unknown>): boolean {
  return typeof options.projectId === 'string' && options.projectId.trim() !== '';
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export type ParsedVercelApiOptions =
  | { ok: true; options: VercelApiOptions }
  | { ok: false; reason: string; hint: string };

export function parseVercelApiOptions(raw: Record<string, unknown>): ParsedVercelApiOptions {
  const projectId = nonEmptyString(raw.projectId);
  const vercelEnv = nonEmptyString(raw.vercelEnv);
  if (!projectId || !vercelEnv) {
    return {
      ok: false,
      // COPY-FLAG
      reason: 'vercel API-mode target needs options.projectId and options.vercelEnv',
      // COPY-FLAG
      hint: 'Set vercelEnv to "production", "preview", "development" or a custom environment slug.',
    };
  }
  return {
    ok: true,
    options: {
      projectDir: nonEmptyString(raw.projectDir),
      vercelEnv,
      projectId,
      teamId: nonEmptyString(raw.teamId),
      teamSlug: nonEmptyString(raw.teamSlug),
      gitBranch: nonEmptyString(raw.gitBranch),
      customEnvironmentId: nonEmptyString(raw.customEnvironmentId),
    },
  };
}

// ── Typed errors ───────────────────────────────────────────────────────────

/** A failed Vercel call. `code` is ours; `vercelCode` is Vercel's own `error.code` field, when it sent one. */
export class VercelApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number | undefined,
    readonly vercelCode: string | undefined,
  ) {
    // The message is for logs: a code and a status, never a body (a body can echo a value).
    super(`${code}${status !== undefined ? ` (HTTP ${status})` : ''}`);
    this.name = 'VercelApiError';
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API_BASE = 'https://api.vercel.com';
/** Retries after a 429. */
export const MAX_RATE_LIMIT_RETRIES = 3;
/** A wait longer than this is not waited for: the call fails with VERCEL_RATE_LIMITED. */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;

/** One Vercel env record — only the fields we read. */
export interface VercelEnvRecord {
  id: string;
  key: string;
  value?: string;
  type?: string;
  target?: readonly string[] | string;
  gitBranch?: string | null;
  customEnvironmentIds?: readonly string[];
  decrypted?: boolean;
}

export interface VercelClientDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Scope requests by the team's slug (`?slug=`) when there is no `teamId` to scope by. */
  teamSlug?: string;
}

export interface VercelClient {
  getProject(): Promise<void>;
  getCustomEnvironment(slugOrId: string): Promise<{ id: string; slug?: string }>;
  listEnvs(): Promise<readonly VercelEnvRecord[]>;
  createEnv(body: Record<string, unknown>): Promise<VercelEnvRecord>;
  patchEnv(envId: string, body: Record<string, unknown>): Promise<VercelEnvRecord>;
  getEnv(envId: string): Promise<VercelEnvRecord>;
}

/** Seconds a 429 asks us to wait: `retry-after` (seconds) first, then `x-ratelimit-reset` (epoch seconds). */
function rateLimitWaitMs(headers: Headers, nowMs: number): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter * 1000);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - nowMs);
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

async function vercelErrorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function codeForStatus(status: number, notFound: ErrorCode): ErrorCode {
  if (status === 401) return ERROR_CODES.VERCEL_TOKEN_REJECTED;
  if (status === 403) return ERROR_CODES.VERCEL_NO_ACCESS;
  if (status === 404) return notFound;
  if (status === 429) return ERROR_CODES.VERCEL_RATE_LIMITED;
  return ERROR_CODES.VERCEL_API_ERROR;
}

export function createVercelClient(
  token: string,
  projectId: string,
  teamId: string | undefined,
  deps: VercelClientDeps = {},
): VercelClient {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const project = encodeURIComponent(projectId);

  const urlFor = (path: string, query: Readonly<Record<string, string>>): string => {
    const scope: Record<string, string> = teamId ? { teamId } : deps.teamSlug ? { slug: deps.teamSlug } : {};
    const params = new URLSearchParams({ ...query, ...scope });
    const qs = params.toString();
    return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  };

  /** One request, retrying a 429 up to MAX_RATE_LIMIT_RETRIES times. Sequential by construction. */
  const request = async (
    method: string,
    path: string,
    query: Readonly<Record<string, string>>,
    body: Record<string, unknown> | undefined,
    notFound: ErrorCode,
    attempt: number = 0,
  ): Promise<unknown> => {
    const res = await doFetch(urlFor(path, query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch((): null => null);
    if (res === null) throw new VercelApiError(ERROR_CODES.VERCEL_NETWORK_ERROR, undefined, undefined);
    if (res.ok) return res.json();
    const vercelCode = await vercelErrorCodeOf(res);
    if (res.status !== 429) {
      throw new VercelApiError(codeForStatus(res.status, notFound), res.status, vercelCode);
    }
    const waitMs = rateLimitWaitMs(res.headers, now());
    if (attempt >= MAX_RATE_LIMIT_RETRIES || waitMs > MAX_RATE_LIMIT_WAIT_MS) {
      throw new VercelApiError(ERROR_CODES.VERCEL_RATE_LIMITED, 429, vercelCode);
    }
    await sleep(waitMs);
    return request(method, path, query, body, notFound, attempt + 1);
  };

  const notFoundProject = ERROR_CODES.VERCEL_PROJECT_NOT_FOUND;

  return {
    async getProject() {
      await request('GET', `/v9/projects/${project}`, {}, undefined, notFoundProject);
    },
    async getCustomEnvironment(slugOrId) {
      const got = (await request(
        'GET',
        `/v9/projects/${project}/custom-environments/${encodeURIComponent(slugOrId)}`,
        {},
        undefined,
        ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND,
      )) as { id?: unknown; slug?: unknown };
      if (typeof got?.id !== 'string') {
        throw new VercelApiError(ERROR_CODES.VERCEL_API_ERROR, undefined, undefined);
      }
      return { id: got.id, slug: typeof got.slug === 'string' ? got.slug : undefined };
    },
    async listEnvs() {
      const got = (await request('GET', `/v10/projects/${project}/env`, { decrypt: 'true' }, undefined, notFoundProject)) as
        | { envs?: unknown }
        | readonly unknown[]
        | null;
      const envs = Array.isArray(got) ? got : (got as { envs?: unknown } | null)?.envs;
      return Array.isArray(envs) ? (envs as VercelEnvRecord[]) : [];
    },
    async createEnv(body) {
      const got = (await request('POST', `/v10/projects/${project}/env`, {}, body, notFoundProject)) as {
        created?: VercelEnvRecord | readonly VercelEnvRecord[];
        failed?: readonly { error?: { code?: unknown } }[];
      };
      const failedCode = got?.failed?.[0]?.error?.code;
      if (Array.isArray(got?.failed) && got.failed.length > 0) {
        throw new VercelApiError(
          ERROR_CODES.VERCEL_API_ERROR,
          undefined,
          typeof failedCode === 'string' ? failedCode : undefined,
        );
      }
      const created = Array.isArray(got?.created) ? got.created[0] : got?.created;
      if (!created || typeof (created as VercelEnvRecord).id !== 'string') {
        throw new VercelApiError(ERROR_CODES.VERCEL_API_ERROR, undefined, undefined);
      }
      return created as VercelEnvRecord;
    },
    async patchEnv(envId, body) {
      const got = (await request(
        'PATCH',
        `/v9/projects/${project}/env/${encodeURIComponent(envId)}`,
        {},
        body,
        notFoundProject,
      )) as VercelEnvRecord | null;
      return got ?? { id: envId, key: '' };
    },
    async getEnv(envId) {
      return (await request(
        'GET',
        `/v1/projects/${project}/env/${encodeURIComponent(envId)}`,
        {},
        undefined,
        notFoundProject,
      )) as VercelEnvRecord;
    },
  };
}

// ── Environment scope ──────────────────────────────────────────────────────

/** The one environment (and, for Preview, branch scope) a target writes to. */
export type EnvScope =
  | { kind: 'standard'; env: StandardVercelEnv; gitBranch?: string }
  | { kind: 'custom'; id: string; slug: string };

/** `production` / `preview` / `development` / `custom:<id>` — one string per environment a record can serve. */
function scopeKey(scope: EnvScope): string {
  return scope.kind === 'standard' ? scope.env : `custom:${scope.id}`;
}

export function describeScope(scope: EnvScope): string {
  if (scope.kind === 'custom') return `custom environment ${scope.slug}`;
  if (scope.env === 'preview') {
    return scope.gitBranch ? `preview · branch=${scope.gitBranch}` : 'preview · all branches';
  }
  return scope.env;
}

export type ScopeResolution =
  | { ok: true; scope: EnvScope }
  | { ok: false; code: ErrorCode; status?: number };

function isStandardEnv(v: string): v is StandardVercelEnv {
  return STANDARD_ENVS.includes(v);
}

/** The target's environment as an `EnvScope`, confirming a custom environment exists on the project. */
export async function resolveEnvScope(
  client: VercelClient,
  opts: VercelApiOptions,
): Promise<ScopeResolution> {
  if (isStandardEnv(opts.vercelEnv)) {
    const gitBranch = opts.vercelEnv === 'preview' ? opts.gitBranch : undefined;
    return { ok: true, scope: { kind: 'standard', env: opts.vercelEnv, ...(gitBranch ? { gitBranch } : {}) } };
  }
  try {
    const found = await client.getCustomEnvironment(opts.customEnvironmentId ?? opts.vercelEnv);
    return { ok: true, scope: { kind: 'custom', id: found.id, slug: found.slug ?? opts.vercelEnv } };
  } catch (err) {
    return failureOf(err);
  }
}

/** A thrown error as `{ ok: false, code, status }`. Anything not a VercelApiError is an unexpected API error. */
export function failureOf(err: unknown): { ok: false; code: ErrorCode; status?: number } {
  if (err instanceof VercelApiError) return { ok: false, code: err.code, status: err.status };
  return { ok: false, code: ERROR_CODES.VERCEL_API_ERROR };
}

/** Preflight: the project exists, the token can see it, and (custom env) the environment exists. */
export async function checkVercelTarget(
  client: VercelClient,
  opts: VercelApiOptions,
): Promise<{ ok: true; scope: EnvScope } | { ok: false; code: ErrorCode; status?: number }> {
  try {
    await client.getProject();
  } catch (err) {
    return failureOf(err);
  }
  return resolveEnvScope(client, opts);
}

// ── Planning ───────────────────────────────────────────────────────────────

function targetsOf(rec: VercelEnvRecord): readonly string[] {
  if (Array.isArray(rec.target)) return rec.target as readonly string[];
  return typeof rec.target === 'string' ? [rec.target] : [];
}

function customIdsOf(rec: VercelEnvRecord): readonly string[] {
  return rec.customEnvironmentIds ?? [];
}

/** Every environment this record serves, as scope keys. */
function envKeysOf(rec: VercelEnvRecord): readonly string[] {
  return [...targetsOf(rec), ...customIdsOf(rec).map((id) => `custom:${id}`)];
}

function branchOf(v: string | null | undefined): string {
  return v ?? '';
}

/** Whether `rec` is a record for this var name that serves `scope` (and, for Preview, the same branch scope). */
function covers(rec: VercelEnvRecord, name: string, scope: EnvScope): boolean {
  if (rec.key !== name) return false;
  if (!envKeysOf(rec).includes(scopeKey(scope))) return false;
  if (scope.kind === 'standard' && scope.env === 'preview') {
    return branchOf(rec.gitBranch) === branchOf(scope.gitBranch);
  }
  return true;
}

/** The value Vercel will let us read, or undefined when it is unreadable (sensitive, or not decrypted). */
function readableValue(rec: VercelEnvRecord): string | undefined {
  if (typeof rec.value !== 'string') return undefined;
  if (rec.type === 'sensitive') return undefined;
  if (rec.type === 'plain' || rec.decrypted === true) return rec.value;
  return undefined;
}

export type NewRecordType = 'encrypted' | 'sensitive';

/** A new record keeps an existing record's type when that is sensitive or encrypted; else `encrypted`. */
function typeLike(rec: VercelEnvRecord | undefined): NewRecordType {
  return rec?.type === 'sensitive' ? 'sensitive' : 'encrypted';
}

/** What to do for one var. `record` is always an existing Vercel record. */
export type VarPlan =
  | { kind: 'create'; name: string; value: string; type: NewRecordType }
  | { kind: 'update'; name: string; value: string; record: VercelEnvRecord }
  | { kind: 'unchanged'; name: string; record: VercelEnvRecord }
  | { kind: 'split'; name: string; value: string; shared: VercelEnvRecord; type: NewRecordType };

/**
 * Decide how to write one var into one environment, from the current records:
 *   1. a record serving exactly this environment → edit its value (skip when equal);
 *   2. a record serving this environment AND others → equal value: nothing to do;
 *      otherwise split — this environment is removed from it and a new record
 *      for this environment alone is created. The shared record is never deleted;
 *   3. no record → create one.
 * Records for other keys are never looked at.
 */
export function planVar(
  name: string,
  value: string,
  records: readonly VercelEnvRecord[],
  scope: EnvScope,
): VarPlan {
  const serving = records.filter((r) => covers(r, name, scope));
  const exact = serving.find((r) => envKeysOf(r).length === 1);
  if (exact) {
    return readableValue(exact) === value
      ? { kind: 'unchanged', name, record: exact }
      : { kind: 'update', name, value, record: exact };
  }
  const shared = serving[0];
  if (shared) {
    return readableValue(shared) === value
      ? { kind: 'unchanged', name, record: shared }
      : { kind: 'split', name, value, shared, type: typeLike(shared) };
  }
  return { kind: 'create', name, value, type: 'encrypted' };
}

/**
 * The record a plan would replace the value of, when Vercel holds it as sensitive. Capy cannot read such a
 * value, so it cannot tell whether the new one differs: every deploy would replace it.
 */
function replacedRecord(plan: VarPlan): VercelEnvRecord | undefined {
  if (plan.kind === 'update') return plan.record;
  return plan.kind === 'split' ? plan.shared : undefined;
}

/** The names whose plan replaces a value Vercel holds as sensitive. */
export function plansReplacingSensitive(plans: readonly VarPlan[]): readonly string[] {
  return plans.filter((plan) => replacedRecord(plan)?.type === 'sensitive').map((plan) => plan.name);
}

/** Dry-run counterpart of `plansReplacingSensitive`: the names a deploy would replace a sensitive value of (names only, no values needed). */
export function sensitiveReplacements(names: readonly string[], records: readonly VercelEnvRecord[], scope: EnvScope): readonly string[] {
  const replaced = (name: string): VercelEnvRecord | undefined => {
    const serving = records.filter((r) => covers(r, name, scope));
    return serving.find((r) => envKeysOf(r).length === 1) ?? serving[0];
  };
  return names.filter((name) => replaced(name)?.type === 'sensitive');
}

/** `planVar` for every name, in order. */
export function planAll(
  vars: ReadonlyArray<readonly [string, string]>,
  records: readonly VercelEnvRecord[],
  scope: EnvScope,
): readonly VarPlan[] {
  return vars.map(([name, value]) => planVar(name, value, records, scope));
}

/** Names only, per kind — all a dry run may say. Without values, "unchanged" cannot be known. */
export function dryRunSummary(
  names: readonly string[],
  records: readonly VercelEnvRecord[],
  scope: EnvScope,
): { create: readonly string[]; update: readonly string[]; split: readonly string[] } {
  const kindOf = (name: string): 'create' | 'update' | 'split' => {
    const serving = records.filter((r) => covers(r, name, scope));
    if (serving.some((r) => envKeysOf(r).length === 1)) return 'update';
    return serving.length > 0 ? 'split' : 'create';
  };
  const kinds = names.map((name) => ({ name, kind: kindOf(name) }));
  const pick = (k: 'create' | 'update' | 'split') => kinds.filter((x) => x.kind === k).map((x) => x.name);
  return { create: pick('create'), update: pick('update'), split: pick('split') };
}

// ── Applying ───────────────────────────────────────────────────────────────

export type WriteOutcome = 'created' | 'updated' | 'split' | 'unchanged';

export interface AppliedVar {
  name: string;
  outcome: WriteOutcome;
  /** The Vercel record now holding this environment's value. */
  envId: string;
  /** The type Vercel reports for that record, when it said. */
  type?: string;
}

export type ApplyResult =
  | { ok: true; applied: readonly AppliedVar[] }
  | { ok: false; code: ErrorCode; status?: number; name: string; applied: readonly AppliedVar[] };

function sortedCopy<T>(xs: readonly T[], cmp?: (a: T, b: T) => number): T[] {
  return Array.from(xs).sort(cmp);
}

/** Body that removes `scope` from a shared record, leaving every other environment it serves exactly as it was. */
function detachBody(shared: VercelEnvRecord, scope: EnvScope): Record<string, unknown> {
  const key = scopeKey(scope);
  const remainingStandard = targetsOf(shared).filter((t) => t !== key);
  const remainingCustom = customIdsOf(shared).filter((id) => `custom:${id}` !== key);
  const lostBranchScope = scope.kind === 'standard' && scope.env === 'preview' && !!shared.gitBranch;
  return {
    target: remainingStandard,
    ...(shared.customEnvironmentIds ? { customEnvironmentIds: remainingCustom } : {}),
    // A git branch is only valid while the record still serves Preview.
    ...(lostBranchScope && !remainingStandard.includes('preview') ? { gitBranch: null } : {}),
  };
}

/** Body that puts a shared record back exactly as listed. */
function restoreBody(shared: VercelEnvRecord): Record<string, unknown> {
  return {
    target: targetsOf(shared),
    ...(shared.customEnvironmentIds ? { customEnvironmentIds: customIdsOf(shared) } : {}),
    ...(shared.gitBranch ? { gitBranch: shared.gitBranch } : {}),
  };
}

/** POST body for a brand-new record serving only `scope`. */
function createBody(name: string, value: string, type: NewRecordType, scope: EnvScope): Record<string, unknown> {
  if (scope.kind === 'custom') {
    return { key: name, value, type, customEnvironmentIds: [scope.id] };
  }
  return {
    key: name,
    value,
    type,
    target: [scope.env],
    ...(scope.env === 'preview' && scope.gitBranch ? { gitBranch: scope.gitBranch } : {}),
  };
}

type OneResult =
  | { ok: true; applied: AppliedVar }
  | { ok: false; code: ErrorCode; status?: number };

async function applyOne(client: VercelClient, plan: VarPlan, scope: EnvScope): Promise<OneResult> {
  try {
    if (plan.kind === 'unchanged') {
      return { ok: true, applied: { name: plan.name, outcome: 'unchanged', envId: plan.record.id, type: plan.record.type } };
    }
    if (plan.kind === 'update') {
      const got = await client.patchEnv(plan.record.id, { value: plan.value });
      return { ok: true, applied: { name: plan.name, outcome: 'updated', envId: plan.record.id, type: got.type ?? plan.record.type } };
    }
    if (plan.kind === 'create') {
      const made = await client.createEnv(createBody(plan.name, plan.value, plan.type, scope));
      return { ok: true, applied: { name: plan.name, outcome: 'created', envId: made.id, type: made.type } };
    }
    return await applySplit(client, plan, scope);
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * Detach this environment from the shared record, then create its own record.
 * The order matters: while the shared record still serves this environment, a
 * create would collide with it. If the create fails after the detach, the
 * detach is undone so the environment does not lose the var; if even that
 * fails the result says so (`VERCEL_SPLIT_NOT_RESTORED`).
 */
async function applySplit(
  client: VercelClient,
  plan: Extract<VarPlan, { kind: 'split' }>,
  scope: EnvScope,
): Promise<OneResult> {
  await client.patchEnv(plan.shared.id, detachBody(plan.shared, scope));
  try {
    const made = await client.createEnv(createBody(plan.name, plan.value, plan.type, scope));
    return { ok: true, applied: { name: plan.name, outcome: 'split', envId: made.id, type: made.type } };
  } catch (createErr) {
    const restored = await client
      .patchEnv(plan.shared.id, restoreBody(plan.shared))
      .then(() => true)
      .catch(() => false);
    if (!restored) return { ok: false, code: ERROR_CODES.VERCEL_SPLIT_NOT_RESTORED };
    return failureOf(createErr);
  }
}

/** Apply every plan, one request at a time, stopping at the first failure. */
export async function applyPlans(
  client: VercelClient,
  plans: readonly VarPlan[],
  scope: EnvScope,
): Promise<ApplyResult> {
  const step = async (index: number, done: readonly AppliedVar[]): Promise<ApplyResult> => {
    const plan = plans[index];
    if (!plan) return { ok: true, applied: done };
    const result = await applyOne(client, plan, scope);
    if (!result.ok) return { ok: false, code: result.code, status: result.status, name: plan.name, applied: done };
    return step(index + 1, [...done, result.applied]);
  };
  return step(0, []);
}

// ── Verification ───────────────────────────────────────────────────────────

export type VerifyState = 'verified' | 'unverified' | 'mismatch';

export interface VerifiedVar {
  name: string;
  state: VerifyState;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Re-read what Vercel holds and compare SHA-256 hashes in memory (the values
 * themselves are never printed or kept). Sensitive records cannot be read —
 * they are `unverified`, never `verified`. A record Vercel will not decrypt
 * is the same.
 */
export async function verifyApplied(
  client: VercelClient,
  applied: readonly AppliedVar[],
  expected: Readonly<Record<string, string>>,
): Promise<{ ok: true; results: readonly VerifiedVar[] } | { ok: false; code: ErrorCode; status?: number }> {
  const step = async (
    index: number,
    done: readonly VerifiedVar[],
  ): Promise<{ ok: true; results: readonly VerifiedVar[] } | { ok: false; code: ErrorCode; status?: number }> => {
    const item = applied[index];
    if (!item) return { ok: true, results: done };
    if (item.outcome === 'unchanged') {
      // Equal by comparison against the decrypted list read — already verified.
      return step(index + 1, [...done, { name: item.name, state: 'verified' }]);
    }
    try {
      const rec = await client.getEnv(item.envId);
      const readable = readableValue(rec);
      const state: VerifyState =
        readable === undefined
          ? 'unverified'
          : sha256(readable) === sha256(expected[item.name] ?? '')
            ? 'verified'
            : 'mismatch';
      return step(index + 1, [...done, { name: item.name, state }]);
    } catch (err) {
      return failureOf(err);
    }
  };
  return step(0, []);
}

/** Names in `names`, sorted — for stable, value-free messages. */
export function sortedNames(names: readonly string[]): string[] {
  return sortedCopy(names);
}

// ── Messages ───────────────────────────────────────────────────────────────

/** A coded refusal as a printable reason + hint. Callers branch on `code`; this text is display only. */
export function describeVercelFailure(
  code: ErrorCode,
  status?: number,
  team?: string,
): { reason: string; hint?: string; link?: { label: string; url: string }; remedy?: string } {
  const http = status !== undefined ? ` (HTTP ${status})` : '';
  if (code === ERROR_CODES.VERCEL_TOKEN_REJECTED) {
    // COPY-FLAG
    return { reason: `Vercel rejected the token${http}`, hint: `Replace it: capy system set ${VERCEL_TARGET_SECRET_NAME}`, ...vercelTargetKeyHelp(team) };
  }
  if (code === ERROR_CODES.VERCEL_NO_ACCESS) {
    // COPY-FLAG
    return { reason: `the Vercel token has no access to this project${http}`, ...vercelTargetTokenProblemHelp() };
  }
  if (code === ERROR_CODES.VERCEL_PROJECT_NOT_FOUND) {
    // COPY-FLAG
    return { reason: `Vercel project not found${http}`, hint: 'Check options.projectId and options.teamId.' };
  }
  if (code === ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND) {
    // COPY-FLAG
    return { reason: `Vercel environment not found on the project${http}`, hint: 'Check options.vercelEnv / options.customEnvironmentId.' };
  }
  if (code === ERROR_CODES.VERCEL_NETWORK_ERROR) {
    // COPY-FLAG
    return { reason: 'could not reach the Vercel API' };
  }
  if (code === ERROR_CODES.VERCEL_RATE_LIMITED) {
    // COPY-FLAG
    return { reason: `Vercel rate limit reached${http}`, hint: 'Wait a minute and run again.' };
  }
  if (code === ERROR_CODES.VERCEL_SPLIT_NOT_RESTORED) {
    // COPY-FLAG
    return { reason: 'a shared Vercel variable lost this environment and could not be restored', hint: 'Check the project’s Environment Variables in Vercel.' };
  }
  // COPY-FLAG
  return { reason: `Vercel API call failed (${code}${http})` };
}

/** Narrows a store-supplied code string to a known `ErrorCode`, else the generic token-missing code. */
export function asKnownErrorCode(code: string): ErrorCode {
  const known = Object.values(ERROR_CODES) as readonly string[];
  return known.includes(code) ? (code as ErrorCode) : ERROR_CODES.VERCEL_TOKEN_MISSING;
}
