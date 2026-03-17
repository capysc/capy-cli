import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import open from 'open';
import { CapyError, ERROR_CODES } from '../types/index';

export class OAuthServer {
  private port: number = 3000;
  private redirectUri: string;
  private state: string;
  private server: any;
  private authorizationCode: string | null = null;
  private error: string | null = null;

  constructor(port: number = 3000) {
    this.port = port;
    this.redirectUri = `http://localhost:${port}/callback`;
    this.state = this.generateState();
  }

  private generateState(): string {
    return randomBytes(32).toString('hex');
  }

  async startAuthFlow(authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this));

      this.server.listen(this.port, async () => {
        console.log(`🔐 Starting OAuth authentication...`);

        try {
          await open(authUrl);
          console.log(`✓ Opened browser for authentication`);
          console.log(`  If the browser didn't open, visit: ${authUrl}`);
        } catch (error) {
          console.error(`❌ Failed to open browser. Please visit: ${authUrl}`);
        }
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
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
            .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .success { color: #22c55e; font-size: 48px; }
            h1 { color: #333; margin: 1rem 0; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✓</div>
            <h1>Authentication Successful!</h1>
            <p>You can now close this window and return to your terminal.</p>
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
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
            .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); max-width: 500px; }
            .error { color: #ef4444; font-size: 48px; }
            h1 { color: #333; margin: 1rem 0; }
            p { color: #666; }
            .error-detail { background: #fef2f2; color: #991b1b; padding: 1rem; border-radius: 4px; margin-top: 1rem; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">❌</div>
            <h1>Authentication Failed</h1>
            <p>Please return to your terminal and try again.</p>
            <div class="error-detail">${error}</div>
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