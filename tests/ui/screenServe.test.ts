import { describe, test, expect, afterEach } from 'bun:test';
import { renderScreen, screenHeaders, ScreenServer, SCREEN_CSP } from '../../src/ui/screens/serve';
import { SCREEN_HTML } from '../../src/ui/screens/generated';

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

    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-security-policy')).toBe(SCREEN_CSP);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = await first.text();
    expect(body).toContain('window.__CAPY_DATA__ = {"autoCloseSeconds":0}');

    // One-time token: same URL is dead after first use.
    const second = await fetch(url);
    expect(second.status).toBe(404);
  });

  test('rejects requests with a missing or wrong token', async () => {
    server = new ScreenServer('auth-success', { autoCloseSeconds: 0 }, { closeAfterServe: false });
    const url = new URL(await server.start());

    const noToken = await fetch(`${url.origin}/`);
    expect(noToken.status).toBe(404);

    const wrongToken = await fetch(`${url.origin}/s/${'A'.repeat(43)}`);
    expect(wrongToken.status).toBe(404);

    // The real token still works after failed attempts.
    const real = await fetch(url);
    expect(real.status).toBe(200);
  });

  test('screen headers are strict', () => {
    const headers = screenHeaders();
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).not.toContain('http');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });
});
