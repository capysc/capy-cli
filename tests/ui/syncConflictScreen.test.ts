/**
 * The sync conflict resolver, now served as a compiled screen.
 *
 * Replaces conflictWeb.test.ts. The behaviour that mattered there is kept —
 * snippets only, never a full value; the user's choices reach the caller — and
 * the things the old browser path could not do are added, because they are the
 * reason it was replaced:
 *
 *   - the whole-run menu reaches the browser at all (it used to be discarded
 *     and `individual` forced in its place)
 *   - `unresolvable` travels as a boolean rather than an ANSI-escaped literal
 *     a value could impersonate
 */
import { describe, test, expect } from 'bun:test';
import { buildConflictData, resolveConflictInBrowser } from '../../src/ui/syncConflictScreen';
import type { ConflictAction } from '../../src/ui/screens/contract';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const ACTIONS: ConflictAction[] = [
  { value: 'commit_local', label: 'Commit and push all local values' },
  { value: 'retrieve_pinned', label: 'Retrieve all pinned values' },
  { value: 'individual', label: 'Individually resolve' },
  { value: 'skip', label: 'Continue working' },
];

const BASE = {
  unresolvable: new Set<string>(),
  showLocal: true,
  showRemote: true,
  localMode: false,
  isOnboarding: false,
  isBehind: false,
  remoteState: 'ok' as const,
  actions: ACTIONS,
  projectName: 'mikes-market',
  branch: 'development',
  open: false,
};

const ROWS = [
  { variable: 'STRIPE_KEY', pinned: 'sk_…001', local: 'sk_…002', remote: 'sk_…003' },
  { variable: 'DB_URL', pinned: 'pos…dev', local: 'pos…loc', remote: null },
];

describe('buildConflictData', () => {
  test('carries the CLI menu verbatim, so both surfaces read the same', () => {
    const d = buildConflictData({ ...BASE, rows: ROWS }, 'n');
    expect(d.actions).toEqual(ACTIONS);
    // Order is the CLI's recommendation, not an alphabetisation.
    expect(d.actions.map((a) => a.value)).toEqual([
      'commit_local',
      'retrieve_pinned',
      'individual',
      'skip',
    ]);
  });

  test('unresolvable is a boolean, not a value that could be impersonated', () => {
    const d = buildConflictData(
      { ...BASE, rows: ROWS, unresolvable: new Set(['DB_URL']) },
      'n',
    );
    expect(d.rows.find((r) => r.variable === 'DB_URL')!.pinnedUnresolvable).toBe(true);
    expect(d.rows.find((r) => r.variable === 'STRIPE_KEY')!.pinnedUnresolvable).toBe(false);
  });

  test('strips the terminal colour codes off snippets', () => {
    const d = buildConflictData(
      { ...BASE, rows: [{ variable: 'A', pinned: '\x1b[3msk_…1\x1b[0m', local: null, remote: null }] },
      'n',
    );
    expect(d.rows[0].pinned).toBe('sk_…1');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('declares the whole route, and marks a stop this run cannot reach', () => {
    const withIndividual = buildConflictData({ ...BASE, rows: ROWS }, 'n');
    expect(withIndividual.stops.map((s) => s.id)).toEqual([
      'review',
      'choose',
      'resolve',
      'apply',
    ]);
    expect(withIndividual.stops.find((s) => s.id === 'resolve')!.state).toBe('upcoming');

    // A run whose menu offers no individual resolution never visits that stop,
    // and the rail says so up front rather than dropping it.
    const noIndividual = buildConflictData(
      { ...BASE, rows: ROWS, actions: ACTIONS.filter((a) => a.value !== 'individual') },
      'n',
    );
    expect(noIndividual.stops.find((s) => s.id === 'resolve')!.state).toBe('skipped');
    expect(noIndividual.stops).toHaveLength(4);
  });

  test('renders no full secret value — only snippets the caller supplied', () => {
    const d = buildConflictData({ ...BASE, rows: ROWS }, 'n');
    const json = JSON.stringify(d);
    expect(json).not.toContain('sk_live');
    for (const r of d.rows) {
      for (const v of [r.pinned, r.local, r.remote]) {
        if (v) expect(v.length).toBeLessThan(20);
      }
    }
  });
});

describe('resolveConflictInBrowser', () => {
  test('a whole-run action comes back without per-variable choices', async () => {
    let url = '';
    const done = resolveConflictInBrowser({
      ...BASE,
      rows: ROWS,
      onListen: (u) => (url = u),
    });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('mikes-market');
    expect(page).not.toContain('id="screen"');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', action: 'retrieve_pinned' } }),
    });

    expect(await done).toEqual({ action: 'retrieve_pinned', choices: {}, cancelled: false });
  });

  test('individual resolution returns a source for every row', async () => {
    let url = '';
    const done = resolveConflictInBrowser({ ...BASE, rows: ROWS, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: {
          __action: 'submit',
          action: 'individual',
          choices: { STRIPE_KEY: 'remote', DB_URL: 'delete' },
        },
      }),
    });

    expect(await done).toEqual({
      action: 'individual',
      choices: { STRIPE_KEY: 'remote', DB_URL: 'delete' },
      cancelled: false,
    });
  });

  test('a half-answered individual resolution is refused, not applied', async () => {
    // The screen holds its button until every row has a source, so this can
    // only arrive from something that is not that screen. Guessing the rest
    // would be guessing at somebody's secrets.
    let url = '';
    let resolved = false;
    const done = resolveConflictInBrowser({ ...BASE, rows: ROWS, onListen: (u) => (url = u) });
    void done.then(() => (resolved = true));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: { __action: 'submit', action: 'individual', choices: { STRIPE_KEY: 'remote' } },
      }),
    });
    // Inline refusal: 200 with an error keeps the user on the step.
    expect(res.status).toBe(200);
    expect((await res.json()).error).toContain('unanswered');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // Answering the rest finishes it.
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: {
          __action: 'submit',
          action: 'individual',
          choices: { STRIPE_KEY: 'remote', DB_URL: 'local' },
        },
      }),
    });
    expect((await done).cancelled).toBe(false);
  });

  test('an action outside this run\'s menu is refused', async () => {
    let url = '';
    const done = resolveConflictInBrowser({
      ...BASE,
      rows: ROWS,
      actions: ACTIONS.filter((a) => a.value !== 'commit_local'),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', action: 'commit_local' } }),
    });
    expect((await res.json()).error).toContain('not available');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('cancelling changes nothing and says so', async () => {
    let url = '';
    const done = resolveConflictInBrowser({ ...BASE, rows: ROWS, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });

    expect(await done).toEqual({ action: 'skip', choices: {}, cancelled: true });
  });
});
