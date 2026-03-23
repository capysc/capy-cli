import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { AuthResult, ServiceToken, CapyError, ERROR_CODES } from '../types/index';
import { OAuthServer } from './oauthServer';

export class AuthService {
  private serviceApiUrl: string;
  private tokenPath: string;
  private serviceToken: ServiceToken | null = null;
  private mockMode: boolean;

  constructor(serviceApiUrl: string = process.env.CAPY_API_URL || 'http://localhost:3000', devMode: boolean = false) {
    this.serviceApiUrl = serviceApiUrl;
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
    const oauthServer = new OAuthServer(3001);
    const state = oauthServer.getState();

    // Ask the service for the auth URL (service owns all WorkOS config)
    const initiateResponse = await axios.post(`${this.serviceApiUrl}/auth/initiate`, {
      state,
      redirect_uri: 'http://localhost:3001/callback',
      organization_id: organizationId,
    });
    const authUrl = initiateResponse.data.auth_url;

    // Open browser and capture the code
    const code = await oauthServer.startAuthFlow(authUrl);

    // Send code to service for exchange (service has the API key)
    const response = await axios.post(`${this.serviceApiUrl}/auth/exchange`, { code });
    const { token, user } = response.data;

    this.serviceToken = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + (token.expires_in * 1000),
      organization_id: user.organization_id || organizationId || '',
      user_id: user.id,
    };
    this.saveToken();

    return {
      success: true,
      organizationId: this.serviceToken.organization_id,
      organizationName: user.organization_name,
      userId: user.id,
      userEmail: user.email,
    };
  }

  async refreshToken(): Promise<boolean> {
    if (!this.serviceToken?.refresh_token) {
      return false;
    }

    try {
      const response = await axios.post(`${this.serviceApiUrl}/auth/refresh`, {
        refresh_token: this.serviceToken.refresh_token
      });

      this.serviceToken = {
        ...this.serviceToken,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || this.serviceToken.refresh_token,
        expires_at: Date.now() + (response.data.expires_in * 1000)
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
