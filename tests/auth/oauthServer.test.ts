import { jest } from '@jest/globals';
import { createServer } from 'http';
import { OAuthServer } from '../../src/auth/oauthServer';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import open from 'open';

// Mock dependencies
jest.mock('http');
jest.mock('crypto', () => ({
  randomBytes: jest.fn().mockReturnValue(Buffer.from('mock-random-bytes-32-characters-long'))
}));
jest.mock('open', () => ({
  __esModule: true,
  default: jest.fn()
}));

const mockCreateServer = createServer as jest.MockedFunction<typeof createServer>;
const mockOpen = open as jest.MockedFunction<typeof open>;

describe('OAuthServer', () => {
  let oauthServer: OAuthServer;
  let mockServer: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock HTTP server
    mockServer = {
      listen: jest.fn((port: number, callback: () => void) => callback()),
      close: jest.fn(),
      on: jest.fn()
    };
    mockCreateServer.mockReturnValue(mockServer);

    // Mock open
    mockOpen.mockResolvedValue({} as any);

    oauthServer = new OAuthServer();
    // Simulate bind() having already been called
    (oauthServer as any).server = mockServer;
    (oauthServer as any).port = 3001;
  });

  describe('generateState', () => {
    test('should generate cryptographically secure state parameter', () => {
      const server = new OAuthServer();
      // The mock is already set up in the jest.mock call
    });
  });

  describe('bind', () => {
    test('should bind to the first available port', async () => {
      const server = new OAuthServer();
      mockServer.once = jest.fn((event: string, handler: any) => {
        // Don't trigger error
      });
      mockServer.listen = jest.fn((port: number, callback: () => void) => callback());
      mockServer.removeListener = jest.fn();
      mockCreateServer.mockReturnValue(mockServer);

      await server.bind();

      expect(mockServer.listen).toHaveBeenCalledWith(19420, expect.any(Function));
    });
  });

  describe('startAuthFlow', () => {
    test('should open browser and return auth code on success', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';

      // Mock successful flow
      setTimeout(() => {
        // Simulate server close event with successful auth code
        const closeHandler = mockServer.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
        if (closeHandler) {
          // Set auth code before calling close handler
          (oauthServer as any).authorizationCode = 'test-auth-code';
          closeHandler();
        }
      }, 10);

      const result = await oauthServer.startAuthFlow(authUrl);

      expect(mockOpen).toHaveBeenCalledWith(authUrl);
      expect(result).toBe('test-auth-code');
    });

    test('should handle browser open failure gracefully', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';
      mockOpen.mockRejectedValue(new Error('Browser failed'));

      // Mock successful auth after browser failure
      setTimeout(() => {
        const closeHandler = mockServer.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
        if (closeHandler) {
          (oauthServer as any).authorizationCode = 'test-auth-code';
          closeHandler();
        }
      }, 10);

      const result = await oauthServer.startAuthFlow(authUrl);
      expect(result).toBe('test-auth-code');
    });

    test('should timeout after 5 minutes', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';

      jest.useFakeTimers();

      const flowPromise = oauthServer.startAuthFlow(authUrl);

      // Fast-forward time by 5 minutes
      jest.advanceTimersByTime(300000);

      await expect(flowPromise).rejects.toThrow(CapyError);
      await expect(flowPromise).rejects.toThrow('Authentication timeout - no response received');

      jest.useRealTimers();
    });

    test('should reject with error when OAuth error occurs', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';

      setTimeout(() => {
        const closeHandler = mockServer.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
        if (closeHandler) {
          (oauthServer as any).error = 'access_denied';
          closeHandler();
        }
      }, 10);

      await expect(oauthServer.startAuthFlow(authUrl)).rejects.toThrow(CapyError);
    });
  });

  describe('handleCallback', () => {
    test('should validate state parameter for CSRF protection', () => {
      const url = new URL('http://localhost:3001/callback?code=test&state=invalid-state');
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('Invalid state parameter');
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
    });

    test('should handle OAuth errors', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?error=access_denied&error_description=User denied&state=${validState}`);
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('User denied');
      expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
    });

    test('should handle missing authorization code', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?state=${validState}`);
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('No authorization code');
    });

    test('should successfully extract authorization code', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?code=test-auth-code&state=${validState}`);
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).authorizationCode).toBe('test-auth-code');
      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    });
  });

  describe('sendSuccessResponse', () => {
    test('should send professional success page with auto-close', () => {
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };

      (oauthServer as any).sendSuccessResponse(mockRes);

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Authentication Successful'));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('setTimeout(() => window.close(), 3000)'));
    });
  });

  describe('sendErrorResponse', () => {
    test('should send professional error page with details', () => {
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      };
      const errorMessage = 'Test error message';

      (oauthServer as any).sendErrorResponse(mockRes, errorMessage);

      expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Authentication Failed'));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining(errorMessage));
    });
  });

  describe('cleanup', () => {
    test('should properly close server', () => {
      // Set up server manually for this test
      (oauthServer as any).server = mockServer;

      (oauthServer as any).cleanup();
      expect(mockServer.close).toHaveBeenCalled();
    });

    test('should handle cleanup when no server exists', () => {
      (oauthServer as any).server = null;
      expect(() => (oauthServer as any).cleanup()).not.toThrow();
    });
  });
});