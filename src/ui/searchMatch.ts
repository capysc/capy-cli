/**
 * The one matching rule for every "type to filter" box in the CLI.
 *
 * It started life inside `capy secrets` search (CAP-678): the query is trimmed
 * of surrounding whitespace and lowercased, and a candidate matches when its
 * lowercased text contains that query as a substring. An empty (or
 * whitespace-only) query matches everything. Pickers and the secrets screen
 * share this so "does it match?" has exactly one answer.
 */

/** The trimmed, lowercased form of a typed query — compute once per filter pass. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether `text` matches `qLower` (already passed through `normalizeQuery`). */
export function textMatches(text: string, qLower: string): boolean {
  return text.toLowerCase().includes(qLower);
}

/** The items whose `textOf` matches `query`; every item when the query is blank. Order is kept. */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
): readonly T[] {
  const qLower = normalizeQuery(query);
  return qLower === '' ? items : items.filter((item) => textMatches(textOf(item), qLower));
}
