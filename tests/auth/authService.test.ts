import { jest } from '@jest/globals';
import { existsSync } from 'fs';
import { AuthService } from '../../src/auth/authService';
import { OAuthServer } from '../../src/auth/oauthServer';
import { SessionStore } from '../../src/types/index';

// Mock dependencies
jest.mock('fs');
jest.mock('proper-lockfile', () => ({
  lockSync: jest.fn(),
  unlockSync: jest.fn(),
}));
jest.mock('../../src/auth/oauthServer');
jest.mock('../../src/config/globalConfig', () => ({
  readAuthSession: jest.fn().mockReturnValue(null),
  saveAuthSession: jest.fn(),
  getAuthSessionPath: jest.fn().mockReturnValue('/home/test/.capy/auth/session.json'),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const MockOAuthServer = OAuthServer as jest.MockedClass<typeof OAuthServer>;

// Import mocked globalConfig functions
import { readAuthSession, saveAuthSession, getAuthSessionPath } from '../../src/config/globalConfig';
const mockReadAuthSession = readAuthSession as jest.MockedFunction<typeof readAuthSession>;
const mockSaveAuthSession = saveAuthSession as jest.MockedFunction<typeof saveAuthSession>;
const mockGetAuthSessionPath = getAuthSessionPath as jest.MockedFunction<typeof getAuthSessionPath>;

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

function makeSession(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    version: 2,
    user_id: 'user-456',
    user_email: 'test@example.com',
    refresh_token: 'test-refresh',
    organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
    sessions: {
      'org-123': {
        access_token: 'test-token',
        expires_at: Date.now() + 3600000,
      },
    },
    ...overrides,
  };
}

describe('AuthService', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.clearAllMocks();
    delete process.env.CAPY_MOCK_AUTH;
    delete process.env.CAPY_API_URL;

    mockGetAuthSessionPath.mockReturnValue('/home/test/.capy/auth/session.json');
    mockReadAuthSession.mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    test('should use default service URL when no environment variable set', () => {
      const service = new AuthService();
      expect((service as any).serviceApiUrl).toBe('https://api.capy.sc');
    });

    test('should use provided service URL', () => {
      const service = new AuthService('https://custom.api.com');
      expect((service as any).serviceApiUrl).toBe('https://custom.api.com');
    });

    test('should load existing session on initialization', () => {
      const session = makeSession();
      mockReadAuthSession.mockReturnValue(session);

      const service = new AuthService();
      // Session is loaded but no currentOrgId yet until authenticate() is called
      expect((service as any).session).toEqual(session);
    });

    test('should handle invalid session file gracefully', () => {
      mockReadAuthSession.mockImplementation(() => { throw new Error('bad json'); });

      const service = new AuthService();
      expect(service.getToken()).toBeNull();
    });

    test('should ignore non-v2 session data', () => {
      mockReadAuthSession.mockReturnValue({ access_token: 'old-format' });

      const service = new AuthService();
      expect((service as any).session).toBeNull();
    });
  });

  describe('authenticate', () => {
    test('should return cached session for matching org', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      const service = new AuthService();
      const result = await service.authenticate('org-123');

      expect(result).toEqual({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com',
        user_first_name: undefined,
        user_last_name: undefined,
        organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
        _auth_method: 'cached',
      });
    });

    test('should refresh for a different org when session exists', async () => {
      const session = makeSession();
      mockReadAuthSession.mockReturnValue(session);

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'org-b-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        user: { id: 'user-456', email: 'test@example.com', first_name: 'Test', last_name: 'User' },
      }));

      const service = new AuthService();
      const result = await service.authenticate('org-B');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-B');
      expect(result._auth_method).toBe('refreshed');

      // Both org sessions should exist
      const token = service.getToken();
      expect(token?.access_token).toBe('org-b-token');
      expect(token?.organization_id).toBe('org-B');

      // Verify the session was saved with both orgs
      expect(mockSaveAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.objectContaining({
            'org-123': expect.any(Object),
            'org-B': expect.objectContaining({ access_token: 'org-b-token' }),
          }),
        }),
        expect.anything(),
      );
    });

    test('should use any valid session when no org specified', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      const service = new AuthService();
      const result = await service.authenticate();

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-123');
      expect(result._auth_method).toBe('cached');
    });

    test('should perform OAuth flow when no session exists', async () => {
      const service = new AuthService();

      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ auth_url: 'https://workos.com/auth' }))
        .mockResolvedValueOnce(mockFetchResponse({
          token: { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 },
          user: { id: 'user-456', email: 'test@example.com', first_name: null, last_name: null },
          organizations: [{ id: 'org-123', name: 'Test Org' }],
        }));

      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123'),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-123');

      // Session should be saved in new format
      expect(mockSaveAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 2,
          user_id: 'user-456',
          sessions: expect.objectContaining({
            'org-123': expect.objectContaining({ access_token: 'new-token' }),
          }),
        }),
        expect.anything(),
      );
    });

    test('should handle authentication failure', async () => {
      const service = new AuthService();

      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123'),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ auth_url: 'https://workos.com/auth' }))
        .mockResolvedValueOnce(mockFetchResponse({ error: 'Invalid credentials' }, false, 401));

      const result = await service.authenticate();

      expect(result).toEqual({ success: false, error: 'Invalid credentials' });
    });

    test('should handle network errors', async () => {
      const service = new AuthService();

      const mockOAuthInstance = {
        bind: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getState: jest.fn().mockReturnValue('mock-state'),
        getRedirectUri: jest.fn().mockReturnValue('http://localhost:19420/callback'),
        getCodeChallenge: jest.fn().mockReturnValue('mock-code-challenge'),
        getCodeVerifier: jest.fn().mockReturnValue('mock-code-verifier'),
        startAuthFlow: jest.fn<() => Promise<string>>().mockResolvedValue('auth-code-123'),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.authenticate();
      expect(result).toEqual({ success: false, error: 'Network error' });
    });

    test('should refresh expired session for requested org', async () => {
      const session = makeSession({
        sessions: {
          'org-123': { access_token: 'expired-token', expires_at: Date.now() - 1000 },
        },
      });
      mockReadAuthSession.mockReturnValue(session);

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'fresh-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService();
      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      expect(result._auth_method).toBe('refreshed');
      expect(service.getToken()?.access_token).toBe('fresh-token');
    });
  });

  describe('isAuthenticated', () => {
    test('should return false when no session exists', () => {
      const service = new AuthService();
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return false when no currentOrgId is set', () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService();
      // Session loaded but currentOrgId not set until authenticate()
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return true after authenticating with valid session', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService();
      await service.authenticate('org-123');
      expect(service.isAuthenticated()).toBe(true);
    });
  });

  describe('getToken', () => {
    test('should return null when no session exists', () => {
      const service = new AuthService();
      expect(service.getToken()).toBeNull();
    });

    test('should assemble ServiceToken from session after authenticate', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService();
      await service.authenticate('org-123');

      const token = service.getToken();
      expect(token).toEqual({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: expect.any(Number),
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com',
        user_first_name: undefined,
        user_last_name: undefined,
        organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
      });
    });
  });

  describe('getOrganizationId', () => {
    test('should return null when no session', () => {
      const service = new AuthService();
      expect(service.getOrganizationId()).toBeNull();
    });

    test('should return currentOrgId after authenticate', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService();
      await service.authenticate('org-123');
      expect(service.getOrganizationId()).toBe('org-123');
    });
  });

  describe('clearToken / clearSession', () => {
    test('should clear session and delete file', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      mockExistsSync.mockReturnValue(true);

      const { unlinkSync } = require('fs');
      const mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>;

      const service = new AuthService();
      await service.authenticate('org-123');
      expect(service.getToken()).not.toBeNull();

      service.clearToken();

      expect(service.getToken()).toBeNull();
      expect(service.getOrganizationId()).toBeNull();
      expect(mockUnlinkSync).toHaveBeenCalledWith('/home/test/.capy/auth/session.json');
    });
  });

  describe('refreshWithCredentials', () => {
    test('should bootstrap session and refresh for org', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'org-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        user: { id: 'user-456', email: 'test@example.com', first_name: 'Test', last_name: 'User' },
      }));

      const service = new AuthService();
      const result = await service.refreshWithCredentials('some-refresh', 'org-abc', 'user-456');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-abc');

      const token = service.getToken();
      expect(token?.access_token).toBe('org-token');
      expect(token?.organization_id).toBe('org-abc');

      expect(mockSaveAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 2,
          sessions: expect.objectContaining({
            'org-abc': expect.objectContaining({ access_token: 'org-token' }),
          }),
        }),
        expect.anything(),
      );
    });

    test('should update existing session refresh token', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'org-b-token',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService();
      const result = await service.refreshWithCredentials('explicit-refresh', 'org-B', 'user-456');

      expect(result.success).toBe(true);

      // Session should have both orgs and updated refresh token
      expect(mockSaveAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          refresh_token: 'rotated-refresh',
          sessions: expect.objectContaining({
            'org-123': expect.any(Object),
            'org-B': expect.objectContaining({ access_token: 'org-b-token' }),
          }),
        }),
        expect.anything(),
      );
    });

    test('should return failure when refresh fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const service = new AuthService();
      const result = await service.refreshWithCredentials('bad-refresh', 'org-abc');

      expect(result.success).toBe(false);
    });
  });

  describe('multi-org sessions', () => {
    test('should maintain sessions for multiple orgs', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      // Refresh for a second org
      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'org-b-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService();

      // First authenticate with org-123 (cached)
      await service.authenticate('org-123');
      expect(service.getToken()?.access_token).toBe('test-token');

      // Then authenticate with org-B (requires refresh)
      await service.authenticate('org-B');
      expect(service.getToken()?.access_token).toBe('org-b-token');
      expect(service.getOrganizationId()).toBe('org-B');

      // Switch back to org-123 (cached, no refresh needed)
      mockFetch.mockClear();
      await service.authenticate('org-123');
      expect(service.getToken()?.access_token).toBe('test-token');
      expect(service.getOrganizationId()).toBe('org-123');

      // No fetch calls needed — both sessions are cached
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('should not corrupt other org sessions when switching', async () => {
      const session = makeSession({
        sessions: {
          'org-A': { access_token: 'token-A', expires_at: Date.now() + 3600000 },
          'org-B': { access_token: 'token-B', expires_at: Date.now() + 3600000 },
        },
        organizations: [
          { id: 'org-A', workos_org_id: 'workos-A', name: 'Org A' },
          { id: 'org-B', workos_org_id: 'workos-B', name: 'Org B' },
        ],
      });
      mockReadAuthSession.mockReturnValue(session);

      const service = new AuthService();

      await service.authenticate('org-A');
      expect(service.getToken()?.access_token).toBe('token-A');

      await service.authenticate('org-B');
      expect(service.getToken()?.access_token).toBe('token-B');

      // Verify org-A session wasn't modified
      await service.authenticate('org-A');
      expect(service.getToken()?.access_token).toBe('token-A');
    });
  });

  describe('refreshToken', () => {
    test('should refresh the current org session', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      const service = new AuthService();
      await service.authenticate('org-123');

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: 'refreshed-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const result = await service.refreshToken();
      expect(result).toBe(true);
      expect(service.getToken()?.access_token).toBe('refreshed-token');
    });

    test('should return false when no session or currentOrgId', async () => {
      const service = new AuthService();
      const result = await service.refreshToken();
      expect(result).toBe(false);
    });
  });
});
