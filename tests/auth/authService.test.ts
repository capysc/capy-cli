import { mock, spyOn, describe, test, expect, beforeEach, afterEach, afterAll, jest } from 'bun:test';

// Mock dependencies - must come BEFORE imports that use them
mock.module('fs', () => ({
  existsSync: mock(() => false),
  readFileSync: mock(() => ''),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  unlinkSync: mock(() => undefined),
  readdirSync: mock(() => []),
}));

mock.module('proper-lockfile', () => ({
  lockSync: mock(() => undefined),
  unlockSync: mock(() => undefined),
}));

const mockOAuthServerConstructor = mock(() => ({}));
mock.module('../../src/auth/oauthServer', () => ({
  OAuthServer: mockOAuthServerConstructor,
}));

const mockReadAuthSession = mock(() => null);
const mockSaveAuthSession = mock(() => undefined);
const mockGetAuthSessionPath = mock(() => '/home/test/.capy/auth/session.json');
mock.module('../../src/config/globalConfig', () => ({
  readAuthSession: mockReadAuthSession,
  saveAuthSession: mockSaveAuthSession,
  getAuthSessionPath: mockGetAuthSessionPath,
  getGlobalCapyDir: mock(() => '/home/test/.capy'),
  getOrgKeyPath: mock(() => '/home/test/.capy/keys/org'),
  getProjectKeyCachePath: mock(() => '/home/test/.capy/keys/project'),
  getGlobalConfigPath: mock(() => '/home/test/.capy/config.json'),
  saveMasterKey: mock(() => undefined),
  readMasterKey: mock(() => null),
  hasOrgKey: mock(() => false),
  saveProjectKeyCache: mock(() => undefined),
  readProjectKeyCache: mock(() => null),
}));

afterAll(() => { mock.restore(); });

import { existsSync, unlinkSync } from 'fs';
import { AuthService } from '../../src/auth/authService';
import { OAuthServer } from '../../src/auth/oauthServer';
import { SessionStore } from '../../src/types/index';

const mockExistsSync = existsSync as any;
const MockOAuthServer = OAuthServer as any;
const mockUnlinkSync = unlinkSync as any;

// Mock global fetch
const mockFetch = mock(() => Promise.resolve(new Response())) as any;
global.fetch = mockFetch;

function mockFetchResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/**
 * Build a fake JWT with the given claims.
 * Not cryptographically signed — just base64-encoded header.payload.signature
 * so that validateTokenOrg can decode the org_id claim.
 */
function fakeJwt(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-456',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })).toString('base64url');
  const sig = 'fake-signature';
  return `${header}.${payload}.${sig}`;
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
        access_token: fakeJwt({ org_id: 'workos-org-123' }),
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

      const service = new AuthService(undefined, false, 'user-456');
      expect((service as any).session).toBeTruthy();
      expect((service as any).session.user_id).toBe('user-456');
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

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-123');
      expect(result.user_id).toBe('user-456');
      expect(result._auth_method).toBe('cached');
    });

    test('should refresh for a different org when session exists', async () => {
      const session = makeSession();
      mockReadAuthSession.mockReturnValue(session);

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-B' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
        user: { id: 'user-456', email: 'test@example.com', first_name: 'Test', last_name: 'User' },
      }));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate('org-B');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-B');
      expect(result._auth_method).toBe('refreshed');

      const token = service.getToken();
      expect(token?.organization_id).toBe('org-B');
    });

    test('should use any valid session when no org specified', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      const service = new AuthService(undefined, false, 'user-456');
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
          token: { access_token: fakeJwt({ org_id: 'workos-org-123' }), refresh_token: 'new-refresh', expires_in: 3600 },
          user: { id: 'user-456', email: 'test@example.com', first_name: null, last_name: null },
          organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
        }));

      const mockOAuthInstance = {
        bind: mock(() => Promise.resolve(undefined)),
        getState: mock(() => 'mock-state'),
        getRedirectUri: mock(() => 'http://localhost:19420/callback'),
        getCodeChallenge: mock(() => 'mock-code-challenge'),
        getCodeVerifier: mock(() => 'mock-code-verifier'),
        startAuthFlow: mock(() => Promise.resolve('auth-code-123')),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-123');

      expect(mockSaveAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 2,
          user_id: 'user-456',
          sessions: expect.objectContaining({
            'org-123': expect.objectContaining({ access_token: expect.any(String) }),
          }),
        }),
        'user-456',
      );
    });

    test('should handle authentication failure', async () => {
      const service = new AuthService();

      const mockOAuthInstance = {
        bind: mock(() => Promise.resolve(undefined)),
        getState: mock(() => 'mock-state'),
        getRedirectUri: mock(() => 'http://localhost:19420/callback'),
        getCodeChallenge: mock(() => 'mock-code-challenge'),
        getCodeVerifier: mock(() => 'mock-code-verifier'),
        startAuthFlow: mock(() => Promise.resolve('auth-code-123')),
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
        bind: mock(() => Promise.resolve(undefined)),
        getState: mock(() => 'mock-state'),
        getRedirectUri: mock(() => 'http://localhost:19420/callback'),
        getCodeChallenge: mock(() => 'mock-code-challenge'),
        getCodeVerifier: mock(() => 'mock-code-verifier'),
        startAuthFlow: mock(() => Promise.resolve('auth-code-123')),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.authenticate();
      expect(result).toEqual({ success: false, error: 'Network error' });
    });

    test('should refresh expired session for requested org', async () => {
      const session = makeSession({
        sessions: {
          'org-123': { access_token: fakeJwt({ org_id: 'workos-org-123' }), expires_at: Date.now() - 1000 },
        },
      });
      mockReadAuthSession.mockReturnValue(session);

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-123' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      expect(result._auth_method).toBe('refreshed');
      expect(service.getToken()?.access_token).toBeTruthy();
    });
  });

  describe('isAuthenticated', () => {
    test('should return false when no session exists', () => {
      const service = new AuthService();
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return false when no currentOrgId is set', () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService(undefined, false, 'user-456');
      expect(service.isAuthenticated()).toBe(false);
    });

    test('should return true after authenticating with valid session', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService(undefined, false, 'user-456');
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
      const service = new AuthService(undefined, false, 'user-456');
      await service.authenticate('org-123');

      const token = service.getToken();
      expect(token).not.toBeNull();
      expect(token!.organization_id).toBe('org-123');
      expect(token!.user_id).toBe('user-456');
      expect(token!.user_email).toBe('test@example.com');
      expect(token!.refresh_token).toBe('test-refresh');
    });
  });

  describe('getOrganizationId', () => {
    test('should return null when no session', () => {
      const service = new AuthService();
      expect(service.getOrganizationId()).toBeNull();
    });

    test('should return currentOrgId after authenticate', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      const service = new AuthService(undefined, false, 'user-456');
      await service.authenticate('org-123');
      expect(service.getOrganizationId()).toBe('org-123');
    });
  });

  describe('clearToken / clearSession', () => {
    test('should clear session and delete file', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());
      mockExistsSync.mockReturnValue(true);

      const service = new AuthService(undefined, false, 'user-456');
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
        access_token: fakeJwt({ org_id: 'workos-org-abc' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
        user: { id: 'user-456', email: 'test@example.com', first_name: 'Test', last_name: 'User' },
      }));

      const service = new AuthService();
      const result = await service.refreshWithCredentials('some-refresh', 'org-abc', 'user-456');

      expect(result.success).toBe(true);
      expect(result.organization_id).toBe('org-abc');

      const token = service.getToken();
      expect(token?.organization_id).toBe('org-abc');
    });

    test('should return failure when refresh fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const service = new AuthService();
      const result = await service.refreshWithCredentials('bad-refresh', 'org-abc');

      expect(result.success).toBe(false);
    });
  });

  describe('refreshToken', () => {
    test('should refresh the current org session', async () => {
      mockReadAuthSession.mockReturnValue(makeSession());

      const service = new AuthService(undefined, false, 'user-456');
      await service.authenticate('org-123');

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-123' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const result = await service.refreshToken();
      expect(result).toBe(true);
      expect(service.getToken()?.access_token).toBeTruthy();
    });

    test('should return false when no session or currentOrgId', async () => {
      const service = new AuthService();
      const result = await service.refreshToken();
      expect(result).toBe(false);
    });
  });

  // ── Security: token org validation ──────────────────────────────────

  describe('security: token org validation', () => {
    test('should reject cached token whose org_id does not match session org', async () => {
      // Session says org-123 maps to workos-org-123,
      // but the access token has org_id: workos-org-WRONG
      const staleSession = makeSession({
        sessions: {
          'org-123': {
            access_token: fakeJwt({ org_id: 'workos-org-WRONG' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(staleSession);

      // The refresh endpoint will be called because the cached token is rejected
      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-123' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate('org-123');

      expect(result.success).toBe(true);
      // Should have refreshed, not used the stale cached token
      expect(result._auth_method).toBe('refreshed');
      expect(mockFetch).toHaveBeenCalled();
    });

    test('getToken should return null for mismatched org token', async () => {
      const staleSession = makeSession({
        sessions: {
          'org-123': {
            access_token: fakeJwt({ org_id: 'workos-org-WRONG' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(staleSession);

      const service = new AuthService(undefined, false, 'user-456');
      // Manually set currentOrgId to simulate post-authenticate state
      (service as any).currentOrgId = 'org-123';

      // getToken should detect the mismatch and return null
      expect(service.getToken()).toBeNull();
    });

    test('should not use stale token from different org when no org specified', async () => {
      // Session has a token for org-123 but the JWT says it's for a completely different org
      const staleSession = makeSession({
        sessions: {
          'org-123': {
            access_token: fakeJwt({ org_id: 'workos-org-STALE' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(staleSession);

      // Will need to refresh since stale token is rejected
      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-123' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate();

      expect(result.success).toBe(true);
      // Should have refreshed, not used the stale token
      expect(result._auth_method).toBe('refreshed');
    });

    test('fresh OAuth should not carry over old session tokens', async () => {
      // Pre-existing session with a token for org-STALE
      const staleSession = makeSession({
        organizations: [
          { id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' },
          { id: 'org-STALE', workos_org_id: 'workos-org-STALE', name: 'Old Org' },
        ],
        sessions: {
          'org-STALE': {
            access_token: fakeJwt({ org_id: 'workos-org-STALE' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(staleSession);

      const service = new AuthService(undefined, false, 'user-456');

      // Simulate OAuth flow returning a token for org-123
      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ auth_url: 'https://workos.com/auth' }))
        .mockResolvedValueOnce(mockFetchResponse({
          token: { access_token: fakeJwt({ org_id: 'workos-org-123' }), refresh_token: 'new-refresh', expires_in: 3600 },
          user: { id: 'user-456', email: 'test@example.com', first_name: null, last_name: null },
          organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
        }));

      const mockOAuthInstance = {
        bind: mock(() => Promise.resolve(undefined)),
        getState: mock(() => 'mock-state'),
        getRedirectUri: mock(() => 'http://localhost:19420/callback'),
        getCodeChallenge: mock(() => 'mock-code-challenge'),
        getCodeVerifier: mock(() => 'mock-code-verifier'),
        startAuthFlow: mock(() => Promise.resolve('auth-code-123')),
      };
      (MockOAuthServer as any).mockImplementation(() => mockOAuthInstance);

      // Force OAuth by clearing session
      (service as any).session = null;
      const result = await service.authenticate('org-123');
      expect(result.success).toBe(true);

      // The saved session should NOT contain org-STALE
      const savedSession = mockSaveAuthSession.mock.calls[0]?.[0] as SessionStore;
      expect(savedSession.sessions).not.toHaveProperty('org-STALE');
      expect(savedSession.sessions).toHaveProperty('org-123');
    });

    test('authenticateSilent should reject mismatched org tokens', async () => {
      const staleSession = makeSession({
        sessions: {
          'org-123': {
            access_token: fakeJwt({ org_id: 'workos-org-WRONG' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(staleSession);

      // Refresh will also fail (no mock set up)
      mockFetch.mockRejectedValueOnce(new Error('refresh failed'));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticateSilent('org-123');

      // Should NOT return success with the stale token
      expect(result.success).toBe(false);
    });

    test('stale session key from re-provisioned org is pruned on load', () => {
      // Session has a token keyed under 'org-OLD' which isn't in the organizations list
      const staleSession: SessionStore = {
        version: 2,
        user_id: 'user-456',
        user_email: 'test@example.com',
        refresh_token: 'test-refresh',
        organizations: [{ id: 'org-NEW', workos_org_id: 'workos-org-123', name: 'Test Org' }],
        sessions: {
          'org-OLD': {
            access_token: fakeJwt({ org_id: 'workos-org-123' }),
            expires_at: Date.now() + 3600000,
          },
        },
      };
      mockReadAuthSession.mockReturnValue(staleSession);

      const service = new AuthService(undefined, false, 'user-456');
      const session = (service as any).session as SessionStore;

      // The stale key should have been pruned during loadSession
      expect(session.sessions).not.toHaveProperty('org-OLD');
    });

    test('refreshForOrg replaces all sessions with the new one', async () => {
      const session = makeSession({
        organizations: [
          { id: 'org-A', workos_org_id: 'workos-org-A', name: 'Org A' },
          { id: 'org-B', workos_org_id: 'workos-org-B', name: 'Org B' },
        ],
        sessions: {
          'org-A': {
            access_token: fakeJwt({ org_id: 'workos-org-A' }),
            expires_at: Date.now() + 3600000,
          },
        },
      });
      mockReadAuthSession.mockReturnValue(session);

      mockFetch.mockResolvedValueOnce(mockFetchResponse({
        access_token: fakeJwt({ org_id: 'workos-org-B' }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }));

      const service = new AuthService(undefined, false, 'user-456');
      const result = await service.authenticate('org-B');

      expect(result.success).toBe(true);

      // After refreshing into org-B, the old org-A session should be gone
      const savedSession = mockSaveAuthSession.mock.calls[0]?.[0] as SessionStore;
      expect(savedSession.sessions).toHaveProperty('org-B');
      expect(savedSession.sessions).not.toHaveProperty('org-A');
    });
  });
});
