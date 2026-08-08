import { unlinkSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { lockSync, unlockSync } from 'proper-lockfile';
import { hostname } from 'os';
import { AuthResult, Organization, ServiceToken, SessionStore, CapyError, ERROR_CODES, SilentAuthFailureCode } from '../types/index';
import { OAuthServer } from './oauthServer';
import { BrokerClient } from '../service/brokerClient';
import { parseCompletionPayload } from '../service/brokerEnvelope';
import { keepFlowUrl, keepScreensEnabled, type KeepAuthFlow } from '../ui/screens/keepScreens';
import { saveAuthSession, readAuthSession, getAuthSessionPath, getGlobalCapyDir, consumeForceLoginMarker } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { debug } from '../ui/debug';

export class HttpStatusError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
  }
}

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

function classifyRefreshFailure(error: any): RefreshFailure {
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
function resolveExpiresAt(expiresInSeconds: number): number {
  const override = process.env.CAPY_TOKEN_TTL_SECONDS;
  const ttl = override ? Number(override) : expiresInSeconds;
  return Date.now() + ttl * 1000;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = (data as any).error || `Request failed with status ${res.status}`;
    throw new HttpStatusError(message, res.status, data);
  }
  return res.json() as Promise<T>;
}

export class AuthService {
  private serviceApiUrl: string;
  private devMode: boolean;
  private sessionUserId: string | undefined;
  private session: SessionStore | null = null;
  private currentOrgId: string | null = null;
  private lastRefreshFailure: RefreshFailure | null = null;

  constructor(serviceApiUrl?: string, devMode: boolean = false, sessionUserId?: string) {
    this.devMode = devMode;
    // Honor CAPY_API_URL / active profile in BOTH modes (same resolution as
    // ServiceClient). Previously prod mode hardcoded api.capy.sc, so auth
    // ignored CAPY_API_URL — capy-staging and byoc would authenticate against
    // prod (returning prod orgs) even though every other call hit the override.
    this.serviceApiUrl = serviceApiUrl || resolveActiveUrl(devMode);
    this.sessionUserId = sessionUserId;
    if (devMode) {
      // Suppress the dev diagnostic in local-only mode — no identity provider
      // is used there, so the server URL is irrelevant and misleading.
      const { isLocalOnly } = require('../config/profileConfig') as typeof import('../config/profileConfig');
      if (!isLocalOnly()) debug(`[dev] AuthService → ${this.serviceApiUrl}`);
    }
    this.loadSession();
  }

  setSessionUserId(userId: string): void {
    if (this.sessionUserId === userId) return;
    this.sessionUserId = userId;
    this.loadSession(); // Reload from the user-scoped file
  }

  async authenticate(organizationId?: string): Promise<AuthResult> {
    try {
      // If we have a session and a specific org is requested, try to use/refresh it
      if (this.session && organizationId) {
        const orgSession = this.session.sessions[organizationId];
        if (orgSession && orgSession.expires_at > Date.now() && this.validateTokenOrg(organizationId, orgSession.access_token)) {
          this.currentOrgId = organizationId;
          return this.buildAuthResult('cached');
        }
        // Token missing, expired, or org mismatch — refresh into the correct org
        if (this.session.refresh_token) {
          const refreshed = await this.refreshForOrg(organizationId);
          if (refreshed) {
            return this.buildAuthResult('refreshed');
          }
        }
      }

      // If we have a session with no specific org requested, use any valid session
      if (this.session && !organizationId) {
        for (const [orgId, orgSession] of Object.entries(this.session.sessions)) {
          if (orgSession.expires_at > Date.now() && this.validateTokenOrg(orgId, orgSession.access_token)) {
            this.currentOrgId = orgId;
            return this.buildAuthResult('cached');
          }
        }
        // Try refreshing the first known org
        if (this.session.refresh_token && this.session.organizations.length > 0) {
          const firstOrg = this.session.organizations[0];
          const refreshed = await this.refreshForOrg(firstOrg.id);
          if (refreshed) {
            return this.buildAuthResult('refreshed');
          }
        }
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
    this.lastRefreshFailure = null;
    if (this.session && organizationId) {
      const orgSession = this.session.sessions[organizationId];
      if (orgSession && orgSession.expires_at > Date.now() && this.validateTokenOrg(organizationId, orgSession.access_token)) {
        this.currentOrgId = organizationId;
        return this.buildAuthResult('cached');
      }
      if (this.session.refresh_token) {
        const refreshed = await this.refreshForOrg(organizationId);
        if (refreshed) {
          return this.buildAuthResult('refreshed');
        }
      }
    }

    if (this.session && !organizationId) {
      for (const [orgId, orgSession] of Object.entries(this.session.sessions)) {
        if (orgSession.expires_at > Date.now() && this.validateTokenOrg(orgId, orgSession.access_token)) {
          this.currentOrgId = orgId;
          return this.buildAuthResult('cached');
        }
      }
      if (this.session.refresh_token && this.session.organizations.length > 0) {
        const firstOrg = this.session.organizations[0];
        const refreshed = await this.refreshForOrg(firstOrg.id);
        if (refreshed) {
          return this.buildAuthResult('refreshed');
        }
      }
    }

    const { code, message } = this.describeSilentAuthFailure();
    return { success: false, error: message, error_code: code };
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
  private describeSilentAuthFailure(): { code: SilentAuthFailureCode; message: string } {
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

  private async startOAuthFlow(organizationId?: string): Promise<AuthResult> {
    // CAP-376 serving fork: with CAPY_KEEP_SCREENS=1 the successful callback
    // response is deferred so the browser can be sent to a hosted keep-app
    // screen bound to a broker connection. Flag unset = today's loopback
    // behavior, unchanged.
    const keepScreens = keepScreensEnabled();
    const oauthServer = new OAuthServer({ deferCompletion: keepScreens });
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

    if (!keepScreens) {
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

    // Keep-screens path: the callback response is still held open. Finish the
    // exchange, then decide where the browser lands. Any throw on the way must
    // settle the held response first — a browser left spinning is a bug.
    try {
      const response = await postJson<{
        token: { access_token: string | null; refresh_token: string; expires_in: number };
        user: { id: string; email: string; first_name: string | null; last_name: string | null };
        organizations: Organization[];
      }>(`${this.serviceApiUrl}/auth/exchange`, {
        code,
        code_verifier: oauthServer.getCodeVerifier(),
      });

      const result = await this.processExchangeResponse(response.token, response.user, response.organizations, organizationId);
      await this.relayAuthScreenViaKeep(oauthServer, result);
      return result;
    } catch (error: any) {
      // Exchange (or session processing) failed with no usable session, so a
      // broker connection cannot be created (create is org-scoped): the held
      // browser response gets today's loopback error screen, and the caller's
      // error handling proceeds unchanged.
      oauthServer.completeDeferred({
        kind: 'error-screen',
        message: error?.message || 'Authentication failed',
      });
      throw error;
    }
  }

  /**
   * CAP-376: relay the auth ending as a hosted keep-app screen riding the
   * connection broker. Fully best-effort — authentication has already
   * succeeded or failed by the time this runs, and every failure here
   * degrades to the loopback screen the flow always had.
   *
   * The keep transport requires an org-scoped access token (broker create is
   * a CLI-side verb). A multi-org first sign-in gets no org token from the
   * exchange, so it keeps the loopback ending — recorded limitation, not an
   * error path.
   */
  private async relayAuthScreenViaKeep(oauthServer: OAuthServer, result: AuthResult): Promise<void> {
    const flow: KeepAuthFlow = result.success ? 'auth-success' : 'auth-error';
    const fallback = () =>
      oauthServer.completeDeferred(
        result.success
          ? { kind: 'success-screen' }
          : { kind: 'error-screen', message: result.error || 'Authentication failed' },
      );

    const token = this.getKeepRelayToken(result);
    if (!token) {
      fallback();
      return;
    }

    const broker = new BrokerClient(this.serviceApiUrl, () => token);
    let connection;
    try {
      connection = await broker.createConnection({
        purpose: flow,
        machineName: hostname(),
      });
    } catch {
      // Coded CapyError from the client; the remedy is always the same —
      // serve the loopback ending instead. Nothing branches on which failure.
      fallback();
      return;
    }

    const url = keepFlowUrl(flow, connection.connectionId, result.success ? undefined : result.error_code || 'AUTH_FAILED');

    // Print before redirecting, mirroring the auth-URL print above: the MCP
    // relays what interactive runs print, and a browser that never follows
    // the redirect still leaves the user a working address.
    console.log('');
    console.log('  Finish in your browser:');
    console.log(`  ${url}`);
    console.log('');

    oauthServer.completeDeferred({ kind: 'redirect', url });

    // Wait (bounded) for the page's sealed acknowledgement — the same
    // envelope round-trip a payload-bearing screen will rely on. The ack is
    // confirmation, not authority: its absence never un-succeeds a login.
    const ack = await broker.awaitAnswer(connection);
    if (ack.kind === 'answered') {
      const completion = parseCompletionPayload(ack.plaintext, flow);
      debug(`[keep-screens] ${flow} ${completion ? 'acknowledged' : 'bad completion payload'}`);
    } else {
      debug(`[keep-screens] ${flow} not acknowledged (${ack.kind})`);
    }
  }

  /**
   * The org-scoped token the broker's CLI-side verbs require, if this auth
   * ending produced one. Empty-handed on multi-org sign-ins (exchange
   * returns no org token) and on failures — the callers fall back.
   */
  private getKeepRelayToken(result: AuthResult): string | null {
    if (!this.session) return null;
    const orgId = result.organization_id || this.currentOrgId;
    if (!orgId) return null;
    const orgSession = this.session.sessions[orgId];
    if (!orgSession || orgSession.expires_at <= Date.now()) return null;
    return orgSession.access_token;
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
    this.session = {
      version: 2,
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      refresh_token: token.refresh_token,
      organizations: organizations || [],
      sessions: {},
    };

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
        this.session.sessions[resolvedOrgId] = {
          access_token: token.access_token,
          expires_at: resolveExpiresAt(token.expires_in),
        };
        this.currentOrgId = resolvedOrgId;
      }

      this.saveSession();

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
    this.saveSession();

    if (organizationId && this.session.refresh_token) {
      const refreshed = await this.refreshForOrg(organizationId);
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
    return this.refreshForOrg(this.currentOrgId);
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

    const success = await this.refreshForOrg(organizationId);
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
    return this.lastRefreshFailure;
  }

  private async refreshForOrg(orgId: string): Promise<boolean> {
    if (!this.session?.refresh_token) return false;
    this.lastRefreshFailure = null;

    const userId = this.sessionUserId || this.session.user_id;
    const sessionPath = getAuthSessionPath(userId);
    let release: (() => void) | null = null;

    try {
      // Acquire file lock to prevent concurrent refresh races
      try {
        release = lockSync(sessionPath, { retries: { retries: 3, minTimeout: 100 } });
      } catch {
        // If locking fails (file doesn't exist yet, etc.), proceed without lock
      }

      // Re-read session from disk in case another process updated it
      if (release) {
        const freshSession = readAuthSession(userId) as SessionStore | null;
        if (freshSession?.version === 2) {
          // Check if another process already refreshed this org
          const existing = freshSession.sessions[orgId];
          if (existing && existing.expires_at > Date.now()) {
            this.session = freshSession;
            this.currentOrgId = orgId;
            return true;
          }
          // Use the latest refresh token
          this.session.refresh_token = freshSession.refresh_token;
        }
      }

      const data = await postJson<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user?: { id: string; email: string; first_name: string | null; last_name: string | null };
        organization?: { id: string; workos_org_id: string; name: string };
      }>(
        `${this.serviceApiUrl}/auth/refresh`,
        {
          refresh_token: this.session.refresh_token,
          organization_id: orgId,
        },
      );

      // Resolve the actual org from the JWT — the caller may have passed a
      // stale internal org ID but the token is scoped to the canonical one.
      let resolvedOrgId = orgId;
      try {
        const payload = JSON.parse(
          Buffer.from(data.access_token.split('.')[1], 'base64').toString()
        );
        if (payload.org_id) {
          const match = this.session.organizations.find(o => o.workos_org_id === payload.org_id);
          if (match) resolvedOrgId = match.id;
        }
      } catch {
        // JWT decode failed — use the orgId as-is
      }

      // Add/update the session for this org. Other org sessions are preserved —
      // the KMS co-decrypt endpoint is the security gate per-org, not the client.
      this.session.sessions[resolvedOrgId] = {
        access_token: data.access_token,
        expires_at: resolveExpiresAt(data.expires_in),
      };
      this.session.refresh_token = data.refresh_token;

      // If this org isn't in the organizations list yet (e.g. user was just
      // invited and we refreshed into the new org), add it from the response.
      if (!this.session.organizations.some(o => o.id === resolvedOrgId) && data.organization) {
        this.session.organizations.push({
          id: data.organization.id,
          workos_org_id: data.organization.workos_org_id,
          name: data.organization.name,
        });
      }

      if (data.user) {
        this.session.user_id = data.user.id;
        this.session.user_email = data.user.email;
        this.session.user_first_name = data.user.first_name;
        this.session.user_last_name = data.user.last_name;
      }

      this.currentOrgId = resolvedOrgId;
      this.saveSession();
      return true;
    } catch (error: any) {
      const failure = classifyRefreshFailure(error);
      this.lastRefreshFailure = failure;
      debug(
        `[auth] token refresh failed for org ${orgId} (${failure.reason}` +
        `${failure.status ? `, HTTP ${failure.status}` : ''}): ${failure.detail || 'no detail'}`
      );
      return false;
    } finally {
      if (release) {
        try { release(); } catch { /* ignore */ }
      }
    }
  }

  isAuthenticated(): boolean {
    // Delegate to getToken() which validates the token's org claim
    return this.getToken() !== null && this.getToken()!.expires_at > Date.now();
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
        const payload = JSON.parse(
          Buffer.from(orgSession.access_token.split('.')[1], 'base64').toString()
        );
        if (payload.org_id && payload.org_id !== org.workos_org_id) {
          // Token is for a different org — discard it.
          delete this.session.sessions[this.currentOrgId];
          this.saveSession();
          return null;
        }
      } catch {
        // Can't decode token — treat as invalid
        delete this.session.sessions[this.currentOrgId];
        this.saveSession();
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
   * request so no stale cached token can escape the authService boundary.
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

    if (!this.session) {
      this.session = {
        version: 2,
        user_id: data.user?.id || userId,
        user_email: data.user?.email,
        user_first_name: data.user?.first_name,
        user_last_name: data.user?.last_name,
        refresh_token: data.refresh_token || refreshToken,
        organizations: [newOrg],
        sessions: {},
      };
    } else {
      this.session.organizations = [...this.session.organizations, newOrg];
      if (data.refresh_token) {
        this.session.refresh_token = data.refresh_token;
      }
    }

    if (data.access_token) {
      this.session.sessions[data.id] = {
        access_token: data.access_token,
        expires_at: resolveExpiresAt(data.expires_in || 86400),
      };
      this.currentOrgId = data.id;
    }

    this.saveSession();
    return data;
  }

  clearSession(): void {
    const userId = this.sessionUserId || this.session?.user_id;
    this.session = null;
    this.currentOrgId = null;
    try {
      const sessionPath = getAuthSessionPath(userId);
      if (existsSync(sessionPath)) {
        unlinkSync(sessionPath);
      }
    } catch {
      // Ignore
    }
  }

  // Keep backward-compatible name
  clearToken(): void {
    this.clearSession();
  }

  /**
   * Validate that an access token's org_id claim matches the expected org.
   * Returns false if the token is for a different org (stale session).
   */
  private validateTokenOrg(orgId: string, accessToken: string): boolean {
    const org = this.session?.organizations.find(o => o.id === orgId);
    if (!org) return false;
    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64').toString()
      );
      if (payload.org_id && payload.org_id !== org.workos_org_id) {
        // Token is scoped to a different org — stale.
        return false;
      }
      return true;
    } catch {
      return false;
    }
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

  private loadSession(): void {
    try {
      const data = readAuthSession(this.sessionUserId) as SessionStore | null;
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
      // Invalid session file, ignore
    }

    // No session found at the expected path. If we don't know the userId,
    // scan ~/.capy/auth/sessions/ for any existing session file.
    // This handles the post-redeem flow where the invitee runs `capy` in a
    // new project directory that has no sync-state (and thus no userId hint).
    if (!this.sessionUserId) {
      try {
        const sessionsDir = join(getGlobalCapyDir(), 'auth', 'sessions');
        if (!existsSync(sessionsDir)) return;
        const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const userId = file.replace('.json', '');
            const data = readAuthSession(userId) as SessionStore | null;
            // Skip stale files where the filename user_id disagrees with the
            // content user_id — a prior refresh wrote new user data to the
            // old path, leaving a snapshot that disagrees with the
            // authoritative per-user file.
            if (data && data.version === 2 && data.user_id === userId) {
              this.session = data;
              this.sessionUserId = userId;
              return;
            }
          } catch {
            // Skip invalid files
          }
        }
      } catch {
        // Sessions directory doesn't exist or isn't readable
      }
    }
  }

  private saveSession(): void {
    if (!this.session) return;
    try {
      // Save to user-scoped path once we know the user ID
      const userId = this.sessionUserId || this.session.user_id;
      saveAuthSession(this.session, userId);
    } catch {
      // Failed to save session
    }
  }
}
