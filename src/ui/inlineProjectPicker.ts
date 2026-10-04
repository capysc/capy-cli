/**
 * Key handling for the in-TUI multi-select project picker that `capy users`
 * opens when a role is scoped to projects (see `InteractiveTable`).
 *
 * Pure: `stepProjectPicker` takes the picker state and one raw key chunk and
 * returns what to do next, without touching the terminal or the state it was
 * given.
 *
 * Bindings (all pre-existing except the filter):
 *   Up / Down   move the cursor (wraps)
 *   Space       tick / untick the highlighted project
 *   Enter       confirm — resolves with every ticked project, visible or not
 *   Esc         cancel — but while a filter is typed, Esc clears the filter
 *               first (same as `capy secrets`), and only a second Esc cancels
 *   (new) any other printable text types into the filter; Backspace edits it
 *
 * The picker has no letter hotkeys of its own (it absorbs every key while
 * open, and the table's `q`/`r`/`g` do nothing here), so — like the
 * `capy secrets` search bar — typing filters directly with no mode switch.
 * Space is the tick key, so a filter cannot contain a space; type a fragment
 * of the name instead.
 *
 * Matching is the shared rule in `searchMatch` (case-insensitive substring).
 * Ticks are kept by project id, so a project hidden by the filter stays
 * ticked.
 */
import { filterByQuery } from './searchMatch';

const ESC = '\x1b';

export interface PickerProject {
  readonly id: string;
  readonly name: string;
}

export interface ProjectPickerState {
  readonly projects: ReadonlyArray<PickerProject>;
  /** Index into the VISIBLE (filtered) projects. */
  readonly cursor: number;
  readonly selected: ReadonlySet<string>;
  /** Absent in states built before the filter existed — treated as ''. */
  readonly query?: string;
}

export type ProjectPickerStep<S extends ProjectPickerState> =
  | { readonly kind: 'state'; readonly state: S }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'confirm'; readonly chosen: readonly string[] };

/** The projects the filter lets through, in list order. */
export function visibleProjects(state: ProjectPickerState): ReadonlyArray<PickerProject> {
  return filterByQuery(state.projects, state.query ?? '', (p) => p.name);
}

/** Printable text with no control characters (so no Esc sequences, Enter or Tab). */
const PLAIN_TEXT = /^[^\x00-\x1f\x7f]+$/;

function withQuery<S extends ProjectPickerState>(state: S, query: string): S {
  return { ...state, query, cursor: 0 };
}

function move<S extends ProjectPickerState>(state: S, offset: number): S {
  const count = visibleProjects(state).length;
  return count === 0 ? state : { ...state, cursor: (state.cursor + offset + count) % count };
}

function toggleCurrent<S extends ProjectPickerState>(state: S): S {
  const current = visibleProjects(state)[state.cursor];
  if (!current) return state;
  const selected = state.selected.has(current.id)
    ? new Set(Array.from(state.selected).filter((id) => id !== current.id))
    : new Set([...state.selected, current.id]);
  return { ...state, selected };
}

export function stepProjectPicker<S extends ProjectPickerState>(state: S, key: string): ProjectPickerStep<S> {
  const query = state.query ?? '';
  if (key === `${ESC}[A`) return { kind: 'state', state: move(state, -1) };
  if (key === `${ESC}[B`) return { kind: 'state', state: move(state, 1) };
  if (key === ' ') return { kind: 'state', state: toggleCurrent(state) };
  if (key === ESC || key === `${ESC}${ESC}`) {
    return query !== '' ? { kind: 'state', state: withQuery(state, '') } : { kind: 'cancel' };
  }
  if (key === '\r' || key === '\n') return { kind: 'confirm', chosen: Array.from(state.selected) };
  if (key === '\x7f' || key === '\b') {
    return { kind: 'state', state: query === '' ? state : withQuery(state, query.slice(0, -1)) };
  }
  if (PLAIN_TEXT.test(key)) return { kind: 'state', state: withQuery(state, query + key) };
  return { kind: 'state', state };
}
