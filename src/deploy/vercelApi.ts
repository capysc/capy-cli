/**
 * Vercel REST client + env-record primitives for `capy connect vercel`
 * (CAP-696): a ONE-TIME, READ-ONLY import of a Vercel project's environment
 * variables.
 *
 * READ-ONLY by construction: every request goes through `VercelFetchLike`,
 * whose `method` is the literal type `'GET'`, and this file contains no other
 * verb. The token is a header on every request and is never part of an error
 * message, a URL, or a return value.
 *
 * Docs checked (2026-10-01), every path/version/field below:
 *   - Teams:        https://vercel.com/docs/rest-api/teams/list-all-teams
 *                   GET /v2/teams, `limit`, `until`; `teams[].{id,slug,name}`;
 *                   `pagination.next` is a timestamp for `until`.
 *   - Projects:     https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects
 *                   GET /v10/projects, `limit`, `from` (a "timestamp or
 *                   continuation token" — the docs list `from`, not `until`,
 *                   for this endpoint), `teamId`; `projects[].{id,name,
 *                   rootDirectory,link}`, `pagination.next`. `link` is
 *                   undocumented beyond the GitHub shape
 *                   (`type:'github'`, `org`, `repo`, `productionBranch`).
 *   - One project:  GET /v9/projects/{idOrName} (projects index page).
 *   - Env list:     https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name
 *                   GET /v10/projects/{idOrName}/env; `envs[].{id,key,type,
 *                   target,gitBranch,customEnvironmentIds,configurationId,
 *                   value}`; `type` is encrypted | plain | secret | sensitive
 *                   | system; `target` is an array OR a string.
 *   - Env value:    https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id
 *                   GET /v1/projects/{idOrName}/env/{id} — "Retrieve the
 *                   decrypted value of an environment variable of a project
 *                   by id". Neither this route nor the list's `decrypt=true`
 *                   is marked deprecated; this connector uses the per-id
 *                   route so the list (names + metadata) never carries
 *                   values.
 *   - Custom envs:  https://vercel.com/docs/rest-api/environment/retrieve-custom-environments
 *                   GET /v9/projects/{idOrName}/custom-environments →
 *                   `{ environments: [{ id, slug, type, ... }] }`.
 *   - Rate limits:  429, `X-RateLimit-Limit/Remaining/Reset` (reset in UTC
 *                   epoch seconds); error body `error.code === 'rate_limited'`
 *                   with `error.limit.{reset,resetMs}`
 *                   (https://vercel.com/docs/rest-api/errors).
 *   - Team scope:   query `teamId` (or `slug`) on every endpoint above.
 */
import { ERROR_CODES } from '../types/index';
import { sortedCopy } from './dokployApi';
import { keyHelpFields, vercelTokenProblemHelp } from './keyHelp';

// ── Names ────────────────────────────────────────────────────────────────────

/** Org system store entry that holds the Vercel token for IMPORT (`capy connect vercel`, inbound). */
export const VERCEL_CONNECTOR_SECRET_NAME = '_CONNECTOR_VERCEL_TOKEN';

/** Org system store entry that holds the Vercel token for DEPLOY (`capy deploy`, outbound). A SEPARATE key on purpose — see `DOKPLOY_TARGET_SECRET_NAME`. */
export const VERCEL_TARGET_SECRET_NAME = '_TARGET_VERCEL_TOKEN';

/** The env var read when no `--token-env` is given and the system store has no entry — mirrors Dokploy's `DOKPLOY_API_KEY` fallback. */
export const DEFAULT_VERCEL_TOKEN_ENV = 'VERCEL_TOKEN';

export const VERCEL_API_BASE = 'https://api.vercel.com';

/** The three built-in Vercel environments; every project has them whether or not any variable targets them. */
export const VERCEL_STANDARD_ENVIRONMENTS = ['production', 'preview', 'development'] as const;
export type VercelStandardEnvironment = (typeof VERCEL_STANDARD_ENVIRONMENTS)[number];

// ── Shapes (only the fields we read) ─────────────────────────────────────────

export interface VercelTeam {
  id: string;
  slug: string;
  name?: string;
}

/** A project's git link. Only `github` is documented well enough to match on; everything else is carried as `unsupported` so it can be REPORTED, never guessed at. */
export type VercelGitLink =
  | { kind: 'github'; org: string; repo: string; productionBranch?: string }
  | { kind: 'unsupported'; type: string; productionBranch?: string };

export interface VercelProject {
  id: string;
  name: string;
  /** `null`/absent/'' all mean the repo root. */
  rootDirectory: string | null;
  link: VercelGitLink | null;
}

/** How a custom environment picks the git branches it deploys: Vercel's branch matcher. A type this client does not know is dropped, never guessed at. */
export type VercelBranchMatcherType = 'equals' | 'startsWith' | 'endsWith';

export interface VercelBranchMatcher {
  readonly type: VercelBranchMatcherType;
  readonly pattern: string;
}

export interface VercelCustomEnvironment {
  id: string;
  slug: string;
  /** The environment's branch rule; absent when it has none. */
  branchMatcher?: VercelBranchMatcher;
}

/** One preview deployment, as far as discovery reads it: the git branch it built from (`meta.githubCommitRef`), when Vercel names one. A name only. */
export interface VercelDeployment {
  readonly id: string;
  readonly gitBranch?: string;
}

export interface VercelEnvRecord {
  id: string;
  key: string;
  /** `system` | `secret` | `encrypted` | `plain` | `sensitive` — kept as a plain string so a type Vercel adds later is `unsupported_type`, never a crash. */
  type: string;
  /** `target` normalized: the array form, the string form wrapped, absent → `[]` (custom-environment-only records). */
  targets: readonly string[];
  /** Preview-only branch scoping. Absent/'' = all branches. */
  gitBranch?: string;
  customEnvironmentIds: readonly string[];
  configurationId?: string;
  /** Present on the list response for `plain` records; never for `sensitive`; ciphertext-or-absent for `encrypted` (which is why values come from the per-id route). */
  value?: string;
}

/** Which Vercel object an import read from — the `source` in the import's JSON, parallel to `DokployImportSource`. */
export interface VercelImportSource {
  kind: 'vercel';
  projectId: string;
  projectName: string;
  /** Absent for a personal-account project. */
  teamId?: string;
  /** The Vercel environment: `production` | `preview` | `development` | a custom slug. */
  environment: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type VercelErrorCode =
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'bad_response';

/**
 * What a request was reading, set by the client method that made it. A 403
 * carries it so the refusal can name what the token could not access: it is a
 * structured field, never parsed out of a message.
 */
export type VercelResource =
  | { readonly kind: 'teams' }
  | { readonly kind: 'projects' }
  | { readonly kind: 'project'; readonly project: string }
  | { readonly kind: 'project_envs'; readonly project: string }
  | { readonly kind: 'project_deployments'; readonly project: string };

export class VercelApiError extends Error {
  constructor(
    public readonly code: VercelErrorCode,
    public readonly status: number | null,
    message: string,
    public readonly resource?: VercelResource,
  ) {
    super(message);
    this.name = 'VercelApiError';
  }
}

function codeForStatus(status: number): VercelErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}

/** A failed Vercel call as a refusal: a stable code and a message, plus where to get a better token when the token is the problem. */
export interface MappedVercelError {
  code: string;
  message: string;
  link?: { label: string; url: string };
  remedy?: string;
}

export interface MapVercelApiErrorOptions {
  /** Discovery reads every team and project: a 403 on those lists says the token must cover the whole team. */
  discovery?: boolean;
}

function deniedResource(resource: VercelResource | undefined): string {
  if (!resource) return 'the request';
  if (resource.kind === 'teams') return 'the team list';
  if (resource.kind === 'projects') return 'the project list';
  if (resource.kind === 'project') return `project ${resource.project}`;
  if (resource.kind === 'project_deployments') return `the deployments of project ${resource.project}`;
  return `the environment variables of project ${resource.project}`;
}

function forbiddenMessage(err: VercelApiError, discovery: boolean): string {
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const denied = `Vercel denied access to ${deniedResource(err.resource)} (HTTP ${err.status}).`;
  const kind = err.resource?.kind;
  if (discovery && (kind === 'teams' || kind === 'projects')) {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    return `${denied} Discovery needs a token scoped to the whole team.`;
  }
  return denied;
}

/**
 * A failed Vercel call as a stable refusal code + message. Never a value.
 * Branches on the typed error's `code`, never on its text. A token problem
 * (401 rejected, 403 no access) carries the token page and the two steps.
 */
export function mapVercelApiError(err: unknown, options: MapVercelApiErrorOptions = {}): MappedVercelError {
  if (err instanceof VercelApiError) {
    if (err.code === 'unauthorized') {
      return {
        code: ERROR_CODES.VERCEL_AUTH_FAILED,
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        message: `Vercel rejected the token (HTTP ${err.status}).`,
        ...keyHelpFields(vercelTokenProblemHelp(VERCEL_CONNECTOR_SECRET_NAME)),
      };
    }
    if (err.code === 'forbidden') {
      return {
        code: ERROR_CODES.VERCEL_NO_ACCESS,
        message: forbiddenMessage(err, options.discovery === true),
        ...keyHelpFields(vercelTokenProblemHelp(VERCEL_CONNECTOR_SECRET_NAME)),
      };
    }
    if (err.code === 'rate_limited') {
      return { code: ERROR_CODES.VERCEL_RATE_LIMITED, message: err.message };
    }
    return { code: ERROR_CODES.VERCEL_API_ERROR, message: err.message };
  }
  return { code: ERROR_CODES.VERCEL_API_ERROR, message: err instanceof Error ? err.message : String(err) };
}

// ── HTTP client ──────────────────────────────────────────────────────────────

/**
 * `fetch`'s shape, narrowed: GET only (read-only is a type, not a promise),
 * and the response carries `headers` — the rate-limit wait is read from them.
 * The global `fetch` satisfies it.
 */
export type VercelFetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    /** Always `'error'`: a redirect must fail rather than re-send the bearer token to whatever host a 30x names. */
    redirect?: 'error' | 'manual' | 'follow';
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface VercelClientOptions {
  fetch?: VercelFetchLike;
  baseUrl?: string;
  /** Injectable so a 429 test never really waits. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How many times one request is retried after a 429. Default 3. */
  maxRetries?: number;
  /** A requested wait longer than this is refused rather than slept. Default 60 000 ms. */
  maxWaitMs?: number;
  /**
   * Never keep an env record's `value`: the list response may carry one for a
   * plain record, and a caller that only needs NAMES (`capy deploy vercel
   * --discover`) must not hold it, even in memory.
   */
  dropValues?: boolean;
}

export interface VercelEnvList {
  envs: readonly VercelEnvRecord[];
  /** True when Vercel said there is a next page this client cannot ask for (the env list documents no paging parameter). */
  truncated: boolean;
}

/** The read-only surface the connector needs. No method here can write. */
export interface VercelClient {
  listTeams(): Promise<readonly VercelTeam[]>;
  listProjects(teamId?: string): Promise<readonly VercelProject[]>;
  getProject(idOrName: string, teamId?: string): Promise<VercelProject>;
  listCustomEnvironments(projectId: string, teamId?: string): Promise<readonly VercelCustomEnvironment[]>;
  listEnvs(projectId: string, teamId?: string): Promise<VercelEnvList>;
  /** The project's most recent preview deployments (one page, newest first, at most `limit`). */
  listPreviewDeployments(projectId: string, teamId?: string, limit?: number): Promise<readonly VercelDeployment[]>;
  /**
   * The decrypted value of one env record, `undefined` when Vercel returned none, or
   * `{ decrypted: false }` when Vercel says it did not decrypt the value (its structured
   * `decrypted: false` field; never judged by the value's text).
   */
  getEnvValue(projectId: string, envId: string, teamId?: string): Promise<VercelEnvValue>;
}

/** Vercel answered the per-id route but did not decrypt the value (for instance a role that cannot read production values). */
export interface VercelUndecryptedValue {
  readonly decrypted: false;
}

/** What the per-id value route gave back: the value, nothing, or "not decrypted". */
export type VercelEnvValue = string | undefined | VercelUndecryptedValue;

export const isUndecrypted = (value: VercelEnvValue): value is VercelUndecryptedValue => typeof value === 'object';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;
const MAX_PAGES = 100;
const PAGE_LIMIT = '100';
/** How many recent preview deployments discovery counts branches over (Vercel's maximum page). */
export const PREVIEW_DEPLOYMENTS_LIMIT = 100;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const nonEmptyString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A pagination cursor: a finite number (a timestamp) or a non-empty string (a continuation token), as text. */
const cursorOf = (v: unknown): string | null => {
  const n = numberOrNull(v);
  if (n !== null) return String(n);
  return typeof v === 'string' && v !== '' ? v : null;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    throw new VercelApiError('bad_response', null, 'Vercel returned a response that is not JSON.');
  }
}

/** Milliseconds to wait before retrying a 429, from `Retry-After` (seconds), else `X-RateLimit-Reset` (epoch seconds), else the error body's `limit.resetMs`, else a short default. */
export function rateLimitWaitMs(
  headers: { get(name: string): string | null } | undefined,
  bodyText: string,
  nowMs: number,
): number {
  const retryAfter = Number(headers?.get('retry-after'));
  if (headers?.get('retry-after') != null && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  const reset = Number(headers?.get('x-ratelimit-reset'));
  if (headers?.get('x-ratelimit-reset') != null && Number.isFinite(reset)) return Math.max(0, reset * 1000 - nowMs);
  const resetMs = readBodyResetMs(bodyText);
  return resetMs === null ? DEFAULT_RETRY_WAIT_MS : Math.max(0, resetMs - nowMs);
}

function readBodyResetMs(bodyText: string): number | null {
  try {
    const body = asRecord(JSON.parse(bodyText));
    const limit = asRecord(asRecord(body?.error)?.limit);
    return numberOrNull(limit?.resetMs);
  } catch {
    return null;
  }
}

export function createVercelClient(token: string, options: VercelClientOptions = {}): VercelClient {
  const fetchImpl: VercelFetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.baseUrl ?? VERCEL_API_BASE).replace(/\/+$/, '');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const urlFor = (path: string, query: Readonly<Record<string, string | undefined>>): string => {
    const qs = new URLSearchParams(
      Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string]])),
    ).toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  };

  const attempt = async (url: string, retriesLeft: number, resource: VercelResource): Promise<unknown> => {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
    }).catch((): never => {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      throw new VercelApiError('unreachable', null, 'Could not reach Vercel.');
    });
    const text = await res.text();
    if (res.status === 429) {
      const waitMs = rateLimitWaitMs(res.headers, text, now());
      if (retriesLeft <= 0 || waitMs > maxWaitMs) {
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        throw new VercelApiError('rate_limited', 429, 'Vercel rate limit reached; try again later.');
      }
      await sleep(waitMs);
      return attempt(url, retriesLeft - 1, resource);
    }
    if (!res.ok) {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      throw new VercelApiError(codeForStatus(res.status), res.status, `Vercel returned HTTP ${res.status}.`, resource);
    }
    return parseJson(text);
  };

  const get = (path: string, resource: VercelResource, query: Readonly<Record<string, string | undefined>> = {}): Promise<unknown> =>
    attempt(urlFor(path, query), maxRetries, resource);

  const enc = encodeURIComponent;

  return {
    async listTeams() {
      const collect = async (until: string | undefined, seen: readonly string[], page: number): Promise<readonly VercelTeam[]> => {
        const body = asRecord(await get('/v2/teams', { kind: 'teams' }, { limit: PAGE_LIMIT, until }));
        const teams = (Array.isArray(body?.teams) ? body.teams : []).flatMap((t) => {
          const parsed = parseTeam(t);
          return parsed ? [parsed] : [];
        });
        const fresh = teams.filter((t) => !seen.includes(t.id));
        const next = numberOrNull(asRecord(body?.pagination)?.next);
        if (next === null || fresh.length === 0 || page >= MAX_PAGES) return fresh;
        return [...fresh, ...(await collect(String(next), [...seen, ...fresh.map((t) => t.id)], page + 1))];
      };
      return collect(undefined, [], 1);
    },

    async listProjects(teamId) {
      const collect = async (from: string | undefined, seen: readonly string[], page: number): Promise<readonly VercelProject[]> => {
        const body = await get('/v10/projects', { kind: 'projects' }, { limit: PAGE_LIMIT, from, teamId });
        const list = Array.isArray(body) ? body : asRecord(body)?.projects;
        const projects = (Array.isArray(list) ? list : []).flatMap((p) => {
          const parsed = parseProject(p);
          return parsed ? [parsed] : [];
        });
        // A page with nothing new ends the walk: a server that ignores the
        // continuation parameter would otherwise be asked for page 1 forever.
        const fresh = projects.filter((p) => !seen.includes(p.id));
        // The docs call `from` a "timestamp or continuation token" and give `next` no type: take either.
        const next = Array.isArray(body) ? null : cursorOf(asRecord(asRecord(body)?.pagination)?.next);
        if (next === null || fresh.length === 0 || page >= MAX_PAGES) return fresh;
        return [...fresh, ...(await collect(next, [...seen, ...fresh.map((p) => p.id)], page + 1))];
      };
      return collect(undefined, [], 1);
    },

    async getProject(idOrName, teamId) {
      const parsed = parseProject(await get(`/v9/projects/${enc(idOrName)}`, { kind: 'project', project: idOrName }, { teamId }));
      if (!parsed) {
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        throw new VercelApiError('bad_response', null, 'Vercel returned a project this client cannot read.');
      }
      return parsed;
    },

    async listCustomEnvironments(projectId, teamId) {
      const body = asRecord(await get(`/v9/projects/${enc(projectId)}/custom-environments`, { kind: 'project_envs', project: projectId }, { teamId }));
      return (Array.isArray(body?.environments) ? body.environments : []).flatMap((e) => {
        const rec = asRecord(e);
        const id = nonEmptyString(rec?.id);
        const slug = nonEmptyString(rec?.slug);
        const branchMatcher = parseBranchMatcher(rec?.branchMatcher);
        return id && slug ? [{ id, slug, ...(branchMatcher ? { branchMatcher } : {}) }] : [];
      });
    },

    async listPreviewDeployments(projectId, teamId, limit = PREVIEW_DEPLOYMENTS_LIMIT) {
      const body = asRecord(
        await get('/v6/deployments', { kind: 'project_deployments', project: projectId }, { projectId, target: 'preview', limit: String(limit), teamId }),
      );
      return (Array.isArray(body?.deployments) ? body.deployments : []).flatMap((d): readonly VercelDeployment[] => {
        const rec = asRecord(d);
        const id = nonEmptyString(rec?.uid) ?? nonEmptyString(rec?.id);
        const gitBranch = nonEmptyString(asRecord(rec?.meta)?.githubCommitRef);
        return id ? [{ id, ...(gitBranch ? { gitBranch } : {}) }] : [];
      });
    },

    async listEnvs(projectId, teamId) {
      const body = asRecord(await get(`/v10/projects/${enc(projectId)}/env`, { kind: 'project_envs', project: projectId }, { teamId }));
      const envs = (Array.isArray(body?.envs) ? body.envs : []).flatMap((e) => {
        const parsed = parseEnvRecord(e, options.dropValues === true);
        return parsed ? [parsed] : [];
      });
      const next = numberOrNull(asRecord(body?.pagination)?.next);
      return { envs, truncated: next !== null };
    },

    async getEnvValue(projectId, envId, teamId) {
      const body = asRecord(await get(`/v1/projects/${enc(projectId)}/env/${enc(envId)}`, { kind: 'project_envs', project: projectId }, { teamId }));
      if (body?.decrypted === false) return { decrypted: false };
      return typeof body?.value === 'string' ? body.value : undefined;
    },
  };
}

function parseBranchMatcher(raw: unknown): VercelBranchMatcher | undefined {
  const rec = asRecord(raw);
  const type = rec?.type;
  const pattern = nonEmptyString(rec?.pattern);
  return pattern && (type === 'equals' || type === 'startsWith' || type === 'endsWith') ? { type, pattern } : undefined;
}

function parseTeam(raw: unknown): VercelTeam | null {
  const rec = asRecord(raw);
  const id = nonEmptyString(rec?.id);
  const slug = nonEmptyString(rec?.slug);
  if (!id || !slug) return null;
  const name = nonEmptyString(rec?.name);
  return { id, slug, ...(name ? { name } : {}) };
}

/** `link` → a github link we can match on, or `unsupported` carrying the provider type so it can be reported. */
export function parseGitLink(raw: unknown): VercelGitLink | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const type = nonEmptyString(rec.type) ?? 'unknown';
  const productionBranch = nonEmptyString(rec.productionBranch);
  const branch = productionBranch ? { productionBranch } : {};
  const org = nonEmptyString(rec.org);
  const repo = nonEmptyString(rec.repo);
  if (type === 'github' && org && repo) return { kind: 'github', org, repo, ...branch };
  return { kind: 'unsupported', type, ...branch };
}

function parseProject(raw: unknown): VercelProject | null {
  const rec = asRecord(raw);
  const id = nonEmptyString(rec?.id);
  const name = nonEmptyString(rec?.name);
  if (!rec || !id || !name) return null;
  return { id, name, rootDirectory: nonEmptyString(rec.rootDirectory) ?? null, link: parseGitLink(rec.link) };
}

function parseTargets(raw: unknown): readonly string[] {
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

function parseEnvRecord(raw: unknown, dropValue: boolean = false): VercelEnvRecord | null {
  const rec = asRecord(raw);
  const id = nonEmptyString(rec?.id);
  const key = nonEmptyString(rec?.key);
  const type = nonEmptyString(rec?.type);
  if (!rec || !id || !key || !type) return null;
  const gitBranch = nonEmptyString(rec.gitBranch);
  const configurationId = nonEmptyString(rec.configurationId);
  return {
    id,
    key,
    type,
    targets: parseTargets(rec.target),
    customEnvironmentIds: Array.isArray(rec.customEnvironmentIds)
      ? rec.customEnvironmentIds.filter((c): c is string => typeof c === 'string')
      : [],
    ...(gitBranch ? { gitBranch } : {}),
    ...(configurationId ? { configurationId } : {}),
    ...(!dropValue && typeof rec.value === 'string' ? { value: rec.value } : {}),
  };
}

// ── Token resolution ─────────────────────────────────────────────────────────

export type VercelTokenSource = 'system' | 'env';

export type ResolveVercelTokenResult =
  | { ok: true; value: string; source: VercelTokenSource }
  | { ok: false; code: string };

/** What the system store's `getConnectorSecret` needs — same shape as `system/systemStore.ts#GetConnectorSecretOptions`. */
export interface VercelSystemStoreCallOptions {
  orgId?: string;
  interactive: boolean;
  devMode?: boolean;
  apiUrl?: string;
  /** The slug of the team that owns the project, when known: the hidden prompt's token instructions name it. */
  helpTeam?: string;
}

export interface ResolveVercelTokenOptions {
  /** `--token-env`. Wins outright when that variable is actually set. */
  tokenEnv?: string;
  env: Record<string, string | undefined>;
  /** Whether this run may let the store prompt a human (hidden input + save). */
  interactive: boolean;
  orgId?: string;
  devMode?: boolean;
  apiUrl?: string;
  /** See `VercelSystemStoreCallOptions.helpTeam`. */
  helpTeam?: string;
  /**
   * Reads (and, when missing + interactive + admin, prompts for and saves)
   * the org system store entry. Defaults to a function that never touches the
   * network, so every test and every other caller gets zero store traffic
   * unless it opts in — the `vercelConnector` singleton wires the real one.
   */
  getConnectorSecret?: (name: string, opts: VercelSystemStoreCallOptions) => Promise<string | null>;
}

async function neverReachesTheStore(): Promise<null> {
  return null;
}

/** A typed store error (`CapyError`-shaped: `{code: string}`) as its code — never its `.message`. */
function storeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : ERROR_CODES.VERCEL_TOKEN_MISSING;
}

type StoreOutcome = { kind: 'value'; value: string } | { kind: 'empty' } | { kind: 'error'; code: string };

async function readFromSystemStore(
  getConnectorSecret: NonNullable<ResolveVercelTokenOptions['getConnectorSecret']>,
  callOpts: VercelSystemStoreCallOptions,
): Promise<StoreOutcome> {
  try {
    const value = await getConnectorSecret(VERCEL_CONNECTOR_SECRET_NAME, callOpts);
    return value ? { kind: 'value', value } : { kind: 'empty' };
  } catch (err) {
    return { kind: 'error', code: storeErrorCode(err) };
  }
}

/**
 * The Vercel token for one command, in the order Dokploy's key resolves:
 *
 *   1. An explicit `--token-env` variable, when it is actually set.
 *   2. The org system store's `_CONNECTOR_VERCEL_TOKEN` (missing + interactive
 *      + admin: the store itself asks, hidden input, and saves it).
 *   3. `$VERCEL_TOKEN`.
 *   4. Refused: the store's own coded error when it refused (non-admin, …),
 *      otherwise `VERCEL_TOKEN_MISSING`.
 */
export async function resolveVercelToken(opts: ResolveVercelTokenOptions): Promise<ResolveVercelTokenResult> {
  const explicit = opts.tokenEnv?.trim();
  const fromExplicit = explicit ? opts.env[explicit] || null : null;
  if (fromExplicit) return { ok: true, value: fromExplicit, source: 'env' };

  const storeOutcome = await readFromSystemStore(opts.getConnectorSecret ?? neverReachesTheStore, {
    orgId: opts.orgId,
    interactive: opts.interactive,
    devMode: opts.devMode,
    apiUrl: opts.apiUrl,
    ...(opts.helpTeam ? { helpTeam: opts.helpTeam } : {}),
  });
  if (storeOutcome.kind === 'value') return { ok: true, value: storeOutcome.value, source: 'system' };

  const fallback = opts.env[DEFAULT_VERCEL_TOKEN_ENV] || null;
  if (fallback) return { ok: true, value: fallback, source: 'env' };

  return storeOutcome.kind === 'error'
    ? { ok: false, code: storeOutcome.code }
    : { ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING };
}

/** Whether a run may let the system store prompt for a missing token: a real TTY, and none of `--web`, `--json`, `--dry-run` (a preview must never save a key). */
export function vercelSecretsMayPrompt(baseInteractive: boolean, suppressed: boolean): boolean {
  return baseInteractive && !suppressed;
}

/** A token-resolution refusal as a printable reason + hint — names only. */
export function describeVercelTokenProblem(code: string, tokenEnv: string): { reason: string; hint: string } {
  if (code === ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `only an org owner or admin can set ${VERCEL_CONNECTOR_SECRET_NAME} in the system store, and $${tokenEnv} is not set`,
      hint: `Ask an org owner/admin to run \`capy system set ${VERCEL_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv} yourself.`,
    };
  }
  if (code === ERROR_CODES.VERCEL_CONNECTOR_KEY_MISSING) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `${VERCEL_CONNECTOR_SECRET_NAME} is not set, but ${VERCEL_TARGET_SECRET_NAME} already holds a Vercel token`,
      hint: `Run this interactively to choose whether to reuse it, or run \`capy system set ${VERCEL_CONNECTOR_SECRET_NAME}\` to set a dedicated one.`,
    };
  }
  if (code === ERROR_CODES.VERCEL_TOKEN_MISSING) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `$${tokenEnv} is not set`,
      hint: `Run \`capy system set ${VERCEL_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv}=… first.`,
    };
  }
  return {
    // COPY-FLAG: minimal neutral wording.
    reason: `could not resolve the Vercel token (${code})`,
    hint: `Run \`capy system set ${VERCEL_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv}=… first.`,
  };
}

// ── Teams ────────────────────────────────────────────────────────────────────

export type ResolveTeamResult =
  | { ok: true; teamId: string | undefined; teamSlug?: string }
  | { ok: false; code: string; message: string };

/**
 * Which team scope to read: `--team <slug|id>` when given; otherwise the
 * token's only team, a pick when several and this run can ask, a coded
 * refusal listing the slugs when it cannot; no teams at all means the
 * personal account (no `teamId` query).
 */
export async function resolveTeam(
  teams: readonly VercelTeam[],
  requested: string | undefined,
  pick: ((teams: readonly VercelTeam[]) => Promise<string>) | null,
): Promise<ResolveTeamResult> {
  const want = requested?.trim();
  if (want) {
    const hit = teams.find((t) => t.slug === want || t.id === want);
    if (!hit) {
      return {
        ok: false,
        code: ERROR_CODES.VERCEL_TEAM_NOT_FOUND,
        // COPY-FLAG: new user-facing string, minimal/neutral wording.
        message: `No Vercel team "${want}". Teams this token sees: ${teams.map((t) => t.slug).join(', ') || '(none)'}.`,
      };
    }
    return { ok: true, teamId: hit.id, teamSlug: hit.slug };
  }
  if (teams.length === 0) return { ok: true, teamId: undefined };
  if (teams.length === 1) return { ok: true, teamId: teams[0].id, teamSlug: teams[0].slug };
  if (!pick) {
    return {
      ok: false,
      code: ERROR_CODES.VERCEL_TEAM_REQUIRED,
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      message: `This token sees several Vercel teams (${teams.map((t) => t.slug).join(', ')}). Pass --team <slug>.`,
    };
  }
  const pickedId = await pick(teams);
  const hit = teams.find((t) => t.id === pickedId) ?? teams[0];
  return { ok: true, teamId: hit.id, teamSlug: hit.slug };
}

// ── Environments and importable records ─────────────────────────────────────

export type VercelEnvironmentKind = VercelStandardEnvironment | 'custom';

export interface VercelEnvironmentInfo {
  /** The Capy branch name: `production` | `preview` | `development`, or a custom environment's slug. */
  name: string;
  kind: VercelEnvironmentKind;
  customEnvironmentId?: string;
}

/** Why a record is not imported. Stable codes — never a sentence. */
export type VercelSkipReason =
  | 'git_branch_scoped'
  | 'sensitive_unreadable'
  | 'vercel_system'
  | 'legacy_secret_unreadable'
  | 'unsupported_type'
  | 'duplicate_key'
  | 'empty_value'
  /** Vercel returned the value route's answer with `decrypted: false`: it would not give the value back. */
  | 'value_not_decrypted'
  /** Vercel answered the value route for this one record with HTTP 404: the record is listed but its value is not there to read. */
  | 'value_not_found';

/**
 * The reasons that mean "Vercel has this value and will not give it back". Each becomes a placeholder
 * on its Capy branch (core/placeholder.ts); every other reason stays a skip.
 */
export const PLACEHOLDER_SKIP_REASONS: readonly VercelSkipReason[] = [
  'sensitive_unreadable',
  'legacy_secret_unreadable',
  'value_not_decrypted',
  'value_not_found',
];

export const isPlaceholderReason = (reason: VercelSkipReason): boolean => PLACEHOLDER_SKIP_REASONS.includes(reason);

export interface VercelSkippedRecord {
  name: string;
  reason: VercelSkipReason;
  /** Only for `git_branch_scoped`: the branch the record is scoped to (a name, never a value). */
  gitBranch?: string;
}

export interface VercelEnvironmentPlan {
  environment: VercelEnvironmentInfo;
  /** Readable records, one per name. Values are NOT here — see `resolveEnvValues`. */
  importable: readonly VercelEnvRecord[];
  skipped: readonly VercelSkippedRecord[];
}

/** All environment names a project has: the three built-ins plus its custom environments' slugs. */
export function availableEnvironments(custom: readonly VercelCustomEnvironment[]): readonly VercelEnvironmentInfo[] {
  return [
    ...VERCEL_STANDARD_ENVIRONMENTS.map((name): VercelEnvironmentInfo => ({ name, kind: name })),
    ...custom.map((c): VercelEnvironmentInfo => ({ name: c.slug, kind: 'custom', customEnvironmentId: c.id })),
  ];
}

function skipReasonFor(rec: VercelEnvRecord, kind: VercelEnvironmentKind): VercelSkipReason | null {
  if (rec.type === 'system') return 'vercel_system';
  const known = rec.type === 'plain' || rec.type === 'encrypted' || rec.type === 'sensitive' || rec.type === 'secret';
  if (!known) return 'unsupported_type';
  // A preview record scoped to one branch of the repo is out of scope whatever its type: it is never a placeholder on the all-branches preview.
  if (kind === 'preview' && rec.gitBranch) return 'git_branch_scoped';
  if (rec.type === 'sensitive') return 'sensitive_unreadable';
  if (rec.type === 'secret') return 'legacy_secret_unreadable';
  return null;
}

function recordTouchesEnvironment(rec: VercelEnvRecord, env: VercelEnvironmentInfo): boolean {
  if (env.kind === 'custom') return !!env.customEnvironmentId && rec.customEnvironmentIds.includes(env.customEnvironmentId);
  return rec.targets.includes(env.name);
}

/**
 * One plan per environment that at least one record references. A record
 * targeting several environments counts in each. Names only: no value is
 * read here, so a plan is safe to print.
 */
export function buildEnvironmentPlans(
  envs: readonly VercelEnvRecord[],
  custom: readonly VercelCustomEnvironment[],
): readonly VercelEnvironmentPlan[] {
  return availableEnvironments(custom).flatMap((environment): readonly VercelEnvironmentPlan[] => {
    const records = envs.filter((r) => recordTouchesEnvironment(r, environment));
    return records.length === 0 ? [] : [planFor(environment, records)];
  });
}

function planFor(environment: VercelEnvironmentInfo, records: readonly VercelEnvRecord[]): VercelEnvironmentPlan {
  const classified = records.map((rec) => ({ rec, reason: skipReasonFor(rec, environment.kind) }));
  const readable = classified.flatMap(({ rec, reason }) => (reason === null ? [rec] : []));
  // Two readable records for one name in one environment: the first wins, the
  // rest are reported, so a name is never imported twice.
  const firstIds = new Map(
    readable.flatMap((rec, i) => (readable.findIndex((r) => r.key === rec.key) === i ? [[rec.key, rec.id] as const] : [])),
  );
  const importable = readable.filter((rec) => firstIds.get(rec.key) === rec.id);
  const duplicates = readable.filter((rec) => firstIds.get(rec.key) !== rec.id);
  const skipped: readonly VercelSkippedRecord[] = [
    ...classified.flatMap(({ rec, reason }): readonly VercelSkippedRecord[] =>
      reason === null
        ? []
        : [{ name: rec.key, reason, ...(reason === 'git_branch_scoped' && rec.gitBranch ? { gitBranch: rec.gitBranch } : {}) }],
    ),
    ...duplicates.map((rec): VercelSkippedRecord => ({ name: rec.key, reason: 'duplicate_key' })),
  ];
  return { environment, importable, skipped };
}

export interface ResolvedEnvValues {
  /** Name + plaintext, for records that came back with a real value. */
  entries: ReadonlyArray<{ record: VercelEnvRecord; value: string }>;
  /** Records that came back empty/absent although typed readable — never imported as empty strings. */
  empty: readonly VercelSkippedRecord[];
  /** Records Vercel would not decrypt (`decrypted: false`): they have a value Capy cannot read, so they are placeholders, not empty. */
  undecrypted: readonly VercelSkippedRecord[];
  /** Records whose per-id value route answered HTTP 404: the run goes on without them, and they are placeholders like `undecrypted`. */
  notFound: readonly VercelSkippedRecord[];
}

/** One record's value read: a value (or none, or "not decrypted"), or the route's 404 for that record. */
type FetchedValue = { readonly record: VercelEnvRecord; readonly value: VercelEnvValue } | { readonly record: VercelEnvRecord; readonly notFound: true };

/** The structured signal for "Vercel has no value route answer for this id": a Vercel 404, by class and status, never by message. */
const isValueNotFound = (err: unknown): boolean => err instanceof VercelApiError && (err.status === 404 || err.code === 'not_found');

/** Reads one record's value; a 404 on the per-id route is that record's outcome, every other failure still throws. */
async function fetchOneValue(
  client: Pick<VercelClient, 'getEnvValue'>,
  projectId: string,
  teamId: string | undefined,
  record: VercelEnvRecord,
): Promise<FetchedValue> {
  if (record.type === 'plain' && record.value !== undefined) return { record, value: record.value };
  try {
    return { record, value: await client.getEnvValue(projectId, record.id, teamId) };
  } catch (err) {
    if (isValueNotFound(err)) return { record, notFound: true };
    throw err;
  }
}

/**
 * Reads the value of every importable record, sequentially (one request at a
 * time keeps well inside the rate limit and gives a deterministic call
 * order). A `plain` record's list value is used as-is; everything else
 * (`encrypted`, or a `plain` record the list sent without a value) comes
 * from the per-id decrypted-value route.
 */
export async function resolveEnvValues(
  client: Pick<VercelClient, 'getEnvValue'>,
  projectId: string,
  teamId: string | undefined,
  records: readonly VercelEnvRecord[],
): Promise<ResolvedEnvValues> {
  const all = await records.reduce<Promise<readonly FetchedValue[]>>(async (accPromise, record) => {
    const acc = await accPromise;
    return [...acc, await fetchOneValue(client, projectId, teamId, record)];
  }, Promise.resolve([]));
  const fetched = all.flatMap((f): ReadonlyArray<{ record: VercelEnvRecord; value: VercelEnvValue }> => ('notFound' in f ? [] : [f]));
  return {
    entries: fetched.flatMap(({ record, value }) => (value === undefined || value === '' || isUndecrypted(value) ? [] : [{ record, value }])),
    empty: fetched.flatMap(({ record, value }): readonly VercelSkippedRecord[] =>
      value === undefined || value === '' ? [{ name: record.key, reason: 'empty_value' }] : [],
    ),
    undecrypted: fetched.flatMap(({ record, value }): readonly VercelSkippedRecord[] =>
      isUndecrypted(value) ? [{ name: record.key, reason: 'value_not_decrypted' }] : [],
    ),
    notFound: all.flatMap((f): readonly VercelSkippedRecord[] => ('notFound' in f ? [{ name: f.record.key, reason: 'value_not_found' }] : [])),
  };
}

/** `--var a,b`: names to restrict the import to; `null` when absent. */
export function parseVarList(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

/** Skipped names grouped by reason — the shape a dry-run plan prints. Names only. */
export function groupSkipped(
  skipped: ReadonlyArray<{ name: string; reason: string; gitBranch?: string }>,
): Readonly<Record<string, ReadonlyArray<{ name: string; gitBranch?: string }>>> {
  const reasons = sortedCopy([...new Set(skipped.map((s) => s.reason))]);
  return Object.fromEntries(
    reasons.map((reason) => [
      reason,
      skipped.filter((s) => s.reason === reason).map((s) => ({ name: s.name, ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}) })),
    ]),
  );
}
