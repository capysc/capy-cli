import { describe, test, expect, afterEach } from 'bun:test';
import { get, type IncomingHttpHeaders } from 'http';
import { renderScreen, screenHeaders, ScreenServer, SCREEN_CSP } from '../../src/ui/screens/serve';
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
});
