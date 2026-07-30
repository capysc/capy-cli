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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 * A poll that lands while the page is navigating comes back from CDP as
 * "Inspected target navigated or closed". That is not a failed predicate — it
 * is the page doing the exact thing the caller is waiting for it to do, since
 * every standalone step advances by RELOADING — so it is swallowed and the
 * next tick asks again.
 *
 * The exception is REMEMBERED rather than dropped, and reported with the
 * timeout. This is the shared harness every flow appends to: a predicate with
 * a typo in it throws on every tick, and a bare `catch {}` turned that into
 * five seconds of silence and "timed out waiting for X" — the one message that
 * sends the reader looking at the product instead of at the test. It is not
 * MATCHED on: the navigation race and a broken predicate arrive as the same
 * CDP error with nothing structured to tell them apart, and keying test
 * control flow off the wording of a Chrome error message would be a harness
 * that breaks when Chrome rewords it.
 */
async function until(page: CdpSession, expression: string, what: string): Promise<void> {
  let last: Error | undefined;
  for (let i = 0; i < 200; i++) {
    try {
      if (await evaluate<boolean>(page, `!!(${expression})`)) return;
      last = undefined;
    } catch (err) {
      last = err as Error;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? ` (last page error: ${last.message})` : ''}`,
  );
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
    // Started rather than awaited: `evaluate` asks CDP to resolve the returned
    // promise, and this one resolves by NAVIGATING. Waiting on it is a race
    // between the response and the reload, and when the reload wins CDP answers
    // "Inspected target navigated or closed" — a failure about the test's own
    // instrumentation, on the one path whose whole subject is that the page
    // navigates. `until` below is what actually waits for the next step.
    await evaluate(page, `window.answer(); undefined`);
    await until(page, `document.getElementById('h') && document.getElementById('h').textContent === 'STEP TWO'`, 'step two');

    await evaluate(page, `window.answer(); undefined`);
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

describeBrowser('capy connect, driven by a real browser', () => {
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

  /**
   * Click the option row whose label is exactly `label`.
   *
   * Exact, on the label element rather than the row: `test` is a substring of
   * half the names in this flow, and the mode question's two answers are the
   * difference between a sandbox and real money.
   */
  const clickOption = (label: string): string =>
    `[...document.querySelectorAll('[role=radio]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  /**
   * Type into a field the way a person does.
   *
   * Assigning `.value` alone is invisible to the screen: `bind:value` listens
   * for `input`, so a test that only sets the property proves the CLI can read
   * a field nobody could have filled in — which is precisely the thing the
   * live gate exists to make impossible.
   */
  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  const PLAN = {
    provider: 'stripe',
    branch: 'development',
    requiresTool: 'stripe',
    requiresAuth: true,
    push: true,
  };

  test('the variable, mode and overwrite stops are walked by clicking', async () => {
    // Three questions, TWO different compiled screens, one server. The whole
    // point of the standalone path: answering a stop is a page RELOAD, not a
    // markup swap, and the same URL then serves the next question — including
    // when the next question is a different document entirely.
    const { askConnectInBrowser } = await import('../../src/ui/connectScreens');
    const { currentVarState } = await import('../../src/commands/connectors/stripe');

    // A real-looking key in .env, reduced by the describer the CLI uses.
    const ctx = {
      keep: { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'mikes-market', variables: {} },
      branch: 'development',
      localPlaintext: { STRIPE_SECRET_KEY: 'rk_live_51HabcdefgHIJKLMNOPqrs' },
    } as never;

    let url = '';
    const done = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      plan: PLAN,
      questions: [
        {
          kind: 'var',
          vars: [
            { name: 'STRIPE_SECRET_KEY', looksRelated: true, hasValue: true },
            { name: 'DATABASE_URL', looksRelated: false, hasValue: true },
          ],
          defaultVarName: 'STRIPE_SECRET_KEY',
        },
        {
          kind: 'mode',
          modes: [
            { id: 'test', available: true, keyPrefix: 'rk_test_' },
            { id: 'live', available: true, keyPrefix: 'rk_live_' },
          ],
        },
        {
          kind: 'overwrite',
          varName: 'STRIPE_SECRET_KEY',
          current: currentVarState(ctx, 'STRIPE_SECRET_KEY'),
          incoming: { keyPrefix: 'rk_test_', mode: 'test', fingerprint: 'rk_…xyz' },
        },
      ],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the stops this page is not standing on.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Sign in')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Refresh key')`)).toBe(true);

    await evaluate(page, clickOption('STRIPE_SECRET_KEY'));
    await evaluate(page, clickButton('Use this variable'));

    // Stop two arrives by navigation, at the same address.
    await until(page, `document.body.textContent.includes('Test or live')`, 'the mode stop');
    // …with stop one now settled on the rail.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);

    await evaluate(page, clickOption('test'));
    await evaluate(page, clickButton('Continue'));

    // Stop three is a DIFFERENT compiled document, served at the same URL.
    await until(page, `document.body.textContent.includes('Overwrite value')`, 'the overwrite guard');
    // It says what is in the slot — as a fingerprint. The plaintext stays in
    // the frame that decrypted it.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_…qrs')`)).toBe(true);
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_51HabcdefgHIJKLMNOPqrs')`),
    ).toBe(false);

    await evaluate(page, clickButton('Overwrite the value'));

    expect(await done).toEqual({
      answers: { var: 'STRIPE_SECRET_KEY', mode: 'test', overwrite: true },
      cancelled: false,
    });
  }, 60_000);

  test('a mode with no key on this machine cannot be chosen', async () => {
    // The terminal offers both unconditionally and exits one question later,
    // in readKeyFromSection, having already asked for the account.
    const { askConnectInBrowser } = await import('../../src/ui/connectScreens');
    let url = '';
    let settled = false;
    const done = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      plan: PLAN,
      questions: [
        {
          kind: 'mode',
          modes: [
            { id: 'test', available: true, keyPrefix: 'rk_test_' },
            { id: 'live', available: false, blockedBy: 'NO_KEY' },
          ],
        },
      ],
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    // The row says why, in the screen's words for the CLI's condition.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('No live-mode API key')`),
    ).toBe(true);

    // Clicking it does not move the selection off the safe answer.
    await evaluate(page, clickOption('live'));
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('[role=radio]')]
           .find(el => el.querySelector('.label').textContent.trim() === 'live')
           .getAttribute('aria-checked') === 'true'`,
      ),
    ).toBe(false);

    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);

  test('the live gate holds its button until the account ID is typed back', async () => {
    // The typed echo is the design. It is the only affordance in the kit that
    // cannot be completed by muscle memory, and this is the check that the
    // button really is held — not merely styled as though it were.
    const { confirmLiveActionInBrowser } = await import('../../src/ui/connectScreens');
    const { connectPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    const done = confirmLiveActionInBrowser({
      action: 'rotate',
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      varName: 'STRIPE_SECRET_KEY',
      accountId: 'acct_1234',
      keyPrefix: 'rk_live_',
      push: true,
      stops: connectPlan({
        ...PLAN,
        standing: null,
        varName: 'STRIPE_SECRET_KEY',
        mode: 'live',
        account: 'acct_1234',
      }),
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The CLI's own line, in the CLI's own capitals.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('LIVE MODE — REAL STRIPE ACCOUNT')`),
    ).toBe(true);
    // Eight characters of the key, and nothing that says which key.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_…')`)).toBe(true);
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_51Habcdefg')`),
    ).toBe(false);

    const submit = `document.querySelector('button[type=submit]')`;
    expect(await evaluate<boolean>(page, `${submit}.disabled`)).toBe(true);

    // A near miss is a near miss, and the page says which character to check.
    await evaluate(page, type('.field input', 'acct_1235'));
    await until(page, `document.body.textContent.includes('character by character')`, 'the mismatch');
    expect(await evaluate<boolean>(page, `${submit}.disabled`)).toBe(true);

    await evaluate(page, type('.field input', 'acct_1234'));
    await until(page, `!${submit}.disabled`, 'the button to go live');

    await evaluate(page, clickButton('Rotate the live key'));
    expect(await done).toBe(true);
  }, 60_000);

  test('a gate with no account to name offers no way through', async () => {
    // The terminal falls back to asking the user to type the literal string
    // `(unknown)`, which satisfies the prompt and confirms nothing.
    const { confirmLiveActionInBrowser } = await import('../../src/ui/connectScreens');
    const { connectPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    let settled = false;
    const done = confirmLiveActionInBrowser({
      action: 'connect',
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      varName: 'STRIPE_SECRET_KEY',
      accountId: null,
      keyPrefix: 'rk_live_',
      push: true,
      stops: connectPlan({ ...PLAN, standing: null, mode: 'live' }),
      open: false,
      timeoutMs: 4_000,
      onListen: (u) => (url = u),
    });
    void done.then(() => (settled = true)).catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('Capy cannot name this account')`),
    ).toBe(true);
    // No field to type into, and no primary button over it.
    expect(await evaluate<boolean>(page, `!document.querySelector('.field input')`)).toBe(true);
    expect(await evaluate<boolean>(page, `!document.querySelector('button[type=submit]')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('(unknown)')`)).toBe(false);

    expect(settled).toBe(false);
    await done.catch(() => undefined);
  }, 60_000);

  test('the connector list previews the binary it needs before you pick it', async () => {
    const { chooseConnectorInBrowser } = await import('../../src/ui/connectScreens');
    let url = '';
    const done = chooseConnectorInBrowser({
      projectName: 'mikes-market',
      branch: 'development',
      connectors: [
        {
          id: 'stripe',
          description: 'Stripe API key (test or live, restricted)',
          requiresAuth: true,
          requiresTool: 'stripe',
          toolFound: false,
          blocked: {
            code: 'PROVIDER_CLI_MISSING',
            title: 'stripe CLI not found.',
            detail: 'Capy reads the key the Stripe CLI already holds.',
            remedy: 'brew install stripe/stripe-cli/stripe',
          },
          managedCount: 2,
        },
        { id: 'acme', description: 'Acme token', toolFound: true },
      ],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The three things the terminal's two columns cannot say.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('stripe missing')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('browser sign-in')`)).toBe(true);
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('2 variables on this branch')`),
    ).toBe(true);

    // It opens on the connector that can actually run, not on the warning.
    await evaluate(page, clickButton('Set up connector'));
    expect(await done).toEqual({ provider: 'acme', cancelled: false });
  }, 60_000);

  test('the account step lists config.toml and returns the section that was clicked', async () => {
    // `pickAccount` refuses outright without a TTY — "2 Stripe accounts in
    // config.toml; can't pick one without a prompt" — so for the caller `--web`
    // exists for this question does not exist at all. The rows are the config's
    // sections verbatim, and the answer is the SECTION name while the row is
    // labelled with the account id: two different strings, and the CLI writes
    // the one it can hand back to `stripe login --project-name=`.
    const { askConnectInBrowser } = await import('../../src/ui/connectScreens');
    let url = '';
    const done = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      plan: PLAN,
      questions: [
        {
          kind: 'account',
          accounts: [
            { id: 'sandbox', accountId: 'acct_0001', hasTestKey: true, hasLiveKey: false },
            {
              id: 'prod',
              displayName: 'Mike’s Market (prod)',
              accountId: 'acct_9999',
              hasTestKey: true,
              hasLiveKey: true,
            },
          ],
        },
      ],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Stripe account')`)).toBe(true);
    // Which modes an account can serve, from the config rather than from a
    // failure two questions later.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('test + live')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('test only')`)).toBe(true);

    await evaluate(page, clickOption('acct_9999'));
    await evaluate(page, clickButton('Use this account'));

    // The section name, which is what the CLI looks the key up by — not the
    // account id the row was labelled with.
    expect(await done).toEqual({ answers: { account: 'prod' }, cancelled: false });
  }, 60_000);

  test('the near-expiry offer can be declined, and the decline comes back as false', async () => {
    // `expiringSoonPrompt` never asks a headless caller: it prints "skipping
    // re-login (non-interactive)" and takes the key that is there. Here the
    // offer is made, and the answer this test gives is the one that is NOT the
    // default — a screen that only ever returns its own default has proved
    // nothing.
    const { askConnectInBrowser } = await import('../../src/ui/connectScreens');
    let url = '';
    const done = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      plan: PLAN,
      questions: [{ kind: 'refresh', mode: 'live', expiresInDays: 1, command: 'stripe login' }],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // A real plural from a number, not the CLI's `day(s)`.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Expires in 1 day')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('day(s)')`)).toBe(false);

    await evaluate(page, clickOption('Use the key Stripe already has'));
    await evaluate(page, clickButton('Continue'));

    expect(await done).toEqual({ answers: { refresh: false }, cancelled: false });
  }, 60_000);

  test('a mode question with no runnable answer is a wall, not a question', async () => {
    // One config section holding only a live key, read by `capy-dev`: live is
    // blocked by the dev firewall, test has no key. The screen disables both
    // rows and the reducer refuses either, so ASKING would leave the run
    // sitting on a dead page until the wizard's five-minute timeout. It is
    // served as an ending instead — no controls, a reason, and a command.
    const { showConnectBlockedInBrowser } = await import('../../src/ui/connectScreens');
    const { noRunnableMode, stripeModeOptions } = await import(
      '../../src/commands/connectors/stripe'
    );
    const { connectPlan } = await import('../../src/commands/connectors/plans');

    // The CLI's own condition, not a hand-written payload: one section, live
    // key only, under capy-dev.
    const modes = stripeModeOptions(
      [{ name: 'default', account_id: 'acct_1234', live_mode_api_key: 'rk_live_51Habcdefg' }],
      undefined,
      true,
    );
    const blocked = noRunnableMode(modes);
    expect(blocked?.code).toBe('DEV_MODE_NO_TEST_KEY');

    let url = '';
    const served = showConnectBlockedInBrowser({
      provider: 'stripe',
      projectName: 'mikes-market',
      branch: 'development',
      step: 'mode',
      stops: connectPlan({ ...PLAN, standing: 'mode', varName: 'STRIPE_SECRET_KEY' }),
      blocked: blocked!,
      open: false,
      timeoutMs: 30_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(
      await evaluate<boolean>(
        page,
        `document.body.textContent.includes('capy-dev cannot use the only key Stripe is holding')`,
      ),
    ).toBe(true);
    // Nothing to answer, and nothing that looks like it could be answered.
    expect(await evaluate<boolean>(page, `!document.querySelector('button[type=submit]')`)).toBe(true);
    expect(await evaluate<boolean>(page, `!document.querySelector('[role=radio]')`)).toBe(true);
    // The way on without a browser is on the page.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('stripe login')`)).toBe(true);
    // The key that caused it is not on it.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_51Habcdefg')`)).toBe(false);

    // The wall ends the run rather than holding it: this resolves once the
    // browser has the page, and the command exits after it.
    expect(await served).toBe(url);
  }, 60_000);
});

describeBrowser('capy rotate, driven by a real browser', () => {
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

  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  const clickOption = (label: string): string =>
    `[...document.querySelectorAll('[role=radio]')]
       .find(el => el.querySelector('.label').textContent.trim() === ${JSON.stringify(label)}).click()`;

  const CANDIDATES = [
    {
      name: 'STRIPE_SECRET_KEY',
      managed: true,
      provider: 'stripe',
      fingerprint: 'rk_…tst',
      expiresInDays: 1,
      mode: 'live' as const,
      accountId: 'acct_1234',
      issuedByCapy: true,
    },
    { name: 'DATABASE_URL', managed: false },
  ];

  test('nothing is pre-selected on the variable step, and picking one returns it', async () => {
    // A list of credentials to invalidate. The terminal's picker opens on the
    // first row, which puts a live key one keypress away.
    const { askRotateVariableInBrowser } = await import('../../src/ui/rotateScreens');
    const { rotationPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    const done = askRotateVariableInBrowser({
      step: 'variable',
      projectName: 'mikes-market',
      branch: 'development',
      devMode: false,
      all: false,
      noPush: false,
      stops: rotationPlan({
        branch: 'development',
        providers: ['stripe'],
        authProviders: ['stripe'],
        standing: 'variable',
      }),
      candidates: CANDIDATES,
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The whole route, including the stops this question is nowhere near.
    for (const label of ['Variable', 'Integration', 'Auth', 'Rotate', 'Push', 'Deploy']) {
      expect(
        await evaluate<boolean>(page, `document.body.textContent.includes(${JSON.stringify(label)})`),
      ).toBe(true);
    }
    // Real plurals, from a number rather than the CLI's `day(s)`.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('expires in 1 day')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('day(s)')`)).toBe(false);

    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('[role=radio]')].some(el => el.getAttribute('aria-checked') === 'true')`,
      ),
    ).toBe(false);

    await evaluate(page, clickOption('DATABASE_URL'));
    await evaluate(page, clickButton('Continue'));

    expect(await done).toEqual({ variable: 'DATABASE_URL', cancelled: false });
  }, 60_000);

  test('the plan gate exists for a caller with no TTY, and is answered by clicking', async () => {
    // `!opts.skipPrompts && isTTY` drops `Proceed?` on a piped run — the only
    // approval the whole rotate → push → deploy chain has.
    const { confirmRotatePlanInBrowser } = await import('../../src/ui/rotateScreens');
    const { rotationPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    const done = confirmRotatePlanInBrowser({
      step: 'plan',
      projectName: 'mikes-market',
      branch: 'development',
      devMode: false,
      all: false,
      noPush: false,
      stops: rotationPlan({
        branch: 'development',
        varName: 'STRIPE_SECRET_KEY',
        needsIntegration: false,
        providers: ['stripe'],
        authProviders: ['stripe'],
        standing: 'plan',
      }),
      varName: 'STRIPE_SECRET_KEY',
      targets: [CANDIDATES[0]],
      deployTargetCount: 0,
      advisories: [
        { code: 'provider-flag-ignored', detail: '--provider stripe only applies to an unmanaged variable.' },
      ],
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // A flag the CLI accepts and silently drops now says so before approval.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('The integration you named was not used')`),
    ).toBe(true);
    // The consequence is above the button, never inside its label.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('real customers, real money')`),
    ).toBe(true);
    // No deploy target resolved, so the button promises only what will happen.
    expect(
      await evaluate<boolean>(
        page,
        `document.querySelector('button[type=submit]').textContent.includes('Rotate and push')`,
      ),
    ).toBe(true);
    // No key material anywhere on the page.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_')`)).toBe(false);

    await evaluate(page, clickButton('Rotate and push'));
    expect(await done).toBe(true);
  }, 60_000);

  test('closing the plan window approves nothing', async () => {
    // An unanswered gate has not been approved. Nothing about leaving may look
    // like agreement to invalidate a live key.
    const { confirmRotatePlanInBrowser } = await import('../../src/ui/rotateScreens');
    const { rotationPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    let settled = false;
    const done = confirmRotatePlanInBrowser({
      step: 'plan',
      projectName: 'mikes-market',
      branch: 'development',
      devMode: false,
      all: false,
      noPush: false,
      stops: rotationPlan({
        branch: 'development',
        providers: ['stripe'],
        authProviders: ['stripe'],
        standing: 'plan',
      }),
      targets: [CANDIDATES[0]],
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

  test('a rotation that shipped nothing says so, and says not to run it again', async () => {
    // The worst middle this command can leave: the keys are live in Capy and
    // every running system still holds the old ones. The instinct is to re-run
    // `capy rotate`, which fetches a third key and widens the gap.
    const { showRotateProgressInBrowser } = await import('../../src/ui/rotateScreens');
    const { rotationPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    // STARTED, not awaited: an ending now holds the run open until the browser
    // has the page, which is the whole point of it — so awaiting it before
    // opening the browser would be waiting for a reader who has not been let
    // in yet.
    const served = showRotateProgressInBrowser({
      outcome: 'deploy-failed',
      projectName: 'mikes-market',
      branch: 'development',
      all: false,
      noPush: false,
      devMode: false,
      stops: rotationPlan({
        branch: 'development',
        varName: 'STRIPE_SECRET_KEY',
        needsIntegration: false,
        providers: ['stripe'],
        authProviders: ['stripe'],
        deployDetail: 'ship directly to prod',
      }),
      steps: [
        { id: 'rotate', label: 'Rotate', state: 'ok', detail: '1/1' },
        { id: 'push', label: 'Push', state: 'ok', detail: 'development' },
        { id: 'deploy', label: 'Deploy', state: 'fail', detail: 'prod' },
      ],
      keys: [
        {
          name: 'STRIPE_SECRET_KEY',
          provider: 'stripe',
          outcome: 'rotated',
          pushed: true,
          mode: 'live',
          issuedByCapy: true,
        },
      ],
      deploy: { targetName: 'prod', targetCount: 1 },
      open: false,
      timeoutMs: 30_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Rollout failed')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Do not run')`)).toBe(true);
    // A key Capy issued: every teammate's copy stopped working when this ran.
    expect(
      await evaluate<boolean>(
        page,
        `document.body.textContent.includes('Teammates are holding a key that no longer works')`,
      ),
    ).toBe(true);
    // It reports; it does not decide. There is nothing here a click could send.
    expect(await evaluate<boolean>(page, `!document.querySelector('button[type=submit]')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_')`)).toBe(false);

    // And the run ends once the page has been read, rather than sitting on the
    // socket for its timeout.
    expect(await served).toBe(url);
  }, 60_000);

  test('the integration step is a real list, and picking one returns it', async () => {
    // The step a piped `capy rotate <VAR>` never asks: off a TTY the CLI
    // auto-picks the single registered provider with no output at all, and the
    // connect flow it hands off to runs with `force: true` — so the value in
    // that variable is replaced rather than rotated.
    const { askRotateIntegrationInBrowser } = await import('../../src/ui/rotateScreens');
    const { rotationPlan } = await import('../../src/commands/connectors/plans');
    let url = '';
    const done = askRotateIntegrationInBrowser({
      step: 'integration',
      projectName: 'mikes-market',
      branch: 'development',
      devMode: false,
      all: false,
      noPush: false,
      stops: rotationPlan({
        branch: 'development',
        varName: 'DATABASE_URL',
        needsIntegration: true,
        standing: 'integration',
      }),
      integrations: [
        { name: 'stripe', description: 'Stripe API key (test or live, restricted)' },
        { name: 'acme', description: 'Acme token' },
      ],
      varName: 'DATABASE_URL',
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The consequence the terminal never states, before the list rather than
    // after the write.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('This replaces the current value')`),
    ).toBe(true);
    // Nothing pre-selected, however few are registered.
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('[role=radio]')].some(el => el.getAttribute('aria-checked') === 'true')`,
      ),
    ).toBe(false);

    await evaluate(page, clickOption('acme'));
    await evaluate(page, clickButton('Continue'));

    expect(await done).toEqual({ provider: 'acme', cancelled: false });
  }, 60_000);
});

/**
 * The endings, driven the way a real run reaches them: in a CHILD PROCESS that
 * ends the moment the page has been handed over.
 *
 * WHY A CHILD. Every other test in this file holds the server open because the
 * test process keeps running. A real `capy rotate --web` does not: it serves
 * the page that explains what happened and then ends — `process.exit`, or
 * simply the last statement of the command — and the loopback server serving
 * that page dies with it. `ScreenServer.start()` resolves when the socket is
 * LISTENING, not when a browser has read anything, so the exit won that race
 * every time and the pages built for the worst outcomes this command has (a
 * live key rotated and pushed with the rollout failed; a connect whose push
 * did not land) were served into a socket that closed microseconds later.
 *
 * These two spawn a child that does exactly that — awaits the ending helper,
 * then `process.exit(1)` on the very next line — and then load the URL with a
 * real browser. They fail if the helper ever stops waiting for delivery.
 */
describeBrowser('a --web ending outlives the exit code that follows it', () => {
  const CLI_ROOT = resolve(import.meta.dir, '../..');
  const SERVED_URL = /http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+/;

  let browser: Browser | null = null;
  let profile = '';
  let scratch = '';
  let child: ChildProcess | null = null;

  afterEach(() => {
    browser?.close();
    browser = null;
    child?.kill('SIGKILL');
    child = null;
    for (const dir of [profile, scratch]) if (dir) rmSync(dir, { recursive: true, force: true });
    profile = '';
    scratch = '';
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

  /** Run one snippet in a child `bun`, and hand back its URL and exit code. */
  function spawnEnding(source: string): {
    url: Promise<string>;
    exit: Promise<number>;
    output: () => string;
  } {
    scratch = mkdtempSync(join(tmpdir(), 'capy-ending-'));
    const file = join(scratch, 'ending.ts');
    writeFileSync(file, source);
    // NEVER without CAPY_WEB_NO_OPEN: the child calls the same helper the CLI
    // calls, and that helper opens a browser.
    child = spawn('bun', [file], {
      cwd: CLI_ROOT,
      env: { ...process.env, CAPY_WEB_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += String(c)));
    child.stderr?.on('data', (c: Buffer) => (out += String(c)));
    const exit = new Promise<number>((res) => child!.on('exit', (code) => res(code ?? -1)));
    const url = (async () => {
      for (let i = 0; i < 800; i++) {
        const m = out.match(SERVED_URL);
        if (m) return m[0];
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`the child never printed a URL. Output:\n${out}`);
    })();
    return { url, exit, output: () => out };
  }

  const imp = (rel: string): string => JSON.stringify(join(CLI_ROOT, rel));

  test('the rollout-failed page is still there after the command exits 1', async () => {
    // The marquee page of this parcel: the keys are live in Capy, every running
    // system still holds the old ones, and the instinct is to re-run rotate —
    // which fetches a third key. `planAndRotate` reports this state and then
    // hands the process the deploy's exit code.
    const { url, exit, output } = spawnEnding(`
      import { showRotateProgressInBrowser } from ${imp('src/ui/rotateScreens.ts')};
      import { travelledStops } from ${imp('src/commands/rotateCommand.ts')};
      import { rotationPlan } from ${imp('src/commands/connectors/plans.ts')};

      const steps = [
        { id: 'rotate', label: 'Rotate', state: 'ok', detail: '1/1' },
        { id: 'push', label: 'Push', state: 'ok', detail: 'development' },
        { id: 'deploy', label: 'Deploy', state: 'fail', detail: 'prod' },
      ];

      await showRotateProgressInBrowser({
        outcome: 'deploy-failed',
        projectName: 'mikes-market',
        branch: 'development',
        all: false,
        noPush: false,
        devMode: false,
        // Exactly what \`reportRun\` sends: the declared route, redrawn as the
        // route the run travelled.
        stops: travelledStops(
          rotationPlan({
            branch: 'development',
            varName: 'STRIPE_SECRET_KEY',
            needsIntegration: false,
            providers: ['stripe'],
            authProviders: ['stripe'],
            deployDetail: 'ship directly to prod',
          }),
          steps,
        ),
        steps,
        keys: [
          { name: 'STRIPE_SECRET_KEY', provider: 'stripe', outcome: 'rotated',
            pushed: true, mode: 'live', issuedByCapy: true },
        ],
        deploy: { targetName: 'prod', targetCount: 1 },
        open: false,
        timeoutMs: 45000,
        onListen: (u) => console.log('LISTENING ' + u),
      });
      process.exit(1);
    `);

    const page = await open(await url);

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Rollout failed')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Do not run')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_live_')`)).toBe(false);

    // The rail agrees with the step log beside it: two stops travelled, and
    // the run standing on the one that failed. The plan handed over untouched
    // drew all three as still ahead of it.
    const li = (cls: string, label: string): string =>
      `[...document.querySelectorAll('li')].some(el =>
         el.className.includes(${JSON.stringify(cls)}) && el.textContent.includes(${JSON.stringify(label)}))`;
    expect(await evaluate<boolean>(page, li('done', 'Rotate'))).toBe(true);
    expect(await evaluate<boolean>(page, li('done', 'Push'))).toBe(true);
    expect(await evaluate<boolean>(page, li('current', 'Deploy'))).toBe(true);
    expect(await evaluate<boolean>(page, li('upcoming', 'Deploy'))).toBe(false);

    // The code the deploy failed with, delivered after the page rather than
    // instead of it.
    expect(await exit).toBe(1);
    // And the address was written down, because `open()` resolves on spawn and
    // under CAPY_WEB_NO_OPEN nothing is spawned at all.
    expect(output()).toContain('What this rotation did, in your browser:');
  }, 90_000);

  test('the push-failed page is still there after the command exits 1', async () => {
    // `writeAndSync` has no try/catch around `pushSecrets`, so this used to be
    // a stack trace: the key is in .env, encrypted, and nobody else has it —
    // and the user could not tell that from "nothing happened".
    const { url, exit, output } = spawnEnding(`
      import { showConnectResultInBrowser } from ${imp('src/ui/connectScreens.ts')};
      import { connectPlan } from ${imp('src/commands/connectors/plans.ts')};

      await showConnectResultInBrowser({
        outcome: 'push-failed',
        provider: 'stripe',
        projectName: 'mikes-market',
        branch: 'development',
        varName: 'STRIPE_SECRET_KEY',
        mode: 'test',
        accountId: 'acct_1234',
        keyPrefix: 'rk_test_',
        fingerprint: 'rk_…xyz',
        detail: 'connect ECONNREFUSED 127.0.0.1:8787',
        stops: connectPlan({
          provider: 'stripe',
          branch: 'development',
          requiresTool: 'stripe',
          requiresAuth: true,
          standing: null,
          varName: 'STRIPE_SECRET_KEY',
          mode: 'test',
          account: 'acct_1234',
          signedIn: true,
          push: true,
          pushOutcome: 'failed',
        }),
        open: false,
        timeoutMs: 45000,
        onListen: (u) => console.log('LISTENING ' + u),
      });
      process.exit(1);
    `);

    const page = await open(await url);

    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('Written here, not shared')`),
    ).toBe(true);
    // The rail on a finished run agrees with the body of the page it sits on:
    // Push is where the run stopped, not a stop still ahead of it.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('did not reach Capy')`),
    ).toBe(true);
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('li')].some(li =>
           li.className.includes('current') && li.textContent.includes('Push'))`,
      ),
    ).toBe(true);
    // Sign in happened — the run got a key — so the rail says so rather than
    // drawing it as a stop still to come.
    expect(
      await evaluate<boolean>(
        page,
        `[...document.querySelectorAll('li')].some(li =>
           li.className.includes('done') && li.textContent.includes('Sign in'))`,
      ),
    ).toBe(true);
    // A prefix and a fingerprint. Never a key.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('rk_test_…')`)).toBe(true);

    expect(await exit).toBe(1);
    expect(output()).toContain('What this run did, in your browser:');
  }, 90_000);
});
