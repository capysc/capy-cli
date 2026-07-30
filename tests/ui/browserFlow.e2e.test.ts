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
import { describe, test, expect, afterAll, afterEach, beforeAll } from 'bun:test';
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

/**
 * Evaluate something whose whole purpose is to navigate the page.
 *
 * `Runtime.evaluate` is bound to a target, and a target that navigates while a
 * call is pending kills it with "Inspected target navigated or closed". For an
 * expression that awaits a submit and then reloads, that error IS the success
 * path — the step advanced. What arrived next is the following poll's job to
 * say; nothing is asserted from the return value here.
 */
async function evaluateThatNavigates(page: CdpSession, expression: string): Promise<void> {
  try {
    await evaluate(page, expression);
  } catch {
    /* the navigation is the point */
  }
}

/**
 * Poll a predicate in the page until it holds, or fail loudly.
 *
 * A poll that spans a NAVIGATION has to survive one, and every standalone step
 * advances by reloading: an evaluation issued while the target is swapping
 * documents comes back as a CDP error rather than as `false`, and treating that
 * as a failure made these tests flake on exactly the transition they exist to
 * check. A poll that cannot read the page has not seen the predicate hold, so
 * it waits — and a predicate that never holds still fails, by timing out with
 * the same message it always did.
 */
async function until(page: CdpSession, expression: string, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    let held = false;
    try {
      held = await evaluate<boolean>(page, `!!(${expression})`);
    } catch {
      held = false;
    }
    if (held) return;
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

    // Answering reloads, and the same URL yields the NEXT step. The reload is
    // what this call is for, so the evaluation being cut short by it is the
    // expected outcome rather than a failure.
    await evaluateThatNavigates(page, `window.answer()`);
    await until(page, `document.getElementById('h') && document.getElementById('h').textContent === 'STEP TWO'`, 'step two');

    await evaluateThatNavigates(page, `window.answer()`);
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

describeBrowser('org and onboarding, driven by a real browser', () => {
  /**
   * ONE headless shell for the whole block, with a fresh tab per test.
   *
   * The blocks above launch and kill a browser per test, which is fine at four
   * tests and starts costing seconds and the occasional early-exit at sixteen —
   * the profile directory is removed the instant SIGTERM is sent, so a shell
   * that has not finished shutting down is racing a deletion. Nothing here
   * needs a clean profile: these pages are loopback documents with no storage,
   * no cookies and no service worker, and each test navigates a tab it opened
   * itself.
   */
  let browser: Browser | null = null;
  let session: CdpSession | null = null;
  let profile = '';

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
  });

  afterEach(() => {
    session?.close();
    session = null;
  });

  afterAll(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function open(url: string): Promise<CdpSession> {
    const page = await browser!.newPage(1280, 820);
    session = page;
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

  /** Click the option row whose label is exactly `label`. */
  const clickOption = (label: string): string =>
    `[...document.querySelectorAll('[role=radio]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  /** Uncover the phrase grid and tick the write-it-down consent. */
  const REVEAL = `document.querySelector('.reveal').click()`;
  const CONSENT = `document.querySelector('[role=checkbox]').click()`;

  test('local setup: the phrase is covered, gated, and never sent back', async () => {
    // The flow the whole browser path exists for. Three things are checked
    // here that no fetch-driven test can see: the grid really is covered on
    // load, the consent really is held closed until it has been uncovered, and
    // the words the page renders are the words the CLI derives the key from.
    const { runLocalOnboardingWeb } = await import('../../src/ui/onboardingWeb');
    let url = '';
    let finalized: { phrase: string; passphrase: string } | null = null;
    const done = runLocalOnboardingWeb(
      (phrase, passphrase) => (finalized = { phrase, passphrase }),
      {
        open: false,
        bodyLines: ['IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU!'],
        onListen: (u) => (url = u),
      },
    );

    const page = await open(await waitForUrl(() => url));

    // The route is drawn whole before anything is answered — including the
    // write-it-down step, which is the one you want to know about while there
    // is still time to find a pen.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Recovery phrase')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Passphrase')`)).toBe(true);

    await evaluate(page, clickButton('Show recovery phrase'));
    await until(page, `document.querySelector('.reveal')`, 'the covered phrase grid');

    // Covered: the words are in the document but not on offer, and the consent
    // cannot be ticked until they have been read.
    expect(await evaluate<string>(page, `document.querySelector('.words').getAttribute('aria-hidden')`)).toBe('true');
    expect(await evaluate<boolean>(page, `document.querySelector('[role=checkbox]').disabled`)).toBe(true);

    const words = await evaluate<string[]>(page, `window.__CAPY_DATA__.phraseWords`);
    expect(words).toHaveLength(24);

    await evaluate(page, REVEAL);
    await evaluate(page, CONSENT);
    await evaluate(page, clickButton('Set a passphrase'));

    await until(page, `document.getElementById('pp2')`, 'the passphrase step');
    // Stop one is settled on the rail and the words are gone from the page.
    expect(await evaluate<unknown>(page, `window.__CAPY_DATA__.phraseWords`)).toBeUndefined();

    await evaluate(page, type('#pp', 'correct-horse-battery'));
    await evaluate(page, type('#pp2', 'correct-horse-battery'));
    await evaluate(page, clickButton('Finish setup'));

    expect(await done).toBe(true);
    expect(finalized!.phrase).toBe(words.join(' '));
    expect(finalized!.passphrase).toBe('correct-horse-battery');
  }, 60_000);

  test('creating an organization: both stops walked, phrase confirmed by a boolean', async () => {
    const { createOrganizationInBrowser } = await import('../../src/ui/onboardingWeb');
    let url = '';
    const phrase = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ');
    const done = createOrganizationInBrowser({
      phrase,
      bodyLines: ['Capy is a ZERO TRUST secrets platform.'],
      learnMoreUrl: 'https://capy.sc/zero-trust',
      maxNameLength: 100,
      checkName: async (n) => (n === 'Acme' ? 'taken' : 'available'),
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // A name the server refuses comes back as this same step, carrying the
    // name so it can be edited rather than retyped — and the phrase is still
    // nowhere on the page.
    await evaluate(page, type('.field input', 'Acme'));
    await evaluate(page, clickButton('Show recovery phrase'));
    await until(page, `document.body.textContent.includes('already taken')`, 'the collision');
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('word1')`)).toBe(false);

    await evaluate(page, type('.field input', 'Acme Labs'));
    await evaluate(page, clickButton('Show recovery phrase'));
    await until(page, `document.querySelector('.reveal')`, 'the phrase step');

    await evaluate(page, REVEAL);
    await until(page, `document.body.textContent.includes('word24')`, 'all 24 words');
    await evaluate(page, CONSENT);
    await evaluate(page, clickButton('Create organization'));

    expect(await done).toEqual({ name: 'Acme Labs', cancelled: false });
  }, 60_000);

  test('capy org: a row with no key on this machine cannot be picked', async () => {
    // The terminal picker offers it, re-scopes the session, prints
    // `Organization: acme`, and only then discovers there is no key. Here the
    // row says so and refuses to be chosen.
    const { switchOrganizationInBrowser } = await import('../../src/ui/selectWeb');
    let url = '';
    const done = switchOrganizationInBrowser({
      signedInAs: 'mike@example.com',
      currentOrgId: 'o1',
      orgs: [
        { id: 'o1', name: 'mikes-market', hasLocalKey: true },
        { id: 'o2', name: 'northwind', hasLocalKey: true },
        { id: 'o3', name: 'acme', hasLocalKey: false },
      ],
      hasKeepLock: false,
      defaultProjectName: 'storefront',
      firstBranchName: 'development',
      onOrgChosen: async () => ({ ok: true, projects: [{ id: 'p1', name: 'storefront' }] }),
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // Opens on the org this directory is already pinned to, so the button
    // starts held down: "switch to where you already are" is not a switch.
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Switch organization')).disabled`,
      ),
    ).toBe(true);
    expect(
      await evaluate<string>(
        page,
        `[...document.querySelectorAll('[role=radio]')]
           .find(el => el.querySelector('.label').textContent.trim() === 'acme')
           .getAttribute('aria-disabled')`,
      ),
    ).toBe('true');
    // And it says why, rather than leaving a dead row.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('No encryption key for this organization')`),
    ).toBe(true);

    await evaluate(page, clickOption('northwind'));
    await evaluate(page, clickButton('Switch organization'));

    await until(page, `document.body.textContent.includes('storefront')`, 'the project stop');
    await evaluate(page, clickOption('storefront'));
    await evaluate(page, clickButton('Switch project'));

    expect(await done).toEqual({
      action: 'select-project',
      orgId: 'o2',
      projectId: 'p1',
      cancelled: false,
    });
  }, 60_000);

  test('capy byoc: a failed probe says which failure it was, then the run recovers', async () => {
    // The terminal prints `connection failed (ENOTFOUND)` and asks for a URL
    // again. ENOTFOUND, ECONNREFUSED and a timeout are three problems with
    // three fixes, and the prompt treats them as one.
    const { connectByocInBrowser } = await import('../../src/ui/byocScreens');
    let url = '';
    const done = connectByocInBrowser({
      defaultUrl: 'https://capy.internal',
      urlSource: 'builtin',
      suggestName: () => 'acme',
      existingProfiles: [],
      probe: async (u) =>
        u.includes('acme')
          ? { url: u, code: 'ok', reason: 'found (capy service detected)' }
          : {
              url: u,
              code: 'connection_failed',
              reason: 'connection failed (ENOTFOUND)',
              transportCode: 'ENOTFOUND',
            },
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The built-in guess is named as a guess. The terminal probes it without
    // ever saying that is what it is doing.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('built-in guess')`)).toBe(true);

    await evaluate(page, clickButton('Verify'));
    await until(page, `document.body.textContent.includes('did not resolve')`, 'the named failure');
    // The CLI's own sentence is quoted rather than paraphrased away.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('connection failed (ENOTFOUND)')`),
    ).toBe(true);

    await evaluate(page, type('.field input', 'capy.acme.com'));
    await evaluate(page, clickButton('Try again'));

    await until(page, `document.body.textContent.includes('Name this profile')`, 'the name step');
    await evaluate(page, clickButton('Save profile'));

    expect(await done).toMatchObject({
      url: 'https://capy.acme.com',
      profileName: 'acme',
      replaced: false,
      cancelled: false,
    });
  }, 60_000);

  test('the local passphrase: a wrong one offers the field again', async () => {
    // The terminal turns a wrong passphrase into a typed error and the command
    // dies; at three of its five call sites the words "Incorrect passphrase."
    // never reach the user at all.
    const { unlockPassphraseInBrowser } = await import('../../src/ui/onboardingWeb');
    let url = '';
    const done = unlockPassphraseInBrowser(
      (pass) => (pass === 'right-one' ? { ok: true, masterKeyHex: 'deadbeef' } : { ok: false }),
      {
        triggeredBy: 'run',
        triggerCommand: 'capy run -- npm start',
        projectName: 'mikes-market',
        lockedBy: 'idle',
        idleTimeoutMs: 3_600_000,
        open: false,
        onListen: (u) => (url = u),
      },
    );

    const page = await open(await waitForUrl(() => url));

    // It says who is asking and why it is asking again — neither of which the
    // bare `Enter your local passphrase:` prompt can.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('put your secrets in the environment')`),
    ).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('idle timer')`)).toBe(true);

    await evaluate(page, type('.passphrase-field input', 'wrong-one'));
    await evaluate(page, clickButton('Unlock'));
    await until(page, `document.body.textContent.includes('Incorrect passphrase')`, 'the refusal');

    // Still the same step, with the field live again.
    expect(await evaluate<boolean>(page, `!!document.querySelector('.passphrase-field input')`)).toBe(true);

    await evaluate(page, type('.passphrase-field input', 'right-one'));
    await evaluate(page, clickButton('Unlock'));

    expect(await done).toBe('deadbeef');
  }, 60_000);
});
