import { AuthResult, Organization, ServiceToken, SessionStore, CapyError, ERROR_CODES } from '../types/index';
import { OAuthServer } from './oauthServer';
import { consumeForceLoginMarker } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { debug } from '../ui/debug';
import { SessionStorageBackend } from './session/backend';
import { FileSessionStorageBackend } from './session/fileBackend';
import { HttpStatusError, postJson } from './session/http';
import { SessionLifecycle, resolveExpiresAt, RefreshFailure } from './session/lifecycle';

// Session mechanics live in src/auth/session/ (CAP-377 phase 1). The names
// below have always been importable from this module — keep them so, with the
// same identities (`instanceof HttpStatusError` still works everywhere).
export { HttpStatusError };
export type { RefreshFailure, RefreshFailureReason } from './session/lifecycle';
export type { SessionStorageBackend } from './session/backend';

/**
 * The sentence to show a user whose silent auth failed, remedy included.
 *
 * Every caller used to print a bare "not authenticated. Run `capy` to sign
 * in." for all five causes. That is wrong advice for two of them: a browser
 * round-trip cannot fix an offline machine or a 5xx from the service, and
 * following it just replaces a clear failure with a hung sign-in. The remedy
 * is chosen from `error_code`, never from the message text.
 */
export function silentAuthFailureMessage(result: AuthResult): string {
  const cause = result.error || 'Not authenticated';
  switch (result.error_code) {
    case 'network':
    case 'server_error':
      return `${cause}. Check your connection and try again.`;
    default:
      return `${cause}. Run \`capy\` to sign in.`;
  }
}

export class AuthService {
  private serviceApiUrl: string;
  private devMode: boolean;
  private readonly lifecycle: SessionLifecycle;

  constructor(
    serviceApiUrl?: string,
    devMode: boolean = false,
    sessionUserId?: string,
    storage?: SessionStorageBackend,
  ) {
    this.devMode = devMode;
    // Honor CAPY_API_URL / active profile in BOTH modes (same resolution as
    // ServiceClient). Previously prod mode hardcoded api.capy.sc, so auth
    // ignored CAPY_API_URL — capy-staging and byoc would authenticate against
    // prod (returning prod orgs) even though every other call hit the override.
    this.serviceApiUrl = serviceApiUrl || resolveActiveUrl(devMode);
    if (devMode) {
      // Suppress the dev diagnostic in local-only mode — no identity provider
      // is used there, so the server URL is irrelevant and misleading.
      const { isLocalOnly } = require('../config/profileConfig') as typeof import('../config/profileConfig');
      if (!isLocalOnly()) debug(`[dev] AuthService → ${this.serviceApiUrl}`);
    }
    // Session lifecycle is delegated; the ~/.capy file backend is the default
    // and an injected backend (Phase 2: MCP-supplied credentials) replaces it
    // without this class knowing the difference.
    this.lifecycle = new SessionLifecycle(
      storage ?? new FileSessionStorageBackend(),
      this.serviceApiUrl,
      sessionUserId,
    );
    this.lifecycle.load();
  }

  // Session state is owned by the lifecycle module; these accessors keep the
  // fields observable exactly where they have always been (tests and this
  // class's own flows read/write `session` and `currentOrgId` directly).
  private get session(): SessionStore | null {
    return this.lifecycle.session;
  }
  private set session(value: SessionStore | null) {
    this.lifecycle.session = value;
  }
  private get currentOrgId(): string | null {
    return this.lifecycle.currentOrgId;
  }
  private set currentOrgId(value: string | null) {
    this.lifecycle.currentOrgId = value;
  }

  setSessionUserId(userId: string): void {
    if (this.lifecycle.sessionUserId === userId) return;
    this.lifecycle.sessionUserId = userId;
    this.lifecycle.load(); // Reload from the user-scoped store
  }

  async authenticate(organizationId?: string): Promise<AuthResult> {
    try {
      // Cached or refreshed token first — same path authenticateSilent uses
      const method = await this.lifecycle.acquireSilent(organizationId);
      if (method) {
        return this.buildAuthResult(method);
      }

      // Try password auth (E2E testing only — requires devMode + env vars)
      const pwResult = await this.tryPasswordAuth(organizationId);
      if (pwResult) return pwResult;

      // Full OAuth flow
      return await this.startOAuthFlow(organizationId);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Authentication failed'
      };
    }
  }

  /**
   * Try to authenticate using only cached/refreshed tokens.
   * Never triggers interactive OAuth — returns failure instead.
   */
  async authenticateSilent(organizationId?: string): Promise<AuthResult> {
    this.lifecycle.lastRefreshFailure = null;
    const method = await this.lifecycle.acquireSilent(organizationId);
    if (method) {
      return this.buildAuthResult(method);
    }

    const { code, message } = this.lifecycle.describeSilentAuthFailure();
    return { success: false, error: message, error_code: code };
  }

  private async startOAuthFlow(organizationId?: string): Promise<AuthResult> {
    const oauthServer = new OAuthServer();
    await oauthServer.bind();
    const redirectUri = oauthServer.getRedirectUri();
    const state = oauthServer.getState();

    // If `capy logout` left a marker, ask the service to add prompt=login to
    // the WorkOS auth URL so AuthKit re-prompts instead of silently reusing
    // its SSO cookie. Consume the marker now — even if the OAuth round-trip
    // fails later, "force_login" was the user's intent for this attempt and
    // we don't want it sticking forever.
    const forceLogin = consumeForceLoginMarker();

    const { auth_url } = await postJson<{ auth_url: string }>(
      `${this.serviceApiUrl}/auth/initiate`,
      {
        state,
        redirect_uri: redirectUri,
        organization_id: organizationId,
        code_challenge: oauthServer.getCodeChallenge(),
        ...(forceLogin ? { force_login: true } : {}),
      },
    );

    const code = await oauthServer.startAuthFlow(auth_url);

    const response = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string; first_name: string | null; last_name: string | null };
      organizations: Organization[];
    }>(`${this.serviceApiUrl}/auth/exchange`, {
      code,
      code_verifier: oauthServer.getCodeVerifier(),
    });

    return this.processExchangeResponse(response.token, response.user, response.organizations, organizationId);
  }

  /**
   * Authenticate with email + password (E2E testing only).
   * Requires devMode=true AND CAPY_TEST_EMAIL/CAPY_TEST_PASSWORD env vars.
   */
  private async tryPasswordAuth(organizationId?: string): Promise<AuthResult | null> {
    if (!this.devMode) return null;

    const email = process.env.CAPY_TEST_EMAIL;
    const password = process.env.CAPY_TEST_PASSWORD;
    if (!email || !password) return null;

    const response = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string; first_name: string | null; last_name: string | null };
      organizations: Organization[];
    }>(`${this.serviceApiUrl}/auth/password-login`, {
      email,
      password,
      ...(organizationId ? { organization_id: organizationId } : {}),
    });

    return this.processExchangeResponse(response.token, response.user, response.organizations, organizationId);
  }

  /**
   * Shared session-storage logic used by both OAuth and password auth flows.
   */
  private async processExchangeResponse(
    token: { access_token: string | null; refresh_token: string; expires_in: number },
    user: { id: string; email: string; first_name: string | null; last_name: string | null },
    organizations: Organization[],
    organizationId?: string,
  ): Promise<AuthResult> {
    // Fresh auth = fresh session. Never carry over stale org tokens —
    // a leftover token for the wrong org is an access-control violation.
    const session: SessionStore = {
      version: 2,
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      refresh_token: token.refresh_token,
      organizations: organizations || [],
      sessions: {},
    };
    this.session = session;

    // If service returned a JWT, store the session.
    // The JWT's org_id claim is the source of truth — always decode it to
    // resolve the org. The client-provided organizationId is only a fallback.
    if (token.access_token) {
      let resolvedOrgId = '';

      // Decode JWT to find which org the token is scoped to
      try {
        const payload = JSON.parse(
          Buffer.from(token.access_token.split('.')[1], 'base64').toString()
        );
        if (payload.org_id) {
          const match = organizations?.find(o => o.workos_org_id === payload.org_id);
          if (match) resolvedOrgId = match.id;
        }
      } catch {
        // JWT decode failed — fall through
      }

      // Fallbacks: explicit organizationId if in the org list, then single-org
      if (!resolvedOrgId && organizationId) {
        const orgExists = organizations?.find(o => o.id === organizationId);
        if (orgExists) resolvedOrgId = organizationId;
      }
      if (!resolvedOrgId && organizations?.length === 1) {
        resolvedOrgId = organizations[0].id;
      }

      if (resolvedOrgId) {
        session.sessions[resolvedOrgId] = {
          access_token: token.access_token,
          expires_at: resolveExpiresAt(token.expires_in),
        };
        this.currentOrgId = resolvedOrgId;
      }

      this.lifecycle.save();

      const resolvedOrg = organizations?.find(o => o.id === resolvedOrgId);
      return {
        success: true,
        organization_id: resolvedOrgId,
        organization_name: resolvedOrg?.name || organizations?.[0]?.name,
        user_id: user.id,
        user_email: user.email,
        user_first_name: user.first_name,
        user_last_name: user.last_name,
        organizations: organizations || [],
        // Include refresh_token for org creation when user has no orgs yet
        ...(!resolvedOrgId ? { _refresh_token: token.refresh_token } : {}),
      };
    }

    // No JWT yet — multi-org user. If a specific org was requested, refresh into it.
    this.lifecycle.save();

    if (organizationId && session.refresh_token) {
      const refreshed = await this.lifecycle.refreshForOrg(organizationId);
      if (refreshed) {
        return this.buildAuthResult('refreshed');
      }
    }

    return {
      success: true,
      organization_id: '',
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      organizations: organizations || [],
      _refresh_token: token.refresh_token,
    };
  }

  async refreshToken(): Promise<boolean> {
    if (!this.session?.refresh_token || !this.currentOrgId) {
      return false;
    }
    return this.lifecycle.refreshForOrg(this.currentOrgId);
  }

  /**
   * Refresh using an explicit refresh token and organization ID.
   * Used after multi-org auth when the user selects an org but we don't
   * have a session saved yet (exchange returned no access_token).
   */
  async refreshWithCredentials(
    refreshToken: string,
    organizationId: string,
    userId?: string,
  ): Promise<AuthResult> {
    // Bootstrap session if needed
    if (!this.session) {
      this.session = {
        version: 2,
        user_id: userId || '',
        refresh_token: refreshToken,
        organizations: [],
        sessions: {},
      };
    } else {
      this.session.refresh_token = refreshToken;
    }

    const success = await this.lifecycle.refreshForOrg(organizationId);
    if (success) {
      return this.buildAuthResult('refreshed');
    }

    return {
      success: false,
      error: 'Failed to refresh token for organization',
    };
  }

  /**
   * Reason the most recent refresh attempt failed, or null if the last
   * attempt succeeded (or none was made). Command layers consult this after
   * a failed silent auth to decide between re-auth and retry.
   */
  getLastRefreshFailure(): RefreshFailure | null {
    return this.lifecycle.lastRefreshFailure;
  }

  isAuthenticated(): boolean {
    // Delegate to getToken() which validates the token's org claim
    return this.getToken() !== null && this.getToken()!.expires_at > Date.now();
  }

  getToken(): ServiceToken | null {
    return this.lifecycle.getToken();
  }

  /**
   * Return a token that's guaranteed to be unexpired by our local clock.
   * If the cached access_token has passed `expires_at`, the lifecycle
   * refreshes before returning. Used by ServiceClient on every request so
   * no stale cached token can escape the auth boundary.
   *
   * Returns null if there's no session, no current org, or refresh failed.
   * Callers typically surface that as "you need to re-authenticate".
   */
  async getValidToken(): Promise<ServiceToken | null> {
    return this.lifecycle.getValidToken();
  }

  getOrganizationId(): string | null {
    return this.currentOrgId;
  }

  async checkOrgName(name: string): Promise<{ available: boolean; reason?: string }> {
    return postJson<{ available: boolean; reason?: string }>(
      `${this.serviceApiUrl}/auth/check-org-name`,
      { name },
    );
  }

  async createOrganization(name: string, refreshToken: string, userId: string): Promise<Organization> {
    let data: Organization & {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { id: string; email: string; first_name: string | null; last_name: string | null };
    };
    try {
      data = await postJson(
        `${this.serviceApiUrl}/auth/create-org`,
        { name, refresh_token: refreshToken },
      );
    } catch (err: any) {
      // Translate quota responses into a CapyError so renderError can show the
      // upgrade screen — and so the createNewOrganization retry loop does not
      // mistake a 402 for a name conflict (409) and keep re-prompting.
      if (err instanceof HttpStatusError && err.status === 402 && err.body?.code === 'QUOTA_EXCEEDED') {
        throw new CapyError(
          err.body.error || 'Account quota exceeded',
          ERROR_CODES.QUOTA_EXCEEDED,
          { status: 402, kind: err.body.kind, limit: err.body.limit, upgrade_url: err.body.upgrade_url },
        );
      }
      throw err;
    }

    const newOrg: Organization = { id: data.id, workos_org_id: data.workos_org_id, name: data.name };

    let session = this.session;
    if (!session) {
      session = {
        version: 2,
        user_id: data.user?.id || userId,
        user_email: data.user?.email,
        user_first_name: data.user?.first_name,
        user_last_name: data.user?.last_name,
        refresh_token: data.refresh_token || refreshToken,
        organizations: [newOrg],
        sessions: {},
      };
      this.session = session;
    } else {
      session.organizations = [...session.organizations, newOrg];
      if (data.refresh_token) {
        session.refresh_token = data.refresh_token;
      }
    }

    if (data.access_token) {
      session.sessions[data.id] = {
        access_token: data.access_token,
        expires_at: resolveExpiresAt(data.expires_in || 86400),
      };
      this.currentOrgId = data.id;
    }

    this.lifecycle.save();
    return data;
  }

  clearSession(): void {
    this.lifecycle.clear();
  }

  // Keep backward-compatible name
  clearToken(): void {
    this.clearSession();
  }

  private buildAuthResult(method: 'cached' | 'refreshed'): AuthResult {
    return {
      success: true,
      organization_id: this.currentOrgId || '',
      user_id: this.session!.user_id,
      user_email: this.session!.user_email,
      user_first_name: this.session!.user_first_name,
      user_last_name: this.session!.user_last_name,
      organizations: this.session!.organizations,
      _auth_method: method,
    };
  }
}
