import { hostname } from 'os';
import { AuthResult, Organization, ServiceToken, SessionStore, CapyError, ERROR_CODES } from '../types/index';
import { OAuthServer } from './oauthServer';
import { BrokerClient } from '../service/brokerClient';
import { parseCompletionPayload } from '../service/brokerEnvelope';
import {
  keepFlowUrl,
  keepOrigin,
  keepScreensEnabled,
  keepLoginBridgeEnabled,
  isKeepReachable,
  type KeepAuthFlow,
} from '../ui/screens/keepScreens';
import { emitHandoffUrlEvent } from '../ui/handoffEvent';
import { consumeForceLoginMarker, isForceLoginMarkerPending } from '../config/globalConfig';
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
    // CAP-376 serving fork: with CAPY_KEEP_SCREENS=1 the successful callback
    // response is deferred so the browser can be sent to a hosted keep-app
    // screen bound to a broker connection. Flag unset = today's loopback
    // behavior, unchanged.
    const keepScreens = keepScreensEnabled();
    const oauthServer = new OAuthServer({ deferCompletion: keepScreens });
    await oauthServer.bind();

    // CAP-374 step 1: route the FIRST hop through keep's own /auth/start
    // instead of calling /auth/initiate directly, so the SAME browser also
    // comes away with a keep session cookie ("double duty" — see
    // oauthServer.ts's getKeepBridgeUrl doc and
    // keep-app/src/lib/auth/cliBridge.ts). Gated by its OWN flag, separate
    // from CAPY_KEEP_SCREENS (keepLoginBridgeEnabled's doc explains why),
    // and only for the plain fresh-sign-in case: keep's bridge doesn't (yet)
    // forward organization_id or force_login, so either one falls back to
    // today's direct path, which fully supports both. A short reachability
    // probe keeps the loopback fallback working when keep can't be reached
    // at all — once the browser is sent into a flow there's no retargeting
    // it mid-flight.
    const canUseKeepBridge =
      keepLoginBridgeEnabled() && !organizationId && !isForceLoginMarkerPending();
    const useKeepBridge =
      canUseKeepBridge && (await isKeepReachable(keepOrigin()));

    let auth_url: string;
    if (useKeepBridge) {
      auth_url = oauthServer.getKeepBridgeUrl(keepOrigin());
    } else {
      const redirectUri = oauthServer.getRedirectUri();
      const state = oauthServer.getState();

      // If `capy logout` left a marker, ask the service to add prompt=login
      // to the WorkOS auth URL so AuthKit re-prompts instead of silently
      // reusing its SSO cookie. Consume the marker now — even if the OAuth
      // round-trip fails later, "force_login" was the user's intent for
      // this attempt and we don't want it sticking forever.
      const forceLogin = consumeForceLoginMarker();

      const response = await postJson<{ auth_url: string }>(
        `${this.serviceApiUrl}/auth/initiate`,
        {
          state,
          redirect_uri: redirectUri,
          organization_id: organizationId,
          code_challenge: oauthServer.getCodeChallenge(),
          ...(forceLogin ? { force_login: true } : {}),
        },
      );
      auth_url = response.auth_url;
    }

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
    emitHandoffUrlEvent(url, 'login');

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

      // CAP-375 Wave-B: a genuinely zero-org identity's exchange now
      // returns a real (org-less, scope:"user") access token instead of
      // null — previously this branch could only be reached by a 1-org or
      // org_id-claim-matched exchange, both of which always resolve an org
      // id. `organizations.length === 0` is the only way `token.access_token`
      // is truthy with `resolvedOrgId` still empty, so this can't
      // misclassify a multi-org sign-in (which still returns a null token,
      // untouched by the amendment) as org-less. Never persisted to
      // SessionStore — see AuthResult._orgless_access_token's doc comment.
      const orglessToken =
        !resolvedOrgId && (!organizations || organizations.length === 0) ? token.access_token : undefined;

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
        ...(orglessToken ? { _orgless_access_token: orglessToken } : {}),
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

  /**
   * Base service URL this instance talks to. Exposed for a caller that
   * needs to build its own transport against the same backend without
   * duplicating URL resolution — e.g. a `payload-both` keep screen's
   * `BrokerClient` (see `src/service/keepPayloadRelay.ts`), the same way
   * `relayAuthScreenViaKeep` below already uses `this.serviceApiUrl`
   * in-process.
   */
  getServiceApiUrl(): string {
    return this.serviceApiUrl;
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

  private buildAuthResult(method: 'cached' | 'refreshed' | 'refreshed_orgless'): AuthResult {
    // CAP-451 §7.1.1: the org-less silent-refresh branch has no
    // `currentOrgId` (there is no org to scope into) and reports its bearer
    // through `_orgless_access_token`, the same field the exchange-time
    // mint uses — never through the ordinary session-store token path,
    // which stays untouched (nothing was persisted for it).
    const orglessToken = method === 'refreshed_orgless' ? this.lifecycle.orglessAccessToken : null;
    return {
      success: true,
      organization_id: this.currentOrgId || '',
      user_id: this.session!.user_id,
      user_email: this.session!.user_email,
      user_first_name: this.session!.user_first_name,
      user_last_name: this.session!.user_last_name,
      organizations: this.session!.organizations,
      // `_auth_method` has no 'refreshed_orgless' slot — it is still a
      // refresh from the caller's point of view, just one that resolved to
      // an org-less bearer instead of an org-scoped one.
      _auth_method: method === 'refreshed_orgless' ? 'refreshed' : method,
      ...(orglessToken ? { _orgless_access_token: orglessToken } : {}),
    };
  }
}
