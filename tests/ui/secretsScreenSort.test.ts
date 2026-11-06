import { describe, test, expect } from 'bun:test';
import {
  initialSecretsScreenState,
  handleKey,
  render,
  filteredRows,
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
const KEY_UP = `${ESC}[A`;
const CTRL_E = '\x05';
const CTRL_D = '\x04';
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
/** Opens the sort menu, moves down to `mode`, and presses Enter. */
const choose = (state: SecretsScreenState, mode: SortMode): SecretsScreenState =>
  press(state, CTRL_S, ...Array.from({ length: (SORT_ORDER.indexOf(mode) - SORT_ORDER.indexOf(state.sort) + SORT_ORDER.length) % SORT_ORDER.length }, () => KEY_DOWN), ENTER);
const cursorName = (state: SecretsScreenState): string | undefined => filteredRows(state)[state.cursorIndex]?.name;

describe('the sort order', () => {
  test('lists the six sorts in order, and the screen starts on name A-Z', () => {
    expect(SORT_ORDER).toEqual(['name-asc', 'name-desc', 'status-asc', 'status-desc', 'updated-newest', 'updated-oldest']);
    expect(initialSecretsScreenState([]).sort).toBe('name-asc');
    expect(initialSecretsScreenState([]).sortMenu).toBeNull();
  });
});

describe('Ctrl+S opens the sort menu', () => {
  const rows = [row({ name: 'B', value_hash: 'b' }), row({ name: 'C', value_hash: 'c' }), row({ name: 'A', value_hash: 'a' })];

  test('it opens with its cursor on the current sort and changes nothing else', () => {
    const open = press(initialSecretsScreenState(rows), CTRL_S);
    expect(open.sortMenu).toEqual({ cursor: 0 });
    expect(open.sort).toBe('name-asc');
    expect(open.search.query).toBe('');
    expect(press(withSort(rows, 'status-desc'), CTRL_S).sortMenu).toEqual({ cursor: 3 });
  });

  test('Up and Down move in the menu and wrap at both ends', () => {
    const open = press(initialSecretsScreenState(rows), CTRL_S);
    expect(press(open, KEY_DOWN).sortMenu).toEqual({ cursor: 1 });
    expect(press(open, KEY_UP).sortMenu).toEqual({ cursor: 5 });
    expect(press(open, ...Array.from({ length: 6 }, () => KEY_DOWN)).sortMenu).toEqual({ cursor: 0 });
    expect(press(open, KEY_DOWN, KEY_DOWN, KEY_UP).sortMenu).toEqual({ cursor: 1 });
  });

  test('moving in the menu does not change the sort or the list cursor until Enter', () => {
    const moved = press(initialSecretsScreenState(rows), KEY_DOWN, CTRL_S, KEY_DOWN, KEY_DOWN);
    expect(moved.sort).toBe('name-asc');
    expect(moved.cursorIndex).toBe(1);
    expect(names(moved)).toEqual(['A', 'B', 'C']);
  });

  test('Enter applies the highlighted sort, closes the menu, and puts the list cursor at 0', () => {
    const s = press(initialSecretsScreenState(rows), KEY_DOWN, KEY_DOWN, CTRL_S, KEY_DOWN, ENTER);
    expect(s.sort).toBe('name-desc');
    expect(s.sortMenu).toBeNull();
    expect(s.cursorIndex).toBe(0);
    expect(names(s)).toEqual(['C', 'B', 'A']);
  });

  test('Enter on the current sort closes the menu and still goes to the top', () => {
    const s = press(initialSecretsScreenState(rows), KEY_DOWN, CTRL_S, ENTER);
    expect(s.sort).toBe('name-asc');
    expect(s.sortMenu).toBeNull();
    expect(s.cursorIndex).toBe(0);
  });

  test('each of the six sorts can be chosen', () => {
    expect(SORT_ORDER.map((mode) => choose(initialSecretsScreenState(rows), mode).sort)).toEqual([...SORT_ORDER]);
  });

  test('Esc closes the menu with no change', () => {
    const before = press(initialSecretsScreenState(rows), KEY_DOWN);
    expect(press(before, CTRL_S, KEY_DOWN, KEY_DOWN, ESC)).toEqual(before);
  });

  test('a double Esc and `q` also close it with no change', () => {
    const before = press(initialSecretsScreenState(rows), KEY_DOWN);
    expect(press(before, CTRL_S, KEY_DOWN, `${ESC}${ESC}`)).toEqual(before);
    expect(press(before, CTRL_S, KEY_DOWN, 'q')).toEqual(before);
    expect(press(before, CTRL_S, KEY_DOWN, 'Q')).toEqual(before);
  });

  test('Esc in the menu does not quit the screen or clear a typed search', () => {
    const s = press(typed(initialSecretsScreenState(rows), 'a'), CTRL_S, ESC);
    expect(s.quit).toBe(false);
    expect(s.search.query).toBe('a');
  });

  test('letters do not reach the search while the menu is open', () => {
    const open = press(initialSecretsScreenState(rows), CTRL_S);
    const s = press(open, 'a', 'b', 'x', ' ', 'j', 'k', '/');
    expect(s).toEqual(open);
    expect(s.search.query).toBe('');
  });

  test('Tab, Shift+Tab, Ctrl+E, Ctrl+D, Ctrl+S, Backspace and paging do nothing in the menu', () => {
    const open = press(initialSecretsScreenState(rows), CTRL_S);
    [KEY_TAB, `${ESC}[Z`, CTRL_E, CTRL_D, CTRL_S, '\x7f', `${ESC}[5~`, `${ESC}[6~`].forEach((k) => {
      const after = handleKey(open, k);
      expect(after.state).toEqual(open);
      expect(after.effect).toBeNull();
    });
  });

  test('Ctrl+E and Ctrl+D do nothing in the menu even with the list on a row', () => {
    const open = press(initialSecretsScreenState(rows), KEY_DOWN, CTRL_S);
    expect(handleKey(open, CTRL_E)).toEqual({ state: open, effect: null });
    expect(handleKey(open, CTRL_D)).toEqual({ state: open, effect: null });
  });

  test('Enter in the menu applies the sort and does not open the details', () => {
    const after = handleKey(press(initialSecretsScreenState(rows), CTRL_S, KEY_DOWN), ENTER);
    expect(after.state.popup).toBeNull();
    expect(after.state.edit).toBeNull();
    expect(after.state.deploy).toBeNull();
    expect(after.effect).toBeNull();
  });

  test('Ctrl+C still quits from the menu', () => {
    expect(press(initialSecretsScreenState(rows), CTRL_S, '\x03').quit).toBe(true);
  });

  test('Tab and Shift+Tab still cycle columns in the list and leave the sort alone', () => {
    const s = press(choose(initialSecretsScreenState(rows), 'name-desc'), KEY_TAB);
    expect(s.column).toBe('branch');
    expect(s.sort).toBe('name-desc');
    expect(press(s, `${ESC}[Z`).column).toBe('project');
  });

  test('Ctrl+S is not typed into the search bar', () => {
    expect(press(initialSecretsScreenState(rows), CTRL_S, ENTER).search.query).toBe('');
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

describe('a sort change goes back to the top', () => {
  const rows = [row({ name: 'A', value_hash: 'a' }), row({ name: 'B', value_hash: 'b' }), row({ name: 'C', value_hash: 'c' }), row({ name: 'D', value_hash: 'd' })];

  test('after each sort change the first row of the new order is highlighted', () => {
    const onC = press(initialSecretsScreenState(rows), KEY_DOWN, KEY_DOWN);
    expect(cursorName(onC)).toBe('C');
    const after = SORT_ORDER.map((mode) => choose(onC, mode));
    after.forEach((s) => {
      expect(s.cursorIndex).toBe(0);
      expect(cursorName(s)).toBe(filteredRows(s)[0].name);
    });
    expect(cursorName(after[1])).toBe('D'); // name Z-A: D, C, B, A
  });

  test('the rendered list starts at the first row after a sort change', () => {
    const many = Array.from({ length: 60 }, (_, i) => row({ name: `K${String(i).padStart(2, '0')}`, value_hash: `h${i}` }));
    const scrolled = press(initialSecretsScreenState(many), ...Array.from({ length: 50 }, () => KEY_DOWN));
    expect(stripAnsi(render(scrolled, 120, 20))).not.toContain('K00');
    const sorted = choose(scrolled, 'name-asc');
    expect(sorted.cursorIndex).toBe(0);
    const text = stripAnsi(render(sorted, 120, 20));
    expect(text).toContain('K00');
    expect(text).not.toContain('K59');
  });

  test('Enter after a sort opens the details of the first row', () => {
    const s = press(initialSecretsScreenState(rows), KEY_DOWN, CTRL_S, KEY_DOWN, ENTER, ENTER);
    expect(s.popup?.rowName).toBe('D');
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
    expect(names(choose(s, 'name-desc'))).toEqual(['API_TWO', 'API_THREE', 'API_ONE']);
  });

  test('typing after a sort keeps that sort', () => {
    const s = typed(choose(initialSecretsScreenState(rows), 'name-desc'), 'api');
    expect(s.sort).toBe('name-desc');
    expect(names(s)).toEqual(['API_TWO', 'API_THREE', 'API_ONE']);
  });

  test('choosing a sort with a filter typed goes back to the first match', () => {
    const s = press(typed(initialSecretsScreenState(rows), 'api'), KEY_DOWN);
    expect(cursorName(s)).toBe('API_THREE');
    expect(cursorName(choose(s, 'name-desc'))).toBe('API_TWO');
  });

  test('a search that matches by value orders its matches by the sort too', () => {
    const s = typed(initialSecretsScreenState(rows), 'zzzz-no-match');
    expect(names(s)).toEqual([]);
    expect(choose(s, 'name-desc').cursorIndex).toBe(0);
  });
});

describe('Ctrl+S in the details view', () => {
  test('is ignored while the popup is open', () => {
    const rows = [row({ name: 'A', value_hash: 'a' }), row({ name: 'B', value_hash: 'b' })];
    const open = press(initialSecretsScreenState(rows), ENTER);
    expect(open.popup).not.toBeNull();
    const after = handleKey(open, CTRL_S);
    expect(after.state.sort).toBe('name-asc');
    expect(after.state.sortMenu).toBeNull();
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
    const labels = SORT_ORDER.map((mode) => footer(choose(initialSecretsScreenState(rows), mode)));
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

describe('the sort menu on screen', () => {
  const rows = [row({ name: 'A', value_hash: 'a' }), row({ name: 'B', value_hash: 'b' })];
  const lines = (state: SecretsScreenState, width: number, height: number): readonly string[] => stripAnsi(render(state, width, height)).split('\n');
  const open = (mode: SortMode = 'name-asc'): SecretsScreenState => press(withSort(rows, mode), CTRL_S);
  const LABELS = ['name A-Z', 'name Z-A', 'deploy status A-Z', 'deploy status Z-A', 'updated newest', 'updated oldest'];

  test('shows the title, the six labels, and the menu footer', () => {
    const l = lines(open(), 100, 30);
    LABELS.forEach((label) => expect(l.join('\n')).toContain(label));
    expect(l.join('\n')).toContain('sort by');
    expect(l.filter((x) => x.trim() !== '').slice(-1)[0]).toContain('↑↓ choose · enter sort · esc cancel');
  });

  test('marks the current sort and puts the pointer on the menu cursor', () => {
    const l = lines(press(open('status-asc'), KEY_DOWN), 100, 30);
    const marked = l.filter((x) => x.includes('●'));
    expect(marked.length).toBe(1);
    expect(marked[0]).toContain('deploy status A-Z');
    const pointed = l.filter((x) => x.includes('▶'));
    expect(pointed.length).toBe(1);
    expect(pointed[0]).toContain('deploy status Z-A');
  });

  test('the list and its footer are not drawn while the menu is open', () => {
    const text = lines(open(), 100, 30).join('\n');
    expect(text).not.toContain('search:');
    expect(text).not.toContain('ctrl+s sort');
  });

  test('the list is back, with the new sort in its footer, after Enter', () => {
    const text = lines(choose(initialSecretsScreenState(rows), 'updated-newest'), 100, 30).join('\n');
    expect(text).toContain('search:');
    expect(text).toContain('ctrl+s sort: updated newest');
    expect(text).not.toContain('sort by');
  });

  test('fits 60 columns by 12 lines: all six labels, no line wider or taller than the terminal', () => {
    const l = lines(open(), 60, 12);
    expect(l.length).toBeLessThanOrEqual(12);
    l.forEach((x) => expect(Array.from(x).length).toBeLessThanOrEqual(60));
    LABELS.forEach((label) => expect(l.join('\n')).toContain(label));
    expect(l.filter((x) => x.trim() !== '').slice(-1)[0]).toContain('esc cancel');
  });

  test('on a very short or narrow terminal it windows around the cursor and never overflows', () => {
    [[40, 8], [30, 7], [20, 6], [80, 5]].forEach(([w, h]) => {
      SORT_ORDER.forEach((_m, i) => {
        const l = lines(press(open(), ...Array.from({ length: i }, () => KEY_DOWN)), w, h);
        expect(l.length).toBeLessThanOrEqual(h);
        l.forEach((x) => expect(Array.from(x).length).toBeLessThanOrEqual(w));
        expect(l.filter((x) => x.includes('▶')).length).toBe(1);
      });
    });
  });

  test('the dry-run tag is on the menu screen', () => {
    expect(lines(press(initialSecretsScreenState(rows, true), CTRL_S), 100, 30).join('\n')).toContain('DRY RUN');
  });
});
