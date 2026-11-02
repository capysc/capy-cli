/**
 * The window decision, tested as a decision.
 *
 * Nothing here launches a browser, and that is the point rather than a
 * convenience: the subject under test is "which browser process would we
 * start", so a test that actually started one would open the developer's own
 * browser on every run of the suite. `planOpen` is pure, takes the detected
 * browser as an argument, and returns what it WOULD do; `openScreen` is the
 * thin part that carries the plan out.
 */
import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { planOpen, openScreen, launched, type DefaultBrowser, type Launchable } from '../../src/ui/openScreen';

const CHROME: DefaultBrowser = {
  family: 'chromium',
  exec: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
const SAFARI: DefaultBrowser = { family: 'webkit' };
const FIREFOX: DefaultBrowser = { family: 'firefox' };
const CHROME_NO_PATH: DefaultBrowser = { family: 'chromium' };

const URL = 'http://127.0.0.1:51234/?n=deadbeef';
/** A clean environment: none of the three knobs set. */
const env = (over: Record<string, string> = {}) => over as NodeJS.ProcessEnv;

describe('which window a screen opens in', () => {
  test('a loopback screen on a Chromium default browser gets a chromeless window', () => {
    const plan = planOpen(URL, { kind: 'dialog', browser: CHROME, env: env() });
    expect(plan.via).toBe('app-window');
    if (plan.via !== 'app-window') throw new Error('unreachable');
    expect(plan.exec).toBe(CHROME.exec!);
    expect(plan.args).toContain(`--app=${URL}`);
  });

  test('authentication never gets a chromeless window, even on Chrome', () => {
    // The person has to be able to read the address bar and pick the profile
    // their session lives in. A borderless window takes both away.
    expect(planOpen(URL, { kind: 'handoff', browser: CHROME, env: env() }).via).toBe(
      'default-browser',
    );
  });

  test('Safari and Firefox get an ordinary window rather than the wrong browser', () => {
    // The failure this guards: forcing Chrome because Chrome can do popups,
    // and landing someone in a browser they do not use.
    for (const browser of [SAFARI, FIREFOX]) {
      expect(planOpen(URL, { kind: 'dialog', browser, env: env() }).via).toBe('default-browser');
    }
  });

  test('a Chromium browser whose binary could not be resolved falls back', () => {
    expect(planOpen(URL, { kind: 'dialog', browser: CHROME_NO_PATH, env: env() }).via).toBe(
      'default-browser',
    );
  });

  test('CAPY_WEB_NO_OPEN suppresses every kind, which is what keeps CI honest', () => {
    for (const kind of ['dialog', 'handoff'] as const) {
      expect(planOpen(URL, { kind, browser: CHROME, env: env({ CAPY_WEB_NO_OPEN: '1' }) }).via).toBe(
        'suppressed',
      );
    }
  });

  test('CAPY_WEB_WINDOW=tab gives the address bar back without an argument', () => {
    expect(
      planOpen(URL, { kind: 'dialog', browser: CHROME, env: env({ CAPY_WEB_WINDOW: 'tab' }) }).via,
    ).toBe('default-browser');
  });

  test('a listing asks for the wide measure and a question does not', () => {
    const narrow = planOpen(URL, { kind: 'dialog', browser: CHROME, env: env() });
    const wide = planOpen(URL, { kind: 'dialog', wide: true, browser: CHROME, env: env() });
    if (narrow.via !== 'app-window' || wide.via !== 'app-window') throw new Error('unreachable');
    const px = (p: typeof narrow) =>
      Number(p.args.find((a) => a.startsWith('--window-size='))!.split('=')[1].split(',')[0]);
    expect(px(wide)).toBeGreaterThan(px(narrow));
    // 52rem of measure plus gutters has to actually fit, or a four-column
    // secret table wraps mid-word — the defect that put `wide` on Page.
    expect(px(wide)).toBeGreaterThanOrEqual(832);
  });

  test('the URL is passed as one argv entry, never through a shell', () => {
    // A nonce in a query string next to a shell is how a flow gets a truncated
    // token and a 404 that looks like a bug in the server.
    const plan = planOpen('http://127.0.0.1:1/?n=a&b=c', {
      kind: 'dialog',
      browser: CHROME,
      env: env(),
    });
    if (plan.via !== 'app-window') throw new Error('unreachable');
    expect(plan.args.filter((a) => a.includes('127.0.0.1'))).toHaveLength(1);
  });
});

/**
 * Carrying the plan out when there is no browser to start — a VM, a container,
 * a server over SSH. The defect being guarded is Node's own: a failed spawn is
 * reported as an `error` event a tick later, and an `error` event with no
 * listener throws after every try/catch has returned and kills the CLI.
 */
describe('opening when no browser can start', () => {
  const MISSING = 'capy-test-no-such-launcher-7f3a';
  const dialog = { kind: 'dialog' as const, browser: CHROME, env: env() };
  const handoff = { kind: 'handoff' as const, env: env() };

  /**
   * How Node reports a missing executable: no throw, `pid` left undefined, and
   * an `error` event on the next tick. An EventEmitter's unhandled `error`
   * throws, so if the listener were missing this would fail the run exactly as
   * it killed the CLI. Built by hand because Bun (which runs this suite) throws
   * synchronously from `spawn` instead, which is not the path the CLI takes.
   */
  const nodeStyleMissing = (): Launchable => {
    const child = Object.assign(new EventEmitter(), { pid: undefined });
    process.nextTick(() =>
      child.emit('error', Object.assign(new Error(`spawn ${MISSING} ENOENT`), { code: 'ENOENT' })),
    );
    return child;
  };
  /** Mirrors the `open` package: start inside an async function, return the child. */
  const openMissing = async (): Promise<Launchable> => {
    await Promise.resolve();
    return nodeStyleMissing();
  };

  test('a missing launcher resolves as not opened instead of crashing', async () => {
    const result = await openScreen(URL, handoff, { openDefault: openMissing });
    expect(result.via).toBe('default-browser');
    expect(result.opened).toBe(false);
  });

  test('a missing app-window binary falls back, and reports not opened when that fails too', async () => {
    const result = await openScreen(URL, dialog, {
      spawnApp: nodeStyleMissing,
      openDefault: openMissing,
    });
    expect(result.via).toBe('app-window');
    expect(result.opened).toBe(false);
  });

  test('a launcher that throws while starting is not opened', async () => {
    const result = await openScreen(URL, handoff, {
      openDefault: () => Promise.reject(new Error('boom')),
    });
    expect(result.opened).toBe(false);
  });

  test('a launcher that starts is opened', async () => {
    const result = await openScreen(URL, handoff, {
      openDefault: async () => spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }),
    });
    expect(result.opened).toBe(true);
  });

  test('suppressed never starts anything and is not opened', async () => {
    const result = await openScreen(URL, { kind: 'handoff', env: env({ CAPY_WEB_NO_OPEN: '1' }) }, {
      openDefault: () => Promise.reject(new Error('must not be called')),
    });
    expect(result).toEqual({ via: 'suppressed', opened: false });
  });

  test('launched() treats an object without events as started', async () => {
    expect(launched({})).toBe(true);
  });
});
