/**
 * The three recovery flows, served as compiled screens.
 *
 * These commands handle material equivalent to a recovery phrase, and each one
 * moves it in a different direction. The tests are grouped by that direction,
 * because getting it wrong is the only really expensive mistake here:
 *
 *   recover     the phrase is TYPED and must cross the loopback — the CLI has
 *               to check it — but nothing about it may be rendered or carried
 *               back in a payload the page was served with.
 *   end-recover the payload names files that ARE plaintext; not a byte of
 *               their contents may travel with the names.
 *   transport   the redeem code goes OUT to the page and can never come back.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildEndRecoverData,
  buildRecoverData,
  buildTransportData,
  endRecoverInBrowser,
  formatDuration,
  recoverInBrowser,
  recoverScreenView,
  showTransportInBrowser,
  type PhraseVerdict,
  type RecoverOps,
  type WriteOutcome,
} from '../../src/ui/recoveryScreens';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

/** POST a payload the way the page does, and hand back the parsed body. */
async function submit(u: URL, nonce: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nonce, payload }),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// recover-master-key
// ---------------------------------------------------------------------------

const ORGS = [
  { id: 'org-demos', name: 'Demos', hasKeyOnThisDevice: false },
  { id: 'org-capy', name: 'Capy', hasKeyOnThisDevice: true },
];

/** A phrase this suite treats as right. Never a real one. */
const GOOD = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ');

function ops(over: Partial<RecoverOps> = {}): RecoverOps {
  return {
    scopeToOrg: async () => true,
    verifyPhrase: async (_orgId, phrase): Promise<PhraseVerdict> =>
      phrase === GOOD ? { code: 'MATCH', kdfVersion: 2 } : { code: 'NO_MATCH' },
    writeKey: async (orgId): Promise<WriteOutcome> => ({
      ok: true,
      keyPath: `~/.capy/orgs/${orgId}/users/u1/key.enc`,
    }),
    ...over,
  };
}

const RECOVER = {
  userEmail: 'vince@capy.sc',
  orgs: ORGS,
  wordCount: 24,
  open: false,
};

describe('buildRecoverData', () => {
  test('opens on the organization stop, and never auto-picks one', () => {
    const d = buildRecoverData({ userEmail: 'v@c.sc', orgs: ORGS, wordCount: 24 }, 'n');
    expect(d.view).toBe('organization');
    expect(d.orgs).toHaveLength(2);
    expect(d.orgId).toBeUndefined();
    expect(d.orgName).toBeUndefined();
  });

  test('declares the whole route before anything is answered', () => {
    const d = buildRecoverData({ orgs: ORGS, wordCount: 24 }, 'n');
    expect(d.stops.map((s) => s.id)).toEqual([
      'auth',
      'organization',
      'overwrite',
      'phrase',
      'write',
    ]);
    // The gate cannot be committed to before an organization is picked, so it
    // is a blank rather than an omission.
    expect(d.stops.find((s) => s.id === 'overwrite')!.blank).toBe(true);
  });

  test('an organization with a key on this device opens the overwrite gate', () => {
    const s = { orgs: ORGS, wordCount: 24, orgId: 'org-capy' };
    expect(recoverScreenView(s)).toBe('overwrite');
    const d = buildRecoverData(s, 'n');
    expect(d.view).toBe('overwrite');
    expect(d.orgName).toBe('Capy');
    expect(d.stops.find((s2) => s2.id === 'overwrite')!.state).toBe('current');
  });

  test('an organization with no key here skips the gate and asks for the phrase', () => {
    const s = { orgs: ORGS, wordCount: 24, orgId: 'org-demos' };
    expect(recoverScreenView(s)).toBe('phrase');
    const d = buildRecoverData(s, 'n');
    expect(d.stops.find((s2) => s2.id === 'overwrite')!.state).toBe('skipped');
    expect(d.stops.find((s2) => s2.id === 'phrase')!.state).toBe('current');
  });

  test('a gap in the oracle becomes the unverified fork, carrying the reason', () => {
    const d = buildRecoverData(
      { orgs: ORGS, wordCount: 24, orgId: 'org-demos', oracleGap: 'list-failed' },
      'n',
    );
    expect(d.view).toBe('unverified');
    expect(d.oracleGap).toBe('list-failed');
    // The phrase is in, so the run stands at the write.
    expect(d.stops.find((s) => s.id === 'phrase')!.state).toBe('done');
    expect(d.stops.find((s) => s.id === 'write')!.state).toBe('current');
  });

  test('the word count is the run\'s, so the rail and the field cannot disagree', () => {
    const d = buildRecoverData({ orgs: ORGS, wordCount: 12, orgId: 'org-demos' }, 'n');
    expect(d.wordCount).toBe(12);
    expect(d.stops.find((s) => s.id === 'phrase')!.detail).toBe('all 12 words');
  });

  test('the refusal travels as a code, not as prose the CLI worded twice', () => {
    const d = buildRecoverData(
      { orgs: ORGS, wordCount: 24, orgId: 'org-demos', phraseError: 'NO_MATCH' },
      'n',
    );
    expect(d.phraseError).toBe('NO_MATCH');
    // The sentence itself belongs to the screen. Nothing here ships a copy.
    expect(JSON.stringify(d)).not.toContain('does not match any secrets');
  });

  test('strips the terminal colour codes off an organization name', () => {
    const d = buildRecoverData(
      {
        orgs: [{ id: 'o', name: '\x1b[1mDemos\x1b[0m', hasKeyOnThisDevice: false }],
        wordCount: 24,
        orgId: 'o',
      },
      'n',
    );
    expect(d.orgName).toBe('Demos');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('carries no phrase, no key, and no field that could hold either', () => {
    // The direction that matters: this payload is what the CLI SENDS. A
    // recovery phrase is entered on this screen and has no business being in
    // anything the CLI hands the page.
    for (const view of ['organization', 'overwrite', 'phrase', 'unverified'] as const) {
      const d = buildRecoverData(
        {
          userEmail: 'v@c.sc',
          orgs: ORGS,
          wordCount: 24,
          orgId: view === 'organization' ? undefined : view === 'overwrite' ? 'org-capy' : 'org-demos',
          oracleGap: view === 'unverified' ? 'no-secrets' : undefined,
        },
        'n',
      );
      const keys = new Set(Object.keys(d));
      expect(keys.has('phrase')).toBe(false);
      expect(keys.has('masterKey')).toBe(false);
      expect(keys.has('seedPhrase')).toBe(false);
      expect(keys.has('fingerprint')).toBe(false);
      expect(JSON.stringify(d)).not.toContain(GOOD);
    }
  });

  test('every stop has a way out without a browser, and the phrase stop\'s is a terminal', () => {
    const phrase = buildRecoverData({ orgs: ORGS, wordCount: 24, orgId: 'org-demos' }, 'n');
    expect(phrase.nonTty!.command).toBe('capy recover');
    expect(phrase.nonTty!.why).toContain('shell history');
    const org = buildRecoverData({ orgs: ORGS, wordCount: 24 }, 'n');
    expect(org.nonTty!.why).not.toBe(phrase.nonTty!.why);
  });
});

describe('recoverInBrowser', () => {
  test('walks organization → phrase and writes the key the trial proved', async () => {
    let url = '';
    const written: Array<{ orgId: string; phrase: string; kdf?: 1 | 2 }> = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        writeKey: async (orgId, phrase, kdf) => {
          written.push({ orgId, phrase, kdf });
          return { ok: true, keyPath: '~/.capy/orgs/org-demos/users/u1/key.enc' };
        },
      }),
      onListen: (u) => (url = u),
    });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).not.toContain('id="screen"');

    const first = await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    // A whole document cannot be spliced in, so the browser is told to reload.
    expect(first.body.next).toBe(true);

    await submit(u, nonce, { __action: 'submit', phrase: GOOD });

    expect(await done).toEqual({
      orgId: 'org-demos',
      orgName: 'Demos',
      kdfVersion: 2,
      keyPath: '~/.capy/orgs/org-demos/users/u1/key.enc',
      cancelled: false,
    });
    // The phrase reached the CLI, which is the point: it has to be checked.
    expect(written).toEqual([{ orgId: 'org-demos', phrase: GOOD, kdf: 2 }]);
  });

  test('the overwrite gate stands between the organization and the phrase', async () => {
    let url = '';
    const done = recoverInBrowser({ ...RECOVER, ops: ops(), onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-capy' });

    // A phrase submitted here is answering a question nobody asked: the gate
    // is the current stop, and it takes a boolean.
    const stray = await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    expect(stray.body.error).toContain('overwrite step');

    await submit(u, nonce, { __action: 'submit', overwrite: true });
    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    expect((await done).cancelled).toBe(false);
  });

  test('an organization outside this session is refused, not scoped to', async () => {
    // Wrapping a phrase's master key for an organization it was never issued
    // for is the exact failure `recover` exists to undo.
    let url = '';
    const scoped: string[] = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        scopeToOrg: async (id) => {
          scoped.push(id);
          return true;
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await submit(u, nonce, { __action: 'submit', organizationId: 'org-somebody-else' });
    expect(res.status).toBe(200);
    expect(res.body.error).toContain('not one this session can reach');
    expect(scoped).toEqual([]);

    await submit(u, nonce, { __action: 'cancel' });
    await done;
  });

  test('a session that cannot be scoped keeps the user on the organization stop', async () => {
    let url = '';
    let settled = false;
    const done = recoverInBrowser({
      ...RECOVER,
      timeoutMs: 4_000,
      ops: ops({ scopeToOrg: async () => false }),
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    expect(res.body.error).toContain('Failed to scope session to Demos');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  });

  test('a phrase that matches nothing comes back as the phrase stop, not an exit code', async () => {
    // The terminal exits 1 here and the user re-runs the whole command. The
    // refusal must not crash, and nothing may be written.
    let url = '';
    const writes: string[] = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        writeKey: async (orgId) => {
          writes.push(orgId);
          return { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    const wrong = await submit(u, nonce, { __action: 'submit', phrase: 'not the phrase' });
    expect(wrong.body.next).toBe(true);
    expect(writes).toEqual([]);

    // The re-served page says why, as a code the screen words.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('NO_MATCH');

    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    expect(writes).toEqual(['org-demos']);
    expect((await done).cancelled).toBe(false);
  });

  test('an empty or malformed phrase is re-asked, and writes nothing', async () => {
    let url = '';
    const writes: string[] = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        verifyPhrase: async (_o, phrase) =>
          !phrase ? { code: 'EMPTY' } : phrase === GOOD ? { code: 'MATCH', kdfVersion: 1 } : { code: 'INVALID' },
        writeKey: async (orgId) => {
          writes.push(orgId);
          return { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    await submit(u, nonce, { __action: 'submit' });
    expect((await (await fetch(u.href)).text())).toContain('EMPTY');
    await submit(u, nonce, { __action: 'submit', phrase: 'three words only' });
    expect((await (await fetch(u.href)).text())).toContain('INVALID');
    expect(writes).toEqual([]);

    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    expect((await done).kdfVersion).toBe(1);
  });

  test('a phrase nothing could check becomes a decision, not a silent write', async () => {
    // The terminal warns and writes anyway under the current KDF version. For
    // a legacy v1 org caught by an outage that is a silently wrong key.
    let url = '';
    const written: Array<{ phrase: string; kdf?: 1 | 2 }> = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'list-failed' }),
        writeKey: async (_orgId, phrase, kdf) => {
          written.push({ phrase, kdf });
          return { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    // Nothing written yet — the fork is a question.
    expect(written).toEqual([]);
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('unverified');
    expect(page).toContain('list-failed');
    // …and the phrase is not on the page it hands back.
    expect(page).not.toContain(GOOD);

    await submit(u, nonce, { __action: 'submit', writeUnverified: true });
    // No KDF version, because nothing proved one.
    expect(written).toEqual([{ phrase: GOOD, kdf: undefined }]);
    expect((await done).kdfVersion).toBeNull();
  });

  test('cancelling the unverified fork writes nothing at all', async () => {
    let url = '';
    const writes: string[] = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'no-secrets' }),
        writeKey: async (orgId) => {
          writes.push(orgId);
          return { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    await submit(u, nonce, { __action: 'cancel' });

    expect(writes).toEqual([]);
    expect(await done).toEqual({
      orgId: '',
      orgName: '',
      kdfVersion: null,
      keyPath: null,
      cancelled: true,
    });
  });

  test('a failed write leaves the run where it was, so pressing again retries', async () => {
    let attempts = 0;
    let url = '';
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'fetch-failed' }),
        writeKey: async () => {
          attempts += 1;
          return attempts === 1
            ? { ok: false, message: 'Failed to wrap and save the master key: 503. No changes were written.' }
            : { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    await submit(u, nonce, { __action: 'submit', phrase: GOOD });

    const failed = await submit(u, nonce, { __action: 'submit', writeUnverified: true });
    expect(failed.status).toBe(200);
    expect(failed.body.error).toContain('No changes were written');

    // The phrase is still held, so the second press is a retry rather than a
    // dead end that costs the user their 24 words again.
    await submit(u, nonce, { __action: 'submit', writeUnverified: true });
    expect(attempts).toBe(2);
    expect((await done).cancelled).toBe(false);
  });

  test('an unverified write the screen could not have asked for is refused', async () => {
    let url = '';
    const writes: string[] = [];
    const done = recoverInBrowser({
      ...RECOVER,
      ops: ops({
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'other-branch' }),
        writeKey: async (orgId) => {
          writes.push(orgId);
          return { ok: true, keyPath: 'p' };
        },
      }),
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-demos' });
    await submit(u, nonce, { __action: 'submit', phrase: GOOD });
    const res = await submit(u, nonce, { __action: 'submit', writeUnverified: 'yes' });
    expect(res.body.error).toContain('not an answer this step can produce');
    expect(writes).toEqual([]);

    await submit(u, nonce, { __action: 'cancel' });
    await done;
  });
});

// ---------------------------------------------------------------------------
// end-recover-cleanup
// ---------------------------------------------------------------------------

const FILES = [
  { name: '.env.production.decrypted', age: '2 hours ago', size: '1 KB' },
  { name: '.env.staging.decrypted', age: '3 days ago', size: '2 KB' },
];

const SWEEP = {
  session: { orgName: 'org-uuid-demos', startedAt: '2 hours ago' },
  cwd: '/work/mikes-market',
  files: FILES,
  open: false,
};

describe('buildEndRecoverData', () => {
  test('names the files and nothing about what is in them', () => {
    const d = buildEndRecoverData(SWEEP, 'n');
    expect(d.view).toBe('review');
    expect(d.files.map((f) => f.name)).toEqual([
      '.env.production.decrypted',
      '.env.staging.decrypted',
    ]);
    // Only name, age and size — no third field could carry a line of secrets.
    for (const f of d.files) {
      expect(Object.keys(f).sort()).toEqual(['age', 'name', 'size']);
    }
    expect(JSON.stringify(d)).not.toContain('sk_live');
    expect(JSON.stringify(d)).not.toContain('=');
  });

  test('a directory with plaintext and no session is a real state, not an error', () => {
    // The terminal returns early here and never sweeps, so files a cleared
    // session left behind outlive it.
    const d = buildEndRecoverData({ ...SWEEP, session: undefined }, 'n');
    expect(d.session).toBeUndefined();
    expect(d.files).toHaveLength(2);
    expect(d.blocked).toBeUndefined();
  });

  test('strips the terminal colour codes off the directory and the session', () => {
    const d = buildEndRecoverData(
      {
        ...SWEEP,
        cwd: '\x1b[1m/work\x1b[0m',
        session: { orgName: '\x1b[1morg-x\x1b[0m', startedAt: '\x1b[90m2 hours ago\x1b[0m' },
      },
      'n',
    );
    expect(d.cwd).toBe('/work');
    expect(d.session!.orgName).toBe('org-x');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('says how the sweep is done without a browser', () => {
    expect(buildEndRecoverData(SWEEP, 'n').nonTty!.command).toBe('capy end-recover');
  });
});

describe('endRecoverInBrowser', () => {
  test('returns the ticked files in the order the page listed them', async () => {
    let url = '';
    const done = endRecoverInBrowser({ ...SWEEP, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, {
      __action: 'submit',
      endSession: true,
      // Submitted out of order, and with a duplicate.
      remove: ['.env.staging.decrypted', '.env.production.decrypted', '.env.staging.decrypted'],
    });

    expect(await done).toEqual({
      endSession: true,
      remove: ['.env.production.decrypted', '.env.staging.decrypted'],
      cancelled: false,
    });
  });

  test('unticking everything ends the session and deletes nothing', async () => {
    let url = '';
    const done = endRecoverInBrowser({ ...SWEEP, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    await submit(u, nonce, { __action: 'submit', endSession: true, remove: [] });
    expect(await done).toEqual({ endSession: true, remove: [], cancelled: false });
  });

  test('a file this sweep never found is refused, not unlinked', async () => {
    // The answer to this page is a set of unlink calls, so a name the screen
    // could not have offered is not a name to act on.
    let url = '';
    const done = endRecoverInBrowser({ ...SWEEP, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await submit(u, nonce, {
      __action: 'submit',
      endSession: true,
      remove: ['.env.production.decrypted', '../../etc/passwd'],
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toContain('not a file this sweep offered');

    await submit(u, nonce, { __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });

  test('the session flag is checked against this run, never obeyed', async () => {
    // The screen computes it from the payload it was served, so a disagreement
    // means the submit did not come from that screen.
    let url = '';
    const done = endRecoverInBrowser({
      ...SWEEP,
      session: undefined,
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await submit(u, nonce, { __action: 'submit', endSession: true, remove: [] });
    expect(res.body.error).toContain('not an answer this step can produce');

    // With no session, the honest answer is false — and the CLI's own value is
    // what comes back, not the page's.
    await submit(u, nonce, { __action: 'submit', endSession: false, remove: [] });
    expect(await done).toEqual({ endSession: false, remove: [], cancelled: false });
  });

  test('cancelling removes nothing and ends no session', async () => {
    let url = '';
    const done = endRecoverInBrowser({ ...SWEEP, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    await submit(u, nonce, { __action: 'cancel' });
    expect(await done).toEqual({ endSession: false, remove: [], cancelled: true });
  });
});

// ---------------------------------------------------------------------------
// transport-machine
// ---------------------------------------------------------------------------

const CODE = 'capy redeem AgQxMjM0NTY3ODkwYWJjZGVmLXRoaXMtaXMtdGhlLWtleQ';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const TRANSPORT = {
  orgName: 'Demos',
  boundEmail: 'vince@capy.sc',
  expiresAtIso: '2026-08-06T12:00:00.000Z',
  redeemCommand: CODE,
  now: NOW,
  open: false,
};

describe('formatDuration', () => {
  test('is a bare duration, because the screen writes the preposition', () => {
    expect(formatDuration(30_000)).toBe('30 seconds');
    expect(formatDuration(60_000)).toBe('1 minute');
    expect(formatDuration(28 * 60_000)).toBe('28 minutes');
    expect(formatDuration(2 * 3_600_000)).toBe('2 hours');
    expect(formatDuration(7 * 24 * 3_600_000)).toBe('7 days');
    expect(formatDuration(-5)).toBe('0 seconds');
  });
});

describe('buildTransportData', () => {
  test('carries the code, and everything that makes a forwarded one useless', () => {
    const d = buildTransportData(TRANSPORT, 'n');
    expect(d.view).toBe('code');
    expect(d.redeemCommand).toBe(CODE);
    expect(d.boundEmail).toBe('vince@capy.sc');
    expect(d.orgName).toBe('Demos');
    expect(d.expiresAtIso).toBe('2026-08-06T12:00:00.000Z');
    expect(d.expiresIn).toBe('7 days');
    expect(d.expiryState).toBe('ok');
  });

  test('how much window is left is a state, never a string to be parsed', () => {
    // The screen colours this row, and "28 minutes" versus "7 days" is not a
    // distinction a renderer should be inferring from prose.
    const soon = buildTransportData(
      { ...TRANSPORT, expiresAtIso: '2026-07-30T12:28:00.000Z' },
      'n',
    );
    expect(soon.expiryState).toBe('soon');
    expect(soon.expiresIn).toBe('28 minutes');

    const gone = buildTransportData(
      { ...TRANSPORT, expiresAtIso: '2026-07-30T11:00:00.000Z' },
      'n',
    );
    expect(gone.expiryState).toBe('expired');
    // Nothing will redeem it, so there is no window to name.
    expect(gone.expiresIn).toBeUndefined();
  });

  test('an unreadable expiry does not become a fake countdown', () => {
    const d = buildTransportData({ ...TRANSPORT, expiresAtIso: 'not a date' }, 'n');
    expect(d.expiresIn).toBeUndefined();
    expect(d.expiryState).toBe('ok');
  });

  test('the escape hatch is a refusal, because there is no safe non-browser form', () => {
    const d = buildTransportData(TRANSPORT, 'n');
    expect(d.nonTty!.command).toBe('capy transport');
    expect(d.nonTty!.why).toContain('stdout');
  });
});

describe('showTransportInBrowser', () => {
  test('closing it out is the only success, and the code never comes back', async () => {
    let url = '';
    const seen: Array<Record<string, unknown>> = [];
    const done = showTransportInBrowser({ ...TRANSPORT, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The code is on the page the CLI serves — that is the whole point.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('AgQxMjM0NTY3ODkw');

    seen.push((await submit(u, nonce, { __action: 'done' })).body);
    expect(await done).toEqual({ acknowledged: true });
  });

  test('a submit carrying anything but an action is refused before it is read', async () => {
    // This is what makes it structurally impossible for the code on the page
    // to travel back over the loopback.
    let url = '';
    const done = showTransportInBrowser({ ...TRANSPORT, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const withCode = await submit(u, nonce, { __action: 'done', redeemCommand: CODE });
    expect(withCode.status).toBe(200);
    expect(withCode.body.error).toContain('an action and nothing else');
    expect(withCode.body.done).toBeUndefined();

    const bare = await submit(u, nonce, { copied: true });
    expect(bare.body.error).toContain('an action and nothing else');

    await submit(u, nonce, { __action: 'done' });
    expect(await done).toEqual({ acknowledged: true });
  });

  test('an action this screen does not offer is refused', async () => {
    let url = '';
    const done = showTransportInBrowser({ ...TRANSPORT, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await submit(u, nonce, { __action: 'revoke' });
    expect(res.body.error).toContain('not an action this screen offers');

    await submit(u, nonce, { __action: 'cancel' });
    await done;
  });

  test('cancelling ends the run without pretending the code was un-minted', async () => {
    let url = '';
    const done = showTransportInBrowser({ ...TRANSPORT, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    await submit(u, nonce, { __action: 'cancel' });
    expect(await done).toEqual({ acknowledged: false });
  });
});
