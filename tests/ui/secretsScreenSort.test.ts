import { describe, test, expect } from 'bun:test';
import {
  initialSecretsScreenState,
  handleKey,
  render,
  filteredRows,
  nextSort,
  sortRows,
  SORT_ORDER,
  SecretsScreenState,
  SortMode,
} from '../../src/ui/secretsScreen';
import type { SecretIndexLocation, SecretIndexRow } from '../../src/service/serviceClient';

const ESC = '\x1b';
const CTRL_S = '\x13';
const ENTER = '\r';
const KEY_DOWN = `${ESC}[B`;
const KEY_TAB = '\t';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mK]/g, '');
}

function loc(over: Partial<SecretIndexLocation> = {}): SecretIndexLocation {
  return { project_id: 'p1', project_name: 'web', branch: 'production', protected: false, service: null, ...over };
}

function row(over: Partial<SecretIndexRow> = {}): SecretIndexRow {
  return { name: 'API_KEY', value_hash: 'hash1', locations: [loc()], users: [], ...over };
}

const target = (stale: boolean) => ({ provider: 'dokploy', target: 'app', stale });
/** A row whose deploy status kind is `deployed`, `behind`, `unknown` (targets not sent) or `no target`. */
function withStatus(name: string, kind: 'deployed' | 'behind' | 'unknown' | 'no target', over: Partial<SecretIndexRow> = {}): SecretIndexRow {
  const location =
    kind === 'deployed' ? loc({ targets: [target(false)] }) : kind === 'behind' ? loc({ targets: [target(true)] }) : kind === 'no target' ? loc({ targets: [] }) : loc();
  return row({ name, value_hash: `h-${name}`, locations: [location], ...over });
}
function withTime(name: string, changedAt: string | undefined): SecretIndexRow {
  return row({ name, value_hash: `h-${name}`, locations: [loc(changedAt === undefined ? {} : { changed_at: changedAt })] });
}

const press = (state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState =>
  keys.reduce((acc: SecretsScreenState, k) => handleKey(acc, k).state, state);
const typed = (state: SecretsScreenState, text: string): SecretsScreenState => press(state, ...text.split(''));
const withSort = (rows: readonly SecretIndexRow[], sort: SortMode): SecretsScreenState => ({ ...initialSecretsScreenState(rows), sort });
const names = (state: SecretsScreenState): readonly string[] => filteredRows(state).map((r) => r.name);
const cursorName = (state: SecretsScreenState): string | undefined => filteredRows(state)[state.cursorIndex]?.name;

describe('nextSort', () => {
  test('walks the six sorts in order and wraps back to name A-Z', () => {
    expect(SORT_ORDER).toEqual(['name-asc', 'name-desc', 'status-asc', 'status-desc', 'updated-newest', 'updated-oldest']);
    expect(SORT_ORDER.map(nextSort)).toEqual(['name-desc', 'status-asc', 'status-desc', 'updated-newest', 'updated-oldest', 'name-asc']);
  });

  test('the screen starts on name A-Z', () => {
    expect(initialSecretsScreenState([]).sort).toBe('name-asc');
  });
});

describe('Ctrl+S cycles the list sort', () => {
  const rows = [row({ name: 'B', value_hash: 'b' }), row({ name: 'C', value_hash: 'c' }), row({ name: 'A', value_hash: 'a' })];

  test('six presses visit each sort and come back to name A-Z', () => {
    const visited = Array.from({ length: 6 }).reduce<{ readonly state: SecretsScreenState; readonly seen: readonly SortMode[] }>(
      (acc) => {
        const state = press(acc.state, CTRL_S);
        return { state, seen: [...acc.seen, state.sort] };
      },
      { state: initialSecretsScreenState(rows), seen: [] },
    );
    expect(visited.seen).toEqual(['name-desc', 'status-asc', 'status-desc', 'updated-newest', 'updated-oldest', 'name-asc']);
  });

  test('name A-Z then name Z-A order the rows', () => {
    expect(names(initialSecretsScreenState(rows))).toEqual(['A', 'B', 'C']);
    expect(names(press(initialSecretsScreenState(rows), CTRL_S))).toEqual(['C', 'B', 'A']);
  });

  test('Tab and Shift+Tab still cycle columns and leave the sort alone', () => {
    const s = press(initialSecretsScreenState(rows), CTRL_S, KEY_TAB);
    expect(s.column).toBe('branch');
    expect(s.sort).toBe('name-desc');
    expect(press(s, `${ESC}[Z`).column).toBe('project');
  });

  test('Ctrl+S is not typed into the search bar', () => {
    expect(press(initialSecretsScreenState(rows), CTRL_S).search.query).toBe('');
  });
});

describe('name sorts', () => {
  test('are case-insensitive: lower and upper case interleave', () => {
    const rows = [row({ name: 'beta', value_hash: '1' }), row({ name: 'Alpha', value_hash: '2' }), row({ name: 'ALPHA2', value_hash: '3' }), row({ name: 'Zed', value_hash: '4' })];
    expect(sortRows(rows, 'name-asc').map((r) => r.name)).toEqual(['Alpha', 'ALPHA2', 'beta', 'Zed']);
    expect(sortRows(rows, 'name-desc').map((r) => r.name)).toEqual(['Zed', 'beta', 'ALPHA2', 'Alpha']);
  });

  test('names that differ only by case tie, and the value hash decides', () => {
    const rows = [row({ name: 'key', value_hash: 'bbb' }), row({ name: 'KEY', value_hash: 'aaa' })];
    expect(sortRows(rows, 'name-asc').map((r) => r.value_hash)).toEqual(['aaa', 'bbb']);
    expect(sortRows(rows.toReversed(), 'name-asc').map((r) => r.value_hash)).toEqual(['aaa', 'bbb']);
  });

  test('the same name with two values keeps a stable order whatever order they arrive in', () => {
    const rows = [row({ name: 'DB', value_hash: 'z' }), row({ name: 'DB', value_hash: 'a' })];
    expect(sortRows(rows, 'name-asc').map((r) => r.value_hash)).toEqual(['a', 'z']);
    expect(sortRows(rows.toReversed(), 'name-asc').map((r) => r.value_hash)).toEqual(['a', 'z']);
  });

  test('sorting never changes the input array', () => {
    const rows = [row({ name: 'B' }), row({ name: 'A' })];
    sortRows(rows, 'name-asc');
    expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
  });
});

describe('deploy status sorts (by the status kind, not the displayed words)', () => {
  const rows = [
    withStatus('E_NONE', 'no target'),
    withStatus('D_UNKNOWN', 'unknown'),
    withStatus('C_BEHIND', 'behind'),
    withStatus('B_DEPLOYED', 'deployed'),
  ];

  test('A-Z: deployed, behind, unknown, no target', () => {
    expect(names(withSort(rows, 'status-asc'))).toEqual(['B_DEPLOYED', 'C_BEHIND', 'D_UNKNOWN', 'E_NONE']);
  });

  test('Z-A is the reverse: no target, unknown, behind, deployed', () => {
    expect(names(withSort(rows, 'status-desc'))).toEqual(['E_NONE', 'D_UNKNOWN', 'C_BEHIND', 'B_DEPLOYED']);
  });

  test('rows of the same status break the tie by name A-Z in BOTH directions', () => {
    const tied = [withStatus('Z', 'behind'), withStatus('A', 'behind'), withStatus('M', 'deployed'), withStatus('B', 'deployed')];
    expect(names(withSort(tied, 'status-asc'))).toEqual(['B', 'M', 'A', 'Z']);
    expect(names(withSort(tied, 'status-desc'))).toEqual(['A', 'Z', 'B', 'M']);
  });

  test('a row used in 33 places with 1 behind still ranks as behind', () => {
    const many = row({ name: 'MANY', value_hash: 'm', locations: [...Array.from({ length: 32 }, () => loc({ targets: [target(false)] })), loc({ targets: [target(true)] })] });
    expect(names(withSort([withStatus('A', 'deployed'), many], 'status-asc'))).toEqual(['A', 'MANY']);
    expect(names(withSort([withStatus('A', 'unknown'), many], 'status-asc'))).toEqual(['MANY', 'A']);
  });
});

describe('updated sorts', () => {
  const rows = [
    withTime('OLD', '2026-01-01T00:00:00.000Z'),
    withTime('NEW', '2026-06-01T00:00:00.000Z'),
    withTime('NONE', undefined),
    withTime('MID', '2026-03-01T00:00:00.000Z'),
  ];

  test('newest first, rows with no time last', () => {
    expect(names(withSort(rows, 'updated-newest'))).toEqual(['NEW', 'MID', 'OLD', 'NONE']);
  });

  test('oldest first, rows with no time STILL last', () => {
    expect(names(withSort(rows, 'updated-oldest'))).toEqual(['OLD', 'MID', 'NEW', 'NONE']);
  });

  test('a row uses its most recent location time', () => {
    const multi = row({ name: 'MULTI', value_hash: 'x', locations: [loc({ changed_at: '2026-01-01T00:00:00.000Z' }), loc({ changed_at: '2026-12-01T00:00:00.000Z' })] });
    expect(names(withSort([withTime('NEW', '2026-06-01T00:00:00.000Z'), multi], 'updated-newest'))).toEqual(['MULTI', 'NEW']);
  });

  test('equal times and several no-time rows break the tie by name A-Z', () => {
    const tied = [
      withTime('Z', '2026-01-01T00:00:00.000Z'),
      withTime('A', '2026-01-01T00:00:00.000Z'),
      withTime('Y_NONE', undefined),
      withTime('B_NONE', undefined),
    ];
    expect(names(withSort(tied, 'updated-newest'))).toEqual(['A', 'Z', 'B_NONE', 'Y_NONE']);
    expect(names(withSort(tied, 'updated-oldest'))).toEqual(['A', 'Z', 'B_NONE', 'Y_NONE']);
  });

  test('a time that is not a date counts as no time', () => {
    expect(names(withSort([withTime('BAD', 'not-a-date'), withTime('OK', '2026-01-01T00:00:00.000Z')], 'updated-oldest'))).toEqual(['OK', 'BAD']);
  });
});

describe('the cursor stays on its row', () => {
  const rows = [row({ name: 'A', value_hash: 'a' }), row({ name: 'B', value_hash: 'b' }), row({ name: 'C', value_hash: 'c' }), row({ name: 'D', value_hash: 'd' })];

  test('after each sort change the highlighted row is the same row', () => {
    const onB = press(initialSecretsScreenState(rows), KEY_DOWN);
    expect(cursorName(onB)).toBe('B');
    const after = SORT_ORDER.slice(1).reduce<readonly SecretsScreenState[]>((acc) => [...acc, press(acc[acc.length - 1], CTRL_S)], [onB]);
    after.forEach((s) => expect(cursorName(s)).toBe('B'));
    expect(after[1].cursorIndex).toBe(2); // name Z-A: D, C, B, A
  });

  test('the same row is kept for two rows with one name and different values', () => {
    const dup = [row({ name: 'DB', value_hash: 'a' }), row({ name: 'DB', value_hash: 'b' })];
    const onSecond = press(initialSecretsScreenState(dup), KEY_DOWN);
    const sorted = press(onSecond, CTRL_S, CTRL_S);
    expect(filteredRows(sorted)[sorted.cursorIndex].value_hash).toBe('b');
  });

  test('Enter after a sort opens the details of the highlighted row', () => {
    const s = press(initialSecretsScreenState(rows), KEY_DOWN, CTRL_S, ENTER);
    expect(s.popup?.rowName).toBe('B');
  });
});

describe('sort and search together', () => {
  const rows = [
    row({ name: 'API_ONE', value_hash: '1' }),
    row({ name: 'DB_URL', value_hash: '2' }),
    row({ name: 'API_TWO', value_hash: '3' }),
    row({ name: 'API_THREE', value_hash: '4' }),
  ];

  test('search decides which rows show, the sort orders them', () => {
    const s = typed(initialSecretsScreenState(rows), 'api');
    expect(names(s)).toEqual(['API_ONE', 'API_THREE', 'API_TWO']);
    expect(names(press(s, CTRL_S))).toEqual(['API_TWO', 'API_THREE', 'API_ONE']);
  });

  test('typing after a sort keeps that sort', () => {
    const s = typed(press(initialSecretsScreenState(rows), CTRL_S), 'api');
    expect(s.sort).toBe('name-desc');
    expect(names(s)).toEqual(['API_TWO', 'API_THREE', 'API_ONE']);
  });

  test('the cursor stays on its row when Ctrl+S is pressed with a filter typed', () => {
    const s = press(typed(initialSecretsScreenState(rows), 'api'), KEY_DOWN);
    expect(cursorName(s)).toBe('API_THREE');
    expect(cursorName(press(s, CTRL_S))).toBe('API_THREE');
  });

  test('a search that matches by value orders its matches by the sort too', () => {
    const s = typed(initialSecretsScreenState(rows), 'zzzz-no-match');
    expect(names(s)).toEqual([]);
    expect(press(s, CTRL_S).cursorIndex).toBe(0);
  });
});

describe('Ctrl+S in the details view', () => {
  test('is ignored while the popup is open', () => {
    const rows = [row({ name: 'A', value_hash: 'a' }), row({ name: 'B', value_hash: 'b' })];
    const open = press(initialSecretsScreenState(rows), ENTER);
    expect(open.popup).not.toBeNull();
    const after = handleKey(open, CTRL_S);
    expect(after.state.sort).toBe('name-asc');
    expect(after.state.popup).toEqual(open.popup);
    expect(after.effect).toBeNull();
  });
});

describe('footer hint', () => {
  const rows = [row({ name: 'A', value_hash: 'a' })];
  const footer = (state: SecretsScreenState, width = 120): string => stripAnsi(render(state, width, 30)).split('\n').filter((l) => l.trim() !== '').slice(-1)[0];

  test('shows the key and the current sort', () => {
    expect(footer(initialSecretsScreenState(rows))).toContain('ctrl+s sort: name A-Z');
  });

  test('follows the sort through the whole cycle', () => {
    const labels = SORT_ORDER.reduce<readonly string[]>((acc, _s, i) => [...acc, footer(SORT_ORDER.slice(0, i).reduce((st) => press(st, CTRL_S), initialSecretsScreenState(rows)))], []);
    expect(labels.map((l) => l.match(/ctrl\+s sort: (.*)$/)?.[1])).toEqual([
      'name A-Z',
      'name Z-A',
      'deploy status A-Z',
      'deploy status Z-A',
      'updated newest',
      'updated oldest',
    ]);
  });

  test('is still shown while a search is typed', () => {
    expect(footer(typed(initialSecretsScreenState(rows), 'a'))).toContain('ctrl+s sort: name A-Z');
  });

  test('is not in the details view footer', () => {
    expect(footer(press(initialSecretsScreenState(rows), ENTER))).not.toContain('ctrl+s');
  });

  test('wide terminal: every hint is shown', () => {
    const line = footer(initialSecretsScreenState(rows), 140);
    ['↑↓ navigate', 'tab column', 'enter inspect', 'ctrl+e edit', 'ctrl+d deploy', 'esc clear/quit', 'ctrl+s sort: name A-Z'].forEach((hint) => expect(line).toContain(hint));
  });

  test('narrower terminal: whole hints are dropped (deploy, then edit, ...) but esc and sort stay', () => {
    const at100 = footer(initialSecretsScreenState(rows), 100);
    expect(at100).not.toContain('ctrl+d deploy');
    expect(at100).toContain('ctrl+e edit');
    const at80 = footer(initialSecretsScreenState(rows), 80);
    expect(at80).not.toContain('ctrl+e edit');
    expect(at80).toContain('esc clear/quit');
    expect(at80).toContain('ctrl+s sort: name A-Z');
    expect(at80).not.toContain('…');
  });

  test('a very narrow terminal clips to one line within the width', () => {
    [20, 40, 60, 80, 100].forEach((width) => {
      expect(Array.from(footer(initialSecretsScreenState(rows), width)).length).toBeLessThanOrEqual(width);
    });
  });

  test('the longest sort label still fits at 80 columns', () => {
    const s = { ...initialSecretsScreenState(rows), sort: 'status-desc' as const };
    expect(footer(s, 80)).toContain('ctrl+s sort: deploy status Z-A');
  });
});
