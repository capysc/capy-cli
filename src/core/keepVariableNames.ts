/**
 * The variable NAMES in a keep.lock, and the branches each one is on. Nothing else survives.
 *
 * A keep.lock entry carries a resource id, a value hash, connector metadata and delivery records. A human asked
 * "delete this project?" needs only the names and the branches, so this is the one place the rest is dropped: a
 * caller that shows or emits the result cannot leak a hash, because the hash is never copied out.
 */

export interface VariableBranches {
  readonly name: string;
  /** Sorted and unique. */
  readonly branches: readonly string[];
}

/** The branches of one keep.lock entry list; an entry with no branch name is skipped. */
function branchesOf(entries: unknown): readonly string[] {
  const names = (Array.isArray(entries) ? entries : []).flatMap((e: unknown) => {
    const branch = typeof e === 'object' && e !== null ? (e as { branch?: unknown }).branch : undefined;
    return typeof branch === 'string' && branch !== '' ? [branch] : [];
  });
  return sortedCopy([...new Set(names)], compareStrings);
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sorted copy (`toSorted` is ES2023 and this package supports Node 18): the sorted array is built here and the input is never changed. */
function sortedCopy<T>(items: readonly T[], cmp: (a: T, b: T) => number): readonly T[] {
  return Array.from(items).sort(cmp);
}

/**
 * Every variable name in `rawKeep` (the keep.lock exactly as the service returned it) with its branches, sorted by name.
 * `undefined` when `rawKeep` is absent or is not a keep.lock: the caller must say "unknown", never "none".
 */
export function variableBranchesFromKeep(rawKeep: string | undefined): readonly VariableBranches[] | undefined {
  if (rawKeep === undefined || rawKeep === '') return undefined;
  const parsed = parseJson(rawKeep);
  const variables = typeof parsed === 'object' && parsed !== null ? (parsed as { variables?: unknown }).variables : undefined;
  if (typeof variables !== 'object' || variables === null) return undefined;
  const rows = Object.entries(variables).map(([name, entries]) => ({ name, branches: branchesOf(entries) }));
  return sortedCopy(rows, (a, b) => compareStrings(a.name, b.name));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
