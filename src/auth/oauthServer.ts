import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import { CapyError, ERROR_CODES } from '../types/index';
import { openScreen } from '../ui/openScreen';
import { renderScreen, screenHeaders } from '../ui/screens/serve';

const CALLBACK_PORTS = [19420, 19421, 19422, 19423, 19424];

/**
 * Generate a PKCE code verifier and S256 code challenge.
 * The verifier stays on the CLI; only the challenge is sent to the server.
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636: 43-128 unreserved characters
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export class OAuthServer {
  private port: number = 0;
  private state: string;
  private server: any;
  private connections: Set<any> = new Set();
  private authorizationCode: string | null = null;
  private error: string | null = null;
  private pkce: { codeVerifier: string; codeChallenge: string };

  constructor() {
    this.state = randomBytes(32).toString('hex');
    this.pkce = generatePKCE();
  }

  getState(): string {
    return this.state;
  }

  getCodeChallenge(): string {
    return this.pkce.codeChallenge;
  }

  getCodeVerifier(): string {
    return this.pkce.codeVerifier;
  }

  getRedirectUri(): string {
    return `http://localhost:${this.port}/callback`;
  }

  /**
   * Bind to the first available port from the candidate list.
   * Must be called before startAuthFlow.
   *
   * Loopback ONLY — the host argument is load-bearing, not decoration. Omitting
   * it binds every interface, and the callback handler is meant to be reachable
   * from this machine and nowhere else. `state` gates what the handler accepts,
   * but the surface itself should never be exposed beyond loopback. Every local
   * server in this CLI pins 127.0.0.1 for the same reason.
   *
   * The redirect URI keeps saying `localhost` because the service validates
   * the string it was handed at /auth/initiate. Browsers resolve localhost to
   * both ::1 and 127.0.0.1 and fall through to the second on connection
   * refused, so an IPv4-only bind still receives the callback.
   */
  async bind(): Promise<void> {
    this.server = createServer(this.handleRequest.bind(this));

    // Track connections so we can force-close them on cleanup
    this.server.on('connection', (conn: any) => {
      this.connections.add(conn);
      conn.on('close', () => this.connections.delete(conn));
    });

    for (const candidate of CALLBACK_PORTS) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(candidate, '127.0.0.1', () => {
            this.server.removeListener('error', reject);
            resolve();
          });
        });
        this.port = candidate;
        return;
      } catch {
        // Port in use, try next
      }
    }

    throw new CapyError(
      `Could not bind to any callback port (tried ${CALLBACK_PORTS.join(', ')})`,
      ERROR_CODES.AUTH_FAILED
    );
  }

  async startAuthFlow(authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      console.log(`🔐 Starting OAuth authentication...`);

      // Always print the URL up front so it's available even if the browser
      // never opens (no TTY, headless, --web driven through the MCP, or `open`
      // silently failing). The auto-open below is a best-effort convenience.
      console.log('');
      console.log(`  If the browser doesn't open, visit:`);
      console.log(`  ${authUrl}`);
      console.log('');

      // `handoff`, and it is the ONLY handoff in the CLI: sign-in is the one
      // page we do not serve. The person needs the address bar to check where
      // they are being asked for a password, and needs to be able to move the
      // window to whichever profile their session lives in — a chromeless
      // popup takes both away. Going through the helper also puts this call
      // behind CAPY_WEB_NO_OPEN for the first time; before, a suite or CI run
      // that reached authentication opened the developer's own browser.
      void openScreen(authUrl, { kind: 'handoff' }).then((plan) => {
        if (plan.via !== 'suppressed') console.log(`✓ Opened browser for authentication`);
      });

      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new CapyError(
          'Authentication timeout - no response received',
          ERROR_CODES.AUTH_FAILED
        ));
      }, 300000); // 5 minutes timeout

      this.server.on('close', () => {
        clearTimeout(timeout);

        if (this.error) {
          reject(new CapyError(
            `Authentication failed: ${this.error}`,
            ERROR_CODES.AUTH_FAILED
          ));
        } else if (this.authorizationCode) {
          resolve(this.authorizationCode);
        } else {
          reject(new CapyError(
            'Authentication cancelled',
            ERROR_CODES.AUTH_FAILED
          ));
        }
      });
    });
  }


  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);

    if (url.pathname === '/callback') {
      this.handleCallback(url, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private handleCallback(url: URL, res: ServerResponse): void {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (state !== this.state) {
      this.sendErrorResponse(res, 'Invalid state parameter - possible CSRF attack');
      this.error = 'Invalid state parameter';
      this.cleanup();
      return;
    }

    if (error) {
      this.sendErrorResponse(res, errorDescription || error);
      this.error = errorDescription || error;
      this.cleanup();
      return;
    }

    if (!code) {
      this.sendErrorResponse(res, 'No authorization code received');
      this.error = 'No authorization code';
      this.cleanup();
      return;
    }

    this.authorizationCode = code;
    this.sendSuccessResponse(res);
    this.cleanup();
  }

  private sendSuccessResponse(res: ServerResponse): void {
    res.writeHead(200, screenHeaders());
    res.end(renderScreen('auth-success', { autoCloseSeconds: 3 }));
  }

  private sendErrorResponse(res: ServerResponse, error: string): void {
    res.writeHead(400, screenHeaders());
    res.end(renderScreen('auth-error', { message: error }));
  }

  private cleanup(): void {
    if (this.server) {
      this.server.close();
      // Destroy all open connections immediately (don't wait for keep-alive timeout)
      for (const conn of this.connections) {
        conn.destroy();
      }
      this.connections.clear();
      this.server = null;
    }
  }
}