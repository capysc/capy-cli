/**
 * A checkbox prompt you can filter.
 *
 * inquirer's own checkbox binds `a` (toggle all), `i` (invert), the digits and
 * space, so letters cannot simply type into a filter. This prompt keeps every
 * one of those keys working exactly as before and adds an explicit search
 * mode:
 *
 *   - Outside search mode: up/down move, space toggles, `a` toggles all, `i`
 *     inverts, a digit toggles that row, Enter submits — unchanged. `/`
 *     enters search mode.
 *   - In search mode: printable characters type into the filter, Backspace
 *     edits it, up/down move within the matches, space still toggles, Enter
 *     still submits. Esc leaves search mode and clears the filter (the cursor
 *     stays on the row it was on). `a`, `i` and digits are filter text here.
 *
 * Ticks live on the underlying list, not on what is visible: rows hidden by
 * the filter keep their tick and are still returned on submit.
 *
 * The key handling is a pure function (`stepCheckboxKey`) so it can be tested
 * without a terminal; the prompt itself is a thin `@inquirer/core` shell.
 */
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  makeTheme,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isEnterKey,
  isBackspaceKey,
  isNumberKey,
} from '@inquirer/core';
import { filterByQuery } from './searchMatch';

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const ACCENT = (s: string) => `\x1b[36m${s}\x1b[0m`;

export interface CheckboxChoice<V> {
  readonly name: string;
  readonly value: V;
  readonly checked?: boolean;
}

/** The slice of a readline keypress event this prompt looks at. */
export interface CheckboxKey {
  readonly name: string;
  readonly ctrl: boolean;
  readonly sequence?: string;
  readonly meta?: boolean;
}

export interface CheckboxState {
  /** Indices (into the full choice list) that are ticked, ascending. */
  readonly checked: readonly number[];
  readonly searching: boolean;
  readonly query: string;
  /** Position within the VISIBLE rows. */
  readonly active: number;
}

export type CheckboxStep =
  | { readonly kind: 'state'; readonly state: CheckboxState }
  | { readonly kind: 'submit' };

/** Indices (into the full list) of the rows the filter lets through. */
export function visibleIndices(names: readonly string[], query: string): readonly number[] {
  return filterByQuery(
    names.map((name, index) => ({ name, index })),
    query,
    (row) => row.name,
  ).map((row) => row.index);
}

export function initialCheckboxState(choices: readonly { readonly checked?: boolean }[]): CheckboxState {
  return {
    checked: choices.flatMap((c, i) => (c.checked ? [i] : [])),
    searching: false,
    query: '',
    active: 0,
  };
}

/** `checked` with `index` flipped; stays ascending. `count` is the full choice count. */
const toggled = (checked: readonly number[], index: number, count: number): readonly number[] =>
  Array.from({ length: count }, (_, i) => i).filter((i) => (i === index ? !checked.includes(i) : checked.includes(i)));

function isPrintable(key: CheckboxKey): boolean {
  const seq = key.sequence ?? '';
  return seq.length === 1 && !key.ctrl && !key.meta && seq >= ' ' && seq !== '\x7f';
}

const same = (state: CheckboxState): CheckboxStep => ({ kind: 'state', state });

/** Keys that work the same in and out of search mode. `null` when the key is not one of them. */
function stepShared(state: CheckboxState, visible: readonly number[], count: number, key: CheckboxKey): CheckboxStep | null {
  if (isEnterKey(key)) return { kind: 'submit' };
  if (isUpKey(key) || isDownKey(key)) {
    const offset = isUpKey(key) ? -1 : 1;
    return visible.length === 0
      ? same(state)
      : same({ ...state, active: (state.active + offset + visible.length) % visible.length });
  }
  if (isSpaceKey(key)) {
    const target = visible[state.active];
    return same(target === undefined ? state : { ...state, checked: toggled(state.checked, target, count) });
  }
  return null;
}

function stepSearching(state: CheckboxState, names: readonly string[], key: CheckboxKey): CheckboxStep {
  const visible = visibleIndices(names, state.query);
  const shared = stepShared(state, visible, names.length, key);
  if (shared) return shared;
  if (key.name === 'escape') {
    // Leave search mode; keep the cursor on the row it was on.
    return same({ ...state, searching: false, query: '', active: visible[state.active] ?? 0 });
  }
  if (isBackspaceKey(key)) return same({ ...state, query: state.query.slice(0, -1), active: 0 });
  if (isPrintable(key)) return same({ ...state, query: state.query + (key.sequence ?? ''), active: 0 });
  return same(state);
}

function stepBrowsing(state: CheckboxState, names: readonly string[], key: CheckboxKey): CheckboxStep {
  const visible = visibleIndices(names, '');
  const shared = stepShared(state, visible, names.length, key);
  if (shared) return shared;
  if (key.sequence === '/') return same({ ...state, searching: true, query: '' });
  if (key.name === 'a' && !key.ctrl) {
    const all = names.map((_, i) => i);
    return same({ ...state, checked: state.checked.length < names.length ? all : [] });
  }
  if (key.name === 'i' && !key.ctrl) {
    return same({ ...state, checked: names.flatMap((_, i) => (state.checked.includes(i) ? [] : [i])) });
  }
  if (isNumberKey(key)) {
    const target = Number(key.name) - 1;
    return target >= 0 && target < names.length
      ? same({ ...state, active: target, checked: toggled(state.checked, target, names.length) })
      : same(state);
  }
  return same(state);
}

/** One keypress applied to the prompt state. Pure. */
export function stepCheckboxKey(
  state: CheckboxState,
  names: readonly string[],
  key: CheckboxKey,
): CheckboxStep {
  return state.searching ? stepSearching(state, names, key) : stepBrowsing(state, names, key);
}

export interface SearchableCheckboxConfig<V> {
  readonly message: string;
  readonly choices: readonly CheckboxChoice<V>[];
  /** The help text under the list (same shape as inquirer checkbox's `instructions`). */
  readonly instructions?: string;
  readonly theme?: { readonly icon?: { readonly checked?: string; readonly unchecked?: string } };
  readonly pageSize?: number;
  /** `true` to accept, or a string to refuse with that message. */
  readonly validate?: (values: readonly V[]) => boolean | string | Promise<boolean | string>;
}

interface PromptState {
  readonly box: CheckboxState;
  readonly error: string | undefined;
}

export const searchableCheckbox = createPrompt<readonly unknown[], SearchableCheckboxConfig<unknown>>(
  (config, done) => {
    const { choices, pageSize = 7, validate = () => true } = config;
    const names = choices.map((c) => c.name);
    const theme = makeTheme({ icon: { checked: '◉', unchecked: '◯', cursor: '❯' } } as any, config.theme as any) as any;
    const icon = {
      checked: config.theme?.icon?.checked ?? '◉',
      unchecked: config.theme?.icon?.unchecked ?? '◯',
      cursor: '❯',
    };
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const prefix = usePrefix({ status, theme });
    const [promptState, setPromptState] = useState<PromptState>({
      box: initialCheckboxState(choices),
      error: undefined,
    });
    const { box, error } = promptState;

    useKeypress(async (key, rl) => {
      rl.clearLine(0);
      const step = stepCheckboxKey(box, names, key as CheckboxKey);
      if (step.kind === 'state') {
        setPromptState({ box: step.state, error: undefined });
        return;
      }
      const values = box.checked.map((i) => choices[i].value);
      const verdict = await validate(values);
      if (verdict === true) {
        setStatus('done');
        done(values);
        return;
      }
      setPromptState({ box, error: typeof verdict === 'string' && verdict ? verdict : 'You must select a valid value' });
    });

    // Hooks run on every render, in the same order — before any early return.
    const visible = visibleIndices(names, box.query);
    const page = usePagination({
      items: visible,
      active: box.active,
      pageSize,
      loop: true,
      renderItem({ item, isActive }) {
        const mark = box.checked.includes(item) ? icon.checked : icon.unchecked;
        const line = `${isActive ? icon.cursor : ' '}${mark} ${names[item]}`;
        return isActive ? theme.style.highlight(line) : line;
      },
    });

    const message = theme.style.message(config.message, status);
    if (status === 'done') {
      const answer = theme.style.answer(box.checked.map((i) => names[i]).join(', '));
      return [prefix, message, answer].filter(Boolean).join(' ');
    }
    const searchBar = box.searching ? `${DIM('search:')} ${ACCENT(box.query)}${DIM('▏')}` : '';

    return [
      [prefix, message].filter(Boolean).join(' '),
      searchBar,
      page,
      ' ',
      error ? theme.style.error(error) : '',
      config.instructions ?? '',
    ]
      .filter(Boolean)
      .join('\n')
      .trimEnd();
  },
) as unknown as <V>(config: SearchableCheckboxConfig<V>, context?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) => Promise<V[]>;
