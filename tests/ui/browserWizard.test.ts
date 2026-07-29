import { describe, test, expect } from 'bun:test';
import { runBrowserWizard } from '../../src/ui/browserWizard';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 200 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

describe('runBrowserWizard loopback server', () => {
  test('serves the first screen, gates nonce/origin, advances through steps, and returns the result', async () => {
    let url = '';
    const seen: Array<{ step: number; payload: Record<string, unknown> }> = [];
    const done = runBrowserWizard(
      {
        title: 'Set up Capy',
        firstScreen: { html: '<form><input name="org" value="acme"><button type="submit">next</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (step, payload) => {
        seen.push({ step, payload });
        if (step === 0) return { screen: { html: '<form id="s2"><input name="project" value="web"><button type="submit">finish</button></form>' } };
        return { done: true, result: { org: seen[0].payload.org, project: payload.project } };
      },
    );

    const u0 = new URL(await waitForUrl(() => url));
    expect(`${u0.protocol}//${u0.host}${u0.pathname}`).toBe(`http://127.0.0.1:${u0.port}/`);
    const base = `http://127.0.0.1:${u0.port}`;
    const nonce = u0.searchParams.get('n') ?? '';

    // GET the page: 200, carries the nonce + title.
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(nonce);
    expect(html).toContain('Set up Capy');

    // GET with a wrong nonce → 403.
    expect((await fetch(`${base}/?n=wrong`)).status).toBe(403);

    // POST with a present-but-wrong Origin → 403 (DNS-rebind guard).
    const badOrigin = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://evil.com' },
      body: JSON.stringify({ nonce, payload: { org: 'acme' } }),
    });
    expect(badOrigin.status).toBe(403);

    // POST with a wrong nonce → 403, nothing delivered.
    expect((await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce: 'wrong', payload: {} }) })).status).toBe(403);
    expect(seen.length).toBe(0);

    // Step 0 submit → 200, returns the next screen's HTML.
    const r0 = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { org: 'acme' } }) });
    expect(r0.status).toBe(200);
    const b0 = await r0.json();
    expect(b0.screen).toContain('name="project"');
    expect(b0.done).toBeUndefined();

    // Step 1 submit → 200 done.
    const r1 = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { project: 'web' } }) });
    expect(r1.status).toBe(200);
    expect((await r1.json()).done).toBe(true);

    const result = await done;
    expect(result).toEqual({ org: 'acme', project: 'web' });
    expect(seen.map((s) => s.step)).toEqual([0, 1]);
  });

  test('an inline error keeps the wizard open (no done, no result)', async () => {
    let url = '';
    let resolved = false;
    const done = runBrowserWizard(
      {
        title: 'T',
        firstScreen: { html: '<form><input name="x"><button type="submit">go</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        if (!payload.x) return { error: 'x is required' };
        return { done: true, result: payload };
      },
    );
    void done.then(() => (resolved = true));

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Missing field → inline error, 200, NOT done.
    const err = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });
    expect(err.status).toBe(200);
    expect((await err.json()).error).toBe('x is required');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // Now a valid submit finishes it.
    const ok = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { x: 'v' } }) });
    expect((await ok.json()).done).toBe(true);
    expect(await done).toEqual({ x: 'v' });
  });

  test('a screen may submit a structured payload, not just flat form fields', async () => {
    // The reason `window.capySubmit` exists. FormData flattens to string keys
    // and string values, so a step whose answer is a decision per variable —
    // the conflict resolver — or an array of name/value pairs — secret intake
    // — could only travel by encoding structure into field NAMES and having
    // the reducer parse it back out. This asserts the reducer receives the
    // shape the screen sent, nested and typed, over the same endpoint.
    let url = '';
    let received: Record<string, unknown> | undefined;
    const done = runBrowserWizard(
      {
        title: 'Resolve conflicts',
        firstScreen: { html: '<div id="resolver"></div>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        received = payload;
        return { done: true, result: payload };
      },
    );

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    const structured = {
      resolutions: [
        { key: 'STRIPE_KEY', take: 'remote' },
        { key: 'DATABASE_URL', take: 'local' },
      ],
      applyToAll: false,
      count: 2,
    };
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: structured }),
    });
    expect((await res.json()).done).toBe(true);
    await done;

    // Arrays stay arrays, booleans stay booleans, numbers stay numbers — none
    // of which survives a FormData round trip.
    expect(received).toEqual(structured);
    expect(Array.isArray((received as { resolutions: unknown }).resolutions)).toBe(true);
    expect((received as { applyToAll: unknown }).applyToAll).toBe(false);
    expect((received as { count: unknown }).count).toBe(2);
  });

  test('the page exposes capySubmit and still serializes plain forms', async () => {
    // Both entry points must be present: the JSON path is additive, and every
    // hand-written screen on this branch is a form.
    let url = '';
    const done = runBrowserWizard(
      {
        title: 'Both paths',
        firstScreen: { html: '<form><button type="submit">go</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async () => ({ done: true, result: {} }),
    );

    const html = await (await fetch(await waitForUrl(() => url))).text();
    expect(html).toContain('window.capySubmit');
    // The delegated form handler survives — it is what the existing screens use.
    expect(html).toContain('new FormData(form)');
    // One transport, not two: both paths reach the same POST, so the nonce and
    // the response contract cannot drift apart per screen technology.
    expect(html.match(/fetch\('\/submit'/g) ?? []).toHaveLength(1);

    const u = new URL(url);
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: u.searchParams.get('n'), payload: {} }),
    });
    await done;
  });
});
