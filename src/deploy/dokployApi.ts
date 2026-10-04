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
import { parse as parseDotenv } from 'dotenv';
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
  /**
   * CAP-682 CI preflight fields. `autoDeploy` must be `true` for a merge to
   * Dokploy's tracked branch to trigger anything; `customGitBranch` is the
   * tracked-branch field for a `sourceType: 'git'` (custom) source — see
   * `trackedGitBranch`'s own doc for why both are read. `watchPaths`, when
   * non-null and non-empty, is the set of path globs that gate auto-deploy —
   * see `watchPathsExcludeKeep`.
   */
  autoDeploy?: boolean | null;
  customGitBranch?: string | null;
  watchPaths?: readonly string[] | null;
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
  /**
   * 'docker-compose' | 'stack' (Docker Swarm). CAP-679: `stack` on a Dokploy
   * version below v0.30.3 ships `env_file` values to containers with literal
   * quotes (upstream fix d1830182) — the deploy adapter warns, never refuses,
   * on that combination.
   */
  composeType?: string;
  /** CAP-682 CI preflight fields — see `DokployApplication`'s identical fields. */
  autoDeploy?: boolean | null;
  customGitBranch?: string | null;
  watchPaths?: readonly string[] | null;
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
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    /**
     * Validator finding (key exposure, CAP-657 URL input follow-up):
     * `call()` below always passes `'error'` — a redirect response makes
     * `fetch` itself reject rather than silently re-sending the `x-api-key`
     * header (which carries the resolved Dokploy token) to whatever host a
     * 30x's `Location` names, which could be cross-origin. Optional so every
     * existing scripted `FetchLike` fake in tests, which ignores unknown
     * init fields, keeps working unchanged.
     */
    redirect?: 'error' | 'manual' | 'follow';
  },
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
  /**
   * `POST compose.saveEnvironment` (CAP-679) — the Compose write counterpart
   * to `saveEnvironment`. Needs the `envVars:write` permission, unlike
   * `compose.update` (`service:create`). `createEnvFile` rides through
   * exactly as read — this call never flips it.
   */
  saveComposeEnvironment(compose: { composeId: string; env: string; createEnvFile: boolean }): Promise<void>;
  /**
   * `POST compose.redeploy` (CAP-679) — reuses the code already on disk.
   * Deliberately NOT `compose.deploy`, which re-clones the branch head and
   * would ship unreviewed commits, and NEVER sends `freshVolumes`.
   */
  redeployCompose(composeId: string, title: string): Promise<void>;
  /**
   * `GET deployment.allByCompose` (CAP-679) — the Compose counterpart to
   * `listDeployments`, used for both the pre-redeploy baseline and polling.
   */
  listComposeDeployments(composeId: string): Promise<readonly DokployDeployment[]>;
  /**
   * `GET settings.getDokployVersion` (CAP-679) — used only to decide whether
   * to WARN (never refuse) on a `composeType: 'stack'` target: below
   * v0.30.3, `env_file` values reach containers with literal quotes.
   * `null` when the response couldn't be read as a version string — callers
   * treat that as "unknown", never as "old".
   */
  getDokployVersion(): Promise<string | null>;
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

/**
 * Whether `version` is at least `min`, both `x.y.z`. Missing/non-numeric
 * segments compare as `0`, so `'0.30'` reads as `0.30.0`. Returns `false`
 * (never "unknown") for a string that doesn't parse as dotted numbers at
 * all — callers that need to tell "known old" apart from "unknown" do that
 * by checking `version` for `null` first, not by trusting this function's
 * `false`.
 */
export function dokployVersionAtLeast(version: string, min: string): boolean {
  const parse = (v: string): readonly number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(version);
  const b = parse(min);
  const len = Math.max(a.length, b.length);
  const compareAt = (i: number): boolean | null => {
    if (i >= len) return null;
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    return av !== bv ? av > bv : compareAt(i + 1);
  };
  return compareAt(0) ?? true;
}

// ── CI preflight (CAP-682): auto-deploy, tracked branch, watch paths ───────

/**
 * The git branch Dokploy is actually tracking for this Application/Compose
 * service — `branch` (github/gitlab/bitbucket/gitea sources) or
 * `customGitBranch` (a `sourceType: 'git'` custom source), whichever is set.
 * `null` when neither is populated (e.g. a `sourceType: 'docker'`/`'drop'`
 * service with no git branch at all — CI preflight treats that as "can't
 * confirm a match" the same as any other mismatch, never as a pass).
 */
export function trackedGitBranch(entity: { branch?: string | null; customGitBranch?: string | null }): string | null {
  const branch = entity.branch?.trim();
  if (branch) return branch;
  const custom = entity.customGitBranch?.trim();
  return custom || null;
}

/**
 * Whether `path` matches Dokploy's watch-path glob `pattern` — `**` for any
 * depth (including zero segments), `*` for anything within one path
 * segment, everything else literal. Deliberately conservative rather than a
 * full glob engine: Dokploy's own watch-path examples (`src/**`, `*.ts`,
 * an exact file path) are exactly what this covers, and CI preflight only
 * ever uses this to decide "definitely excluded" vs "let it through" — see
 * `watchPathsExcludeKeep`.
 */
export function matchesWatchPath(pattern: string, path: string): boolean {
  const DOUBLESTAR = '\u0000CAPY_DOUBLESTAR\u0000';
  const withPlaceholder = pattern.trim().split('**').join(DOUBLESTAR);
  const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.split('\\*').join('[^/]*').split(DOUBLESTAR).join('.*');
  return new RegExp(`^${withWildcards}$`).test(path);
}

/**
 * True when Dokploy's `watchPaths` is configured (non-null, non-empty) AND
 * none of its patterns cover `keepPath` — i.e. merging the deploy PR would
 * never trigger Dokploy's own auto-deploy. `null`/empty `watchPaths` means
 * Dokploy watches everything, so this is always `false` in that case —
 * never a refusal.
 */
export function watchPathsExcludeKeep(watchPaths: readonly string[] | null | undefined, keepPath: string): boolean {
  const patterns = (watchPaths ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (patterns.length === 0) return false;
  return !patterns.some((p) => matchesWatchPath(p, keepPath));
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
      // Refuse to follow a redirect rather than risk forwarding the
      // `x-api-key` header cross-origin — see `FetchLike`'s own doc. A
      // redirect response makes `fetch` reject, which the `.catch` below
      // turns into the same `'unreachable'` `DokployApiError` any other
      // network failure produces.
      redirect: 'error',
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
        autoDeploy: typeof body.autoDeploy === 'boolean' ? body.autoDeploy : null,
        customGitBranch: typeof body.customGitBranch === 'string' ? body.customGitBranch : null,
        watchPaths: Array.isArray(body.watchPaths)
          ? body.watchPaths.filter((p): p is string => typeof p === 'string')
          : null,
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
        composeType: typeof body.composeType === 'string' ? body.composeType : undefined,
        autoDeploy: typeof body.autoDeploy === 'boolean' ? body.autoDeploy : null,
        customGitBranch: typeof body.customGitBranch === 'string' ? body.customGitBranch : null,
        watchPaths: Array.isArray(body.watchPaths)
          ? body.watchPaths.filter((p): p is string => typeof p === 'string')
          : null,
      };
    },
    async saveComposeEnvironment(compose) {
      await call('POST', 'compose.saveEnvironment', {
        composeId: compose.composeId,
        env: compose.env,
        createEnvFile: compose.createEnvFile,
      });
    },
    async redeployCompose(composeId, title) {
      await call('POST', 'compose.redeploy', { composeId, title });
    },
    async listComposeDeployments(composeId) {
      const body = json(
        'deployment.allByCompose',
        await call('GET', 'deployment.allByCompose', { composeId }),
      );
      if (!Array.isArray(body)) {
        throw new DokployApiError('bad_response', null, 'deployment.allByCompose did not return a list');
      }
      return body.filter(
        (d): d is DokployDeployment =>
          !!d && typeof d === 'object' && typeof d.deploymentId === 'string',
      );
    },
    async getDokployVersion() {
      const body = json(
        'settings.getDokployVersion',
        await call('GET', 'settings.getDokployVersion', {}),
      );
      if (typeof body === 'string') return body;
      if (body && typeof body === 'object' && typeof (body as { version?: unknown }).version === 'string') {
        return (body as { version: string }).version;
      }
      return null;
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
 * that holds the Dokploy API key for IMPORT (`capy connect dokploy`, inbound):
 * `_CONNECTOR_<PROVIDER>_<NAME>`.
 */
export const DOKPLOY_CONNECTOR_SECRET_NAME = '_CONNECTOR_DOKPLOY_API_KEY';

/**
 * Name of the org system store entry that holds the Dokploy API key for
 * DEPLOY (`capy deploy`, outbound) — CAP-679 follow-up. Deliberately a
 * SEPARATE key from `DOKPLOY_CONNECTOR_SECRET_NAME`: import and deploy are
 * different directions of "integrations" and may legitimately want different
 * credentials (e.g. a narrower-scoped token for deploy). When this one is
 * absent but the connector key already exists, the caller (`deployCommand.ts`
 * wiring `system/systemStore.ts#getDirectionalConnectorSecret`) offers to
 * reuse it via a one-level REFERENCE rather than silently using it directly
 * or forcing a duplicate value to be typed in.
 */
export const DOKPLOY_TARGET_SECRET_NAME = '_TARGET_DOKPLOY_API_KEY';

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
  storeName: string,
): Promise<StoreOutcome> {
  try {
    const value = await getConnectorSecret(storeName, callOpts);
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
  /**
   * Which system store entry to ask for (CAP-679 follow-up: deploy and
   * import now use SEPARATE keys). Defaults to
   * `DOKPLOY_CONNECTOR_SECRET_NAME` — every caller that predates this option
   * (and `capy connect dokploy`, which passes it explicitly for clarity)
   * keeps asking for the connector key; `deployCommand.ts` passes
   * `DOKPLOY_TARGET_SECRET_NAME` explicitly.
   */
  storeName?: string;
}

/**
 * The Dokploy API key for one command, in order:
 *
 *   1. An explicit `tokenEnv` (the `--token-env` flag, or a saved target's
 *      own `tokenEnv`) — when that variable is actually set, it wins outright.
 *   2. The org system store's `opts.storeName` entry (default
 *      `_CONNECTOR_DOKPLOY_API_KEY` — see that option's own doc for the
 *      deploy-vs-import split, CAP-679 follow-up). Missing + interactive +
 *      admin: the store itself asks for it (hidden input, possibly offering
 *      to reuse the OTHER direction's key instead — see
 *      `system/systemStore.ts#getDirectionalConnectorSecret`) and saves it.
 *   3. The default env var (`DOKPLOY_API_KEY`) — back-compat with every
 *      target saved before the system store existed.
 *   4. Refused: `DOKPLOY_TOKEN_MISSING` when nothing anywhere had a value.
 *      When the store itself refused (a non-admin caller, or any other
 *      store error) AND step 3 was also empty, the refusal carries the
 *      STORE's own code (e.g. `SYSTEM_STORE_ADMIN_ONLY`,
 *      `DOKPLOY_TARGET_KEY_MISSING`) instead of the generic "missing" code,
 *      so the caller learns WHY, never by parsing a message string.
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
  const storeOutcome = await readFromSystemStore(
    getConnectorSecret,
    {
      orgId: opts.orgId,
      interactive: opts.interactive,
      devMode: opts.devMode,
      apiUrl: opts.apiUrl,
    },
    opts.storeName ?? DOKPLOY_CONNECTOR_SECRET_NAME,
  );
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
 * ask" — shared by `deployCommand.ts` (`--yes`, `--dry-run`) and
 * the import connector (`--json`, `--dry-run`):
 *
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
 *
 * `storeName` (CAP-679 follow-up) is which system store entry this refusal
 * is about — defaults to `DOKPLOY_CONNECTOR_SECRET_NAME` for back-compat
 * with every existing caller; `deployCommand.ts` passes
 * `DOKPLOY_TARGET_SECRET_NAME` explicitly so its messages name the right key.
 */
export function describeDokployTokenProblem(
  code: string,
  tokenEnv: string,
  storeName: string = DOKPLOY_CONNECTOR_SECRET_NAME,
): { reason: string; hint: string } {
  if (code === ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `only an org owner or admin can set ${storeName} in the system store, and $${tokenEnv} is not set`,
      hint: `Ask an org owner/admin to run \`capy system set ${storeName}\`, or export ${tokenEnv} yourself.`,
    };
  }
  if (code === ERROR_CODES.DOKPLOY_TARGET_KEY_MISSING) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `${DOKPLOY_TARGET_SECRET_NAME} is not set, but ${DOKPLOY_CONNECTOR_SECRET_NAME} already holds a Dokploy key`,
      hint: `Run this interactively to choose whether to reuse it, or run \`capy system set ${DOKPLOY_TARGET_SECRET_NAME}\` to set a dedicated one.`,
    };
  }
  if (code === ERROR_CODES.DOKPLOY_CONNECTOR_KEY_MISSING) {
    return {
      // COPY-FLAG: minimal neutral wording.
      reason: `${DOKPLOY_CONNECTOR_SECRET_NAME} is not set, but ${DOKPLOY_TARGET_SECRET_NAME} already holds a Dokploy key`,
      hint: `Run this interactively to choose whether to reuse it, or run \`capy system set ${DOKPLOY_CONNECTOR_SECRET_NAME}\` to set a dedicated one.`,
    };
  }
  if (code === 'DOKPLOY_TOKEN_MISSING') {
    return {
      reason: `$${tokenEnv} is not set`,
      // COPY-FLAG: minimal neutral wording.
      hint: `Run \`capy system set ${storeName}\`, or export ${tokenEnv}=… first.`,
    };
  }
  return {
    // COPY-FLAG: minimal neutral wording.
    reason: `could not resolve the Dokploy API key (${code})`,
    hint: `Run \`capy system set ${storeName}\`, or export ${tokenEnv}=… first.`,
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
  // Deliberately EXCLUDES the END line's own eol: that terminator belongs to
  // `after`, not to the consumed block span. `mergeManagedBlock` rebuilds the
  // block's 4 lines via `.join(eol)`, which never carries a trailing
  // terminator after the last line (END) — so if `after` didn't keep its own
  // leading eol, `before + newBlock + after` would lose exactly one line
  // ending every time a block gets replaced with real content following it
  // (see the fixtures in dokployApi.test.ts for the byte-exact round trip
  // this buys: strip(merge(x)) === x, and a replace keeps `before`/`after`
  // byte-identical).
  const endEnd = offsetOf(ends[0]) + rawLines[ends[0]].content.length;
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
 * `before`/`after` concatenated, byte for byte — the raw text a real dotenv
 * parser (CRLF, quoting, comments, multi-line quoted values) should read,
 * as opposed to `outsideLines`' pre-split/pre-joined view used by the
 * naive name-only regex (`parseDotenvEntries`/`envKeys`). Never used for
 * reconstruction — that stays `splitManagedBlock`'s `before`/`after` fields
 * directly (see `mergeManagedBlock`/`stripManagedBlock`).
 */
function outsideText(split: EnvSplit): string {
  return split.before + split.after;
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

// ── Plaintext delivery (CAP-682) ────────────────────────────────────────────
//
// Dokploy targets no longer ship `_SECRETS_BLOB`/`_PROJECT_KEY` — Capy writes
// each delivered var as a plain `KEY=value` line INSIDE the managed block,
// and comments out (never deletes) every pre-existing ACTIVE line outside the
// block that defines the same name, so the platform never reads two
// definitions of one var. This section is the pure rendering/scanning half
// of that: `formatDotenvValue` (one value → one dotenv-safe line),
// `syncCommentedLines` (comment/uncomment the right outside lines),
// `mergeManagedValuesBlock`/`removeManagedValuesBlock` (compose the two into
// a whole-env write), and `mismatchedDeliveredValues` (the read-back check).
// The OLD pair-based `mergeManagedBlock`/`stripManagedBlock`/`RUNTIME_PAIR`
// above are UNCHANGED and still exported — `capy run` and any other adapter
// that still ships the blob/token pair keeps using them exactly as before.

/**
 * Stable prefix `capy deploy` puts on a line it disabled — never deletes.
 * Chosen short and greppable; the trailing space keeps the original line's
 * own content readable immediately after it in the Dokploy dashboard.
 */
// COPY-FLAG: new on-disk marker text (not user-facing prose, but visible in the Dokploy dashboard).
export const CAPY_OFF_MARKER = '# capy:off ';

export type DotenvValueProblem = 'DOKPLOY_VALUE_UNREPRESENTABLE' | 'DOKPLOY_VALUE_HAS_REFERENCE';

/**
 * Render one arbitrary string as a `dotenv`-safe VALUE (the part after `=`,
 * quotes included) such that `dotenv.parse` on the rendered line reads back
 * exactly `value` — see `tests/deploy/dokployPlainDelivery.test.ts` for the
 * adversarial property test (and seeded fuzz test) this is built to satisfy.
 *
 * ALWAYS quotes (never emits an unquoted value): dotenv trims an unquoted
 * value's surrounding whitespace and cuts it at the first `#`, and — subtler
 * — a value that itself happens to start and end with the same quote
 * character would be re-stripped by `dotenv.parse`'s own quote-removal step
 * if left unquoted. Quoting unconditionally sidesteps both.
 *
 * FIRST, independent of quoting: `dotenv.parse` normalizes every `\r\n` (and
 * a lone `\r`) to `\n` on the WHOLE input text before any quote-aware parsing
 * even starts (`lines.replace(/\r\n?/mg, '\n')` in `dotenv`'s own source) —
 * so a value containing a real `\r` byte, in ANY quote form, can never read
 * back exactly: refused outright, not a quoting problem at all.
 *
 * Otherwise picks the first wrapper the value doesn't defeat, in order of
 * "least escaping-shaped risk":
 *   1. single quotes — safe for anything, PROVIDED the value has no `'`.
 *      `dotenv` never interprets escapes inside a single-quoted value (not
 *      even `\n`), so every other byte — real newlines, `"`, `` ` ``,
 *      `#`, `$`, backslashes — survives verbatim.
 *   2. backticks — identical safety to single quotes, for a value that has
 *      a `'` but no `` ` ``.
 *   3. double quotes — for a value with both `'` and `` ` `` but no `"`.
 *      UNLIKE the other two, `dotenv.parse` decodes a double-quoted value's
 *      literal `\n` AND literal `\r` (backslash + the letter n or r — two
 *      ordinary characters, NOT the real control bytes the earlier `\r`
 *      check above is about) into real newline/CR control characters — so
 *      this wrapper is only safe when the value contains NEITHER two-
 *      character sequence. A REAL embedded newline byte is fine either way
 *      (it is not what that decode step matches); a real embedded `\r`
 *      byte was already refused above, but the literal two-character
 *      `\`+`r` sequence is a completely different, still-live risk this
 *      branch must guard on its own.
 *   4. refuse — a value containing all three quote characters (or `'`+`` ` ``
 *      plus a `"` or a literal `\n`/`\r` sequence) cannot be represented
 *      losslessly by any of `dotenv`'s three quote forms: whichever one
 *      would be chosen to survive matching still needs to escape ITS OWN
 *      quote character inside the value, and `dotenv.parse` never
 *      un-escapes that back — the escaping backslash would land in the
 *      read-back value, corrupting it. Refused rather than written lossy.
 *
 * SEPARATELY, before any of the above: a value containing a literal `${{`
 * is refused outright (`DOKPLOY_VALUE_HAS_REFERENCE`), regardless of
 * quoting. Dokploy itself resolves `${{project.X}}`/`${{environment.X}}`
 * template references inside `env` at deploy time (or throws if one
 * doesn't resolve) — so a delivered value that merely CONTAINS that
 * substring would either get silently rewritten by Dokploy's own resolver
 * or break the deploy outright, never reaching the container as the exact
 * value Capy wrote.
 */
export function formatDotenvValue(value: string): { ok: true; rendered: string } | { ok: false; code: DotenvValueProblem } {
  if (value.includes('${{')) return { ok: false, code: 'DOKPLOY_VALUE_HAS_REFERENCE' };
  if (value.includes('\r')) return { ok: false, code: 'DOKPLOY_VALUE_UNREPRESENTABLE' };
  if (!value.includes("'")) return { ok: true, rendered: `'${value}'` };
  if (!value.includes('`')) return { ok: true, rendered: `\`${value}\`` };
  // Both literal two-character sequences `dotenv.parse` decodes inside a
  // double-quoted value — NOT the real control bytes (`\r` is refused
  // above; a real embedded `\n` is fine and not what this matches).
  const hasEscapeSequence = value.includes('\\n') || value.includes('\\r');
  if (!value.includes('"') && !hasEscapeSequence) return { ok: true, rendered: `"${value}"` };
  return { ok: false, code: 'DOKPLOY_VALUE_UNREPRESENTABLE' };
}

/** One dotenv line's problem, keyed by the variable NAME only — never the value. */
export interface DotenvValueNameProblem {
  name: string;
  code: DotenvValueProblem;
}

/**
 * `formatDotenvValue` for a whole delivery — every entry rendered as a
 * `KEY=value` line, in the SAME order `entries` was given. All-or-nothing:
 * any unrepresentable value refuses the WHOLE render (never a partial
 * block), naming every offending variable.
 */
export function renderManagedValueLines(
  entries: ReadonlyArray<{ name: string; value: string }>,
): { ok: true; lines: readonly string[] } | { ok: false; problems: readonly DotenvValueNameProblem[] } {
  const rendered = entries.map((e) => ({ name: e.name, result: formatDotenvValue(e.value) }));
  const problems = rendered.flatMap((r) => (r.result.ok ? [] : [{ name: r.name, code: r.result.code }]));
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    lines: rendered.map((r) => `${r.name}=${(r.result as { ok: true; rendered: string }).rendered}`),
  };
}

/**
 * Mirrors `dotenv` 16.x's own `LINE` regex verbatim (see
 * `node_modules/dotenv/lib/main.js`) — used ONLY to find each outside
 * entry's NAME and physical-line SPAN (including a multi-line quoted
 * value's continuation lines), never to extract/decode its value (reading
 * a value back for verification stays `dotenv.parse` itself, via
 * `mismatchedDeliveredValues`). Kept as a local literal copy rather than a
 * dependency on `dotenv`'s internals (which the package does not export)
 * — this is the only way to know which physical lines one entry spans.
 */
const DOTENV_LINE_SOURCE =
  "(?:^|^)\\s*(?:export\\s+)?([\\w.-]+)(?:\\s*=\\s*?|:\\s+?)(\\s*'(?:\\\\'|[^'])*'|\\s*\"(?:\\\\\"|[^\"])*\"|\\s*`(?:\\\\`|[^`])*`|[^#\\r\\n]+)?\\s*(?:#.*)?(?:$|$)";

interface OutsideEntrySpan {
  readonly name: string;
  /** Index into the physical-line array this span was found in (0-based, inclusive). */
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** Cumulative start offset of each line, as if every `RawLine.content` were joined with a single `\n` — mirrors `dotenv`'s own CRLF→LF normalization for matching purposes only (never for reconstruction). */
function lineStartOffsets(contents: readonly string[]): readonly number[] {
  return contents.reduce<{ offsets: readonly number[]; acc: number }>(
    (state, c) => ({ offsets: [...state.offsets, state.acc], acc: state.acc + c.length + 1 }),
    { offsets: [], acc: 0 },
  ).offsets;
}

/** The largest index `i` with `offsets[i] <= pos` — which physical line a normalized-text offset falls in. */
function lineIndexForOffset(offsets: readonly number[], pos: number): number {
  return offsets.reduce((best, start, i) => (start <= pos ? i : best), 0);
}

/**
 * Every KEY=value entry findable in `lines`, with the physical-line span it
 * occupies.
 *
 * Uses the regex's `d` (hasIndices) flag to read each CAPTURE GROUP's own
 * offsets, rather than the whole match's `m.index`/`m[0].length` — the
 * pattern's leading `\s*` (before the KEY) and trailing `\s*` (after the
 * value, before an optional comment) are DELIBERATELY lax to mirror
 * `dotenv`'s own matching, which means the FULL match can extend across a
 * blank line or trailing whitespace that has nothing to do with this
 * entry's own content. Anchoring the span to the KEY group's start and the
 * value group's end (falling back to the KEY group's own end when there is
 * no value at all, e.g. a bare `KEY=`) keeps a blank/comment line that
 * merely precedes or follows an entry from being misattributed to it.
 */
function findEntrySpans(lines: readonly RawLine[]): readonly OutsideEntrySpan[] {
  const contents = lines.map((l) => l.content);
  const normalized = contents.join('\n');
  const offsets = lineStartOffsets(contents);
  const re = new RegExp(DOTENV_LINE_SOURCE, 'gmd');
  return Array.from(normalized.matchAll(re))
    .filter((m) => m[0].length > 0 && typeof m.index === 'number')
    .map((m) => {
      const indices = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
      const keyRange = indices?.[1];
      const valueRange = indices?.[2];
      const start = keyRange ? keyRange[0] : (m.index as number);
      const end = (valueRange ?? keyRange ?? [start, start + m[0].length])[1] - 1;
      return { name: m[1], lineStart: lineIndexForOffset(offsets, start), lineEnd: lineIndexForOffset(offsets, Math.max(start, end)) };
    });
}

function markLine(content: string): string {
  return content.startsWith(CAPY_OFF_MARKER) ? content : CAPY_OFF_MARKER + content;
}

function unmarkLine(content: string): string {
  return content.startsWith(CAPY_OFF_MARKER) ? content.slice(CAPY_OFF_MARKER.length) : content;
}

/**
 * Whether `env` has ANY line carrying Capy's `CAPY_OFF_MARKER` prefix —
 * regardless of whether a managed block is present. Exists for `onRemove`:
 * a managed block being GONE (`splitManagedBlock`'s `hadBlock: false` —
 * e.g. someone deleted just the block by hand in the Dokploy dashboard,
 * leaving the commented lines behind, since a `# capy:off ` line is an
 * ordinary comment to Dokploy and never gets cleaned up on its own) must
 * not be reported as "nothing to remove" when stray marked lines are still
 * sitting there — those still need un-commenting to restore the env.
 */
export function hasCommentedLines(env: string | null): boolean {
  return (env ?? '').split(/\r?\n/).some((line) => line.startsWith(CAPY_OFF_MARKER));
}

/** `a..b` inclusive, as a plain array — small env files only, no need for anything cleverer. */
function inclusiveRange(a: number, b: number): readonly number[] {
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

/**
 * Comment out (or un-comment) lines OUTSIDE Capy's managed block so at most
 * ONE definition of any delivered name is ever active — the byte-exact,
 * reversible half of CAP-682's plaintext delivery.
 *
 * For every KEY=value entry `findEntrySpans` can find in `text` (scanned
 * against a MARKER-STRIPPED reading of every line, so this is correct
 * however the line is marked right now):
 *   - `deliveredNames` has the entry's name → every physical line of its
 *     span ends up marked (an already-marked line is left alone —
 *     `markLine` is idempotent, never double-prefixes).
 *   - it does not → every physical line of its span ends up UNmarked.
 *
 * A line that is not part of any detected entry (blank, a real comment, or
 * one Dokploy's own `${{project.X}}`/`${{environment.X}}` reference syntax
 * that still parses as a plain KEY=value — those are entries too, just
 * never in `deliveredNames`, so this leaves them active) is returned
 * byte-identical, including its own original line ending. Idempotent and
 * order-independent: calling this again with the SAME `deliveredNames`
 * changes nothing; calling it with a DIFFERENT set converges directly to
 * the new state without needing to know what the previous call did.
 */
export function syncCommentedLines(text: string, deliveredNames: ReadonlySet<string>): string {
  const rawLines = splitPreservingEol(text);
  const demarkedForScanning = rawLines.map((l) => ({ ...l, content: unmarkLine(l.content) }));
  const spans = findEntrySpans(demarkedForScanning);
  const lineDecision = spans.reduce<ReadonlyMap<number, 'mark' | 'unmark'>>((acc, span) => {
    const decision: 'mark' | 'unmark' = deliveredNames.has(span.name) ? 'mark' : 'unmark';
    const entries = inclusiveRange(span.lineStart, span.lineEnd).map((i) => [i, decision] as const);
    return new Map([...acc, ...entries]);
  }, new Map());
  return rawLines
    .map((l, i) => {
      const decision = lineDecision.get(i);
      const content = decision === 'mark' ? markLine(l.content) : decision === 'unmark' ? unmarkLine(l.content) : l.content;
      return content + l.eol;
    })
    .join('');
}

export type DokployPlainMergeProblem =
  | { code: 'malformed_block' }
  // Deliberately NOT keyed by a single `DotenvValueProblem` — `problems` can
  // freely mix `DOKPLOY_VALUE_UNREPRESENTABLE` and `DOKPLOY_VALUE_HAS_REFERENCE`
  // across different variables in the same delivery (see
  // `describeDokployPlainMergeProblem`, which groups them back out).
  | { code: 'value_problem'; problems: readonly DotenvValueNameProblem[] };

/**
 * Whole-env write for CAP-682's plaintext delivery: comments out every
 * pre-existing active line outside the block for a delivered name (see
 * `syncCommentedLines`), un-comments a previously-marked line for a name no
 * longer delivered, and replaces (or first-writes) the managed block with
 * one `KEY=value` line per delivered var — same in-place-replace / append
 * placement rule `mergeManagedBlock` uses (reuses its own `blockEol`/
 * `dominantEol` choice, so a redeploy's block framing never drifts).
 *
 * All-or-nothing on an unrepresentable value: nothing is written (not even
 * the comment/uncomment half) — a partial write would leave the platform's
 * env in a state no single `capy deploy` run produced.
 */
export function mergeManagedValuesBlock(
  env: string | null,
  values: ReadonlyArray<{ name: string; value: string }>,
): { ok: true; env: string } | { ok: false; problem: DokployPlainMergeProblem } {
  const split = splitManagedBlock(env);
  if ('code' in split) return { ok: false, problem: { code: 'malformed_block' } };
  const rendered = renderManagedValueLines(values);
  if (!rendered.ok) {
    return { ok: false, problem: { code: 'value_problem', problems: rendered.problems } };
  }
  const deliveredNames = new Set(values.map((v) => v.name));
  const nextBefore = syncCommentedLines(split.before, deliveredNames);
  const nextAfter = syncCommentedLines(split.after, deliveredNames);
  const eol = split.hadBlock ? (split.blockEol ?? '\n') : dominantEol(nextBefore);
  const block = [MANAGED_BEGIN, ...rendered.lines, MANAGED_END].join(eol);
  const withBlock = split.hadBlock
    ? nextBefore + block
    : nextBefore.length > 0
      ? nextBefore + eol + block
      : block;
  return { ok: true, env: withBlock + nextAfter };
}

/**
 * The exact revert of `mergeManagedValuesBlock`: removes the managed block
 * (`stripManagedBlock`'s own byte-exact rule) AND un-comments every line
 * Capy marked outside it — `deliveredNames` is always empty here, so every
 * currently-marked entry, for whichever names, comes back active. Byte-exact
 * restore of the original env, the same guarantee `stripManagedBlock` alone
 * gives for the block itself.
 */
export function removeManagedValuesBlock(env: string | null): { ok: true; env: string } | { ok: false } {
  const split = splitManagedBlock(env);
  if ('code' in split) return { ok: false };
  const uncommentedBefore = syncCommentedLines(split.before, new Set());
  const uncommentedAfter = syncCommentedLines(split.after, new Set());
  const text = split.hadBlock
    ? uncommentedBefore.replace(/\r?\n$/, '') + uncommentedAfter
    : uncommentedBefore + uncommentedAfter;
  return { ok: true, env: text };
}

/**
 * Read-back verification (CAP-682): every delivered name that
 * `dotenv.parse(env)` does NOT resolve to Capy's own value — because the
 * write didn't land, a concurrent edit raced it, or (defensively) the
 * comment/uncomment logic above has a gap somewhere. Empty means every
 * delivered value round-trips exactly. Never logs `env` or any value —
 * callers name ONLY the returned variable names.
 */
export function mismatchedDeliveredValues(
  env: string,
  values: ReadonlyArray<{ name: string; value: string }>,
): readonly string[] {
  const parsed = parseDotenv(env);
  return values.filter((v) => parsed[v.name] !== v.value).map((v) => v.name);
}

/**
 * CAP-679: a Compose service with `createEnvFile: false` never gets an
 * `.env` file on disk, so a service that reads its config via `env_file:
 * .env` would never see Capy's block no matter what `env` holds. Refused
 * before any read/merge — there is no way to make this deploy work without
 * the Dokploy setting changing first.
 */
export function describeComposeEnvFileDisabled(): { reason: string; hint: string } {
  return {
    // COPY-FLAG: minimal neutral wording.
    reason: 'this Compose service has "Create Env File" disabled in Dokploy, so its containers never read an env file',
    hint: 'Enable "Create Env File" for this service in the Dokploy Environment tab, then re-run `capy deploy`.',
  };
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

/**
 * `mergeManagedValuesBlock`'s refusal, as a printable reason + hint.
 * `code` is the SPECIFIC `ErrorCode` when every offending variable shares
 * the SAME `DotenvValueProblem`; when `p.problems` mixes
 * `DOKPLOY_VALUE_UNREPRESENTABLE` and `DOKPLOY_VALUE_HAS_REFERENCE` across
 * different variables in one delivery, neither specific code alone would
 * correctly describe every variable, so the umbrella `DOKPLOY_VALUE_INVALID`
 * is reported instead (Rule 5: always a real, stable code — never omitted).
 * `reason`/`hint` name every variable and its own specific problem either
 * way. `malformed_block` mirrors `describeEnvProblem`'s OWN pre-existing
 * refusal, which has never carried a machine code (an edited/duplicated
 * block is reported by `reason` alone, same as before CAP-682). Names
 * only, never a value.
 */
// COPY-FLAG: new user-facing strings, minimal/neutral wording.
export function describeDokployPlainMergeProblem(
  p: DokployPlainMergeProblem,
): { reason: string; hint: string; code?: string } {
  if (p.code === 'malformed_block') {
    return describeEnvProblem({ code: 'malformed_block', names: [] });
  }
  const referenceNames = p.problems.filter((x) => x.code === 'DOKPLOY_VALUE_HAS_REFERENCE').map((x) => x.name);
  const unrepresentableNames = p.problems.filter((x) => x.code === 'DOKPLOY_VALUE_UNREPRESENTABLE').map((x) => x.name);
  const referenceVerb = referenceNames.length === 1 ? 'contains' : 'contain';
  const reasonParts = [
    referenceNames.length
      ? `${referenceNames.join(', ')} ${referenceVerb} a literal \${{ — Dokploy resolves that itself at deploy time, so Capy's own value would never reach the container unchanged`
      : null,
    unrepresentableNames.length
      ? `${unrepresentableNames.join(', ')} cannot be written to Dokploy as an exact dotenv value — every quote style dotenv understands is already in use, or it contains a carriage return`
      : null,
  ].filter((s): s is string => !!s);
  const hintParts = [
    referenceNames.length ? `remove the literal \${{ from ${referenceNames.join(', ')}` : null,
    unrepresentableNames.length
      ? `change the value of ${unrepresentableNames.join(', ')} (drop one of ' " \` from it, or the carriage return)`
      : null,
  ].filter((s): s is string => !!s);
  const code =
    referenceNames.length > 0 && unrepresentableNames.length === 0
      ? 'DOKPLOY_VALUE_HAS_REFERENCE'
      : referenceNames.length === 0 && unrepresentableNames.length > 0
        ? 'DOKPLOY_VALUE_UNREPRESENTABLE'
        : 'DOKPLOY_VALUE_INVALID'; // mixed — umbrella code; reason/hint still say everything needed
  return {
    reason: reasonParts.join('; '),
    hint: `${hintParts.join('; ')}, then re-run \`capy deploy\`.`,
    code,
  };
}

// ── Importable entries (for a future `capy connect dokploy`) ─────────────

export type ImportSkipReason = 'DOKPLOY_REFERENCE_VALUE';
export type ImportWarningReason = 'DOKPLOY_VALUE_HAS_DOLLAR' | 'DOKPLOY_VALUE_QUOTED';

export interface ImportableEnvEntry {
  name: string;
  value: string;
  /** Present when this entry should not be offered for import, and why. */
  skip?: ImportSkipReason;
  /** Present when this entry IS offered, but its value deserves a second look — see `classifyImportValue`'s doc. */
  warning?: ImportWarningReason;
}

/** Whether `value` is wrapped in exactly one matching pair of `"`/`'` — never stripped, only detected. */
function isSingleQuotePairWrapped(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' || first === "'") && first === last;
}

/**
 * One raw name/value's own classification: a reference value is never
 * imported as a literal string (there is no resolved value to put in
 * `.env`). Dokploy's own `dotenv.parse` (see `listImportableEntries`'s doc)
 * already strips ONE layer of surrounding quotes before this ever runs, so a
 * PARSED value that STILL looks quote-wrapped means the raw line was
 * double-quoted (e.g. `KEY='"real value"'`) — flagged under
 * `DOKPLOY_VALUE_QUOTED` (CAP-679 follow-up) rather than silently imported
 * with its outer quote characters as literal content. Never stripped here —
 * the person reviews and decides; a `$` anywhere else in the PARSED value
 * (bcrypt hashes written `$$escaped$$`, an unresolved `${VAR}` Compose
 * interpolation, …) is still imported — Dokploy/Compose is the thing that
 * treats `$` specially, not Capy — but flagged under
 * `DOKPLOY_VALUE_HAS_DOLLAR` the same way. A value is flagged for at most
 * one reason — quoting takes priority since it's about the value's OUTER
 * shape, `$` about its content.
 */
function classifyImportValue(name: string, value: string): ImportableEnvEntry {
  if (value.includes('${{')) return { name, value, skip: 'DOKPLOY_REFERENCE_VALUE' };
  if (isSingleQuotePairWrapped(value)) return { name, value, warning: 'DOKPLOY_VALUE_QUOTED' };
  return value.includes('$') ? { name, value, warning: 'DOKPLOY_VALUE_HAS_DOLLAR' } : { name, value };
}

/**
 * Entries a `capy connect dokploy` import could offer: every name outside
 * the Capy block, minus the runtime pairs (Capy's own machinery, never a
 * project secret), with a reference value like `${{project.SOME_VAR}}`
 * flagged rather than silently imported as a literal string.
 *
 * The value for each name is exactly what Dokploy's OWN first parsing step
 * produces — Dokploy parses a service's env text with the `dotenv` npm
 * package before it ever reaches disk (see `docs/dokploy-deploy-adapter.md`
 * for the upstream source reference) — never a byte-for-byte copy of the
 * raw line. Concretely, for a name like `DATABASE_URL="postgres://…"`:
 * CRLF is normalized to LF, a leading `export ` is dropped, one matching
 * pair of `'`/`"`/`` ` `` around the (trimmed) value is stripped, `\n`/`\r`
 * are decoded ONLY inside a double-quoted value, an unquoted value is cut
 * at the first `#`, and a duplicate name's LAST line wins — all of it
 * `dotenv.parse`'s own behavior, not reimplemented here. This is a
 * DIFFERENT parse than `parseDotenvEntries`/`envKeys` (used for name-only
 * collision checks and the byte-exact managed-block machinery above) — that
 * one is intentionally naive about values; only import ever hands a value
 * to the person, so only import needs to get the value right.
 */
export function listImportableEntries(env: string | null): readonly ImportableEnvEntry[] {
  const split = splitManagedBlock(env);
  if ('code' in split) return [];
  const reserved = new Set<string>([...RUNTIME_PAIR, ...OLD_RUNTIME_PAIR]);
  const parsed = parseDotenv(outsideText(split));
  return Object.entries(parsed)
    .filter(([name]) => !reserved.has(name))
    .map(([name, value]) => classifyImportValue(name, value));
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
