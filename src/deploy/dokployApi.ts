/**
 * Dokploy API client + env-block primitives, shared by the `dokploy` deploy
 * adapter and (later) a `capy connect dokploy` import flow.
 *
 * Kept separate from the adapter so a second consumer never has to import
 * deploy-flow types (`DeployAdapter`, `DeployContext`, …) just to talk to
 * Dokploy or read its env blob. `ERROR_CODES` (below) is the one exception —
 * a plain string-constant map, not a deploy-flow type — so a resolution
 * refusal can be compared by its stable code rather than a hand-typed
 * literal.
 */
import { ERROR_CODES } from '../types/index';

/**
 * Sort a copy, never the input. `Array.prototype.toSorted` would do this in
 * one call but is Node 20+ only — this package's `engines.node` is
 * `>=18.0.0`, and `dist/` ships to whatever Node the installer has.
 */
export function sortedCopy<T>(xs: readonly T[], cmp?: (a: T, b: T) => number): T[] {
  return Array.from(xs).sort(cmp);
}

// ── Dokploy API shapes (only the fields we read) ───────────────────────────

export interface DokployApplication {
  applicationId: string;
  name?: string;
  appName?: string;
  env: string | null;
  buildArgs: string | null;
  buildSecrets: string | null;
  createEnvFile: boolean;
  /**
   * Git-source detail fields (CAP-657 discovery follow-up) — ASSUMED to
   * mirror `DokployCompose`'s (unverified live for Applications; Compose's
   * shape was checked live — see that interface's doc). Absent/undefined
   * for a non-git source (e.g. `sourceType: 'raw'` or a Docker-image app);
   * discovery reports those as unmatched rather than guessing.
   */
  sourceType?: string;
  repository?: string;
  owner?: string;
  branch?: string;
  /** Which Dokploy environment this Application belongs to, within its project. */
  environmentId?: string;
}

/**
 * A Dokploy Compose service (`compose.one`) — every one of a `compose.one`
 * org's Dokploy services is one of these, never an Application (CAP-657
 * follow-up). Same `env` shape as `DokployApplication`; no `buildArgs` /
 * `buildSecrets` — Dokploy's compose services don't have them.
 */
export interface DokployCompose {
  composeId: string;
  name?: string;
  appName?: string;
  env: string | null;
  createEnvFile: boolean;
  /** Git-source detail fields, as returned by a live `compose.one` (CAP-657 original spike). */
  sourceType?: string;
  repository?: string;
  owner?: string;
  branch?: string;
  /** The compose file's path within the repo, e.g. `backend/deployment/production/docker-compose.yml`. */
  composePath?: string;
  /** Which Dokploy environment this Compose service belongs to, within its project. */
  environmentId?: string;
}

// ── Discovery (CAP-657 follow-up): `project.all` ────────────────────────────

/**
 * One service entry inside a `project.all` environment's summary — just
 * enough to fetch the FULL detail (`application.one` / `compose.one`) for
 * matching: discovery reads `project.all` first for the id/kind/environment
 * tree, then the per-service detail call for the git-source fields
 * (`owner`/`repository`/`sourceType`/…) actually used to match a repo.
 *
 * CONFIRMED LIVE (2026-09-26): each environment carries its applications and
 * compose services as separate arrays, keyed `applications` / `compose` — a
 * read-only inventory ran against exactly this shape and found 49 compose
 * services. (`application.one`'s own git-source detail fields are the one
 * part of this still unverified — see `DokployApplication`'s doc.)
 */
export interface DokployProjectServiceRef {
  id: string;
  kind: 'application' | 'compose';
  name?: string;
  appName?: string;
}

export interface DokployProjectEnvironment {
  environmentId: string;
  /** e.g. 'production', 'staging' — becomes the Capy branch name. */
  name: string;
  applications: readonly DokployProjectServiceRef[];
  composes: readonly DokployProjectServiceRef[];
}

export interface DokployProjectSummary {
  projectId: string;
  name: string;
  environments: readonly DokployProjectEnvironment[];
}

/**
 * Which Dokploy object a `capy connect dokploy` import is reading from.
 * Exported so callers branch on `.kind`, never on a provider name string
 * (Rule 4) — `import()`'s settings resolution, the request it fires, and the
 * keep.lock field it writes (`application_id` vs `compose_id`) all key off
 * this.
 */
export type DokployImportSource =
  | { kind: 'application'; id: string }
  | { kind: 'compose'; id: string };

export type DokployDeploymentStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface DokployDeployment {
  deploymentId: string;
  status: DokployDeploymentStatus | null;
  createdAt: string;
  errorMessage?: string | null;
}

// ── HTTP client ────────────────────────────────────────────────────────────

/** Why a Dokploy call failed, as a code the caller branches on. */
export type DokployErrorCode =
  | 'unreachable'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'server_error'
  | 'bad_response';

export class DokployApiError extends Error {
  constructor(
    public readonly code: DokployErrorCode,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'DokployApiError';
  }
}

function codeForStatus(status: number): DokployErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface DokployClient {
  getApplication(applicationId: string): Promise<DokployApplication>;
  saveEnvironment(app: Omit<DokployApplication, 'name' | 'appName'>): Promise<void>;
  deploy(applicationId: string, title: string): Promise<void>;
  listDeployments(applicationId: string): Promise<readonly DokployDeployment[]>;
  readLogs(deploymentId: string): Promise<string>;
  /**
   * `GET compose.one` — read-only, mirrors `getApplication`. No write
   * counterpart exists on this client: the Compose side of `capy connect
   * dokploy` never writes to Dokploy (there is no compose deploy adapter yet).
   */
  getCompose(composeId: string): Promise<DokployCompose>;
  /**
   * `GET project.all` — read-only. The whole project/environment/service
   * tree, at summary depth (CAP-657 discovery follow-up): enough to walk
   * every service's id/kind/environment, not enough to match a repo (that
   * needs `getApplication`/`getCompose`'s detail fields per candidate).
   */
  listProjects(): Promise<readonly DokployProjectSummary[]>;
}

// ── `project.all` parsing (defensive: unknown-shaped JSON in, typed tree out) ─

function parseProjectServiceRef(
  raw: unknown,
  kind: 'application' | 'compose',
): DokployProjectServiceRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = r[kind === 'application' ? 'applicationId' : 'composeId'];
  if (typeof id !== 'string') return null;
  return {
    id,
    kind,
    name: typeof r.name === 'string' ? r.name : undefined,
    appName: typeof r.appName === 'string' ? r.appName : undefined,
  };
}

function parseProjectEnvironment(raw: unknown): DokployProjectEnvironment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.environmentId !== 'string') return null;
  const applications = Array.isArray(r.applications)
    ? r.applications.flatMap((a) => {
        const parsed = parseProjectServiceRef(a, 'application');
        return parsed ? [parsed] : [];
      })
    : [];
  const composes = Array.isArray(r.compose)
    ? r.compose.flatMap((c) => {
        const parsed = parseProjectServiceRef(c, 'compose');
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    environmentId: r.environmentId,
    name: typeof r.name === 'string' ? r.name : r.environmentId,
    applications,
    composes,
  };
}

function parseProjectSummary(raw: unknown): DokployProjectSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') return null;
  const environments = Array.isArray(r.environments)
    ? r.environments.flatMap((e) => {
        const parsed = parseProjectEnvironment(e);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    projectId: r.projectId,
    name: typeof r.name === 'string' ? r.name : r.projectId,
    environments,
  };
}

/** `https://host/` and `https://host/api` both mean the same dashboard. */
export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export function createDokployClient(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): DokployClient {
  const base = apiBase(baseUrl);
  const headers = {
    'x-api-key': token,
    accept: 'application/json',
    'content-type': 'application/json',
  };

  const call = async (
    method: 'GET' | 'POST',
    procedure: string,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const url =
      method === 'GET'
        ? `${base}/${procedure}?${new URLSearchParams(params as Record<string, string>).toString()}`
        : `${base}/${procedure}`;
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(params) } : {}),
    }).catch((err: unknown) => {
      throw new DokployApiError(
        'unreachable',
        null,
        `cannot reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const text = await res.text();
    if (!res.ok) {
      throw new DokployApiError(
        codeForStatus(res.status),
        res.status,
        `${procedure} returned HTTP ${res.status}`,
      );
    }
    return text;
  };

  const json = (procedure: string, text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new DokployApiError('bad_response', null, `${procedure} did not return JSON`);
    }
  };

  return {
    async getApplication(applicationId) {
      const body = json(
        'application.one',
        await call('GET', 'application.one', { applicationId }),
      ) as Partial<DokployApplication> | null;
      if (!body || typeof body !== 'object' || body.applicationId !== applicationId) {
        throw new DokployApiError(
          'bad_response',
          null,
          'application.one did not return the requested application',
        );
      }
      return {
        applicationId: body.applicationId,
        name: body.name,
        appName: body.appName,
        env: typeof body.env === 'string' ? body.env : null,
        buildArgs: typeof body.buildArgs === 'string' ? body.buildArgs : null,
        buildSecrets: typeof body.buildSecrets === 'string' ? body.buildSecrets : null,
        createEnvFile: body.createEnvFile !== false,
        sourceType: typeof body.sourceType === 'string' ? body.sourceType : undefined,
        repository: typeof body.repository === 'string' ? body.repository : undefined,
        owner: typeof body.owner === 'string' ? body.owner : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        environmentId: typeof body.environmentId === 'string' ? body.environmentId : undefined,
      };
    },
    async saveEnvironment(app) {
      await call('POST', 'application.saveEnvironment', {
        applicationId: app.applicationId,
        env: app.env,
        buildArgs: app.buildArgs,
        buildSecrets: app.buildSecrets,
        createEnvFile: app.createEnvFile,
      });
    },
    async deploy(applicationId, title) {
      await call('POST', 'application.deploy', { applicationId, title });
    },
    async listDeployments(applicationId) {
      const body = json(
        'deployment.all',
        await call('GET', 'deployment.all', { applicationId }),
      );
      if (!Array.isArray(body)) {
        throw new DokployApiError('bad_response', null, 'deployment.all did not return a list');
      }
      return body.filter(
        (d): d is DokployDeployment =>
          !!d && typeof d === 'object' && typeof d.deploymentId === 'string',
      );
    },
    async getCompose(composeId) {
      const body = json(
        'compose.one',
        await call('GET', 'compose.one', { composeId }),
      ) as Partial<DokployCompose> | null;
      if (!body || typeof body !== 'object' || body.composeId !== composeId) {
        throw new DokployApiError(
          'bad_response',
          null,
          'compose.one did not return the requested compose service',
        );
      }
      return {
        composeId: body.composeId,
        name: body.name,
        appName: body.appName,
        env: typeof body.env === 'string' ? body.env : null,
        createEnvFile: body.createEnvFile !== false,
        sourceType: typeof body.sourceType === 'string' ? body.sourceType : undefined,
        repository: typeof body.repository === 'string' ? body.repository : undefined,
        owner: typeof body.owner === 'string' ? body.owner : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        composePath: typeof body.composePath === 'string' ? body.composePath : undefined,
        environmentId: typeof body.environmentId === 'string' ? body.environmentId : undefined,
      };
    },
    async readLogs(deploymentId) {
      const text = await call('GET', 'deployment.readLogs', { deploymentId });
      // tRPC-OpenAPI serialises a string result as a JSON string.
      const parsed = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })();
      return typeof parsed === 'string' ? parsed : '';
    },
    async listProjects() {
      const body = json('project.all', await call('GET', 'project.all', {}));
      if (!Array.isArray(body)) {
        throw new DokployApiError('bad_response', null, 'project.all did not return a list');
      }
      return body.flatMap((p) => {
        const parsed = parseProjectSummary(p);
        return parsed ? [parsed] : [];
      });
    },
  };
}

// ── Token resolution ─────────────────────────────────────────────────────

/** The env var name `capy deploy dokploy` reads by default, absent an override. */
export const DEFAULT_TOKEN_ENV = 'DOKPLOY_API_KEY';

/**
 * The Dokploy API token, read from the variable NAME the target configured
 * (never from the target itself — the token is never persisted to
 * `.capy/deploy.json`).
 *
 * Superseded by `resolveDokployApiKey` (CAP-664/CAP-657), which layers the
 * org system store in front of this exact lookup. Kept and still exported —
 * `resolveDokployApiKey`'s own env-only fallback steps call it — so nothing
 * that imported it for a plain env-var check has to change.
 */
export function resolveDokployToken(
  tokenEnv: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env[tokenEnv] || null;
}

/**
 * Name of the org system store entry (CAP-664, `docs/org-system-store.md`)
 * that holds the Dokploy API key: `_CONNECTOR_<PROVIDER>_<NAME>`.
 */
export const DOKPLOY_CONNECTOR_SECRET_NAME = '_CONNECTOR_DOKPLOY_API_KEY';

/** Where a resolved Dokploy API key came from — never logged with the value, only alongside it in memory. */
export type DokployApiKeySource = 'system' | 'env';

export type ResolveDokployApiKeyResult =
  | { ok: true; value: string; source: DokployApiKeySource }
  | { ok: false; code: string };

/** What the system store's `getConnectorSecret` needs — same shape as `system/systemStore.ts#GetConnectorSecretOptions`. */
export interface DokploySystemStoreCallOptions {
  orgId?: string;
  interactive: boolean;
  devMode?: boolean;
  apiUrl?: string;
}

export interface ResolveDokployApiKeyDeps {
  /**
   * Reads (and, when missing + interactive + admin, prompts for and saves)
   * the org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry.
   *
   * Defaults to a function that never touches the network or a terminal —
   * every REAL caller (the deploy adapter's and the import connector's
   * exported singletons, and `deployCommand.ts`) wires the real
   * `system/systemStore.ts#getConnectorSecret` explicitly. Everyone else
   * (tests, and the adapter/connector's own internal env-only fallback when
   * a caller didn't pre-resolve) gets this safe no-op, so a missing token
   * resolves with zero network calls unless something opted in.
   */
  getConnectorSecret?: (name: string, opts: DokploySystemStoreCallOptions) => Promise<string | null>;
}

async function neverReachesTheStore(): Promise<null> {
  return null;
}

/** A typed store error (`CapyError`-shaped: `{code: string}`) as its code — never its `.message`. */
function storeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'DOKPLOY_STORE_ERROR';
}

type StoreOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'empty' }
  | { kind: 'error'; code: string };

async function readFromSystemStore(
  getConnectorSecret: NonNullable<ResolveDokployApiKeyDeps['getConnectorSecret']>,
  callOpts: DokploySystemStoreCallOptions,
): Promise<StoreOutcome> {
  try {
    const value = await getConnectorSecret(DOKPLOY_CONNECTOR_SECRET_NAME, callOpts);
    return value ? { kind: 'value', value } : { kind: 'empty' };
  } catch (err) {
    return { kind: 'error', code: storeErrorCode(err) };
  }
}

export interface ResolveDokployApiKeyOptions {
  /** `--token-env`, or a saved target's own `tokenEnv`. Wins outright when that variable is actually set. */
  tokenEnv?: string;
  env: Record<string, string | undefined>;
  /** Whether this run can prompt a human — passed straight through to the system store. */
  interactive: boolean;
  orgId?: string;
  devMode?: boolean;
  apiUrl?: string;
  deps?: ResolveDokployApiKeyDeps;
}

/**
 * The Dokploy API key for one command, in order:
 *
 *   1. An explicit `tokenEnv` (the `--token-env` flag, or a saved target's
 *      own `tokenEnv`) — when that variable is actually set, it wins outright.
 *   2. The org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry. Missing +
 *      interactive + admin: the store itself asks for it (hidden input) and
 *      saves it (`system/systemStore.ts#getConnectorSecret`).
 *   3. The default env var (`DOKPLOY_API_KEY`) — back-compat with every
 *      target saved before the system store existed.
 *   4. Refused: `DOKPLOY_TOKEN_MISSING` when nothing anywhere had a value.
 *      When the store itself refused (a non-admin caller, or any other
 *      store error) AND step 3 was also empty, the refusal carries the
 *      STORE's own code (e.g. `SYSTEM_STORE_ADMIN_ONLY`) instead of the
 *      generic "missing" code, so the caller learns WHY, never by parsing a
 *      message string.
 *
 * Callers resolve this ONCE per command and reuse the result — see
 * `deployCommand.ts`'s single call, fed into both `preflight()` and
 * `deploy()`, so the store is asked (and an admin prompted) at most once.
 */
export async function resolveDokployApiKey(
  opts: ResolveDokployApiKeyOptions,
): Promise<ResolveDokployApiKeyResult> {
  const explicit = opts.tokenEnv?.trim();
  if (explicit) {
    const value = opts.env[explicit] || null;
    if (value) return { ok: true, value, source: 'env' };
  }

  const getConnectorSecret = opts.deps?.getConnectorSecret ?? neverReachesTheStore;
  const storeOutcome = await readFromSystemStore(getConnectorSecret, {
    orgId: opts.orgId,
    interactive: opts.interactive,
    devMode: opts.devMode,
    apiUrl: opts.apiUrl,
  });
  if (storeOutcome.kind === 'value') return { ok: true, value: storeOutcome.value, source: 'system' };

  const fallback = resolveDokployToken(DEFAULT_TOKEN_ENV, opts.env);
  if (fallback) return { ok: true, value: fallback, source: 'env' };

  return storeOutcome.kind === 'error'
    ? { ok: false, code: storeOutcome.code }
    : { ok: false, code: 'DOKPLOY_TOKEN_MISSING' };
}

/**
 * Whether a run may let the org system store prompt a human for a missing
 * Dokploy key. `baseInteractive` is the caller's ordinary TTY check;
 * `suppressed` covers every reason that overrides a real TTY back to "never
 * ask" — shared by `deployCommand.ts` (`--web`, `--yes`, `--dry-run`) and
 * the import connector (`--web`, `--json`, `--dry-run`):
 *
 *   - `--web`: the store's own prompt is a raw terminal `inquirer` prompt,
 *     not a browser screen — asking there could hang a browser-driven run.
 *   - `--json` (connector only): machine output must never have a prompt
 *     interleaved with it.
 *   - `--yes` (deploy only): never ask, resolve from what's already there
 *     or fail fast — the same contract every other picker/confirm honors.
 *   - `--dry-run` (deploy AND the import connector): a preview must never
 *     have the side effect of saving a new key into the org store.
 */
export function dokploySecretsMayPrompt(baseInteractive: boolean, suppressed: boolean): boolean {
  return baseInteractive && !suppressed;
}

/**
 * A resolution refusal as a printable reason + hint — names only, never a
 * value. `DOKPLOY_TOKEN_MISSING`'s reason is deliberately identical to the
 * pre-system-store message (`$<tokenEnv> is not set`) — additive, not a
 * reword of what every caller already prints.
 */
export function describeDokployTokenProblem(
  code: string,
  tokenEnv: string,
): { reason: string; hint: string } {
  if (code === ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `only an org owner or admin can set ${DOKPLOY_CONNECTOR_SECRET_NAME} in the system store, and $${tokenEnv} is not set`,
      hint: `Ask an org owner/admin to run \`capy system set ${DOKPLOY_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv} yourself.`,
    };
  }
  if (code === 'DOKPLOY_TOKEN_MISSING') {
    return {
      reason: `$${tokenEnv} is not set`,
      // COPY-FLAG: minimal neutral wording.
      hint: `Run \`capy system set ${DOKPLOY_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv}=… first.`,
    };
  }
  return {
    // COPY-FLAG: minimal neutral wording.
    reason: `could not resolve the Dokploy API key (${code})`,
    hint: `Run \`capy system set ${DOKPLOY_CONNECTOR_SECRET_NAME}\`, or export ${tokenEnv}=… first.`,
  };
}

// ── Env block: parse / find / replace / strip ─────────────────────────────

/** Exact marker lines around the block Capy owns inside Dokploy's `env`. */
export const MANAGED_BEGIN = '# capy:managed:begin — written by `capy deploy`, do not edit';
export const MANAGED_END = '# capy:managed:end';

/**
 * The two names `capy run` reads FIRST in deployed mode, and what `capy
 * deploy` writes today. Chosen so a stale plaintext var of the same NAME the
 * user already had on the platform never wins over the decrypted value —
 * see `capy run`'s precedence rules in `runCommand.ts`.
 *
 * NOT `_DEPLOY_KEY`: that name is reserved for the OIDC design's per-deploy
 * key (`<deployId>.<K_deploy>`, see `docs/oidc-ci-auth-spec.md`, CAP-54).
 * This variable holds the project key, so it is `_PROJECT_KEY`.
 */
export const RUNTIME_PAIR = ['_SECRETS_BLOB', '_PROJECT_KEY'] as const;

/**
 * The pair `capy run` still reads for back-compat, in the platform's own
 * env-wins-over-blob precedence. No adapter writes these names anymore, but
 * a leftover pair from an older deploy is still a name Capy must never
 * silently collide with.
 */
export const OLD_RUNTIME_PAIR = ['SECRETS_BLOB', 'PROJECT_KEY'] as const;

const KEY_VALUE_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export interface DotenvEntry {
  name: string;
  value: string;
}

/** Dotenv-style lines as name/value pairs. Comments and blanks skipped. */
export function parseDotenvEntries(lines: readonly string[]): readonly DotenvEntry[] {
  return lines.flatMap((line) => {
    const m = KEY_VALUE_LINE.exec(line);
    return m ? [{ name: m[1], value: m[2] }] : [];
  });
}

/** Variable names defined by dotenv-style lines. Comments and blanks ignored. */
export function envKeys(lines: readonly string[]): readonly string[] {
  return parseDotenvEntries(lines).map((e) => e.name);
}

export type EnvMergeProblemCode = 'malformed_block' | 'reserved_outside_block';

export interface EnvMergeProblem {
  code: EnvMergeProblemCode;
  names: readonly string[];
}

export type EnvWarningCode = 'DOKPLOY_SHADOWED_VAR';

export interface EnvWarning {
  code: EnvWarningCode;
  names: readonly string[];
}

export interface EnvSplit {
  /** Text before the Capy block, byte for byte (the WHOLE env when no block was found). */
  before: string;
  /** Text after the Capy block, byte for byte (empty when no block was found). */
  after: string;
  /** Whether a Capy-managed block was found. */
  hadBlock: boolean;
  /**
   * The line ending found inside/around the existing block (right after the
   * begin marker). Only set when `hadBlock` is true — a replace reuses this
   * rather than guessing, so the block's own framing never drifts across
   * repeated writes.
   */
  blockEol?: '\n' | '\r\n';
}

interface RawLine {
  content: string;
  eol: '' | '\n' | '\r\n';
}

/**
 * Every line of `text`, each paired with its OWN original terminator (`''`
 * for a final unterminated line). One-to-one with `text.split(/\r?\n/)` —
 * same length, same content per index — but keeps the byte each line
 * actually ended with, which a plain `.split()` throws away.
 */
function splitPreservingEol(text: string): readonly RawLine[] {
  const m = /\r\n|\n/.exec(text);
  if (!m) return [{ content: text, eol: '' }];
  const eol = m[0] as '\n' | '\r\n';
  return [{ content: text.slice(0, m.index), eol }, ...splitPreservingEol(text.slice(m.index + eol.length))];
}

/** The more common line ending in `text`; `\n` when there's no clear majority or no line ending at all. */
function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const bareLf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > bareLf ? '\r\n' : '\n';
}

/**
 * Split Dokploy's env into the text Capy owns and everything else. Exactly
 * zero or one well-formed block is accepted — anything else means someone
 * edited the markers, and guessing which lines are ours could delete theirs.
 *
 * `before`/`after` are exact substrings of the original text — never
 * re-joined, re-terminated, or trimmed — so `mergeManagedBlock` and
 * `stripManagedBlock` can round-trip every byte outside the block.
 */
export function splitManagedBlock(env: string | null): EnvSplit | EnvMergeProblem {
  const text = env ?? '';
  const rawLines = splitPreservingEol(text);
  const begins = rawLines.flatMap((l, i) => (l.content.trim() === MANAGED_BEGIN ? [i] : []));
  const ends = rawLines.flatMap((l, i) => (l.content.trim() === MANAGED_END ? [i] : []));
  if (begins.length === 0 && ends.length === 0) {
    return { before: text, after: '', hadBlock: false };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    return { code: 'malformed_block', names: [] };
  }
  const offsetOf = (idx: number): number =>
    rawLines.slice(0, idx).reduce((acc, l) => acc + l.content.length + l.eol.length, 0);
  const beginStart = offsetOf(begins[0]);
  const endEnd = offsetOf(ends[0]) + rawLines[ends[0]].content.length + rawLines[ends[0]].eol.length;
  return {
    before: text.slice(0, beginStart),
    after: text.slice(endEnd),
    hadBlock: true,
    blockEol: rawLines[begins[0]].eol || '\n',
  };
}

/**
 * The lines Capy does not own, ready for name/value parsing: CRLF-safe (no
 * line carries a trailing `\r`), same shape `envKeys`/`parseDotenvEntries`
 * always took. `splitManagedBlock`'s `before`/`after` stay byte-exact for
 * reconstruction; this is the parsing-only view over the same text.
 */
export function outsideLines(split: EnvSplit): readonly string[] {
  return (split.before + split.after).split(/\r?\n/);
}

/**
 * Everything that must stop a deploy before anything is minted or written: an
 * edited/duplicated block, or a runtime pair (old or new name) that Capy did
 * not write sitting outside the block — an unknown pair would be silently
 * replaced or would shadow ours.
 */
export function envProblems(env: string | null): EnvMergeProblem | null {
  const split = splitManagedBlock(env);
  if ('code' in split) return split;
  const keys = new Set(envKeys(outsideLines(split)));
  const reserved = [...RUNTIME_PAIR, ...OLD_RUNTIME_PAIR].filter((k) => keys.has(k));
  return reserved.length > 0 ? { code: 'reserved_outside_block', names: reserved } : null;
}

/**
 * A selected variable ALSO set as a plain Dokploy value, outside the block.
 * `capy run`'s new pair lets the decrypted value win (see `RUNTIME_PAIR`
 * doc), so the stale dashboard value is shadowed rather than dangerous — this
 * is a warning, not a reason to refuse the deploy.
 */
export function envWarnings(
  env: string | null,
  selectedVars: readonly string[],
): EnvWarning | null {
  const split = splitManagedBlock(env);
  if ('code' in split) return null;
  const keys = new Set(envKeys(outsideLines(split)));
  const shadowed = sortedCopy(selectedVars.filter((k) => keys.has(k)));
  return shadowed.length > 0 ? { code: 'DOKPLOY_SHADOWED_VAR', names: shadowed } : null;
}

/**
 * Dokploy's env with Capy's block replaced (or appended for a first write).
 * Everything outside the block — every byte, every line's own terminator,
 * the trailing-newline state — is carried through exactly, so
 * `stripManagedBlock` can undo this precisely (see its own doc).
 */
export function mergeManagedBlock(
  split: EnvSplit,
  pair: { secretsBlob: string; projectKey: string },
): string {
  const eol = split.hadBlock ? (split.blockEol ?? '\n') : dominantEol(split.before);
  const block = [
    MANAGED_BEGIN,
    `${RUNTIME_PAIR[0]}=${pair.secretsBlob}`,
    `${RUNTIME_PAIR[1]}=${pair.projectKey}`,
    MANAGED_END,
  ].join(eol);
  if (split.hadBlock) {
    // Replace in place: swap only the block's own 4 lines. `before`/`after`
    // — including whatever separator the FIRST write added — are untouched.
    return split.before + block + split.after;
  }
  // First write: append at the end. Exactly one separator line ending is
  // added, and ONLY when there is existing content to separate the block
  // from — one deterministic rule, so `stripManagedBlock` can undo it
  // exactly, no matter how many replaces happen after this first write.
  return split.before.length > 0 ? split.before + eol + block : block;
}

/**
 * Dokploy's env with Capy's block removed entirely — the exact revert of
 * `mergeManagedBlock`'s first write. Undoes ONLY the one separator line
 * ending that write added (when it added one) — every other byte outside the
 * block, including however many trailing blank lines the user already had,
 * comes back exactly as it was before Capy ever touched this environment.
 */
export function stripManagedBlock(split: EnvSplit): string {
  if (!split.hadBlock) return split.before + split.after;
  return split.before.replace(/\r?\n$/, '') + split.after;
}

export function describeEnvProblem(p: EnvMergeProblem): { reason: string; hint: string } {
  switch (p.code) {
    case 'malformed_block':
      return {
        reason: 'the Capy block in the Dokploy environment is incomplete or duplicated',
        hint:
          'In the Dokploy Environment tab, keep one begin line and one end line of the Capy block,\n' +
          'or delete the block. Then re-run `capy deploy`.',
      };
    case 'reserved_outside_block':
      return {
        reason: `the Dokploy environment already sets ${p.names.join(', ')}`,
        hint: `Remove ${p.names.join(', ')} from the Dokploy Environment tab, then re-run \`capy deploy\`.`,
      };
  }
}

/**
 * The line printed for a `DOKPLOY_SHADOWED_VAR` warning. Names only, never
 * values.
 */
// COPY-FLAG: new user-facing string, minimal/neutral wording.
export function describeEnvWarning(w: EnvWarning): string {
  const verb = w.names.length === 1 ? 'is' : 'are';
  return `${w.names.join(', ')} ${verb} set in Dokploy too; ignored at boot.`;
}

// ── Importable entries (for a future `capy connect dokploy`) ─────────────

export type ImportSkipReason = 'DOKPLOY_REFERENCE_VALUE';

export interface ImportableEnvEntry {
  name: string;
  value: string;
  /** Present when this entry should not be offered for import, and why. */
  skip?: ImportSkipReason;
}

/**
 * Entries a `capy connect dokploy` import could offer: every name outside
 * the Capy block, minus the runtime pairs (Capy's own machinery, never a
 * project secret), with a reference value like `${{project.SOME_VAR}}`
 * flagged rather than silently imported as a literal string.
 */
export function listImportableEntries(env: string | null): readonly ImportableEnvEntry[] {
  const split = splitManagedBlock(env);
  if ('code' in split) return [];
  const reserved = new Set<string>([...RUNTIME_PAIR, ...OLD_RUNTIME_PAIR]);
  return parseDotenvEntries(outsideLines(split))
    .filter((e) => !reserved.has(e.name))
    .map((e) => (e.value.includes('${{') ? { ...e, skip: 'DOKPLOY_REFERENCE_VALUE' as const } : e));
}

// ── Import conflict classification (shared by the single-service import and
// the discovery apply — ONE rule, never two) ────────────────────────────────

export interface ImportClassified {
  unchanged: readonly string[];
  skipped: ReadonlyArray<{ name: string; code: string }>;
  toImport: ReadonlyArray<{ name: string; value: string }>;
  /** Dry run only: a conflict a real run would have prompted about. */
  wouldAsk: readonly string[];
}

const EMPTY_IMPORT_CLASSIFIED: ImportClassified = { unchanged: [], skipped: [], toImport: [], wouldAsk: [] };

/**
 * Classifies importable candidates against a local plaintext env, one rule
 * for every caller that pulls Dokploy values into `.env` — the single-
 * service import (`capy connect dokploy --application/--compose`) AND
 * discovery's apply step (`--discover`, CAP-657 follow-up) call this SAME
 * function rather than each keeping their own copy of the conflict rule:
 *
 *   - Missing locally → import.
 *   - Same value locally → `unchanged`, a no-op.
 *   - Different value locally, dry run → `wouldAsk` (never prompts — a dry
 *     run changes nothing, regardless of TTY).
 *   - Different value locally, interactive → asks replace/keep (default
 *     KEEP — declining, or any non-interactive run, never silently
 *     overwrites a different local value).
 *   - Different value locally, non-interactive → keeps local,
 *     `IMPORT_CONFLICT_SKIPPED`.
 *
 * Sequential (not parallel): a conflict's `confirm()` is a real prompt when
 * interactive, and every entry is classified in selection order — a
 * `.reduce` over a promise keeps that order without a mutable accumulator.
 */
export async function classifyImportCandidates(
  candidates: ReadonlyArray<{ name: string; value: string }>,
  localPlaintext: Readonly<Record<string, string>>,
  opts: {
    dryRun: boolean;
    interactive: boolean;
    /** Names only — never the value on either side. */
    confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  },
): Promise<ImportClassified> {
  return candidates.reduce<Promise<ImportClassified>>(async (accPromise, e) => {
    const acc = await accPromise;
    const local = localPlaintext[e.name];
    if (local === undefined) {
      return { ...acc, toImport: [...acc.toImport, { name: e.name, value: e.value }] };
    }
    if (local === e.value) {
      return { ...acc, unchanged: [...acc.unchanged, e.name] };
    }
    if (opts.dryRun) {
      return { ...acc, wouldAsk: [...acc.wouldAsk, e.name] };
    }
    if (opts.interactive) {
      // COPY-FLAG: new user-facing string, minimal/neutral wording.
      const replace = await opts.confirm(
        `${e.name} is already set locally with a different value. Replace it with the Dokploy value?`,
        false,
      );
      return replace
        ? { ...acc, toImport: [...acc.toImport, { name: e.name, value: e.value }] }
        : { ...acc, skipped: [...acc.skipped, { name: e.name, code: 'IMPORT_CONFLICT_SKIPPED' }] };
    }
    return { ...acc, skipped: [...acc.skipped, { name: e.name, code: 'IMPORT_CONFLICT_SKIPPED' }] };
  }, Promise.resolve(EMPTY_IMPORT_CLASSIFIED));
}
