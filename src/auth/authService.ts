import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { lockSync, unlockSync } from 'proper-lockfile';
import { AuthResult, Organization, ServiceToken, SessionStore, CapyError, ERROR_CODES } from '../types/index';
import { OAuthServer } from './oauthServer';
import { saveAuthSession, readAuthSession, getAuthSessionPath } from '../config/globalConfig';

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export class AuthService {
  private serviceApiUrl: string;
  private sessionUserId: string | undefined;
  private session: SessionStore | null = null;
  private currentOrgId: string | null = null;

  constructor(serviceApiUrl?: string, devMode: boolean = false, sessionUserId?: string) {
    this.serviceApiUrl = serviceApiUrl || (devMode ? (process.env.CAPY_API_URL || 'http://localhost:3000') : 'https://api.capy.sc');
    this.sessionUserId = sessionUserId;
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
        if (orgSession && orgSession.expires_at > Date.now()) {
          this.currentOrgId = organizationId;
          return this.buildAuthResult('cached');
        }
        // Try refreshing for this org
        if (this.session.refresh_token) {
          const refreshed = await this.refreshForOrg(organizationId);
          if (refreshed) {
            return this.buildAuthResult('refreshed');
          }
        }
      }

      // If we have a session with no specific org requested, use any valid session
      if (this.session && !organizationId) {
        // Find a valid session
        for (const [orgId, orgSession] of Object.entries(this.session.sessions)) {
          if (orgSession.expires_at > Date.now()) {
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

      // Full OAuth flow
      return await this.startOAuthFlow(organizationId);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Authentication failed'
      };
    }
  }

  private async startOAuthFlow(organizationId?: string): Promise<AuthResult> {
    const oauthServer = new OAuthServer();
    await oauthServer.bind();
    const redirectUri = oauthServer.getRedirectUri();
    const state = oauthServer.getState();

    const { auth_url } = await postJson<{ auth_url: string }>(
      `${this.serviceApiUrl}/auth/initiate`,
      {
        state,
        redirect_uri: redirectUri,
        organization_id: organizationId,
        code_challenge: oauthServer.getCodeChallenge(),
      },
    );

    const code = await oauthServer.startAuthFlow(auth_url);

    const { token, user, organizations } = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string; first_name: string | null; last_name: string | null };
      organizations: Organization[];
    }>(`${this.serviceApiUrl}/auth/exchange`, {
      code,
      code_verifier: oauthServer.getCodeVerifier(),
    });

    // Initialize or update session
    this.session = {
      version: 2,
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      refresh_token: token.refresh_token,
      organizations: organizations || [],
      sessions: this.session?.sessions || {},
    };

    // If service returned a JWT (single org), store the session
    if (token.access_token) {
      const resolvedOrgId = organizations?.length === 1
        ? organizations[0].id
        : '';

      if (resolvedOrgId) {
        this.session.sessions[resolvedOrgId] = {
          access_token: token.access_token,
          expires_at: Date.now() + (token.expires_in * 1000),
        };
        this.currentOrgId = resolvedOrgId;
      }

      this.saveSession();

      return {
        success: true,
        organization_id: resolvedOrgId,
        organization_name: organizations?.[0]?.name,
        user_id: user.id,
        user_email: user.email,
        user_first_name: user.first_name,
        user_last_name: user.last_name,
        organizations: organizations || [],
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

  private async refreshForOrg(orgId: string): Promise<boolean> {
    if (!this.session?.refresh_token) return false;

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
      }>(
        `${this.serviceApiUrl}/auth/refresh`,
        {
          refresh_token: this.session.refresh_token,
          organization_id: orgId,
        },
      );

      this.session.sessions[orgId] = {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in * 1000),
      };
      this.session.refresh_token = data.refresh_token;

      if (data.user) {
        this.session.user_id = data.user.id;
        this.session.user_email = data.user.email;
        this.session.user_first_name = data.user.first_name;
        this.session.user_last_name = data.user.last_name;
      }

      this.currentOrgId = orgId;
      this.saveSession();
      return true;
    } catch {
      return false;
    } finally {
      if (release) {
        try { release(); } catch { /* ignore */ }
      }
    }
  }

  isAuthenticated(): boolean {
    if (!this.session || !this.currentOrgId) return false;
    const s = this.session.sessions[this.currentOrgId];
    return !!s && s.expires_at > Date.now();
  }

  getToken(): ServiceToken | null {
    if (!this.session || !this.currentOrgId) return null;
    const orgSession = this.session.sessions[this.currentOrgId];
    if (!orgSession) return null;
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

  getOrganizationId(): string | null {
    return this.currentOrgId;
  }

  async createOrganization(name: string, refreshToken: string, userId: string): Promise<Organization> {
    const data = await postJson<Organization & {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { id: string; email: string; first_name: string | null; last_name: string | null };
    }>(
      `${this.serviceApiUrl}/auth/create-org`,
      { name, refresh_token: refreshToken },
    );

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
        expires_at: Date.now() + ((data.expires_in || 86400) * 1000),
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
    if (!this.sessionUserId) return; // No user ID — require fresh login
    try {
      const data = readAuthSession(this.sessionUserId) as SessionStore | null;
      if (data && data.version === 2) {
        this.session = data;
      }
    } catch {
      // Invalid session file, ignore
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
