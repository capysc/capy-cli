import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import { CapyError, ERROR_CODES } from '../types/index';
import { openScreen } from '../ui/openScreen';
import { renderScreen, screenHeaders } from '../ui/screens/serve';
import { emitHandoffUrlEvent } from '../ui/handoffEvent';

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

/**
 * How a deferred callback response is finally answered (CAPY_KEEP_SCREENS).
 * A discriminated union so the ending is always one of exactly three shapes.
 */
export type DeferredCompletion =
  /** Send the browser to a hosted keep-app screen. */
  | { kind: 'redirect'; url: string }
  /** Fall back to today's loopback auth-success screen. */
  | { kind: 'success-screen' }
  /** Fall back to today's loopback auth-error screen. Display-only message. */
  | { kind: 'error-screen'; message: string };

export class OAuthServer {
  private port: number = 0;
  private state: string;
  private server: any;
  private connections: Set<any> = new Set();
  private authorizationCode: string | null = null;
  private error: string | null = null;
  private pkce: { codeVerifier: string; codeChallenge: string };
  /**
   * Deferred-completion mode (CAP-376 keep-screens fork): the successful
   * callback's HTTP response is HELD OPEN instead of being answered with the
   * loopback auth-success screen, and `startAuthFlow` resolves as soon as the
   * code arrives. The caller finishes the token exchange, decides where the
   * browser should land, and settles the held response via
   * `completeDeferred`. Error callbacks (state mismatch, provider error,
   * missing code) are NOT deferred — no session can exist at that point, so
   * they render the loopback error screen exactly as always.
   */
  private deferCompletion: boolean;
  private pendingRes: ServerResponse | null = null;
  private flowResolve: ((code: string) => void) | null = null;

  constructor(opts: { deferCompletion?: boolean } = {}) {
    this.state = randomBytes(32).toString('hex');
    this.pkce = generatePKCE();
    this.deferCompletion = opts.deferCompletion === true;
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
      emitHandoffUrlEvent(authUrl, 'login');

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

      // Deferred mode resolves the flow as soon as the code arrives (the
      // callback response is still held open); the close-time settlement
      // below is then a no-op — a promise settles once.
      this.flowResolve = resolve;

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
    if (this.deferCompletion) {
      // Hold the browser's request open; the caller finishes the exchange and
      // settles it via completeDeferred. The 5-minute flow timeout still
      // bounds this — cleanup() answers any still-held response.
      this.pendingRes = res;
      this.flowResolve?.(code);
      return;
    }
    this.sendSuccessResponse(res);
    this.cleanup();
  }

  /**
   * Settle the held callback response (deferred mode only). Safe to call
   * exactly once; a response that already died (browser gone, timeout fired)
   * degrades to plain cleanup.
   */
  completeDeferred(completion: DeferredCompletion): void {
    const res = this.pendingRes;
    this.pendingRes = null;
    if (res && !res.writableEnded) {
      try {
        if (completion.kind === 'redirect') {
          // 303: the callback GET is done here; the outcome lives at the
          // hosted screen. No screen HTML ever renders on the loopback.
          res.writeHead(303, { Location: completion.url, 'Cache-Control': 'no-store' });
          res.end();
        } else if (completion.kind === 'success-screen') {
          this.sendSuccessResponse(res);
        } else {
          this.sendErrorResponse(res, completion.message);
        }
        // Let the response flush before tearing the sockets down — the same
        // grace ScreenServer gives after serving; a synchronous destroy can
        // cut the redirect off mid-flight.
        setTimeout(() => this.cleanup(), 250);
        return;
      } catch {
        // The socket died under us — nothing left to answer.
      }
    }
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
    // Never leave a deferred browser request hanging: if the flow ends by any
    // path (timeout, error) while a callback response is still held, answer
    // it with the loopback error screen before tearing the server down.
    if (this.pendingRes && !this.pendingRes.writableEnded) {
      try {
        this.sendErrorResponse(this.pendingRes, 'Sign-in could not be completed');
      } catch {
        // Socket already gone.
      }
    }
    this.pendingRes = null;
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