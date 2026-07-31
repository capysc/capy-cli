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

/**
 * Poll a predicate in the page until it holds, or fail loudly.
 *
 * An evaluation that THROWS counts as "not yet". Half of what this helper
 * waits for is a page that is being replaced — every standalone step advances
 * by navigating — and there is a window during a navigation where the target
 * has no execution context to evaluate in at all. Treating that as a verdict
 * made this file fail about one run in eight on a page that was working
 * perfectly. The last attempt is deliberately NOT caught, so a page that is
 * genuinely broken still says so instead of timing out mutely.
 */
async function until(page: CdpSession, expression: string, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      if (await evaluate<boolean>(page, `!!(${expression})`)) return;
    } catch {
      /* mid-navigation: no context to ask yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (await evaluate<boolean>(page, `!!(${expression})`)) return;
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

    // Answering reloads, and the same URL yields the NEXT step. The call is
    // not awaited: the promise it returns settles around `location.reload()`,
    // so awaiting it means asking a navigating target for a result.
    await evaluate(page, `window.answer(); 'sent'`);
    await until(page, `document.getElementById('h') && document.getElementById('h').textContent === 'STEP TWO'`, 'step two');

    await evaluate(page, `window.answer()`);
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

describeBrowser('the first run, driven by a real browser', () => {
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
   * `.value` alone is invisible to the screen — `bind:value` listens for
   * `input` — and `:not(.filter)` because a choice list's own search box is
   * also an input on some of these steps.
   */
  const type = (value: string): string =>
    `(() => { const el = document.querySelector('input:not(.filter)');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  const clickOption = (label: string): string =>
    `[...document.querySelectorAll('[role=radio]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  /**
   * Answer the step, and wait for the one that replaces it.
   *
   * The wait is on the page's own load event, then on a control only the NEXT
   * step draws. Every stop's label is on the rail of every page — that is the
   * point of the rail — so waiting for a label would pass without the page
   * having moved at all, and the next `evaluate` would then land in an
   * execution context that was being torn down.
   */
  async function advance(page: CdpSession, click: string, button: string, what: string): Promise<void> {
    const reloaded = page.once('Page.loadEventFired', 20_000);
    await evaluate(page, click);
    await reloaded;
    await until(
      page,
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes(${JSON.stringify(button)}))`,
      what,
    );
  }

  const ORGS = [
    { id: 'org-1', name: 'mikes-market-hq', isCurrent: true },
    { id: 'org-2', name: 'side-project-labs', isCurrent: false },
  ];

  const LOCAL_ENV = { count: 2, names: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] };
  const TARGET = { projectName: 'mikes-market', orgName: 'mikes-market-hq', branch: 'development' };

  test('four stops of the first run are walked in one window, by clicking', async () => {
    // The property that replaced six unrelated pages: answering a stop RELOADS
    // this same address, and what comes back is the step the CLI actually
    // reached after doing the work that answer unlocked. Three inventions this
    // session died on exactly this.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    let url = '';
    const session = new InitWizardSession({ open: false, onListen: (u) => (url = u) });

    const done = (async () => {
      session.record({ signedInAs: 'mike@market.example', orgCount: 2 });
      const org = await session.askOrganization(ORGS);
      // The work that answer unlocked: scope the session, check the key, look
      // for projects. This org has none, so that stop is never asked.
      session.record({ hasOrgKey: true, projectCount: 0 });
      const project = await session.askProjectName('mikes-market');
      const branch = await session.askBranchChoice();
      session.record({ localEnvCount: 2 });
      const encrypt = await session.askEncrypt(LOCAL_ENV, TARGET);
      await session.finish();
      return { org, project, branch, encrypt };
    })();

    const page = await open(await waitForUrl(() => url));

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the consent gate three stops away, and the fork this run has
    // not reached yet.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Encrypt and push')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Recovery phrase')`)).toBe(true);

    await evaluate(page, clickOption('side-project-labs'));
    // Stop two arrives by navigation, at the same address.
    await advance(page, clickButton('Use this organization'), 'Create project', 'the project name stop');

    // …with stop one settled on the rail, under the name the CLI resolved.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('side-project-labs')`)).toBe(true);
    // The four stops the CLI has since worked out this run does not need are
    // no longer stations on it, while the ones still ahead are. Which is
    // which was decided by the plan, not by the page.
    const stations = `[...document.querySelectorAll('nav.route li')].map(li => li.textContent).join(' ')`;
    expect(await evaluate<boolean>(page, `!(${stations}).includes('Redeem a code')`)).toBe(true);
    expect(await evaluate<boolean>(page, `(${stations}).includes('Encrypt and push')`)).toBe(true);

    await evaluate(page, type('mikes-market'));
    await advance(page, clickButton('Create project'), 'Use this branch', 'the branch stop');

    await evaluate(page, clickOption('development'));
    // The consent gate names what it is asking about: variable NAMES, and
    // never a value — they are still plaintext on disk and this is the
    // question of whether they may stop being.
    await advance(page, clickButton('Use this branch'), 'Encrypt and push', 'the consent gate');

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('DATABASE_URL')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);
    // It says where this is going, which the terminal's one-line confirm does
    // in prose and this run must not get wrong.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('mikes-market-hq')`)).toBe(true);

    await evaluate(page, clickButton('Encrypt and push'));

    expect(await done).toEqual({
      org: 'org-2',
      project: 'mikes-market',
      branch: 'development',
      encrypt: true,
    });
  }, 90_000);

  /**
   * Answer the step and wait for the page that replaces it, whatever it is.
   *
   * Tolerant of the reload never coming, on purpose: a run that ends by
   * rendering "Done" in place is exactly the defect these two tests are about,
   * and swallowing the wait here lets them fail on what the page SAYS rather
   * than on a protocol timeout that names nothing.
   */
  async function reloadAfter(page: CdpSession, click: string): Promise<void> {
    const reloaded = page.once('Page.loadEventFired', 20_000).catch(() => undefined);
    await evaluate(page, click);
    await reloaded;
  }

  const body = `document.body.textContent`;

  test('a run that stops between two stops says so, and never says Done', async () => {
    // The teammate case, which is the most common way this run stops: the
    // organization was answered, and the CLI then finds no key for it on this
    // device and throws. The browser is holding that answer's POST at that
    // moment, and the compiled screen draws its ending from the button that
    // was pressed — so ending the flow with `{ done }` renders a green check
    // and "Done. You can close this tab." over a run that just died.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    const { CapyError, ERROR_CODES } = await import('../../src/types');
    let url = '';
    const session = new InitWizardSession({
      open: false,
      finalGraceMs: 8_000,
      onListen: (u) => (url = u),
    });

    const done = (async () => {
      session.record({ signedInAs: 'mike@market.example', orgCount: 2 });
      await session.askOrganization(ORGS);
      // The work that answer unlocked: scope the session to that org, and
      // check whether this device holds its key. It does not.
      session.record({ hasOrgKey: false });
      session.willBlock(
        'redeem',
        {
          code: ERROR_CODES.AUTH_FAILED,
          title: 'This device does not hold this organization\'s key',
          detail:
            'You have access to the organization, but the shared encryption key has never been transferred to this device.',
          remedy: 'capy redeem <code>',
        },
        { facts: [{ label: 'Organization', value: 'side-project-labs' }] },
      );
      await session.abort(new CapyError('no key on this device', ERROR_CODES.AUTH_FAILED));
    })();

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('side-project-labs'));
    await reloadAfter(page, clickButton('Use this organization'));

    // Nothing anywhere on it says this worked.
    expect(await evaluate<boolean>(page, `${body}.includes('Done. You can close this tab.')`)).toBe(false);
    // The stop that blocked it, on the rail it was drawn on from the start.
    await until(page, `${body}.includes('does not hold this organization')`, 'the blocked page');
    // The way out, as something to copy — not mined out of the error's prose.
    expect(await evaluate<boolean>(page, `${body}.includes('capy redeem <code>')`)).toBe(true);
    expect(await evaluate<boolean>(page, `${body}.includes('side-project-labs')`)).toBe(true);

    await done;
  }, 90_000);

  test('the clock stops while the CLI works between two stops', async () => {
    // One window for the whole run put every stop under ONE budget, and the
    // budget has to cover what the CLI does BETWEEN stops — answering
    // "Create new organization" hands off to a flow that opens two more
    // windows and asks somebody to write down 24 words, which is not five
    // minutes of anything but is easily five minutes of a person.
    //
    // Here that work takes longer than the whole per-question budget. Before
    // the clock was made to stop for it, the wizard died mid-work and the next
    // question threw "The setup window has already closed." — with the
    // organization already created and its recovery phrase already shown once.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    let url = '';
    const session = new InitWizardSession({ open: false, timeoutMs: 6_000, onListen: (u) => (url = u) });

    const done = (async () => {
      session.record({ signedInAs: 'mike@market.example', orgCount: 2 });
      const org = await session.askOrganization(ORGS);
      // createNewOrganization: name it, mint the master key, show 24 words.
      await new Promise((r) => setTimeout(r, 8_000));
      session.record({ hasOrgKey: true, projectCount: 0, recoveryShown: true });
      const project = await session.askProjectName('mikes-market');
      await session.finish();
      return { org, project };
    })();

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('side-project-labs'));
    await reloadAfter(page, clickButton('Use this organization'));

    // The window survived the work and is serving the next stop.
    await until(
      page,
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Create project'))`,
      'the project name stop',
    );
    await evaluate(page, type('mikes-market'));
    await evaluate(page, clickButton('Create project'));

    expect(await done).toEqual({ org: 'org-2', project: 'mikes-market' });
  }, 90_000);

  test('a push that fails after consent does not render as Done', async () => {
    // The one failure that lands AFTER the last question. The terminal path
    // swallows it, prints "You can run capy again", and carries on — so under
    // --web the run reached `finish()` and the page drew a green check over a
    // push that never happened, on a directory whose .env is still plaintext.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    let url = '';
    const session = new InitWizardSession({
      open: false,
      finalGraceMs: 8_000,
      onListen: (u) => (url = u),
    });

    const done = (async () => {
      session.record({
        signedInAs: 'mike@market.example',
        orgCount: 1,
        organization: { kind: 'existing', name: 'mikes-market-hq' },
        hasOrgKey: true,
        projectCount: 0,
        project: { kind: 'new', name: 'mikes-market' },
        branchChoice: 'development',
        localEnvCount: 2,
      });
      const yes = await session.askEncrypt(LOCAL_ENV, TARGET);
      // pushSecrets threw. Nothing was stored, nothing was backed up, and the
      // .env in this directory was never rewritten.
      await session.reportEncryptFailure({
        code: 'SERVICE_ERROR',
        reason: 'Keep did not answer (503).',
        envRewritten: false,
        backupWritten: false,
        pushed: false,
      });
      return yes;
    })();

    const page = await open(await waitForUrl(() => url));
    await until(page, `${body}.includes('STRIPE_SECRET_KEY')`, 'the consent gate');
    await reloadAfter(page, clickButton('Encrypt and push'));

    expect(await evaluate<boolean>(page, `${body}.includes('Done. You can close this tab.')`)).toBe(false);
    await until(page, `${body}.includes('The push failed')`, 'the failure page');
    // The fact that decides what to do next, and the only one the message
    // cannot be trusted for: what is on disk right now.
    expect(await evaluate<boolean>(page, `${body}.includes('still plaintext')`)).toBe(true);
    // The consent stop is where this run is STANDING, not a stop it ticked
    // off: the rail must not draw a station done because the question on it
    // was answered, when the thing the station describes then failed.
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('nav.route li')]
           .some(li => li.textContent.includes('Encrypt and push') && li.textContent.includes('you are here'))`,
      ),
    ).toBe(true);

    expect(await done).toBe(true);
  }, 90_000);

  test('a refusal the CLI makes lands on the compiled screen, and the step stays live', async () => {
    // Five of the wizard's verdicts are inline refusals, and until now no test
    // drove one against a STANDALONE compiled screen — the shell's `#status`
    // line, which the other refusal test reads, does not exist on one of these
    // pages. This is the org list refusing an id it cannot reach, which is
    // what a page whose list has moved under it submits.
    const { buildInitWizardData } = await import('../../src/ui/initWizardScreen');
    const { renderScreen } = await import('../../src/ui/screens/serve');
    let url = '';
    let attempts = 0;
    const render = (nonce: string): string =>
      renderScreen(
        'init-wizard',
        buildInitWizardData({ step: 'organization', input: { signedInAs: 'mike@market.example', orgCount: 2 }, orgs: ORGS }, nonce),
      );

    const done = runBrowserWizard(
      {
        title: 'Set up this directory',
        firstScreen: { html: '', standalone: true },
        open: false,
        timeoutMs: 30_000,
        onListen: (u) => (url = u),
        renderFirst: render,
      },
      async (_step, payload) => {
        attempts += 1;
        if (attempts === 1) return { error: 'That organization is not one this session can reach.' };
        return { done: true, result: payload };
      },
    );

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('side-project-labs'));
    await evaluate(page, clickButton('Use this organization'));

    // The CLI's sentence, on the page, in the screen's own status line.
    await until(page, `${body}.includes('not one this session can reach')`, 'the refusal');
    // Still this step: the rows are there and the button is live again.
    expect(await evaluate<boolean>(page, `!!document.querySelector('[role=radio]')`)).toBe(true);
    await until(
      page,
      `![...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this organization')).disabled`,
      'the button to go live again',
    );

    // Answering again finishes it — a refusal is not an ending.
    await evaluate(page, clickButton('Use this organization'));
    expect(await done).toEqual({ __action: 'submit', organizationId: 'org-2' });
    expect(attempts).toBe(2);
  }, 90_000);

  test('cancelling the consent gate is a NO, and nothing is encrypted', async () => {
    // `confirmEncrypt = chosen === 'yes'` already meant this. After this step
    // the .env in the directory is ciphertext, so the refusal has to come back
    // as a refusal rather than as an error the caller might treat as a retry.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    let url = '';
    const session = new InitWizardSession({ open: false, onListen: (u) => (url = u) });
    const done = (async () => {
      session.record({ signedInAs: 'mike@market.example', orgCount: 0, localEnvCount: 2 });
      return session.askEncrypt(LOCAL_ENV, TARGET);
    })();

    const page = await open(await waitForUrl(() => url));
    await until(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`, 'the consent gate');

    await evaluate(page, clickButton('Cancel'));

    expect(await done).toBe(false);
  }, 90_000);

  test('closing the window on the consent gate encrypts nothing', async () => {
    // An unanswered gate has not been agreed to. Leaving must not resolve as
    // consent, and it must not resolve at all.
    const { InitWizardSession } = await import('../../src/ui/initWizardScreen');
    let url = '';
    let settled = false;
    const session = new InitWizardSession({ open: false, timeoutMs: 1_500, onListen: (u) => (url = u) });
    const done = session.askEncrypt(LOCAL_ENV, TARGET);
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);

    // It ends by timing out, not by treating the close as an answer.
    await done.catch(() => undefined);
    expect(settled).toBe(false);
  }, 90_000);
});

describeBrowser('the sync reports, driven by a real browser', () => {
  // A report has nothing to click, which is exactly why it needs loading in a
  // real browser: a payload the screen cannot read renders a blank page and
  // every server-side test still passes. These open the page the CLI serves
  // and read what a person would read off it.
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

  test('capy status renders its report, and no value is on it', async () => {
    // The `json` field is `capy status --json` VERBATIM, and this test used to
    // hand it a two-key stub — which made its own "no hash on the page"
    // assertion vacuous, because the hashes live in that object's `diffs`.
    // This is the real thing statusCommand builds.
    const { showSyncStatusInBrowser } = await import('../../src/ui/syncScreens');
    const diffs = [
      { variable: 'STRIPE_SECRET_KEY', type: 'changed' as const, pinned: 'a1b2c3d4e5f60718', local: '0718f6e5d4c3b2a1', remote: 'a1b2c3d4e5f60718' },
      { variable: 'DATABASE_URL', type: 'new' as const, local: 'ffeeddccbbaa9988' },
    ];
    const report = {
      projectName: 'mikes-market',
      branch: 'development',
      totalSecrets: 14,
      inSync: false,
      localMatchesPinned: false,
      remoteMatchesPinned: false,
      remoteFailure: null,
      diffs,
    };
    const url = await showSyncStatusInBrowser({
      projectName: 'mikes-market',
      branch: 'development',
      totalSecrets: 14,
      localMatchesPinned: false,
      remoteMatchesPinned: false,
      hasRemote: true,
      diffs,
      expiring: [{ variable: 'STRIPE_SECRET_KEY', expiresInDays: 2 }],
      json: JSON.stringify(report, null, 2),
      open: false,
      timeoutMs: 20_000,
    });

    const page = await open(url);

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('mikes-market')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('DATABASE_URL')`)).toBe(true);
    // No value, ever.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);

    // The rows the screen renders carry a name, a type and which side moved.
    // The hashes `compareSecrets` compared on are dropped on the way in.
    expect(
      await evaluate<boolean>(
        page,
        `window.__CAPY_DATA__.diffs.every(d =>
           Object.keys(d).sort().join(',') === 'side,type,variable')`,
      ),
    ).toBe(true);

    // The hashes DO appear once each on this page, and only inside the copy of
    // `capy status --json` — the same object the same command prints to stdout
    // on the same machine. Every occurrence in the document is accounted for
    // by that string: nothing else on the page renders one.
    const hashHits = `(document.body.textContent.match(/a1b2c3d4e5f60718/g) || []).length`;
    const jsonHits = (JSON.stringify(report, null, 2).match(/a1b2c3d4e5f60718/g) || []).length;
    expect(jsonHits).toBe(2);
    expect(await evaluate<number>(page, hashHits)).toBe(jsonHits);

    // The command that moves this forward, which the terminal also offers.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('capy')`)).toBe(true);
  }, 90_000);

  test('the end of a run renders what moved, and which way', async () => {
    const { showSyncResultInBrowser } = await import('../../src/ui/syncScreens');
    const url = await showSyncResultInBrowser({
      projectName: 'mikes-market',
      branch: 'development',
      outcome: 'synced',
      pulled: [{ variable: 'DATABASE_URL', type: 'changed' }],
      pushed: [{ variable: 'STRIPE_SECRET_KEY', type: 'new' }],
      envRewritten: true,
      open: false,
      timeoutMs: 20_000,
    });

    const page = await open(url);

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('DATABASE_URL')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);
  }, 90_000);
});
