import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import open from 'open';
import { CapyError, ERROR_CODES } from '../types/index';
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
          this.server.listen(candidate, () => {
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

      open(authUrl).then(() => {
        console.log(`✓ Opened browser for authentication`);
      }).catch(() => {
        console.error(`❌ Failed to open browser automatically — use the URL above.`);
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