/**
 * The Stripe CLI's non-interactive sign-in hand-off, as capy reads it.
 *
 * `stripe login` with a piped stdin does NOT sign anyone in. It prints a JSON
 * object — `browser_url`, `verification_code`, `next_step` — and exits 0
 * immediately; completing the pairing is the caller's job. Before CAP-365 capy
 * did neither half: it inherited stdout, so on the MCP transport the pairing
 * URL and code were delivered to the AI agent instead of to the person who has
 * to approve them, and nothing ever ran `next_step`, so the run then failed on
 * a config that had never been written.
 *
 * This file pins the reading of that object, which is the part capy does not
 * own. Two properties matter more than the happy path:
 *
 *  - it fails CLOSED. A shape this parser does not recognise is `null`, which
 *    the caller reports as "this CLI cannot hand off a pairing" — never a
 *    half-built pairing that sends someone to nowhere.
 *  - the poll URL is VALIDATED, not trusted. It can only be lifted out of
 *    `next_step`, which is a command line, so the guard is that it must parse,
 *    must be https, and must sit on the same origin as `browser_url` — which
 *    came out of the same object and is where the user is being sent.
 */
import { describe, test, expect } from 'bun:test';
import { parseStripePairing } from '../../../src/commands/connectors/stripe';

/** Verbatim from `stripe login --non-interactive` (stripe 1.40.9), retokenised. */
const REAL = `{
  "browser_url": "https://dashboard.stripe.com/stripecli/confirm_auth?t=TOKEN123",
  "verification_code": "grin-faster-mature-bright",
  "next_step": "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/cliauth_ABC?secret=TOKEN123'"
}`;

describe('parseStripePairing', () => {
  test('reads the three things the hand-off needs out of a real payload', () => {
    const p = parseStripePairing(REAL);
    expect(p).toEqual({
      browserUrl: 'https://dashboard.stripe.com/stripecli/confirm_auth?t=TOKEN123',
      verificationCode: 'grin-faster-mature-bright',
      pollUrl: 'https://dashboard.stripe.com/stripecli/auth/cliauth_ABC?secret=TOKEN123',
    });
  });

  test('a banner printed before the object does not break the read', () => {
    // Sliced to the outermost braces rather than parsed whole, so a future
    // version that prefixes a line degrades to nothing rather than to a hard
    // refusal on every run.
    expect(parseStripePairing(`Checking for updates...\n${REAL}\n`)?.verificationCode).toBe(
      'grin-faster-mature-bright',
    );
  });

  test('output that is not the JSON object at all is null, not a guess', () => {
    // What an older `stripe` prints when it does not know the flag, and what a
    // TTY run prints instead. Either way there is no pairing here.
    expect(parseStripePairing('')).toBeNull();
    expect(parseStripePairing('unknown flag: --non-interactive')).toBeNull();
    expect(parseStripePairing('{ not json')).toBeNull();
    expect(parseStripePairing('[]')).toBeNull();
  });

  test('a payload missing either URL is null — half a hand-off is not one', () => {
    expect(parseStripePairing('{"verification_code":"a-b-c-d"}')).toBeNull();
    expect(
      parseStripePairing('{"browser_url":"https://dashboard.stripe.com/x","next_step":"stripe login"}'),
    ).toBeNull();
  });

  test('a next_step pointing off the browser_url origin is refused', () => {
    // The one that matters. `next_step` is a command line, and the URL inside
    // it is the address capy hands to `--complete`. An origin that is not the
    // one the user is being sent to is not the next step of this pairing.
    const evil = REAL.replace(
      'https://dashboard.stripe.com/stripecli/auth/cliauth_ABC',
      'https://dashboard.stripe.example.com/stripecli/auth/cliauth_ABC',
    );
    expect(parseStripePairing(evil)).toBeNull();
  });

  test('a plaintext browser_url or poll URL is refused', () => {
    expect(parseStripePairing(REAL.replace('"https://dashboard', '"http://dashboard'))).toBeNull();
    expect(
      parseStripePairing(REAL.replace("'https://dashboard.stripe.com/stripecli/auth", "'http://dashboard.stripe.com/stripecli/auth")),
    ).toBeNull();
  });

  test('a verification code Stripe did not send is empty, not fatal', () => {
    // The code is what the user compares; the URLs are what the pairing needs.
    // Losing the code costs the comparison and the screen says so — it must not
    // cost the sign-in.
    const p = parseStripePairing(REAL.replace('"verification_code": "grin-faster-mature-bright",', ''));
    expect(p?.verificationCode).toBe('');
    expect(p?.pollUrl).toContain('cliauth_ABC');
  });
});
