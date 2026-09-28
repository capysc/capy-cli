import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import {
  initialSecretsScreenState,
  handleKey,
  applyValueResult,
  resolveSecretValue,
  render,
  filteredRows,
  formatUsersCell,
  formatBranchCell,
  formatServiceCell,
  formatUpdatedCell,
  mostRecentChangedAt,
  maskSecretValue,
  SecretsScreenState,
  LocationDecryptResult,
} from '../../src/ui/secretsScreen';
import type { SecretIndexLocation, SecretIndexRow } from '../../src/service/serviceClient';

// A very long, obviously-fake secret used everywhere a "real" value is
// needed — never a plausible credential, never logged.
const FAKE_LONG_VALUE = 'zzzz-fake-test-value-not-real-1234567890-zzzz';
const FAKE_SHORT_VALUE = 'sh0rt';

const NOW = new Date('2026-06-15T12:00:00.000Z');

// Same hash the real app computes (sha256().slice(0,16)) — duplicated here so
// fixtures can carry a `value_hash` that actually matches a fake plaintext,
// without this test file importing a command module just for that.
function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function loc(over: Partial<SecretIndexLocation> = {}): SecretIndexLocation {
  return {
    project_id: 'p1',
    project_name: 'web',
    branch: 'production',
    protected: false,
    service: null,
    ...over,
  };
}

function row(over: Partial<SecretIndexRow> = {}): SecretIndexRow {
  return {
    name: 'API_KEY',
    value_hash: 'hash1',
    locations: [loc()],
    users: [{ user_id: 'u1', email: 'a@example.com' }],
    ...over,
  };
}

const ESC = '\x1b';
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_TAB = '\t';
const KEY_SHIFT_TAB = `${ESC}[Z`;
const ENTER = '\r';

/** Folds `handleKey` over a sequence of keypresses, keeping only the final state — a `reduce`-based stand-in for "press these keys in order" that never needs a reassigned binding. */
function pressKeys(state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState {
  return keys.reduce((acc: SecretsScreenState, k) => handleKey(acc, k).state, state);
}

/** Same as `pressKeys`, but for a string typed one character at a time (the way real keystrokes arrive). */
function type(state: SecretsScreenState, text: string): SecretsScreenState {
  return pressKeys(state, ...text.split(''));
}

describe('handleKey — column cycling', () => {
  test('Tab cycles USERS -> BRANCH -> SERVICE -> USERS', () => {
    const s0 = initialSecretsScreenState([row()]);
    expect(s0.column).toBe('users');
    const s1 = handleKey(s0, KEY_TAB).state;
    expect(s1.column).toBe('branch');
    const s2 = handleKey(s1, KEY_TAB).state;
    expect(s2.column).toBe('service');
    const s3 = handleKey(s2, KEY_TAB).state;
    expect(s3.column).toBe('users');
  });

  test('Shift-Tab cycles backwards', () => {
    const s0 = initialSecretsScreenState([row()]);
    const s1 = handleKey(s0, KEY_SHIFT_TAB).state;
    expect(s1.column).toBe('service');
    const s2 = handleKey(s1, KEY_SHIFT_TAB).state;
    expect(s2.column).toBe('branch');
  });
});

describe('column cell formatting', () => {
  test('users cell is compact singular/plural', () => {
    expect(formatUsersCell(row({ users: [{ user_id: 'u1', email: 'a@example.com' }] }))).toBe('1 user');
    expect(
      formatUsersCell(
        row({
          users: [
            { user_id: 'u1', email: 'a@example.com' },
            { user_id: 'u2', email: 'b@example.com' },
          ],
        }),
      ),
    ).toBe('2 users');
  });

  test('branch cell shows project · branch, +N when more locations', () => {
    expect(formatBranchCell(row({ locations: [loc({ project_name: 'web', branch: 'main' })] }))).toBe('web · main');
    expect(
      formatBranchCell(
        row({
          locations: [loc({ project_name: 'web', branch: 'main' }), loc({ project_name: 'api', branch: 'staging' })],
        }),
      ),
    ).toBe('web · main +1');
  });

  test('service cell reuses the dokploy_project/name fallback chain, +N when distinct', () => {
    expect(
      formatServiceCell(row({ locations: [loc({ service: { provider: 'dokploy', name: 'main', dokploy_project: 'slidespeak' } })] })),
    ).toBe('slidespeak / main');
    expect(formatServiceCell(row({ locations: [loc({ service: null })] }))).toBe('—');
    expect(
      formatServiceCell(
        row({
          locations: [
            loc({ service: { provider: 'dokploy', name: 'main', dokploy_project: 'slidespeak' } }),
            loc({ service: { provider: 'dokploy', name: 'worker', dokploy_project: 'slidespeak' } }),
          ],
        }),
      ),
    ).toBe('slidespeak / main +1');
    // Same service repeated across locations does not inflate the count.
    expect(
      formatServiceCell(
        row({
          locations: [
            loc({ service: { provider: 'dokploy', name: 'main', dokploy_project: 'slidespeak' } }),
            loc({ service: { provider: 'dokploy', name: 'main', dokploy_project: 'slidespeak' } }),
          ],
        }),
      ),
    ).toBe('slidespeak / main'); // identical service label at both locations — no +N
  });
});

describe('UPDATED computation', () => {
  test('most recent changed_at across locations wins', () => {
    const r = row({
      locations: [
        loc({ changed_at: '2026-06-01T00:00:00.000Z' }),
        loc({ changed_at: '2026-06-10T00:00:00.000Z' }),
        loc({ changed_at: '2026-06-05T00:00:00.000Z' }),
      ],
    });
    expect(mostRecentChangedAt(r)).toBe('2026-06-10T00:00:00.000Z');
  });

  test('no changed_at anywhere renders as em dash', () => {
    expect(formatUpdatedCell(row({ locations: [loc()] }), NOW)).toBe('—');
  });

  test('formats the winning timestamp relative to now', () => {
    const r = row({ locations: [loc({ changed_at: '2026-06-15T11:55:00.000Z' })] });
    expect(formatUpdatedCell(r, NOW)).toBe('5 minutes ago');
  });
});

describe('search bar — always-on, fzf-style (no "/" mode)', () => {
  const rows = [row({ name: 'API_KEY' }), row({ name: 'DB_PASSWORD' }), row({ name: 'api_secondary' })];

  test('typed characters filter by NAME, case-insensitively, live — no "/" needed to start', () => {
    const s = type(initialSecretsScreenState(rows), 'api');
    expect(s.search.query).toBe('api');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['API_KEY', 'api_secondary']);
  });

  test('backspace edits the query', () => {
    const s = pressKeys(type(initialSecretsScreenState(rows), 'xx'), '\x7f');
    expect(s.search.query).toBe('x');
  });

  test('"q" and "j" are just query text in the list view, not quit/navigate', () => {
    const s = type(initialSecretsScreenState(rows), 'qj');
    expect(s.search.query).toBe('qj');
    expect(s.quit).toBe(false);
    expect(s.cursorIndex).toBe(0); // 'j' did not move the cursor
  });

  test('Esc clears a non-empty query without quitting', () => {
    const s = pressKeys(type(initialSecretsScreenState(rows), 'db'), ESC);
    expect(s.search.query).toBe('');
    expect(s.quit).toBe(false);
    expect(filteredRows(s)).toEqual(rows);
  });

  test('Esc with an already-empty query quits', () => {
    const s = handleKey(initialSecretsScreenState(rows), ESC).state;
    expect(s.search.query).toBe('');
    expect(s.quit).toBe(true);
  });

  test('pressing Esc twice clears then quits', () => {
    const afterFirstEsc = pressKeys(type(initialSecretsScreenState(rows), 'db'), ESC);
    expect(afterFirstEsc.quit).toBe(false);
    const afterSecondEsc = handleKey(afterFirstEsc, ESC).state;
    expect(afterSecondEsc.quit).toBe(true);
  });

  test('cursor reclamps when the filter shrinks the list, but is left alone otherwise', () => {
    const s0 = pressKeys(initialSecretsScreenState(rows), KEY_DOWN, KEY_DOWN); // cursor at index 2 (api_secondary)
    expect(s0.cursorIndex).toBe(2);
    const s1 = type(s0, 'DB'); // only 1 row matches now — cursor must come back into range
    expect(filteredRows(s1)).toHaveLength(1);
    expect(s1.cursorIndex).toBe(0);
  });
});

describe('navigation bounds', () => {
  const rows = [row({ name: 'A' }), row({ name: 'B' }), row({ name: 'C' })];

  test('up/down clamp at the ends, never go negative or past the last row', () => {
    const afterUpAtTop = handleKey(initialSecretsScreenState(rows), KEY_UP).state;
    expect(afterUpAtTop.cursorIndex).toBe(0);
    const afterFourDowns = pressKeys(initialSecretsScreenState(rows), KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN);
    expect(afterFourDowns.cursorIndex).toBe(2);
  });

  test('an empty row set never lets the cursor go out of range', () => {
    const s = handleKey(initialSecretsScreenState([]), KEY_DOWN).state;
    expect(s.cursorIndex).toBe(0);
  });
});

describe('render scroll viewport', () => {
  test('a short terminal only shows a window of rows, following the cursor', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ name: `VAR_${i}` }));
    const s0 = initialSecretsScreenState(rows);
    const out0 = render(s0, 100, 15);
    expect(out0).toContain('VAR_0');
    expect(out0).not.toContain('VAR_29');

    const s1 = pressKeys(s0, ...Array.from({ length: 25 }, () => KEY_DOWN));
    const out1 = render(s1, 100, 15);
    expect(out1).toContain('VAR_25');
    expect(out1).not.toContain('VAR_0');
  });
});

describe('details popup open/close', () => {
  test('Enter opens a popup for the selected row and fires a fetchValue effect', () => {
    const s0 = initialSecretsScreenState([row({ name: 'API_KEY' })]);
    const { state: s1, effect } = handleKey(s0, ENTER);
    expect(s1.popup).not.toBeNull();
    expect(s1.popup?.rowName).toBe('API_KEY');
    expect(s1.popup?.value).toEqual({ status: 'loading' });
    expect(effect).toEqual({ type: 'fetchValue', row: s0.rows[0] });
  });

  test('Esc closes the popup', () => {
    const s0 = initialSecretsScreenState([row()]);
    const s1 = pressKeys(s0, ENTER, ESC);
    expect(s1.popup).toBeNull();
  });

  test('"q" also closes the popup (unlike the list view, where it is just text)', () => {
    const s0 = initialSecretsScreenState([row()]);
    const s1 = pressKeys(s0, ENTER, 'q');
    expect(s1.popup).toBeNull();
    expect(s1.quit).toBe(false); // closes the popup, does not quit the app
  });

  test('reveal toggle clears (along with the plaintext) on close', () => {
    const s0 = initialSecretsScreenState([row()]);
    const afterOpen = handleKey(s0, ENTER).state;
    const afterValue = applyValueResult(afterOpen, s0.rows[0], { status: 'ok', value: FAKE_LONG_VALUE });
    const afterReveal = handleKey(afterValue, 'r').state;
    expect(afterReveal.popup?.revealed).toBe(true);
    expect(afterReveal.popup?.value).toEqual({ status: 'ok', value: FAKE_LONG_VALUE });

    const afterClose = handleKey(afterReveal, ESC).state;
    expect(afterClose.popup).toBeNull(); // revealed flag AND plaintext are gone with it

    // Reopening starts fresh: not revealed, value re-requested from scratch.
    const { state: reopened, effect } = handleKey(afterClose, ENTER);
    expect(reopened.popup?.revealed).toBe(false);
    expect(reopened.popup?.value).toEqual({ status: 'loading' });
    expect(effect).not.toBeNull();
  });

  test('applyValueResult drops a stale result for a row the popup has moved past', () => {
    const rows = [row({ name: 'FIRST', value_hash: 'h1' }), row({ name: 'SECOND', value_hash: 'h2' })];
    const s = pressKeys(initialSecretsScreenState(rows), ENTER, ESC, KEY_DOWN, ENTER); // open FIRST, close, move down, open SECOND

    // A late result for FIRST must not land in SECOND's popup.
    const afterStale = applyValueResult(s, rows[0], { status: 'ok', value: FAKE_LONG_VALUE });
    expect(afterStale.popup?.rowName).toBe('SECOND');
    expect(afterStale.popup?.value).toEqual({ status: 'loading' });
  });
});

describe('masking rules', () => {
  test('values of 8 chars or fewer are fully masked, regardless of content', () => {
    expect(maskSecretValue('')).toBe('(empty)');
    expect(maskSecretValue('a')).not.toContain('a');
    expect(maskSecretValue(FAKE_SHORT_VALUE)).not.toContain(FAKE_SHORT_VALUE);
    expect(maskSecretValue('12345678')).not.toMatch(/12345678/);
  });

  test('longer values show at most 4 characters, never more than a third', () => {
    const masked = maskSecretValue(FAKE_LONG_VALUE);
    const shown = masked.replace('...', '').length;
    expect(shown).toBeLessThanOrEqual(4);
    expect(shown).toBeLessThanOrEqual(Math.floor(FAKE_LONG_VALUE.length / 3));
    expect(masked).not.toContain(FAKE_LONG_VALUE);
  });
});

describe('resolveSecretValue — location fallback and hash verification', () => {
  test('a refused first location falls through to a working second one', async () => {
    const r = row({ value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc({ branch: 'protected-branch' }), loc({ branch: 'main' })] });
    const calls: string[] = [];
    const decryptAt = async (location: SecretIndexLocation): Promise<LocationDecryptResult> => {
      calls.push(location.branch);
      if (location.branch === 'protected-branch') return { ok: false, code: 'PERMISSION_DENIED' };
      return { ok: true, plaintext: FAKE_LONG_VALUE };
    };
    const result = await resolveSecretValue(r, decryptAt);
    expect(calls).toEqual(['protected-branch', 'main']);
    expect(result).toEqual({ status: 'ok', value: FAKE_LONG_VALUE });
  });

  test('a hash mismatch is treated as unusable and the next location is tried', async () => {
    const wrongValue = 'not-the-real-value-zzz';
    const r = row({ value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc({ branch: 'a' }), loc({ branch: 'b' })] });
    const calls: string[] = [];
    const decryptAt = async (location: SecretIndexLocation): Promise<LocationDecryptResult> => {
      calls.push(location.branch);
      if (location.branch === 'a') return { ok: true, plaintext: wrongValue };
      return { ok: true, plaintext: FAKE_LONG_VALUE };
    };
    const result = await resolveSecretValue(r, decryptAt);
    expect(calls).toEqual(['a', 'b']);
    expect(result).toEqual({ status: 'ok', value: FAKE_LONG_VALUE });
  });

  test('when every location is refused or mismatched, the value is unavailable with a coded reason — never a fake value', async () => {
    const r = row({ value_hash: hashOf('a-value-that-will-never-be-produced'), locations: [loc({ branch: 'a' }), loc({ branch: 'b' })] });
    const decryptAt = async (location: SecretIndexLocation): Promise<LocationDecryptResult> => {
      if (location.branch === 'a') return { ok: false, code: 'PERMISSION_DENIED' };
      return { ok: true, plaintext: 'some-other-value' }; // will mismatch the hash
    };
    const result = await resolveSecretValue(r, decryptAt);
    expect(result.status).toBe('unavailable');
    expect((result as { code: string }).code).toBe('HASH_MISMATCH');
  });

  test('a row with no locations at all is unavailable, not a thrown error', async () => {
    const r = row({ locations: [] });
    const result = await resolveSecretValue(r, async () => ({ ok: false, code: 'UNREACHABLE' }));
    expect(result).toEqual({ status: 'unavailable', code: 'NO_LOCATIONS' });
  });
});

describe('render never leaks plaintext', () => {
  test('a revealed=false popup never contains the real value anywhere in the frame', () => {
    const s0 = initialSecretsScreenState([row({ name: 'API_KEY' })]);
    const s1 = handleKey(s0, ENTER).state;
    const s2 = applyValueResult(s1, { name: 'API_KEY', value_hash: 'hash1' }, { status: 'ok', value: FAKE_LONG_VALUE });
    const frame = render(s2, 100, 30);
    expect(frame).not.toContain(FAKE_LONG_VALUE);
  });

  test('a revealed=true popup does show the (collapsed) value', () => {
    const s0 = initialSecretsScreenState([row({ name: 'API_KEY' })]);
    const s1 = handleKey(s0, ENTER).state;
    const s2 = applyValueResult(s1, { name: 'API_KEY', value_hash: 'hash1' }, { status: 'ok', value: FAKE_LONG_VALUE });
    const s3 = handleKey(s2, 'r').state;
    const frame = render(s3, 100, 30);
    expect(frame).toContain(FAKE_LONG_VALUE);
  });

  test('an unavailable value never renders a placeholder that looks like real data', () => {
    const s0 = initialSecretsScreenState([row({ name: 'API_KEY' })]);
    const s1 = handleKey(s0, ENTER).state;
    const s2 = applyValueResult(s1, { name: 'API_KEY', value_hash: 'hash1' }, { status: 'unavailable', code: 'PERMISSION_DENIED' });
    const frame = render(s2, 100, 30);
    expect(frame).toContain('unavailable');
    expect(frame).toContain('PERMISSION_DENIED');
  });
});

describe('render — search bar', () => {
  test('shows a placeholder and the full match count when the query is empty', () => {
    const rows = [row({ name: 'A' }), row({ name: 'B' })];
    const frame = render(initialSecretsScreenState(rows), 100, 20);
    expect(frame).toContain('type to filter');
    expect(frame).toContain('2/2');
  });

  test('shows the typed query and a narrowed match count', () => {
    const rows = [row({ name: 'API_KEY' }), row({ name: 'DB_PASSWORD' })];
    const s = type(initialSecretsScreenState(rows), 'api');
    const frame = render(s, 100, 20);
    expect(frame).toContain('api');
    expect(frame).toContain('1/2');
  });
});
