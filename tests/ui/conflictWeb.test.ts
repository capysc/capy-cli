import { describe, test, expect } from 'bun:test';
import { resolveConflictInBrowser } from '../../src/ui/conflictWeb';
import type { ResolveRow } from '../../src/ui/resolveTable';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 200 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const ROWS: ResolveRow[] = [
  { variable: 'API_KEY', pinned: 'sk_...001', local: 'sk_...999', remote: null },
  { variable: 'DATABASE_URL', pinned: 'pos...dev', local: 'pos...ing', remote: null },
];

describe('resolveConflictInBrowser (capy --web conflict resolver)', () => {
  test('renders per-variable rows with snippets and returns the chosen sources', async () => {
    let url = '';
    const done = resolveConflictInBrowser({
      rows: ROWS,
      showLocal: true,
      showRemote: false,
      projectName: 'demo',
      branch: 'development',
      open: false,
      onListen: (u) => (url = u),
    });

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // The page renders both variables, their snippets, and the radio sources —
    // but NEVER a full secret value (snippets only). The screen HTML is embedded
    // as a JS string (injected via innerHTML), so quotes are backslash-escaped;
    // assert on the quote-free tokens that survive that embedding.
    const html = await (await fetch(url)).text();
    expect(html).toContain('API_KEY');
    expect(html).toContain('DATABASE_URL');
    expect(html).toContain('sk_...001'); // pinned snippet
    expect(html).toContain('sk_...999'); // local snippet
    expect(html).toContain('__action');
    // Three-column table (mirrors the CLI): a Variable column + Pinned/Local headers.
    expect(html).toContain('cf-table');
    expect(html).toContain('Variable');
    expect(html).toContain('Pinned');
    expect(html).toContain('Local');

    // Submit: keep PINNED baseline for API_KEY, keep LOCAL edit for DATABASE_URL.
    const r = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: { __action: 'apply', API_KEY: 'pinned', DATABASE_URL: 'local' },
      }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).done).toBe(true);

    expect(await done).toEqual({
      choices: { API_KEY: 'pinned', DATABASE_URL: 'local' },
      cancelled: false,
    });
  });

  test('the cancel form backs out with cancelled:true and no choices', async () => {
    let url = '';
    const done = resolveConflictInBrowser({
      rows: ROWS,
      showLocal: true,
      showRemote: false,
      projectName: 'demo',
      branch: 'development',
      open: false,
      onListen: (u) => (url = u),
    });

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    const r = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect((await r.json()).done).toBe(true);
    expect(await done).toEqual({ choices: {}, cancelled: true });
  });
});
