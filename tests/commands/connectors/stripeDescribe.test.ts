/**
 * What the Stripe connector tells the browser about the machine it is on.
 *
 * Every one of these is a pure read of state the command already has, and
 * every one of them is a place a secret could leak into a payload if it were
 * written carelessly. The tests that matter most here are the negative ones.
 */
import { describe, test, expect } from 'bun:test';
import {
  currentVarState,
  describeIncomingKey,
  parseStripeConfig,
  stripeModeOptions,
  stripeVarSlots,
  toStripeAccounts,
} from '../../../src/commands/connectors/stripe';
import type { ResolvedContext } from '../../../src/commands/connectors/shared';
import type { KeepFile } from '../../../src/types/index';

const CONFIG = `
[default]
account_id = 'acct_1234'
display_name = 'Mikes Market'
test_mode_api_key = 'rk_test_51HabcdefgHIJKLMNOP'
test_mode_key_expires_at = '2099-01-01'

[second]
account_id = 'acct_5678'
live_mode_api_key = 'rk_live_51HzyxwvutSRQPONML'
`;

const SECTIONS = parseStripeConfig(CONFIG);

function ctxWith(
  localPlaintext: Record<string, string>,
  variables: KeepFile['variables'] = {},
): ResolvedContext {
  const keep: KeepFile = {
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'mikes-market',
    variables,
  };
  return { keep, branch: 'development', localPlaintext } as unknown as ResolvedContext;
}

describe('toStripeAccounts', () => {
  test('carries the section name, the account id and what each can serve', () => {
    const accounts = toStripeAccounts(SECTIONS);
    expect(accounts.map((a) => a.id)).toEqual(['default', 'second']);
    expect(accounts[0].accountId).toBe('acct_1234');
    expect(accounts[0].displayName).toBe('Mikes Market');
    expect(accounts[0].hasTestKey).toBe(true);
    expect(accounts[0].hasLiveKey).toBe(false);
    expect(accounts[1].hasLiveKey).toBe(true);
  });

  test('carries no key value', () => {
    const json = JSON.stringify(toStripeAccounts(SECTIONS));
    expect(json).not.toContain('rk_test_51HabcdefgHIJKLMNOP');
    expect(json).not.toContain('rk_live_51HzyxwvutSRQPONML');
  });
});

describe('stripeModeOptions', () => {
  test('says which modes this machine can actually serve', () => {
    // The terminal offers both and finds out one question later, in
    // `readKeyFromSection`, that there is no key — an exit, too late.
    const modes = stripeModeOptions(SECTIONS, 'acct_1234', false);
    const test_ = modes.find((m) => m.id === 'test')!;
    const live = modes.find((m) => m.id === 'live')!;
    expect(test_.available).toBe(true);
    expect(test_.keyPrefix).toBe('rk_test_');
    expect(live.available).toBe(false);
    expect(live.blockedBy).toBe('NO_KEY');
  });

  test('a prefix is eight characters and no more', () => {
    for (const m of stripeModeOptions(SECTIONS, 'acct_1234', false)) {
      if (m.keyPrefix) expect(m.keyPrefix.length).toBe(8);
    }
    expect(JSON.stringify(stripeModeOptions(SECTIONS, 'acct_1234', false))).not.toContain(
      'rk_test_51HabcdefgHIJKLMNOP',
    );
  });

  test('capy-dev refuses live mode beside the option, not two screens later', () => {
    const live = stripeModeOptions(SECTIONS, 'acct_5678', true).find((m) => m.id === 'live')!;
    expect(live.available).toBe(false);
    expect(live.blockedBy).toBe('DEV_MODE');
  });

  test('an unresolved account offers what any section could serve, never a false no', () => {
    // Several accounts and none named: availability is genuinely unknown, and
    // a definite `false` would be a claim the CLI cannot make here.
    const modes = stripeModeOptions(SECTIONS, undefined, false);
    expect(modes.find((m) => m.id === 'test')!.available).toBe(true);
    expect(modes.find((m) => m.id === 'live')!.available).toBe(true);
    expect(modes.every((m) => m.keyPrefix === undefined)).toBe(true);
  });

  test('nothing paired yet offers both, because nothing has been read', () => {
    const modes = stripeModeOptions([], undefined, false);
    expect(modes.every((m) => m.available)).toBe(true);
  });
});

describe('stripeVarSlots', () => {
  test('puts the Stripe-shaped names first, the way rankStripeVars does', () => {
    const ctx = ctxWith({ DATABASE_URL: 'postgres://x', STRIPE_SECRET_KEY: 'rk_test_abc12345' });
    const slots = stripeVarSlots(ctx);
    expect(slots.map((s) => s.name)).toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL']);
    expect(slots[0].looksRelated).toBe(true);
    expect(slots[1].looksRelated).toBe(false);
  });

  test('marks a slot a connector already owns', () => {
    const ctx = ctxWith(
      { STRIPE_SECRET_KEY: 'rk_test_abc12345' },
      {
        STRIPE_SECRET_KEY: [
          {
            resource_id: 'r',
            branch: 'development',
            value_hash: 'h',
            connector: { provider: 'stripe', source: 'cli', mode: 'test', created_at: 1 },
          },
        ],
      },
    );
    expect(stripeVarSlots(ctx)[0].managedBy).toBe('stripe');
  });

  test('carries no value', () => {
    const ctx = ctxWith({ STRIPE_SECRET_KEY: 'rk_test_abc12345', DATABASE_URL: 'postgres://x' });
    const json = JSON.stringify(stripeVarSlots(ctx));
    expect(json).not.toContain('rk_test_abc12345');
    expect(json).not.toContain('postgres://x');
  });
});

describe('currentVarState', () => {
  test('reduces the value in the slot to a fingerprint', () => {
    const ctx = ctxWith({ STRIPE_SECRET_KEY: 'rk_test_abcdefghijklmnop' });
    const state = currentVarState(ctx, 'STRIPE_SECRET_KEY');
    expect(state.fingerprint).toBe('rk_…nop');
    expect(JSON.stringify(state)).not.toContain('rk_test_abcdefghijklmnop');
  });

  test('a value too short to redact gets NO fingerprint at all', () => {
    // `fingerprint()` returns anything seven characters or shorter verbatim,
    // which is right for a terminal the user is already looking at and a leak
    // in a payload. The screen renders an absent fingerprint as "not recorded".
    const ctx = ctxWith({ API_KEY: 'hunter2' });
    const state = currentVarState(ctx, 'API_KEY');
    expect(state.fingerprint).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('hunter2');
  });

  test('says whether teammates are holding this value', () => {
    // An entry seeded before any push carries an empty value_hash; anything
    // else came back from the service, which means the branch has it.
    const pushed = ctxWith({ K: 'rk_test_abcdefghij' }, {
      K: [{ resource_id: 'r', branch: 'development', value_hash: 'h' }],
    });
    expect(currentVarState(pushed, 'K').pushed).toBe(true);

    const local = ctxWith({ K: 'rk_test_abcdefghij' }, {
      K: [{ resource_id: '', branch: 'development', value_hash: '' }],
    });
    expect(currentVarState(local, 'K').pushed).toBe(false);
  });

  test('surfaces the connector that set it, and when', () => {
    const ctx = ctxWith({ K: 'rk_live_abcdefghij' }, {
      K: [
        {
          resource_id: 'r',
          branch: 'development',
          value_hash: 'h',
          connector: {
            provider: 'stripe',
            source: 'cli',
            mode: 'live',
            created_at: Math.floor(Date.now() / 1000) - 3 * 86400,
          },
        },
      ],
    });
    const state = currentVarState(ctx, 'K');
    expect(state.managedBy).toBe('stripe');
    expect(state.mode).toBe('live');
    expect(state.age).toBe('3 days ago');
  });

  test('a hand-entered value claims no connector', () => {
    const ctx = ctxWith({ K: 'rk_test_abcdefghij' });
    const state = currentVarState(ctx, 'K');
    expect(state.managedBy).toBeUndefined();
    expect(state.mode).toBeUndefined();
  });
});

describe('describeIncomingKey', () => {
  test('describes the key an unambiguous account would hand over', () => {
    const incoming = describeIncomingKey(SECTIONS, 'test', 'acct_1234');
    expect(incoming.keyPrefix).toBe('rk_test_');
    expect(incoming.mode).toBe('test');
    expect(incoming.accountId).toBe('acct_1234');
    expect(incoming.fingerprint).toBe('rk_…NOP');
    expect(JSON.stringify(incoming)).not.toContain('rk_test_51HabcdefgHIJKLMNOP');
  });

  test('claims nothing about a key the run has not resolved yet', () => {
    // `confirmOverwrite` runs before the account is settled and before any
    // `stripe login`, so with several accounts paired and none named there is
    // no key to describe. Empty rather than invented — see the note on
    // `describeIncomingKey` about the contract this reveals.
    const incoming = describeIncomingKey(SECTIONS, 'live', undefined);
    expect(incoming.keyPrefix).toBe('');
    expect(incoming.fingerprint).toBe('');
    expect(incoming.mode).toBe('live');
  });
});
