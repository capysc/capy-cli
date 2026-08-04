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
import { planOpen, type DefaultBrowser } from '../../src/ui/openScreen';

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
