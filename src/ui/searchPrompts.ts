/**
 * Type-to-filter project pickers for the inquirer-based prompts.
 *
 * Single-select pickers use inquirer's own `search` prompt; this module only
 * supplies its `source` (the shared match rule from `searchMatch`) so the
 * rule lives in one place. Multi-select lives in `searchableCheckbox`.
 *
 * "Special" rows (the "New project" row, Vercel's "None of these" row) are
 * ordinary rows: they are matched on their own label like every other row,
 * and with no filter typed they sit exactly where the list put them. They are
 * deliberately NOT pinned under a filter — a pinned row would become the
 * highlighted one when nothing else matched, and Enter on a mistyped filter
 * would then create a project. Clearing the filter brings them back.
 */
import { filterByQuery } from './searchMatch';

export interface PickChoice<V> {
  readonly name: string;
  readonly value: V;
}

/** `matched` with the default choice (if present) moved to the front; order otherwise unchanged. */
function defaultFirst<V>(matched: readonly PickChoice<V>[], defaultValue: V | undefined): readonly PickChoice<V>[] {
  const at = defaultValue === undefined ? -1 : matched.findIndex((c) => c.value === defaultValue);
  return at <= 0 ? matched : [matched[at], ...matched.filter((_, i) => i !== at)];
}

/** What a search prompt shows for `term`: the matching choices, default first. `term` is `undefined` or '' for "no filter". */
export function searchableChoices<V>(
  choices: readonly PickChoice<V>[],
  term: string | undefined,
  defaultValue?: V,
): readonly PickChoice<V>[] {
  return defaultFirst(filterByQuery(choices, term ?? '', (c) => c.name), defaultValue);
}

/**
 * The question to hand `inquirer.prompt([...])` for a searchable single-select.
 * The answer is stored under `name`, as with the `list` prompt it replaces.
 */
export function searchableSelectQuestion<V>(opts: {
  readonly name: string;
  readonly message: string;
  readonly choices: readonly PickChoice<V>[];
  readonly default?: V;
}): any {
  return {
    type: 'search',
    name: opts.name,
    message: opts.message,
    source: (term: string | undefined) => searchableChoices(opts.choices, term, opts.default),
  };
}
