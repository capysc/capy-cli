/**
 * What is left of `capy add` once the intake moved.
 *
 * `parseVars`, `runWebIntake` and the loopback contract are now
 * `tests/ui/secretIntakeScreen.test.ts` — they went with the code, which moved
 * to `ui/secretIntakeScreen.ts` along with the compiled screen it serves. This
 * file keeps the one thing that is genuinely argv's: turning repeatable
 * `--help-url NAME=URL` flags into per-variable links.
 */
import { describe, test, expect } from 'bun:test';
import { parseHelpUrls, overwriteNotice } from '../../src/commands/addCommand';

describe('parseHelpUrls (repeatable --help-url NAME=URL)', () => {
  test('maps valid http(s) pairs by name', () => {
    expect(
      parseHelpUrls(['STRIPE_SECRET_KEY=https://dashboard.stripe.com/apikeys', 'OPENAI_API_KEY=http://example.com/k']),
    ).toEqual({
      STRIPE_SECRET_KEY: 'https://dashboard.stripe.com/apikeys',
      OPENAI_API_KEY: 'http://example.com/k',
    });
  });

  test('drops non-http(s) URLs and malformed/invalid-name pairs', () => {
    expect(parseHelpUrls(['A=javascript:alert(1)', 'B=ftp://x', 'no-equals', '=https://x', '1BAD=https://x'])).toEqual(
      {},
    );
  });

  test('returns {} for undefined', () => {
    expect(parseHelpUrls(undefined)).toEqual({});
  });
});

describe('overwriteNotice', () => {
  test('carries the terminal confirm word for word', () => {
    // `--web` used to skip the confirm entirely — it is gated on `!opts.web` —
    // so a browser intake overwrote existing values without a word anywhere.
    // Two wordings for one thing is a bug, so this is the CLI's own sentence.
    expect(overwriteNotice(['A', 'B'])).toBe('A, B already exist(s). Overwrite?');
  });

  test('says nothing when nothing would be overwritten', () => {
    expect(overwriteNotice([])).toBeUndefined();
  });
});
