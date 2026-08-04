/**
 * `capy decrypt --web`, served as the compiled `seed-phrase-decrypt` screen.
 *
 * The phrase is the most sensitive thing any Capy screen collects — hold it and
 * you open this project's secrets with no server, no session and nobody's
 * permission — so most of what is pinned here is where it does NOT go: not into
 * a payload, not into a URL, not back out of the transport, and not into the
 * result the command reports.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildDecryptData,
  decryptInBrowser,
  showDecryptResult,
  SEED_PHRASE_WORDS,
  type DecryptAttempt,
  type WebDecryptParams,
} from '../../src/ui/decryptScreen';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const BASE: WebDecryptParams = {
  projectName: 'mikes-market',
  branch: 'main',
  outputFile: '.env.main.decrypted',
  open: false,
};

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');

describe('buildDecryptData', () => {
  test('declares the whole route before the first box opens', () => {
    const d = buildDecryptData(BASE, 'n');
    expect(d.stops.map((s) => s.id)).toEqual(['phrase', 'decrypt', 'write']);
    expect(d.stops[0]).toMatchObject({ state: 'current', detail: '24 words, typed here' });
    expect(d.stops[2]).toMatchObject({ state: 'upcoming', detail: '.env.main.decrypted' });
    expect(d.wordCount).toBe(SEED_PHRASE_WORDS);
  });

  test('an open recovery session SKIPS the phrase stop rather than hiding it', () => {
    // The terminal reuses a cached master key with no prompt and no mention.
    // The station stays on the rail, marked as one this run does not visit.
    const d = buildDecryptData(
      { ...BASE, session: { orgName: 'org_123', startedAt: '14 minutes ago' } },
      'n',
    );
    expect(d.view).toBe('session');
    expect(d.stops[0].state).toBe('skipped');
    expect(d.stops[1].state).toBe('current');
    expect(d.session).toEqual({ orgName: 'org_123', startedAt: '14 minutes ago' });
  });

  test('a run with no path to name carries no detail on the write stop', () => {
    const d = buildDecryptData({ ...BASE, outputFile: '' }, 'n');
    expect(d.stops[2].detail).toBeUndefined();
  });

  test('the result carries a count and a filename and nothing else', () => {
    const d = buildDecryptData(BASE, 'n', { view: 'result', result: { count: 7, wrote: true } });
    expect(d.view).toBe('result');
    expect(d.result).toEqual({ count: 7, wrote: true });
    // No variable names, no values: the whole point of the command is that the
    // plaintext goes to a file, not to a screen someone might be sharing.
    const json = JSON.stringify(d);
    expect(json).not.toContain('STRIPE');
    expect(d.stops.every((s) => s.state === 'done' || s.state === 'skipped')).toBe(true);
  });

  test('local mode says the passphrase lock is not consulted', () => {
    // `capy decrypt` has no `assertNotLocalOnly` gate and no role check, so the
    // recovery phrase opens local secrets around the lock. A fact, not a bug to
    // hide.
    expect(buildDecryptData({ ...BASE, localOnly: true }, 'n').localOnly).toBe(true);
    expect(buildDecryptData(BASE, 'n').localOnly).toBeUndefined();
  });

  test('the two refusals are an enum, not a sentence to match on', () => {
    expect(buildDecryptData(BASE, 'n', { view: 'phrase', phraseError: 'INVALID' }).phraseError).toBe('INVALID');
    expect(buildDecryptData(BASE, 'n', { view: 'phrase', phraseError: 'KEY_MISMATCH' }).phraseError).toBe(
      'KEY_MISMATCH',
    );
  });
});

describe('decryptInBrowser', () => {
  test('the phrase reaches the attempt and never comes back out', async () => {
    let url = '';
    let seen = '';
    const done = decryptInBrowser({ ...BASE, onListen: (u) => (url = u) }, async (input) => {
      if ('phrase' in input) seen = input.phrase;
      return { ok: true, count: 3, wrote: true };
    });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen, served whole — and the URL that carries
    // it holds only the loopback token.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).toContain('.env.main.decrypted');
    expect(u.search).not.toContain('word0');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', phrase: PHRASE } }),
    });

    const result = await done;
    expect(seen).toBe(PHRASE);
    // The transport hands back a count and whether a file was written. The
    // words are not in it.
    expect(result).toEqual({ action: 'decrypted', count: 3, wrote: true });
    expect(JSON.stringify(result)).not.toContain('word0');
  });

  test('a wrong phrase re-serves the step saying WHICH refusal it was', async () => {
    let url = '';
    let attempts = 0;
    const done = decryptInBrowser({ ...BASE, onListen: (u) => (url = u) }, async (): Promise<DecryptAttempt> => {
      attempts += 1;
      return attempts === 1 ? { ok: false, reason: 'KEY_MISMATCH' } : { ok: true, count: 1, wrote: true };
    });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const body = JSON.stringify({ nonce, payload: { __action: 'submit', phrase: PHRASE } });

    const refused = await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    // `{ next: true }` is the contract the screen's wizard implements: it
    // freezes and reloads, and the same address serves the step again.
    expect(await refused.json()).toEqual({ next: true });

    const again = await (await fetch(u.href)).text();
    expect(again).toContain('KEY_MISMATCH');
    // The words that did not work are not re-served with the page.
    expect(again).not.toContain('word0');

    await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body });
    expect(await done).toEqual({ action: 'decrypted', count: 1, wrote: true });
  });

  test('the session step will only answer with its own flag', async () => {
    // Reusing a cached master key off the back of a submit the screen could not
    // have produced is not a thing to guess at.
    let url = '';
    let called = false;
    const done = decryptInBrowser(
      { ...BASE, session: { orgName: 'org_123', startedAt: 'just now' }, onListen: (u) => (url = u), timeoutMs: 4_000 },
      async () => {
        called = true;
        return { ok: true, count: 1, wrote: true };
      },
    );
    void done.catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', phrase: PHRASE } }),
    });
    expect((await res.json()).error).toContain('session step');
    expect(called).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', useSession: true } }),
    });
    expect(await done).toEqual({ action: 'decrypted', count: 1, wrote: true });
  });

  test('a phrase that is not even a string is refused, not attempted', async () => {
    let url = '';
    let called = false;
    const done = decryptInBrowser({ ...BASE, onListen: (u) => (url = u), timeoutMs: 4_000 }, async () => {
      called = true;
      return { ok: true, count: 0, wrote: false };
    });
    void done.catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', phrase: 24 } }),
    });
    expect((await res.json()).error).toContain('phrase step');
    expect(called).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toEqual({ action: 'cancelled', reason: 'declined' });
  });

  test('an .env with nothing encrypted in it is not a failure', async () => {
    let url = '';
    const done = decryptInBrowser({ ...BASE, onListen: (u) => (url = u) }, async () => ({
      ok: true,
      count: 0,
      wrote: false,
    }));
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', phrase: PHRASE } }),
    });
    expect(await done).toEqual({ action: 'decrypted', count: 0, wrote: false });
  });

  test('cancelling decrypts nothing and says so', async () => {
    let url = '';
    let called = false;
    const done = decryptInBrowser({ ...BASE, onListen: (u) => (url = u) }, async () => {
      called = true;
      return { ok: true, count: 1, wrote: true };
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toEqual({ action: 'cancelled', reason: 'declined' });
    expect(called).toBe(false);
  });
});

describe('showDecryptResult', () => {
  test('stops holding the process open when nothing comes to look at it', async () => {
    // The page is served by a socket in THIS process, so the process cannot
    // exit while it is listening. This used to return in about four
    // milliseconds and leave that socket up for the ScreenServer's full two
    // minutes — after the plaintext was already written and the result already
    // printed — on every run where nothing opened the URL: a headless agent,
    // `--no-open`, or an `open()` that failed into its own empty catch.
    let url = '';
    const started = Date.now();
    await showDecryptResult(
      { ...BASE, onListen: (u) => (url = u) },
      { count: 2, wrote: true },
      { timeoutMs: 600 },
    );
    const waited = Date.now() - started;

    // It waited — the URL it printed was reachable for that whole window…
    expect(waited).toBeGreaterThanOrEqual(500);
    // …and then stopped, rather than lingering.
    expect(waited).toBeLessThan(5_000);

    // The socket is closed with it: refused, not answered.
    expect(url).toContain('http://127.0.0.1:');
    await expect(fetch(url)).rejects.toBeDefined();
  }, 20_000);

  test('the result page carries counts and a filename, and no variable name', async () => {
    let url = '';
    const shown = showDecryptResult(
      { ...BASE, onListen: (u) => (url = u) },
      { count: 2, wrote: true },
      { timeoutMs: 5_000 },
    );
    const html = await (await fetch(await waitForUrl(() => url))).text();
    expect(html).toContain('.env.main.decrypted');
    expect(html).not.toContain('STRIPE');
    await shown;
  }, 20_000);
});
