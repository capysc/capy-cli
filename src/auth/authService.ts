import { unlinkSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { lockSync, unlockSync } from 'proper-lockfile';
import { AuthResult, Organization, ServiceToken, SessionStore, CapyError, ERROR_CODES, SilentAuthFailureCode } from '../types/index';
import { OAuthServer } from './oauthServer';
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
  /**
   * True when the service answered `SESSION_NOT_RECOGNIZED`: it did not hand this session out, so no refresh or
   * retry can ever make it work. The saved session is removed and the user signs in again.
   */
  notRecognized?: boolean;
}

/** The service's `code` for a session it did not hand out. Decided by this code, never by the message text. */
export const SESSION_NOT_RECOGNIZED = 'SESSION_NOT_RECOGNIZED';

function classifyRefreshFailure(error: any): RefreshFailure {
  if (error instanceof HttpStatusError) {
    if (error.status === 401) {
      // WorkOS rejected the refresh token — the backing session has ended
      // (inactivity timeout, max duration, sign-out, or revocation).
      const notRecognized = error.body?.code === SESSION_NOT_RECOGNIZED;
      return { reason: 'session_ended', status: error.status, detail: error.message, ...(notRecognized ? { notRecognized } : {}) };
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
function resolveExpiresAt(expiresInSeconds: number, accessToken?: string): number {
  const override = process.env.CAPY_TOKEN_TTL_SECONDS;
  if (override) return Date.now() + Number(override) * 1000;
  const fromResponse = Date.now() + expiresInSeconds * 1000;
  const jwtExpiry = accessToken === undefined ? undefined : decodeJwtExpiryMs(accessToken);
  return jwtExpiry === undefined ? fromResponse : Math.min(fromResponse, jwtExpiry);
}

/** The unverified JWT payload of an access token, or undefined if it is missing or unparseable. Decode-only — the server has already validated the signature. */
function decodeJwtPayload(accessToken: string): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The `org_id` claim out of an unverified JWT access token, or undefined if it's missing/unparseable. */
function decodeJwtOrgClaim(accessToken: string): string | undefined {
  const orgId = decodeJwtPayload(accessToken)?.org_id;
  return typeof orgId === 'string' ? orgId : undefined;
}

/**
 * The JWT's own `exp` in ms, or undefined when it is missing, not a number, or already past. A past `exp`
 * (a client clock ahead of the server's) is ignored, so it can never make every request refresh.
 */
function decodeJwtExpiryMs(accessToken: string): number | undefined {
  const exp = decodeJwtPayload(accessToken)?.exp;
  const ms = typeof exp === 'number' ? exp * 1000 : NaN;
  return Number.isFinite(ms) && ms > Date.now() ? ms : undefined;
}

/**
 * Which org a freshly-issued JWT is scoped to. The JWT's own `org_id` claim
 * is the source of truth; `organizationId` (the caller's request) and "the
 * user has exactly one org" are fallbacks for when the JWT doesn't resolve
 * to a known org. Returns `''` when none of the three apply — same
 * "no org yet" signal `processExchangeResponse` always used.
 *
 * Extracted so `processExchangeResponse` doesn't need a `let resolvedOrgId`
 * reassigned across three independent conditionals — each branch here is a
 * plain early return instead.
 */
function resolveSessionOrgId(accessToken: string, organizations: Organization[] | undefined, organizationId: string | undefined): string {
  const claimOrgId = decodeJwtOrgClaim(accessToken);
  const claimMatch = claimOrgId ? organizations?.find(o => o.workos_org_id === claimOrgId) : undefined;
  if (claimMatch) return claimMatch.id;

  if (organizationId && organizations?.some(o => o.id === organizationId)) return organizationId;

  if (organizations?.length === 1) return organizations[0].id;

  return '';
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

/** The refresh endpoint's answer. */
interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: { id: string; email: string; first_name: string | null; last_name: string | null };
  organization?: { id: string; workos_org_id: string; name: string };
}

/** The session file's lock, or null when it cannot be taken (the file does not exist yet, or the lock library refuses). */
function tryLockSession(sessionPath: string): (() => void) | null {
  try {
    return lockSync(sessionPath, { retries: { retries: 3, minTimeout: 100 } }) || null;
  } catch {
    return null;
  }
}

/** The v2 session stored for `userId`, or null when there is none. Throws if the file is unreadable. */
function readSessionStore(userId: string | undefined): SessionStore | null {
  const stored = readAuthSession(userId) as SessionStore | null;
  return stored?.version === 2 ? stored : null;
}

/**
 * Whether `session` holds, for `orgId`, an access token that is unexpired by our clock and is not `rejected`.
 * `rejected` is the token the service just refused; with none given, any unexpired token counts.
 */
function holdsLiveTokenOtherThan(session: SessionStore, orgId: string, rejected: string | undefined): boolean {
  const held = session.sessions[orgId];
  return held !== undefined && held.expires_at > Date.now() && held.access_token !== rejected;
}

/** The org a refreshed JWT is scoped to: its own `org_id` claim when that names a known org, else the org asked for. */
function resolveRefreshedOrgId(session: SessionStore, requestedOrgId: string, accessToken: string): string {
  const claim = decodeJwtOrgClaim(accessToken);
  const match = claim ? session.organizations.find(o => o.workos_org_id === claim) : undefined;
  return match ? match.id : requestedOrgId;
}

/**
 * `session` after a refresh answered with `data`: the new token and refresh token, the org added when the
 * response introduces it (a freshly invited org), and the user's profile when the response carries it.
 * Other orgs' tokens are kept — the KMS co-decrypt endpoint is the per-org gate, not the client.
 */
function withRefreshedSession(session: SessionStore, resolvedOrgId: string, data: RefreshResponse): SessionStore {
  const incoming = data.organization;
  const organizations = incoming && !session.organizations.some(o => o.id === resolvedOrgId)
    ? [...session.organizations, { id: incoming.id, workos_org_id: incoming.workos_org_id, name: incoming.name }]
    : session.organizations;
  const profile = data.user
    ? { user_id: data.user.id, user_email: data.user.email, user_first_name: data.user.first_name, user_last_name: data.user.last_name }
    : {};
  return {
    ...session,
    ...profile,
    refresh_token: data.refresh_token,
    organizations,
    sessions: {
      ...session.sessions,
      [resolvedOrgId]: { access_token: data.access_token, expires_at: resolveExpiresAt(data.expires_in, data.access_token) },
    },
  };
}

/** A refresh started because the service rejected `rejected` for `orgId`; later 401s on the same token join it. */
interface InFlightRefresh {
  readonly orgId: string;
  readonly rejected: string;
  readonly promise: Promise<boolean>;
}

export class AuthService {
  private serviceApiUrl: string;
  private devMode: boolean;
  private sessionUserId: string | undefined;
  private session: SessionStore | null = null;
  private currentOrgId: string | null = null;
  private lastRefreshFailure: RefreshFailure | null = null;
  /**
   * The one refresh a 401 started and that is still running. Refresh tokens are single-use, so concurrent 401s in
   * this process must share a single refresh instead of each spending the same refresh token. The holder is
   * written only by `shareRefresh`.
   */
  private readonly rejectedTokenRefresh: { current: InFlightRefresh | null } = { current: null };

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
        if (this.lastRefreshFailure.notRecognized) {
          return { code: 'session_ended', message: 'Capy no longer recognizes this session — sign in again' };
        }
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
      const resolvedOrgId = resolveSessionOrgId(token.access_token, organizations, organizationId);

      if (resolvedOrgId) {
        this.session = {
          ...this.session,
          sessions: {
            ...this.session.sessions,
            [resolvedOrgId]: {
              access_token: token.access_token,
              expires_at: resolveExpiresAt(token.expires_in, token.access_token),
            },
          },
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

  /**
   * Installs a token/user/org triple as the current session, the same way a
   * successful `capy` OAuth or password login does — this just exposes
   * {@link processExchangeResponse} publicly rather than duplicating its
   * session-storage logic.
   *
   * Used by `capy pair` (CAP-684): the WorkOS device grant's
   * `/auth/device/token` success response carries the same
   * token/user/organizations shape `/auth/exchange` does, so the session gets
   * installed through the one shared path both flows already use.
   */
  async installDeviceGrantSession(
    token: { access_token: string | null; refresh_token: string; expires_in: number },
    user: { id: string; email: string; first_name: string | null; last_name: string | null },
    organizations: Organization[],
  ): Promise<AuthResult> {
    return this.processExchangeResponse(token, user, organizations);
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

  /**
   * `rejectedAccessToken`: the token the service just refused for this org. A session another process stored is
   * adopted only if its token differs from it — adopting the rejected token itself would change nothing.
   */
  private async refreshForOrg(orgId: string, rejectedAccessToken?: string): Promise<boolean> {
    if (!this.session?.refresh_token) return false;
    this.lastRefreshFailure = null;

    const userId = this.sessionUserId || this.session.user_id;
    // Acquire file lock to prevent concurrent refresh races. If locking fails
    // (file doesn't exist yet, etc.), proceed without lock.
    const release = tryLockSession(getAuthSessionPath(userId));

    try {
      // Re-read session from disk in case another process updated it
      const freshSession = release ? readSessionStore(userId) : null;
      if (freshSession && holdsLiveTokenOtherThan(freshSession, orgId, rejectedAccessToken)) {
        // Another process already refreshed this org
        this.session = freshSession;
        this.currentOrgId = orgId;
        return true;
      }
      // Use the latest refresh token
      const base: SessionStore = freshSession ? { ...this.session, refresh_token: freshSession.refresh_token } : this.session;
      this.session = base;

      const data = await postJson<RefreshResponse>(
        `${this.serviceApiUrl}/auth/refresh`,
        {
          refresh_token: base.refresh_token,
          organization_id: orgId,
        },
      );

      // Resolve the actual org from the JWT — the caller may have passed a
      // stale internal org ID but the token is scoped to the canonical one.
      const resolvedOrgId = resolveRefreshedOrgId(base, orgId, data.access_token);

      this.session = withRefreshedSession(base, resolvedOrgId, data);
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
      // The service never handed this session out. Keeping the file would only make every later command send
      // the same refused token until it expires, so forget it now: the next sign-in starts clean.
      if (failure.notRecognized) this.clearSession();
      return false;
    } finally {
      if (release) {
        try { release(); } catch { /* ignore */ }
      }
    }
  }

  /**
   * After the service refused `rejected` for `orgId`: make this process hold a different, unexpired token for
   * it. True when it does. Concurrent callers refused the same token share one refresh (see `shareRefresh`).
   */
  private refreshPastRejected(orgId: string, rejected: string): Promise<boolean> {
    return this.shareRefresh(orgId, rejected, () => this.replaceRejectedToken(orgId, rejected));
  }

  /**
   * The mutable corner of the forced refresh: `rejectedTokenRefresh` is read and written only here. A call for
   * the token already being replaced joins that refresh. A call for another token waits for it to settle first,
   * so two refreshes never spend the same single-use refresh token at once; `run` re-checks, so it is cheap
   * once the token has been replaced.
   */
  private shareRefresh(orgId: string, rejected: string, run: () => Promise<boolean>): Promise<boolean> {
    const holder = this.rejectedTokenRefresh;
    const inFlight = holder.current;
    if (inFlight && inFlight.orgId === orgId && inFlight.rejected === rejected) return inFlight.promise;

    const turn = inFlight ? inFlight.promise.then(() => undefined, () => undefined) : Promise.resolve();
    const promise: Promise<boolean> = turn.then(run).finally(() => {
      if (holder.current?.promise === promise) holder.current = null;
    });
    holder.current = { orgId, rejected, promise };
    return promise;
  }

  /**
   * Replace `rejected` for `orgId`, cheapest way first: a different unexpired token already in memory (an
   * earlier 401 replaced it), one another process stored on disk, then a real refresh. If the refresh fails,
   * look at the disk once more: another process may have spent the refresh token first and stored its result.
   */
  private async replaceRejectedToken(orgId: string, rejected: string): Promise<boolean> {
    if (this.session && holdsLiveTokenOtherThan(this.session, orgId, rejected)) return true;
    if (this.adoptStoredSession(orgId, rejected)) return true;
    if (await this.refreshForOrg(orgId, rejected)) return true;
    return this.adoptStoredSession(orgId, rejected);
  }

  /** Adopt the session file's copy when it holds a different, unexpired token than `rejected` for `orgId`. */
  private adoptStoredSession(orgId: string, rejected: string): boolean {
    const stored = this.readStoredSession();
    if (!stored || !holdsLiveTokenOtherThan(stored, orgId, rejected)) return false;
    this.session = stored;
    this.currentOrgId = orgId;
    this.lastRefreshFailure = null;
    return true;
  }

  private readStoredSession(): SessionStore | null {
    try {
      return readSessionStore(this.sessionUserId || this.session?.user_id);
    } catch {
      return null;
    }
  }

  isAuthenticated(): boolean {
    // Delegate to getToken() which validates the token's org claim
    return this.getToken() !== null && this.getToken()!.expires_at > Date.now();
  }

  /** Whether the JWT decodes and is not scoped to an org other than `workosOrgId`. */
  private tokenMatchesOrg(accessToken: string, workosOrgId: string): boolean {
    const payload = decodeJwtPayload(accessToken);
    return payload !== undefined && !(payload.org_id && payload.org_id !== workosOrgId);
  }

  /** Forget the cached token for `orgId`, in memory and on disk. */
  private dropOrgSession(orgId: string): void {
    if (!this.session) return;
    const { [orgId]: _dropped, ...remaining } = this.session.sessions;
    this.session = { ...this.session, sessions: remaining };
    this.saveSession();
  }

  getToken(): ServiceToken | null {
    if (!this.session || !this.currentOrgId) return null;
    const orgSession = this.session.sessions[this.currentOrgId];
    if (!orgSession) return null;

    // Validate that the access token's org claim matches the org we think
    // we're in. A mismatch means stale client state — the token grants
    // access to a different org than intended.
    const org = this.session.organizations.find(o => o.id === this.currentOrgId);
    if (org && !this.tokenMatchesOrg(orgSession.access_token, org.workos_org_id)) {
      // Token is for a different org, or can't be decoded — discard it.
      this.dropOrgSession(this.currentOrgId);
      return null;
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
   * `rejectedAccessToken` is the token the service just answered 401 for. Our
   * local clock said it was fine, so the expiry check above cannot be trusted
   * for it: the result is a token that is NOT that one (another process
   * already refreshed, or a refresh made now), or null if there is none.
   *
   * Returns null if there's no session, no current org, or refresh failed.
   * Callers typically surface that as "you need to re-authenticate".
   */
  async getValidToken(rejectedAccessToken?: string): Promise<ServiceToken | null> {
    if (!this.session || !this.currentOrgId) return null;
    const orgSession = this.session.sessions[this.currentOrgId];
    if (!orgSession) return null;

    if (rejectedAccessToken !== undefined) {
      const replaced = await this.refreshPastRejected(this.currentOrgId, rejectedAccessToken);
      return replaced ? this.getToken() : null;
    }

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
    const data = await this.requestCreateOrg(name, refreshToken);

    const newOrg: Organization = { id: data.id, workos_org_id: data.workos_org_id, name: data.name };

    const withOrg: SessionStore = this.session
      ? {
          ...this.session,
          organizations: [...this.session.organizations, newOrg],
          refresh_token: data.refresh_token || this.session.refresh_token,
        }
      : {
          version: 2,
          user_id: data.user?.id || userId,
          user_email: data.user?.email,
          user_first_name: data.user?.first_name,
          user_last_name: data.user?.last_name,
          refresh_token: data.refresh_token || refreshToken,
          organizations: [newOrg],
          sessions: {},
        };

    const accessToken = data.access_token;
    this.session = accessToken
      ? {
          ...withOrg,
          sessions: {
            ...withOrg.sessions,
            [data.id]: { access_token: accessToken, expires_at: resolveExpiresAt(data.expires_in || 86400, accessToken) },
          },
        }
      : withOrg;
    if (accessToken) this.currentOrgId = data.id;

    this.saveSession();
    return data;
  }

  /** The create-org call. A quota response becomes a CapyError so the quota screen can render it. */
  private async requestCreateOrg(name: string, refreshToken: string): Promise<Organization & {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id: string; email: string; first_name: string | null; last_name: string | null };
  }> {
    try {
      return await postJson(
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
