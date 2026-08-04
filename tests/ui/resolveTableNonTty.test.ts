/**
 * Off a terminal, the conflict table asks for a human — it does not answer for
 * one.
 *
 * The bug this pins: `run()` used to detect the missing TTY and resolve every
 * variable to its DEFAULT with `cancelled: false`, which the caller could not
 * tell apart from a person pressing enter on each row. Nothing was destroyed —
 * the defaults are the safe picks — but a sync with nobody watching wrote a
 * conflict resolution and reported it as consent. The screens state the rule
 * the terminal was breaking: an unanswered step is a refusal.
 *
 * The shape of the fix is what these assert. `outcome` carries three values so
 * "nobody was asked" is expressible at all, and `choices` comes back EMPTY on
 * that outcome so a caller that forgets to check has nothing to apply rather
 * than a plausible set of answers nobody gave.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { ResolveTable, type ResolveRow, type ColumnKey } from '../../src/ui/resolveTable';

const ROWS: ResolveRow[] = [
  { variable: 'STRIPE_SECRET_KEY', pinned: 'sk_l...4242', local: 'sk_l...9999', remote: null },
  { variable: 'DATABASE_URL', pinned: 'post...dev', local: 'post...prod', remote: 'post...prod' },
];

const saved = process.stdin.isTTY;
const withoutTty = <T>(body: () => T): T => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  return body();
};

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
});

describe('the conflict table with no terminal', () => {
  test('reports that it needs input rather than answering', async () => {
    const result = await withoutTty(() => new ResolveTable(ROWS, true, true, ['pinned', 'local']).run());
    expect(result.outcome).toBe('needs-input');
  });

  test('hands back NO choices, so a careless caller applies nothing', async () => {
    // This is the load-bearing half. Before, `choices` was fully populated
    // with the defaults, so `mapResolveChoicesToEnv` would happily write a
    // resolution from it whether or not anyone checked the flag.
    const result = await withoutTty(() =>
      new ResolveTable(ROWS, true, true, ['pinned', 'local']).run(),
    );
    expect(result.choices).toEqual({});
  });

  test('"needs input" is not "cancelled" — the caller must be able to tell them apart', async () => {
    // A cancel is a person deciding to stop, and the run ends quietly at 0.
    // No TTY is nobody having decided anything, and the run has to exit 3 so
    // an agent knows the next move is a browser or a human, not a retry.
    const result = await withoutTty(() => new ResolveTable(ROWS, false, false).run());
    expect(result.outcome).not.toBe('cancelled');
    expect(result.outcome).not.toBe('resolved');
  });

  test('an empty conflict set is still not an answer', async () => {
    // Zero rows off a TTY once produced `{choices: {}, cancelled: false}` —
    // indistinguishable from a completed resolution of nothing. It reads as
    // "needs input" now, and the caller refuses, which is harmless here and
    // keeps the outcome meaning one thing.
    const result = await withoutTty(() => new ResolveTable([], false, false).run());
    expect(result.outcome).toBe('needs-input');
  });

  test('the defaults the table would have applied are genuinely reachable', async () => {
    // Guards against this test passing for the wrong reason: if the defaults
    // were invalid for these rows the old code would have returned something
    // else and the regression would look fixed. `pinned` and `local` are both
    // available columns here.
    const defaults: ColumnKey[] = ['pinned', 'local'];
    const table = new ResolveTable(ROWS, true, true, defaults);
    expect((table as unknown as { selections: ColumnKey[] }).selections).toEqual(defaults);
  });
});
