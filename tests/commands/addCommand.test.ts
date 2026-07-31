import { describe, test, expect } from 'bun:test';
import { parseVars, parseHelpUrls, runWebIntake, type SecretPair } from '../../src/commands/addCommand';

describe('parseHelpUrls (repeatable --help-url NAME=URL)', () => {
  test('maps valid http(s) pairs by name', () => {
    expect(
      parseHelpUrls(['STRIPE_SECRET_KEY=https://dashboard.stripe.com/apikeys', 'OPENAI_API_KEY=http://example.com/k']),
    ).toEqual({
      STRIPE_SECRET_KEY: 'https://dashboard.stripe.com/apikeys',
      OPENAI_API_KEY: 'http://example.com/k',
    });
  });

  test('drops non-http(s) URLs and malformed/invalid-name pairs', () => {
    expect(parseHelpUrls(['A=javascript:alert(1)', 'B=ftp://x', 'no-equals', '=https://x', '1BAD=https://x'])).toEqual(
      {},
    );
  });

  test('returns {} for undefined', () => {
    expect(parseHelpUrls(undefined)).toEqual({});
  });
});

describe('parseVars (submitted {name,value}[] payload)', () => {
  test('accepts valid pairs and preserves multiline values', () => {
    expect(
      parseVars([
        { name: 'A', value: 'x' },
        { name: 'B_2', value: 'multi\nline\nvalue' },
      ]),
    ).toEqual([
      { name: 'A', value: 'x' },
      { name: 'B_2', value: 'multi\nline\nvalue' },
    ]);
  });

  test('trims surrounding whitespace on names', () => {
    expect(parseVars([{ name: '  A  ', value: 'x' }])).toEqual([{ name: 'A', value: 'x' }]);
  });

  test('rejects invalid names', () => {
    expect(parseVars([{ name: '1BAD', value: 'x' }])).toBeNull();
    expect(parseVars([{ name: 'has space', value: 'x' }])).toBeNull();
    expect(parseVars([{ name: 'OK', value: 'x' }, { name: 'bad-name', value: 'y' }])).toBeNull();
  });

  test('rejects non-string values (e.g. an empty value or wrong type)', () => {
    expect(parseVars([{ name: 'A', value: 123 }])).toBeNull();
    expect(parseVars([{ name: 'A' }])).toBeNull();
  });

  test('rejects empty arrays and non-arrays', () => {
    expect(parseVars([])).toBeNull();
    expect(parseVars('nope')).toBeNull();
    expect(parseVars(null)).toBeNull();
    expect(parseVars([null])).toBeNull();
  });
});

describe('runWebIntake loopback server (multi-variable contract)', () => {
  test('serves a pre-seeded form, gates the nonce + names, and delivers every pair to onSubmit', async () => {
    let received: SecretPair[] | null = null;
    let url = '';
    const done = runWebIntake(
      {
        vars: [{ name: 'A', helpUrl: 'https://dashboard.stripe.com/apikeys' }, { name: 'B' }],
        open: false,
        onListen: (u) => (url = u),
      },
      async (pairs) => {
        received = pairs;
      },
    );

    // wait for the server to bind + report its URL
    for (let i = 0; i < 100 && !url; i++) await new Promise((r) => setTimeout(r, 10));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?n=[0-9a-f]+$/);

    const u = new URL(url);
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';
    const headers = { 'content-type': 'application/json' };

    // GET: the form is pre-seeded with both suggested names + A's per-variable link
    const form = await fetch(url);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('"A"');
    expect(html).toContain('"B"');
    expect(html).toContain('https://dashboard.stripe.com/apikeys');

    // ...under the interactive screen policy. This page collects credentials, so
    // the browser — not just the page's construction — has to be the thing that
    // stops it reaching a remote origin, being framed, or posting natively.
    const csp = form.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'"); // its own loopback origin, nothing else
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(form.headers.get('referrer-policy')).toBe('no-referrer');
    expect(form.headers.get('cache-control')).toBe('no-store');

    // wrong nonce → 403, nothing delivered
    const bad = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: 'wrong', vars: [{ name: 'A', value: 'x' }] }),
    });
    expect(bad.status).toBe(403);

    // invalid variable name → 400
    const badName = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, vars: [{ name: '1BAD', value: 'x' }] }),
    });
    expect(badName.status).toBe(400);

    // malformed JSON → 400
    const badJson = await fetch(`${base}/submit`, { method: 'POST', headers, body: '{not json' });
    expect(badJson.status).toBe(400);

    expect(received).toBeNull(); // none of the rejected requests reached onSubmit

    // valid multi-var submit → 200; every pair (incl. a multiline value) is delivered
    const ok = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        vars: [
          { name: 'A', value: 'va' },
          { name: 'B', value: 'vb\nmultiline' },
        ],
      }),
    });
    expect(ok.status).toBe(200);

    await done; // resolves once the save succeeds
    expect(received).toEqual([
      { name: 'A', value: 'va' },
      { name: 'B', value: 'vb\nmultiline' },
    ]);
  });
});
