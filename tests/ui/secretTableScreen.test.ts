/**
 * `capy edit`, served as compiled screens.
 *
 * These are the only screens in the product that render real secret values, so
 * most of what is pinned here is what does NOT cross: the payload carries a
 * mask, a length and a status, and the plaintext moves only on the round trip
 * the user asked for. The rest pins the four things the terminal gets wrong and
 * the browser path was built to fix — the short-value leak, the silent
 * collateral deletion, the undecryptable values dropped without a word, and
 * `remote unavailable` standing for three different conditions.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildSecretTableData,
  buildSecretValueEditorData,
  serveSecretTable,
  serveSecretValueEditor,
  type WebSecretRow,
  type WebSecretTableParams,
} from '../../src/ui/secretTableScreen';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const LIVE = 'example-value-123456-not-a-secret';

const ROWS: WebSecretRow[] = [
  {
    key: 'STRIPE_SECRET_KEY',
    localValue: LIVE,
    remoteValue: LIVE,
    status: 'in sync',
    updatedLabel: '3 days ago',
    changedAt: '2026-07-27T10:00:00.000Z',
  },
  {
    key: 'DATABASE_URL',
    localValue: 'postgres://localhost/dev',
    remoteValue: 'postgres://prod/app',
    status: 'conflict',
    updatedLabel: 'just now',
    changedAt: '2026-07-30T10:00:00.000Z',
  },
  {
    key: 'LEGACY_TOKEN',
    localValue: undefined,
    remoteValue: 'remote-only-value',
    status: 'remote',
    updatedLabel: '—',
  },
];

const BASE: WebSecretTableParams = {
  projectName: 'mikes-market',
  branch: 'staging',
  mode: 'server',
  rows: ROWS,
  open: false,
};

describe('buildSecretTableData', () => {
  test('carries no value — only what a value IS, never what it says', () => {
    const json = JSON.stringify(buildSecretTableData(BASE, 'n'));
    expect(json).not.toContain('sk_live');
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain('remote-only-value');
    // …and nothing pre-seeds the reveal cache, which is the other half of the
    // promise that the served HTML can never hold the whole vault.
    expect(JSON.parse(json).revealed).toBeUndefined();
  });

  test('a value is described by state, length and lines — never by content', () => {
    const d = buildSecretTableData(
      {
        ...BASE,
        rows: [
          { key: 'PEM', localValue: 'a\nb\nc', remoteValue: undefined, status: 'local', updatedLabel: 'just now' },
          { key: 'BLANK', localValue: '', remoteValue: undefined, status: 'local', updatedLabel: 'just now' },
          { key: 'GONE', localValue: undefined, remoteValue: undefined, status: 'unknown', updatedLabel: '—' },
        ],
      },
      'n',
    );
    expect(d.rows[0]).toMatchObject({ value: 'set', length: 5, lines: 3 });
    expect(d.rows[1]).toMatchObject({ value: 'empty', length: 0 });
    expect(d.rows[1].lines).toBeUndefined();
    expect(d.rows[2]).toMatchObject({ value: 'absent' });
    expect(d.rows[2].length).toBeUndefined();
  });

  test('the CLI status words survive the crossing', () => {
    const d = buildSecretTableData(BASE, 'n');
    expect(d.rows.map((r) => r.status)).toEqual(['in-sync', 'conflict', 'remote']);
  });

  test('updatedRank is monotonic in recency, ties share, and a blank ranks last', () => {
    const rows: WebSecretRow[] = [
      { key: 'OLD', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: '3 days ago', changedAt: '2026-07-27T10:00:00.000Z' },
      { key: 'NEW', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: 'just now', changedAt: '2026-07-30T10:00:00.000Z' },
      // Same humanised age as OLD but a different instant: the column reads the
      // same, so the order must too.
      { key: 'ALSO_OLD', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: '3 days ago', changedAt: '2026-07-27T18:00:00.000Z' },
      { key: 'NEVER', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: '—' },
    ];
    const byKey = new Map(buildSecretTableData({ ...BASE, rows }, 'n').rows.map((r) => [r.key, r.updatedRank]));
    expect(byKey.get('NEW')).toBe(0);
    expect(byKey.get('OLD')).toBe(1);
    expect(byKey.get('ALSO_OLD')).toBe(1);
    // Explicit, not a sentinel: the row with no stamp is behind everything that
    // has one, and it is a number the table can actually sort by.
    expect(byKey.get('NEVER')).toBe(2);
  });

  test('local mode ranks the uncommitted rows ahead of the committed ones', () => {
    const rows: WebSecretRow[] = [
      { key: 'CLEAN', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: 'committed' },
      { key: 'DIRTY', localValue: 'y', remoteValue: 'x', status: 'local', updatedLabel: 'uncommitted' },
    ];
    const d = buildSecretTableData({ ...BASE, mode: 'local', rows }, 'n');
    expect(d.rows.find((r) => r.key === 'DIRTY')!.updatedRank).toBe(0);
    expect(d.rows.find((r) => r.key === 'CLEAN')!.updatedRank).toBe(1);
  });

  test('names what a commit would silently delete', () => {
    // The audit's worst finding: the commit rebuilds .env from the local
    // plaintext alone, so a pinned-but-absent variable loses its branch entry
    // on ANY commit at all.
    const d = buildSecretTableData(BASE, 'n');
    expect(d.droppedOnCommitKeys).toEqual(['LEGACY_TOKEN']);

    // Queueing an edit for it gives it a local value, so it is no longer
    // dropped — the list follows the rows rather than a snapshot taken once.
    const edited = buildSecretTableData(
      { ...BASE, rows: ROWS.map((r) => (r.key === 'LEGACY_TOKEN' ? { ...r, localValue: 'now-here', dirty: true } : r)) },
      'n',
    );
    expect(edited.droppedOnCommitKeys).toBeUndefined();
  });

  test('declares the whole route before anything opens', () => {
    const d = buildSecretTableData(BASE, 'n');
    expect(d.stops.map((s) => s.id)).toEqual(['edit', 'review', 'write', 'result']);
    expect(d.stops[0]).toMatchObject({ state: 'current', detail: '3 variables' });
    expect(d.stops[2]).toMatchObject({
      label: 'Encrypt and push to Keep',
      detail: 'mikes-market/staging',
      detailMono: true,
    });
  });

  test('local mode names a destination it can actually reach', () => {
    const d = buildSecretTableData({ ...BASE, mode: 'local' }, 'n');
    expect(d.stops[2]).toMatchObject({ label: 'Commit locally', detail: 'to this machine only' });
    expect(d.stops[2].detailMono).toBeUndefined();
  });

  test('the review stop reports the answer, not the offer', () => {
    const dirty = ROWS.map((r) => (r.key === 'DATABASE_URL' ? { ...r, dirty: true } : r));
    const d = buildSecretTableData({ ...BASE, rows: dirty }, 'n', 'confirm-commit');
    expect(d.stops[0]).toMatchObject({ state: 'done', answer: '1 change' });
    expect(d.stops[0].detail).toBeUndefined();
    expect(d.stops[1].state).toBe('current');
  });

  test('a discarded run marks the write as a station it never visited', () => {
    const d = buildSecretTableData(BASE, 'n', 'cancelled');
    expect(d.stops[2].state).toBe('skipped');
    expect(d.stops[3].state).toBe('current');
  });

  test('a missing remote is one of three named conditions, not one blank', () => {
    for (const gap of ['never_pushed', 'fetch_failed', 'local_mode'] as const) {
      expect(buildSecretTableData({ ...BASE, remoteGap: gap }, 'n').remoteGap).toBe(gap);
    }
    expect(buildSecretTableData(BASE, 'n').remoteGap).toBeUndefined();
  });

  test('undecryptable values are named rather than dropped in silence', () => {
    const d = buildSecretTableData({ ...BASE, undecryptableKeys: ['OLD_KEY'] }, 'n');
    expect(d.undecryptableKeys).toEqual(['OLD_KEY']);
  });

  test('strips the terminal colour codes off anything the CLI formatted', () => {
    const d = buildSecretTableData(
      {
        ...BASE,
        projectName: '\x1b[1mmikes-market\x1b[0m',
        rows: [{ key: 'A', localValue: 'x', remoteValue: 'x', status: 'in sync', updatedLabel: '\x1b[90mjust now\x1b[0m' }],
      },
      'n',
    );
    expect(d.projectName).toBe('mikes-market');
    expect(d.rows[0].updated).toBe('just now');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });
});

describe('buildSecretValueEditorData', () => {
  const editorBase = {
    projectName: 'mikes-market',
    branch: 'staging',
    mode: 'server' as const,
    remoteAvailable: true,
    pendingCount: 1,
    open: false,
  };

  test('a long value crosses as the CLI\'s own mask and nothing else', () => {
    const d = buildSecretValueEditorData({ ...editorBase, row: ROWS[0] }, 'n');
    expect(d.snippetIsWholeValue).toBe(false);
    expect(d.snippet).toBe('exa...ret');
    expect(JSON.stringify(d)).not.toContain('sk_live');
    expect(d.valueLength).toBe(LIVE.length);
  });

  test('a short value crosses with NO snippet, because the snippet would be the value', () => {
    // `formatSnippet` returns anything six characters or shorter VERBATIM, so
    // the terminal's masked column prints short secrets whole. Badging it would
    // still ship the leak; the payload simply does not carry one.
    const d = buildSecretValueEditorData(
      { ...editorBase, row: { key: 'PIN', localValue: 'hunter', remoteValue: undefined, status: 'local', updatedLabel: 'just now' } },
      'n',
    );
    expect(d.snippetIsWholeValue).toBe(true);
    expect(d.snippet).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('hunter');
  });

  test('the boundary is six characters, the same one formatSnippet draws', () => {
    const at = (v: string) =>
      buildSecretValueEditorData(
        { ...editorBase, row: { key: 'K', localValue: v, remoteValue: undefined, status: 'local', updatedLabel: 'now' } },
        'n',
      );
    expect(at('123456').snippetIsWholeValue).toBe(true);
    expect(at('123456').snippet).toBeUndefined();
    expect(at('1234567').snippetIsWholeValue).toBe(false);
    expect(at('1234567').snippet).toBe('123...567');
  });

  test('empty and absent are kept apart, and neither is masked into looking like a secret', () => {
    const empty = buildSecretValueEditorData(
      { ...editorBase, row: { key: 'K', localValue: '', remoteValue: undefined, status: 'local', updatedLabel: 'now' } },
      'n',
    );
    expect(empty.isEmptyString).toBe(true);
    expect(empty.hasLocalValue).toBe(true);

    const absent = buildSecretValueEditorData(
      { ...editorBase, row: { key: 'K', localValue: undefined, remoteValue: undefined, status: 'unknown', updatedLabel: '—' } },
      'n',
    );
    expect(absent.isEmptyString).toBe(false);
    expect(absent.hasLocalValue).toBe(false);
    expect(absent.hasRemoteValue).toBe(false);
    expect(absent.valueLength).toBe(0);
  });

  test('a multi-line value says so, and its snippet keeps the terminal\'s marker', () => {
    const d = buildSecretValueEditorData(
      {
        ...editorBase,
        row: {
          key: 'PRIVATE_KEY',
          localValue: '-----BEGIN\nMIIabc\n-----END',
          remoteValue: undefined,
          status: 'local',
          updatedLabel: 'now',
        },
      },
      'n',
    );
    expect(d.multiline).toBe(true);
    expect(d.snippet).toBe('---...END');
  });

  test('a row with no local copy is flagged, so an empty box is not an accident', () => {
    // Editing this row in the terminal seeds an EMPTY buffer even though a
    // teammate's remote value exists, and one enter press overwrites it.
    const d = buildSecretValueEditorData({ ...editorBase, row: ROWS[2] }, 'n');
    expect(d.hasLocalValue).toBe(false);
    expect(d.hasRemoteValue).toBe(true);
  });
});

describe('serveSecretTable', () => {
  test('reveal hands back one value and the flow stays where it was', async () => {
    let url = '';
    const done = serveSecretTable({ ...BASE, onListen: (u) => (url = u), timeoutMs: 4_000 });
    void done.catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole — and it does not
    // contain the value it is about to be asked for.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('STRIPE_SECRET_KEY');
    expect(page).not.toContain('sk_live');

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'reveal', key: 'STRIPE_SECRET_KEY' } }),
    });
    expect(await res.json()).toEqual({ value: LIVE });

    // Still answering: a reveal is a question, not the end of the flow.
    const second = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(second.status).toBe(200);
    expect(await done).toEqual({ action: 'cancel', reason: 'declined' });
  });

  test('a reveal for a variable that is not on the table is refused', async () => {
    let url = '';
    const done = serveSecretTable({ ...BASE, onListen: (u) => (url = u), timeoutMs: 4_000 });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'reveal', key: 'SOMEONE_ELSES_KEY' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).error).toContain('not on this table');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('a connector-owned row cannot be hand-edited through a stray submit', async () => {
    // The screen disables the control; the CLI refuses the request. Letting it
    // through would queue an edit the next rotation silently overwrites.
    let url = '';
    const rows: WebSecretRow[] = [
      { ...ROWS[0], managedBy: { provider: 'stripe', expiresInDays: 5 } },
    ];
    const done = serveSecretTable({ ...BASE, rows, onListen: (u) => (url = u), timeoutMs: 4_000 });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'edit', key: 'STRIPE_SECRET_KEY' } }),
    });
    expect((await res.json()).error).toContain('capy rotate STRIPE_SECRET_KEY');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('the commit runs inside the request, so a failed push is not celebrated', async () => {
    // Resolving first and pushing after would render "Committed — 4 changes are
    // now pushed to staging" and then fail the push into a terminal nobody is
    // looking at. The intake's save has always run inside the request for this
    // reason; the commit does now too.
    let url = '';
    let attempts = 0;
    const done = serveSecretTable({ ...BASE, onListen: (u) => (url = u), timeoutMs: 8_000 }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Could not reach the Capy service.');
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const body = JSON.stringify({ nonce, payload: { __action: 'commit' } });

    const failed = await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain('Could not reach the Capy service');

    const retried = await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    expect(retried.status).toBe(200);
    expect(await done).toEqual({ action: 'commit' });
    expect(attempts).toBe(2);
  });

  test('an action outside the screen\'s vocabulary is refused, not guessed at', async () => {
    let url = '';
    const done = serveSecretTable({ ...BASE, onListen: (u) => (url = u), timeoutMs: 4_000 });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'delete', key: 'STRIPE_SECRET_KEY' } }),
    });
    expect((await res.json()).error).toContain('not an action this screen offers');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });
});

describe('serveSecretValueEditor', () => {
  const params = {
    projectName: 'mikes-market',
    branch: 'staging',
    mode: 'server' as const,
    row: ROWS[0],
    remoteAvailable: true,
    pendingCount: 1,
    open: false,
    timeoutMs: 4_000,
  };

  test('/reveal hands back exactly the side that was asked for', async () => {
    let url = '';
    const done = serveSecretValueEditor({ ...params, row: ROWS[1], onListen: (u) => (url = u) });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const base = `http://127.0.0.1:${u.port}`;

    const current = await fetch(`${base}/reveal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { key: 'DATABASE_URL', side: 'current' } }),
    });
    expect(await current.json()).toEqual({ value: 'postgres://localhost/dev' });

    const remote = await fetch(`${base}/reveal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { key: 'DATABASE_URL', side: 'remote' } }),
    });
    expect(await remote.json()).toEqual({ value: 'postgres://prod/app' });

    await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toEqual({ action: 'cancel', reason: 'declined' });
  });

  test('/reveal refuses a variable this editor was not opened for', async () => {
    // The editor is opened for ONE variable and the screen posts its own key,
    // so anything else is a request to read a secret nobody opened.
    let url = '';
    const done = serveSecretValueEditor({ ...params, onListen: (u) => (url = u) });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const base = `http://127.0.0.1:${u.port}`;

    const res = await fetch(`${base}/reveal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { key: 'DATABASE_URL', side: 'current' } }),
    });
    expect((await res.json()).error).toContain('not open in this editor');

    await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('a saved buffer comes back whole, newlines and all', async () => {
    let url = '';
    const done = serveSecretValueEditor({ ...params, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: { __action: 'save', key: 'STRIPE_SECRET_KEY', value: 'line one\nline two' },
      }),
    });

    expect(await done).toEqual({
      action: 'save',
      key: 'STRIPE_SECRET_KEY',
      value: 'line one\nline two',
    });
  });

  test('a value carrying a control character is refused rather than stored', async () => {
    // `sanitizePastedText` strips these in the terminal and `SecretField`
    // strips them on paste, so one arriving over the wire did not come from the
    // screen — and `dotenvEscape` quotes newlines and quotes and nothing else,
    // so the byte would go into .env raw.
    let url = '';
    let settled = false;
    const done = serveSecretValueEditor({ ...params, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nonce,
        payload: { __action: 'save', key: 'STRIPE_SECRET_KEY', value: 'sk_\u0000live' },
      }),
    });
    expect((await res.json()).error).toContain('control character');
    // The message never quotes the value: it lands in an alert and in every
    // screenshot of the page.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('a save aimed at another variable is refused', async () => {
    let url = '';
    const done = serveSecretValueEditor({ ...params, onListen: (u) => (url = u) });
    void done.catch(() => undefined);
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'save', key: 'DATABASE_URL', value: 'x' } }),
    });
    expect((await res.json()).error).toContain('not open in this editor');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });
});
