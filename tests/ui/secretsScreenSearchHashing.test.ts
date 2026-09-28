/**
 * CAP-678: the search bar's exact-value match hashes the QUERY (via
 * `hashValue`, the same helper `resolveSecretValue` uses), and it must do so
 * once per filter pass — not once per row. Hashing per row would turn every
 * keystroke into O(rows) sha256 calls, which is both wasteful and pointless
 * (the query doesn't change across rows within one pass).
 *
 * `computeFilteredRows` (private to secretsScreen.ts) hoists the hash(es)
 * out of its per-row `.map` on purpose. This file pins that: it replaces
 * `hashValue` with a call-counting wrapper and asserts the count tracks
 * KEYSTROKES, not ROWS.
 *
 * Its own file because `mock.module` is process-wide in bun — see
 * `tests/ui/deployDeadline.test.ts` for the same pattern — so
 * `tests/run-tests.sh` runs this one in isolation too.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createHash } from 'crypto';
import type { SecretIndexRow } from '../../src/service/serviceClient';

const realHashValue = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

// `mock()` is bun's own call-tracking wrapper (jest.fn()-equivalent) — the
// call history lives inside ITS object, not in a `let`/mutable binding this
// file declares, so counting calls never needs this file to mutate anything
// of its own.
const hashValueSpy = mock(realHashValue);

// `secretsScreen.ts` pulls in `editScreen.ts` (for `renderInlineValue`), which
// also imports `formatSnippet` from this same module — `mock.module` replaces
// the WHOLE module, so that binding needs to keep resolving too, even though
// this file never exercises it. Copied verbatim from the real
// `formatSnippet`; nothing here depends on it doing anything in particular.
function formatSnippetStub(value: string): string {
  if (!value) return '-';
  if (value.length <= 6) return value;
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

mock.module('../../src/commands/statusCommand', () => ({
  hashValue: hashValueSpy,
  formatSnippet: formatSnippetStub,
}));

const { initialSecretsScreenState, handleKey, filteredRows, tokenizeKeys } = await import('../../src/ui/secretsScreen');

function makeRow(index: number): SecretIndexRow {
  return {
    name: `SECRET_${index}`,
    value_hash: `hash-${index}`,
    locations: [{ project_id: 'p', project_name: 'proj', branch: 'main', protected: false, service: null }],
    users: [],
  };
}

/** Types `text` one keystroke at a time, same as a real user typing into the search bar. */
function typeInto(state: ReturnType<typeof initialSecretsScreenState>, text: string): ReturnType<typeof initialSecretsScreenState> {
  return tokenizeKeys(text).reduce((acc, key) => handleKey(acc, key).state, state);
}

describe('search hashing — once per filter pass, not once per row (CAP-678)', () => {
  test('typing the same query costs the SAME number of hashValue calls whether there are 2 rows or 500', () => {
    const smallState = initialSecretsScreenState(Array.from({ length: 2 }, (_, i) => makeRow(i)));
    const largeState = initialSecretsScreenState(Array.from({ length: 500 }, (_, i) => makeRow(i)));

    hashValueSpy.mockClear();
    typeInto(smallState, 'api');
    const callsForSmall = hashValueSpy.mock.calls.length;

    hashValueSpy.mockClear();
    typeInto(largeState, 'api');
    const callsForLarge = hashValueSpy.mock.calls.length;

    // If a hash were computed per row, 500 rows would cost ~250x what 2 rows
    // cost. Instead the count depends only on the 3 keystrokes typed, so it
    // must come out identical either way.
    expect(callsForLarge).toBe(callsForSmall);
    // And it's a small, keystroke-scaled number — nowhere near row count.
    expect(callsForLarge).toBeLessThan(20);
  });

  test('the count scales with keystrokes typed, not with rows scanned', () => {
    const rows = Array.from({ length: 300 }, (_, i) => makeRow(i));

    hashValueSpy.mockClear();
    typeInto(initialSecretsScreenState(rows), 'a');
    const callsForOneKeystroke = hashValueSpy.mock.calls.length;

    hashValueSpy.mockClear();
    typeInto(initialSecretsScreenState(rows), 'ab');
    const callsForTwoKeystrokes = hashValueSpy.mock.calls.length;

    expect(callsForTwoKeystrokes).toBeGreaterThan(callsForOneKeystroke);
    // Still nowhere near the 300-row scale either count would hit if hashing
    // happened inside the per-row scan.
    expect(callsForTwoKeystrokes).toBeLessThan(20);
  });

  test('sanity: the filter still runs correctly under the mocked hashValue', () => {
    const target = makeRow(0);
    const state = initialSecretsScreenState([target, makeRow(1)]);
    const afterTyping = typeInto(state, target.name);
    expect(filteredRows(afterTyping).map((r) => r.name)).toEqual([target.name]);
  });
});
