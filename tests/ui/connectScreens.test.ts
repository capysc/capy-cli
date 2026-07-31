/**
 * `capy connect`'s five screens: the payloads, and the refusals.
 *
 * The behaviour that matters here is the behaviour that matters in
 * `syncConflictScreen.test.ts` — snippets only, never a value; the user's
 * answer reaches the caller; an answer the screen could not have produced is
 * refused inline rather than applied as a guess — plus the things this flow can
 * get wrong that no other flow can: a mode this machine has no key for, a
 * connector whose binary is missing, and the typed account-ID echo in front of
 * a live key.
 */
import { describe, test, expect } from 'bun:test';
import {
  askConnectInBrowser,
  buildConnectOverwriteData,
  buildConnectProviderData,
  buildConnectResultData,
  buildConnectSetupData,
  buildLiveGateData,
  chooseConnectorInBrowser,
  confirmLiveActionInBrowser,
  type ConnectQuestion,
  type WebConnectSetupParams,
} from '../../src/ui/connectScreens';
import { connectPlan } from '../../src/commands/connectors/plans';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const PLAN = {
  provider: 'stripe',
  branch: 'development',
  requiresTool: 'stripe',
  requiresAuth: true,
  push: true,
};

function params(questions: ConnectQuestion[]): WebConnectSetupParams {
  return {
    provider: 'stripe',
    projectName: 'mikes-market',
    branch: 'development',
    plan: PLAN,
    questions,
    open: false,
  };
}

const VAR_Q: ConnectQuestion = {
  kind: 'var',
  vars: [
    { name: 'STRIPE_SECRET_KEY', looksRelated: true, hasValue: true, managedBy: 'stripe' },
    { name: 'DATABASE_URL', looksRelated: false, hasValue: true },
  ],
  defaultVarName: 'STRIPE_SECRET_KEY',
};

const MODE_Q: ConnectQuestion = {
  kind: 'mode',
  modes: [
    { id: 'test', available: true, keyPrefix: 'rk_test_' },
    { id: 'live', available: false, blockedBy: 'NO_KEY' },
  ],
};

describe('buildConnectSetupData', () => {
  test('the rail is the CLI’s plan, drawn whole, standing on the question asked', () => {
    const d = buildConnectSetupData(params([VAR_Q]), VAR_Q, {}, 'n');
    expect(d.step).toBe('var');
    expect(d.stops.map((s) => s.id)).toEqual(
      connectPlan({ ...PLAN, standing: 'var' }).map((s) => s.id),
    );
    expect(d.stops.filter((s) => s.state === 'current').map((s) => s.id)).toEqual(['var']);
  });

  test('answers already collected are folded forward onto the rail', () => {
    const d = buildConnectSetupData(params([MODE_Q]), MODE_Q, { var: 'STRIPE_SECRET_KEY' }, 'n');
    const varStop = d.stops.find((s) => s.id === 'var')!;
    expect(varStop.state).toBe('done');
    expect(varStop.answer).toBe('STRIPE_SECRET_KEY');
    expect(d.stops.find((s) => s.id === 'mode')!.state).toBe('current');
  });

  test('each step carries only its own question’s data', () => {
    const onVar = buildConnectSetupData(params([VAR_Q]), VAR_Q, {}, 'n');
    expect(onVar.vars).toHaveLength(2);
    expect(onVar.modes).toBeUndefined();
    expect(onVar.accounts).toBeUndefined();

    const onMode = buildConnectSetupData(params([MODE_Q]), MODE_Q, {}, 'n');
    expect(onMode.modes).toHaveLength(2);
    expect(onMode.vars).toBeUndefined();
  });

  test('every step states how it is answered without a browser', () => {
    // One source for the flag, so the footnote and `refuseNonInteractive`
    // cannot describe different arguments.
    expect(buildConnectSetupData(params([VAR_Q]), VAR_Q, {}, 'n').nonTty!.command).toContain('--var');
    expect(buildConnectSetupData(params([MODE_Q]), MODE_Q, {}, 'n').nonTty!.command).toContain('--live');
  });

  test('carries no key value — a prefix is eight characters and no more', () => {
    const d = buildConnectSetupData(params([MODE_Q]), MODE_Q, {}, 'n');
    for (const m of d.modes ?? []) {
      if (m.keyPrefix) expect(m.keyPrefix.length).toBe(8);
    }
    expect(JSON.stringify(d)).not.toContain('rk_test_51H');
  });
});

describe('buildConnectOverwriteData', () => {
  const Q: ConnectQuestion = {
    kind: 'overwrite',
    varName: 'STRIPE_SECRET_KEY',
    current: { fingerprint: 'rk_…abc', managedBy: 'stripe', mode: 'live', age: '3 days ago', pushed: true },
    incoming: { keyPrefix: 'rk_test_', mode: 'test', accountId: 'acct_1234', fingerprint: 'rk_…xyz' },
  };

  test('describes both sides of the replacement, and neither as a value', () => {
    const d = buildConnectOverwriteData(params([Q]), Q as never, 'n');
    expect(d.current.fingerprint).toBe('rk_…abc');
    expect(d.incoming.keyPrefix).toBe('rk_test_');
    const json = JSON.stringify(d);
    expect(json).not.toContain('rk_test_51HabcdefgHIJK');
    // Every string in the payload is a snippet, a name or a sentence — nothing
    // in it is long enough to be a key.
    expect(d.current.fingerprint!.length).toBeLessThan(20);
    expect(d.incoming.fingerprint.length).toBeLessThan(20);
  });

  test('the overwrite guard draws no rail: it is not a stop on the route', () => {
    // It is the route being interrupted by something already in the way, and a
    // station for it would imply the plan expected it.
    const d = buildConnectOverwriteData(params([Q]), Q as never, 'n');
    expect('stops' in d).toBe(false);
  });

  test('names -f, the same flag the non-interactive refusal names', () => {
    expect(buildConnectOverwriteData(params([Q]), Q as never, 'n').nonTty!.command).toContain('-f');
  });
});

describe('askConnectInBrowser', () => {
  test('walks three questions over one server and returns every answer', async () => {
    let url = '';
    const done = askConnectInBrowser({
      ...params([
        VAR_Q,
        MODE_Q,
        {
          kind: 'overwrite',
          varName: 'STRIPE_SECRET_KEY',
          current: { pushed: false },
          incoming: { keyPrefix: 'rk_test_', mode: 'test', fingerprint: 'rk_…xyz' },
        },
      ]),
      onListen: (u) => (url = u),
    });

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The page is the compiled screen itself, served whole.
    const page = await (await fetch(u.href)).text();
    expect(page).toContain('window.__CAPY_DATA__');
    expect(page).not.toContain('id="screen"');

    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });

    expect(await (await post({ __action: 'submit', var: 'STRIPE_SECRET_KEY' })).json()).toEqual({
      next: true,
    });
    // The reload serves the NEXT question at the same address.
    expect(await (await fetch(u.href)).text()).toContain('"step":"mode"');

    await post({ __action: 'submit', mode: 'test' });
    await post({ __action: 'submit', overwrite: true });

    expect(await done).toEqual({
      answers: { var: 'STRIPE_SECRET_KEY', mode: 'test', overwrite: true },
      cancelled: false,
    });
  });

  test('a mode this machine has no key for is refused, not written', async () => {
    // The screen disables it. Writing a live key there is no live key for is
    // the failure this refusal exists to prevent — the terminal finds out one
    // question later, in `readKeyFromSection`, and exits.
    let url = '';
    let settled = false;
    const done = askConnectInBrowser({ ...params([MODE_Q]), timeoutMs: 4_000, onListen: (u) => (url = u) });
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', mode: 'live' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).error).toContain('not available');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    await done;
  });

  test('a new variable name .env cannot hold is refused', async () => {
    let url = '';
    const done = askConnectInBrowser({ ...params([VAR_Q]), onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });

    expect((await (await post({ __action: 'submit', var: 'lower case' })).json()).error).toContain(
      'UPPER_SNAKE_CASE',
    );
    // A name already on the branch is fine — it is the list's own row.
    await post({ __action: 'submit', var: 'DATABASE_URL' });
    expect((await done).answers.var).toBe('DATABASE_URL');
  });

  test('an account the config does not hold is refused', async () => {
    let url = '';
    const done = askConnectInBrowser({
      ...params([
        {
          kind: 'account',
          accounts: [{ id: 'default', accountId: 'acct_1', hasTestKey: true, hasLiveKey: false }],
        },
      ]),
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

    expect((await (await post({ __action: 'submit', account: 'somebody-elses' })).json()).error).toContain(
      'not in this provider',
    );
    await post({ __action: 'submit', account: 'default' });
    expect((await done).answers.account).toBe('default');
  });

  test('cancelling answers nothing and says so', async () => {
    let url = '';
    const done = askConnectInBrowser({ ...params([VAR_Q, MODE_Q]), onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toEqual({ answers: {}, cancelled: true });
  });

  test('a run with nothing outstanding opens no browser at all', async () => {
    let opened = false;
    const out = await askConnectInBrowser({ ...params([]), onListen: () => (opened = true) });
    expect(out).toEqual({ answers: {}, cancelled: false });
    expect(opened).toBe(false);
  });
});

describe('buildConnectProviderData', () => {
  const CONNECTORS = [
    {
      id: 'stripe',
      description: 'Stripe API key (test or live, restricted)',
      requiresAuth: true,
      requiresTool: 'stripe',
      toolFound: false,
      blocked: { code: 'PROVIDER_CLI_MISSING', title: 'stripe CLI not found.', detail: 'x' },
      managedCount: 2,
    },
  ];

  test('carries the registry’s description verbatim', () => {
    const d = buildConnectProviderData(
      { projectName: 'mikes-market', branch: 'development', connectors: CONNECTORS },
      'n',
    );
    expect(d.connectors[0].description).toBe('Stripe API key (test or live, restricted)');
    expect(d.connectors[0].requiresAuth).toBe(true);
  });

  test('shows the mistake and the menu together', () => {
    const d = buildConnectProviderData(
      {
        projectName: 'mikes-market',
        branch: 'development',
        connectors: CONNECTORS,
        unknownProvider: 'strope',
      },
      'n',
    );
    expect(d.unknownProvider).toBe('strope');
    expect(d.connectors).toHaveLength(1);
  });
});

describe('chooseConnectorInBrowser', () => {
  test('a connector whose binary is missing cannot be picked', async () => {
    // The row already draws the refusal as a preview; running it anyway walks
    // the user into a `precheck` that exits, having spent a click.
    let url = '';
    const done = chooseConnectorInBrowser({
      projectName: 'mikes-market',
      branch: 'development',
      connectors: [
        { id: 'stripe', description: 'Stripe API key', requiresTool: 'stripe', toolFound: false },
        { id: 'acme', description: 'Acme token', toolFound: true },
      ],
      open: false,
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

    expect((await (await post({ __action: 'submit', provider: 'stripe' })).json()).error).toContain(
      'not on your PATH',
    );
    expect((await (await post({ __action: 'submit', provider: 'nope' })).json()).error).toContain(
      'not in this build',
    );
    await post({ __action: 'submit', provider: 'acme' });
    expect(await done).toEqual({ provider: 'acme', cancelled: false });
  });
});

describe('buildLiveGateData', () => {
  const GATE = {
    action: 'rotate' as const,
    provider: 'stripe',
    projectName: 'mikes-market',
    branch: 'development',
    varName: 'STRIPE_SECRET_KEY',
    accountId: 'acct_1234',
    keyPrefix: 'rk_live_',
    push: true,
    stops: connectPlan({ ...PLAN, standing: null, varName: 'STRIPE_SECRET_KEY', mode: 'live', account: 'acct_1234' }),
    open: false,
  };

  test('never arrives with the answer already in the box', () => {
    // A gate that confirms itself is not a gate.
    expect(buildLiveGateData(GATE, 'n').typed).toBe('');
  });

  test('an account the config could not name travels as null, not as "(unknown)"', () => {
    // The terminal asks the user to type the literal string `(unknown)`, which
    // satisfies the prompt and confirms nothing.
    const d = buildLiveGateData({ ...GATE, accountId: null }, 'n');
    expect(d.accountId).toBeNull();
    expect(JSON.stringify(d)).not.toContain('(unknown)');
  });

  test('carries eight characters of the key and no more', () => {
    const d = buildLiveGateData(GATE, 'n');
    expect(d.keyPrefix).toBe('rk_live_');
    expect(JSON.stringify(d)).not.toContain('rk_live_51HabcdefgHIJK');
  });

  test('draws the route the run declared, not one of its own', () => {
    const d = buildLiveGateData(GATE, 'n');
    expect(d.stops.map((s) => s.id)).toEqual(['cli', 'var', 'mode', 'auth', 'account', 'refresh', 'push']);
  });
});

describe('confirmLiveActionInBrowser', () => {
  const GATE = {
    action: 'rotate' as const,
    provider: 'stripe',
    projectName: 'mikes-market',
    branch: 'development',
    varName: 'STRIPE_SECRET_KEY',
    accountId: 'acct_1234',
    keyPrefix: 'rk_live_',
    push: true,
    stops: connectPlan({ ...PLAN, standing: null, mode: 'live' }),
    open: false,
  };

  test('a mismatch keeps the user on the gate instead of losing the run', async () => {
    // `confirmLiveAction` returns false on any unequal string and the command
    // exits, so a typo and a change of heart are indistinguishable.
    let url = '';
    let settled = false;
    const done = confirmLiveActionInBrowser({ ...GATE, onListen: (u) => (url = u) });
    void done.then(() => (settled = true));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = (payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload }),
      });

    expect((await (await post({ __action: 'submit', confirmed: 'acct_1235' })).json()).error).toContain(
      'character by character',
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // A pasted ID with a trailing space is not a decision to abandon it.
    await post({ __action: 'submit', confirmed: '  acct_1234 ' });
    expect(await done).toBe(true);
  });

  test('the comparison is the CLI’s, never the page’s', async () => {
    // Anything the page sends is compared here against the account the CLI
    // resolved: a gate whose verdict is computed by the thing being gated is
    // not a gate.
    let url = '';
    const done = confirmLiveActionInBrowser({ ...GATE, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', confirmed: true, matches: true } }),
    });
    expect((await res.json()).error).toBeTruthy();
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });

  test('a gate with nothing to confirm against cannot be satisfied', async () => {
    let url = '';
    const done = confirmLiveActionInBrowser({ ...GATE, accountId: null, onListen: (u) => (url = u) });
    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'submit', confirmed: '(unknown)' } }),
    });
    expect((await res.json()).error).toContain('cannot name this account');
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'cancel' } }),
    });
    expect(await done).toBe(false);
  });
});

describe('buildConnectResultData', () => {
  const RESULT = {
    outcome: 'pushed' as const,
    provider: 'stripe',
    projectName: 'mikes-market',
    branch: 'development',
    varName: 'STRIPE_SECRET_KEY',
    mode: 'live' as const,
    accountId: 'acct_1234',
    keyPrefix: 'rk_live_',
    fingerprint: 'rk_…xyz',
    stops: connectPlan({ ...PLAN, standing: null, varName: 'STRIPE_SECRET_KEY', mode: 'live' }),
    open: false,
  };

  test('confirms which key landed where, with no key in it', () => {
    const d = buildConnectResultData(RESULT);
    expect(d.keyPrefix).toBe('rk_live_');
    expect(d.fingerprint).toBe('rk_…xyz');
    expect(JSON.stringify(d)).not.toContain('rk_live_51HabcdefgHIJK');
  });

  test('a run whose push did not land says what to run next', () => {
    // "It is here and nobody else has it" and "nothing happened" need
    // different next moves, and the terminal reports the first as a stack
    // trace.
    const d = buildConnectResultData({ ...RESULT, outcome: 'push-failed', detail: 'ECONNRESET' });
    expect(d.outcome).toBe('push-failed');
    expect(d.followUp).toBe('capy push');
    expect(d.detail).toBe('ECONNRESET');
  });

  test('the result screen has no nonce: it reports, it does not decide', () => {
    expect('nonce' in buildConnectResultData(RESULT)).toBe(false);
  });

  test('strips terminal colour codes off anything the CLI formatted', () => {
    const d = buildConnectResultData({ ...RESULT, projectName: '\x1b[1mmikes-market\x1b[0m' });
    expect(d.projectName).toBe('mikes-market');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });
});
