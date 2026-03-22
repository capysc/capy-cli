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

  constructor(serviceApiUrl: string = process.env.CAPY_API_URL || 'http://localhost:3002', mockMode: boolean = false) {
    this.serviceApiUrl = serviceApiUrl;
    this.mockMode = mockMode;
    this.tokenPath = join(process.cwd(), '.capy', 'token');

    if (this.mockMode) {
      console.log('🔫 AuthService: Mock mode enabled (dev entrypoint)');
    }

    this.loadToken();
  }

  async authenticate(organizationId?: string): Promise<AuthResult> {
    try {
      // Check for mock mode FIRST - skip all other checks
      // Mock mode can only be enabled via the dev entrypoint (bin/capy-dev),
      // not via environment variables, to prevent leaking into production.
      if (this.mockMode) {
        return this.mockAuthenticate(organizationId);
      }

      // Check if we have a valid token and verify it with the service
      if (this.isAuthenticated()) {
        const token = this.getToken();
        if (token) {
          try {
            // Validate token with service
            const response = await axios.get(`${this.serviceApiUrl}/auth/validate`, {
              headers: {
                'Authorization': `Bearer ${token.access_token}`
              }
            });

            const userData = response.data;
            return {
              success: true,
              organizationId: userData.organization_id || token.organization_id,
              organizationName: userData.organization_name,
              userId: userData.user_id || token.user_id,
              userEmail: userData.user_email
            };
          } catch (error) {
            // Token validation failed, clear it and continue with fresh auth
            console.warn('⚠️  Cached token invalid, re-authenticating...');
            this.clearToken();
          }
        }
      }

      // Step 1: Request auth URL from service
      const authUrlResponse = await axios.post(`${this.serviceApiUrl}/auth/initiate`, {
        organization_id: organizationId
      });

      const { auth_url, session_id } = authUrlResponse.data;

      // Step 2: Start local OAuth server to handle callback
      const oauthServer = new OAuthServer();
      const authorizationCode = await oauthServer.startAuthFlow(auth_url);

      // Step 3: Send authorization code to service for token exchange
      const tokenResponse = await axios.post(`${this.serviceApiUrl}/auth/exchange`, {
        code: authorizationCode,
        session_id: session_id
      });

      const { auth_result, token } = tokenResponse.data;

      if (!auth_result.success) {
        return {
          success: false,
          error: auth_result.error || 'Authentication failed'
        };
      }

      // Save token locally
      this.serviceToken = token;
      this.saveToken();

      return {
        success: true,
        organizationId: auth_result.organizationId,
        organizationName: auth_result.organizationName,
        userId: auth_result.userId,
        userEmail: auth_result.userEmail
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Authentication failed'
      };
    }
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
    if (!this.serviceToken) {
      return false;
    }

    // Check if token is expired
    if (this.serviceToken.expires_at < Date.now()) {
      return false;
    }

    return true;
  }

  getToken(): ServiceToken | null {
    return this.serviceToken;
  }

  getOrganizationId(): string | null {
    return this.serviceToken?.organization_id || null;
  }

  private loadToken(): void {
    if (!existsSync(this.tokenPath)) {
      return;
    }

    try {
      const content = readFileSync(this.tokenPath, 'utf-8');
      this.serviceToken = JSON.parse(content);
    } catch {
      // Invalid token file, ignore
    }
  }

  private saveToken(): void {
    if (!this.serviceToken) {
      return;
    }

    try {
      // Ensure .capy directory exists
      const capyDir = dirname(this.tokenPath);
      if (!existsSync(capyDir)) {
        mkdirSync(capyDir, { recursive: true });
      }
      
      const content = JSON.stringify(this.serviceToken, null, 2);
      writeFileSync(this.tokenPath, content, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Failed to save token, continue anyway
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
      // Ignore errors
    }
  }

  private mockAuthenticate(organizationId?: string): AuthResult {
    console.log('🔫 Using mock authentication (CAPY_MOCK_AUTH=true)');

    const mockOrgId = organizationId || 'mock-org-123';
    const mockUserId = 'mock-user-456';

    // Create mock token
    const mockToken: ServiceToken = {
      access_token: 'mock-access-token-' + Math.random().toString(36).substr(2, 9),
      refresh_token: 'mock-refresh-token-' + Math.random().toString(36).substr(2, 9),
      expires_at: Date.now() + (24 * 60 * 60 * 1000), // 24 hours from now
      organization_id: mockOrgId,
      user_id: mockUserId
    };

    // Save mock token
    this.serviceToken = mockToken;
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