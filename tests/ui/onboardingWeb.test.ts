/**
 * The three flows that handle a recovery phrase or a passphrase, now served as
 * compiled screens.
 *
 * The behaviour that mattered in the hand-written version is kept and re-tested
 * here — a fresh phrase renders in the page, `finalize` gets phrase and
 * passphrase, and the wizard's result is a boolean rather than the words — and
 * two things the old path could not do are added, because they are the reason
 * it was replaced:
 *
 *   - the generated phrase is refused if it ever comes BACK. It travels one
 *     way, and a payload carrying it did not come from a screen that has one.
 *   - naming an organization and writing down its phrase are one wizard with
 *     one rail, instead of two loopback windows that never mentioned each
 *     other.
 *
 * These drive the loopback with fetch, which proves the transport and proves
 * nothing about the page. The click-level check is in browserFlow.e2e.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildCreateOrganizationData,
  buildLocalOnboardingData,
  buildPassphraseUnlockData,
  createOrganizationInBrowser,
  runLocalOnboardingWeb,
  unlockPassphraseInBrowser,
  SEED_PHRASE_WORDS,
} from '../../src/ui/onboardingWeb';
import { generateSeedPhrase, validateSeedPhrase } from '../../src/crypto/keyManager';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

/**
 * A submit, plus the page the browser would fetch next.
 *
 * A standalone step advances by RELOADING, so the CLI answers `{ next: true }`
 * and holds the next screen for the following GET. A test that only posted
 * would never see the step it just unlocked.
 */
function driver(pageUrl: string) {
  const u = new URL(pageUrl);
  const base = `http://127.0.0.1:${u.port}`;
  const nonce = u.searchParams.get('n') ?? '';
  return {
    base,
    nonce,
    page: async (): Promise<string> => (await fetch(pageUrl)).text(),
    /**
     * The payload the served page carries.
     *
     * Asserted against instead of the document, because a compiled screen is a
     * minified bundle of ordinary English identifiers and BIP-39 words are
     * ordinary English: "is the first word of the phrase absent from this
     * HTML?" is a question that answers itself differently depending on which
     * phrase was generated.
     */
    data: async (): Promise<Record<string, unknown>> => {
      const html = await (await fetch(pageUrl)).text();
      return JSON.parse(
        html.match(/window\.__CAPY_DATA__ = (\{.*?\});/s)![1].replace(/\\u003c/g, '<'),
      );
    },
    post: async (payload: Record<string, unknown>) =>
      (
        await fetch(`${base}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ nonce, payload }),
        })
      ).json() as Promise<Record<string, unknown>>,
  };
}

const submit = (answer: Record<string, unknown>) => ({ __action: 'submit', ...answer });

// ---------------------------------------------------------------------------
// local-onboarding
// ---------------------------------------------------------------------------

describe('buildLocalOnboardingData', () => {
  test('the route is declared whole on the very first render', () => {
    const d = buildLocalOnboardingData({}, 'n');
    expect(d.view).toBe('choose-source');
    expect(d.stops!.map((s) => s.id)).toEqual(['source', 'phrase', 'passphrase', 'finish']);
    expect(d.expectedWords).toBe(SEED_PHRASE_WORDS);
    expect(d.minPassphraseLength).toBe(8);
  });

  test('the words reach the display step and no other', () => {
    const words = ['alpha', 'bravo', 'charlie'];
    expect(
      buildLocalOnboardingData({ source: 'generate', phraseWords: words }, 'n').phraseWords,
    ).toEqual(words);
    // Written down: the run has moved on, and the page it moves on to has no
    // business holding a master key.
    expect(
      buildLocalOnboardingData(
        { source: 'generate', phraseWords: words, phraseSettled: true },
        'n',
      ).phraseWords,
    ).toBeUndefined();
    // Restoring: the user has the words; the page never echoes them back.
    expect(buildLocalOnboardingData({ source: 'enter' }, 'n').phraseWords).toBeUndefined();
  });

  test('the source decides which phrase step is served', () => {
    expect(buildLocalOnboardingData({ source: 'generate' }, 'n').view).toBe('phrase');
    expect(buildLocalOnboardingData({ source: 'enter' }, 'n').view).toBe('enter-phrase');
    expect(
      buildLocalOnboardingData({ source: 'enter', phraseSettled: true }, 'n').view,
    ).toBe('passphrase');
  });

  test('strips the terminal colour codes off the warning block', () => {
    const d = buildLocalOnboardingData({ bodyLines: ['\x1b[31mIF YOU LOSE THIS\x1b[0m'] }, 'n');
    expect(d.bodyLines).toEqual(['IF YOU LOSE THIS']);
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('says this step cannot be answered headlessly, rather than how', () => {
    // An empty command is the contract's way of refusing: a passphrase in argv
    // outlives the run in shell history and in whatever captured it.
    expect(buildLocalOnboardingData({}, 'n').nonTty!.command).toBe('');
  });
});

describe('runLocalOnboardingWeb (capy byoc --web)', () => {
  test('generate path: the phrase renders in the page, finalizes, and never comes back', async () => {
    let url = '';
    let finalized: { phrase: string; passphrase: string } | null = null;
    const done = runLocalOnboardingWeb(
      (phrase, passphrase) => {
        finalized = { phrase, passphrase };
      },
      { open: false, onListen: (u) => (url = u) },
    );

    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ source: 'generate' }))).toEqual({ next: true });

    // The phrase step is a whole document, fetched at the same address.
    expect(await d.page()).toContain('window.__CAPY_DATA__');
    const words = (await d.data()).phraseWords as string[];
    expect(words).toHaveLength(SEED_PHRASE_WORDS);
    expect(validateSeedPhrase(words.join(' '))).toBe(true);

    expect(await d.post(submit({ confirmed: true }))).toEqual({ next: true });
    // Written down, so the page it moves on to no longer holds a master key.
    expect((await d.data()).phraseWords).toBeUndefined();
    expect(await d.post(submit({ passphrase: 'hunter2hunter', confirm: 'hunter2hunter' }))).toEqual({
      done: true,
    });

    // A boolean, NOT the phrase.
    expect(await done).toBe(true);
    expect(finalized).not.toBeNull();
    expect(finalized!.phrase).toBe(words.join(' '));
    expect(finalized!.passphrase).toBe('hunter2hunter');
  });

  test('a generated phrase offered back is refused, not keyed with', async () => {
    // The display step sends consent and nothing else, so words arriving there
    // came from something that is not that step — and using them would key
    // this machine from the wire.
    let url = '';
    let finalizeCalls = 0;
    const done = runLocalOnboardingWeb(() => finalizeCalls++, {
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ source: 'generate' }));
    const refused = await d.post(
      submit({ confirmed: true, phrase: generateSeedPhrase() }),
    );
    expect(refused.error).toContain('not something this step sends back');
    expect(finalizeCalls).toBe(0);

    // Consent alone still works.
    expect(await d.post(submit({ confirmed: true }))).toEqual({ next: true });
    await d.post(submit({ passphrase: 'longenough1', confirm: 'longenough1' }));
    expect(await done).toBe(true);
  });

  test('the write-it-down gate is enforced by the CLI too, not only the page', async () => {
    let url = '';
    const done = runLocalOnboardingWeb(() => undefined, {
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ source: 'generate' }));
    expect((await d.post(submit({}))).error).toContain('written down');
    await d.post({ __action: 'cancel' });
    expect(await done).toBe(false);
  });

  test('enter path: an invalid phrase is refused inline, keeping what was typed', async () => {
    let url = '';
    let finalized: { phrase: string; passphrase: string } | null = null;
    const valid = generateSeedPhrase();
    const done = runLocalOnboardingWeb(
      (phrase, passphrase) => {
        finalized = { phrase, passphrase };
      },
      { open: false, onListen: (u) => (url = u) },
    );

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ source: 'enter' }));

    // Inline (no `next`), so the wizard stays on the step it is on: re-serving
    // would wipe twenty-four words over one wrong one.
    const bad = await d.post(submit({ source: 'enter', phrase: 'not a real phrase' }));
    expect(bad.error).toContain(`not a valid ${SEED_PHRASE_WORDS}-word`);
    expect(bad.next).toBeUndefined();

    expect(await d.post(submit({ source: 'enter', phrase: valid }))).toEqual({ next: true });
    await d.post(submit({ passphrase: 'correct-horse', confirm: 'correct-horse' }));

    expect(await done).toBe(true);
    expect(finalized!.phrase).toBe(valid);
  });

  test('the passphrase checks run in the CLI\'s own order, and nothing is written until both pass', async () => {
    let url = '';
    let finalizeCalls = 0;
    const done = runLocalOnboardingWeb(() => finalizeCalls++, {
      open: false,
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ source: 'generate' }));
    await d.post(submit({ confirmed: true }));

    expect((await d.post(submit({ passphrase: 'short', confirm: 'short' }))).error).toContain(
      'at least 8',
    );
    // Length before match, matching the terminal: both are true here and the
    // length is the more actionable of the two.
    expect((await d.post(submit({ passphrase: 'short', confirm: 'other' }))).error).toContain(
      'at least 8',
    );
    expect(
      (await d.post(submit({ passphrase: 'longenough1', confirm: 'longenough2' }))).error,
    ).toContain('do not match');
    expect(finalizeCalls).toBe(0);

    await d.post(submit({ passphrase: 'longenough1', confirm: 'longenough1' }));
    expect(await done).toBe(true);
    expect(finalizeCalls).toBe(1);
  });

  test('a finalize that throws stays on the step and says what failed', async () => {
    let url = '';
    const done = runLocalOnboardingWeb(
      () => {
        throw new Error('EACCES: permission denied');
      },
      { open: false, timeoutMs: 4_000, onListen: (u) => (url = u) },
    );
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ source: 'generate' }));
    await d.post(submit({ confirmed: true }));
    const failed = await d.post(submit({ passphrase: 'longenough1', confirm: 'longenough1' }));
    expect(failed.error).toContain('EACCES');
    // Never a promise that nothing changed: finalize writes three things in
    // sequence and a failure part-way through has written some of them.
    expect(failed.error).not.toContain('nothing was changed');

    await d.post({ __action: 'cancel' });
    expect(await done).toBe(false);
  });

  test('a source the screen does not offer is refused', async () => {
    let url = '';
    const done = runLocalOnboardingWeb(() => undefined, {
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    expect((await d.post(submit({ source: 'import-from-1password' }))).error).toContain(
      'not a phrase source',
    );
    await d.post({ __action: 'cancel' });
    await done;
  });
});

// ---------------------------------------------------------------------------
// create-organization
// ---------------------------------------------------------------------------

const ORG_NOTES = ['This recovery phrase generates the master key for', 'all projects.'];
const ORG_BASE = {
  phrase: 'alpha bravo charlie delta',
  bodyLines: ORG_NOTES,
  learnMoreUrl: 'https://capy.sc/zero-trust',
  maxNameLength: 100,
  open: false,
};

describe('buildCreateOrganizationData', () => {
  test('opens on the name, with the phrase nowhere near the payload', () => {
    const d = buildCreateOrganizationData(ORG_BASE, 'n');
    expect(d.view).toBe('name');
    expect(d.phraseWords).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('bravo');
    expect(d.maxNameLength).toBe(100);
    expect(d.stops!.map((s) => s.id)).toEqual(['name', 'phrase', 'create']);
  });

  test('a named organization gets the phrase step, and the words with it', () => {
    const d = buildCreateOrganizationData({ ...ORG_BASE, state: { name: 'Northwind' } }, 'n');
    expect(d.view).toBe('phrase');
    expect(d.phraseWords).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    // The count is not assumed: the grid renders what it is given.
    expect(d.phraseWords).toHaveLength(4);
  });

  test('a refused name puts the run back on the name step with the code, not a sentence', () => {
    const d = buildCreateOrganizationData(
      { ...ORG_BASE, state: { name: 'Northwind', nameError: 'TAKEN' } },
      'n',
    );
    expect(d.view).toBe('name');
    expect(d.nameError).toBe('TAKEN');
    expect(d.nameStatus).toBe('taken');
    expect(d.name).toBe('Northwind');
    // Still no phrase: the run has not reached that step.
    expect(d.phraseWords).toBeUndefined();
  });

  test('a name-only retry never reaches the phrase step, and says it is behind', () => {
    // The 409 path. The phrase has already been shown and written down, so
    // showing it again would make "this is the only time it is shown" false the
    // first time anyone read it.
    const d = buildCreateOrganizationData(
      { ...ORG_BASE, nameOnly: true, state: { name: 'Acme', nameError: 'RACE_409' } },
      'n',
    );
    expect(d.view).toBe('name');
    expect(d.nameError).toBe('RACE_409');
    expect(d.phraseWords).toBeUndefined();
    expect(d.stops!.find((s) => s.id === 'phrase')).toMatchObject({
      state: 'done',
      answer: 'written down',
    });
  });

  test('the learn-more URL is structured, not left as a line of the warning', () => {
    const d = buildCreateOrganizationData(ORG_BASE, 'n');
    expect(d.learnMoreUrl).toBe('https://capy.sc/zero-trust');
    expect(d.bodyLines).toEqual(ORG_NOTES);
    expect(d.bodyLines!.join(' ')).not.toContain('capy.sc');
  });
});

describe('createOrganizationInBrowser', () => {
  const phrase = generateSeedPhrase();

  test('names it, shows the phrase, and returns the name and nothing else', async () => {
    let url = '';
    const checked: string[] = [];
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      checkName: async (n) => {
        checked.push(n);
        return 'available';
      },
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ name: '  Northwind Labs  ' }))).toEqual({ next: true });
    expect(checked).toEqual(['Northwind Labs']);

    expect(await d.data()).toMatchObject({
      view: 'phrase',
      phraseWords: phrase.split(' '),
    });

    expect(await d.post(submit({ confirmed: true }))).toEqual({ done: true });
    expect(await done).toEqual({ name: 'Northwind Labs', cancelled: false });
  });

  test('a taken name comes back as a fresh page carrying the code', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      checkName: async (n) => (n === 'Acme' ? 'taken' : 'available'),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    // A real refusal the page could not have made for itself, so it is re-served
    // rather than answered inline.
    expect(await d.post(submit({ name: 'Acme' }))).toEqual({ next: true });
    expect(await d.data()).toMatchObject({ view: 'name', name: 'Acme', nameError: 'TAKEN' });
    // And the phrase still has not been shown.
    expect((await d.data()).phraseWords).toBeUndefined();

    await d.post(submit({ name: 'Acme Labs' }));
    await d.post(submit({ confirmed: true }));
    expect(await done).toEqual({ name: 'Acme Labs', cancelled: false });
  });

  test('the 409 retry finishes at the name, without showing the phrase again', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      name: 'Acme',
      nameError: 'RACE_409',
      nameOnly: true,
      checkName: async () => 'available',
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ name: 'Acme Labs' }))).toEqual({ done: true });
    expect(await done).toEqual({ name: 'Acme Labs', cancelled: false });
  });

  test('a name check that cannot reach the service carries on, as the terminal does', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      checkName: async () => 'unreachable',
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ name: 'Northwind' }))).toEqual({ next: true });
    await d.post(submit({ confirmed: true }));
    expect((await done).name).toBe('Northwind');
  });

  test('the phrase is refused if it is offered back', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      timeoutMs: 4_000,
      checkName: async () => 'available',
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ name: 'Northwind' }));
    expect((await d.post(submit({ confirmed: true, phrase }))).error).toContain(
      'not something this step sends back',
    );
    await d.post({ __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });

  test('an empty or over-long name is refused rather than sent', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      maxNameLength: 10,
      timeoutMs: 4_000,
      checkName: async () => 'available',
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    expect((await d.post(submit({ name: '   ' }))).error).toContain('cannot be empty');
    expect((await d.post(submit({ name: 'x'.repeat(11) }))).error).toContain('10 characters');
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('cancelling creates nothing and says so', async () => {
    let url = '';
    const done = createOrganizationInBrowser({
      ...ORG_BASE,
      phrase,
      checkName: async () => 'available',
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'cancel' });
    expect(await done).toEqual({ name: '', cancelled: true });
  });
});

// ---------------------------------------------------------------------------
// local-passphrase-unlock
// ---------------------------------------------------------------------------

describe('buildPassphraseUnlockData', () => {
  test('says who is asking and why, which the terminal prompt does not', () => {
    const d = buildPassphraseUnlockData(
      {
        triggeredBy: 'run',
        triggerCommand: 'capy run -- npm start',
        projectName: 'mikes-market',
        lockedBy: 'idle',
        idleTimeoutMs: 3_600_000,
      },
      'n',
    );
    expect(d.view).toBe('unlock');
    expect(d.triggeredBy).toBe('run');
    expect(d.idleTimeoutMs).toBe(3_600_000);
    expect(d.nonTty!.command).toBe('');
  });

  test('carries no passphrase, and nothing a passphrase could be derived from', () => {
    const json = JSON.stringify(buildPassphraseUnlockData({ projectName: 'x' }, 'n'));
    expect(json).not.toContain('passphrase":"');
    expect(JSON.parse(json).wrongPassphrase).toBeUndefined();
  });
});

describe('unlockPassphraseInBrowser', () => {
  test('a correct passphrase hands back the key and nothing else', async () => {
    let url = '';
    const seen: string[] = [];
    const done = unlockPassphraseInBrowser(
      (pass) => {
        seen.push(pass);
        return pass === 'correct-horse' ? { ok: true, masterKeyHex: 'deadbeef' } : { ok: false };
      },
      { open: false, onListen: (u) => (url = u) },
    );

    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ passphrase: 'correct-horse' }))).toEqual({ done: true });
    expect(await done).toBe('deadbeef');
    expect(seen).toEqual(['correct-horse']);
  });

  test('a wrong passphrase offers the field again instead of killing the command', async () => {
    // The terminal has no retry at all: a wrong passphrase becomes a typed
    // error and the command dies, and at three of the five call sites the words
    // "Incorrect passphrase." never reach the user.
    let url = '';
    const done = unlockPassphraseInBrowser(
      (pass) => (pass === 'right' ? { ok: true, masterKeyHex: 'cafe' } : { ok: false }),
      { open: false, onListen: (u) => (url = u) },
    );

    const d = driver(await waitForUrl(() => url));
    const refused = await d.post(submit({ passphrase: 'wrong' }));
    expect(refused.error).toBe('Incorrect passphrase.');
    expect(refused.done).toBeUndefined();

    await d.post(submit({ passphrase: 'right' }));
    expect(await done).toBe('cafe');
  });

  test('an empty passphrase is refused before anything is derived from it', async () => {
    let url = '';
    let attempts = 0;
    const done = unlockPassphraseInBrowser(
      () => {
        attempts++;
        return { ok: false };
      },
      { open: false, timeoutMs: 4_000, onListen: (u) => (url = u) },
    );

    const d = driver(await waitForUrl(() => url));
    expect((await d.post(submit({}))).error).toContain('Enter your local passphrase');
    expect(attempts).toBe(0);
    await d.post({ __action: 'cancel' });
    expect(await done).toBeNull();
  });

  test('cancelling unlocks nothing', async () => {
    let url = '';
    const done = unlockPassphraseInBrowser(() => ({ ok: true, masterKeyHex: 'cafe' }), {
      open: false,
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'cancel' });
    expect(await done).toBeNull();
  });
});
