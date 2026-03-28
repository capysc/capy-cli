import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import open from 'open';
import { CapyError, ERROR_CODES } from '../types/index';

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

      open(authUrl).then(() => {
        console.log(`✓ Opened browser for authentication`);
        console.log(`  If the browser didn't open, visit: ${authUrl}`);
      }).catch(() => {
        console.error(`❌ Failed to open browser. Please visit: ${authUrl}`);
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
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Successful</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
          <script>
            tailwind.config = {
              darkMode: 'media',
              theme: { extend: { fontFamily: { geist: ['Geist', 'system-ui', 'sans-serif'] } } }
            }
          </script>
        </head>
        <body class="flex items-center justify-center min-h-screen dark:bg-neutral-950 font-geist">
          <div class="text-center p-8 rounded-lg border border-neutral-200 dark:border-neutral-800 dark:text-white">
            <div class="flex justify-center mb-6 dark:invert"><svg width="48" height="48" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#s0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="s0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg></div>
            <h1>Authentication Successful</h1>
            <p>You can now close this window and return to your terminal.</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </div>
        </body>
      </html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private sendErrorResponse(res: ServerResponse, _error: string): void {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Failed</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
          <script>
            tailwind.config = {
              darkMode: 'media',
              theme: { extend: { fontFamily: { geist: ['Geist', 'system-ui', 'sans-serif'] } } }
            }
          </script>
        </head>
        <body class="flex items-center justify-center min-h-screen dark:bg-neutral-950 font-geist">
          <div class="text-center p-8 rounded-lg border border-neutral-200 dark:border-neutral-800 max-w-md dark:text-white">
            <div class="flex justify-center mb-6 dark:invert"><svg width="48" height="48" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#e0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="e0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg></div>
            <h1>Authentication Failed</h1>
            <p>Please return to your terminal and try again.</p>
            <div class="text-neutral-500">Something went wrong. Check your terminal for details.</div>
          </div>
        </body>
      </html>
    `;

    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private cleanup(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}