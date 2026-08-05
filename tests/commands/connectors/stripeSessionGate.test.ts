/**
 * When `connect` decides it needs to sign you in again.
 *
 * The old gate was `sections.length === 0` — "does config.toml have any
 * section at all". That answered a different question from the one it was
 * standing in for, in two ways that both end badly:
 *
 *  - `parseStripeConfig` keeps a section carrying nothing but an `account_id`,
 *    so a config with no key of any kind read as a live session. The run then
 *    died lower down in `readKeyFromSection` telling the user to run `stripe
 *    login` — the very thing the gate had just decided against doing for them.
 *  - An EXPIRED key read as signed in. A pairing that no longer works is not a
 *    pairing, and the failure surfaces later and further away.
 *
 * `usableFor` is that gate stated properly, and it is unit-testable precisely
 * because it takes parsed sections rather than reaching for the filesystem —
 * a behavioural test of the gate would have to let `stripe login` actually run.
 */
import { describe, test, expect } from 'bun:test';
import { parseStripeConfig, usableFor } from '../../../src/commands/connectors/stripe';

/** Far future and far past, as ISO dates — the shape Stripe writes. */
const SOON = '2099-01-01';
const GONE = '2020-01-01';

const cfg = (body: string) => parseStripeConfig(body);

describe('usableFor', () => {
  test('a section with a live, unexpired key for the mode is usable', () => {
    const s = cfg(`
[default]
account_id = 'acct_1'
test_mode_api_key = 'rk_test_abcdefghijkl'
test_mode_key_expires_at = '${SOON}'
`);
    expect(usableFor(s, 'test').map((x) => x.name)).toEqual(['default']);
  });

  test('a section holding only an account id is NOT a session', () => {
    // This is the one that made `connect` skip sign-in and then fail two
    // screens later with "run `stripe login` first".
    const s = cfg(`
[default]
account_id = 'acct_1'
display_name = 'Mikes Market'
`);
    expect(s).toHaveLength(1);
    expect(usableFor(s, 'test')).toHaveLength(0);
    expect(usableFor(s, 'live')).toHaveLength(0);
  });

  test('an expired key is not a session either', () => {
    const s = cfg(`
[default]
account_id = 'acct_1'
test_mode_api_key = 'rk_test_abcdefghijkl'
test_mode_key_expires_at = '${GONE}'
`);
    expect(usableFor(s, 'test')).toHaveLength(0);
  });

  test('a key with no recorded expiry counts as usable', () => {
    // Stripe does not always write one, and refusing a key for want of a date
    // would invent a problem — the pairing works or it does not, and the next
    // call finds out.
    const s = cfg(`
[default]
account_id = 'acct_1'
test_mode_api_key = 'rk_test_abcdefghijkl'
`);
    expect(usableFor(s, 'test')).toHaveLength(1);
  });

  test('the mode is part of the question, not an afterthought', () => {
    // A live-only config is not a test-mode session. Under the old gate this
    // read as signed in for BOTH modes.
    const s = cfg(`
[default]
account_id = 'acct_1'
live_mode_api_key = 'rk_live_abcdefghijkl'
live_mode_key_expires_at = '${SOON}'
`);
    expect(usableFor(s, 'live')).toHaveLength(1);
    expect(usableFor(s, 'test')).toHaveLength(0);
  });

  test('picks out the usable sections when a config holds several', () => {
    const s = cfg(`
[stale]
account_id = 'acct_1'
test_mode_api_key = 'rk_test_oldoldoldold'
test_mode_key_expires_at = '${GONE}'

[fresh]
account_id = 'acct_2'
test_mode_api_key = 'rk_test_newnewnewnew'
test_mode_key_expires_at = '${SOON}'
`);
    expect(usableFor(s, 'test').map((x) => x.name)).toEqual(['fresh']);
  });
});
