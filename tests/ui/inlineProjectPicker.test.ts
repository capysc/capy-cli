import { describe, test, expect } from 'bun:test';
import {
  stepProjectPicker,
  visibleProjects,
  type ProjectPickerState,
  type ProjectPickerStep,
} from '../../src/ui/inlineProjectPicker';

const ESC = '\x1b';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

const PROJECTS = [
  { id: 'p1', name: 'billing-api' },
  { id: 'p2', name: 'Web-Frontend' },
  { id: 'p3', name: 'billing-worker' },
  { id: 'p4', name: 'docs' },
];

const start = (selected: string[] = []): ProjectPickerState => ({
  projects: PROJECTS,
  cursor: 0,
  selected: new Set(selected),
  query: '',
});

/** Applies keys in order; stops at the first cancel/confirm. */
function press(initial: ProjectPickerState, ...keys: string[]): ProjectPickerStep<ProjectPickerState> {
  return keys.reduce<ProjectPickerStep<ProjectPickerState>>(
    (step, k) => (step.kind === 'state' ? stepProjectPicker(step.state, k) : step),
    { kind: 'state', state: initial },
  );
}
function stateAfter(initial: ProjectPickerState, ...keys: string[]): ProjectPickerState {
  const step = press(initial, ...keys);
  if (step.kind !== 'state') throw new Error(`expected a state, got ${step.kind}`);
  return step.state;
}

describe('inline project picker — pre-existing hotkeys behave as before when nothing is typed', () => {
  test('Space ticks and unticks the highlighted row', () => {
    const on = stateAfter(start(), ' ');
    expect(Array.from(on.selected)).toEqual(['p1']);
    expect(Array.from(stateAfter(on, ' ').selected)).toEqual([]);
  });

  test('Up/Down move the cursor and wrap', () => {
    expect(stateAfter(start(), DOWN).cursor).toBe(1);
    expect(stateAfter(start(), UP).cursor).toBe(3);
    expect(stateAfter(start(), DOWN, DOWN, DOWN, DOWN).cursor).toBe(0);
  });

  test('Enter (\\r or \\n) confirms with every ticked id', () => {
    expect(press(start(['p2']), DOWN, ' ', DOWN, ' ', '\r')).toEqual({ kind: 'confirm', chosen: ['p3'] });
    expect(press(start(['p1', 'p2']), '\n')).toEqual({ kind: 'confirm', chosen: ['p1', 'p2'] });
  });

  test('Esc (single or doubled) cancels', () => {
    expect(press(start(['p1']), ESC)).toEqual({ kind: 'cancel' });
    expect(press(start(), `${ESC}${ESC}`)).toEqual({ kind: 'cancel' });
  });

  test('unrecognised escape sequences and control keys are ignored', () => {
    const s = start(['p1']);
    expect(press(s, `${ESC}[C`)).toEqual({ kind: 'state', state: s });
    expect(press(s, '\t')).toEqual({ kind: 'state', state: s });
  });

  test('the state it was given is never changed', () => {
    const s = start(['p1']);
    stepProjectPicker(s, ' ');
    stepProjectPicker(s, 'x');
    expect(Array.from(s.selected)).toEqual(['p1']);
    expect(s.query).toBe('');
    expect(s.cursor).toBe(0);
  });
});

describe('inline project picker — typing, using and leaving the filter', () => {
  test('typed characters filter the list (case-insensitive substring)', () => {
    const s = stateAfter(start(), 'B', 'i', 'L');
    expect(s.query).toBe('BiL');
    expect(visibleProjects(s).map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  test('letters that are hotkeys elsewhere (q, r, g) are just filter text here', () => {
    const s = stateAfter(start(), 'q', 'r', 'g');
    expect(s.query).toBe('qrg');
    expect(visibleProjects(s)).toEqual([]);
  });

  test('a pasted chunk types all of it', () => {
    expect(stateAfter(start(), 'web').query).toBe('web');
  });

  test('Backspace edits the filter; on an empty filter it does nothing', () => {
    expect(stateAfter(start(), 'd', 'o', '\x7f').query).toBe('d');
    const s = start();
    expect(press(s, '\x7f')).toEqual({ kind: 'state', state: s });
  });

  test('the cursor addresses the filtered list: Space ticks the highlighted match', () => {
    const s = stateAfter(start(), 'w', 'o', 'r', ' ');
    expect(Array.from(s.selected)).toEqual(['p3']);
  });

  test('Up/Down stay inside the matches', () => {
    expect(stateAfter(start(), 'b', 'i', 'l', DOWN).cursor).toBe(1);
    expect(stateAfter(start(), 'b', 'i', 'l', DOWN, DOWN).cursor).toBe(0);
  });

  test('with no matches, arrows, Space and Backspace are harmless', () => {
    const s = stateAfter(start(), 'z', 'z', DOWN, UP, ' ');
    expect(Array.from(s.selected)).toEqual([]);
    expect(s.query).toBe('zz');
  });

  test('Enter confirms the ticks, including ticked projects the filter is hiding', () => {
    const step = press(start(['p4']), 'w', 'e', 'b', ' ', '\r');
    expect(step).toEqual({ kind: 'confirm', chosen: ['p4', 'p2'] });
  });

  test('Esc while a filter is typed clears it and does NOT cancel; a second Esc cancels', () => {
    const cleared = stateAfter(start(['p1']), 'd', 'o', ESC);
    expect(cleared.query).toBe('');
    expect(visibleProjects(cleared)).toHaveLength(4);
    expect(Array.from(cleared.selected)).toEqual(['p1']);
    expect(press(cleared, ESC)).toEqual({ kind: 'cancel' });
  });

  test('a state built without a query (older callers) behaves as an empty filter', () => {
    const legacy: ProjectPickerState = { projects: PROJECTS, cursor: 0, selected: new Set() };
    expect(visibleProjects(legacy)).toHaveLength(4);
    expect(press(legacy, ESC)).toEqual({ kind: 'cancel' });
  });
});
