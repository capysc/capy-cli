import { describe, test, expect } from 'bun:test';
import {
  searchableCheckbox,
  stepCheckboxKey,
  initialCheckboxState,
  visibleIndices,
  type CheckboxKey,
  type CheckboxState,
} from '../../src/ui/searchableCheckbox';
import { SEARCHABLE_CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME } from '../../src/ui/promptStyle';
import { fakeTerminal, KEYS } from '../helpers/fakeTerminal';

const NAMES = ['billing-api', 'Web-Frontend', 'billing-worker', 'docs'];

const key = (name: string, sequence: string = name): CheckboxKey => ({ name, sequence, ctrl: false });
const K = {
  up: key('up', '\x1b[A'),
  down: key('down', '\x1b[B'),
  space: key('space', ' '),
  enter: key('return', '\r'),
  escape: key('escape', '\x1b'),
  backspace: key('backspace', '\x7f'),
  slash: key('/', '/'),
};

/** Feed keys through the pure step function; returns the final state (or 'submit'). */
function press(start: CheckboxState, ...keys: CheckboxKey[]): CheckboxState | 'submit' {
  return keys.reduce<CheckboxState | 'submit'>((state, k) => {
    if (state === 'submit') return state;
    const step = stepCheckboxKey(state, NAMES, k);
    return step.kind === 'submit' ? 'submit' : step.state;
  }, start);
}
const asState = (r: CheckboxState | 'submit'): CheckboxState => {
  if (r === 'submit') throw new Error('unexpected submit');
  return r;
};
const fresh = () => initialCheckboxState(NAMES.map(() => ({})));

describe('searchableCheckbox — keys that worked before search existed still do', () => {
  test('space toggles the highlighted row, arrows move (wrapping)', () => {
    const s = asState(press(fresh(), K.down, K.space));
    expect(s.checked).toEqual([1]);
    expect(asState(press(s, K.space)).checked).toEqual([]);
    expect(asState(press(fresh(), K.up)).active).toBe(3);
    expect(asState(press(fresh(), K.down, K.down, K.down, K.down)).active).toBe(0);
  });

  test('`a` toggles all (all on, then all off), `i` inverts', () => {
    const all = asState(press(fresh(), key('a')));
    expect(all.checked).toEqual([0, 1, 2, 3]);
    expect(asState(press(all, key('a'))).checked).toEqual([]);
    const some = asState(press(fresh(), K.space));
    expect(asState(press(some, key('i'))).checked).toEqual([1, 2, 3]);
  });

  test('a digit toggles that row and moves the cursor to it', () => {
    const s = asState(press(fresh(), key('3')));
    expect(s.checked).toEqual([2]);
    expect(s.active).toBe(2);
    expect(asState(press(fresh(), key('9'))).checked).toEqual([]);
  });

  test('Enter submits', () => {
    expect(press(fresh(), K.enter)).toBe('submit');
  });

  test('pre-checked rows start ticked', () => {
    const s = initialCheckboxState([{}, { checked: true }, {}, { checked: true }]);
    expect(s.checked).toEqual([1, 3]);
    expect(s.searching).toBe(false);
  });

  test('outside search mode, other letters do nothing (they are not filter text)', () => {
    const s = asState(press(fresh(), key('b'), key('x')));
    expect(s.query).toBe('');
    expect(s.searching).toBe(false);
  });
});

describe('searchableCheckbox — entering, typing in and leaving search', () => {
  test('`/` enters search mode; typing builds the query and filters the rows', () => {
    const s = asState(press(fresh(), K.slash, key('b'), key('i'), key('l')));
    expect(s.searching).toBe(true);
    expect(s.query).toBe('bil');
    expect(visibleIndices(NAMES, s.query)).toEqual([0, 2]);
  });

  test('in search mode `a`, `i` and digits are filter text, not shortcuts', () => {
    const s = asState(press(fresh(), K.slash, key('a'), key('i'), key('1')));
    expect(s.query).toBe('ai1');
    expect(s.checked).toEqual([]);
  });

  test('Backspace edits the query', () => {
    const s = asState(press(fresh(), K.slash, key('d'), key('o'), K.backspace));
    expect(s.query).toBe('d');
  });

  test('matching is case-insensitive substring (the shared rule)', () => {
    expect(visibleIndices(NAMES, 'WEB')).toEqual([1]);
    expect(visibleIndices(NAMES, 'ing-')).toEqual([0, 2]);
  });

  test('Space still toggles in search mode — on the highlighted VISIBLE row', () => {
    const s = asState(press(fresh(), K.slash, key('w'), key('o'), K.space));
    expect(s.checked).toEqual([2]);
  });

  test('arrows move within the matches only', () => {
    const s = asState(press(fresh(), K.slash, key('b'), key('i'), key('l'), K.down, K.space));
    expect(s.checked).toEqual([2]);
    expect(asState(press(fresh(), K.slash, key('b'), key('i'), key('l'), K.down, K.down)).active).toBe(0);
  });

  test('Enter still submits from search mode', () => {
    expect(press(fresh(), K.slash, key('d'), K.enter)).toBe('submit');
  });

  test('Esc leaves search mode and clears the filter, keeping the cursor on its row', () => {
    const s = asState(press(fresh(), K.slash, key('w'), key('e'), key('b'), K.escape));
    expect(s.searching).toBe(false);
    expect(s.query).toBe('');
    expect(s.active).toBe(1);
  });

  test('Esc outside search mode does nothing (it never cancelled this prompt)', () => {
    const s = fresh();
    expect(asState(press(s, K.escape))).toEqual(s);
  });

  test('ticks survive filtering: rows hidden by the filter stay ticked', () => {
    const s = asState(press(fresh(), K.space, K.slash, key('d'), key('o'), key('c'), K.space, K.escape));
    expect(s.checked).toEqual([0, 3]);
  });

  test('no matches: arrows and Space are harmless', () => {
    const s = asState(press(fresh(), K.slash, key('z'), key('z'), K.down, K.space, K.up));
    expect(s.checked).toEqual([]);
    expect(visibleIndices(NAMES, s.query)).toEqual([]);
  });
});

describe('searchableCheckbox — the real prompt, driven by keystrokes', () => {
  const choices = NAMES.map((name, i) => ({ name, value: `p${i + 1}`, checked: i === 0 }));
  const config = {
    message: 'Grant Member access to which projects?',
    choices,
    instructions: SEARCHABLE_CHECKBOX_INSTRUCTIONS,
    theme: CHECKBOX_THEME,
    validate: (v: readonly string[]) => v.length > 0 || 'Pick at least one project',
  };

  test('Enter straight away returns the pre-checked default', async () => {
    const t = fakeTerminal();
    const pending = searchableCheckbox<string>(config, t.context);
    await t.wait(30);
    await t.type(KEYS.enter);
    expect(await pending).toEqual(['p1']);
    expect(t.screen()).toContain('Grant Member access to which projects?');
  });

  test('`/`, type, Space, Enter picks the filtered row and keeps the default ticked', async () => {
    const t = fakeTerminal();
    const pending = searchableCheckbox<string>(config, t.context);
    await t.wait(30);
    await t.type('/', 'w', 'e', 'b', ' ', KEYS.enter);
    expect(await pending).toEqual(['p1', 'p2']);
    expect(t.screen()).toContain('search:');
  });

  test('plain keys behave as before: `i` inverts the default, `a` selects all', async () => {
    const t = fakeTerminal();
    const pending = searchableCheckbox<string>(config, t.context);
    await t.wait(30);
    await t.type('i', KEYS.enter);
    expect(await pending).toEqual(['p2', 'p3', 'p4']);

    const t2 = fakeTerminal();
    const pending2 = searchableCheckbox<string>(config, t2.context);
    await t2.wait(30);
    await t2.type('a', KEYS.enter);
    expect(await pending2).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('Esc leaves search; the typed filter does not hide rows afterwards', async () => {
    const t = fakeTerminal();
    const pending = searchableCheckbox<string>(config, t.context);
    await t.wait(30);
    await t.type('/', 'd', 'o', 'c', KEYS.escape, 'a', KEYS.enter);
    expect(await pending).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('validation still refuses an empty selection and the prompt stays open', async () => {
    const t = fakeTerminal();
    const pending = searchableCheckbox<string>(config, t.context);
    await t.wait(30);
    await t.type(' ', KEYS.enter); // untick the default, try to submit
    expect(t.screen()).toContain('Pick at least one project');
    await t.type('2', KEYS.enter);
    expect(await pending).toEqual(['p2']);
  });
});

describe('SEARCHABLE_CHECKBOX_INSTRUCTIONS', () => {
  test('keeps every existing key hint and adds the filter key', () => {
    const plain = SEARCHABLE_CHECKBOX_INSTRUCTIONS.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('space to select');
    expect(plain).toContain('a to toggle all');
    expect(plain).toContain('i to invert');
    expect(plain).toContain('/ to filter');
    expect(plain).toContain('enter to proceed');
  });
});
