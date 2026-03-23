import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { WorkOS } from '@workos-inc/node';
import { AuthResult, Organization, ServiceToken, CapyError, ERROR_CODES } from '../types/index';
import { OAuthServer } from './oauthServer';

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
  private tokenPath: string;
  private serviceToken: ServiceToken | null = null;
  private mockMode: boolean;

  constructor(serviceApiUrl?: string, devMode: boolean = false) {
    this.serviceApiUrl = serviceApiUrl || (devMode ? (process.env.CAPY_API_URL || 'http://localhost:3000') : 'https://api.capy.sc');
    // Mock mode requires BOTH dev entrypoint AND explicit env var
    this.mockMode = devMode && process.env.CAPY_MOCK_AUTH === 'true';
    this.tokenPath = join(process.cwd(), '.capy', 'token');

    if (this.mockMode) {
      console.log('🔫 AuthService: Mock mode enabled (CAPY_MOCK_AUTH=true)');
    }

    this.loadToken();
  }

  async authenticate(organizationId?: string): Promise<AuthResult> {
    try {
      // Mock mode — only when dev entrypoint + CAPY_MOCK_AUTH=true
      if (this.mockMode) {
        return this.mockAuthenticate(organizationId);
      }

      // Check for valid cached token
      if (this.isAuthenticated()) {
        const token = this.getToken();
        if (token) {
          return {
            success: true,
            organizationId: token.organization_id,
            userId: token.user_id,
          };
        }
      }

      // Try refresh if we have a refresh token
      if (this.serviceToken?.refresh_token) {
        const refreshed = await this.refreshToken();
        if (refreshed) {
          return {
            success: true,
            organizationId: this.serviceToken!.organization_id,
            userId: this.serviceToken!.user_id,
          };
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

  /**
   * Fetch the WorkOS client ID from the backend.
   */
  private async fetchClientId(): Promise<string> {
    const res = await fetch(`${this.serviceApiUrl}/auth/config`);
    if (!res.ok) {
      throw new CapyError('Failed to fetch auth config from server', ERROR_CODES.NETWORK_ERROR);
    }
    const data = await res.json() as { client_id: string };
    return data.client_id;
  }

  private async startOAuthFlow(organizationId?: string): Promise<AuthResult> {
    // Get client ID from backend (CLI never hardcodes WorkOS config)
    const clientId = await this.fetchClientId();

    // Initialize WorkOS SDK as a public client (no API key, PKCE only)
    const workos = new WorkOS({ clientId });

    const oauthServer = new OAuthServer();
    await oauthServer.bind();
    const redirectUri = oauthServer.getRedirectUri();

    // Generate PKCE auth URL directly with WorkOS SDK
    const { url, state, codeVerifier } = await workos.userManagement.getAuthorizationUrlWithPKCE({
      provider: 'authkit',
      clientId,
      redirectUri,
      organizationId,
    });

    // Use the SDK-generated state for CSRF validation in the callback
    oauthServer.setState(state);

    // Open browser and capture the authorization code
    const code = await oauthServer.startAuthFlow(url);

    // Exchange code directly with WorkOS (PKCE, no client_secret needed)
    const workosAuth = await workos.userManagement.authenticateWithCodeAndVerifier({
      code,
      codeVerifier,
      clientId,
    });

    // Send the WorkOS refresh token to our backend to get a service JWT.
    // The backend verifies identity via WorkOS, resolves org memberships,
    // syncs to DB, and mints a service JWT.
    const { token, user, organizations } = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string };
      organizations: Organization[];
    }>(`${this.serviceApiUrl}/auth/exchange`, { refresh_token: workosAuth.refreshToken });

    // If service returned a JWT (single org), use it directly
    if (token.access_token) {
      const resolvedOrgId = organizations?.length === 1
        ? organizations[0].id
        : '';

      this.serviceToken = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Date.now() + (token.expires_in * 1000),
        organization_id: resolvedOrgId,
        user_id: user.id,
      };
      this.saveToken();

      return {
        success: true,
        organizationId: resolvedOrgId,
        organizationName: organizations?.[0]?.name,
        userId: user.id,
        userEmail: user.email,
        organizations: organizations || [],
      };
    }

    // No JWT yet — user must select an org (0 or >1 orgs)
    // Return with organizations list for the CLI to prompt.
    // The refresh_token is used by createOrganization to prove identity
    // via WorkOS — no raw user_id is ever sent to the server.
    return {
      success: true,
      organizationId: '',
      userId: user.id,
      userEmail: user.email,
      organizations: organizations || [],
      _refreshToken: token.refresh_token,
    };
  }

  async refreshToken(): Promise<boolean> {
    if (!this.serviceToken?.refresh_token) {
      return false;
    }

    try {
      // Refresh the WorkOS token directly via SDK (public client, PKCE mode)
      const clientId = await this.fetchClientId();
      const workos = new WorkOS({ clientId });

      const workosResult = await workos.userManagement.authenticateWithRefreshToken({
        refreshToken: this.serviceToken.refresh_token,
        clientId,
      });

      // Send the fresh WorkOS refresh token to the backend with the org hint.
      // The backend verifies identity, confirms org membership, and mints a service JWT.
      const { token } = await postJson<{
        token: { access_token: string; refresh_token: string; expires_in: number };
      }>(`${this.serviceApiUrl}/auth/exchange`, {
        refresh_token: workosResult.refreshToken,
        organization_id: this.serviceToken.organization_id,
      });

      this.serviceToken = {
        ...this.serviceToken,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Date.now() + (token.expires_in * 1000),
      };

      this.saveToken();
      return true;
    } catch {
      return false;
    }
  }

  isAuthenticated(): boolean {
    if (!this.serviceToken) return false;
    return this.serviceToken.expires_at > Date.now();
  }

  getToken(): ServiceToken | null {
    return this.serviceToken;
  }

  getOrganizationId(): string | null {
    return this.serviceToken?.organization_id || null;
  }

  private loadToken(): void {
    if (!existsSync(this.tokenPath)) return;

    try {
      const content = readFileSync(this.tokenPath, 'utf-8');
      this.serviceToken = JSON.parse(content);
    } catch {
      // Invalid token file, ignore
    }
  }

  private saveToken(): void {
    if (!this.serviceToken) return;

    try {
      const capyDir = dirname(this.tokenPath);
      if (!existsSync(capyDir)) {
        mkdirSync(capyDir, { recursive: true });
      }
      writeFileSync(this.tokenPath, JSON.stringify(this.serviceToken, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Failed to save token
    }
  }

  async createOrganization(name: string, refreshToken: string, userId: string): Promise<Organization> {
    const data = await postJson<Organization & { access_token?: string; refresh_token?: string; expires_in?: number }>(
      `${this.serviceApiUrl}/auth/create-org`,
      { name, refresh_token: refreshToken },
    );

    // Service returns a JWT + fresh refresh token for the new org — save both
    if (data.access_token) {
      this.serviceToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: Date.now() + ((data.expires_in || 86400) * 1000),
        organization_id: data.id,
        user_id: userId,
      };
      this.saveToken();
    }

    return data;
  }

  clearToken(): void {
    this.serviceToken = null;
    try {
      if (existsSync(this.tokenPath)) {
        const fs = require('fs');
        fs.unlinkSync(this.tokenPath);
      }
    } catch {
      // Ignore
    }
  }

  private mockAuthenticate(organizationId?: string): AuthResult {
    console.log('🔫 Using mock authentication');

    const mockOrgId = organizationId || 'mock-org-123';
    const mockUserId = 'mock-user-456';

    this.serviceToken = {
      access_token: 'mock-access-token-' + Math.random().toString(36).substr(2, 9),
      refresh_token: 'mock-refresh-token-' + Math.random().toString(36).substr(2, 9),
      expires_at: Date.now() + (24 * 60 * 60 * 1000),
      organization_id: mockOrgId,
      user_id: mockUserId
    };
    this.saveToken();

    return {
      success: true,
      organizationId: mockOrgId,
      organizationName: 'Mock Organization',
      userId: mockUserId,
      userEmail: 'mock.user@example.com'
    };
  }
}
