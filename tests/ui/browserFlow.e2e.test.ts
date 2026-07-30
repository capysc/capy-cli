/**
 * The browser end-to-end tests: a real headless browser loads the page the CLI
 * serves, clicks the controls a person would click, and the CLI's own reducer
 * says what it received.
 *
 * WHY THIS EXISTS. Every other test here drives the loopback server with fetch,
 * which proves the transport and proves nothing about the page. That gap is not
 * theoretical — the screens shipped a "Continue in terminal" button wired to a
 * hand-back no branch of this CLI ever implemented, a control key the server
 * does not read, and an answer shape the reducer could not parse. Each was
 * carefully reasoned about, and each would have died on first contact with a
 * click.
 *
 * These tests emulate the MCP flow, which is the only flow: `--web` is agent
 * -only, so a headless browser driving the page IS the real usage, not a
 * simulation of it.
 *
 * Skipped when no Chrome for Testing shell is cached, so a standalone clone
 * still runs its suite. Install one with:
 *   bunx @puppeteer/browsers install chrome-headless-shell@stable
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, findHeadlessShell, type CdpSession } from '../helpers/cdp';
import { runBrowserWizard } from '../../src/ui/browserWizard';

const HAS_BROWSER = findHeadlessShell() !== null;
const describeBrowser = HAS_BROWSER ? describe : describe.skip;

if (!HAS_BROWSER) {
  console.warn(
    'browserFlow.e2e: no cached chrome-headless-shell — skipping. ' +
      'Install: bunx @puppeteer/browsers install chrome-headless-shell@stable',
  );
}

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 400 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate<T>(page: CdpSession, expression: string): Promise<T> {
  const res = (await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'page threw');
  return res.result?.value as T;
}

/** Poll a predicate in the page until it holds, or fail loudly. */
async function until(page: CdpSession, expression: string, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    // Everything this file waits for arrives by NAVIGATION — a standalone step
    // advances by reloading the same address — and a poll that lands while the
    // document is being swapped comes back as "Inspected target navigated or
    // closed" rather than as `false`. That is the page arriving, not the page
    // failing, so it is another turn of the loop and not the answer.
    try {
      if (await evaluate<boolean>(page, `!!(${expression})`)) return;
    } catch {
      /* mid-navigation; ask again */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeBrowser('browser flow, driven by a real browser', () => {
  let browser: Browser | null = null;
  let profile = '';

  afterEach(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function open(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 820);
    const loaded = page.once('Page.loadEventFired', 20_000);
    await page.send('Page.navigate', { url });
    await loaded;
    return page;
  }

  test('typing in the form and clicking submit reaches the reducer', async () => {
    let url = '';
    const seen: Array<Record<string, unknown>> = [];
    const done = runBrowserWizard(
      {
        title: 'Name your branch',
        firstScreen: {
          html: '<form><input name="branch" value=""><button type="submit">Create the branch</button></form>',
        },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        seen.push(payload);
        return { done: true, result: payload };
      },
    );

    const page = await open(await waitForUrl(() => url));

    // Type like a person: set the field, then click the button by its text.
    await evaluate(page, `document.querySelector('input[name=branch]').value = 'feature/checkout'`);
    await evaluate(
      page,
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Create the branch')).click()`,
    );

    expect(await done).toEqual({ branch: 'feature/checkout' });
    expect(seen).toHaveLength(1);
    expect(seen[0].branch).toBe('feature/checkout');
  }, 60_000);

  test('a screen posting structured JSON reaches the reducer intact', async () => {
    // The path the compiled screens use. A flat form cannot express this.
    let url = '';
    let received: Record<string, unknown> | undefined;
    const done = runBrowserWizard(
      {
        title: 'Resolve',
        firstScreen: { html: '<button id="go">Resolve all</button>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        received = payload;
        return { done: true, result: payload };
      },
    );

    const page = await open(await waitForUrl(() => url));
    await evaluate(
      page,
      `document.getElementById('go').addEventListener('click', () => window.capySubmit({
         resolutions: [{ key: 'STRIPE_KEY', take: 'remote' }, { key: 'DB_URL', take: 'local' }],
         applyToAll: true,
         count: 2,
       })); document.getElementById('go').click()`,
    );

    await done;
    expect(received).toEqual({
      resolutions: [
        { key: 'STRIPE_KEY', take: 'remote' },
        { key: 'DB_URL', take: 'local' },
      ],
      applyToAll: true,
      count: 2,
    });
  }, 60_000);

  test('an inline refusal keeps the user on the step, with the reason on screen', async () => {
    // The CLI answers a refusal with HTTP 200 and an `error` field. A page that
    // read only the status would advance past a step the CLI never took.
    let url = '';
    let attempts = 0;
    const done = runBrowserWizard(
      {
        title: 'Name it',
        firstScreen: {
          html: '<form><input name="name" value="taken"><button type="submit">Use this name</button></form>',
        },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        attempts += 1;
        if (payload.name === 'taken') return { error: 'That name is already in use.' };
        return { done: true, result: payload };
      },
    );

    const page = await open(await waitForUrl(() => url));
    const click = `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this name')).click()`;

    await evaluate(page, click);
    await until(page, `document.getElementById('status').textContent.includes('already in use')`, 'the refusal to show');

    // Still the same step: the form is there and the button is live again.
    expect(await evaluate<boolean>(page, `!!document.querySelector('input[name=name]')`)).toBe(true);
    expect(await evaluate<boolean>(page, `!document.querySelector('button').disabled`)).toBe(true);

    // Correcting it now finishes the flow.
    await evaluate(page, `document.querySelector('input[name=name]').value = 'free'`);
    await evaluate(page, click);
    expect(await done).toEqual({ name: 'free' });
    expect(attempts).toBe(2);
  }, 60_000);

  test('a standalone step is served whole and the page advances by reloading', async () => {
    // The compiled-screen path end to end: no shell around the document, and
    // the browser fetches the next step rather than being handed its markup.
    let url = '';
    const doc = (body: string): string =>
      `<!DOCTYPE html><html><body>${body}<script>
         window.answer = () => fetch('/submit', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ nonce: new URL(location.href).searchParams.get('n'), payload: {} }),
         }).then(r => r.json()).then(b => { if (b.next) location.reload(); return b; });
       </script></body></html>`;

    const done = runBrowserWizard(
      {
        title: 'Compiled',
        firstScreen: { html: doc('<h1 id="h">STEP ONE</h1>'), standalone: true },
        open: false,
        onListen: (u) => (url = u),
      },
      async (step) =>
        step === 0
          ? { screen: { html: doc('<h1 id="h">STEP TWO</h1>'), standalone: true } }
          : { done: true, result: { finished: true } },
    );

    const page = await open(await waitForUrl(() => url));

    // Served as itself — the wizard shell is not wrapped around it.
    expect(await evaluate<string>(page, `document.getElementById('h').textContent`)).toBe('STEP ONE');
    expect(await evaluate<boolean>(page, `!document.getElementById('screen')`)).toBe(true);

    // Answering reloads, and the same URL yields the NEXT step.
    //
    // `void` and a literal, rather than awaiting `answer()`'s promise: that
    // promise settles only after it has asked for the reload, so awaiting it
    // is a race against the navigation that destroys the context it would
    // settle in — which surfaces as a CDP error and not as a failed step.
    // What the answer did is read off the page below, where it is visible.
    await evaluate(page, `void window.answer(); 0`);
    await until(page, `document.getElementById('h') && document.getElementById('h').textContent === 'STEP TWO'`, 'step two');

    await evaluate(page, `void window.answer(); 0`);
    expect(await done).toEqual({ finished: true });
  }, 60_000);

  test('closing the window is refusal: the run never resolves on its own', async () => {
    // Contract: an unanswered step has not been approved. Nothing the browser
    // does by leaving may look like consent.
    let url = '';
    let resolved = false;
    let reducerCalled = false;
    const done = runBrowserWizard(
      {
        title: 'Encrypt and push',
        firstScreen: { html: '<form><button type="submit">Encrypt</button></form>', doneMessage: 'x' },
        open: false,
        onListen: (u) => (url = u),
        timeoutMs: 1_500,
      },
      async () => {
        reducerCalled = true;
        return { done: true, result: { encrypted: true } };
      },
    );
    void done.then(() => (resolved = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    // Leave without answering.
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(reducerCalled).toBe(false);
    expect(resolved).toBe(false);

    // The wizard ends by timing out, not by treating the close as an answer.
    await done.catch(() => undefined);
    expect(reducerCalled).toBe(false);
  }, 60_000);
});

describeBrowser('the sync conflict resolver, driven by a real browser', () => {
  let browser: Browser | null = null;
  let profile = '';

  afterEach(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function open(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 820);
    const loaded = page.once('Page.loadEventFired', 20_000);
    await page.send('Page.navigate', { url });
    await loaded;
    return page;
  }

  const PARAMS = {
    rows: [
      { variable: 'STRIPE_KEY', pinned: 'sk_…001', local: 'sk_…002', remote: 'sk_…003' },
      { variable: 'DB_URL', pinned: 'pos…dev', local: 'pos…loc', remote: 'pos…rem' },
    ],
    unresolvable: new Set<string>(),
    showLocal: true,
    showRemote: true,
    localMode: false,
    isOnboarding: false,
    isBehind: false,
    remoteState: 'ok' as const,
    actions: [
      { value: 'commit_local' as const, label: 'Commit and push all local values' },
      { value: 'retrieve_pinned' as const, label: 'Retrieve all pinned values' },
      { value: 'individual' as const, label: 'Individually resolve' },
      { value: 'skip' as const, label: 'Continue working' },
    ],
    projectName: 'mikes-market',
    branch: 'development',
    open: false,
  };

  test('a whole-run action can be chosen and applied by clicking', async () => {
    // The level the old browser resolver did not have. It discarded the CLI's
    // menu and hard-coded per-variable resolution, so "take theirs" meant
    // answering once per variable.
    const { resolveConflictInBrowser } = await import('../../src/ui/syncConflictScreen');
    let url = '';
    const done = resolveConflictInBrowser({ ...PARAMS, onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));

    // The review stop renders the diff the CLI computed.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_KEY')`)).toBe(true);
    // Snippets only — no full secret reaches the page.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);

    await evaluate(page, `document.querySelector('[data-test=to-choose]').click()`);
    await until(page, `document.querySelector('[data-test=apply-action]')`, 'the action menu');

    // Pick the CLI's own wording, the way a person would.
    await evaluate(
      page,
      `[...document.querySelectorAll('[role=radio],[role=option],li,label')]
         .find(el => el.textContent.trim().startsWith('Retrieve all pinned values')).click()`,
    );
    await evaluate(page, `document.querySelector('[data-test=apply-action]').click()`);

    expect(await done).toEqual({ action: 'retrieve_pinned', choices: {}, cancelled: false });
  }, 60_000);

  test('closing the window resolves nothing', async () => {
    // An unanswered conflict is a refusal. Nothing about leaving may look like
    // agreement to rewrite somebody's .env.
    const { resolveConflictInBrowser } = await import('../../src/ui/syncConflictScreen');
    let url = '';
    let settled = false;
    const done = resolveConflictInBrowser({ ...PARAMS, timeoutMs: 1_500, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);
});

describeBrowser('capy checkout, driven by a real browser', () => {
  let browser: Browser | null = null;
  let profile = '';

  afterEach(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function open(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 820);
    const loaded = page.once('Page.loadEventFired', 20_000);
    await page.send('Page.navigate', { url });
    await loaded;
    return page;
  }

  /**
   * Type into a field the way a person does.
   *
   * Assigning `.value` alone is invisible to the screen: `bind:value` listens
   * for `input`, so a test that only sets the property proves the CLI can read
   * a field nobody could have filled in.
   */
  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  /** Click the button whose visible text contains `text`. */
  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  /**
   * Click the option row whose label is exactly `label`.
   *
   * Exact, on the label element rather than the row: `protected` is a suffix
   * of `unprotected`, and this flow's whole subject is which of those two it
   * ends up being.
   */
  const clickOption = (label: string): string =>
    `[...document.querySelectorAll('[role=radio]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  const EXISTING = [
    { name: 'development', isProtected: false },
    { name: 'production', isProtected: true },
  ];

  const CREATE = {
    projectName: 'mikes-market',
    existingBranches: EXISTING,
    seedFrom: 'development',
    seedVarNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
    open: false,
  };

  test('both stops of the create route are walked by clicking', async () => {
    // The whole point of the standalone path: answering stop one is a page
    // RELOAD, not a markup swap, and the same URL then serves stop two. Three
    // inventions this session died on exactly this.
    const { createBranchInBrowser } = await import('../../src/ui/branchScreens');
    let url = '';
    // No name in argv, so the plan leaves both stops outstanding.
    const done = createBranchInBrowser({ ...CREATE, branchName: '', onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the stop this page is not standing on.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Protection')`)).toBe(true);

    await evaluate(page, type('input[type=text], .field input', 'release'));
    await evaluate(page, clickButton('Use this name'));

    // Stop two arrives by navigation, at the same address.
    await until(page, `document.body.textContent.includes('Protect this branch?')`, 'the protection stop');
    // …with stop one now settled on the rail.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('release')`)).toBe(true);
    // The commit point says what comes across: variable NAMES, never a value.
    // `-b` skips both dirty guards, so this is the only warning there is.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);

    await evaluate(page, clickOption('protected'));
    await evaluate(page, clickButton('Create branch'));

    expect(await done).toEqual({ name: 'release', isProtected: true, cancelled: false });
  }, 60_000);

  test('a name the branch list already holds never reaches the button', async () => {
    // The terminal validates nothing: the name is a positional that goes
    // straight to POST /branches, so "already taken" is the server's prose
    // after a round trip. The screen holds the list, so it answers while the
    // user is still typing — and this is the check that it is wired up.
    const { createBranchInBrowser } = await import('../../src/ui/branchScreens');
    let url = '';
    let settled = false;
    const done = createBranchInBrowser({
      ...CREATE,
      branchName: '',
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    await evaluate(page, type('input[type=text], .field input', 'production'));
    await until(
      page,
      `document.body.textContent.includes('already exists in this project')`,
      'the collision to be named',
    );
    // It says WHICH kind of branch took it, which the server's error does not.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('as a protected branch')`),
    ).toBe(true);
    expect(
      await evaluate<boolean>(page, `document.querySelector('button[type=submit]').disabled`),
    ).toBe(true);

    // Nothing was sent, so nothing was created.
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);

  test('a wrong branch name becomes a picker instead of an exit code', async () => {
    // `capy checkout <typo>` prints the list and exits 1: the branch the user
    // meant is on the screen and unreachable. Here the listing IS the answer.
    const { chooseBranchInBrowser } = await import('../../src/ui/branchScreens');
    let url = '';
    const done = chooseBranchInBrowser({
      projectName: 'mikes-market',
      activeBranch: 'development',
      branches: [
        { id: 'b1', name: 'development', project_id: 'p1', is_protected: false },
        { id: 'b2', name: 'staging', project_id: 'p1', is_protected: false },
        { id: 'b3', name: 'spike', project_id: 'p1', is_protected: true },
      ],
      variableCounts: { development: 14 },
      canDelete: false,
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // Protection is drawn from `is_protected`, so the invite-only branch is
    // marked here — the terminal picker marks nothing and lets a 403 explain.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('protected')`)).toBe(true);
    // A run that cannot delete draws no delete control.
    expect(
      await evaluate<boolean>(
        page,
        `![...document.querySelectorAll('button')].some(b => b.textContent.includes('Delete'))`,
      ),
    ).toBe(true);

    await evaluate(page, clickOption('staging'));
    await evaluate(page, clickButton('Switch branch'));

    expect(await done).toEqual({ branch: 'staging', cancelled: false });
  }, 60_000);

  test('the branch this directory is already on cannot be picked', async () => {
    // The list opens on the current row, so the button starts held down:
    // "switch to where you already are" is not a thing a checkout can do.
    const { chooseBranchInBrowser } = await import('../../src/ui/branchScreens');
    let url = '';
    const done = chooseBranchInBrowser({
      projectName: 'mikes-market',
      activeBranch: 'development',
      branches: [
        { id: 'b1', name: 'development', project_id: 'p1', is_protected: false },
        { id: 'b2', name: 'staging', project_id: 'p1', is_protected: false },
      ],
      canDelete: false,
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Switch branch')).disabled`,
      ),
    ).toBe(true);

    // Choosing another row releases it.
    await evaluate(page, clickOption('staging'));
    await until(
      page,
      `![...document.querySelectorAll('button')].find(b => b.textContent.includes('Switch branch')).disabled`,
      'the switch button to go live',
    );

    await done.catch(() => undefined);
  }, 60_000);
});

/**
 * The three recovery flows, driven by a real browser.
 *
 * These are the highest blast radius in the product: one takes a 24-word
 * phrase and writes a master key, one deletes plaintext, and one puts a bearer
 * credential for the whole account on a page. Every claim about them —
 * "advancing is a reload", "a wrong phrase is a refusal you can retry", "the
 * code cannot come back" — is a claim about a page nobody had clicked until
 * these ran.
 */
describeBrowser('the recovery flows, driven by a real browser', () => {
  let browser: Browser | null = null;
  let profile = '';

  afterEach(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function open(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 820);
    const loaded = page.once('Page.loadEventFired', 20_000);
    await page.send('Page.navigate', { url });
    await loaded;
    return page;
  }

  /** Click the button whose visible text contains `text`. */
  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  /** Click the option row whose label is exactly `label`. */
  const clickOption = (role: 'radio' | 'checkbox', label: string): string =>
    `[...document.querySelectorAll('[role=${role}]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  /**
   * Fill the word grid the way a person does, box by box.
   *
   * Assigning `.value` alone is invisible to the screen: each box listens for
   * `input`, and the screen refuses to submit until its own BIP-39 check
   * passes — so a test that only set the property would prove the CLI can read
   * a phrase nobody could have entered.
   */
  const typePhrase = (phrase: string): string =>
    `(() => {
       ${JSON.stringify(phrase)}.split(' ').forEach((word, i) => {
         const el = document.querySelector('input[aria-label="Word ' + (i + 1) + '"]');
         el.value = word;
         el.dispatchEvent(new Event('input', { bubbles: true }));
       });
     })()`;

  const ORGS = [
    { id: 'org-demos', name: 'Demos', hasKeyOnThisDevice: false },
    { id: 'org-capy', name: 'Capy', hasKeyOnThisDevice: true },
  ];

  test('capy recover walks all three stops by clicking, and the key is written once', async () => {
    // The whole route in one run: pick the organization that already holds a
    // key here, agree to destroy it, then type the phrase. Each answer is a
    // page RELOAD serving the next stop at the same address.
    const { recoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');
    const phrase = generateSeedPhrase();

    const scoped: string[] = [];
    const verified: string[] = [];
    const written: Array<{ orgId: string; phrase: string }> = [];
    let url = '';
    const done = recoverInBrowser({
      userEmail: 'vince@capy.sc',
      orgs: ORGS,
      wordCount: 24,
      open: false,
      onListen: (u) => (url = u),
      ops: {
        scopeToOrg: async (orgId) => {
          scoped.push(orgId);
          return true;
        },
        verifyPhrase: async (_orgId, p) => {
          verified.push(p);
          return { code: 'MATCH', kdfVersion: 2 };
        },
        writeKey: async (orgId, p) => {
          written.push({ orgId, phrase: p });
          return { ok: true, keyPath: `~/.capy/orgs/${orgId}/users/u1/key.enc` };
        },
      },
    });

    const page = await open(await waitForUrl(() => url));

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the destructive stop the terminal springs on you afterwards.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Overwrite')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Recovery phrase')`)).toBe(true);

    await evaluate(page, clickOption('radio', 'Capy'));
    await evaluate(page, clickButton('Use this organization'));

    // Stop two arrives by navigation, at the same address.
    await until(
      page,
      `document.body.textContent.includes('Overwrite the key on this device')`,
      'the overwrite stop',
    );
    expect(scoped).toEqual(['org-capy']);
    // It is held down until the consent is ticked: nothing is replaced by the
    // act of arriving here.
    expect(
      await evaluate<boolean>(page, `document.querySelector('button[type=submit]').disabled`),
    ).toBe(true);

    await evaluate(page, `document.querySelector('button.box-row[role=checkbox]').click()`);
    await evaluate(page, clickButton('Overwrite key'));

    await until(page, `document.querySelector('input[aria-label="Word 24"]')`, 'the phrase stop');
    // The words are masked as they are typed, like the terminal's prompt.
    expect(
      await evaluate<string>(page, `document.querySelector('input[aria-label="Word 1"]').type`),
    ).toBe('password');

    await evaluate(page, typePhrase(phrase));
    await evaluate(page, clickButton('Recover key'));

    expect(await done).toEqual({
      orgId: 'org-capy',
      orgName: 'Capy',
      kdfVersion: 2,
      keyPath: '~/.capy/orgs/org-capy/users/u1/key.enc',
      cancelled: false,
    });
    // The phrase crossed the loopback once, because the CLI has to check it,
    // and the key was written once.
    expect(verified).toEqual([phrase]);
    expect(written).toEqual([{ orgId: 'org-capy', phrase }]);
  }, 90_000);

  test('a phrase that matches nothing comes back as the same stop, with the boxes empty', async () => {
    // The terminal exits 1 here and the whole command has to be re-run. The
    // requirement is a refusal the user can retry — never a crash, and never a
    // key written from a phrase that proved nothing.
    const { recoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');
    const right = generateSeedPhrase();
    let wrong = generateSeedPhrase();
    while (wrong === right) wrong = generateSeedPhrase();

    const written: string[] = [];
    let url = '';
    const done = recoverInBrowser({
      orgs: [ORGS[0]],
      wordCount: 24,
      open: false,
      onListen: (u) => (url = u),
      ops: {
        scopeToOrg: async () => true,
        verifyPhrase: async (_o, p) =>
          p === right ? { code: 'MATCH', kdfVersion: 1 } : { code: 'NO_MATCH' },
        writeKey: async (orgId) => {
          written.push(orgId);
          return { ok: true, keyPath: 'k' };
        },
      },
    });

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('radio', 'Demos'));
    await evaluate(page, clickButton('Use this organization'));
    await until(page, `document.querySelector('input[aria-label="Word 24"]')`, 'the phrase stop');

    await evaluate(page, typePhrase(wrong));
    await evaluate(page, clickButton('Recover key'));

    // The CLI's own sentence, worded by the screen off the code it sent.
    await until(
      page,
      `document.body.textContent.includes('does not match any secrets in Demos')`,
      'the refusal',
    );
    expect(written).toEqual([]);
    // Every box is empty again — a rejected phrase leaves nothing behind, and
    // the page it came back on carries none of it.
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('input[aria-label^="Word "]')].every(el => el.value === '')`,
      ),
    ).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes(${JSON.stringify(wrong.split(' ')[0] + ' ' + wrong.split(' ')[1])})`)).toBe(false);

    // Typing the right one now finishes the run.
    await evaluate(page, typePhrase(right));
    await evaluate(page, clickButton('Recover key'));
    expect((await done).kdfVersion).toBe(1);
    expect(written).toEqual(['org-demos']);
  }, 90_000);

  test('a bolded organization name reaches the page as text, never as escape codes', async () => {
    // The CLI bolds an org name and dims an email everywhere it PRINTS them,
    // and hands the same strings to the screen. Three of the four places they
    // land were stripped and the rail was not, so the station that reads your
    // own answer back rendered a literal `[1m` beside the clean copy in the
    // body — a browser is not a terminal and nothing there interprets an
    // escape.
    const { recoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const ESC = String.fromCharCode(27);
    let url = '';
    const done = recoverInBrowser({
      userEmail: `${ESC}[90mvince@capy.sc${ESC}[0m`,
      orgs: [{ id: 'org-demos', name: `${ESC}[1mDemos${ESC}[0m`, hasKeyOnThisDevice: false }],
      wordCount: 24,
      open: false,
      onListen: (u) => (url = u),
      ops: {
        scopeToOrg: async () => true,
        verifyPhrase: async () => ({ code: 'MATCH', kdfVersion: 2 }),
        writeKey: async () => ({ ok: true, keyPath: 'k' }),
      },
    });

    const page = await open(await waitForUrl(() => url));

    // The email is on the rail's finished sign-in stop from the first paint.
    const clean = `!document.body.textContent.includes(String.fromCharCode(27))
       && !document.body.textContent.includes('[90m')
       && !document.body.textContent.includes('[1m')`;
    expect(await evaluate<boolean>(page, clean)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('vince@capy.sc')`)).toBe(
      true,
    );

    // Answering puts the ORGANIZATION name on the rail too, which is the field
    // that was travelling raw.
    await evaluate(page, clickOption('radio', 'Demos'));
    await evaluate(page, clickButton('Use this organization'));
    await until(page, `document.querySelector('input[aria-label="Word 24"]')`, 'the phrase stop');

    expect(await evaluate<boolean>(page, clean)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Demos')`)).toBe(true);

    // Out through the exit every stop draws, so the run ends rather than
    // waiting out the wizard's timeout.
    await evaluate(page, clickButton('Cancel'));
    expect((await done).cancelled).toBe(true);
  }, 90_000);

  test('the unverified fork is a decision someone takes, and it writes once', async () => {
    // The one control this flow invents. With nothing to trial-decrypt
    // against, the terminal prints a warning and writes a key under the
    // current KDF version on the user's behalf — silently wrong for a legacy
    // v1 organization caught by an outage. Here it is a stop, and until this
    // test nobody had clicked it.
    const { recoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');
    const phrase = generateSeedPhrase();

    const written: Array<{ orgId: string; kdfVersion: 1 | 2 | undefined }> = [];
    let url = '';
    const done = recoverInBrowser({
      orgs: [ORGS[0]],
      wordCount: 24,
      open: false,
      onListen: (u) => (url = u),
      ops: {
        scopeToOrg: async () => true,
        // The check DID NOT RUN, which is not the same as passing.
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'list-failed' }),
        writeKey: async (orgId, _p, kdfVersion) => {
          written.push({ orgId, kdfVersion });
          return { ok: true, keyPath: `~/.capy/orgs/${orgId}/users/u1/key.enc` };
        },
      },
    });

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('radio', 'Demos'));
    await evaluate(page, clickButton('Use this organization'));
    await until(page, `document.querySelector('input[aria-label="Word 24"]')`, 'the phrase stop');

    await evaluate(page, typePhrase(phrase));
    await evaluate(page, clickButton('Recover key'));

    // Which of the four reasons it was, named — the CLI reports one null.
    await until(
      page,
      `document.body.textContent.includes('Could not list')`,
      'the reason the trial could not run',
    );
    // …and the rail stops promising the verification that could not happen.
    expect(
      await evaluate<boolean>(
        page,
        `document.body.textContent.includes('nothing here could verify it, so saving it is a decision')`,
      ),
    ).toBe(true);
    expect(
      await evaluate<boolean>(
        page,
        `document.body.textContent.includes('verify it against this organization')`,
      ),
    ).toBe(false);

    // Held down until the consent is ticked. Arriving here writes nothing.
    expect(
      await evaluate<boolean>(page, `document.querySelector('button[type=submit]').disabled`),
    ).toBe(true);
    expect(written).toEqual([]);

    await evaluate(page, `document.querySelector('button.box-row[role=checkbox]').click()`);
    await evaluate(page, clickButton('Write the key anyway'));

    expect(await done).toEqual({
      orgId: 'org-demos',
      orgName: 'Demos',
      // Null, not 2: nothing proved a version, and the result says so rather
      // than reporting the fallback as a finding.
      kdfVersion: null,
      keyPath: '~/.capy/orgs/org-demos/users/u1/key.enc',
      cancelled: false,
    });
    // Once, with no version — the caller falls back, this does not decide.
    expect(written).toEqual([{ orgId: 'org-demos', kdfVersion: undefined }]);
  }, 90_000);

  test('declining the unverified fork writes nothing at all', async () => {
    // Cancel is the safe answer on the one page in this flow whose primary
    // button is a guess. It has to be reachable, and it has to end the run —
    // an abandoned danger stop that waits out the wizard's timeout is not one
    // of the two endings.
    const { recoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');

    const written: string[] = [];
    let url = '';
    const done = recoverInBrowser({
      orgs: [ORGS[0]],
      wordCount: 24,
      open: false,
      onListen: (u) => (url = u),
      ops: {
        scopeToOrg: async () => true,
        verifyPhrase: async () => ({ code: 'NO_ORACLE', gap: 'other-branch' }),
        writeKey: async (orgId) => {
          written.push(orgId);
          return { ok: true, keyPath: 'k' };
        },
      },
    });

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('radio', 'Demos'));
    await evaluate(page, clickButton('Use this organization'));
    await until(page, `document.querySelector('input[aria-label="Word 24"]')`, 'the phrase stop');
    await evaluate(page, typePhrase(generateSeedPhrase()));
    await evaluate(page, clickButton('Recover key'));
    await until(page, `document.body.textContent.includes('Found no secrets')`, 'the unverified fork');

    await evaluate(page, clickButton('Cancel'));

    expect(await done).toEqual({
      orgId: '',
      orgName: '',
      kdfVersion: null,
      keyPath: null,
      cancelled: true,
    });
    expect(written).toEqual([]);
  }, 90_000);

  test('capy end-recover sweeps only what is still ticked', async () => {
    // The terminal deletes every match with no preview and no confirmation.
    // Unticking a row is the whole reason this screen exists, so it is the
    // thing worth clicking.
    const { endRecoverInBrowser } = await import('../../src/ui/recoveryScreens');
    let url = '';
    const done = endRecoverInBrowser({
      session: { orgName: 'org-uuid-demos', startedAt: '2 hours ago' },
      cwd: '/work/mikes-market',
      files: [
        { name: '.env.production.decrypted', age: '2 hours ago', size: '1 KB' },
        { name: '.env.staging.decrypted', age: '3 days ago', size: '2 KB' },
      ],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // Filenames and the directory, and nothing about what is inside them.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('.env.production.decrypted')`),
    ).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);

    // Both start ticked, matching what the terminal would have deleted.
    expect(
      await evaluate<number>(
        page,
        `[...document.querySelectorAll('[role=checkbox]')].filter(el => el.getAttribute('aria-checked') === 'true').length`,
      ),
    ).toBe(2);

    await evaluate(page, clickOption('checkbox', '.env.staging.decrypted'));
    await evaluate(page, clickButton('End session and delete'));

    expect(await done).toEqual({
      endSession: true,
      remove: ['.env.production.decrypted'],
      cancelled: false,
    });
  }, 60_000);

  test('a sweep with no session is never served, so no browser can reach it', async () => {
    // `capy end-recover` returns early with no session open and removes
    // nothing. Under `--web` it used to serve the sweep anyway, with every row
    // arriving TICKED — so pressing the page's own primary button unlinked
    // plaintext the terminal form would never have touched, and `--web` was
    // deciding what gets deleted rather than where a question is drawn.
    //
    // The refusal happens before `listen`, so the proof is that there is no
    // address for a browser to go to. Then the same call with a session is
    // driven with a real one, to show that closing the hole did not close the
    // flow.
    const { endRecoverInBrowser } = await import('../../src/ui/recoveryScreens');
    const FILES = [
      { name: '.env.production.decrypted', age: '2 hours ago', size: '1 KB' },
      { name: '.env.staging.decrypted', age: '3 days ago', size: '2 KB' },
    ];

    let sessionless = '';
    const refusal = endRecoverInBrowser({
      // The shape a JavaScript caller can still hand in. TypeScript refuses it.
      session: undefined as unknown as { orgName: string; startedAt: string },
      cwd: '/work/mikes-market',
      files: FILES,
      open: false,
      // Only reached if the refusal does not happen: the short window is what
      // stops this test hanging on the defect instead of reporting it.
      timeoutMs: 2_000,
      onListen: (u) => (sessionless = u),
    }).then(
      () => 'served' as const,
      () => 'refused' as const,
    );
    // No address was ever published, so there is nothing for the browser below
    // to open. This is the assertion the old behaviour fails.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionless).toBe('');
    expect(await refusal).toBe('refused');

    // One field different, and the page is there — with the session named on
    // it, and its ticked rows exactly the list the terminal would have swept.
    let url = '';
    const done = endRecoverInBrowser({
      session: { orgName: 'org-uuid-demos', startedAt: '2 hours ago' },
      cwd: '/work/mikes-market',
      files: FILES,
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Session for')`)).toBe(
      true,
    );
    expect(
      await evaluate<number>(
        page,
        `[...document.querySelectorAll('[role=checkbox]')].filter(el => el.getAttribute('aria-checked') === 'true').length`,
      ),
    ).toBe(2);

    await evaluate(page, clickButton('End session and delete'));
    expect(await done).toEqual({
      endSession: true,
      remove: ['.env.production.decrypted', '.env.staging.decrypted'],
      cancelled: false,
    });
  }, 60_000);

  test('capy transport shows the code and answers with an action only', async () => {
    // The code is a wrapped copy of the account's encryption key. It has to
    // reach the page — that is the point — and it must not come back.
    const { showTransportInBrowser } = await import('../../src/ui/recoveryScreens');
    const CODE = 'capy redeem AgQtaGVhZGxlc3MtdHJhbnNwb3J0LWNvZGU';
    let url = '';
    const done = showTransportInBrowser({
      orgName: 'Demos',
      boundEmail: 'vince@capy.sc',
      expiresAtIso: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
      redeemCommand: CODE,
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(await evaluate<boolean>(page, `document.body.textContent.includes(${JSON.stringify(CODE)})`)).toBe(true);
    // It is blurred until the user asks for it — the page is a screen someone
    // else can be looking at.
    expect(await evaluate<boolean>(page, `!!document.querySelector('.value.blurred')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('vince@capy.sc')`)).toBe(true);

    await evaluate(page, clickButton('Close this out'));

    expect(await done).toEqual({ acknowledged: true });
  }, 60_000);

  test('cancelling the transport page is a refusal, and is not dressed as a finish', async () => {
    // Two endings, and this is the one the screen used to render as the other:
    // pressing Cancel produced the green tick, the "back to your terminal"
    // heading and the reassurance a successful finish gets. The CLI's own
    // answer has to differ too — `acknowledged: false` is what makes it print
    // that the code was never taken.
    const { showTransportInBrowser } = await import('../../src/ui/recoveryScreens');
    let url = '';
    const done = showTransportInBrowser({
      orgName: 'Demos',
      boundEmail: 'vince@capy.sc',
      expiresAtIso: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
      redeemCommand: 'capy redeem AgQtaGVhZGxlc3MtdHJhbnNwb3J0LWNvZGU',
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickButton('Cancel'));

    expect(await done).toEqual({ acknowledged: false });

    // And the page says the code exists anyway, because `capy transport`
    // mints it before it opens the browser. Refusing it un-mints nothing.
    await until(
      page,
      `document.body.textContent.includes('The code was already minted')`,
      'the refusal ending',
    );
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('You have the code')`)).toBe(
      false,
    );
    // Off screen: the ending replaces the page the code was on.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('AgQtaGVhZGxlc3M')`),
    ).toBe(false);
  }, 60_000);

  test('closing the transport page without answering resolves nothing', async () => {
    // An unanswered page has not been acknowledged, and nothing about leaving
    // may look like it was.
    const { showTransportInBrowser } = await import('../../src/ui/recoveryScreens');
    let url = '';
    let settled = false;
    const done = showTransportInBrowser({
      orgName: 'Demos',
      boundEmail: 'vince@capy.sc',
      expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      redeemCommand: 'capy redeem AgQ',
      open: false,
      timeoutMs: 1_500,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);
});
