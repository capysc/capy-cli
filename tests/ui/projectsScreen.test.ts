import { describe, test, expect } from 'bun:test';
import {
  initialProjectsScreenState,
  handleKey,
  render,
  filteredProjects,
  formatBranchesCell,
  tokenizeKeys,
  ProjectsScreenState,
} from '../../src/ui/projectsScreen';
import type { ProjectBranchSummary, ProjectSummary } from '../../src/commands/projectsCommand';

/**
 * `src/ui/projectsScreen.ts` — the pure reducer/render core of the `capy
 * projects` type-to-search screen. Modeled on `tests/ui/secretsScreen.test.ts`:
 * the same "fold `handleKey` over a sequence of keypresses" helper, the same
 * ESC/arrow key constants, and the same split between filter logic, the
 * reducer, and rendering.
 *
 * Unlike secrets, this reducer never returns an effect — Enter's "inspect"
 * view is just a different render of data already in `state.projects`, so
 * there's nothing here to mock a fetch for.
 */

const ESC = '\x1b';
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_C = '\x03';

function branch(name: string, isProtected = false, id = name): ProjectBranchSummary {
  return { id, name, protected: isProtected };
}

function project(name: string, branches: readonly ProjectBranchSummary[] = [], id = name): ProjectSummary {
  return { id, name, branches };
}

/** Folds `handleKey` over a sequence of keypresses — a `reduce`-based stand-in for "press these keys in order" that never needs a reassigned binding. */
function pressKeys(state: ProjectsScreenState, ...keys: readonly string[]): ProjectsScreenState {
  return keys.reduce((acc: ProjectsScreenState, k) => handleKey(acc, k), state);
}

/** Same as `pressKeys`, but for a string typed one character at a time. */
function type(state: ProjectsScreenState, text: string): ProjectsScreenState {
  return pressKeys(state, ...text.split(''));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const FIXTURE_PROJECTS: readonly ProjectSummary[] = [
  project('web', [branch('development'), branch('production', true)]),
  project('api', [branch('main')]),
  project('billing-queue', []),
];

describe('filteredProjects — case-insensitive substring over name or branch name', () => {
  test('empty query matches everything', () => {
    const state = initialProjectsScreenState(FIXTURE_PROJECTS);
    expect(filteredProjects(state).map((p) => p.name)).toEqual(['web', 'api', 'billing-queue']);
  });

  test('matches by project name, case-insensitively', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'WEB');
    expect(filteredProjects(state).map((p) => p.name)).toEqual(['web']);
  });

  test('matches by a branch name even when the project name does not match', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'main');
    expect(filteredProjects(state).map((p) => p.name)).toEqual(['api']);
  });

  test('a query matching nothing filters down to zero rows', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'nonexistent');
    expect(filteredProjects(state)).toEqual([]);
  });

  test('whitespace-only query is treated as empty', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), '   ');
    expect(filteredProjects(state).map((p) => p.name)).toEqual(['web', 'api', 'billing-queue']);
  });

  test('a project with no branches is still matchable by its own name', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'billing');
    expect(filteredProjects(state).map((p) => p.name)).toEqual(['billing-queue']);
  });
});

describe('handleKey — type-to-search list view', () => {
  test('every printable character types into the query, including letters that double as other screens\' quit keys (q/j/k)', () => {
    const state = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'q');
    expect(state.search.query).toBe('q');
    expect(state.quit).toBe(false);
  });

  test('Backspace removes the last character of the query', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'web');
    const afterBackspace = handleKey(typed, '\x7f');
    expect(afterBackspace.search.query).toBe('we');
  });

  test('Esc clears a non-empty query without quitting', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'web');
    const afterEsc = handleKey(typed, ESC);
    expect(afterEsc.search.query).toBe('');
    expect(afterEsc.quit).toBe(false);
  });

  test('Esc pressed again with an already-empty query quits', () => {
    const state = initialProjectsScreenState(FIXTURE_PROJECTS);
    const afterEsc = handleKey(state, ESC);
    expect(afterEsc.quit).toBe(true);
  });

  test('Ctrl-C always quits, regardless of query state', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'web');
    const afterCtrlC = handleKey(typed, CTRL_C);
    expect(afterCtrlC.quit).toBe(true);
  });

  test('typing a query reclamps the cursor into the (possibly shorter) filtered set rather than resetting to the top', () => {
    const movedDown = pressKeys(initialProjectsScreenState(FIXTURE_PROJECTS), KEY_DOWN, KEY_DOWN);
    expect(movedDown.cursorIndex).toBe(2); // billing-queue
    const filtered = type(movedDown, 'web'); // only 1 row now
    expect(filtered.cursorIndex).toBe(0);
  });

  test('Up/Down navigate and clamp at the ends of the filtered list', () => {
    const base = initialProjectsScreenState(FIXTURE_PROJECTS);
    expect(handleKey(base, KEY_UP).cursorIndex).toBe(0); // clamp at top
    const movedDown = pressKeys(base, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN);
    expect(movedDown.cursorIndex).toBe(2); // clamp at bottom (3 rows)
  });
});

describe('handleKey — Enter opens the inspect view, Esc/q close it', () => {
  test('Enter on the selected row opens its inspect view (by id)', () => {
    const state = initialProjectsScreenState(FIXTURE_PROJECTS);
    const afterEnter = handleKey(state, ENTER);
    expect(afterEnter.inspectingId).toBe('web');
  });

  test('Enter opens the CURRENTLY FILTERED row at the cursor, not the unfiltered one', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'main');
    const afterEnter = handleKey(typed, ENTER);
    expect(afterEnter.inspectingId).toBe('api');
  });

  test('while the inspect view is open, typing does not filter — it is absorbed, not applied to the search bar', () => {
    const opened = handleKey(initialProjectsScreenState(FIXTURE_PROJECTS), ENTER);
    const afterTyping = type(opened, 'xyz');
    expect(afterTyping.search.query).toBe('');
    expect(afterTyping.inspectingId).toBe('web');
  });

  test('Esc closes the inspect view, returning to the list (not quitting)', () => {
    const opened = handleKey(initialProjectsScreenState(FIXTURE_PROJECTS), ENTER);
    const afterEsc = handleKey(opened, ESC);
    expect(afterEsc.inspectingId).toBeNull();
    expect(afterEsc.quit).toBe(false);
  });

  test('q (or Q) also closes the inspect view, same as Esc', () => {
    const opened = handleKey(initialProjectsScreenState(FIXTURE_PROJECTS), ENTER);
    expect(handleKey(opened, 'q').inspectingId).toBeNull();
    expect(handleKey(opened, 'Q').inspectingId).toBeNull();
  });

  test('Ctrl-C quits straight through an open inspect view', () => {
    const opened = handleKey(initialProjectsScreenState(FIXTURE_PROJECTS), ENTER);
    expect(handleKey(opened, CTRL_C).quit).toBe(true);
  });

  test('a row with no branches can still be inspected without throwing', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'billing');
    const opened = handleKey(typed, ENTER);
    expect(opened.inspectingId).toBe('billing-queue');
  });
});

describe('formatBranchesCell', () => {
  test('joins branch names with a comma, marking protected ones', () => {
    expect(stripAnsi(formatBranchesCell(project('web', [branch('development'), branch('production', true)])))).toBe(
      'development, production (protected)',
    );
  });

  test('no branches renders a dim placeholder', () => {
    expect(stripAnsi(formatBranchesCell(project('empty', [])))).toBe('(no branches)');
  });
});

describe('render — pure function of state + terminal size', () => {
  test('shows the total project count and the live match count in the search bar', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'web');
    const out = stripAnsi(render(typed, 80, 24));
    expect(out).toContain('capy projects');
    expect(out).toContain('(3 projects)');
    expect(out).toContain('1/3');
    expect(out).toContain('web');
  });

  test('every project name and its branches appear in the body', () => {
    const out = stripAnsi(render(initialProjectsScreenState(FIXTURE_PROJECTS), 80, 24));
    expect(out).toContain('web');
    expect(out).toContain('development, production (protected)');
    expect(out).toContain('api');
    expect(out).toContain('main');
    expect(out).toContain('billing-queue');
    expect(out).toContain('(no branches)');
  });

  test('a query matching nothing renders the "No projects match." message', () => {
    const typed = type(initialProjectsScreenState(FIXTURE_PROJECTS), 'nonexistent');
    const out = stripAnsi(render(typed, 80, 24));
    expect(out).toContain('No projects match.');
  });

  test('footer hints change between the list view and the inspect view', () => {
    const listOut = stripAnsi(render(initialProjectsScreenState(FIXTURE_PROJECTS), 80, 24));
    expect(listOut).toContain('navigate');
    expect(listOut).toContain('inspect');
    expect(listOut).toContain('clear/quit');

    const opened = handleKey(initialProjectsScreenState(FIXTURE_PROJECTS), ENTER);
    const inspectOut = stripAnsi(render(opened, 80, 24));
    expect(inspectOut).toContain('close');
    expect(inspectOut).toContain('branches');
    expect(inspectOut).toContain('development');
    expect(inspectOut).toContain('production');
  });

  test('empty org renders a dedicated 0/0 state without throwing', () => {
    const out = stripAnsi(render(initialProjectsScreenState([]), 80, 24));
    expect(out).toContain('(0 projects)');
    expect(out).toContain('No projects match.');
  });
});

describe('tokenizeKeys is re-exported unchanged from the shared interactiveKeys module', () => {
  test('splits a chunk the same way secretsScreen.ts\'s tokenizer does', () => {
    expect(tokenizeKeys('web\r')).toEqual(['w', 'e', 'b', '\r']);
  });
});
