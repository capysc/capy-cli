import { jest } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { AuthService } from '../../src/auth/authService';
import { OAuthServer } from '../../src/auth/oauthServer';

// Mock dependencies
jest.mock('fs');
jest.mock('../../src/auth/oauthServer');

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const MockOAuthServer = OAuthServer as jest.MockedClass<typeof OAuthServer>;

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function mockFetchResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('AuthService', () => {
  let authService: AuthService;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Reset all mocks
    jest.clearAllMocks();

    // Reset environment
    delete process.env.CAPY_MOCK_AUTH;
    delete process.env.CAPY_API_URL;

    // Create fresh AuthService instance
    authService = new AuthService();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('constructor', () => {
    test('should use default service URL when no environment variable set', () => {
      const service = new AuthService();
      expect((service as any).serviceApiUrl).toBe('https://api.capy.sc');
    });

    test('should use environment variable for service URL', () => {
      const customUrl = 'https://api.capy.sc';
      const service = new AuthService(customUrl);
      expect((service as any).serviceApiUrl).toBe(customUrl);
    });

    test('should load existing token on initialization', () => {
      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockToken));

      const service = new AuthService();
      expect(service.getToken()).toEqual(mockToken);
    });

    test('should handle invalid token file gracefully', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid-json');

      const service = new AuthService();
      expect(service.getToken()).toBeNull();
    });

    test('should enable mock mode when CAPY_MOCK_AUTH is set and devMode is true', () => {
      process.env.CAPY_MOCK_AUTH = 'true';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      new AuthService(undefined, true);

      expect(consoleSpy).toHaveBeenCalledWith('🔫 AuthService: Mock mode enabled (CAPY_MOCK_AUTH=true)');
      consoleSpy.mockRestore();
    });
  });

  describe('authenticate', () => {
    test('should return existing valid token', async () => {
      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockToken));

      const service = new AuthService();
      const result = await service.authenticate();

      expect(result).toEqual({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: undefined,
        user_first_name: undefined,
        user_last_name: undefined,
        _auth_method: 'cached',
      });
    });

    test('should perform OAuth flow when no valid token exists', async () => {
      // Create a fresh service instance to avoid constructor issues
      mockExistsSync.mockReturnValue(false);
      const service = new AuthService();

      // Mock fetch responses
      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({
          auth_url: 'https://workos.com/auth',
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          token: {
            access_token: 'new-token',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          },
          user: {
            id: 'user-456',
            email: 'test@example.com',
            first_name: null,
            last_name: null,
            organization_id: 'org-123',
            organization_name: 'Test Org',
          },
          organizations: [
            { id: 'org-123', name: 'Test Org' }
          ]
        }));

      // Mock OAuth server
      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123')
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      const result = await service.authenticate('org-123');

      expect(result).toEqual({
        success: true,
        organization_id: 'org-123',
        organization_name: 'Test Org',
        user_id: 'user-456',
        user_email: 'test@example.com',
        user_first_name: null,
        user_last_name: null,
        organizations: [{ id: 'org-123', name: 'Test Org' }],
      });

      expect(mockOAuthInstance.bind).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.capy.sc/auth/initiate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ state: 'mock-state', redirect_uri: 'http://localhost:19420/callback', organization_id: 'org-123', code_challenge: 'mock-code-challenge' }),
        })
      );

      expect(mockOAuthInstance.startAuthFlow).toHaveBeenCalledWith('https://workos.com/auth');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.capy.sc/auth/exchange',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ code: 'auth-code-123', code_verifier: 'mock-code-verifier' }),
        })
      );
    });

    test('should handle authentication failure from service', async () => {
      // Create a fresh service instance
      mockExistsSync.mockReturnValue(false);
      const service = new AuthService();

      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123')
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({
          auth_url: 'https://workos.com/auth',
        }))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: 'Invalid credentials' }, false, 401
        ));

      const result = await service.authenticate();

      expect(result).toEqual({
        success: false,
        error: 'Invalid credentials'
      });
    });

    test('should handle network errors during authentication', async () => {
      // Create a fresh service instance
      mockExistsSync.mockReturnValue(false);
      const service = new AuthService();

      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123')
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.authenticate();

      expect(result).toEqual({
        success: false,
        error: 'Network error'
      });
    });

    test('should use mock authentication when CAPY_MOCK_AUTH is enabled and devMode is true', async () => {
      process.env.CAPY_MOCK_AUTH = 'true';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const service = new AuthService(undefined, true);
      const result = await service.authenticate('test-org');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('test-org');
      expect(result.organization_name).toBe('Mock Organization');
      expect(result.user_id).toBe('mock-user-456');
      expect(result.user_email).toBe('mock.user@example.com');

      expect(consoleSpy).toHaveBeenCalledWith('🔫 Using mock authentication');
      consoleSpy.mockRestore();
    });

    test('should use default organization ID in mock mode', async () => {
      process.env.CAPY_MOCK_AUTH = 'true';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const service = new AuthService(undefined, true);
      const result = await service.authenticate();

      expect(result.organization_id).toBe('mock-org-123');
      consoleSpy.mockRestore();
    });
  });

  describe('isAuthenticated', () => {
    test('should return false when no token exists', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new AuthService();
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return false when token is expired', () => {
      const expiredToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() - 1000, // Expired
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(expiredToken));

      const service = new AuthService();
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return true when token is valid', () => {
      const validToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000, // Valid for 1 hour
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(validToken));

      const service = new AuthService();
      expect(service.isAuthenticated()).toBe(true);
    });
  });

  describe('getToken', () => {
    test('should return current token', () => {
      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockToken));

      const service = new AuthService();
      expect(service.getToken()).toEqual(mockToken);
    });

    test('should return null when no token exists', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new AuthService();
      expect(service.getToken()).toBeNull();
    });
  });

  describe('getOrganizationId', () => {
    test('should return organization ID from token', () => {
      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockToken));

      const service = new AuthService();
      expect(service.getOrganizationId()).toBe('org-123');
    });

    test('should return null when no token exists', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new AuthService();
      expect(service.getOrganizationId()).toBeNull();
    });
  });

  describe('clearToken', () => {
    test('should clear token and delete file', () => {
      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockToken));

      // Mock fs.unlinkSync
      const mockUnlinkSync = jest.fn();
      const fs = require('fs');
      fs.unlinkSync = mockUnlinkSync;

      const service = new AuthService();
      expect(service.getToken()).not.toBeNull();

      service.clearToken();

      expect(service.getToken()).toBeNull();
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('.capy/token'));
    });
  });

  describe('token persistence', () => {
    test('should save token with correct permissions', () => {
      mockExistsSync.mockReturnValue(false);

      const service = new AuthService();

      const mockToken = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      };

      // Set token directly to trigger save
      (service as any).serviceToken = mockToken;
      (service as any).saveToken();

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.capy/token'),
        JSON.stringify(mockToken, null, 2),
        { encoding: 'utf-8', mode: 0o600 }
      );
    });
  });
});
