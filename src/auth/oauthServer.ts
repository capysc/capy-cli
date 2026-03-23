import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import open from 'open';
import { CapyError, ERROR_CODES } from '../types/index';

const CALLBACK_PORTS = [19420, 19421, 19422, 19423, 19424];

export class OAuthServer {
  private port: number = 0;
  private state: string;
  private server: any;
  private authorizationCode: string | null = null;
  private error: string | null = null;

  constructor() {
    this.state = randomBytes(32).toString('hex');
  }

  getState(): string {
    return this.state;
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
        </head>
        <body class="flex items-center justify-center min-h-screen bg-gray-50">
          <div class="text-center p-8 bg-white rounded-lg shadow-md">
            <div class="text-green-500 text-5xl mb-4">✓</div>
            <h1 class="text-2xl font-semibold text-gray-800 mb-2">Authentication Successful!</h1>
            <p class="text-gray-500">You can now close this window and return to your terminal.</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </div>
        </body>
      </html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private sendErrorResponse(res: ServerResponse, error: string): void {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Failed</title>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="flex items-center justify-center min-h-screen bg-gray-50">
          <div class="text-center p-8 bg-white rounded-lg shadow-md max-w-md">
            <div class="text-red-500 text-5xl mb-4">✗</div>
            <h1 class="text-2xl font-semibold text-gray-800 mb-2">Authentication Failed</h1>
            <p class="text-gray-500 mb-4">Please return to your terminal and try again.</p>
            <div class="bg-red-50 text-red-800 p-3 rounded text-sm">${error}</div>
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