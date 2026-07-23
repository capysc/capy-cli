import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SCREEN_HTML } from './generated';
import type { ScreenDataMap, ScreenName } from './contract';

/** Serve-time marker baked into every embedded screen by the ui build. */
const DATA_PLACEHOLDER = '/*__CAPY_DATA__*/ null';

/**
 * Strict CSP for locally served screens: no remote origins of any kind, no
 * eval. Screens are single-file documents, so inline script/style is the
 * only thing allowed to run.
 */
export const SCREEN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function screenHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': SCREEN_CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

/**
 * Inline the per-screen payload into the embedded HTML as
 * `window.__CAPY_DATA__`. `<` is escaped in the JSON so payload strings can
 * never break out of the script element (e.g. a "</script>" in an error
 * message).
 */
export function renderScreen<K extends ScreenName>(screen: K, data: ScreenDataMap[K]): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return SCREEN_HTML[screen].replace(DATA_PLACEHOLDER, () => json);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * One-shot local server for CLI-opened browser screens.
 *
 * Security posture:
 *  - binds 127.0.0.1 only (never 0.0.0.0)
 *  - the opened URL carries a single-use 256-bit token; requests without it
 *    (or after first use) get 404 with no body detail
 *  - token comparison is constant-time
 *  - responses carry a strict CSP (no remote origins, no eval)
 *  - server closes itself after serving once, or on timeout
 */
export class ScreenServer<K extends ScreenName> {
  private server: Server | null = null;
  private connections: Set<import('net').Socket> = new Set();
  private token = randomBytes(32).toString('base64url');
  private served = false;
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    private screen: K,
    private data: ScreenDataMap[K],
    private opts: { timeoutMs?: number; closeAfterServe?: boolean } = {},
  ) {}

  /** Start listening and return the tokenized URL to open in the browser. */
  async start(): Promise<string> {
    this.server = createServer(this.handleRequest.bind(this));
    this.server.on('connection', (conn) => {
      this.connections.add(conn);
      conn.on('close', () => this.connections.delete(conn));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    const timeoutMs = this.opts.timeoutMs ?? 120000;
    if (timeoutMs > 0) {
      this.timeout = setTimeout(() => this.close(), timeoutMs);
      this.timeout.unref();
    }

    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}/s/${this.token}`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0];
    const match = path.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    const presented = match ? match[1] : '';
    const valid =
      !this.served &&
      presented.length > 0 &&
      timingSafeEqual(sha256(presented), sha256(this.token));

    if (req.method !== 'GET' || !valid) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    this.served = true;
    res.writeHead(200, screenHeaders());
    res.end(renderScreen(this.screen, this.data));

    if (this.opts.closeAfterServe !== false) {
      // Let the response flush before tearing the server down.
      res.on('finish', () => setTimeout(() => this.close(), 250));
    }
  }

  close(): void {
    if (this.timeout) clearTimeout(this.timeout);
    if (!this.server) return;
    this.server.close();
    for (const conn of this.connections) conn.destroy();
    this.server = null;
  }
}
