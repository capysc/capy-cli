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
    if (await evaluate<boolean>(page, `!!(${expression})`)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The same poll, tolerating the moment a document is being replaced.
 *
 * A standalone step advances by NAVIGATION, so between a click and the next
 * assertion there is a window where the execution context the last evaluate
 * used no longer exists — CDP answers "Inspected target navigated or closed"
 * instead of a value. That transition is the mechanism these flows are built
 * on, not a failure, so it is retried against the new context rather than
 * thrown. `until` keeps its stricter behaviour for the shell flows above,
 * which swap markup in place and never navigate.
 */
async function untilSettled(page: CdpSession, expression: string, what: string): Promise<void> {
  let last = '';
  for (let i = 0; i < 400; i++) {
    try {
      if (await evaluate<boolean>(page, `!!(${expression})`)) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last})` : ''}`);
}

/**
 * Navigate, and wait until the document we asked for is the one running.
 *
 * `Page.loadEventFired` can be the tab's own initial empty document rather than
 * the target, so awaiting it alone leaves the first evaluate racing the real
 * navigation — and CDP answers an evaluate in a context that has just gone away
 * with "Inspected target navigated or closed" rather than with a value. That
 * surfaced as a suite that failed roughly one run in three, on whichever test
 * happened to lose the race, so every `open` below goes through here.
 */
async function navigate(page: CdpSession, url: string): Promise<void> {
  const loaded = page.once('Page.loadEventFired', 20_000);
  await page.send('Page.navigate', { url });
  await loaded;
  await untilSettled(page, `document.body && document.body.innerHTML.length > 0`, 'the page to be running');
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
    await navigate(page, url);
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
    // `void` rather than awaiting the page's promise: `answer()` resolves only
    // after `location.reload()`, so awaiting it means awaiting a value from an
    // execution context that the reload has already destroyed — CDP answers
    // that with "Inspected target navigated or closed" and the test fails on
    // the very transition it exists to check. The poll below is what waits.
    await evaluate(page, `void window.answer()`);
    await untilSettled(
      page,
      `document.getElementById('h') && document.getElementById('h').textContent === 'STEP TWO'`,
      'step two',
    );

    await evaluate(page, `void window.answer()`);
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
    await navigate(page, url);
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
    await navigate(page, url);
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
 * Find the control and click it in ONE evaluation, retrying until it lands.
 *
 * Polling for an element and then clicking it in a second `evaluate` leaves a
 * window between the two: these steps advance by NAVIGATION, so the document
 * the poll saw can be gone by the time the click is dispatched — CDP answers
 * "Inspected target navigated or closed" and the run fails on a race rather
 * than on a defect. Finding and clicking in the same expression closes the
 * window, and retrying absorbs the replacement itself.
 */
async function clickWhenReady(page: CdpSession, finder: string, what: string): Promise<void> {
  let last = '';
  for (let i = 0; i < 300; i++) {
    try {
      const hit = await evaluate<boolean>(
        page,
        `(() => { const el = ${finder}; if (!el) return false; el.click(); return true; })()`,
      );
      if (hit) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out clicking ${what}${last ? ` (last: ${last})` : ''}`);
}

describeBrowser('capy invite, driven by a real browser', () => {
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
    const page = await browser.newPage(1280, 900);
    await navigate(page, url);
    // A compiled screen mounts itself from an inline script, so "the document
    // arrived" and "the screen is on it" are two different moments.
    await untilSettled(page, `document.querySelector('h1')`, 'the screen to mount');
    return page;
  }

  /**
   * The rows this page is currently offering, by label.
   *
   * Every predicate below reads the DOM defensively, because a standalone step
   * advances by NAVIGATION: between the click and the next assertion the
   * document is being replaced, and a selector chained off a `.find()` that
   * momentarily returns undefined throws rather than polls.
   */
  const optionLabels = `[...document.querySelectorAll('[role=radio],[role=checkbox]')]
       .map(el => el.querySelector('.label')).filter(Boolean).map(el => el.textContent.trim())`;

  /** Wait for an option row to exist, then click it. */
  async function chooseOption(page: CdpSession, label: string): Promise<void> {
    await untilSettled(page, `${optionLabels}.includes(${JSON.stringify(label)})`, `the ${label} option`);
    await clickWhenReady(
      page,
      `[...document.querySelectorAll('[role=radio],[role=checkbox]')]
         .find(el => el.querySelector('.label') && el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)})`,
      `the ${label} option`,
    );
  }

  /** Wait for a button to exist, then click it by its visible text. */
  async function press(page: CdpSession, text: string): Promise<void> {
    await clickWhenReady(
      page,
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))`,
      `the ${text} button`,
    );
  }

  /** Does the page currently read this? Null-safe across a navigation. */
  const says = (text: string): string =>
    `(document.body ? document.body.textContent : '').includes(${JSON.stringify(text)})`;

  const INVITE = {
    email: 'bob@example.com',
    orgName: 'mikes-market',
    callerEmail: 'mike@example.com',
    callerRole: 'owner',
    grantableRoles: ['member', 'project-admin', 'admin'],
    projects: [
      { id: 'p1', name: 'storefront', isCwd: true },
      { id: 'p2', name: 'warehouse', isCwd: false },
    ],
    plan: { defaultTtl: '7d', canAskExpiry: true },
    open: false,
    now: new Date('2026-07-30T00:00:00Z'),
  };

  test('all three stops of the invite route are walked by clicking', async () => {
    // The standalone path end to end: answering a stop is a page RELOAD, not a
    // markup swap, and the same URL then serves the next one. The expiry stop
    // is the one with no terminal counterpart at all — `resolveNotAfter` never
    // prompts — so this is the only place it can be shown to work.
    const { askInviteInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the stops this page is not standing on.
    await untilSettled(page, says('Role'), 'the role stop');
    for (const label of ['Role', 'Projects', 'Expiry', 'Code']) {
      expect(await evaluate<boolean>(page, says(label))).toBe(true);
    }
    // The slug the `--role` flag takes, not the picker's `Project Admin`.
    expect(await evaluate<boolean>(page, says('project-admin'))).toBe(true);
    // Nothing has been minted, so there is no code anywhere on a question page.
    expect(await evaluate<boolean>(page, says('capy redeem'))).toBe(false);

    // Every stop keeps a way out. A step that can only be answered forwards is
    // a step whose only refusal is closing the window, and this run holds a
    // copy of the organization key at the end of it.
    const hasCancel = `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel')`;
    expect(await evaluate<boolean>(page, hasCancel)).toBe(true);

    await chooseOption(page, 'member');
    await press(page, 'Continue');

    // Stop two arrives by navigation, at the same address.
    await untilSettled(page, says('Which projects?'), 'the projects stop');
    expect(await evaluate<boolean>(page, says('storefront'))).toBe(true);
    // The cwd tick says where it came from, which the terminal never does.
    expect(await evaluate<boolean>(page, says('Ticked because you ran this from here'))).toBe(true);
    expect(await evaluate<boolean>(page, hasCancel)).toBe(true);

    await chooseOption(page, 'warehouse');
    await press(page, 'Continue');

    await untilSettled(page, says('How long should it last?'), 'the expiry stop');
    // The service's silent ceiling, said out loud.
    expect(await evaluate<boolean>(page, says('caps invites at 30 days'))).toBe(true);
    expect(await evaluate<boolean>(page, hasCancel)).toBe(true);

    await chooseOption(page, '24h');
    await press(page, 'Create invite');

    expect(await done).toEqual({
      role: 'member',
      projectIds: ['p1', 'p2'],
      ttl: '24h',
      cancelled: false,
    });
  }, 60_000);

  test('picking an org-wide role walks past the project stop', async () => {
    // The rail says `admin` reaches every project before the choice is made,
    // and the run then proves it by never asking.
    const { askInviteInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    const done = askInviteInBrowser({ ...INVITE, onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));
    await chooseOption(page, 'admin');
    await press(page, 'Continue');

    await untilSettled(page, says('How long should it last?'), 'the expiry stop');
    expect(await evaluate<boolean>(page, says('Which projects?'))).toBe(false);

    await chooseOption(page, '7d');
    await press(page, 'Create invite');

    expect(await done).toEqual({ role: 'admin', projectIds: [], ttl: '7d', cancelled: false });
  }, 60_000);

  test('the projects step holds its button until something is ticked', async () => {
    // The CLI validates this after the fact with `Pick at least one project`.
    // Here the control never lets the empty answer be sent at all.
    const { askInviteInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    let settled = false;
    const done = askInviteInBrowser({
      ...INVITE,
      projects: [{ id: 'p2', name: 'warehouse', isCwd: false }],
      timeoutMs: 8_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await chooseOption(page, 'member');
    await press(page, 'Continue');
    await untilSettled(page, says('Which projects?'), 'the projects stop');

    // Nothing is ticked: this run has no cwd project for the CLI to tick.
    const submit = `document.querySelector('button[type=submit]')`;
    await untilSettled(page, submit, 'the continue button');
    expect(await evaluate<boolean>(page, `${submit}.disabled`)).toBe(true);
    expect(settled).toBe(false);

    await chooseOption(page, 'warehouse');
    await untilSettled(page, `${submit} && !${submit}.disabled`, 'the continue button to go live');

    await done.catch(() => undefined);
  }, 60_000);

  test('the no on the page is a no the CLI receives, and says so', async () => {
    // The other ending, clicked rather than inferred. Closing the window is
    // covered below, but a flow whose only tested refusal is an abandoned tab
    // has never proved that its Cancel is wired to anything — which is exactly
    // how `capy kick`'s decline shipped reaching nothing at all.
    const { askInviteInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    let settled: unknown = 'PENDING';
    const done = askInviteInBrowser({ ...INVITE, timeoutMs: 8_000, onListen: (u) => (url = u) });
    void done.then((v) => (settled = v)).catch((e) => (settled = `REJECTED: ${e.message}`));

    const page = await open(await waitForUrl(() => url));
    await untilSettled(page, says('What can they reach?'), 'the role stop');

    await press(page, 'Cancel');

    await new Promise((r) => setTimeout(r, 1_000));
    expect(settled).toEqual({ role: '', projectIds: [], cancelled: true });
    expect(await done).toEqual({ role: '', projectIds: [], cancelled: true });
    // Visibly, on the page the click happened on.
    await untilSettled(page, says('Cancelled'), 'the cancelled ending');
    expect(await evaluate<boolean>(page, says('nothing was changed'))).toBe(true);
  }, 60_000);

  test('closing the window mints nothing', async () => {
    // An unanswered invite is a refusal. Nothing about leaving may look like
    // agreement to hand somebody a copy of the organization key.
    const { askInviteInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    let settled = false;
    const done = askInviteInBrowser({ ...INVITE, timeoutMs: 1_500, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);

  test('the minted code renders on a page that cannot send it back', async () => {
    // Why `--web` stops printing the code: an agent shelling `capy` reads
    // stdout. It goes to a page instead — and that page is served with
    // `connect-src 'none'`, so the browser itself refuses to let it speak.
    const { serveInviteCode } = await import('../../src/ui/memberScreens');
    const served = await serveInviteCode(
      INVITE,
      {
        redeemCommand: 'capy redeem AgTESTREDEEMCODE00001',
        expiresAtIso: '2026-08-06T00:00:00.000Z',
        expiresRelative: 'in 7 days',
        role: 'member',
        reissued: false,
        grantedProjects: [{ id: 'p1', name: 'storefront' }],
        assignmentFailures: [],
      },
      { role: 'member', projectIds: ['p1'] },
      { open: false },
    );

    const page = await open(served.url);

    await untilSettled(page, says('AgTESTREDEEMCODE00001'), 'the code to render');
    expect(await evaluate<boolean>(page, says('This code is a key, not a link'))).toBe(true);
    // A page you are handed, not one you answer: no form, and nothing on it
    // that could post the credential anywhere.
    expect(await evaluate<number>(page, `document.querySelectorAll('form').length`)).toBe(0);
    expect(await evaluate<boolean>(page, `typeof window.capySubmit === 'undefined'`)).toBe(true);

    // And if something in the page tried anyway, the browser stops it.
    const spoke = await evaluate<string>(
      page,
      `fetch('/submit', { method: 'POST', body: 'x' }).then(() => 'sent').catch(() => 'blocked')`,
    );
    expect(spoke).toBe('blocked');

    served.close();
  }, 60_000);

  test('a service message reaches the page as words, not as escape codes', async () => {
    // The code page carries two things the CLI also PRINTS — the projects this
    // invite granted, and the service's own message for each one it could not.
    // A payload is not a terminal: `\x1b[90m` renders in a browser as the
    // literal `[90m`, and a receipt that reads `[31mproject not found[0m` is
    // the CLI's colour scheme leaking into somebody's browser.
    const { serveInviteCode } = await import('../../src/ui/memberScreens');
    const served = await serveInviteCode(
      { ...INVITE, orgName: '\x1b[1mmikes-market\x1b[0m' },
      {
        redeemCommand: 'capy redeem AgTESTREDEEMCODE00002',
        expiresAtIso: '2026-08-06T00:00:00.000Z',
        expiresRelative: 'in 7 days',
        role: 'member',
        reissued: false,
        grantedProjects: [{ id: 'p1', name: '\x1b[90mstorefront\x1b[0m' }],
        assignmentFailures: [
          { project: { id: 'p2', name: '\x1b[90mwarehouse\x1b[0m' }, error: '\x1b[31m503 from the service\x1b[0m' },
        ],
      },
      { role: 'member', projectIds: ['p1'] },
      { open: false },
    );

    const page = await open(served.url);
    await untilSettled(page, says('AgTESTREDEEMCODE00002'), 'the code to render');

    const text = await evaluate<string>(page, `document.body.textContent`);
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('[90m');
    expect(text).not.toContain('[31m');
    // Still says everything it was given, just in words.
    expect(text).toContain('storefront');
    expect(text).toContain('503 from the service');
    expect(text).toContain('mikes-market');

    served.close();
  }, 60_000);
});

describeBrowser('capy kick, driven by a real browser', () => {
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
    const page = await browser.newPage(1280, 900);
    await navigate(page, url);
    // A compiled screen mounts itself from an inline script, so "the document
    // arrived" and "the screen is on it" are two different moments.
    await untilSettled(page, `document.querySelector('h1')`, 'the screen to mount');
    return page;
  }

  /** Type into a field the way a person does — `bind:value` listens for `input`. */
  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  /** Press a button by its visible text, retrying across a re-render. */
  const press = (page: CdpSession, text: string): Promise<void> =>
    clickWhenReady(
      page,
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))`,
      `the ${text} button`,
    );

  /** Does the page currently read this? Null-safe across a navigation. */
  const says = (text: string): string =>
    `(document.body ? document.body.textContent : '').includes(${JSON.stringify(text)})`;

  const KICK = {
    orgName: 'mikes-market',
    callerRole: 'owner',
    currentUserId: 'u-mike',
    member: {
      membershipId: 'mem-bob-2',
      userId: 'u-bob',
      email: 'bob@example.com',
      role: 'member',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      projects: [{ id: 'p1', name: 'storefront', role: 'member' as const }],
    },
    open: false,
  };

  test('the consequence is stated above the button, and the button waits for the address', async () => {
    // The terminal asks one line — `Remove <email> from this organization? They
    // will lose access to all secrets.` — defaulting to No, with the whole
    // consequence folded into the question itself. Here it is two callouts
    // ABOVE the control, and the control is held until the address is typed.
    const { confirmKickInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    const done = confirmKickInBrowser({ ...KICK, onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));

    await untilSettled(page, says('This cannot be undone'), 'the removal confirm');
    // The thing the terminal never says: removing the membership does not
    // reach the key already on their machine.
    expect(await evaluate<boolean>(page, says('still on their machine'))).toBe(true);
    // Both callouts sit before the button in the document, never inside it.
    expect(
      await evaluate<boolean>(
        page,
        `(() => {
           const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove member');
           const callout = [...document.querySelectorAll('*')].find(e => e.className && String(e.className).includes('callout'));
           return !!btn && !!callout && !btn.contains(callout) &&
             (callout.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
         })()`,
      ),
    ).toBe(true);

    const remove = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove member')`;
    expect(await evaluate<boolean>(page, `!!${remove} && ${remove}.disabled`)).toBe(true);

    // A near miss is not the address.
    await evaluate(page, type('input[type=text]', 'bob@example.co'));
    await new Promise((r) => setTimeout(r, 150));
    expect(await evaluate<boolean>(page, `${remove}.disabled`)).toBe(true);

    await evaluate(page, type('input[type=text]', 'bob@example.com'));
    await untilSettled(page, `${remove} && !${remove}.disabled`, 'the remove button to go live');
    await press(page, 'Remove member');

    expect(await done).toBe(true);
    // The CLI answered, and the page then says what removal did NOT reach.
    await untilSettled(page, says('no longer a member'), 'the removal receipt');

    // The removal receipt is the LAST thing this page says. The decline bridge
    // watches for the question leaving the document, and a confirmed removal
    // takes it away too — so this is the check that a yes cannot be repainted
    // as a cancel by the very code that exists to report a no.
    await new Promise((r) => setTimeout(r, 600));
    expect(await evaluate<boolean>(page, says('no longer a member'))).toBe(true);
    expect(await evaluate<boolean>(page, says('is still a member of'))).toBe(false);
  }, 60_000);

  test('the answer the terminal defaults to is an answer the CLI receives', async () => {
    // `Remove …? (y/N)` defaults to No, and this screen's No is `Keep them`.
    // It is CLIENT-SIDE ONLY: it flips the view back to the roster and tells
    // the CLI nothing, so before the bridge this click left the run pending
    // until the wizard's timeout — five minutes in production — on a page with
    // nothing left to answer. A flow has two endings and both must be
    // reachable from the page.
    //
    // `timeoutMs` is the guard rail: without the fix this promise cannot
    // resolve, so the test fails on the rejection instead of hanging.
    const { confirmKickInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    let settled: boolean | string = 'PENDING';
    const done = confirmKickInBrowser({ ...KICK, timeoutMs: 8_000, onListen: (u) => (url = u) });
    void done.then((v) => (settled = v)).catch((e) => (settled = `REJECTED: ${e.message}`));

    const page = await open(await waitForUrl(() => url));
    await untilSettled(page, says('This cannot be undone'), 'the removal confirm');

    await press(page, 'Keep them');

    // Promptly, not eventually: the decline is a round trip to the loopback.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(settled).toBe(false);
    expect(await done).toBe(false);

    // And the page says so, rather than dropping the user on a roster that
    // cannot answer the question they were asked.
    await untilSettled(page, says('Cancelled'), 'the cancelled ending');
    expect(await evaluate<boolean>(page, says('bob@example.com is still a member of mikes-market.'))).toBe(true);
    expect(
      await evaluate<number>(page, `document.querySelectorAll('button.danger').length`),
    ).toBe(0);
  }, 60_000);

  test('closing the window removes nobody', async () => {
    // A destructive step nobody answered has not been approved.
    const { confirmKickInBrowser } = await import('../../src/ui/memberScreens');
    let url = '';
    let settled = false;
    const done = confirmKickInBrowser({ ...KICK, timeoutMs: 1_500, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.navigate', { url: 'about:blank' });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);
});
