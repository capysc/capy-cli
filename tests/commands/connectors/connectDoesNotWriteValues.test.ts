/**
 * `connect` sets up the link. It does not touch the credential.
 *
 * This is the invariant, and it is worth a test of its own because the old
 * behaviour was so quiet. `connect stripe` used to return the key sitting in
 * the Stripe CLI's `config.toml` as `ConnectResult.value`, and
 * `connectCommand` handed that straight to `writeAndSync`, which wrote it over
 * whatever the variable already held, re-encrypted every variable on the
 * branch and pushed. On a command whose name promises an association, on a
 * flow where the user's only warning was an overwrite screen that — with more
 * than one Stripe account paired — rendered the incoming key as a blank.
 *
 * Nothing failed. The connector's unit tests all passed, because they test the
 * describers rather than the write; the suite was green; the value was gone.
 * So the assertions below are about ABSENCE: no `value` on the result, and a
 * `localPlaintext` that comes out the way it went in.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripeConnector } from '../../../src/commands/connectors/stripe';
import type { ResolvedContext } from '../../../src/commands/connectors/shared';
import type { KeepFile } from '../../../src/types/index';

/**
 * One section only, and no `--account`, so the run needs no prompt to resolve
 * it. Expiry is far out so the near-expiry offer stays quiet too — this test is
 * about the write, and a run that stops to ask something is not exercising it.
 */
const CONFIG = `
[default]
account_id = 'acct_1234'
display_name = 'Mikes Market'
test_mode_api_key = 'rk_test_51HabcdefgHIJKLMNOPqrs'
test_mode_key_expires_at = '2099-01-01'
`;

const HOME = mkdtempSync(join(tmpdir(), 'capy-connect-'));
mkdirSync(join(HOME, 'stripe'), { recursive: true });
writeFileSync(join(HOME, 'stripe', 'config.toml'), CONFIG);
const PREV_XDG = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = HOME;

afterAll(() => {
  if (PREV_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = PREV_XDG;
  rmSync(HOME, { recursive: true, force: true });
});

function ctxWith(localPlaintext: Record<string, string>): ResolvedContext {
  const keep: KeepFile = {
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'mikes-market',
    variables: {},
  };
  return { keep, branch: 'development', localPlaintext } as unknown as ResolvedContext;
}

const ORIGINAL = 'sk_test_thevalueThatWasAlreadyInDotEnv';

describe('connect stripe', () => {
  test('returns no value to write', async () => {
    const ctx = ctxWith({ STRIPE_SECRET: ORIGINAL });
    const result = await stripeConnector.connect(ctx, {
      var: 'STRIPE_SECRET',
      nonTty: true,
      devMode: true,
    });
    expect(result.varName).toBe('STRIPE_SECRET');
    expect(result.value).toBeUndefined();
  });

  test('leaves the variable it connected exactly as it found it', async () => {
    const localPlaintext = { STRIPE_SECRET: ORIGINAL, API_KEY: 'untouched' };
    const ctx = ctxWith(localPlaintext);
    await stripeConnector.connect(ctx, { var: 'STRIPE_SECRET', nonTty: true, devMode: true });
    expect(localPlaintext.STRIPE_SECRET).toBe(ORIGINAL);
    expect(localPlaintext.API_KEY).toBe('untouched');
  });

  test('records the link: provider, mode, account, fingerprint and key type', async () => {
    // The absence above is only right if the PRESENCE here holds — a connect
    // that wrote nothing and recorded nothing would pass the first two tests
    // and be useless.
    const ctx = ctxWith({ STRIPE_SECRET: ORIGINAL });
    const { entry } = await stripeConnector.connect(ctx, {
      var: 'STRIPE_SECRET',
      nonTty: true,
      devMode: true,
    });
    expect(entry.provider).toBe('stripe');
    expect(entry.mode).toBe('test');
    expect(entry.account_id).toBe('acct_1234');
    // Both derived from Stripe's key, NOT from what .env holds: `rotate` diffs
    // the key Stripe hands back against `fingerprint`, so recording the .env
    // value here would break its "Stripe returned the same key" detection.
    expect(entry.fingerprint).toBe('rk_…qrs');
    expect(entry.key_prefix).toBe('rk_test_');
  });

  test('carries no key value anywhere in the result', async () => {
    const ctx = ctxWith({ STRIPE_SECRET: ORIGINAL });
    const result = await stripeConnector.connect(ctx, {
      var: 'STRIPE_SECRET',
      nonTty: true,
      devMode: true,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('rk_test_51HabcdefgHIJKLMNOPqrs');
    expect(json).not.toContain(ORIGINAL);
  });
});
