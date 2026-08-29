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
  // Wrapper endpoints (CAP-379 contract): 404/409 answers the onboarding
  // fork must branch on. FRESH_AUTH_REQUIRED and EMAIL_NOT_VERIFIED are NOT
  // here — they arrive on 403s and stay `details.code` on PERMISSION_DENIED,
  // the MEMBERSHIP_REVOKED convention.
  ERROR_CODES.WRAPPER_NOT_FOUND,
  ERROR_CODES.WRAPPER_CONFLICT,
  ERROR_CODES.WRAPPER_INVARIANT_VIOLATION,
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

/**
 * A project as it appears on a member's row — which is EVERY project in the
 * organization, annotated with what this member holds on it. `role` is absent
 * when the member has no grant: the project is merely visible to them, not
 * theirs. Listed is not granted, and code that conflates the two hands out
 * access nobody asked for.
 */
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

  private async request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number; _retried?: boolean }): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = this.tokenProvider ? await this.tokenProvider() : null;
    if (token) {
      headers['Authorization'] = `Bearer ${token.access_token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout ?? 30000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
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
    }
    clearTimeout(timeout);

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
          // `data` carried through so structured 403 contracts stay readable
          // downstream — e.g. FreshAuthRequiredError's `remediation` +
          // `max_token_age_seconds` fields (CAP-379). Additive only.
          { status: 403, detail, code: serverCode, data }
        );
      }

      if (res.status === 402 && data.code === 'QUOTA_EXCEEDED') {
        throw new CapyError(
          data.error || 'Account quota exceeded',
          ERROR_CODES.QUOTA_EXCEEDED,
          { status: 402, kind: data.kind, limit: data.limit, upgrade_url: data.upgrade_url }
        );
      }

      // Lock-less push CAS conflict: this write's `base_keep_hash` no longer
      // matches the branch's current server hash. `keep_hash`/`keep_file`
      // hoisted to top-level `details` (mirrors the 402 QUOTA_EXCEEDED shape
      // above) so callers rebase without re-parsing `details.data`.
      if (res.status === 409 && data.code === 'STALE_KEEP_HASH') {
        throw new CapyError(
          data.error || 'Keep changed on the server since this write was based on it.',
          ERROR_CODES.STALE_KEEP_HASH,
          { status: 409, keep_hash: data.keep_hash, keep_file: data.keep_file },
        );
      }

      // Master-key mint arbitration (`POST /orgs/:orgId/key-mint/claim`).
      // `expires_at` hoisted to top-level `details` (mirrors STALE_KEEP_HASH's
      // keep_hash/keep_file above) so callers read it without re-parsing
      // `details.data`.
      if (res.status === 409 && data.code === 'KEY_ALREADY_MINTED') {
        throw new CapyError(
          data.error || 'This organization\'s master key has already been minted.',
          ERROR_CODES.KEY_ALREADY_MINTED,
          { status: 409 },
        );
      }
      if (res.status === 409 && data.code === 'KEY_MINT_IN_PROGRESS') {
        throw new CapyError(
          data.error || 'Another device is currently minting this organization\'s master key.',
          ERROR_CODES.KEY_MINT_IN_PROGRESS,
          { status: 409, expires_at: data.expires_at },
        );
      }
      if (res.status === 409 && data.code === 'KEY_MINT_NOT_CLAIMED') {
        throw new CapyError(
          data.error || 'This device does not hold the mint lease for this organization.',
          ERROR_CODES.KEY_MINT_NOT_CLAIMED,
          { status: 409 },
        );
      }

      // `POST /orgs/personal/mint-ceremony` (CAP-542): this caller already
      // has an active membership somewhere — there is no fresh personal org
      // left to mint. Same convention as the key-mint 409s above.
      if (res.status === 409 && data.code === 'ALREADY_PROVISIONED') {
        throw new CapyError(
          data.error || 'You already belong to an organization.',
          ERROR_CODES.ALREADY_PROVISIONED,
          { status: 409 },
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
   *
   * `baseKeepHash` is the branch's keep_hash this write was based on — the
   * CAS precondition (single-user lock-less mode, also honored in lock-full
   * mode when the caller knows its base). Omitted entirely (not sent as
   * undefined/null) when the caller can't determine one, so an older server
   * that doesn't understand `base_keep_hash` sees exactly the request shape
   * it always has. A server that DOES understand it and finds the branch has
   * moved on responds 409 STALE_KEEP_HASH (see `request()`'s 409 handling).
   */
  async pushSecrets(
    projectId: string,
    keepFile: string,
    envBlob: string,
    branch: string,
    baseKeepHash?: string,
  ): Promise<{ keep_hash: string; keep_file?: string }> {
    return this.request('POST', `/secrets/${projectId}`, {
      keep_file: keepFile,
      env_blob: envBlob,
      branch,
      ...(baseKeepHash !== undefined ? { base_keep_hash: baseKeepHash } : {}),
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

  // --- v3 invite blob + pickup (docs/invite-pickup-flow.md §4, §6c, §7) ---
  //
  // Distinct from createInvite() above (the WorkOS membership invite,
  // `/orgs/:orgId/invite`, singular): these hit the new stored-blob routes
  // (`/orgs/:orgId/invites`, plural) that back the v3 short code. Both are
  // called by a v3 mint; neither replaces the other.

  /**
   * Uploads the outer-wrapped blob for a v3 invite (§4 step 1). `inviteId` is
   * `deriveInviteId(T)` — the server never sees T itself.
   */
  async uploadInviteBlob(
    orgId: string,
    body: { invite_id: string; email: string; blob: string; not_after: number },
  ): Promise<{ invite_id: string }> {
    return this.request('POST', `/orgs/${orgId}/invites`, body);
  }

  /**
   * Fetches the stored outer-wrapped blob for a v3 invite (§4 step 3 / §7.1).
   * CLI-scope gated server-side (§6.2) — a browser-kind token is refused.
   * `email` is the invite row's own bound address, which the caller MUST use
   * for `innerUnwrap` instead of the session's email (§7.3).
   */
  async fetchInviteBlob(
    orgId: string,
    inviteId: string,
  ): Promise<{ blob: string; email: string; not_after: string | null }> {
    return this.request('GET', `/orgs/${orgId}/invites/${encodeURIComponent(inviteId)}/blob`);
  }

  /**
   * The caller's own pending pickup row, if any (§4 step 1 of the first-use
   * flow / §7.2). `null` when there is nothing to consume — not an error.
   *
   * The server responds with `{ pickups: [...] }` (plural — a user can hold
   * more than one live pickup at once, e.g. invited to two orgs; see
   * `listPendingPickups` in service/src/invites/store.ts and its caller in
   * routes/invites.ts's `GET /invites/pending`). This CLI's first-attach
   * flow only consumes one pickup per invocation (`consumeInvitePickup`),
   * so it takes the first — a later `capy` invocation picks up the rest,
   * same steady-state loop as any other single pickup.
   */
  async getPendingInvitePickup(): Promise<PendingInvitePickup | null> {
    const data = await this.request<{ pickups: PendingInvitePickup[] }>('GET', '/invites/pending');
    return data.pickups?.[0] ?? null;
  }

  /**
   * Retires T and hard-deletes the blob server-side (§4 step 9). Idempotent
   * by contract on the server side; callers should still only call this once
   * consumption has actually completed.
   */
  async deleteInvitePickup(inviteId: string): Promise<void> {
    await this.request('DELETE', `/invites/${encodeURIComponent(inviteId)}/pickup`);
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

  /**
   * Claim the 15-minute first-mint lease on an auto-provisioned org's master
   * key (Owner only). This device's own re-claim extends the lease; an
   * expired foreign lease is taken over. 409s (`KEY_ALREADY_MINTED`,
   * `KEY_MINT_IN_PROGRESS`) and 403/404 arrive as typed `CapyError`s via
   * `request()`'s classification above — never parsed from prose here.
   */
  async claimKeyMint(orgId: string): Promise<{ key_state: 'minting'; expires_at: string }> {
    return this.request('POST', `/orgs/${orgId}/key-mint/claim`);
  }

  /**
   * Mark an org's master key minted, once this device has claimed the lease,
   * generated M, and saved key.enc locally. Idempotent: a second call after
   * the org is already `minted` answers `{ already: true }` rather than
   * `KEY_MINT_NOT_CLAIMED` — the caller (this device, the one that just
   * minted) already holds the key either way.
   */
  async finalizeKeyMint(orgId: string): Promise<{ key_state: 'minted' } | { already: true }> {
    return this.request('POST', `/orgs/${orgId}/key-mint/finalize`);
  }

  /**
   * CAP-542: mint-ceremony for a fresh personal org — the sandbox-session
   * ceremony's `first_run.kind:'create_org'` source. Creates the org AND
   * claims THIS caller's own key-mint lease in one call: unlike
   * `claimKeyMint`, there is no separate claim step on this path — the org
   * is born `key_state:'minting'` with the lease already held by the
   * caller. `name` is a BASE name only; a collision is resolved
   * server-side with a numeric suffix, never retried client-side (see
   * `orgCreation.ts`'s `createOrganizationFromEnvelope` for why the old
   * CLI-side suffix-retry loop is gone). 409 `ALREADY_PROVISIONED` (this
   * caller already holds an active membership) arrives as a typed
   * `CapyError` via `request()`'s classification above.
   */
  async mintPersonalOrgCeremony(name?: string): Promise<{
    org_id: string;
    project_id: string;
    mint_claim: { key_state: 'minting'; expires_at: string };
    organization: { id: string; workos_org_id: string; name: string };
  }> {
    return this.request('POST', '/orgs/personal/mint-ceremony', name !== undefined ? { name } : undefined);
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

  /**
   * `credentialGeneration` records which shape (CAP-411) this token was
   * minted as, so `capy deploy list` can flag legacy (raw-project-key)
   * tokens. Always `'dt'` from this build — there is no code path that
   * mints a legacy token on purpose; the service defaults an absent value to
   * `'legacy'`, which is what an un-upgraded CLI binary would mint anyway.
   */
  async createDeployToken(
    orgId: string,
    deployId: string,
    projectId: string,
    innerBlob: string,
    credentialGeneration: 'dt' | 'legacy' = 'dt',
  ): Promise<{ outer_blob: string }> {
    return this.request('POST', `/orgs/${orgId}/deploy`, {
      deploy_id: deployId,
      project_id: projectId,
      inner_blob: innerBlob,
      credential_generation: credentialGeneration,
    });
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
      return { platform, markdown: `Set _CAPY_SECRETS_BLOB and _CAPY_DEPLOY_KEY as environment variables in your deployment platform.` };
    }
    clearTimeout(timeout);

    if (!res.ok) {
      return { platform, markdown: `Set _CAPY_SECRETS_BLOB and _CAPY_DEPLOY_KEY as environment variables in your deployment platform.` };
    }

    return res.json() as Promise<{ platform: string; markdown: string }>;
  }

  async revokeDeployToken(deployId: string): Promise<void> {
    await this.request('DELETE', `/deploy/${encodeURIComponent(deployId)}`);
  }

  async listDeployTokens(orgId: string, projectId: string): Promise<{ tokens: Array<{ deploy_id: string; label: string | null; created_by: string; created_at: string; revoked_at: string | null; credential_generation?: string }> }> {
    return this.request('GET', `/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/deploy-tokens`);
  }

  // --- Key wrappers (CAP-379 contract, consumed by CAP-380 onboarding) ---
  //
  // Shapes mirror service openapi.yaml. Doors (wrapped_k_local) are org-less
  // and per credential; key_enc rows are per user×org with the org taken
  // from the JWT — so key_enc upload/fetch MUST run under a token scoped to
  // that org. Fetching EITHER wrapper type's full payload (GET
  // /wrappers/:id) is fresh-auth gated — door reads were folded into the
  // same gate as key_enc (audit-browser-direct-api.md, "Audit fixes ...
  // Finding 2"). The 403 FRESH_AUTH_REQUIRED retry dance lives in
  // src/auth/deviceKey/serviceOps.ts, not here — this client stays one
  // call per method.

  /** Upload a door (wrapped_k_local) blob. 409 WRAPPER_CONFLICT if the credential already has a live row. */
  async uploadDoorWrapper(body: {
    wrapped_k_local: string;
    iv: string;
    prf_salt: string;
    credential_id: string;
    kdf_version: number;
  }): Promise<KeyWrapperMetadata> {
    const data = await this.request<{ wrapper: KeyWrapperMetadata }>(
      'POST', '/wrappers',
      { type: 'wrapped_k_local', ...body },
    );
    return data.wrapper;
  }

  /** Upload this org's key.enc blob unchanged (already KMS+AES self-armored). Org comes from the JWT. */
  async uploadKeyEncWrapper(keyEnc: string, kdfVersion?: number): Promise<KeyWrapperMetadata> {
    const data = await this.request<{ wrapper: KeyWrapperMetadata }>(
      'POST', '/wrappers',
      { type: 'key_enc', key_enc: keyEnc, ...(kdfVersion !== undefined ? { kdf_version: kdfVersion } : {}) },
    );
    return data.wrapper;
  }

  /** The caller's wrapper inventory — metadata only, never ciphertext. */
  async listWrappers(includeDeleted = false): Promise<KeyWrapperMetadata[]> {
    const data = await this.request<{ wrappers: KeyWrapperMetadata[] }>(
      'GET', `/wrappers${includeDeleted ? '?include_deleted=true' : ''}`,
    );
    return data.wrappers;
  }

  /** One wrapper with its ciphertext payload. Both wrapper types are fresh-auth gated server-side. */
  async fetchWrapper(wrapperId: string): Promise<KeyWrapperPayload> {
    const data = await this.request<{ wrapper: KeyWrapperPayload }>(
      'GET', `/wrappers/${encodeURIComponent(wrapperId)}`,
    );
    return data.wrapper;
  }

  /** Record enrollment-ceremony completion for a door. Idempotent; fresh-auth gated. */
  async verifyWrapper(wrapperId: string): Promise<KeyWrapperMetadata> {
    const data = await this.request<{ wrapper: KeyWrapperMetadata }>(
      'POST', `/wrappers/${encodeURIComponent(wrapperId)}/verify`,
    );
    return data.wrapper;
  }

  /** Soft-delete a wrapper. 409 WRAPPER_INVARIANT_VIOLATION when it would strand the account. */
  async deleteWrapper(wrapperId: string): Promise<KeyWrapperMetadata> {
    const data = await this.request<{ wrapper: KeyWrapperMetadata }>(
      'DELETE', `/wrappers/${encodeURIComponent(wrapperId)}`,
    );
    return data.wrapper;
  }

  /**
   * The caller's doors inventory (CAP-378): "everything that can act as
   * this user" — device keys, org key copies, and WorkOS sessions, plus the
   * honest gaps (transport codes are never persisted; sessions may be
   * unavailable if the WorkOS lookup itself failed). Never includes
   * ciphertext or key material. Mounted behind the same org-scoped auth
   * middleware as /wrappers.
   *
   * Final-gate BLOCKER-2: `/doors` shipped on a service branch that isn't
   * guaranteed to be in every deployed service's merge train yet. A 404 here
   * means "this route doesn't exist" (the inventory itself answers "zero
   * doors" with a 200 + empty array, never a 404) — a capability gap the CLI
   * can degrade out of, not a generic request failure. Reclassified to a
   * dedicated code so `capy doors` can say so plainly instead of surfacing
   * an unhandled/generic error. Branches on `details.status`, never on
   * response text (cardinal Rule 4).
   */
  async listDoors(): Promise<DoorsInventory> {
    try {
      return await this.request<DoorsInventory>('GET', '/doors');
    } catch (err) {
      if (err instanceof CapyError && err.details?.status === 404) {
        throw new CapyError(
          'This Capy service does not support device-key doors yet (no /doors route).',
          ERROR_CODES.DOORS_NOT_SUPPORTED,
          { status: 404 },
        );
      }
      throw err;
    }
  }

  /**
   * `capy flow cancel <id>` — abandon a flow instance and release whatever
   * repo lock it holds. Authorized server-side either by the normal
   * secret/bound-identity gate every other flow verb uses, or (the reason
   * this command exists) by ORG OWNERSHIP of whatever the flow pinned so
   * far — the escape hatch for a ceremony stranded on a machine that has no
   * identity of its own to authorize a cancel with. See
   * service/src/routes/flows.ts's `/:id/cancel` doc comment.
   *
   * The server answers 404 for both "no such flow" and "not yours to
   * cancel" — deliberately: telling them apart would let an unauthorized
   * caller probe for a flow's existence. `request()` already turns that into
   * a CapyError coded PROJECT_NOT_FOUND (the flows route reuses that server
   * code verbatim for this 404); reclassified here to FLOW_NOT_FOUND so a
   * caller of THIS method never has to know it shares a wire code with an
   * unrelated project lookup (same reclassification shape as listDoors()
   * above, from PROJECT_NOT_FOUND rather than a bare 404).
   */
  async cancelFlow(flowId: string): Promise<{ flow_id: string; state: string }> {
    try {
      return await this.request<{ flow_id: string; state: string }>(
        'POST',
        `/flows/${encodeURIComponent(flowId)}/cancel`,
      );
    } catch (err) {
      if (err instanceof CapyError && err.code === ERROR_CODES.PROJECT_NOT_FOUND) {
        throw new CapyError(
          `Flow ${flowId} does not exist, or is not yours to cancel.`,
          ERROR_CODES.FLOW_NOT_FOUND,
          { status: 404, flowId },
        );
      }
      throw err;
    }
  }

  /**
   * `GET /flows/mine` — this caller's own OPEN flow instances, found by
   * identity alone (no flow id, no `X-Flow-Secret`). Used by `capy flow run`
   * (flowRunCommand.ts) to find a hosted-minted `checkout` instance to
   * attach to and drive, without the caller ever having been handed the
   * instance's id directly.
   *
   * `step` on each row is the SANITIZED projection the service renders for a
   * second renderer (see `sanitizeStepForMine` in service/src/routes/flows.ts)
   * — display-only, with high-entropy fields (`plan_hash`) stripped. It is
   * NEVER passed to `validateStep`: the full, validatable envelope for an
   * instance comes only from `getFlowStep`/`reportFlowObservations` below.
   */
  async listMyFlows(): Promise<FlowSummary[]> {
    const data = await this.request<{ flows: FlowSummary[] }>('GET', '/flows/mine');
    return data.flows;
  }

  /**
   * `GET /flows/:id/next` — re-read the step this instance is currently on,
   * without reporting observations or advancing anything. Deliberately
   * allowed to be stale (`derived_at` says how): this is a peek, not a
   * report. `step` here IS the full envelope — validate it with
   * `validateStep` before acting on it, same as the response from
   * `reportFlowObservations`.
   */
  async getFlowStep(flowId: string): Promise<{ step: unknown; derived_at: string | null; state: string }> {
    return this.request('GET', `/flows/${encodeURIComponent(flowId)}/next`);
  }

  /**
   * `POST /flows/:id/next` — report this run's freshly re-observed
   * predicates (and, when the previous step was a local_action, its
   * outcome) and get back the next full step envelope. The one call
   * `capy flow run`'s drive loop repeats until it reaches a stop step.
   */
  async reportFlowObservations(flowId: string, body: FlowNextReportBody): Promise<{ step: unknown }> {
    return this.request('POST', `/flows/${encodeURIComponent(flowId)}/next`, body);
  }
}

/** One row of `GET /flows/mine` — see `listMyFlows`'s doc for what `step` is (and is not). */
export interface FlowSummary {
  flow_id: string;
  flow_type: string;
  contract_version: string;
  repo_key: string;
  status: string;
  step: Record<string, unknown> | null;
}

/** Body for `POST /flows/:id/next`, shaped for `checkout`'s own (smaller) report schema. */
export interface FlowNextReportBody {
  contract_version: string;
  observations: Record<string, boolean>;
  last_step?: {
    step_id: string;
    outcome: 'ok' | 'failed';
    code?: string;
  };
}

/**
 * A caller's own pending pickup row (§7.2 of docs/invite-pickup-flow.md), as
 * returned by one entry of `GET /invites/pending`'s `pickups` array.
 * `organization_id` is not a column on `invite_pickups` itself, but the
 * endpoint resolves and returns it (joined from `invite_blobs`) — the CLI
 * needs an org id to call the org-scoped blob-fetch and co-decrypt routes
 * downstream. Fields mirror exactly what `routes/invites.ts`'s
 * `GET /invites/pending` maps per row — no `id`/`user_id`/`created_at`/
 * `expires_at` (those are DB-internal to `invite_pickups` and never
 * serialized), and `email` IS present but unused here — `fetchInviteBlob`'s
 * own response is the one `email` value `innerUnwrap` may use (§7.3).
 */
export interface PendingInvitePickup {
  invite_id: string;
  organization_id: string;
  email: string;
  /** base64(ciphertext||tag) — T wrapped under KEK_pickup. */
  wrapped_t: string;
  /** base64, 12 bytes. */
  iv: string;
  /** base64. */
  prf_salt: string;
  credential_id: string;
  kdf_version: number;
}

/** Wrapper row metadata (service KeyWrapperMetadata schema) — never carries ciphertext. */
export interface KeyWrapperMetadata {
  id: string;
  type: 'wrapped_k_local' | 'key_enc';
  /** WebAuthn credential id (doors only). */
  credential_id?: string | null;
  kdf_version: number;
  /** Server-assigned: the user's first live door anchors the ≥1-wrapper invariant until a door is verified. */
  is_seed: boolean;
  verified_at?: string | null;
  /** Set for key_enc rows (per user×org); null for doors. */
  organization_id?: string | null;
  created_at: string;
  deleted_at?: string | null;
  mirror_state: 'pending' | 'mirrored' | 'diverged';
}

/** Full wrapper fetch: metadata plus the type's ciphertext fields. */
export interface KeyWrapperPayload extends KeyWrapperMetadata {
  wrapped_k_local?: string;
  iv?: string;
  prf_salt?: string;
  key_enc?: string;
}

/**
 * One row in a user's doors inventory (service `Door` schema, CAP-378).
 * Fields present depend on `door_type` — device_key and org_key are
 * key_wrappers rows (same underlying data as KeyWrapperMetadata, reshaped);
 * session is a WorkOS AuthKit session, the only server-observable "signed in
 * as me" signal this service has (no local sessions table exists).
 */
export type DoorType = 'device_key' | 'org_key' | 'session' | 'transport_code';

export interface Door {
  door_type: DoorType;
  /** Opaque within its door_type's id space (UUID for wrapper-backed doors, a WorkOS session id for sessions). */
  id: string;
  /** device_key only. No label column exists in the schema yet — always null today. */
  label?: string | null;
  /** device_key only — the WebAuthn credential id. */
  credential_id?: string | null;
  /** org_key and session — null for device_key (user-global). */
  organization_id?: string | null;
  /** device_key and org_key only. */
  kdf_version?: number;
  /** device_key only. True on the account's first-ever enrolled door. */
  is_seed?: boolean;
  /** device_key and org_key only. */
  verified_at?: string | null;
  /** session only. */
  ip_address?: string | null;
  /** session only. */
  user_agent?: string | null;
  /** session only — WorkOS AuthMethod (oauth, password, sso, ...). */
  auth_method?: string;
  /** session only. */
  status?: 'active' | 'expired' | 'revoked';
  created_at: string;
  /** session only. */
  updated_at?: string;
  /** session only. */
  expires_at?: string;
  /** session only. */
  ended_at?: string | null;
  revocable: boolean;
}

/**
 * Why the sessions section of a DoorsInventory may be empty even though the
 * user genuinely has sessions: null means the WorkOS lookup ran (even if it
 * returned zero rows); non-null means it could not run or failed, which is a
 * different fact from "this user has zero sessions."
 */
export type SessionsUnavailableReason = 'WORKOS_NOT_CONFIGURED' | 'WORKOS_LOOKUP_FAILED';

export interface UnavailableDoorType {
  door_type: 'transport_code';
  reason: 'NOT_PERSISTED';
}

export interface DoorsInventory {
  doors: Door[];
  /** True while a live device_key door with is_seed=true exists. */
  has_seed_wrapper: boolean;
  sessions_unavailable_reason: SessionsUnavailableReason | null;
  /** Door types this endpoint can never populate — always contains exactly transport_code today. */
  unavailable_door_types: UnavailableDoorType[];
}
