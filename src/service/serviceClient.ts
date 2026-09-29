import { join } from 'path';
import {
  DecryptResponse,
  ProjectInitResult,
  PushResult,
  ServiceToken,
  EnvVariable,
  KeepFile,
  Branch,
  CapyError,
  ERROR_CODES,
} from '../types/index';
import { createHash } from 'crypto';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';
import { debug } from '../ui/debug';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * The codes this client is willing to mint from a response body's `code`.
 *
 * An allowlist rather than a passthrough: a server free to name any code it
 * likes could steer the CLI down a branch the CLI never reasoned about, and
 * `MEMBERSHIP_REVOKED` in particular gates a destructive local wipe. Anything
 * unrecognised falls through to SERVICE_ERROR, which is the safe default.
 */
const SERVER_CODES = new Set<string>([
  ERROR_CODES.PROJECT_NOT_FOUND,
  ERROR_CODES.BRANCH_NOT_FOUND,
  ERROR_CODES.SNAPSHOT_NOT_FOUND,
  ERROR_CODES.NO_SECRETS,
  ERROR_CODES.ORG_NOT_FOUND,
  ERROR_CODES.DEPLOY_TOKEN_NOT_FOUND,
  // CAP-684 basic pairing — device-pairings pickup refusals.
  ERROR_CODES.PAIRING_NOT_FOUND,
  ERROR_CODES.PAIRING_WRONG_USER,
  ERROR_CODES.PAIRING_NOT_READY,
]);

/**
 * WHICH ERROR THIS IS — decided ONCE, here, where the status and the body are
 * both in hand, and never again downstream.
 *
 * The alternative is what this replaces, and it was live in three files: the
 * error screen picked its layout with `serverMsg.includes('Project not
 * found')`, `getDecryptData` decided whether to swallow a 404 with
 * `msg.includes('not found') && !msg.includes('No secrets')`, and
 * `statusCommand` turned `err.message` into an `access_denied` badge with
 * `reason.includes('do not have access')`. Three copies of one decision, each
 * keyed on prose that no contract obliges the service to keep. Reword "Project
 * not found" to "No such project" and the error screen silently drops to the
 * generic layout — taking the recovery instructions with it — with nothing
 * failing anywhere.
 *
 * PRECEDENCE.
 *   1. The server's own `code` field, when it is one we recognise. This is the
 *      contract, and it is what new code should rely on.
 *   2. Otherwise, for 404s only, the historical message shapes — because a CLI
 *      talks to whatever version of the service is deployed, and the older one
 *      sends prose and nothing else. This is the ONLY place that match is
 *      allowed to live, and it is here rather than downstream so it is one
 *      bridge to delete rather than three to find. Delete it once every
 *      supported service emits `code`.
 *   3. SERVICE_ERROR.
 *
 * `MEMBERSHIP_REVOKED` is deliberately not minted here: it stays a
 * `details.code` on a PERMISSION_DENIED, because `isMembershipRevokedError`
 * is the single gate for a destructive wipe and its contract is pinned by
 * tests. One vocabulary, two shapes, both machine-readable.
 */
export function classifyResponse(
  status: number,
  data: Record<string, any>,
  message: string,
): string {
  if (typeof data.code === 'string' && SERVER_CODES.has(data.code)) return data.code;

  if (status === 404) {
    // Legacy bridge — prose, quarantined. Each predicate is the one that used
    // to live at the call site named above, moved verbatim so behaviour is
    // identical and only its LOCATION has changed.
    if (message.includes('Snapshot not found')) return ERROR_CODES.SNAPSHOT_NOT_FOUND;
    if (message.includes('No secrets')) return ERROR_CODES.NO_SECRETS;
    if (message.includes('Project not found')) return ERROR_CODES.PROJECT_NOT_FOUND;
    if (message.includes('Branch')) return ERROR_CODES.BRANCH_NOT_FOUND;
  }

  return ERROR_CODES.SERVICE_ERROR;
}

export interface MemberProjectBranch {
  id: string;
  name: string;
  isProtected: boolean;
  hasAccess: boolean;
}

export interface MemberProject {
  id: string;
  name: string;
  role?: 'project-admin' | 'member';
  branches: MemberProjectBranch[];
}

export interface MemberDetail {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  projects: MemberProject[];
}

// ── `capy secrets` (CAP-673): GET /orgs/:orgId/secrets ──────────────────────
//
// Read-only, org-wide secret NAME index — never a value. One row per
// (name, value_hash) pair; `capy secrets` (secretsCommand.ts) renders this
// as a table and is the only consumer.

/** A location's Dokploy connector info, when the value there was imported from Dokploy (CAP-673's `service_name`/`dokploy_project`/`environment`/`compose_id`). `null` when this location's value has no connector, or a non-dokploy one. */
export interface SecretIndexService {
  provider: string;
  name?: string;
  dokploy_project?: string;
  environment?: string;
  compose_id?: string;
}

/**
 * CAP-676: the connector that brought this location's value IN. Distinct
 * from (and additive alongside) the older `service` shape — `service` is
 * Dokploy-specific and carries a name/project/compose_id; `connector` is
 * provider-only and provider-agnostic. Optional because it may be absent on
 * a server that predates CAP-676 — callers fall back to `service?.provider`.
 */
export interface SecretIndexConnector {
  provider: string;
}

/**
 * CAP-676: one deploy target this location's value was pushed OUT to.
 * `stale` marks a target whose last push (`deployed_at`) predates the
 * value's current `changed_at` — i.e. what's deployed there may not be
 * what's set now. Optional/absent on a server that predates CAP-676.
 */
export interface SecretIndexTarget {
  provider: string;
  target: string;
  deployed_at?: string;
  stale: boolean;
  /**
   * CAP-679 follow-up: this target's config was written by `capy deploy
   * --no-deploy` and has never actually been shipped — the platform deploy
   * itself hasn't run yet. Absent (or `false`) means deployed, same
   * additive-only convention as `TargetDelivery.deployed` in
   * `types/index.ts`. The server currently drops unknown target fields, so
   * this is only ever populated once the server passes it through — the CLI
   * side is ready ahead of that.
   */
  pending?: boolean;
}

/** One (project, branch) this (name, value_hash) pair lives on. */
export interface SecretIndexLocation {
  project_id: string;
  project_name: string;
  branch: string;
  protected: boolean;
  changed_at?: string;
  service: SecretIndexService | null;
  /** CAP-676, additive: the inbound connector, when the server sends one (see `SecretIndexConnector`'s doc for the `service` fallback). */
  connector?: SecretIndexConnector;
  /** CAP-676, additive: every outbound deploy target for this location's value, or absent/`[]` on a server or location with none. */
  targets?: SecretIndexTarget[];
}

export interface SecretIndexUser {
  user_id: string;
  email: string;
}

/** One row: a (name, value_hash) pair, every location that holds it, and every user who can read it. Two rows can share a `name` with a DIFFERENT `value_hash` — that's a real divergence, not a bug. */
export interface SecretIndexRow {
  name: string;
  value_hash: string;
  locations: SecretIndexLocation[];
  users: SecretIndexUser[];
}

/** A project the index could not read (e.g. a permission gap) — named and coded, never silently dropped. */
export interface SecretIndexSkipped {
  project_id: string;
  project_name: string;
  code: string;
}

export interface SecretIndexResponse {
  org_id: string;
  rows: SecretIndexRow[];
  skipped: SecretIndexSkipped[];
}

/**
 * Async callback that returns the current valid token, refreshing it if
 * needed. ServiceClient calls this before every request — no local token
 * cache — so token rotation (org switch, create-org, redeem, expiry) is
 * invisible to ServiceClient and callers.
 */
export type TokenProvider = () => Promise<ServiceToken | null>;

export class ServiceClient {
  private apiUrl: string;
  private tokenProvider: TokenProvider | null = null;

  constructor(apiUrl?: string, devMode: boolean = false) {
    // Explicit apiUrl wins (call-site override / tests). Otherwise resolve
    // through the profile chain: CAPY_API_URL → CAPY_PROFILE → config.default
    // → built-in default. See src/config/profileConfig.ts for the precedence
    // contract.
    if (apiUrl) {
      this.apiUrl = apiUrl;
    } else {
      // Lazy require so config/profileConfig doesn't get pulled into the
      // dist when this module is tree-shaken in isolation (matches the rest
      // of the codebase's lazy-import pattern for dev-only paths).
      const { resolveActiveUrl } = require('../config/profileConfig') as typeof import('../config/profileConfig');
      this.apiUrl = resolveActiveUrl(devMode);
    }
    // Install profile TLS trust (idempotent) so subsequent fetch() calls
    // accept self-signed BYOC certs configured via `capy byoc`. No-op when
    // there's no active profile or the profile has no caBundle.
    const { installProfileTlsTrust } = require('../config/tlsBootstrap') as typeof import('../config/tlsBootstrap');
    installProfileTlsTrust();
    if (devMode) {
      // Suppress the dev diagnostic in local-only mode — the server URL is
      // never used there, and the log is misleading (looks like server use).
      const { isLocalOnly } = require('../config/profileConfig') as typeof import('../config/profileConfig');
      if (!isLocalOnly()) debug(`[dev] ServiceClient → ${this.apiUrl}`);
    }
  }

  /**
   * Wire the token provider. Call exactly once after construction — ServiceClient
   * then pulls a token on every request. Replaces the old `setToken()` +
   * `setTokenRefresher()` pair (removed to eliminate a whole class of
   * stale-cached-token bugs).
   */
  setTokenProvider(provider: TokenProvider): void {
    this.tokenProvider = provider;
  }

  /**
   * The actual network round trip, isolated so `request()` never needs a
   * `let`-then-try/catch-assignment binding for the response — this returns
   * it (or throws the same `NETWORK_ERROR` it always did) instead of a
   * caller having to declare `res` before the try block.
   */
  private async fetchOnce(method: string, path: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.apiUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new CapyError(
          `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
          ERROR_CODES.NETWORK_ERROR,
          { code: 'ETIMEDOUT' }
        );
      }
      throw new CapyError(
        `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
        ERROR_CODES.NETWORK_ERROR,
        { code: err.code || err.cause?.code }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number; _retried?: boolean }): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = this.tokenProvider ? await this.tokenProvider() : null;
    if (token) {
      headers['Authorization'] = `Bearer ${token.access_token}`;
    }

    const res = await this.fetchOnce(method, path, headers, body, options?.timeout ?? 30000);

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as Record<string, any>;

      if (res.status === 401) {
        // The provider already refreshes proactively on expiry; a 401 here
        // means either the server rejected the token for a non-expiry reason
        // (e.g., membership revoked) or a race with the refresh cycle. Retry
        // once — the next provider() call will fetch a fresh token.
        if (!options?._retried && this.tokenProvider) {
          return this.request<T>(method, path, body, { ...options, _retried: true });
        }
        const detail = data.error || 'Unknown auth error';
        throw new CapyError(
          `Authentication failed: ${detail}`,
          ERROR_CODES.AUTH_FAILED,
          { status: 401, detail }
        );
      }

      if (res.status === 403) {
        const detail = data.error || 'You do not have permission to perform this action.';
        // Surface the server's `code` field if present (e.g., MEMBERSHIP_REVOKED).
        // Callers MUST gate destructive local cleanup on this code, never on the
        // bare 403 status — see capyCommand.ts cleanupOrgData.
        const serverCode = typeof data.code === 'string' ? data.code : undefined;
        throw new CapyError(
          detail,
          ERROR_CODES.PERMISSION_DENIED,
          { status: 403, detail, code: serverCode }
        );
      }

      if (res.status === 402 && data.code === 'QUOTA_EXCEEDED') {
        throw new CapyError(
          data.error || 'Account quota exceeded',
          ERROR_CODES.QUOTA_EXCEEDED,
          { status: 402, kind: data.kind, limit: data.limit, upgrade_url: data.upgrade_url }
        );
      }

      const serverMessage = data.error || data.message || 'Service request failed';
      throw new CapyError(
        serverMessage,
        classifyResponse(res.status, data, serverMessage),
        { status: res.status, data }
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  async initializeProject(projectName: string, organizationId: string): Promise<ProjectInitResult> {
    try {
      const data = await this.request<{ id: string; name: string; organization_id: string; s3_prefix: string }>(
        'POST', '/projects',
        { name: projectName, organization_id: organizationId },
      );

      return {
        org_id: data.organization_id,
        project_id: data.id,
        project_name: data.name,
        created: true
      };
    } catch (error: any) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        'Failed to initialize project',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  async getDecryptData(
    projectId: string,
    branch?: string,
    keepHash?: string,
    includeLatestHash?: boolean,
  ): Promise<DecryptResponse> {
    try {
      const params: string[] = [];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      if (keepHash) params.push(`keep_hash=${encodeURIComponent(keepHash)}`);
      if (includeLatestHash) params.push('include_latest_hash=true');
      const query = params.length ? `?${params.join('&')}` : '';
      const data = await this.request<{
        env_file?: string;
        permissions: string[];
        keep_hash?: string;
        latest_keep_hash?: string;
        keep_file?: string;
      }>(
        'GET', `/secrets/${projectId}${query}`,
      );

      return {
        env_content: data.env_file || '',
        decrypt_key: '', // Key is managed client-side via keyResolver
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        keep_hash: data.keep_hash,
        latest_keep_hash: data.latest_keep_hash,
        keep_file: data.keep_file,
      };
    } catch (error: any) {
      // A 404 here is two different facts wearing one status. "This project /
      // branch / pinned snapshot does not exist" is the caller's problem and
      // has to propagate; "this branch has no secrets yet" is an ordinary
      // empty state on a first run and must not be. `classifyResponse` already
      // told them apart on the way in, so this reads the verdict rather than
      // re-deriving it from the sentence.
      if (error instanceof CapyError && error.details?.status === 404) {
        const PROPAGATE: string[] = [
          ERROR_CODES.SNAPSHOT_NOT_FOUND, // pinned version missing — caller must handle
          ERROR_CODES.PROJECT_NOT_FOUND,
          ERROR_CODES.BRANCH_NOT_FOUND,
        ];
        if (PROPAGATE.includes(error.code)) throw error;
        return {
          env_content: '',
          decrypt_key: '', // Key is managed client-side via keyResolver
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };
      }
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        error.message || 'Failed to retrieve decryption data',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  async pushVariables(
    projectId: string,
    variables: Record<string, string>,
    keep: KeepFile | null = null,
    branch?: string,
    encryptionKey?: string
  ): Promise<PushResult> {
    try {
      const activeBranch = branch || '';
      const encryptedVars: Record<string, string> = {};
      const resultVariables: Record<string, any> = {};

      if (!encryptionKey) {
        throw new CapyError(
          'Encryption key is required for pushing variables',
          ERROR_CODES.PERMISSION_DENIED
        );
      }

      for (const [key, value] of Object.entries(variables)) {
        if (value === 'capy:deleted') {
          encryptedVars[key] = 'capy:deleted';
          resultVariables[key] = {
            resource_id: deriveResourceId(activeBranch, key),
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          };
        } else if (value.startsWith('capy:')) {
          // Already encrypted — pass through as-is, no hash (keep existing)
          const existingResourceId = value.split(':')[1] || deriveResourceId(activeBranch, key);
          encryptedVars[key] = value;
          resultVariables[key] = {
            resource_id: existingResourceId,
          };
        } else {
          const resourceId = deriveResourceId(activeBranch, key);
          const encrypted = Encryptor.encrypt(value, encryptionKey);
          const snippetValue = this.createSnippetWithEncryption(value, encrypted);
          encryptedVars[key] = `capy:${resourceId}:${snippetValue}`;
          resultVariables[key] = {
            resource_id: resourceId,
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          };
        }
      }

      const envFileContent = Object.entries(encryptedVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      // Build keep_file content from keep data
      const keepFileContent = keep ? JSON.stringify(keep) : JSON.stringify({ variables: {} });

      const data = await this.request<{ success: boolean }>(
        'POST', `/secrets/${projectId}`,
        { env_file: envFileContent, keep_file: keepFileContent, ...(branch ? { branch } : {}) },
      );

      return {
        success: data.success,
        variables: resultVariables
      };
    } catch (error: any) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        error.message || 'Failed to push variables',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  /**
   * v3: Fetch an encrypted env blob by keep_hash (no environment param).
   */
  async getSecrets(
    projectId: string,
    keepHash: string,
  ): Promise<{ env_file: string } | null> {
    try {
      const data = await this.request<{ env_file: string }>(
        'GET',
        `/secrets/${projectId}?keep_hash=${encodeURIComponent(keepHash)}`,
      );
      return data;
    } catch (error: any) {
      if (error instanceof CapyError && error.details?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * v3: Push a single env blob to content-addressed storage.
   * The response's keep_file (when the server sends one) is the pushed
   * keep.lock with server-assigned changed_at timestamps — callers should
   * adopt it as the local keep.lock (SyncEngine.adoptServerKeep).
   */
  async pushSecrets(
    projectId: string,
    keepFile: string,
    envBlob: string,
    branch: string,
  ): Promise<{ keep_hash: string; keep_file?: string }> {
    return this.request('POST', `/secrets/${projectId}`, {
      keep_file: keepFile,
      env_blob: envBlob,
      branch,
    });
  }

  /**
   * List all projects in the caller's organization. Used by the client to
   * bootstrap when running in a directory with no local keep.lock.
   */
  async listProjects(): Promise<Array<{ id: string; name: string; organization_id: string }>> {
    const data = await this.request<{
      projects: Array<{ id: string; name: string; organization_id: string }>;
    }>('GET', '/projects');
    return data.projects;
  }

  async createBranch(projectId: string, name: string, isProtected: boolean = false): Promise<Branch> {
    return this.request<Branch>(
      'POST', `/projects/${projectId}/branches`,
      { name, is_protected: isProtected },
    );
  }

  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    await this.request<{ success: boolean }>(
      'DELETE', `/projects/${projectId}/branches/${branchId}`,
    );
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    const data = await this.request<{ branches: Branch[] }>(
      'GET', `/projects/${projectId}/branches`,
    );
    return data.branches;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Creates a snippet-enhanced encrypted value for better usability (same logic as FileManager)
   */
  private createSnippetWithEncryption(originalValue: string, encryptedValue: string): string {
    const valueLength = originalValue.length;

    if (valueLength <= 8) {
      const snippet = originalValue.slice(-1);
      return `${encryptedValue}...${snippet}`;
    } else if (valueLength <= 16) {
      const snippet = originalValue.slice(-3);
      return `${encryptedValue}...${snippet}`;
    } else {
      const firstSnippet = originalValue.slice(0, 4);
      const lastSnippet = originalValue.slice(-4);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    }
  }

  async createInvite(orgId: string, email: string, role?: string, projectId?: string): Promise<{ invite_id: string; org_id: string; email: string; role: string; user_id: string; project_id: string | null }> {
    return this.request('POST', `/orgs/${orgId}/invite`, { email, role, project_id: projectId });
  }

  async inviteToProject(orgId: string, projectId: string, email: string, role: 'project-admin' | 'member'): Promise<{ user_id: string; email: string; project_id: string; role: string }> {
    return this.request('POST', `/orgs/${orgId}/projects/${projectId}/members`, { email, role });
  }

  async kickFromProject(orgId: string, projectId: string, userId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/projects/${projectId}/members/${encodeURIComponent(userId)}`);
  }

  async grantProtectedBranch(orgId: string, projectId: string, branchId: string, userId: string): Promise<void> {
    await this.request('POST', `/orgs/${orgId}/projects/${projectId}/branches/${branchId}/grants`, { user_id: userId });
  }

  async revokeProtectedBranch(orgId: string, projectId: string, branchId: string, userId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/projects/${projectId}/branches/${branchId}/grants/${encodeURIComponent(userId)}`);
  }

  async changeRole(orgId: string, userId: string, role: string, projectId?: string): Promise<{ user_id: string; role: string; project_id: string | null }> {
    return this.request('PATCH', `/orgs/${orgId}/members/${encodeURIComponent(userId)}/role`, { role, project_id: projectId });
  }

  async getOrgMe(orgId: string): Promise<{ user_id: string; role: string; admin_projects: Array<{ id: string; name: string }> }> {
    return this.request('GET', `/orgs/${orgId}/me`);
  }

  /**
   * `notAfter` is for invite-issued blobs only — when present, the server
   * binds it into the KMS EncryptionContext so a client tampering with the
   * value in the redeem code fails the AEAD unwrap. The user's long-lived
   * master key blob is wrapped without it (no expiry on personal storage).
   */
  async wrapOuterLayer(orgId: string, plaintext: string, notAfter?: number): Promise<{ ciphertext: string }> {
    return this.request('POST', `/orgs/${orgId}/wrap`, { plaintext, ...(notAfter !== undefined ? { not_after: notAfter } : {}) });
  }

  async coDecrypt(orgId: string, ciphertext: string, notAfter?: number): Promise<{ plaintext: string }> {
    return this.request('POST', `/orgs/${orgId}/co-decrypt`, { ciphertext, ...(notAfter !== undefined ? { not_after: notAfter } : {}) });
  }

  // --- Basic pairing (CAP-684, docs/basic-pair.md) ---

  /** `capy transport`: stores the sealed transport envelope; the row is deleted on first activate or after 15 minutes, whichever comes first. */
  async createTransport(ciphertext: string): Promise<{ id: string; expires_at: string }> {
    return this.request('POST', '/transports', { ciphertext });
  }

  /**
   * `capy pair`'s last step: exchanges the now-authenticated device code for
   * whatever Keep sealed to the CLI's public key. The server returns this
   * only once — the row is deleted on pickup, same lifecycle as `/transports`.
   */
  async pickupDevicePairing(deviceCode: string): Promise<{ sealed: { v: 1; epk: string; iv: string; ct: string } }> {
    return this.request('POST', '/device-pairings/pickup', { device_code: deviceCode });
  }


  async listMembers(orgId: string): Promise<{ members: any[] }> {
    return this.request('GET', `/orgs/${orgId}/members`);
  }

  async listMemberDetails(orgId: string): Promise<{ members: MemberDetail[] }> {
    return this.request('GET', `/orgs/${orgId}/members/details`);
  }

  async kickMember(orgId: string, membershipId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/members/${encodeURIComponent(membershipId)}`);
  }

  async createDeployToken(orgId: string, deployId: string, projectId: string, innerBlob: string): Promise<{ outer_blob: string }> {
    return this.request('POST', `/orgs/${orgId}/deploy`, { deploy_id: deployId, project_id: projectId, inner_blob: innerBlob });
  }

  /**
   * Decrypt a deploy token (unauthenticated, for CI runtime).
   * Makes a raw fetch without the auth header.
   */
  async deployDecrypt(deployId: string, ciphertext: string): Promise<{ plaintext: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/deploy/${encodeURIComponent(deployId)}/decrypt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      throw new CapyError(
        `Cannot reach ${B('Capy')} service. Check your internet connection.`,
        ERROR_CODES.NETWORK_ERROR,
        { code: err.code || err.cause?.code },
      );
    }
    clearTimeout(timeout);

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as Record<string, any>;
      const msg = data.error || 'Deploy decrypt failed';
      if (res.status === 403) {
        throw new CapyError(msg, ERROR_CODES.PERMISSION_DENIED, { status: 403 });
      }
      if (res.status === 404) {
        throw new CapyError(msg, ERROR_CODES.SERVICE_ERROR, { status: 404 });
      }
      throw new CapyError(msg, ERROR_CODES.SERVICE_ERROR, { status: res.status, data });
    }

    return res.json() as Promise<{ plaintext: string }>;
  }

  /**
   * Fetch platform-specific deploy instructions (unauthenticated).
   */
  async fetchDeployInstructions(platform: string): Promise<{ platform: string; markdown: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/deploy/instructions/${encodeURIComponent(platform)}`, {
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return { platform, markdown: `Set SECRETS_BLOB and PROJECT_KEY as environment variables in your deployment platform.` };
    }
    clearTimeout(timeout);

    if (!res.ok) {
      return { platform, markdown: `Set SECRETS_BLOB and PROJECT_KEY as environment variables in your deployment platform.` };
    }

    return res.json() as Promise<{ platform: string; markdown: string }>;
  }

  async revokeDeployToken(deployId: string): Promise<void> {
    await this.request('DELETE', `/deploy/${encodeURIComponent(deployId)}`);
  }

  async listDeployTokens(orgId: string, projectId: string): Promise<{ tokens: Array<{ deploy_id: string; label: string | null; created_by: string; created_at: string; revoked_at: string | null }> }> {
    return this.request('GET', `/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/deploy-tokens`);
  }

  /**
   * Create-or-get the org's system store (CAP-664): a hidden `system`-kind
   * project, owner/admin only, idempotent. Every other read/write against it
   * goes through the normal `/secrets/:projectId` routes — this is the only
   * system-store-specific endpoint the client calls.
   */
  async getOrCreateSystemStore(orgId: string): Promise<{ project_id: string; branch: string }> {
    return this.request('POST', `/orgs/${orgId}/system-store`, {});
  }

  /**
   * `capy secrets` (CAP-673): every secret NAME across the org, grouped by
   * (name, value_hash), with every location and every user who can read it.
   * Read-only, never returns a value — see `SecretIndexResponse`'s own doc.
   */
  async getSecretIndex(orgId: string): Promise<SecretIndexResponse> {
    return this.request('GET', `/orgs/${orgId}/secrets`);
  }
}
