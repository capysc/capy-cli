import { describe, test, expect } from 'bun:test';
import { runLocalOnboardingWeb } from '../../src/ui/onboardingWeb';
import { generateSeedPhrase, validateSeedPhrase } from '../../src/crypto/keyManager';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 200 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

function post(base: string, nonce: string, payload: Record<string, unknown>) {
  return fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload }) });
}

describe('runLocalOnboardingWeb (capy byoc --web)', () => {
  test('generate path: shows a fresh phrase in-page, finalizes with phrase+passphrase, never returns the phrase', async () => {
    let url = '';
    let finalized: { phrase: string; passphrase: string } | null = null;
    const done = runLocalOnboardingWeb(
      (phrase, passphrase) => {
        finalized = { phrase, passphrase };
      },
      { open: false, onListen: (u) => (url = u) },
    );

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Step 0: choose "generate" → the next screen DISPLAYS the 24-word phrase.
    const s1 = await (await post(base, nonce, { mode: 'generate' })).json();
    expect(s1.screen).toContain('written down'); // phrase-display screen
    // The phrase grid shows word #24 — proof all 24 rendered in the page.
    expect(s1.screen).toContain('>24<');

    // Step 1: confirm saved → passphrase screen.
    const s2 = await (await post(base, nonce, { saved: 'on' })).json();
    expect(s2.screen).toContain('Confirm passphrase');

    // Step 2: set a valid, matching passphrase → done.
    const s3 = await (await post(base, nonce, { passphrase: 'hunter2hunter', confirm: 'hunter2hunter' })).json();
    expect(s3.done).toBe(true);

    const result = await done;
    expect(result).toBe(true); // boolean, NOT the phrase
    expect(finalized).not.toBeNull();
    expect(validateSeedPhrase(finalized!.phrase)).toBe(true);
    expect(finalized!.passphrase).toBe('hunter2hunter');
  });

  test('enter path: rejects an invalid phrase inline, then accepts a valid one', async () => {
    let url = '';
    let finalized: { phrase: string; passphrase: string } | null = null;
    const validPhrase = generateSeedPhrase();
    const done = runLocalOnboardingWeb(
      (phrase, passphrase) => {
        finalized = { phrase, passphrase };
      },
      { open: false, onListen: (u) => (url = u) },
    );

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Step 0: choose "enter".
    const s1 = await (await post(base, nonce, { mode: 'enter' })).json();
    expect(s1.screen).toContain('existing 24-word');

    // Step 1a: an invalid phrase → inline error, still on the enter step.
    const bad = await (await post(base, nonce, { phrase: 'not a real phrase' })).json();
    expect(bad.error).toContain('not a valid');
    expect(bad.screen).toBeUndefined();

    // Step 1b: a valid phrase advances to the passphrase screen.
    const ok = await (await post(base, nonce, { phrase: validPhrase })).json();
    expect(ok.screen).toContain('Confirm passphrase');

    const fin = await (await post(base, nonce, { passphrase: 'correct-horse', confirm: 'correct-horse' })).json();
    expect(fin.done).toBe(true);

    expect(await done).toBe(true);
    expect(finalized!.phrase).toBe(validPhrase);
    expect(finalized!.passphrase).toBe('correct-horse');
  });

  test('passphrase mismatch and too-short are rejected inline (no finalize)', async () => {
    let url = '';
    let finalizeCalls = 0;
    const done = runLocalOnboardingWeb(() => finalizeCalls++, { open: false, onListen: (u) => (url = u) });

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    await post(base, nonce, { mode: 'generate' });
    await post(base, nonce, { saved: 'on' });

    // Too short → inline error, still on passphrase step.
    const short = await (await post(base, nonce, { passphrase: 'short', confirm: 'short' })).json();
    expect(short.error).toContain('at least 8');
    expect(short.done).toBeUndefined();

    // Mismatch → inline error.
    const mismatch = await (await post(base, nonce, { passphrase: 'longenough1', confirm: 'longenough2' })).json();
    expect(mismatch.error).toContain('do not match');

    expect(finalizeCalls).toBe(0);

    // Finally, a good one finishes.
    const ok = await (await post(base, nonce, { passphrase: 'longenough1', confirm: 'longenough1' })).json();
    expect(ok.done).toBe(true);
    expect(await done).toBe(true);
    expect(finalizeCalls).toBe(1);
  });
});
