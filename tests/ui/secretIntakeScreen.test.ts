/**
 * `capy add --web`, now the compiled `secret-intake` screen.
 *
 * Replaces intakePage.test.ts. What the hand-written page could do is kept —
 * the form is pre-seeded with the suggested names and each variable's own
 * "where to find this" link, a bad nonce delivers nothing, and every pair
 * reaches `onSubmit` with its multi-line value intact. What it could not do is
 * added: a `javascript:` help link never reaches the page, an illegal variable
 * name is refused rather than encrypted, and the values do not appear in the
 * document the CLI serves.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildSecretIntakeData,
  parseVars,
  runWebIntake,
  vendorDomainFor,
  safeHttpUrl,
  type SecretPair,
} from '../../src/ui/secretIntakeScreen';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

describe('safeHttpUrl', () => {
  test('only http(s) survives — a model supplies these links', () => {
    expect(safeHttpUrl('https://dashboard.stripe.com/apikeys')).toBe('https://dashboard.stripe.com/apikeys');
    expect(safeHttpUrl('  http://example.com/k  ')).toBe('http://example.com/k');
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>')).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
  });
});

describe('vendorDomainFor', () => {
  test('the help link is the strongest signal, stripped to the registrable domain', () => {
    expect(vendorDomainFor({ name: 'ANYTHING', helpUrl: 'https://dashboard.stripe.com/apikeys' })).toBe('stripe.com');
  });

  test('falls back to a token in the variable name, which is all a bare terminal has', () => {
    expect(vendorDomainFor({ name: 'STRIPE_SECRET_KEY' })).toBe('stripe.com');
  });

  test('an unknown or ambiguous variable gets no mark rather than a guess', () => {
    expect(vendorDomainFor({ name: 'MY_SERVICE_TOKEN' })).toBeUndefined();
    // A wrong logo beside a credential box is a claim about where the value
    // should come from.
    expect(vendorDomainFor({ name: 'STRIPE_OPENAI_KEY' })).toBeUndefined();
  });
});

describe('buildSecretIntakeData', () => {
  test('seeds the suggested names, their links and their vendor marks', () => {
    const d = buildSecretIntakeData(
      {
        vars: [{ name: 'STRIPE_SECRET_KEY', helpUrl: 'https://dashboard.stripe.com/apikeys' }, { name: 'PLAIN' }],
        open: false,
      },
      'n',
    );
    expect(d.vars[0]).toMatchObject({ name: 'STRIPE_SECRET_KEY', helpUrl: 'https://dashboard.stripe.com/apikeys' });
    expect(d.vars[0].logo).toContain('<svg');
    expect(d.vars[1]).toEqual({ name: 'PLAIN' });
  });

  test('a javascript: help link is dropped before it can reach an anchor', () => {
    const d = buildSecretIntakeData({ vars: [{ name: 'A', helpUrl: 'javascript:alert(1)' }], open: false }, 'n');
    expect(d.vars[0].helpUrl).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('javascript:');
  });

  test('the payload carries names and never a value — there are none yet to carry', () => {
    const d = buildSecretIntakeData({ vars: [{ name: 'A' }], reason: 'Stripe is not configured', open: false }, 'n');
    expect(d.reason).toBe('Stripe is not configured');
    expect(d.nonce).toBe('n');
    // The one step no flag can ever answer, said out loud.
    expect(d.nonTty?.command).toBe('capy add --non-tty');
  });
});

describe('parseVars', () => {
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

  test('rejects non-string values (e.g. a wrong type, or none at all)', () => {
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

describe('runWebIntake', () => {
  test('serves the compiled screen, gates the nonce, and delivers every pair', async () => {
    let received: SecretPair[] | null = null;
    let url = '';
    const done = runWebIntake(
      {
        vars: [{ name: 'A', helpUrl: 'https://dashboard.stripe.com/apikeys' }, { name: 'B' }],
        open: false,
        onListen: (u) => (url = u),
        timeoutMs: 8_000,
      },
      async (pairs) => {
        received = pairs;
      },
    );

    const u = new URL(await waitForUrl(() => url));
    expect(u.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?n=[0-9a-f]+$/);
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole and pre-seeded.
    const form = await fetch(u.href);
    const html = await form.text();
    // ...and served under the interactive screen policy. This page collects
    // credentials, so the browser — not just the page's construction — has to
    // be the thing that stops it reaching a remote origin, being framed, or
    // posting natively. `browserWizard` sets these; asserting them here is what
    // catches the intake losing them.
    const csp = form.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'"); // its own loopback origin, nothing else
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(form.headers.get('referrer-policy')).toBe('no-referrer');
    expect(form.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('window.__CAPY_DATA__');
    expect(html).toContain('"A"');
    expect(html).toContain('"B"');
    expect(html).toContain('https://dashboard.stripe.com/apikeys');

    // wrong nonce → 403, nothing delivered
    const bad = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: 'wrong', payload: { vars: [{ name: 'A', value: 'x' }] } }),
    });
    expect(bad.status).toBe(403);

    // An illegal name is refused inline rather than encrypted: the screen
    // refuses it while it is typed and holds its button, so this can only come
    // from something that is not the screen.
    const badName = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { vars: [{ name: '1BAD', value: 'x' }] } }),
    });
    expect((await badName.json()).error).toContain('valid NAME');

    // malformed JSON → 400
    const badJson = await fetch(`${base}/submit`, { method: 'POST', headers, body: '{not json' });
    expect(badJson.status).toBe(400);

    expect(received).toBeNull(); // none of the rejected requests reached onSubmit

    const ok = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: {
          vars: [
            { name: 'A', value: 'va' },
            { name: 'B', value: 'vb\nmultiline' },
          ],
        },
      }),
    });
    expect(ok.status).toBe(200);

    await done;
    expect(received).toEqual([
      { name: 'A', value: 'va' },
      { name: 'B', value: 'vb\nmultiline' },
    ]);
  });

  test('a save that fails keeps the form live with the reason', async () => {
    // The save runs INSIDE the request, so the browser learns whether it really
    // happened rather than celebrating and losing the values.
    let url = '';
    let attempts = 0;
    const done = runWebIntake(
      { vars: [{ name: 'A' }], open: false, onListen: (u) => (url = u), timeoutMs: 8_000 },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Could not reach the Capy service.');
      },
    );

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const body = JSON.stringify({ nonce, payload: { vars: [{ name: 'A', value: 'x' }] } });

    const failed = await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain('Could not reach the Capy service');

    const retried = await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    expect(retried.status).toBe(200);
    await done;
    expect(attempts).toBe(2);
  });
});
