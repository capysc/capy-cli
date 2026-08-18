import { ServiceToken, SessionStore, SilentAuthFailureCode } from '../../types/index';
import { debug } from '../../ui/debug';
import { SessionStorageBackend } from './backend';
import { HttpStatusError, postJson } from './http';

/**
 * Why the last token refresh failed. Callers use this to pick the right
 * recovery: `session_ended` → re-authenticate (browser), `network` → retry
 * later (a browser round-trip can't fix an offline machine, so don't fall
 * through to OAuth), `org_not_found` / `server_error` → surface the detail.
 */
// Derived from SilentAuthFailureCode rather than restated, so the two can
// never drift: every refresh failure is reportable to a caller, and the only
// silent-auth failure that is NOT a refresh failure is `no_session`.
export type RefreshFailureReason = Exclude<SilentAuthFailureCode, 'no_session'>;

export interface RefreshFailure {
  reason: RefreshFailureReason;
  status?: number;
  /** Server `error` body or transport error message. Never contains tokens. */
  detail?: string;
}

export function classifyRefreshFailure(error: any): RefreshFailure {
  if (error instanceof HttpStatusError) {
    if (error.status === 401) {
      // WorkOS rejected the refresh token — the backing session has ended
      // (inactivity timeout, max duration, sign-out, or revocation).
      return { reason: 'session_ended', status: error.status, detail: error.message };
    }
    if (error.status === 404) {
      return { reason: 'org_not_found', status: error.status, detail: error.message };
    }
    return { reason: 'server_error', status: error.status, detail: error.message };
  }
  return { reason: 'network', detail: error?.message };
}

/**
 * Resolve the effective `expires_at` for a newly-issued access token. Normal
 * production: `Date.now() + expires_in * 1000` from WorkOS (~10 min).
 *
 * Test-only override: setting `CAPY_TOKEN_TTL_SECONDS=5` clamps every
 * local `expires_at` to 5 seconds from now. This forces `getValidToken()`
 * to exercise the refresh path on nearly every request, catching
 * regressions in the refresh logic that wouldn't surface in a single
 * short-running test run. The override does NOT shorten the WorkOS token
 * itself — it lies to our code about when the cached copy is stale, which
 * is exactly the decision we want to exercise.
 */
export function resolveExpiresAt(expiresInSeconds: number): number {
  const override = process.env.CAPY_TOKEN_TTL_SECONDS;
  const ttl = override ? Number(override) : expiresInSeconds;
  return Date.now() + ttl * 1000;
}

/**
 * The one place a JWT payload gets decoded. Throws on anything that is not a
 * decodable JWT — every call site keeps its own try/catch so each preserves
 * its historical failure semantics (skip, reject, or discard).
 */
export function decodeJwtPayload(accessToken: string): any {
  return JSON.parse(
    Buffer.from(accessToken.split('.')[1], 'base64').toString()
  );
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: { id: string; email: string; first_name: string | null; last_name: string | null };
  organization?: { id: string; workos_org_id: string; name: string };
}

/**
 * Session lifecycle — refresh, expiry, org resolution, validation — extracted
 * from AuthService (CAP-377 phase 1) so the same logic can run against any
 * `SessionStorageBackend`. AuthService owns the interactive flows (OAuth,
 * password auth, org creation) and delegates everything session-shaped here;
 * its observable behavior is unchanged.
 *
 * State is deliberately public: AuthService exposes `session`/`currentOrgId`
 * accessors over these fields so the pre-extraction internals remain
 * observable exactly where they always were.
 *
 * BRIGHT LINE: auth material only. No path in this module reads or writes
 * key material (local.key, key.enc, project keys) — see backend.ts.
 */
interface OrglessRefreshResponse {
  access_token: string;
  refresh_token: string;
  scope?: string;
}

export class SessionLifecycle {
  session: SessionStore | null = null;
  sessionUserId: string | undefined;
  currentOrgId: string | null = null;
  lastRefreshFailure: RefreshFailure | null = null;
  /**
   * CAP-451 §7.1.1: the org-less (`scope:"user"`) bearer minted by
   * `refreshOrgless`. Held in memory only, exactly like the exchange-time
   * `_orgless_access_token` it mirrors — never written to SessionStore.
   * Overwritten by each successful org-less refresh; stale otherwise.
   */
  orglessAccessToken: string | null = null;

  constructor(
    private readonly storage: SessionStorageBackend,
    private readonly serviceApiUrl: string,
    sessionUserId?: string,
  ) {
    this.sessionUserId = sessionUserId;
  }

  load(): void {
    try {
      const data = this.storage.load(this.sessionUserId);
      if (data && data.version === 2) {
        // Prune sessions for orgs not in the organizations list (stale/deleted).
        // Keep all sessions for known orgs — multi-org users need tokens for each.
        const knownOrgIds = new Set(data.organizations.map(o => o.id));
        for (const key of Object.keys(data.sessions)) {
          if (!knownOrgIds.has(key)) {
            delete data.sessions[key];
          }
        }
        this.session = data;
        return;
      }
    } catch {
      // Invalid session data, ignore
    }

    // No session found at the expected scope. If we don't know the userId,
    // ask the backend to discover one (file backend: scan auth/sessions/).
    if (!this.sessionUserId) {
      try {
        const found = this.storage.discover();
        if (found) {
          this.session = found.session;
          this.sessionUserId = found.userId;
        }
      } catch {
        // Discovery unavailable — stay signed out
      }
    }
  }

  save(): void {
    if (!this.session) return;
    try {
      // Save to user-scoped path once we know the user ID
      const userId = this.sessionUserId || this.session.user_id;
      this.storage.save(this.session, userId);
    } catch {
      // Failed to save session
    }
  }

  clear(): void {
    const userId = this.sessionUserId || this.session?.user_id;
    this.session = null;
    this.currentOrgId = null;
    try {
      this.storage.clear(userId);
    } catch {
      // Ignore
    }
  }

  /**
   * The shared non-interactive path: use a cached org token if it is
   * unexpired and org-valid, otherwise refresh. Returns how the token was
   * obtained, or null when neither worked — the caller decides what comes
   * next (interactive OAuth for `authenticate`, a typed failure for
   * `authenticateSilent`).
   */
  async acquireSilent(organizationId?: string): Promise<'cached' | 'refreshed' | 'refreshed_orgless' | null> {
    // If we have a session and a specific org is requested, try to use/refresh it
    if (this.session && organizationId) {
      const orgSession = this.session.sessions[organizationId];
      if (orgSession && orgSession.expires_at > Date.now() && this.validateTokenOrg(organizationId, orgSession.access_token)) {
        this.currentOrgId = organizationId;
        return 'cached';
      }
      // Token missing, expired, or org mismatch — refresh into the correct org
      if (this.session.refresh_token) {
        const refreshed = await this.refreshForOrg(organizationId);
        if (refreshed) {
          return 'refreshed';
        }
      }
    }

    // If we have a session with no specific org requested, use any valid session
    if (this.session && !organizationId) {
      for (const [orgId, orgSession] of Object.entries(this.session.sessions)) {
        if (orgSession.expires_at > Date.now() && this.validateTokenOrg(orgId, orgSession.access_token)) {
          this.currentOrgId = orgId;
          return 'cached';
        }
      }
      // Try refreshing the first known org
      if (this.session.refresh_token && this.session.organizations.length > 0) {
        const firstOrg = this.session.organizations[0];
        const refreshed = await this.refreshForOrg(firstOrg.id);
        if (refreshed) {
          return 'refreshed';
        }
      }
    }

    // CAP-451 §7.1.1: a session with a refresh token but ZERO known
    // organizations — a brand-new identity, or the org-less mint from a
    // sandbox broker ceremony. Neither branch above applies: the first
    // needs an org id to scope into, the second needs `organizations.length
    // > 0`. Without this branch `acquireSilent` returns null here and
    // `authenticate` escalates to loopback OAuth, which is exactly the
    // unreachable-from-a-phone failure this closes — the org-less bearer
    // this mints is held in memory only (never persisted) and is what lets
    // the SECOND `capy onboard` process present a bearer to `POST /next` so
    // the instance can rebind (executors/index.ts's `authenticate` already
    // reads `_orgless_access_token` for this).
    if (this.session?.refresh_token && this.session.organizations.length === 0 && !organizationId) {
      const refreshed = await this.refreshOrgless();
      if (refreshed) {
        return 'refreshed_orgless';
      }
    }

    return null;
  }

  /**
   * Refresh with no `organization_id` — the service answers with an
   * org-less (`scope:"user"`) bearer, or 400 `code:ORG_ID_REQUIRED` if the
   * user has since gained an organization (someone else redeemed an invite
   * for them, or a concurrent process created one). The latter is not a
   * failure of this call — it means the org-less branch no longer applies —
   * so it returns false and lets the caller fall through to null exactly as
   * it did before this method existed; no `lastRefreshFailure` is set for
   * it (a caller reading `describeSilentAuthFailure` after this sees
   * `no_session`, not a spurious server error).
   *
   * The rotated refresh token is persisted exactly as `refreshForOrg` does —
   * through `withRefreshLock`, so a concurrent refresh cannot burn the same
   * single-use token twice.
   */
  async refreshOrgless(): Promise<boolean> {
    if (!this.session?.refresh_token) return false;
    this.lastRefreshFailure = null;

    const userId = this.sessionUserId || this.session.user_id;

    try {
      return await this.storage.withRefreshLock(userId, async (freshSession) => {
        if (freshSession?.version === 2) {
          // An org appeared on the persisted copy since this in-memory
          // session was loaded — the org-less branch no longer applies.
          // Adopt the fresher session and let the caller re-derive.
          if (freshSession.organizations.length > 0) {
            this.session = freshSession;
            return false;
          }
          this.session!.refresh_token = freshSession.refresh_token;
        }

        const data = await postJson<OrglessRefreshResponse>(
          `${this.serviceApiUrl}/auth/refresh`,
          { refresh_token: this.session!.refresh_token },
        );

        this.session!.refresh_token = data.refresh_token;
        this.orglessAccessToken = data.access_token;
        this.save();
        return true;
      });
    } catch (error: any) {
      if (
        error instanceof HttpStatusError &&
        error.status === 400 &&
        error.body?.code === 'ORG_ID_REQUIRED'
      ) {
        // The user gained an org between session load and this call — not a
        // refresh failure, just means this branch no longer applies.
        return false;
      }
      const failure = classifyRefreshFailure(error);
      this.lastRefreshFailure = failure;
      debug(
        `[auth] org-less refresh failed (${failure.reason}` +
        `${failure.status ? `, HTTP ${failure.status}` : ''}): ${failure.detail || 'no detail'}`
      );
      return false;
    }
  }

  /**
   * Distinct, actionable failure for a silent auth. Before this, an ended
   * session, a network outage, and a genuinely missing session were all
   * reported as "No valid session available".
   *
   * Returns the code as well as the sentence: a caller that only gets the
   * sentence has to either print one generic remedy for every cause or parse
   * prose to tell them apart, and both of those have bitten us.
   */
  describeSilentAuthFailure(): { code: SilentAuthFailureCode; message: string } {
    switch (this.lastRefreshFailure?.reason) {
      case 'session_ended':
        return { code: 'session_ended', message: 'Session expired — sign-in required' };
      case 'network':
        return { code: 'network', message: 'Could not reach the Capy service to refresh your session' };
      case 'org_not_found':
        return { code: 'org_not_found', message: 'Organization not found while refreshing your session' };
      case 'server_error':
        return {
          code: 'server_error',
          message: `Token refresh failed (HTTP ${this.lastRefreshFailure.status})`,
        };
      default:
        return { code: 'no_session', message: 'No valid session available' };
    }
  }

  async refreshForOrg(orgId: string): Promise<boolean> {
    if (!this.session?.refresh_token) return false;
    this.lastRefreshFailure = null;

    const userId = this.sessionUserId || this.session.user_id;

    try {
      return await this.storage.withRefreshLock(userId, async (freshSession) => {
        if (freshSession?.version === 2) {
          // Check if another process already refreshed this org
          const existing = freshSession.sessions[orgId];
          if (existing && existing.expires_at > Date.now()) {
            this.session = freshSession;
            this.currentOrgId = orgId;
            return true;
          }
          // Use the latest refresh token
          this.session!.refresh_token = freshSession.refresh_token;
        }

        const data = await postJson<RefreshResponse>(
          `${this.serviceApiUrl}/auth/refresh`,
          {
            refresh_token: this.session!.refresh_token,
            organization_id: orgId,
          },
        );

        // Resolve the actual org from the JWT — the caller may have passed a
        // stale internal org ID but the token is scoped to the canonical one.
        let resolvedOrgId = orgId;
        try {
          const payload = decodeJwtPayload(data.access_token);
          if (payload.org_id) {
            const match = this.session!.organizations.find(o => o.workos_org_id === payload.org_id);
            if (match) resolvedOrgId = match.id;
          }
        } catch {
          // JWT decode failed — use the orgId as-is
        }

        // Add/update the session for this org. Other org sessions are preserved —
        // the KMS co-decrypt endpoint is the security gate per-org, not the client.
        this.session!.sessions[resolvedOrgId] = {
          access_token: data.access_token,
          expires_at: resolveExpiresAt(data.expires_in),
        };
        this.session!.refresh_token = data.refresh_token;

        // If this org isn't in the organizations list yet (e.g. user was just
        // invited and we refreshed into the new org), add it from the response.
        if (!this.session!.organizations.some(o => o.id === resolvedOrgId) && data.organization) {
          this.session!.organizations.push({
            id: data.organization.id,
            workos_org_id: data.organization.workos_org_id,
            name: data.organization.name,
          });
        }

        if (data.user) {
          this.session!.user_id = data.user.id;
          this.session!.user_email = data.user.email;
          this.session!.user_first_name = data.user.first_name;
          this.session!.user_last_name = data.user.last_name;
        }

        this.currentOrgId = resolvedOrgId;
        this.save();
        return true;
      });
    } catch (error: any) {
      const failure = classifyRefreshFailure(error);
      this.lastRefreshFailure = failure;
      debug(
        `[auth] token refresh failed for org ${orgId} (${failure.reason}` +
        `${failure.status ? `, HTTP ${failure.status}` : ''}): ${failure.detail || 'no detail'}`
      );
      return false;
    }
  }

  getToken(): ServiceToken | null {
    if (!this.session || !this.currentOrgId) return null;
    const orgSession = this.session.sessions[this.currentOrgId];
    if (!orgSession) return null;

    // Validate that the access token's org claim matches the org we think
    // we're in. A mismatch means stale client state — the token grants
    // access to a different org than intended.
    const org = this.session.organizations.find(o => o.id === this.currentOrgId);
    if (org) {
      try {
        const payload = decodeJwtPayload(orgSession.access_token);
        if (payload.org_id && payload.org_id !== org.workos_org_id) {
          // Token is for a different org — discard it.
          delete this.session.sessions[this.currentOrgId];
          this.save();
          return null;
        }
      } catch {
        // Can't decode token — treat as invalid
        delete this.session.sessions[this.currentOrgId];
        this.save();
        return null;
      }
    }

    return {
      access_token: orgSession.access_token,
      refresh_token: this.session.refresh_token,
      expires_at: orgSession.expires_at,
      organization_id: this.currentOrgId,
      user_id: this.session.user_id,
      user_email: this.session.user_email,
      user_first_name: this.session.user_first_name,
      user_last_name: this.session.user_last_name,
      organizations: this.session.organizations,
    };
  }

  /**
   * Return a token that's guaranteed to be unexpired by our local clock.
   * If the cached access_token has passed `expires_at`, refresh via
   * `refreshForOrg` before returning. Used by ServiceClient on every
   * request so no stale cached token can escape the auth boundary.
   *
   * Returns null if there's no session, no current org, or refresh failed.
   * Callers typically surface that as "you need to re-authenticate".
   */
  async getValidToken(): Promise<ServiceToken | null> {
    if (!this.session || !this.currentOrgId) return null;
    const orgSession = this.session.sessions[this.currentOrgId];
    if (!orgSession) return null;

    if (orgSession.expires_at <= Date.now()) {
      const refreshed = await this.refreshForOrg(this.currentOrgId);
      if (!refreshed) return null;
    }

    // getToken() re-validates the org_id claim and discards mismatches.
    return this.getToken();
  }

  /**
   * Validate that an access token's org_id claim matches the expected org.
   * Returns false if the token is for a different org (stale session).
   */
  validateTokenOrg(orgId: string, accessToken: string): boolean {
    const org = this.session?.organizations.find(o => o.id === orgId);
    if (!org) return false;
    try {
      const payload = decodeJwtPayload(accessToken);
      if (payload.org_id && payload.org_id !== org.workos_org_id) {
        // Token is scoped to a different org — stale.
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
