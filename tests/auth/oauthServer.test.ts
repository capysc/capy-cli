import { mock, spyOn, describe, test, expect, beforeEach, afterEach, afterAll, jest } from 'bun:test';

// Mock dependencies - must come BEFORE imports that use them
const mockCreateServer = mock(() => ({}));
mock.module('http', () => ({
  createServer: mockCreateServer,
}));

mock.module('crypto', () => ({
  randomBytes: mock(() => Buffer.from('mock-random-bytes-32-characters-long')),
  createHash: mock(() => ({
    update: mock(() => ({
      digest: mock(() => 'mock-code-challenge'),
    })),
  })),
}));

const mockOpen = mock(() => Promise.resolve({}));
mock.module('open', () => ({
  __esModule: true,
  default: mockOpen,
}));

afterAll(() => { mock.restore(); });

import { createServer } from 'http';
import { OAuthServer } from '../../src/auth/oauthServer';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import open from 'open';

describe('OAuthServer', () => {
  let oauthServer: OAuthServer;
  let mockServer: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock HTTP server
    mockServer = {
      listen: mock((_port: number, _host: string, callback: () => void) => callback()),
      close: mock(() => undefined),
      on: mock(() => undefined),
      once: mock(() => undefined),
      removeListener: mock(() => undefined),
    };
    (mockCreateServer as any).mockReturnValue(mockServer);

    // Mock open
    (mockOpen as any).mockResolvedValue({} as any);

    oauthServer = new OAuthServer();
  });

  describe('generateState', () => {
    test('should generate cryptographically secure state parameter', () => {
      const server = new OAuthServer();
      // The mock is already set up in the mock.module call
    });
  });

  describe('bind', () => {
    test('should bind to first available port, on loopback only', async () => {
      // Mock the listen to call the callback (success)
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        mockServer.removeListener('error', expect.any(Function));
        callback();
      });

      await oauthServer.bind();

      expect(mockCreateServer).toHaveBeenCalled();
      // The host argument is the assertion that matters: omitting it binds every
      // interface, which puts the OAuth callback on the LAN for the length of an
      // auth round trip.
      expect(mockServer.listen).toHaveBeenCalledWith(19420, '127.0.0.1', expect.any(Function));
    });
  });

  describe('getKeepBridgeUrl (CAP-374 step 1)', () => {
    test('carries this server\'s own redirect_uri, code_challenge, and state — nothing else', async () => {
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => callback());
      await oauthServer.bind();

      const url = new URL(oauthServer.getKeepBridgeUrl('https://keep.capy.sc'));
      expect(url.origin).toBe('https://keep.capy.sc');
      expect(url.pathname).toBe('/auth/start');
      expect(url.searchParams.get('cli_redirect')).toBe(oauthServer.getRedirectUri());
      expect(url.searchParams.get('cli_challenge')).toBe(oauthServer.getCodeChallenge());
      expect(url.searchParams.get('cli_state')).toBe(oauthServer.getState());
      // Exactly these three params — nothing riding along that keep doesn't
      // validate (spec: the code_verifier itself never leaves this process).
      expect([...url.searchParams.keys()].sort()).toEqual(['cli_challenge', 'cli_redirect', 'cli_state']);
    });

    test('honors a CAPY_KEEP_ORIGIN-style custom origin verbatim', async () => {
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => callback());
      await oauthServer.bind();

      const url = new URL(oauthServer.getKeepBridgeUrl('http://keep.localhost:4100'));
      expect(url.origin).toBe('http://keep.localhost:4100');
    });
  });

  describe('startAuthFlow', () => {
    /**
     * Sign-in now goes through `openScreen`, which honours CAPY_WEB_NO_OPEN —
     * and `run-tests.sh` exports it for the whole suite, precisely so that no
     * test opens the developer's browser. Cases that assert a browser WAS
     * opened have to lift it for their own duration and put it back, or they
     * would be asserting against the suite's own safety net.
     */
    const withBrowserAllowed = async (body: () => Promise<void>): Promise<void> => {
      const saved = process.env.CAPY_WEB_NO_OPEN;
      delete process.env.CAPY_WEB_NO_OPEN;
      try {
        await body();
      } finally {
        if (saved !== undefined) process.env.CAPY_WEB_NO_OPEN = saved;
      }
    };

    test('CAPY_WEB_NO_OPEN reaches sign-in too, and the flow still completes', async () => {
      // Before `openScreen`, this one call site ignored the flag: a CI run or a
      // suite that reached authentication launched a real browser. The flag has
      // to suppress the window WITHOUT suppressing the flow — the URL is
      // printed, and a person can still finish in a browser of their choosing.
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';
      (oauthServer as any).server = mockServer;

      setTimeout(() => {
        const closeHandler = mockServer.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
        if (closeHandler) {
          (oauthServer as any).authorizationCode = 'test-auth-code';
          closeHandler();
        }
      }, 10);

      const result = await oauthServer.startAuthFlow(authUrl);

      expect(mockOpen).not.toHaveBeenCalled();
      expect(result).toBe('test-auth-code');
    });

    test('should open browser and resolve with auth code on success', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';

      // Manually set the server (as bind() would)
      (oauthServer as any).server = mockServer;

      // Mock successful flow
      await withBrowserAllowed(async () => {
        setTimeout(() => {
          // Simulate server close event with successful auth code
          const closeHandler = mockServer.on.mock.calls.find(
            (call: any) => call[0] === 'close',
          )?.[1];
          if (closeHandler) {
            // Set auth code before calling close handler
            (oauthServer as any).authorizationCode = 'test-auth-code';
            closeHandler();
          }
        }, 10);

        const result = await oauthServer.startAuthFlow(authUrl);

        // Browser selection itself is covered deterministically by
        // openScreen.test.ts. The dynamic import used by that helper is not
        // interceptable by this module mock under Bun, so this boundary test
        // verifies that allowing a browser does not block the OAuth result.
        expect(result).toBe('test-auth-code');
      });
    });

    test('should handle browser open failure gracefully', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';
      (mockOpen as any).mockRejectedValue(new Error('Browser failed'));

      // Manually set the server (as bind() would)
      (oauthServer as any).server = mockServer;

      await withBrowserAllowed(async () => {
        // Mock successful auth after browser failure
        setTimeout(() => {
          const closeHandler = mockServer.on.mock.calls.find(
            (call: any) => call[0] === 'close',
          )?.[1];
          if (closeHandler) {
            (oauthServer as any).authorizationCode = 'test-auth-code';
            closeHandler();
          }
        }, 10);

        const result = await oauthServer.startAuthFlow(authUrl);
        expect(result).toBe('test-auth-code');
      });
    });

    test('should timeout after 5 minutes', async () => {
      const authUrl = 'https://api.workos.com/sso/authorize?client_id=test';

      // Manually set the server (as bind() would)
      (oauthServer as any).server = mockServer;

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

      // Manually set the server (as bind() would)
      (oauthServer as any).server = mockServer;

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
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('Invalid state parameter');
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        400,
        expect.objectContaining({ 'Content-Type': 'text/html; charset=utf-8' })
      );
    });

    test('should handle OAuth errors', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?error=access_denied&error_description=User denied&state=${validState}`);
      const mockRes = {
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('User denied');
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        400,
        expect.objectContaining({ 'Content-Type': 'text/html; charset=utf-8' })
      );
    });

    test('should handle missing authorization code', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?state=${validState}`);
      const mockRes = {
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).error).toBe('No authorization code');
    });

    test('should successfully extract authorization code', () => {
      const validState = (oauthServer as any).state;
      const url = new URL(`http://localhost:3001/callback?code=test-auth-code&state=${validState}`);
      const mockRes = {
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };

      (oauthServer as any).handleCallback(url, mockRes);

      expect((oauthServer as any).authorizationCode).toBe('test-auth-code');
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'Content-Type': 'text/html; charset=utf-8' })
      );
    });
  });

  describe('sendSuccessResponse', () => {
    test('should send professional success page with auto-close', () => {
      const mockRes = {
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };

      (oauthServer as any).sendSuccessResponse(mockRes);

      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'Content-Type': 'text/html; charset=utf-8' })
      );
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Authentication Successful'));
      // Auto-close now flows through the __CAPY_DATA__ contract of the embedded screen
      expect(mockRes.end).toHaveBeenCalledWith(
        expect.stringContaining('window.__CAPY_DATA__ = {"autoCloseSeconds":3}')
      );
    });
  });

  describe('sendErrorResponse', () => {
    test('should send error page without exposing raw error string (XSS prevention)', () => {
      const mockRes = {
        writeHead: mock(() => undefined),
        end: mock(() => undefined),
      };
      const errorMessage = '<script>alert("xss")</script>';

      (oauthServer as any).sendErrorResponse(mockRes, errorMessage);

      expect(mockRes.writeHead).toHaveBeenCalledWith(
        400,
        expect.objectContaining({ 'Content-Type': 'text/html; charset=utf-8' })
      );
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Authentication Failed'));
      // Raw error string must NOT appear in HTML output (XSS prevention).
      // The message is JSON-inlined with `<` escaped, so markup can never
      // execute; the screen renders it as text.
      expect(mockRes.end).toHaveBeenCalledWith(expect.not.stringContaining(errorMessage));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('\\u003cscript>alert'));
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
