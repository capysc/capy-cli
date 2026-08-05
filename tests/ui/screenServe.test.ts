import { describe, test, expect, afterEach } from 'bun:test';
import { get, type IncomingHttpHeaders } from 'http';
import { renderScreen, screenHeaders, ScreenServer, SCREEN_CSP, INTERACTIVE_SCREEN_CSP } from '../../src/ui/screens/serve';
import { SCREEN_HTML } from '../../src/ui/screens/generated';

/**
 * Plain node http.get instead of fetch: CI runners route fetch through an
 * egress proxy (HTTP_PROXY env), which intercepts even loopback requests and
 * answers 403 itself. http.get connects to 127.0.0.1 directly, so these
 * tests observe the server, not the runner's proxy.
 */
function request(
  url: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    }).on('error', reject);
  });
}

describe('renderScreen', () => {
  test('inlines the payload into the __CAPY_DATA__ placeholder', () => {
    const html = renderScreen('auth-error', { message: 'nope' });
    expect(html).toContain('window.__CAPY_DATA__ = {"message":"nope"}');
    expect(html).not.toContain('/*__CAPY_DATA__*/ null');
  });

  test('escapes < so payloads cannot break out of the script element', () => {
    const html = renderScreen('auth-error', { message: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  test('payloads with replacement-pattern dollars are inlined verbatim', () => {
    const html = renderScreen('auth-error', { message: "$' $` $&" });
    expect(html).toContain('{"message":"$\' $` $&"}');
  });

  test('every embedded screen carries the placeholder', () => {
    for (const html of Object.values(SCREEN_HTML)) {
      expect(html).toContain('/*__CAPY_DATA__*/ null');
    }
  });

  test('embedded screens reference no external URLs', () => {
    for (const html of Object.values(SCREEN_HTML)) {
      for (const match of html.matchAll(/\bhttps?:\/\/[^\s"'`<>\\)]+/g)) {
        expect(match[0]).toMatch(
          /^https?:\/\/(127\.0\.0\.1|localhost)|^http:\/\/www\.w3\.org\/|^https:\/\/svelte\.dev\/e\//
        );
      }
    }
  });
});

describe('ScreenServer', () => {
  let server: ScreenServer<'auth-success'> | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  test('binds 127.0.0.1 and serves the screen once with the token', async () => {
    server = new ScreenServer('auth-success', { autoCloseSeconds: 0 }, { closeAfterServe: false });
    const url = await server.start();
    expect(url).toStartWith('http://127.0.0.1:');

    const first = await request(url);
    expect(first.status).toBe(200);
    expect(first.headers['content-security-policy']).toBe(SCREEN_CSP);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toContain('window.__CAPY_DATA__ = {"autoCloseSeconds":0}');

    // One-time token: same URL is dead after first use.
    const second = await request(url);
    expect(second.status).toBe(404);
  });

  test('delivered stays pending until a browser has actually read the page', async () => {
    // `start()` resolves on LISTENING, which is what every ending call site
    // had — and an ending is followed by the command exiting, so the page went
    // into a socket that closed microseconds later. This is the fact those
    // callers actually need.
    server = new ScreenServer('auth-success', { autoCloseSeconds: 0 }, { closeAfterServe: false });
    const url = await server.start();

    let settled: boolean | undefined;
    void server.delivered.then((v) => (settled = v));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeUndefined();

    expect((await request(url)).status).toBe(200);
    expect(await server.delivered).toBe(true);
  });

  test('a server that closes unread releases its waiter with false', async () => {
    // The ceiling for a browser that never comes: the work being reported is
    // already over, so the command must not be held open by a page nobody is
    // reading.
    server = new ScreenServer('auth-success', { autoCloseSeconds: 0 }, { timeoutMs: 40 });
    await server.start();
    expect(await server.delivered).toBe(false);
  });

  test('rejects requests with a missing or wrong token', async () => {
    server = new ScreenServer('auth-success', { autoCloseSeconds: 0 }, { closeAfterServe: false });
    const url = new URL(await server.start());

    const noToken = await request(`${url.origin}/`);
    expect(noToken.status).toBe(404);

    const wrongToken = await request(`${url.origin}/s/${'A'.repeat(43)}`);
    expect(wrongToken.status).toBe(404);

    // The real token still works after failed attempts.
    const real = await request(url.href);
    expect(real.status).toBe(200);
  });

  test('screen headers are strict', () => {
    const headers = screenHeaders();
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).not.toContain('http');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  test('a display screen cannot open a socket, and that is the default', () => {
    // The load-bearing line: a page that renders a secret and cannot connect
    // anywhere cannot exfiltrate it, whatever ends up in its markup.
    expect(screenHeaders()['Content-Security-Policy']).toContain("connect-src 'none'");
    // Opt-in, so forgetting to think about it fails closed.
    expect(screenHeaders({})['Content-Security-Policy']).toBe(SCREEN_CSP);
    expect(screenHeaders({ interactive: false })['Content-Security-Policy']).toBe(SCREEN_CSP);
  });

  test('an interactive screen may reach its own origin and nothing else', () => {
    const csp = screenHeaders({ interactive: true })['Content-Security-Policy'];
    expect(csp).toBe(INTERACTIVE_SCREEN_CSP);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("connect-src 'none'");
    // Widening connect-src must be the ONLY difference, or "interactive"
    // quietly becomes a way to opt out of the whole header.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Native form posts stay off in both modes: an interactive screen answers
    // through fetch, which connect-src governs. An open form-action would be a
    // second way out of the page, under a directive nobody is watching.
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('http');
    expect(csp).not.toContain('unsafe-eval');
    // Same directives, same order — only the connect-src value differs.
    expect(csp.replace("connect-src 'self'", "connect-src 'none'")).toBe(SCREEN_CSP);
  });
});
