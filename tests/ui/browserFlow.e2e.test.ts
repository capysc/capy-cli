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
import { describe, test, expect, afterEach, afterAll, beforeAll } from 'bun:test';
import { spawn } from 'node:child_process';
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
/**
 * Wait for a condition in THIS process (a promise settling, a callback firing).
 *
 * `until` polls the page; this polls the CLI, which is what most of the
 * endings below are about — a flow that ends by nobody clicking anything has
 * nothing on screen left to assert against.
 */
async function untilHere(ok: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  for (let i = 0; i < budgetMs / 25; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
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

/** The members parcel's name for `until`. One helper, not two that can drift. */
const untilSettled = until;

/** Click as soon as the control exists, rather than assuming it already does. */
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

const CLI_ROOT = resolve(import.meta.dir, '../..');

/** An absolute import specifier for a CLI module, for use inside a child snippet. */
const imp = (rel: string): string => JSON.stringify(join(CLI_ROOT, rel));

/**
 * Either loopback address a `--web` run prints: an ending page served by
 * `ScreenServer` (`/s/<token>`), or a wizard step (`/?n=<nonce>`).
 */
const PRINTED_URL = /http:\/\/127\.0\.0\.1:\d+\/(?:s\/[A-Za-z0-9_-]+|\?n=[a-f0-9]+)/;

export interface CliChild {
  /** The first loopback URL the child printed. */
  url: Promise<string>;
  exit: Promise<number>;
  output: () => string;
  dispose: () => void;
}

/**
 * Run one snippet in a child `bun`, and hand back its URL and its EXIT CODE.
 *
 * Two facts about a `--web` run can only be observed from outside the process
 * that has them: whether a page outlives the exit that follows it, and what
 * that exit code is. Both matter — an ending served into a socket that closes
 * microseconds later is a page nobody sees, and a refusal that exits 1 with a
 * stack trace is a decision rendered as a crash.
 *
 * One helper for both, at module scope, because a second copy is a second set
 * of assumptions about the URL shape, the environment and the teardown.
 */
function spawnCliChild(source: string): CliChild {
  const scratch = mkdtempSync(join(tmpdir(), 'capy-child-'));
  const file = join(scratch, 'run.ts');
  writeFileSync(file, source);
  // NEVER without CAPY_WEB_NO_OPEN: the child calls the same helpers the CLI
  // calls, and those helpers open a browser.
  const child = spawn('bun', [file], {
    cwd: CLI_ROOT,
    env: { ...process.env, CAPY_WEB_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += String(c)));
  child.stderr?.on('data', (c: Buffer) => (out += String(c)));
  const exit = new Promise<number>((res) => child.on('exit', (code) => res(code ?? -1)));
  const url = (async () => {
    for (let i = 0; i < 800; i++) {
      const m = out.match(PRINTED_URL);
      if (m) return m[0];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`the child never printed a URL. Output:\n${out}`);
  })();
  return {
    url,
    exit,
    output: () => out,
    dispose: () => {
      child.kill('SIGKILL');
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Navigate and wait until the page is actually running, not merely loaded. */
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
  let browser: Browser | null = null;
  let profile = '';
  let child: CliChild | null = null;

  afterEach(() => {
    browser?.close();
    browser = null;
    child?.dispose();
    child = null;
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

  /** The shared child runner, remembered so `afterEach` can bury it. */
  const spawnEnding = (source: string): CliChild => (child = spawnCliChild(source));

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

  /**
   * One row of the rail, by the label the CLI put on it.
   *
   * The rail is a `<nav class="route">` of `<li class="{state}">` (Trainstops),
   * so the row's class IS the claim the payload made about that stop and its
   * text is what the reader is told: `← you are here` on the current stop,
   * `not needed` on a skipped one, the answer on a done one.
   */
  const railRow = (label: string): string =>
    `[...document.querySelectorAll('nav.route li')]
       .find(li => li.querySelector('.label').textContent.trim() === ${JSON.stringify(label)})`;
  const railClass = (label: string): string => `${railRow(label)}.className`;
  const railText = (label: string): string => `${railRow(label)}.textContent`;

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

  test('capy byoc: a failed probe takes the rail back to the address with the page', async () => {
    // THE RAIL DEFECT, in the browser that showed it. `capy byoc <host> --web`
    // with the host mistyped — the commonest path this flow has — used to serve
    // the address question with a rail beside it reading `● Server URL
    // https://nope.invalid`, `● Verify ← you are here`, `● Certificate not
    // needed`: three false statements at once, the last of them struck through
    // on the strength of a probe that never completed a handshake.
    const { connectByocInBrowser } = await import('../../src/ui/byocScreens');
    let url = '';
    const done = connectByocInBrowser({
      defaultUrl: 'https://nope.invalid',
      urlSource: 'argv',
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
    await evaluate(page, clickButton('Verify'));
    await until(page, `document.body.textContent.includes('did not resolve')`, 'the named failure');

    // Back on the address question — and so is the rail.
    expect(await evaluate<string>(page, railClass('Server URL'))).toContain('current');
    expect(await evaluate<string>(page, railText('Server URL'))).not.toContain('nope.invalid');
    expect(await evaluate<string>(page, railText('Verify'))).not.toContain('you are here');
    expect(await evaluate<string>(page, railText('Certificate'))).not.toContain('not needed');
    // A route has one traveller: exactly one station may say where they are.
    expect(
      await evaluate<number>(
        page,
        `document.querySelectorAll('nav.route li .here').length`,
      ),
    ).toBe(1);

    // And an address that IS accepted still settles: the fix is a rail that
    // follows the run, not a rail that never commits.
    await evaluate(page, type('.field input', 'capy.acme.com'));
    await evaluate(page, clickButton('Try again'));
    await until(page, `document.body.textContent.includes('Name this profile')`, 'the name step');
    expect(await evaluate<string>(page, railText('Server URL'))).toContain('https://capy.acme.com');
    expect(await evaluate<string>(page, railClass('Verify'))).toContain('done');
    // The certificate never came up, and only now is that a settled fact.
    expect(await evaluate<string>(page, railText('Certificate'))).toContain('not needed');

    await evaluate(page, clickButton('Save profile'));
    expect(await done).toMatchObject({ url: 'https://capy.acme.com', cancelled: false });
  }, 60_000);

  test('capy org: a refusal the terminal bolded reaches the page as words, not escapes', async () => {
    // `firstProjectRefusal` writes its sentence with `\x1b[1m…\x1b[0m` because
    // the TTY path raises the same string as a CapyError in a scrollback. Handed
    // to a browser unchanged, the page rendered `a project in [1mnorthwind[0m
    // would make those values unreadable.` — reachable whenever the chosen org
    // has no projects and this directory's .env holds an encrypted value.
    const { switchOrganizationInBrowser } = await import('../../src/ui/selectWeb');
    let url = '';
    const done = switchOrganizationInBrowser({
      signedInAs: 'mike@example.com',
      currentOrgId: 'o1',
      orgs: [
        { id: 'o1', name: 'mikes-market', hasLocalKey: true },
        { id: 'o2', name: 'northwind', hasLocalKey: true },
      ],
      hasKeepLock: false,
      defaultProjectName: 'storefront',
      firstBranchName: 'development',
      onOrgChosen: async () => ({
        ok: false,
        reason:
          'This directory is bound to another project and its .env contains 2 encrypted value(s).\n\n' +
          '  Binding it to a project in \x1b[1mnorthwind\x1b[0m would make those values unreadable.',
      }),
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, clickOption('northwind'));
    await evaluate(page, clickButton('Switch organization'));
    await until(
      page,
      `document.body.textContent.includes('would make those values unreadable')`,
      'the refusal to reach the page',
    );

    const text = await evaluate<string>(page, `document.body.textContent`);
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('[1m');
    expect(text).not.toContain('[0m');
    // The sentence survives whole; only the formatting is gone.
    expect(text).toContain('a project in northwind would make those values unreadable');

    // Still the organization step, so another row is one click away.
    expect(
      await evaluate<boolean>(page, `!!document.querySelector('[role=radio]')`),
    ).toBe(true);
    await evaluate(page, clickButton('Cancel'));
    await done.catch(() => undefined);
  }, 60_000);

  test('capy org in a directory that already has a keep.lock draws no rail', async () => {
    // THE PRODUCTION DEFAULT, pinned because it is the case the other org test
    // does not cover. `hasKeepLock: true` is what `capy org` ships from any
    // directory that has been initialised, and the screen's `showStops`
    // (packages/ui switch-organization/Screen.svelte) is `mode === 'init' ||
    // onCreateRoute || (mode === 'switch' && hasKeepLock === false)`, so the
    // five stops the CLI computed are discarded before they are drawn.
    //
    // CAP-316's reasoning is that a switch onto an existing org is one decision
    // — but this CLI still asks for a project afterwards either way, so the
    // route is two stops and the traveller is shown none of it. The CLI half is
    // right (the payload below carries all five) and the fix belongs in the
    // screen, which this parcel may not edit. WHEN THAT SCREEN CHANGES, this
    // assertion is the one to update: it is here so the gap cannot ship quietly
    // a second time.
    const { switchOrganizationInBrowser } = await import('../../src/ui/selectWeb');
    let url = '';
    const done = switchOrganizationInBrowser({
      signedInAs: 'mike@example.com',
      currentOrgId: 'o1',
      orgs: [
        { id: 'o1', name: 'mikes-market', hasLocalKey: true },
        { id: 'o2', name: 'northwind', hasLocalKey: true },
      ],
      hasKeepLock: true,
      defaultProjectName: 'storefront',
      firstBranchName: 'development',
      onOrgChosen: async () => ({ ok: true, projects: [{ id: 'p1', name: 'storefront' }] }),
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // The command computed the whole route…
    expect(
      await evaluate<number>(page, `window.__CAPY_DATA__.stops.length`),
    ).toBe(5);
    expect(await evaluate<boolean>(page, `window.__CAPY_DATA__.hasKeepLock`)).toBe(true);
    // …and the screen drew none of it.
    expect(
      await evaluate<number>(page, `document.querySelectorAll('nav.route li').length`),
    ).toBe(0);

    // Both questions are still asked and still answerable, rail or no rail.
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

  test('naming the first project: the create route just walked is behind you', async () => {
    // This window opens straight after Name → Recovery phrase → Create. The
    // route was built from the org name alone, so all three stops arrived
    // `skipped` — the rail telling somebody who had written down 24 words a
    // minute earlier that the step was "not needed".
    //
    // It also cost the rail entirely. The screen's `onCreateRoute` reads the
    // payload back on any view past the picker — "a create-only stop that is
    // not `skipped` means this run went that way" — so three skipped stops plus
    // this directory's keep.lock left `showStops` false and no rail at all.
    const { nameFirstProjectInBrowser } = await import('../../src/ui/selectWeb');
    let url = '';
    const done = nameFirstProjectInBrowser({
      signedInAs: 'mike@example.com',
      currentOrgId: undefined,
      orgs: [{ id: 'new', name: 'northwind', hasLocalKey: true }],
      hasKeepLock: true,
      defaultProjectName: 'storefront',
      firstBranchName: 'development',
      orgId: 'new',
      open: false,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(
      await evaluate<number>(page, `document.querySelectorAll('nav.route li').length`),
    ).toBeGreaterThan(0);
    for (const label of ['Name', 'Recovery phrase', 'Create']) {
      expect(await evaluate<string>(page, railClass(label))).toContain('done');
      expect(await evaluate<string>(page, railText(label))).not.toContain('not needed');
    }
    // The one stop left is the question on screen.
    expect(await evaluate<string>(page, railClass('Project'))).toContain('current');
    // The phrase stop still carries the consent and nothing else — never words.
    expect(await evaluate<string>(page, railText('Recovery phrase'))).toContain('written down');

    await evaluate(page, type('.field input', 'storefront'));
    await evaluate(page, clickButton('Create project'));
    expect(await done).toBe('storefront');
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

// ---------------------------------------------------------------------------
// The secrets parcel: `capy edit`, `capy add` and `capy decrypt`.
//
// These four screens are the only ones in the product that render real secret
// values, so a fetch-driven test proves the least here: what has to be true is
// that the page shows a mask, that the plaintext arrives ONLY on the round trip
// the user asked for, and that the buffer the user typed reaches the CLI whole.
// None of that can be checked without a browser.
// ---------------------------------------------------------------------------

const LIVE_KEY = 'example-value-123456-not-a-secret';
const DB_LOCAL = 'postgres://localhost/dev';

/** Two variables, as `capy edit` holds them: decrypted, in memory, in the CLI. */
const EDIT_ROWS = [
  {
    key: 'STRIPE_SECRET_KEY',
    localValue: LIVE_KEY,
    remoteValue: LIVE_KEY,
    status: 'in sync' as const,
    updatedLabel: '3 days ago',
    changedAt: '2026-07-27T10:00:00.000Z',
  },
  {
    key: 'DATABASE_URL',
    localValue: DB_LOCAL,
    remoteValue: 'postgres://prod/app',
    status: 'conflict' as const,
    updatedLabel: 'just now',
    changedAt: '2026-07-30T10:00:00.000Z',
    // Queued in this session, so the table offers the review stop.
    dirty: true,
  },
];

/**
 * The same two variables with nothing queued — the state every real run OPENS
 * in, because `editCommand.ts` builds its rows from disk and no row on disk is
 * dirty.
 *
 * It gets its own fixture because pre-marking a row `dirty` is what hid the
 * worst defect in this parcel: with a change queued the table draws `Review 1
 * change`, which is the only control that leads to a Cancel, so every test
 * that used `EDIT_ROWS` was driving a screen that had a way out. On a clean
 * table there is none — the buttons are the four column headers and `copy`,
 * and `q`, `Escape`, `c` and `x` all post nothing.
 */
const CLEAN_ROWS = EDIT_ROWS.map(({ dirty: _dirty, ...row }) => row);

describeBrowser('capy edit, driven by a real browser', () => {
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
    // The file's own navigate helper, not a fourth copy of it: it waits for the
    // page to be RUNNING rather than merely loaded, which is what every
    // assertion below actually depends on.
    await navigate(page, url);
    return page;
  }

  /** Type into a field the way a person does — `bind:value` listens for `input`. */
  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  /** Click the button whose visible text contains `text`. */
  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  const TABLE = {
    projectName: 'mikes-market',
    branch: 'staging',
    mode: 'server' as const,
    rows: EDIT_ROWS,
    open: false,
  };

  test('a value is masked until it is asked for, and only that one is handed over', async () => {
    // The rule the terminal cannot keep: `r` prints `row.localValue ??
    // row.remoteValue` straight out of memory, and every value the table drew
    // was already in the process that drew it. Here the served document holds
    // no value at all, and one reveal fetches exactly one.
    const { serveSecretTable } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretTable({ ...TABLE, timeoutMs: 20_000, onListen: (u) => (url = u) });
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    // At rest: both keys on screen, neither value.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('STRIPE_SECRET_KEY')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live')`)).toBe(false);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('postgres://')`)).toBe(false);
    // The mask is a fixed run and does not vary with the value behind it.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022')`)).toBe(true);

    // The rail is the CLI's plan, drawn whole before anything was answered —
    // including the stops this run has not reached.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('Encrypt and push to Keep')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('mikes-market/staging')`)).toBe(true);

    // Open one row and ask for its value.
    await evaluate(page, `document.querySelectorAll('tbody tr')[0].click()`);
    await until(page, `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'reveal')`, 'the value panel');
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'reveal').click()`);

    await until(page, `document.body.textContent.includes(${JSON.stringify(LIVE_KEY)})`, 'the revealed value');
    // One value, not the vault: the row nobody opened is still masked.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('postgres://')`)).toBe(false);

    await evaluate(page, clickButton('Review'));
    await evaluate(page, `document.querySelector('[data-test=commit]').click()`);
    expect(await done).toEqual({ action: 'commit' });
  }, 90_000);

  test('asking to edit a variable is a handoff, and the CLI is told which one', async () => {
    // `secret-table` answers the CLI's `ok` by saying "Opening <KEY> in the
    // value editor…" and waiting — it never becomes the editor itself. So the
    // CLI opens the editor, and this is the check that it learns the key.
    const { serveSecretTable } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretTable({ ...TABLE, timeoutMs: 20_000, onListen: (u) => (url = u) });

    const page = await open(await waitForUrl(() => url));

    await evaluate(page, `document.querySelectorAll('tbody tr')[1].click()`);
    await until(page, `document.querySelector('[data-test=edit-value]')`, 'the row panel');
    await evaluate(page, `document.querySelector('[data-test=edit-value]').click()`);

    expect(await done).toEqual({ action: 'edit', key: 'DATABASE_URL' });
    await until(page, `document.body.textContent.includes('in the value editor')`, 'the handoff line');
  }, 90_000);

  test('the editor seeds its buffer from the CLI and saves what was typed', async () => {
    // Two round trips a fetch test cannot stand in for: `/reveal` fills the box
    // with the value that is on disk, and `/submit` carries the new one back.
    // The terminal seeds this buffer with `row.localValue ?? ''`, so a row with
    // no local copy silently overwrites the remote one with an empty string.
    const { serveSecretValueEditor } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretValueEditor({
      projectName: 'mikes-market',
      branch: 'staging',
      mode: 'server',
      row: EDIT_ROWS[0],
      remoteAvailable: true,
      pendingCount: 0,
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    // Inspect: the CLI's own mask, and no value.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('exa...ret')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes(${JSON.stringify(LIVE_KEY)})`)).toBe(false);

    await evaluate(page, clickButton('Edit value'));
    await until(page, `document.querySelector('input[type=password], textarea')`, 'the edit buffer');
    // Seeded from the round trip, not from the payload.
    expect(
      await evaluate<string>(page, `document.querySelector('input[type=password], textarea').value`),
    ).toBe(LIVE_KEY);

    await evaluate(page, type('input[type=password], textarea', 'sk_live_rotated_0987654321'));
    await until(page, `![...document.querySelectorAll('button')].find(b => b.textContent.includes('Save value')).disabled`, 'the save button to go live');
    await evaluate(page, clickButton('Save value'));

    expect(await done).toEqual({
      action: 'save',
      key: 'STRIPE_SECRET_KEY',
      value: 'sk_live_rotated_0987654321',
    });
  }, 90_000);

  test('a secret short enough to have no mask is not previewed at all', async () => {
    // `formatSnippet` returns anything six characters or shorter VERBATIM, so
    // the terminal's column labelled as masked prints it whole. The payload
    // carries no snippet for these, and the page says why there is none.
    const { serveSecretValueEditor } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretValueEditor({
      projectName: 'mikes-market',
      branch: 'staging',
      mode: 'server',
      row: {
        key: 'PIN',
        localValue: 'hunter',
        remoteValue: 'hunter',
        status: 'in sync',
        updatedLabel: 'just now',
      },
      remoteAvailable: true,
      pendingCount: 0,
      open: false,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('hunter')`)).toBe(false);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('No preview')`)).toBe(true);

    // Reveal still works — seeing a value is meant to cost a deliberate act,
    // which is exactly what it stopped costing when it was already on screen.
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'reveal').click()`);
    await until(page, `document.body.textContent.includes('hunter')`, 'the revealed value');

    await evaluate(page, clickButton('Cancel'));
    // `declined`: a control on the page said no. The other two refusals — a
    // closed window, a step nobody answered — are further down, and they are
    // not the same fact even though all three write nothing.
    expect(await done).toEqual({ action: 'cancel', reason: 'declined' });
  }, 90_000);

  test('a table with nothing queued has no control that ends the run', async () => {
    // The state every real run opens in, and the reason the rest of this file
    // did not catch what follows: `Review N changes` is the only control that
    // reaches a Cancel, and it is not drawn until a row is dirty. This asserts
    // the gap rather than papering over it — the fix is a `secret-table`
    // change nobody in this parcel is allowed to make, so what the CLI owes
    // the flow is an ending that does not need a control at all.
    const { serveSecretTable } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretTable({
      ...TABLE,
      rows: CLEAN_ROWS,
      timeoutMs: 20_000,
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    expect(
      await evaluate<string[]>(page, `[...document.querySelectorAll('button')].map(b => b.textContent.trim())`),
    ).toEqual(['Key', 'Value', 'Status', 'Updated', 'copy']);

    // And the keyboard is not a second way out either: `c` opens the review
    // stop only when something is pending, and there is no `q` at all.
    await evaluate(page, `window.__posts = []; const f = window.fetch;
      window.fetch = (u, i) => { window.__posts.push(String(u)); return f(u, i); };`);
    for (const key of ['q', 'Escape', 'c', 'x']) {
      await evaluate(page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`);
    }
    expect(await evaluate<string[]>(page, `window.__posts`)).toEqual([]);

    await page.send('Page.close').catch(() => undefined);
    await done.catch(() => undefined);
  }, 90_000);

  test('closing a table with nothing queued ends the run as a refusal', async () => {
    // The blocking one. A person opens `capy edit --web`, reads the table,
    // reveals a value and closes the tab — the most common path there is, and
    // the one with no control on it. It used to end by holding the terminal
    // for five minutes and then throwing `Timed out waiting for the browser`;
    // it has to end the way every other refusal does, promptly and by name.
    const { serveSecretTable } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretTable({
      ...TABLE,
      rows: CLEAN_ROWS,
      // Comfortably longer than the close takes, so a pass cannot come from
      // the deadline: this settles because the window closed.
      timeoutMs: 30_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));
    await evaluate(page, `document.querySelectorAll('tbody tr')[0].click()`);
    await until(page, `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'reveal')`, 'the value panel');

    const t0 = Date.now();
    await page.send('Page.close').catch(() => undefined);

    expect(await done).toEqual({ action: 'cancel', reason: 'closed' });
    // Promptly: the whole defect was that this took five minutes.
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 90_000);

  test('closing the value editor ends the run instead of looping back to a page nobody can see', async () => {
    // Its Cancel means "back to the table". Closing the window does not: there
    // is no tab left to draw a table into, so re-serving one waits out the
    // deadline against a browser that has gone home.
    const { serveSecretValueEditor } = await import('../../src/ui/secretTableScreen');
    let url = '';
    const done = serveSecretValueEditor({
      projectName: 'mikes-market',
      branch: 'staging',
      mode: 'server',
      row: CLEAN_ROWS[0],
      remoteAvailable: true,
      pendingCount: 0,
      open: false,
      timeoutMs: 30_000,
      onListen: (u) => (url = u),
    });

    const page = await open(await waitForUrl(() => url));
    await page.send('Page.close').catch(() => undefined);

    expect(await done).toEqual({ action: 'cancel', reason: 'closed' });
  }, 90_000);

  test('the rail marks whichever stop the CLI says the run is standing on', async () => {
    // The rail is the CLI's claim about the route, and the claim has to MOVE.
    // Both payloads are built by the same `buildSecretTableData` the served
    // flow uses, and the compiled screen draws the marker where the CLI put it.
    //
    // WHAT THIS DOES NOT COVER, deliberately, because it cannot be reached from
    // here: `secret-table` swaps to its review view CLIENT-side
    // (packages/ui/screens/secret-table/Screen.svelte, `openReview()` sets
    // `view = 'confirm-commit'` and never posts), so the CLI is never asked for
    // the second payload below and the rail on that view is the first one,
    // stale. The same is true of the `done` and `cancelled` views. The fix is a
    // line of packages/ui, which this parcel may not touch, and the pattern
    // already exists there: `Wizard.svelte`'s `shownStops` advances the rail
    // locally for exactly this reason. This test pins the CLI's half so that
    // change is a one-liner and not an investigation.
    const { buildSecretTableData } = await import('../../src/ui/secretTableScreen');
    const { ScreenServer } = await import('../../src/ui/screens/serve');
    const nonce = 'n'.repeat(64);
    const params = { ...TABLE, rows: EDIT_ROWS };

    const here = async (view: 'table' | 'confirm-commit'): Promise<string> => {
      const server = new ScreenServer('secret-table', buildSecretTableData(params, nonce, view), {
        timeoutMs: 20_000,
      });
      const url = await server.start();
      const page = await open(url);
      await until(page, `document.querySelector('li.current .label')`, 'the rail');
      const label = await evaluate<string>(page, `document.querySelector('li.current .label').textContent`);
      // One marker, never two: the rail is drawn from a single cursor.
      expect(await evaluate<number>(page, `document.querySelectorAll('.here').length`)).toBe(1);
      browser?.close();
      browser = null;
      // `open()` reassigns `profile`, so the second call would orphan the
      // first one's directory past `afterEach`.
      if (profile) rmSync(profile, { recursive: true, force: true });
      profile = '';
      server.close();
      return label;
    };

    expect(await here('table')).toBe('Edit values');
    expect(await here('confirm-commit')).toBe('Review changes');
  }, 90_000);
});

describeBrowser('capy edit end to end, driven by a real browser', () => {
  // `runSecretEditorInBrowser` is what `editCommand.ts` calls: the loop that
  // stitches table → editor → table → commit across three separate loopback
  // servers and three pages. Every test above drives one of those servers on
  // its own, which is how a table with no way out shipped — the loop is where
  // "no way out" becomes a hung command.
  let browser: Browser | null = null;
  let profile = '';

  afterEach(() => {
    browser?.close();
    browser = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  async function launch(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 900);
    // The file's own navigate helper, not a fourth copy of it: it waits for the
    // page to be RUNNING rather than merely loaded, which is what every
    // assertion below actually depends on.
    await navigate(page, url);
    return page;
  }

  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  const clickButton = (text: string): string =>
    `[...document.querySelectorAll('button')]
       .find(b => b.textContent.includes(${JSON.stringify(text)})).click()`;

  const LOOP = {
    projectName: 'mikes-market',
    branch: 'staging',
    mode: 'server' as const,
    remoteAvailable: true,
    open: false,
    timeoutMs: 30_000,
  };

  test('a run that edits nothing ends when the window closes, and writes nothing', async () => {
    // The whole command, on its most common path. Without an ending here this
    // is `capy edit --web` holding the terminal for five minutes and exiting
    // non-zero, long after the person walked away.
    const { runSecretEditorInBrowser } = await import('../../src/ui/secretTableScreen');
    const urls: string[] = [];
    let saved: Record<string, string> | null = null;

    const done = runSecretEditorInBrowser(
      { ...LOOP, rows: CLEAN_ROWS, onListen: (u) => urls.push(u) },
      {
        saveLocalEdits: async (edits) => {
          saved = edits;
          return {};
        },
      },
    );

    await untilHere(() => urls.length > 0, 'the table to be served');
    const page = await launch(urls[0]);
    await page.send('Page.close').catch(() => undefined);

    await done;
    expect(saved).toBeNull();
    // One server, opened once: the loop did not go round again and serve a
    // table into a browser that had gone.
    expect(urls).toHaveLength(1);
  }, 120_000);

  test('the whole route is walked by clicking: table, editor, table, review, commit', async () => {
    // Starting from a CLEAN table, which is where every real run starts. The
    // review stop exists at the end only because the editor put a change
    // behind it.
    const { runSecretEditorInBrowser } = await import('../../src/ui/secretTableScreen');
    const urls: string[] = [];
    let saved: Record<string, string> | null = null;

    const done = runSecretEditorInBrowser(
      { ...LOOP, rows: CLEAN_ROWS, onListen: (u) => urls.push(u) },
      {
        saveLocalEdits: async (edits) => {
          saved = edits;
          return { STRIPE_SECRET_KEY: '2026-07-30T12:00:00.000Z' };
        },
      },
    );

    await untilHere(() => urls.length > 0, 'the table to be served');
    const page = await launch(urls[0]);

    // Stop one: ask to edit a variable. The table hands over rather than
    // becoming the editor, so the CLI has to open the next page itself.
    await evaluate(page, `document.querySelectorAll('tbody tr')[0].click()`);
    await until(page, `document.querySelector('[data-test=edit-value]')`, 'the row panel');
    await evaluate(page, `document.querySelector('[data-test=edit-value]').click()`);
    await until(page, `document.body.textContent.includes('in the value editor')`, 'the handoff line');

    // Stop two: the editor the loop opened, at its own address.
    await untilHere(() => urls.length > 1, 'the value editor to be served');
    await navigate(page, urls[1]);
    await evaluate(page, clickButton('Edit value'));
    await until(page, `document.querySelector('input[type=password], textarea')`, 'the edit buffer');
    await evaluate(page, type('input[type=password], textarea', 'sk_live_rotated'));
    await until(page, `![...document.querySelectorAll('button')].find(b => b.textContent.includes('Save value')).disabled`, 'the save button');
    await evaluate(page, clickButton('Save value'));

    // Stop three: back to the table, now holding one queued change — which is
    // what puts a Review control on the page at all.
    await untilHere(() => urls.length > 2, 'the table to be served again');
    await navigate(page, urls[2]);
    await until(page, `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Review'))`, 'the review control');
    // The queued value is not in the document it redrew from.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('sk_live_rotated')`)).toBe(false);

    await evaluate(page, clickButton('Review'));
    await evaluate(page, `document.querySelector('[data-test=commit]').click()`);

    await done;
    expect(saved).toEqual({ STRIPE_SECRET_KEY: 'sk_live_rotated' });
  }, 120_000);
});

describeBrowser('capy add, driven by a real browser', () => {
  let browser: Browser | null = null;
  let profile = '';
  let child: CliChild | null = null;

  afterEach(() => {
    browser?.close();
    browser = null;
    child?.dispose();
    child = null;
    if (profile) rmSync(profile, { recursive: true, force: true });
    profile = '';
  });

  /** The shared child runner, remembered so `afterEach` can bury it. */
  const spawnChild = (source: string): CliChild => (child = spawnCliChild(source));

  async function open(url: string): Promise<CdpSession> {
    profile = mkdtempSync(join(tmpdir(), 'capy-e2e-'));
    browser = await Browser.launch(profile);
    const page = await browser.newPage(1280, 900);
    // The file's own navigate helper, not a fourth copy of it: it waits for the
    // page to be RUNNING rather than merely loaded, which is what every
    // assertion below actually depends on.
    await navigate(page, url);
    return page;
  }

  const type = (selector: string, value: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  test('a value typed into the form reaches the CLI and was never in the document', async () => {
    // The whole promise of this page: an agent asks for a credential it must
    // not see, and the value goes from the keyboard to the CLI without passing
    // through the model. It is also masked while it is typed, which the
    // hand-written page it replaces did not do.
    const { runWebIntake } = await import('../../src/ui/secretIntakeScreen');
    let url = '';
    let received: Array<{ name: string; value: string }> | null = null;
    const done = runWebIntake(
      {
        vars: [{ name: 'STRIPE_SECRET_KEY', helpUrl: 'https://dashboard.stripe.com/apikeys' }],
        reason: 'STRIPE_SECRET_KEY already exist(s). Overwrite?',
        open: false,
        timeoutMs: 20_000,
        onListen: (u) => (url = u),
      },
      async (pairs) => {
        received = pairs;
      },
    );

    const page = await open(await waitForUrl(() => url));

    // The name is pre-seeded, the vendor mark resolved from the help link, and
    // the CLI's own overwrite sentence is above the form — the confirm `--web`
    // used to skip in silence.
    expect(await evaluate<string>(page, `document.querySelector('input[type=text]').value`)).toBe('STRIPE_SECRET_KEY');
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('already exist(s). Overwrite?')`)).toBe(true);
    expect(await evaluate<boolean>(page, `!!document.querySelector('svg[role=img]')`)).toBe(true);

    // The value box is masked while it is typed.
    expect(await evaluate<boolean>(page, `!!document.querySelector('input[type=password], textarea')`)).toBe(true);

    await evaluate(page, type('input[type=password], textarea', 'sk_live_typed_by_a_person'));
    await evaluate(
      page,
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save')).click()`,
    );

    await done;
    expect(received).toEqual([{ name: 'STRIPE_SECRET_KEY', value: 'sk_live_typed_by_a_person' }]);
  }, 90_000);

  test('an illegal variable name holds the button down before anything is sent', async () => {
    // The page it replaces accepted `my key` as a variable name and encrypted
    // it, because a hand-rolled input has nowhere to put an error.
    const { runWebIntake } = await import('../../src/ui/secretIntakeScreen');
    let url = '';
    let saved = false;
    const done = runWebIntake(
      { vars: [{ name: 'OK_NAME' }], open: false, timeoutMs: 4_000, onListen: (u) => (url = u) },
      async () => {
        saved = true;
      },
    );
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    await evaluate(page, type('input[type=text]', 'my key'));
    await evaluate(page, type('input[type=password], textarea', 'anything'));
    await until(
      page,
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save')).disabled`,
      'the save button to be held down',
    );

    expect(saved).toBe(false);
    await done.catch(() => undefined);
  }, 90_000);

  test('closing the form is how you refuse the overwrite, and it saves nothing', async () => {
    // `capy add --web` states the terminal's overwrite confirm above the form
    // and the screen has no Cancel control, so leaving IS the answer to it.
    // That answer has to arrive: it used to be a five-minute wait ending in a
    // thrown timeout, and the caller — which reads "nothing was captured" as
    // the refusal — never got to see it.
    const { runWebIntake } = await import('../../src/ui/secretIntakeScreen');
    let url = '';
    let saved = false;
    const done = runWebIntake(
      {
        vars: [{ name: 'STRIPE_SECRET_KEY' }],
        reason: 'STRIPE_SECRET_KEY already exist(s). Overwrite?',
        open: false,
        timeoutMs: 30_000,
        onListen: (u) => (url = u),
      },
      async () => {
        saved = true;
      },
    );

    const page = await open(await waitForUrl(() => url));
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('already exist(s). Overwrite?')`),
    ).toBe(true);
    // Still true, and still the reason this ending has to work: there is no
    // control on this page that says no.
    expect(
      await evaluate<boolean>(
        page,
        `![...document.querySelectorAll('button')].some(b => /cancel|discard/i.test(b.textContent))`,
      ),
    ).toBe(true);

    const t0 = Date.now();
    await page.send('Page.close').catch(() => undefined);

    await done;
    expect(saved).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 90_000);

  test('refusing the overwrite ends the command cleanly — no stack trace, exit 0', async () => {
    // The refusal above only proves the INTAKE resolves. What the person sees
    // is `capy add`, and that ran on past the resolve: the command printed its
    // friendly line and then threw a `CapyError` that nothing catches — the
    // `.action` handler has no try/catch and `program.parse` is not awaited —
    // so it landed in the process-level unhandledRejection handler, which
    // printed the same sentence again under eight lines of node internals and
    // exited 1. Declining an overwrite is one of this flow's two endings; it is
    // not a crash, and the terminal path for the identical refusal has always
    // printed `Aborted.` and returned 0.
    //
    // A CHILD PROCESS, because an exit code is the thing under test and this
    // one cannot be observed from inside the process that would be exiting.
    const source = `
      import { mock } from 'bun:test';
      // The command's context, stubbed at the seam it is imported from: this
      // test is about how the command ENDS, not about keep.lock or the service.
      mock.module(${imp('src/commands/connectors/shared.ts')}, () => ({
        resolveContext: async () => ({ branch: 'staging', localPlaintext: { STRIPE_SECRET_KEY: 'old' } }),
        writeAndSync: async () => { throw new Error('nothing may be written on a refusal'); },
      }));
      const { AddCommand } = await import(${imp('src/commands/addCommand.ts')});
      // Exactly as src/index.ts invokes it: awaited, with nothing catching.
      await new AddCommand(false).execute(['STRIPE_SECRET_KEY'], { web: true, open: false, noPush: true });
      console.log('COMMAND RETURNED');
    `;
    const run = spawnChild(source);
    const page = await open(await run.url);
    // The overwrite question really is on the page being closed.
    expect(
      await evaluate<boolean>(page, `document.body.textContent.includes('already exist(s). Overwrite?')`),
    ).toBe(true);
    await page.send('Page.close').catch(() => undefined);

    expect(await run.exit).toBe(0);
    const out = run.output();
    expect(out).toContain('Nothing was added. The browser was closed without saving.');
    expect(out).toContain('COMMAND RETURNED');
    // Not the ✓ line either: a refusal is not a save of zero variables.
    expect(out).not.toContain('✓ Saved');
    // And no crash dressed over the top of it.
    expect(out).not.toContain('CapyError');
    expect(out).not.toContain('at <anonymous>');
  }, 90_000);
});

describeBrowser('capy decrypt, driven by a real browser', () => {
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
    // The file's own navigate helper, not a fourth copy of it: it waits for the
    // page to be RUNNING rather than merely loaded, which is what every
    // assertion below actually depends on.
    await navigate(page, url);
    return page;
  }

  /** Fill the phrase grid one box at a time, the way a person retypes a card. */
  const fillWords = (words: string[]): string =>
    `(() => {
       const boxes = [...document.querySelectorAll('input[type=password]')];
       const words = ${JSON.stringify(words)};
       boxes.forEach((el, i) => {
         el.value = words[i] ?? '';
         el.dispatchEvent(new Event('input', { bubbles: true }));
       });
       return boxes.length;
     })()`;

  const DECRYPT = {
    projectName: 'mikes-market',
    branch: 'main',
    outputFile: '.env.main.decrypted',
    open: false,
  };

  test('a real phrase is typed, posted once, and never comes back with the page', async () => {
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');
    const { decryptInBrowser } = await import('../../src/ui/decryptScreen');
    const phrase = generateSeedPhrase();
    const words = phrase.split(' ');

    let url = '';
    let seen = '';
    const done = decryptInBrowser(
      { ...DECRYPT, timeoutMs: 20_000, onListen: (u) => (url = u) },
      async (input) => {
        if ('phrase' in input) seen = input.phrase;
        return { ok: true, count: 7, wrote: true };
      },
    );

    const page = await open(await waitForUrl(() => url));

    // The rail says what happens next, including the file this will write.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('.env.main.decrypted')`)).toBe(true);
    // Every box is masked, and none of them autocompletes.
    expect(await evaluate<number>(page, `document.querySelectorAll('input[type=password]').length`)).toBe(24);

    expect(await evaluate<number>(page, fillWords(words))).toBe(24);
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Decrypt to a file')).click()`);

    expect(await done).toEqual({ action: 'decrypted', count: 7, wrote: true });
    // The CLI got the phrase the user typed…
    expect(seen).toBe(phrase);
    // …and the tab it was typed into does not hold it any more.
    await until(page, `!document.body.textContent.includes(${JSON.stringify(words[0])})`, 'the words to be forgotten');
    expect(await evaluate<string>(page, `location.search`)).not.toContain(words[0]);
  }, 90_000);

  test('a phrase the wordlist does not know never leaves the tab', async () => {
    // The terminal answers all three failures with one sentence and only after
    // the words have already been sent. The page runs the CLI's own three
    // checks in the tab and holds the submit, so a typo is never posted.
    const { decryptInBrowser } = await import('../../src/ui/decryptScreen');
    let url = '';
    let attempted = false;
    const done = decryptInBrowser(
      { ...DECRYPT, timeoutMs: 4_000, onListen: (u) => (url = u) },
      async () => {
        attempted = true;
        return { ok: true, count: 1, wrote: true };
      },
    );
    void done.catch(() => undefined);

    const page = await open(await waitForUrl(() => url));

    await evaluate(page, fillWords(Array.from({ length: 24 }, (_, i) => `notaword${i}`)));
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Decrypt to a file')).click()`);

    await until(page, `document.body.textContent.includes('BIP-39 wordlist')`, 'the refusal');
    expect(attempted).toBe(false);
    await done.catch(() => undefined);
  }, 90_000);

  test('an open recovery session asks before it reuses the key it already holds', async () => {
    // The terminal reuses a cached master key with no prompt and no mention.
    const { decryptInBrowser } = await import('../../src/ui/decryptScreen');
    let url = '';
    let answered: unknown = null;
    const done = decryptInBrowser(
      {
        ...DECRYPT,
        session: { orgName: 'org_2f9c', startedAt: '14 minutes ago' },
        timeoutMs: 20_000,
        onListen: (u) => (url = u),
      },
      async (input) => {
        answered = input;
        return { ok: true, count: 2, wrote: true };
      },
    );

    const page = await open(await waitForUrl(() => url));

    expect(await evaluate<boolean>(page, `document.body.textContent.includes('org_2f9c')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('plaintext')`)).toBe(true);
    // No phrase is asked for, so there is nothing to type.
    expect(await evaluate<number>(page, `document.querySelectorAll('input[type=password]').length`)).toBe(0);

    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Decrypt to a file')).click()`);
    expect(await done).toEqual({ action: 'decrypted', count: 2, wrote: true });
    expect(answered).toEqual({ useSession: true });
  }, 90_000);

  test('closing the window decrypts nothing, and says which refusal it was', async () => {
    // An unanswered step is a refusal. Nothing about leaving may look like
    // consent to write every secret on this branch to a file in the clear —
    // and nothing about it may look like a fault either: this used to end by
    // throwing `Timed out waiting for the browser (5 minutes).` at a command
    // that had done nothing wrong.
    const { decryptInBrowser } = await import('../../src/ui/decryptScreen');
    let url = '';
    let attempted = false;
    const done = decryptInBrowser({ ...DECRYPT, timeoutMs: 30_000, onListen: (u) => (url = u) }, async () => {
      attempted = true;
      return { ok: true, count: 1, wrote: true };
    });

    const page = await open(await waitForUrl(() => url));
    const t0 = Date.now();
    await page.send('Page.close').catch(() => undefined);

    expect(await done).toEqual({ action: 'cancelled', reason: 'closed' });
    expect(attempted).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 90_000);

  test('a wrong phrase re-serves the step, and the run survives a human-length pause on it', async () => {
    // The trap under "closing the window is a refusal": a standalone step
    // ADVANCES by reloading, so every re-serve is a page going away and coming
    // straight back. A refusal that fired on the way out would cancel the run
    // exactly when it should be asking again — with the words already typed.
    //
    // THE PAUSE IS THE POINT. An earlier version of this test retyped 24 words
    // and clicked in under half a second, which is faster than any grace window
    // and faster than any person: it passed against a build where the re-serve
    // armed a 1.2-second self-destruct. So this one STOPS and reads, the way
    // somebody does when a page tells them "a single wrong word produces a
    // completely different key", and only then retypes.
    const { generateSeedPhrase } = await import('../../src/crypto/keyManager');
    const { decryptInBrowser } = await import('../../src/ui/decryptScreen');
    const phrase = generateSeedPhrase();
    const words = phrase.split(' ');

    let url = '';
    let attempts = 0;
    let settled: unknown = 'still going';
    const done = decryptInBrowser(
      { ...DECRYPT, timeoutMs: 30_000, onListen: (u) => (url = u) },
      async () => {
        attempts += 1;
        // First answer: the phrase is real but opens nothing. The CLI re-serves
        // the step rather than refusing inline, which is a full page reload.
        return attempts === 1
          ? { ok: false, reason: 'KEY_MISMATCH' as const }
          : { ok: true, count: 4, wrote: true };
      },
    );
    void done.then((r) => (settled = r)).catch((e) => (settled = e));

    const page = await open(await waitForUrl(() => url));
    expect(await evaluate<number>(page, fillWords(words))).toBe(24);
    const reloaded = page.once('Page.loadEventFired', 20_000);
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Decrypt to a file')).click()`);
    await reloaded;

    // The step comes back, wiped, with the CLI's own reason on it.
    await until(
      page,
      `document.body.textContent.includes('a single wrong word produces a completely different key')`,
      'the key-mismatch reason',
    );
    expect(await evaluate<string>(page, `document.querySelector('input[type=password]').value`)).toBe('');

    // Read it. Twice the old grace window, and a fraction of what it takes to
    // find the card the 24 words are written on.
    await new Promise((r) => setTimeout(r, 2_500));

    // The run has not ended behind the page. This is the assertion the defect
    // broke: the promise resolved `{action:'cancelled',reason:'closed'}` about
    // 1.2s after the re-serve, the CLI printed "Browser closed. Nothing was
    // decrypted." and returned, and the socket the retype posts into was gone.
    expect(settled).toBe('still going');
    // The page is still being served by a live CLI, not by a corpse.
    expect((await fetch(url)).status).toBe(200);

    // …so the retype lands, and the run finishes the way it was going to.
    expect(await evaluate<number>(page, fillWords(words))).toBe(24);
    await evaluate(page, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Decrypt to a file')).click()`);
    expect(await done).toEqual({ action: 'decrypted', count: 4, wrote: true });
    expect(attempts).toBe(2);
  }, 90_000);

  test('the result page is reachable when the browser comes for it, and stops being served once it has', async () => {
    // Both halves of one rule. The page is served out of this process, so it
    // has to outlive the command long enough to load — and not one moment
    // longer: `showDecryptResult` used to return in 4ms and leave a listening
    // socket holding the process for two minutes with the work already done
    // and printed, on every run where nothing opened it.
    const { showDecryptResult } = await import('../../src/ui/decryptScreen');
    let url = '';
    const done = showDecryptResult(
      { ...DECRYPT, onListen: (u) => (url = u) },
      { count: 3, wrote: true },
      { timeoutMs: 30_000 },
    );

    const page = await open(await waitForUrl(() => url));
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('.env.main.decrypted')`)).toBe(true);
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('plaintext')`)).toBe(true);
    // Counts and a filename. Never a variable name, never a value.
    expect(await evaluate<boolean>(page, `document.body.textContent.includes('3 secrets')`)).toBe(true);

    const t0 = Date.now();
    await done;
    // It waited for the page and then stopped waiting — not for the timeout.
    expect(Date.now() - t0).toBeLessThan(5_000);
    // And the socket goes with it. Not asserted on the first try: the server
    // gives the response a beat to flush before tearing itself down, so the
    // honest claim is that the port STOPS answering, not that it already has.
    let refused = false;
    for (let i = 0; i < 200 && !refused; i++) {
      try {
        // While it is still up it is single-use and spent, so it cannot serve
        // a second copy of a page about a plaintext file either.
        expect((await fetch(url)).status).not.toBe(200);
      } catch {
        refused = true;
      }
      if (!refused) await new Promise((r) => setTimeout(r, 25));
    }
    expect(refused).toBe(true);
  }, 90_000);
});
