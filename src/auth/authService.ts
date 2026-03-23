import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
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

  private async startOAuthFlow(organizationId?: string): Promise<AuthResult> {
    const oauthServer = new OAuthServer();
    await oauthServer.bind();

    const state = oauthServer.getState();
    const redirectUri = oauthServer.getRedirectUri();

    // Ask the service for the auth URL (service owns all WorkOS config)
    const initiateData = await postJson<{ auth_url: string }>(
      `${this.serviceApiUrl}/auth/initiate`,
      { state, redirect_uri: redirectUri, organization_id: organizationId },
    );
    const authUrl = initiateData.auth_url;

    // Open browser and capture the code
    const code = await oauthServer.startAuthFlow(authUrl);

    // Send code to service for exchange
    // Service now mints its own JWT (if exactly 1 org) or returns org list
    const { token, user, organizations, _workos_user_id } = await postJson<{
      token: { access_token: string | null; refresh_token: string; expires_in: number };
      user: { id: string; email: string };
      organizations: Organization[];
      _workos_user_id?: string;
    }>(`${this.serviceApiUrl}/auth/exchange`, { code });

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
    // Return with organizations list for the CLI to prompt
    return {
      success: true,
      organizationId: '',
      userId: _workos_user_id || user.id,
      userEmail: user.email,
      organizations: organizations || [],
      // Store refresh token temporarily so we can use it after org selection
      _refreshToken: token.refresh_token,
    };
  }

  /**
   * After the CLI prompts the user to pick an org, call this to get a service JWT.
   */
  async selectOrganization(userId: string, organizationId: string, refreshToken?: string): Promise<void> {
    const data = await postJson<{ access_token: string; expires_in: number }>(
      `${this.serviceApiUrl}/auth/select-org`,
      { user_id: userId, organization_id: organizationId },
    );

    this.serviceToken = {
      access_token: data.access_token,
      refresh_token: refreshToken || '',
      expires_at: Date.now() + (data.expires_in * 1000),
      organization_id: organizationId,
      user_id: userId,
    };
    this.saveToken();
  }

  async refreshToken(): Promise<boolean> {
    if (!this.serviceToken?.refresh_token) {
      return false;
    }

    try {
      const data = await postJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
        `${this.serviceApiUrl}/auth/refresh`,
        {
          refresh_token: this.serviceToken.refresh_token,
          organization_id: this.serviceToken.organization_id,
        },
      );

      this.serviceToken = {
        ...this.serviceToken,
        access_token: data.access_token,
        refresh_token: data.refresh_token || this.serviceToken.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000)
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

  async createOrganization(name: string, userId: string): Promise<Organization> {
    const data = await postJson<Organization & { access_token?: string; expires_in?: number }>(
      `${this.serviceApiUrl}/auth/create-org`,
      { name, user_id: userId },
    );

    // Service now returns a JWT with the new org — save it
    if (data.access_token) {
      this.serviceToken = {
        access_token: data.access_token,
        refresh_token: this.serviceToken?.refresh_token || '',
        expires_at: Date.now() + ((data.expires_in || 86400) * 1000),
        organization_id: data.id,
        user_id: userId,
      };
      this.saveToken();
    }

    return data;
  }

  setOrganizationId(orgId: string): void {
    if (this.serviceToken) {
      this.serviceToken.organization_id = orgId;
      this.saveToken();
    }
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
