/**
 * `capy rotate`'s three serves, and the page that reports what they did.
 *
 * The gate is the reason this file exists. `!opts.skipPrompts && isTTY` drops
 * `Proceed?` the moment stdin is piped, so the only approval the whole
 * rotate → push → deploy chain has disappears on exactly the runs nobody is
 * watching. Everything here is a check that the browser version cannot be
 * satisfied by anything other than a person answering it.
 */
import { describe, test, expect } from 'bun:test';
import {
  askRotateIntegrationInBrowser,
  askRotateVariableInBrowser,
  buildRotatePlanData,
  buildRotateProgressData,
  confirmRotatePlanInBrowser,
  type WebRotatePlanParams,
} from '../../src/ui/rotateScreens';
import { rotationPlan } from '../../src/commands/connectors/plans';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const CANDIDATES = [
  {
    name: 'STRIPE_SECRET_KEY',
    managed: true,
    provider: 'stripe',
    fingerprint: 'rk_…tst',
    expiresInDays: 3,
    mode: 'live' as const,
    accountId: 'acct_1234',
    issuedByCapy: true,
  },
  { name: 'DATABASE_URL', managed: false },
];

const BASE: WebRotatePlanParams = {
  step: 'variable',
  projectName: 'mikes-market',
  branch: 'development',
  devMode: false,
  all: false,
  noPush: false,
  stops: rotationPlan({ branch: 'development', providers: ['stripe'], authProviders: ['stripe'], standing: 'variable' }),
  candidates: CANDIDATES,
  open: false,
};

describe('buildRotatePlanData', () => {
  test('the rail is the CLI’s route, whole, on every step', () => {
    const d = buildRotatePlanData(BASE, 'n');
    expect(d.stops.map((s) => s.id)).toEqual([
      'variable',
      'integration',
      'auth',
      'rotate',
      'push',
      'deploy',
    ]);
  });

  test('a candidate carries the redacted fingerprint keep.lock stores, never a key', () => {
    const d = buildRotatePlanData(BASE, 'n');
    const row = d.candidates!.find((c) => c.name === 'STRIPE_SECRET_KEY')!;
    expect(row.fingerprint).toBe('rk_…tst');
    expect(row.fingerprint!.length).toBeLessThan(20);
    expect(JSON.stringify(d)).not.toContain('rk_live_51H');
  });

  test('expiry travels as a number, so the screen can count', () => {
    // The product renders this fact two ways today — `expires in 30d` in the
    // picker and `expires in 30 day(s).` in the nudge that sends you here —
    // and one of them has a plural bug.
    const d = buildRotatePlanData(BASE, 'n');
    expect(d.candidates![0].expiresInDays).toBe(3);
    expect(JSON.stringify(d)).not.toContain('day(s)');
  });

  test('each step names the flag that answers it headlessly', () => {
    expect(buildRotatePlanData(BASE, 'n').nonTty!.command).toBe('capy rotate <VAR>');
    expect(
      buildRotatePlanData({ ...BASE, step: 'integration', varName: 'DATABASE_URL' }, 'n').nonTty!
        .command,
    ).toContain('--provider');
    // The plan step's escape is the flag that stands in for the whole gate.
    expect(buildRotatePlanData({ ...BASE, step: 'plan' }, 'n').nonTty!.command).toContain('--yes');
  });

  test('advisories carry a code to branch on and a sentence for the reader', () => {
    const d = buildRotatePlanData(
      {
        ...BASE,
        step: 'plan',
        advisories: [{ code: 'provider-flag-ignored', detail: '\x1b[33m--provider stripe did nothing\x1b[0m' }],
      },
      'n',
    );
    expect(d.advisories![0].code).toBe('provider-flag-ignored');
    // The terminal's yellow is the terminal's; a payload is not a terminal.
    expect(d.advisories![0].detail).toBe('--provider stripe did nothing');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('an empty advisory list is omitted rather than sent as []', () => {
    expect(buildRotatePlanData({ ...BASE, advisories: [] }, 'n').advisories).toBeUndefined();
  });
});

describe('askRotateVariableInBrowser', () => {
  test('returns the picked credential', async () => {
    let url = '';
    const done = askRotateVariableInBrowser({ ...BASE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', variable: 'DATABASE_URL' } }),
    });
    expect(await done).toEqual({ variable: 'DATABASE_URL', cancelled: false });
  });

  test('a name the branch does not hold is refused, not rotated', async () => {
    let url = '';
    const done = askRotateVariableInBrowser({ ...BASE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });
    expect((await (await post({ __action: 'submit', variable: 'NOPE' })).json()).error).toContain(
      'not on this branch',
    );
    await post({ __action: 'cancel' });
    expect((await done).cancelled).toBe(true);
  });
});

describe('askRotateIntegrationInBrowser', () => {
  test('an integration this build does not register is refused', async () => {
    let url = '';
    const done = askRotateIntegrationInBrowser({
      ...BASE,
      step: 'integration',
      varName: 'DATABASE_URL',
      integrations: [{ name: 'stripe', description: 'Stripe API key' }],
      onListen: (u) => (url = u),
    });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });
    expect((await (await post({ __action: 'submit', provider: 'braintree' })).json()).error).toContain(
      'not registered',
    );
    await post({ __action: 'submit', provider: 'stripe' });
    expect(await done).toEqual({ provider: 'stripe', cancelled: false });
  });
});

describe('confirmRotatePlanInBrowser', () => {
  test('approval has to be sent, never inferred from a submit', async () => {
    let url = '';
    const done = confirmRotatePlanInBrowser({ ...BASE, step: 'plan', onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });

    expect((await (await post({ __action: 'submit' })).json()).error).toBeTruthy();
    await post({ __action: 'submit', proceed: true });
    expect(await done).toBe(true);
  });

  test('cancelling refuses the whole chain', async () => {
    let url = '';
    const done = confirmRotatePlanInBrowser({ ...BASE, step: 'plan', onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });
});

describe('buildRotateProgressData', () => {
  const RUN = {
    outcome: 'deploy-failed' as const,
    projectName: 'mikes-market',
    branch: 'development',
    all: true,
    noPush: false,
    devMode: false,
    stops: rotationPlan({ branch: 'development', all: true, targetCount: 2, providers: ['stripe'], authProviders: ['stripe'] }),
    steps: [
      { id: 'rotate' as const, label: 'Rotate', state: 'ok' as const, detail: '2/2' },
      { id: 'push' as const, label: 'Push', state: 'ok' as const, detail: 'development' },
      { id: 'deploy' as const, label: 'Deploy', state: 'fail' as const, detail: '\x1b[31mvercel refused\x1b[0m' },
    ],
    keys: [
      { name: 'STRIPE_SECRET_KEY', provider: 'stripe', outcome: 'rotated' as const, pushed: true, issuedByCapy: true },
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        provider: 'stripe',
        outcome: 'failed' as const,
        failureCode: 'login-failed-after-logout' as const,
        detail: '\x1b[31mstripe login failed\x1b[0m',
        retry: 'capy rotate STRIPE_WEBHOOK_SECRET',
      },
    ],
    deploy: { targetCount: 1 },
    open: false,
  };

  test('the progress screen has no nonce: closing the window costs nothing', () => {
    // Every choice the rotation needed was taken on the plan screen, and there
    // is nothing here a click could send back.
    expect('nonce' in buildRotateProgressData(RUN)).toBe(false);
  });

  test('a key that failed keeps a stable code, and the sentence stays display-only', () => {
    const d = buildRotateProgressData(RUN);
    const bad = d.keys.find((k) => k.name === 'STRIPE_WEBHOOK_SECRET')!;
    expect(bad.failureCode).toBe('login-failed-after-logout');
    expect(bad.detail).toBe('stripe login failed');
    expect(bad.retry).toBe('capy rotate STRIPE_WEBHOOK_SECRET');
  });

  test('strips the terminal colour codes off everything the CLI printed', () => {
    expect(JSON.stringify(buildRotateProgressData(RUN))).not.toContain('\x1b');
  });

  test('renders no key material', () => {
    const json = JSON.stringify(buildRotateProgressData(RUN));
    expect(json).not.toContain('rk_live');
    expect(json).not.toContain('sk_live');
  });
});
