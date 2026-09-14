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
import type { AuthResponseWire } from './initRunContract';

import {
  initRunSessionAuthorityDigest,
  prepareInitRunSessionInstallation,
  refreshTokenAuthorityDigest,
} from './initRunSessionInstaller';
import {
  INIT_RUN_ORGANIZATION_INDETERMINATE,
  INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH,
  parseInitRunCreatedOrganizationResponse,
  prepareInitRunCreatedOrganizationInstallation,
} from './initRunOrganizationInstaller';
import {
  currentIdentityAccessToken,
  prepareIdentityRefresh,
  requestIdentityRefresh,
} from './identityRefresh';

export interface InstalledExchangeResponse {
  readonly auth: AuthResult;
  readonly authService: AuthService;
}

export interface InstalledInitRunOrganization {
  readonly organization: Organization;
  readonly auth: AuthResult;
  readonly authService: AuthService;
}

export interface RenewedInitRunIdentity {
  readonly auth: AuthResult;
  readonly authService: AuthService;
  readonly accessToken: string;
}

type ExplicitAuthInstallationBaseline = Readonly<{
  userId: string | null;
  refreshAuthoritySha256: string | null;
}>;

const INIT_RUN_ORGANIZATION_RESPONSE_LIMIT = 131_072;
const INIT_RUN_ORGANIZATION_TIMEOUT_MS = 15_000;

const exactInitRunServiceOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

const exactConfiguredServiceBase = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
};

const initRunOrganizationFailure = (message: string): CapyError =>
  new CapyError(message, INIT_RUN_ORGANIZATION_INDETERMINATE);

const parseJsonText = (value: string): unknown => {
  try { return JSON.parse(value); } catch { return null; }
};

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
  private readonly storageBackend: SessionStorageBackend;
  private readonly initialSessionUserId: string | null;
  private readonly initialSessionAuthorityDigest: string | null;
  private readonly initialRefreshAuthorityDigest: string | null;
  private readonly initialRefreshLineageDigest: string | null;

  constructor(
    serviceApiUrl?: string,
    devMode: boolean = false,
    sessionUserId?: string,
    storage?: SessionStorageBackend,
    initialCurrentOrgId: string | null = null,
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
    const storageBackend = storage ?? new FileSessionStorageBackend();
    this.storageBackend = storageBackend;
    this.lifecycle = new SessionLifecycle(
      storageBackend,
      this.serviceApiUrl,
      sessionUserId,
      initialCurrentOrgId,
    );
    this.lifecycle.load();
    this.initialSessionUserId = this.lifecycle.session?.user_id ?? null;
    this.initialSessionAuthorityDigest = initRunSessionAuthorityDigest(this.lifecycle.session);
    this.initialRefreshAuthorityDigest = refreshTokenAuthorityDigest(this.lifecycle.session);
    this.initialRefreshLineageDigest = this.lifecycle.session?.identity_session?.root_authority_sha256
      ?? this.initialRefreshAuthorityDigest;
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
      this.assertRefreshAuthorityAvailable();
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
    const installationBaseline = this.captureExplicitAuthInstallationBaseline();
    const oauthServer = new OAuthServer({ deferCompletion: keepScreens });
    await oauthServer.bind();

    // A local CLI listener is its own transport. The Service creates the
    // WorkOS URL and signs its callback binding before Keep is involved.
    // For a fresh sign-in, Keep owns the browser authentication and signup
    // ceremony; the CLI must never bypass it with a direct WorkOS URL.
    // The CLI remains the sole exchanger for the local loopback callback.
    const canUseKeepBridge =
      keepLoginBridgeEnabled() && !organizationId && !isForceLoginMarkerPending();
    const useKeepBridge = canUseKeepBridge;
    const redirectUri = oauthServer.getRedirectUri();
    const forceLogin = consumeForceLoginMarker();
    const initiated = await postJson<{ auth_url: string; loopback_binding: string }>(
      `${this.serviceApiUrl}/auth/loopback/initiate`,
      {
        state: oauthServer.getState(),
        redirect_uri: redirectUri,
        organization_id: organizationId,
        code_challenge: oauthServer.getCodeChallenge(),
        ...(forceLogin ? { force_login: true } : {}),
      },
    );
    const auth_url = useKeepBridge
      ? oauthServer.getKeepLoopbackDirectUrl(keepOrigin(), initiated.loopback_binding)
      : initiated.auth_url;

    const code = await oauthServer.startAuthFlow(auth_url);

    if (!keepScreens) {
      const response = await postJson<{
        token: { access_token: string | null; refresh_token: string; expires_in: number };
        user: { id: string; email: string; first_name: string | null; last_name: string | null };
        organizations: Organization[];
      }>(`${this.serviceApiUrl}/auth/exchange`, {
        code,
        code_verifier: oauthServer.getCodeVerifier(),
        redirect_uri: redirectUri,
        loopback_binding: initiated.loopback_binding,
      });

      return this.processVerifiedExchangeResponse(
        response.token, response.user, response.organizations, installationBaseline, organizationId,
      );
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
        redirect_uri: redirectUri,
        loopback_binding: initiated.loopback_binding,
      });

      const result = await this.processVerifiedExchangeResponse(
        response.token, response.user, response.organizations, installationBaseline, organizationId,
      );
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
    const installationBaseline = this.captureExplicitAuthInstallationBaseline();

    const response = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string; first_name: string | null; last_name: string | null };
      organizations: Organization[];
    }>(`${this.serviceApiUrl}/auth/password-login`, {
      email,
      password,
      ...(organizationId ? { organization_id: organizationId } : {}),
    });

    return this.processVerifiedExchangeResponse(
      response.token, response.user, response.organizations, installationBaseline, organizationId,
    );
  }

  private captureExplicitAuthInstallationBaseline(): ExplicitAuthInstallationBaseline {
    this.assertRefreshAuthorityAvailable();
    const scopedUserId = this.lifecycle.sessionUserId ?? this.initialSessionUserId ?? this.session?.user_id ?? null;
    const stored = scopedUserId === null ? null : this.storageBackend.load(scopedUserId);
    return {
      userId: stored?.user_id ?? scopedUserId,
      refreshAuthoritySha256: refreshTokenAuthorityDigest(stored),
    };
  }

  private processVerifiedExchangeResponse(
    token: { access_token: string | null; refresh_token: string; expires_in: number },
    user: { id: string; email: string; first_name: string | null; last_name: string | null },
    organizations: Organization[],
    baseline: ExplicitAuthInstallationBaseline,
    organizationId?: string,
  ): Promise<AuthResult> {
    if (baseline.userId !== null && baseline.userId !== user.id) {
      return Promise.reject(new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE'));
    }
    const process = () => this.processExchangeResponse(token, user, organizations, organizationId);
    return this.storageBackend.withVerifiedAuthInstallation
      ? this.storageBackend.withVerifiedAuthInstallation(
        user.id,
        baseline.refreshAuthoritySha256,
        process,
      )
      : process();
  }

  /**
   * Shared session-storage logic used by both OAuth and password auth flows.
   */
  async installExchangeResponse(
    response: AuthResponseWire,
    expected: Readonly<{ userId: string }>,
  ): Promise<InstalledExchangeResponse> {
    const prepared = prepareInitRunSessionInstallation(response, expected);
    const currentSession = (() => {
      try {
        return this.storageBackend.load(response.user.id);
      } catch {
        throw new CapyError('Could not verify the current auth session', 'INIT_DELIVERY_INDETERMINATE');
      }
    })();
    const currentDigest = initRunSessionAuthorityDigest(currentSession);
    const preparedDigest = initRunSessionAuthorityDigest(prepared.session);
    const baselineDigest = this.initialSessionUserId === response.user.id
      ? this.initialSessionAuthorityDigest
      : null;
    const alreadyInstalled = currentDigest !== null && currentDigest === preparedDigest;
    if (!alreadyInstalled && currentDigest !== baselineDigest) {
      throw new CapyError('The auth session changed during hosted sign-in', 'INIT_DELIVERY_INDETERMINATE');
    }
    if (!alreadyInstalled) {
      try {
        const saved = this.storageBackend.saveIfRefreshAuthorityMatches
          ? this.storageBackend.saveIfRefreshAuthorityMatches(
            prepared.session,
            response.user.id,
            refreshTokenAuthorityDigest(currentSession),
          )
          : (this.storageBackend.save(prepared.session, response.user.id), true);
        if (!saved) throw new Error('authority changed');
      } catch {
        throw new CapyError('Could not persist the hosted auth session', 'INIT_DELIVERY_INDETERMINATE');
      }
    }
    const replacement = new AuthService(
      this.serviceApiUrl,
      this.devMode,
      response.user.id,
      this.storageBackend,
      prepared.currentOrgId,
    );
    if (
      replacement.initialSessionUserId !== response.user.id
      || replacement.initialSessionAuthorityDigest !== preparedDigest
      || replacement.currentOrgId !== prepared.currentOrgId
    ) {
      throw new CapyError('Could not confirm the persisted hosted auth session', 'INIT_DELIVERY_INDETERMINATE');
    }
    return {
      auth: prepared.auth,
      authService: replacement,
    };
  }

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
    this.assertRefreshAuthorityAvailable();
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
  ): Promise<InstalledExchangeResponse> {
    this.assertRefreshAuthorityAvailable();
    const failure = (authService: AuthService): InstalledExchangeResponse => ({
      auth: {
        success: false,
        error: 'Failed to refresh token for organization',
      },
      authService,
    });
    const expectedUserId = userId ?? this.lifecycle.sessionUserId ?? this.initialSessionUserId
      ?? this.session?.user_id ?? null;
    if (!expectedUserId || !refreshToken || !organizationId) return failure(this);
    const loaded = (() => {
      try {
        this.storageBackend.assertRefreshAuthorityAvailable?.(expectedUserId);
        return { ok: true as const, session: this.storageBackend.load(expectedUserId) };
      } catch {
        return { ok: false as const };
      }
    })();
    if (!loaded.ok) return failure(this);
    const current = loaded.session;
    if (current && current.user_id !== expectedUserId) return failure(this);
    const authority = current ?? {
        version: 2,
        user_id: expectedUserId,
        refresh_token: refreshToken,
        organizations: [],
        sessions: {},
      } as const satisfies SessionStore;
    if (!current) {
      const saved = (() => {
        try {
          return this.storageBackend.saveIfRefreshAuthorityMatches
            ? this.storageBackend.saveIfRefreshAuthorityMatches(authority, expectedUserId, null)
            : (this.storageBackend.save(authority, expectedUserId), true);
        } catch {
          return false;
        }
      })();
      if (!saved) return failure(this);
    }
    const candidate = new AuthService(
      this.serviceApiUrl,
      this.devMode,
      expectedUserId,
      this.storageBackend,
      null,
    );
    const refreshed = await candidate.lifecycle.refreshForOrg(organizationId);
    if (!refreshed) return failure(candidate);
    const replacement = new AuthService(
      this.serviceApiUrl,
      this.devMode,
      expectedUserId,
      this.storageBackend,
      organizationId,
    );
    const selected = (() => {
      try { return replacement.getToken(); } catch { return null; }
    })();
    if (!selected
      || selected.user_id !== expectedUserId
      || selected.organization_id !== organizationId
      || !/^\S+$/u.test(selected.access_token)
      || !Number.isFinite(selected.expires_at)
      || selected.expires_at <= Date.now()) {
      return failure(replacement);
    }
    return { auth: replacement.buildAuthResult('refreshed'), authService: replacement };
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
    this.assertRefreshAuthorityAvailable();
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
    this.assertRefreshAuthorityAvailable();
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

  assertRefreshAuthorityAvailable(): void {
    this.storageBackend.assertRefreshAuthorityAvailable?.(
      this.lifecycle.sessionUserId ?? this.initialSessionUserId ?? this.session?.user_id,
    );
  }

  async checkOrgName(name: string): Promise<{ available: boolean; reason?: string }> {
    return postJson<{ available: boolean; reason?: string }>(
      `${this.serviceApiUrl}/auth/check-org-name`,
      { name },
    );
  }

  /**
   * Install the single response from the hosted fresh-user organization
   * endpoint without mutating this AuthService. The request is bound to this
   * instance's configured service and current persisted zero-org authority.
   */
  async createInitRunOrganization(
    name: string,
    expected: Readonly<{ userId: string; deadline: number }>,
  ): Promise<InstalledInitRunOrganization> {
    const serviceOrigin = exactInitRunServiceOrigin(this.serviceApiUrl);
    const trimmedName = name.trim();
    if (!serviceOrigin || trimmedName.length === 0 || trimmedName.length > 100) {
      throw initRunOrganizationFailure('The hosted organization request authority was invalid');
    }
    if (!Number.isFinite(expected.deadline)) {
      throw initRunOrganizationFailure('The hosted initialization deadline was invalid');
    }
    const installed = await this.storageBackend.withRefreshLock(expected.userId, async (before, beginRotation) => {
      const beforeDigest = initRunSessionAuthorityDigest(before);
      const baselineMatches = before !== null
        && before.user_id === expected.userId
        && /^\S+$/u.test(before.refresh_token)
        && before.organizations.length === 0
        && Object.keys(before.sessions).length === 0
        && this.currentOrgId === null
        && this.initialSessionUserId === expected.userId
        && beforeDigest !== null
        && (beforeDigest === this.initialSessionAuthorityDigest
          || before.identity_session?.root_authority_sha256 === this.initialRefreshLineageDigest);
      if (!before || !baselineMatches) {
        throw initRunOrganizationFailure('The hosted organization request authority was invalid');
      }
    const remaining = expected.deadline - Date.now();
    if (remaining <= 0) throw new CapyError('The hosted initialization run expired', 'INIT_RUN_EXPIRED');
    beginRotation();
    const response = await (async () => {
      try {
        return await fetch(`${serviceOrigin}/auth/create-org`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, refresh_token: before.refresh_token }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(INIT_RUN_ORGANIZATION_TIMEOUT_MS, remaining))),
        });
      } catch {
        throw initRunOrganizationFailure('The hosted organization response was not confirmed');
      }
    })();
    const bodyText = await (async () => {
      try { return await response.text(); } catch { throw initRunOrganizationFailure('The hosted organization response was not confirmed'); }
    })();
    if (bodyText.length > INIT_RUN_ORGANIZATION_RESPONSE_LIMIT) {
      throw initRunOrganizationFailure('The hosted organization response was invalid');
    }
    const body = parseJsonText(bodyText);
    if (!response.ok) {
      const coded = body && typeof body === 'object' && !Array.isArray(body)
        && 'code' in body && body.code === INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH;
      if (response.status === 409 && coded) {
        throw new CapyError('The organization name is already reserved', INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH);
      }
      throw initRunOrganizationFailure('The hosted organization outcome was not confirmed');
    }
    const parsed = parseInitRunCreatedOrganizationResponse(body);
    if (!parsed || Date.now() >= expected.deadline) {
      throw initRunOrganizationFailure('The hosted organization response was invalid or expired');
    }
    const prepared = prepareInitRunCreatedOrganizationInstallation({
      response: parsed,
      expectedUserId: expected.userId,
      requestedName: trimmedName,
      previousSession: before,
      expiresAt: resolveExpiresAt(parsed.expires_in),
      now: Date.now(),
    });
    if (Date.now() >= expected.deadline) {
      throw initRunOrganizationFailure('The auth session changed during hosted organization creation');
    }
    try {
      this.storageBackend.save(prepared.session, expected.userId);
    } catch {
      throw initRunOrganizationFailure('Could not persist the hosted organization session');
    }
    return { prepared, parsed };
    });
    const preparedDigest = initRunSessionAuthorityDigest(installed.prepared.session);
    const replacement = (() => {
      try {
        const authService = new AuthService(
          this.serviceApiUrl,
          this.devMode,
          expected.userId,
          this.storageBackend,
          installed.prepared.currentOrgId,
        );
        return { authService, token: authService.getToken() };
      } catch {
        return null;
      }
    })();
    if (!replacement
      || replacement.authService.initialSessionUserId !== expected.userId
      || replacement.authService.initialSessionAuthorityDigest !== preparedDigest
      || replacement.authService.currentOrgId !== installed.prepared.currentOrgId
      || replacement.token?.user_id !== expected.userId
      || replacement.token.organization_id !== installed.prepared.organization.id
      || replacement.token.access_token !== installed.parsed.access_token) {
      throw initRunOrganizationFailure('Could not confirm the persisted hosted organization session');
    }
    return {
      organization: installed.prepared.organization,
      auth: installed.prepared.auth,
      authService: replacement.authService,
    };
  }

  /**
   * Renew the provider identity without choosing an organization. The file
   * backend keeps its durable fence from immediately before the provider call
   * through replacement persistence and readback.
   */
  async renewInitRunIdentity(expected: Readonly<{
    userId: string;
    deadline: number;
  }>): Promise<RenewedInitRunIdentity> {
    const serviceOrigin = exactInitRunServiceOrigin(this.serviceApiUrl);
    if (!serviceOrigin || !Number.isFinite(expected.deadline)) {
      throw initRunOrganizationFailure('The identity refresh configuration was invalid');
    }
    const renewed = await this.storageBackend.withRefreshLock(expected.userId, async (fresh, beginRotation) => {
      const freshAuthorityDigest = refreshTokenAuthorityDigest(fresh);
      const lineageMatches = freshAuthorityDigest !== null
        && this.initialRefreshAuthorityDigest !== null
        && (freshAuthorityDigest === this.initialRefreshAuthorityDigest
          || fresh?.identity_session?.root_authority_sha256 === this.initialRefreshLineageDigest);
      if (!fresh || fresh.user_id !== expected.userId || this.currentOrgId !== null || !lineageMatches) {
        throw initRunOrganizationFailure('The identity refresh authority was invalid');
      }
      const cached = currentIdentityAccessToken(fresh, expected.userId, Date.now());
      if (!cached) beginRotation();
      const prepared = cached ? null : prepareIdentityRefresh({
        response: await requestIdentityRefresh({
          serviceOrigin,
          refreshToken: fresh.refresh_token,
          deadline: expected.deadline,
        }),
        previous: fresh,
        currentOrgId: this.currentOrgId,
        expectedUserId: expected.userId,
        now: Date.now(),
      });
      if (prepared) this.storageBackend.save(prepared.session, expected.userId);
      return {
        auth: prepared?.auth ?? null,
        currentOrgId: prepared?.currentOrgId ?? this.currentOrgId,
        accessToken: prepared?.accessToken ?? cached,
      };
    });
    const replacement = new AuthService(
      this.serviceApiUrl,
      this.devMode,
      expected.userId,
      this.storageBackend,
      renewed.currentOrgId,
    );
    const replacementSession = (() => {
      try { return this.storageBackend.load(expected.userId); } catch { return null; }
    })();
    const accessToken = replacementSession
      ? currentIdentityAccessToken(replacementSession, expected.userId, Date.now())
      : null;
    if (!replacementSession || replacementSession.user_id !== expected.userId
      || !accessToken || accessToken !== renewed.accessToken) {
      throw initRunOrganizationFailure('The renewed identity was not confirmed');
    }
    const selected = renewed.currentOrgId === null
      ? null
      : replacementSession.organizations.find((organization) => organization.id === renewed.currentOrgId) ?? null;
    const auth = renewed.auth ?? {
      success: true as const,
      organization_id: selected?.id ?? '',
      organization_name: selected?.name,
      user_id: replacementSession.user_id,
      user_email: replacementSession.user_email,
      user_first_name: replacementSession.user_first_name,
      user_last_name: replacementSession.user_last_name,
      organizations: replacementSession.organizations,
      ...(selected ? {} : {
        _refresh_token: replacementSession.refresh_token,
        _orgless_access_token: accessToken,
      }),
    };
    return { auth, authService: replacement, accessToken };
  }

  async createOrganization(name: string, refreshToken: string, userId: string): Promise<InstalledInitRunOrganization> {
    const serviceBase = exactConfiguredServiceBase(this.serviceApiUrl);
    const requestedName = name.trim();
    const callerAuthorityDigest = refreshTokenAuthorityDigest(this.session);
    const acceptedLineageDigest = this.initialRefreshLineageDigest;
    if (!serviceBase || !/^\S+$/u.test(userId) || userId.length > 255
      || !/^\S+$/u.test(refreshToken) || requestedName.length === 0 || requestedName.length > 100) {
      throw initRunOrganizationFailure('The organization request authority was invalid');
    }
    const requestDeadline = Date.now() + INIT_RUN_ORGANIZATION_TIMEOUT_MS;
    const requestController = new AbortController();
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      const remaining = requestDeadline - Date.now();
      if (remaining <= 0) throw initRunOrganizationFailure('The organization response was not confirmed');
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        requestController.abort();
        timeout.reject(initRunOrganizationFailure('The organization response was not confirmed'));
      }, remaining);
      return Promise.race([Promise.resolve().then(run), timeout.promise])
        .finally(() => clearTimeout(timer));
    };
    const installed = await this.storageBackend.withRefreshLock(userId, async (before, beginRotation) => {
      const beforeDigest = refreshTokenAuthorityDigest(before);
      const lineageMatches = beforeDigest !== null && (
        beforeDigest === callerAuthorityDigest
        || (acceptedLineageDigest !== null
          && before?.identity_session?.root_authority_sha256 === acceptedLineageDigest)
      );
      if (!before || before.user_id !== userId || before.refresh_token !== refreshToken || !lineageMatches) {
        throw initRunOrganizationFailure('The organization request authority was invalid');
      }
      beginRotation();
      const response = await bounded(() => {
        try {
          return fetch(`${serviceBase}/auth/create-org`, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: requestedName, refresh_token: before.refresh_token }),
            signal: requestController.signal,
          });
        } catch {
          return Promise.reject(initRunOrganizationFailure('The organization response was not confirmed'));
        }
      }).catch(() => {
        throw initRunOrganizationFailure('The organization response was not confirmed');
      });
      const bodyText = await bounded(() => response.text()).catch(() => {
        throw initRunOrganizationFailure('The organization response was not confirmed');
      });
      if (bodyText.length > INIT_RUN_ORGANIZATION_RESPONSE_LIMIT) {
        throw initRunOrganizationFailure('The organization response was invalid');
      }
      const body = parseJsonText(bodyText);
      const responseBody = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Readonly<Record<string, unknown>>
        : null;
      if (!response.ok) {
        if (response.status === 409 && responseBody?.code === INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH) {
          throw new CapyError('The organization name is already reserved', INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH);
        }
        if (response.status === 402 && responseBody?.code === ERROR_CODES.QUOTA_EXCEEDED) {
          throw new CapyError(
            typeof responseBody.error === 'string' ? responseBody.error : 'Account quota exceeded',
            ERROR_CODES.QUOTA_EXCEEDED,
            {
              status: 402,
              kind: responseBody.kind,
              limit: responseBody.limit,
              upgrade_url: responseBody.upgrade_url,
            },
          );
        }
        throw initRunOrganizationFailure('The organization outcome was not confirmed');
      }
      const parsed = parseInitRunCreatedOrganizationResponse(body);
      if (!parsed) throw initRunOrganizationFailure('The organization response was invalid');
      const prepared = prepareInitRunCreatedOrganizationInstallation({
        response: parsed,
        expectedUserId: userId,
        requestedName,
        previousSession: before,
        expiresAt: resolveExpiresAt(parsed.expires_in),
        now: Date.now(),
      });
      try {
        this.storageBackend.save(prepared.session, userId);
      } catch {
        throw initRunOrganizationFailure('Could not persist the organization session');
      }
      return { prepared, parsed };
    }).catch((error: unknown) => {
      const code = error instanceof CapyError ? error.code : null;
      if (code === INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH
        || code === ERROR_CODES.QUOTA_EXCEEDED
        || code === INIT_RUN_ORGANIZATION_INDETERMINATE) throw error;
      throw initRunOrganizationFailure('The organization outcome was not confirmed');
    });
    const preparedDigest = initRunSessionAuthorityDigest(installed.prepared.session);
    const replacement = (() => {
      try {
        const authService = new AuthService(
          this.serviceApiUrl,
          this.devMode,
          userId,
          this.storageBackend,
          installed.prepared.currentOrgId,
        );
        const readback = this.storageBackend.load(userId);
        return { authService, readback, token: authService.getToken() };
      } catch {
        return null;
      }
    })();
    if (!replacement
      || JSON.stringify(replacement.authService.session) !== JSON.stringify(installed.prepared.session)
      || JSON.stringify(replacement.readback) !== JSON.stringify(installed.prepared.session)
      || initRunSessionAuthorityDigest(replacement.readback) !== preparedDigest
      || replacement.authService.initialSessionUserId !== userId
      || replacement.authService.initialSessionAuthorityDigest !== preparedDigest
      || replacement.authService.currentOrgId !== installed.prepared.currentOrgId
      || replacement.token?.user_id !== userId
      || replacement.token.organization_id !== installed.prepared.organization.id
      || replacement.token.access_token !== installed.parsed.access_token) {
      throw initRunOrganizationFailure('Could not confirm the persisted organization session');
    }
    return {
      organization: installed.prepared.organization,
      auth: installed.prepared.auth,
      authService: replacement.authService,
    };
  }

  clearSession(): void {
    this.lifecycle.clear();
  }

  // Keep backward-compatible name
  clearToken(): void {
    this.clearSession();
  }

  private buildAuthResult(method: 'cached' | 'refreshed' | 'refreshed_orgless'): AuthResult {
    this.assertRefreshAuthorityAvailable();
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
