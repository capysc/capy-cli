import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import {
  initialSecretsScreenState,
  handleKey,
  applyValueResult,
  resolveSecretValue,
  render,
  formatMiddleCell,
  filteredRows,
  filteredRowsWithReasons,
  formatUsersCell,
  formatBranchCell,
  formatProjectCell,
  formatConnectorCell,
  formatTargetCell,
  formatIntegrationsCell,
  formatUpdatedCell,
  mostRecentChangedAt,
  maskSecretValue,
  tokenizeKeys,
  SecretsScreenState,
  LocationDecryptResult,
} from '../../src/ui/secretsScreen';
import type { SecretIndexLocation, SecretIndexRow } from '../../src/service/serviceClient';
import { BEHIND_LABEL, DEPLOYED_LABEL, TARGET_STATUS_HEADING } from '../../src/core/deployStatus';

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

// Same teal the rest of the CLI's "← current" markers use (src/ui/colors.ts's
// `ACCENT`) — duplicated here rather than imported so this test file can
// assert on the exact byte sequence independently of the module under test.
const ACCENT = `${ESC}[38;5;43m`;
const ANSI_RESET = `${ESC}[0m`;

/** Strips ANSI escapes the same way `secretsScreen.ts`'s own (private) `stripAnsi` does, so width/column assertions measure visible columns, not escape bytes. */
function stripAnsiForTest(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Folds `handleKey` over a sequence of keypresses, keeping only the final state — a `reduce`-based stand-in for "press these keys in order" that never needs a reassigned binding. */
function pressKeys(state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState {
  return keys.reduce((acc: SecretsScreenState, k) => handleKey(acc, k).state, state);
}

/** Same as `pressKeys`, but for a string typed one character at a time (the way real keystrokes arrive). */
function type(state: SecretsScreenState, text: string): SecretsScreenState {
  return pressKeys(state, ...text.split(''));
}

/** Feeds a raw stdin chunk through the same tokenize-then-fold path the driver uses. */
function pressChunk(state: SecretsScreenState, chunk: string): SecretsScreenState {
  return pressKeys(state, ...tokenizeKeys(chunk));
}

describe('tokenizeKeys — splitting a raw stdin chunk into key tokens', () => {
  test('a multi-character chunk (paste / fast typing) becomes one token per character', () => {
    expect(tokenizeKeys('APIFY')).toEqual(['A', 'P', 'I', 'F', 'Y']);
  });

  test('a trailing \\r is its own token, in order', () => {
    expect(tokenizeKeys('STRIPE\r')).toEqual(['S', 'T', 'R', 'I', 'P', 'E', '\r']);
  });

  test('a CSI arrow sequence mixed with letters splits into one token for the arrow and one per letter', () => {
    expect(tokenizeKeys(`${ESC}[Bxy`)).toEqual([KEY_DOWN, 'x', 'y']);
  });

  test('a CSI sequence with numeric parameters (e.g. PgUp) is one token', () => {
    expect(tokenizeKeys(`${ESC}[5~`)).toEqual([`${ESC}[5~`]);
  });

  test('an SS3 sequence (ESC O <byte>) is one token', () => {
    expect(tokenizeKeys(`${ESC}OA`)).toEqual([`${ESC}OA`]);
  });

  test('a lone ESC at the end of a chunk is its own token', () => {
    expect(tokenizeKeys(ESC)).toEqual([ESC]);
  });

  test('a lone ESC followed by an ordinary character splits into two tokens', () => {
    expect(tokenizeKeys(`${ESC}q`)).toEqual([ESC, 'q']);
  });

  test('two consecutive ESC bytes (one physical Escape, double-emitted by some terminals) collapse to one token', () => {
    expect(tokenizeKeys(`${ESC}${ESC}`)).toEqual([`${ESC}${ESC}`]);
  });

  test('an incomplete CSI sequence at the chunk boundary is returned whole, not chopped into stray characters', () => {
    expect(tokenizeKeys(`${ESC}[`)).toEqual([`${ESC}[`]);
    expect(tokenizeKeys(`${ESC}[1`)).toEqual([`${ESC}[1`]);
  });

  test('a surrogate-pair character (emoji) is one token, not two broken halves', () => {
    const emoji = '🔒';
    expect(tokenizeKeys(emoji)).toEqual([emoji]);
    expect(tokenizeKeys(`ab${emoji}cd`)).toEqual(['a', 'b', emoji, 'c', 'd']);
  });

  test('an empty chunk tokenizes to nothing', () => {
    expect(tokenizeKeys('')).toEqual([]);
  });
});

describe('multi-key chunks reach the reducer in order (paste / fast-typing bug)', () => {
  const rows = [row({ name: 'STRIPE_SECRET_KEY' }), row({ name: 'DATABASE_URL' })];

  test('a whole word arriving in one chunk filters the list, not just its first character', () => {
    const s = pressChunk(initialSecretsScreenState(rows), 'STRIPE');
    expect(s.search.query).toBe('STRIPE');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['STRIPE_SECRET_KEY']);
  });

  test('a chunk with a trailing \\r types the filter AND opens the (now sole) matching row', () => {
    const s0 = initialSecretsScreenState(rows);
    const tokens = tokenizeKeys('STRIPE\r');
    const beforeEnter = pressKeys(s0, ...tokens.slice(0, -1));
    expect(filteredRows(beforeEnter).map((r) => r.name)).toEqual(['STRIPE_SECRET_KEY']);
    const { state: afterEnter, effect } = handleKey(beforeEnter, tokens[tokens.length - 1]);
    expect(afterEnter.popup?.rowName).toBe('STRIPE_SECRET_KEY');
    expect(effect).toEqual({ type: 'fetchValue', row: beforeEnter.rows.find((r) => r.name === 'STRIPE_SECRET_KEY') });
  });

  test('a chunk mixing an arrow escape with letters navigates AND types, in order', () => {
    const s = pressChunk(initialSecretsScreenState(rows), `${KEY_DOWN}url`);
    // Down moved the cursor to row 1 before "url" was typed into the query.
    expect(s.cursorIndex).toBe(0); // reclamped: "url" only matches DATABASE_URL, a single row
    expect(s.search.query).toBe('url');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['DATABASE_URL']);
  });

  test('a lone ESC arriving mid-chunk still clears an already-typed query', () => {
    const s = pressChunk(initialSecretsScreenState(rows), `db${ESC}`);
    expect(s.search.query).toBe('');
    expect(s.quit).toBe(false);
  });

  test('pasted multi-line text (raw \\n line breaks, no bracketed-paste markers) never opens a popup', () => {
    const s = pressChunk(initialSecretsScreenState(rows), 'foo\nbar\nbaz');
    expect(s.popup).toBeNull();
    // The `\n`s themselves are inert (not Enter, not typed) — only the
    // letters land in the query.
    expect(s.search.query).toBe('foobarbaz');
  });
});

describe('handleKey — column cycling (CAP-702: PROJECT first, STATUS added)', () => {
  test('PROJECT is the default (first-shown) column', () => {
    const s0 = initialSecretsScreenState([row()]);
    expect(s0.column).toBe('project');
  });

  test('Tab cycles PROJECT -> BRANCH -> STATUS -> CONNECTOR -> TARGET -> INTEGRATIONS -> USERS -> PROJECT (wrapping)', () => {
    const order = ['branch', 'status', 'connector', 'target', 'integrations', 'users', 'project'];
    const states = order.reduce<SecretsScreenState[]>(
      (acc) => [...acc, handleKey(acc[acc.length - 1], KEY_TAB).state],
      [initialSecretsScreenState([row()])],
    );
    expect(states.slice(1).map((st) => st.column)).toEqual(order as SecretsScreenState['column'][]);
  });

  test('Shift-Tab cycles backwards, wrapping the other way', () => {
    const order = ['users', 'integrations', 'target', 'connector', 'status', 'branch', 'project'];
    const states = order.reduce<SecretsScreenState[]>(
      (acc) => [...acc, handleKey(acc[acc.length - 1], KEY_SHIFT_TAB).state],
      [initialSecretsScreenState([row()])],
    );
    expect(states.slice(1).map((st) => st.column)).toEqual(order as SecretsScreenState['column'][]);
  });
});

describe('STATUS column (CAP-702)', () => {
  const stale = (target: string) => ({ provider: 'dokploy', target, stale: true });
  const current = (target: string) => ({ provider: 'dokploy', target, stale: false });
  const YELLOW = `${ESC}[33m`;
  const GREEN = `${ESC}[32m`;
  const DIM = `${ESC}[90m`;
  const cell = (r: SecretIndexRow) => formatMiddleCell(r, 'status', 30);

  test('a row with one target that lags reads the behind badge in yellow, like capy edit', () => {
    expect(cell(row({ locations: [loc({ targets: [stale('prod')] })] }))).toBe(`${YELLOW}● ${BEHIND_LABEL}${ANSI_RESET}`);
  });

  test('a multi-target row counts lagging targets across every location, same yellow badge', () => {
    const r = row({ locations: [loc({ targets: [stale('prod'), current('preview')] }), loc({ branch: 'staging', targets: [current('staging')] })] });
    expect(cell(r)).toBe(`${YELLOW}● ${BEHIND_LABEL} (1 of 3)${ANSI_RESET}`);
  });

  test('every target current reads "● deployed" in green', () => {
    expect(cell(row({ locations: [loc({ targets: [current('prod')] })] }))).toBe(`${GREEN}● ${DEPLOYED_LABEL}${ANSI_RESET}`);
  });

  test('a row with no Capy deploy target reads a grey "—", never deployed', () => {
    expect(cell(row({ locations: [loc({ targets: [] }), loc({ branch: 'staging', targets: [] })] }))).toBe(`${DIM}—${ANSI_RESET}`);
  });

  test('a server that sent no targets reads "● unknown", dim — it cannot be told', () => {
    expect(cell(row({ locations: [loc()] }))).toBe(`${DIM}● unknown${ANSI_RESET}`);
  });

  test('the STATUS header and cell render when the column is selected, padded by visible width', () => {
    const r = row({ name: 'ROW', locations: [loc({ targets: [stale('prod'), current('preview')] })] });
    const frame = render({ ...initialSecretsScreenState([r]), column: 'status' }, 100, 20);
    const stripped = stripAnsiForTest(frame);
    expect(stripped).toContain(`${TARGET_STATUS_HEADING} ⇥`);
    const line = stripped.split('\n').find((l) => l.includes('ROW'));
    expect(line).toContain(`● ${BEHIND_LABEL} (1 of 2)`);
    const header = stripped.split('\n').find((l) => l.includes(`${TARGET_STATUS_HEADING} ⇥`));
    // The UPDATED column starts at the same visible offset on the header and the row: colour codes don't shift it.
    expect(line!.indexOf('—', line!.indexOf('(1 of 2)'))).toBe(header!.indexOf('UPDATED'));
  });

  test('the highlighted row stays highlighted after its coloured STATUS badge', () => {
    const r = row({ name: 'ROW', locations: [loc({ targets: [stale('prod')] })] });
    const frame = render({ ...initialSecretsScreenState([r]), column: 'status' }, 100, 20);
    expect(frame).toContain(`${YELLOW}● ${BEHIND_LABEL}${ANSI_RESET}${ESC}[7m`);
  });

  test('the details view shows the row status badge, and a lagging target in yellow', () => {
    const r = row({ name: 'ROW', locations: [loc({ targets: [stale('prod')] })] });
    const frame = render(handleKey(initialSecretsScreenState([r]), ENTER).state, 100, 30);
    expect(stripAnsiForTest(frame)).toContain(`${TARGET_STATUS_HEADING.toLowerCase()}  `);
    expect(stripAnsiForTest(frame)).toContain(`● ${BEHIND_LABEL}`);
    expect(frame).toContain(`${YELLOW}● ${BEHIND_LABEL}${ANSI_RESET}`);
    expect(frame).toContain(`${YELLOW}(${BEHIND_LABEL})`);
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

  test('branch cell shows just the branch name (no project prefix — PROJECT is its own column), +N for distinct branch names', () => {
    expect(formatBranchCell(row({ locations: [loc({ project_name: 'web', branch: 'main' })] }))).toBe('main');
    expect(
      formatBranchCell(
        row({
          locations: [loc({ project_name: 'web', branch: 'main' }), loc({ project_name: 'api', branch: 'staging' })],
        }),
      ),
    ).toBe('main +1');
    // Same branch name at two different projects does not inflate the count.
    expect(
      formatBranchCell(
        row({
          locations: [loc({ project_name: 'web', branch: 'main' }), loc({ project_name: 'api', branch: 'main' })],
        }),
      ),
    ).toBe('main');
  });

  test('project cell shows the first location\'s project, +N for distinct projects', () => {
    expect(formatProjectCell(row({ locations: [loc({ project_name: 'web' })] }))).toBe('web');
    expect(
      formatProjectCell(
        row({
          locations: [loc({ project_name: 'web' }), loc({ project_name: 'api' })],
        }),
      ),
    ).toBe('web +1');
    // Same project at two different branches does not inflate the count.
    expect(
      formatProjectCell(
        row({
          locations: [loc({ project_name: 'web', branch: 'main' }), loc({ project_name: 'web', branch: 'staging' })],
        }),
      ),
    ).toBe('web');
  });

});

describe('CONNECTOR / TARGET / INTEGRATIONS cell formatting (CAP-679 — replaces the old SERVICE column)', () => {
  test('connector cell: "[provider] name", falling back to service.provider when the new `connector` field is absent (old-server payload)', () => {
    expect(
      formatConnectorCell(row({ locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'main' } })] })),
    ).toBe('[dokploy] main');
    // No `connector` field at all (CAP-676 predates this server) — falls back to service.provider.
    expect(formatConnectorCell(row({ locations: [loc({ service: { provider: 'dokploy', name: 'main' } })] }))).toBe('[dokploy] main');
  });

  test('connector cell: bare "[provider]" when there is a provider but no name', () => {
    expect(formatConnectorCell(row({ locations: [loc({ connector: { provider: 'aws' }, service: null })] }))).toBe('[aws]');
  });

  test('connector cell: "—" when there is no connector at all', () => {
    expect(formatConnectorCell(row({ locations: [loc({ service: null })] }))).toBe('—');
  });

  test('connector cell: +N for DISTINCT connector labels across locations (identical labels do not inflate it)', () => {
    expect(
      formatConnectorCell(
        row({
          locations: [
            loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'main' } }),
            loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'worker' } }),
          ],
        }),
      ),
    ).toBe('[dokploy] main +1');
    expect(
      formatConnectorCell(
        row({
          locations: [
            loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'main' } }),
            loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'main' } }),
          ],
        }),
      ),
    ).toBe('[dokploy] main'); // identical label at both locations — no +N
  });

  test('target cell: "[provider] target", with a trailing "*" when stale', () => {
    expect(formatTargetCell(row({ locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod', stale: false }] })] }))).toBe(
      '[aws-ecs] prod',
    );
    expect(formatTargetCell(row({ locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod', stale: true }] })] }))).toBe(
      '[aws-ecs] prod*',
    );
  });

  test('target cell: " (pending)" suffix when the target config was written by --no-deploy and never shipped', () => {
    expect(
      formatTargetCell(row({ locations: [loc({ targets: [{ provider: 'dokploy', target: 'backend-preview', stale: false, pending: true }] })] })),
    ).toBe('[dokploy] backend-preview (pending)');
    // Absent `pending` (or `false`) never shows the suffix — additive, old-server-safe.
    expect(
      formatTargetCell(row({ locations: [loc({ targets: [{ provider: 'dokploy', target: 'backend-preview', stale: false }] })] })),
    ).toBe('[dokploy] backend-preview');
  });

  test('target cell: stale and pending can both apply — "*" then " (pending)"', () => {
    expect(
      formatTargetCell(row({ locations: [loc({ targets: [{ provider: 'dokploy', target: 'backend-preview', stale: true, pending: true }] })] })),
    ).toBe('[dokploy] backend-preview* (pending)');
  });

  test('target cell: "—" when there are no targets anywhere — whether `targets` is absent (old-server payload) or explicitly `[]`', () => {
    expect(formatTargetCell(row({ locations: [loc()] }))).toBe('—'); // `targets` field entirely absent
    expect(formatTargetCell(row({ locations: [loc({ targets: [] })] }))).toBe('—');
  });

  test('target cell: +N for DISTINCT target labels, counted across every location (one location can itself carry more than one target)', () => {
    expect(
      formatTargetCell(
        row({
          locations: [
            loc({
              targets: [
                { provider: 'aws-ecs', target: 'prod', stale: false },
                { provider: 'aws-ecs', target: 'staging', stale: false },
              ],
            }),
          ],
        }),
      ),
    ).toBe('[aws-ecs] prod +1');
  });

  test('integrations cell: "in:<provider>" then "out:<provider>", distinct, space-separated, names left out', () => {
    expect(
      formatIntegrationsCell(
        row({
          locations: [
            loc({
              connector: { provider: 'dokploy' },
              service: { provider: 'dokploy', name: 'main' },
              targets: [{ provider: 'aws-ecs', target: 'prod', stale: false }],
            }),
          ],
        }),
      ),
    ).toBe('in:dokploy out:aws-ecs');
  });

  test('integrations cell: "—" when there is neither a connector nor any targets', () => {
    expect(formatIntegrationsCell(row({ locations: [loc({ service: null })] }))).toBe('—');
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

describe('search bar — project/branch/value matching (CAP-678)', () => {
  const webRow = row({
    name: 'STRIPE_KEY',
    value_hash: 'unrelated-hash',
    locations: [loc({ project_name: 'web-storefront', branch: 'production' })],
  });
  const apiRow = row({
    name: 'REDIS_URL',
    value_hash: 'also-unrelated',
    locations: [loc({ project_name: 'api-gateway', branch: 'staging-preview' })],
  });
  const rows = [webRow, apiRow];

  test('matches on a location\'s project_name, case-insensitively', () => {
    const s = type(initialSecretsScreenState(rows), 'STOREFRONT');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['STRIPE_KEY']);
  });

  test('"prod" matches a production branch', () => {
    const s = type(initialSecretsScreenState(rows), 'prod');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['STRIPE_KEY']);
  });

  test('name matching still works alongside the new signals', () => {
    const s = type(initialSecretsScreenState(rows), 'REDIS');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['REDIS_URL']);
  });

  test('an exact value match finds the row whose value_hash equals hashValue(query)', () => {
    const target = row({ name: 'DB_PASSWORD', value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc()] });
    const s = type(initialSecretsScreenState([...rows, target]), FAKE_LONG_VALUE);
    expect(filteredRows(s).map((r) => r.name)).toEqual(['DB_PASSWORD']);
  });

  test('a value pasted with surrounding whitespace still matches via the trimmed hash', () => {
    const target = row({ name: 'DB_PASSWORD', value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc()] });
    // Typed one character at a time, including leading/trailing spaces —
    // the same way a paste of "  value  " would arrive at the reducer.
    const s = type(initialSecretsScreenState([...rows, target]), `  ${FAKE_LONG_VALUE}  `);
    expect(filteredRows(s).map((r) => r.name)).toEqual(['DB_PASSWORD']);
  });

  test('a partial value never matches — value matching is exact only', () => {
    const target = row({ name: 'DB_PASSWORD', value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc()] });
    const s = type(initialSecretsScreenState([...rows, target]), FAKE_LONG_VALUE.slice(0, -1));
    expect(filteredRows(s).map((r) => r.name)).not.toContain('DB_PASSWORD');
  });

  test('match reasons are reported in priority order value > name > project > branch', () => {
    // A query that is simultaneously this row's exact value AND a substring
    // of its own name — value must still win as the reported reason.
    const trickyValue = 'API_KEY_LOOKALIKE';
    const target = row({ name: 'API_KEY_LOOKALIKE_SUFFIX', value_hash: hashOf(trickyValue), locations: [loc()] });
    const s = type(initialSecretsScreenState([target]), trickyValue);
    const [match] = filteredRowsWithReasons(s);
    expect(match.reasons[0]).toBe('value');
    expect(match.reasons).toContain('name');
  });

  test('no reasons are reported when the query is empty', () => {
    const matches = filteredRowsWithReasons(initialSecretsScreenState(rows));
    expect(matches.every((m) => m.reasons.length === 0)).toBe(true);
  });

  test('the match count in filteredRowsWithReasons matches filteredRows', () => {
    const s = type(initialSecretsScreenState(rows), 'a');
    expect(filteredRowsWithReasons(s).length).toBe(filteredRows(s).length);
  });

  test('render shows a match tag for the strongest reason, including a value match', () => {
    const target = row({ name: 'DB_PASSWORD', value_hash: hashOf(FAKE_LONG_VALUE), locations: [loc()] });
    const s = type(initialSecretsScreenState([target]), FAKE_LONG_VALUE);
    const frame = render(s, 100, 20);
    expect(frame).toContain('[value]');
  });

  test('render shows no match tags when the query is empty', () => {
    const frame = render(initialSecretsScreenState(rows), 100, 20);
    expect(frame).not.toContain('[name]');
    expect(frame).not.toContain('[project]');
    expect(frame).not.toContain('[branch]');
    expect(frame).not.toContain('[value]');
  });

  test('updated placeholder mentions name, project, branch, connector, target, and exact value', () => {
    const frame = render(initialSecretsScreenState(rows), 100, 20);
    expect(frame).toContain('name, project, branch, connector, target, or exact value');
  });

  test('the query lives only in state.search.query — nothing else in state echoes it', () => {
    const query = 'super-secret-query-text';
    const s = type(initialSecretsScreenState(rows), query);
    const { search, ...rest } = s;
    expect(JSON.stringify(rest)).not.toContain(query);
    expect(search.query).toBe(query);
  });

  test("matches on a location's inbound connector name (service.name), case-insensitively", () => {
    const target = row({
      name: 'BACKEND_SECRET',
      locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([...rows, target]), 'backend-preview');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['BACKEND_SECRET']);
  });

  test('a partial connector-name substring still matches (e.g. "preview" inside "backend-preview")', () => {
    const target = row({
      name: 'BACKEND_SECRET',
      locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([...rows, target]), 'preview');
    // `apiRow` (from the outer `rows`) also matches via its
    // "staging-preview" branch — the point here is just that the CONNECTOR
    // partial match fires too, not exclusivity.
    expect(filteredRows(s).map((r) => r.name)).toContain('BACKEND_SECRET');
  });

  test('matches on the connector provider even when it is not part of the connector name', () => {
    const target = row({
      name: 'BACKEND_SECRET',
      locations: [loc({ connector: { provider: 'aws-secrets' }, service: { provider: 'aws-secrets', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([...rows, target]), 'aws-secrets');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['BACKEND_SECRET']);
  });

  test('matches via the connector provider even on an old-server payload with no `connector` field (falls back to service.provider)', () => {
    const target = row({
      name: 'BACKEND_SECRET',
      locations: [loc({ service: { provider: 'aws-secrets', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([...rows, target]), 'aws-secrets');
    expect(filteredRows(s).map((r) => r.name)).toEqual(['BACKEND_SECRET']);
  });

  test('a location with no connector at all (null service, no connector field) is never matched via the connector signal', () => {
    const target = row({ name: 'NO_CONNECTOR_ROW', locations: [loc({ service: null })] });
    const s = type(initialSecretsScreenState([...rows, target]), 'backend-preview');
    expect(filteredRows(s).map((r) => r.name)).not.toContain('NO_CONNECTOR_ROW');
  });

  test("matches on a location's outbound target (provider or target name)", () => {
    const target = row({
      name: 'DEPLOYED_SECRET',
      locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod-cluster', stale: false }] })],
    });
    const s1 = type(initialSecretsScreenState([...rows, target]), 'prod-cluster');
    expect(filteredRows(s1).map((r) => r.name)).toEqual(['DEPLOYED_SECRET']);
    const s2 = type(initialSecretsScreenState([...rows, target]), 'aws-ecs');
    expect(filteredRows(s2).map((r) => r.name)).toEqual(['DEPLOYED_SECRET']);
  });

  test('a location with no targets at all (absent `targets` field, an old-server payload) is never matched via the target signal', () => {
    const target = row({ name: 'NO_TARGET_ROW', locations: [loc()] });
    const s = type(initialSecretsScreenState([...rows, target]), 'prod-cluster');
    expect(filteredRows(s).map((r) => r.name)).not.toContain('NO_TARGET_ROW');
  });

  test('match reasons prioritize value > name > project > branch > connector > target', () => {
    // A query that is simultaneously this row's connector name AND a
    // substring of its branch — connector must lose to branch here.
    const target = row({
      name: 'ROW',
      locations: [loc({ branch: 'staging-preview', connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'staging-preview' } })],
    });
    const s = type(initialSecretsScreenState([target]), 'staging-preview');
    const [match] = filteredRowsWithReasons(s);
    expect(match.reasons[0]).toBe('branch');
    expect(match.reasons).toContain('connector');
  });

  test('connector beats target when a query matches both', () => {
    const target = row({
      name: 'ROW',
      locations: [
        loc({
          connector: { provider: 'dokploy' },
          service: { provider: 'dokploy', name: 'shared-name' },
          targets: [{ provider: 'aws-ecs', target: 'shared-name', stale: false }],
        }),
      ],
    });
    const s = type(initialSecretsScreenState([target]), 'shared-name');
    const [match] = filteredRowsWithReasons(s);
    expect(match.reasons[0]).toBe('connector');
    expect(match.reasons).toContain('target');
  });

  test('a query that ONLY matches via the connector reports connector as the (only, strongest) reason', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([target]), 'backend-preview');
    const [match] = filteredRowsWithReasons(s);
    expect(match.reasons).toEqual(['connector']);
  });

  test('a query that ONLY matches via a target reports target as the (only) reason', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod-cluster', stale: false }] })],
    });
    const s = type(initialSecretsScreenState([target]), 'prod-cluster');
    const [match] = filteredRowsWithReasons(s);
    expect(match.reasons).toEqual(['target']);
  });

  test('render shows a [connector] match tag', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'backend-preview' } })],
    });
    const s = type(initialSecretsScreenState([target]), 'backend-preview');
    const frame = render(s, 100, 20);
    expect(frame).toContain('[connector]');
  });

  test('render shows a [target] match tag', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod-cluster', stale: false }] })],
    });
    const s = type(initialSecretsScreenState([target]), 'prod-cluster');
    const frame = render(s, 100, 20);
    expect(frame).toContain('[target]');
  });
});

describe('search styling — right-justified match tag, accent-colored query/tag (CAP-678 follow-up)', () => {
  /** Finds the rendered (ANSI-stripped) body line that carries a `[reason]` match tag. */
  function matchTagLine(frame: string): string {
    const stripped = stripAnsiForTest(frame);
    const line = stripped.split('\n').find((l) => /\[(value|name|project|branch)\]/.test(l));
    if (line === undefined) throw new Error('no line with a match tag found in frame');
    return line;
  }

  test("the tag's closing ']' sits exactly 2 visible columns before the next column starts", () => {
    const s = type(initialSecretsScreenState([row({ name: 'SHORT_NAME' })]), 'SHORT');
    const frame = render(s, 100, 20);
    const line = matchTagLine(frame);
    const closeIdx = line.indexOf(']');
    expect(line.slice(closeIdx + 1, closeIdx + 3)).toBe('  ');
    expect(line.charAt(closeIdx + 3)).not.toBe(' ');
  });

  test('a long name is truncated to make room, but the match tag is never cut off', () => {
    const longName = `PREFIX_${'X'.repeat(200)}`;
    const s = type(initialSecretsScreenState([row({ name: longName })]), 'PREFIX');
    const frame = render(s, 100, 20);
    const line = matchTagLine(frame);
    expect(line).toContain('…'); // the long name got truncated
    expect(line).toContain('[name]'); // the tag itself is intact, not truncated
  });

  test('typed query text is wrapped in the shared ACCENT color (teal, 38;5;43 — not a generic ANSI blue)', () => {
    const rows = [row({ name: 'API_KEY' })];
    const s = type(initialSecretsScreenState(rows), 'api');
    const frame = render(s, 100, 20);
    expect(frame).toContain(`${ACCENT}api${ANSI_RESET}`);
    expect(frame).not.toContain('\x1b[34m'); // not the old plain-blue constant
    expect(frame).not.toContain('\x1b[36m'); // not cyan either
  });

  test('the placeholder is NOT accent-colored — only real typed text is', () => {
    const rows = [row({ name: 'API_KEY' })];
    const frame = render(initialSecretsScreenState(rows), 100, 20);
    expect(frame).toContain('type to filter');
    expect(frame).not.toContain(ACCENT);
  });

  test('the match tag is wrapped in the shared ACCENT color', () => {
    const rows = [row({ name: 'API_KEY' })];
    const s = type(initialSecretsScreenState(rows), 'API');
    const frame = render(s, 100, 20);
    expect(frame).toContain(`${ACCENT}[name]${ANSI_RESET}`);
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

describe('CAP-679 rendering: "+N" survives truncation, INTEGRATIONS overflow, popup connector/target', () => {
  test('a long CONNECTOR label truncates but keeps its "+N" suffix intact, never cut', () => {
    const longName = 'X'.repeat(60);
    const target = row({
      name: 'ROW',
      locations: [
        loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: longName } }),
        loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'other' } }),
      ],
    });
    const frame = render({ ...initialSecretsScreenState([target]), column: 'connector' }, 100, 20);
    const stripped = stripAnsiForTest(frame);
    const line = stripped.split('\n').find((l) => l.includes('ROW'));
    expect(line).toBeDefined();
    expect(line).toContain('…'); // the label got truncated
    expect(line).toContain('… +1'); // and the "+1" survived, right after the ellipsis
    expect(line).not.toMatch(/\+\d[^\s]/); // "+1" is never itself sliced (e.g. into a bare "+")
  });

  test('a long TARGET label truncates but keeps its "+N" suffix intact', () => {
    const longTarget = 'Y'.repeat(60);
    const target = row({
      name: 'ROW',
      locations: [
        loc({
          targets: [
            { provider: 'aws-ecs', target: longTarget, stale: false },
            { provider: 'aws-ecs', target: 'other', stale: false },
          ],
        }),
      ],
    });
    const s: SecretsScreenState = { ...initialSecretsScreenState([target]), column: 'target' };
    const frame = render(s, 100, 20);
    const stripped = stripAnsiForTest(frame);
    const line = stripped.split('\n').find((l) => l.includes('ROW'));
    expect(line).toBeDefined();
    expect(line).toContain('… +1');
  });

  test('INTEGRATIONS overflow packs whole provider tags and reports how many were hidden, never slicing one in half', () => {
    const manyProvidersRow = row({
      name: 'ROW',
      locations: [
        loc({ connector: { provider: 'dokploy' } }),
        loc({ connector: { provider: 'aws-secrets' } }),
        loc({ connector: { provider: 'gcp-secrets' } }),
        loc({
          connector: { provider: 'azure-kv' },
          targets: [
            { provider: 'aws-ecs', target: 't1', stale: false },
            { provider: 'gcp-run', target: 't2', stale: false },
            { provider: 'lambda-fn', target: 't3', stale: false },
          ],
        }),
      ],
    });
    const s: SecretsScreenState = { ...initialSecretsScreenState([manyProvidersRow]), column: 'integrations' };
    const frame = render(s, 100, 20);
    const stripped = stripAnsiForTest(frame);
    const line = stripped.split('\n').find((l) => l.includes('ROW'));
    expect(line).toBeDefined();
    expect(line).toMatch(/ \+\d+(\s|$)/); // some "+N" is present, as its own trailing token
    expect(line).toContain('in:dokploy'); // the first (whole) tags are still shown
    expect(line).not.toContain('lambda-fn'); // and the tail got dropped, not sliced mid-word
  });

  test('INTEGRATIONS shows "—" when a row has neither a connector nor a target', () => {
    const target = row({ name: 'ROW', locations: [loc({ service: null })] });
    const s: SecretsScreenState = { ...initialSecretsScreenState([target]), column: 'integrations' };
    const frame = render(s, 100, 20);
    const stripped = stripAnsiForTest(frame);
    const line = stripped.split('\n').find((l) => l.includes('ROW'));
    expect(line).toContain('—');
  });

  test('the details popup shows the per-location connector as "[provider] name" (renamed from "service")', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ connector: { provider: 'dokploy' }, service: { provider: 'dokploy', name: 'backend-preview' } })],
    });
    const s1 = handleKey(initialSecretsScreenState([target]), ENTER).state;
    const frame = render(s1, 100, 30);
    expect(frame).toContain('[dokploy] backend-preview');
  });

  test('the details popup spells out a stale target with the behind label (CAP-702)', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod-cluster', stale: true }] })],
    });
    const s1 = handleKey(initialSecretsScreenState([target]), ENTER).state;
    const frame = render(s1, 100, 30);
    expect(stripAnsiForTest(frame)).toContain(`targets: [aws-ecs] prod-cluster (${BEHIND_LABEL})`);
  });

  test('the details popup spells out a pending target with "(pending)"', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ targets: [{ provider: 'dokploy', target: 'backend-preview', stale: false, pending: true }] })],
    });
    const s1 = handleKey(initialSecretsScreenState([target]), ENTER).state;
    const frame = render(s1, 100, 30);
    expect(frame).toContain('targets: [dokploy] backend-preview (pending)');
  });

  test('the details popup lists a non-stale target with no behind marker', () => {
    const target = row({
      name: 'ROW',
      locations: [loc({ targets: [{ provider: 'aws-ecs', target: 'prod-cluster', stale: false }] })],
    });
    const s1 = handleKey(initialSecretsScreenState([target]), ENTER).state;
    const frame = render(s1, 100, 30);
    expect(frame).toContain('targets: [aws-ecs] prod-cluster');
    expect(frame).not.toContain(`(${BEHIND_LABEL})`);
  });

  test('the details popup shows nothing target-related for a location with no targets', () => {
    const target = row({ name: 'ROW', locations: [loc()] });
    const s1 = handleKey(initialSecretsScreenState([target]), ENTER).state;
    const frame = render(s1, 100, 30);
    expect(frame).not.toContain('targets:');
  });
});
