/**
 * Placeholders: a name that exists on a branch with NO value yet.
 *
 * An import connector that cannot read a value (Vercel never returns a sensitive one)
 * still records that the name exists. That record is a typed flag on the variable's
 * keep.lock entry for the branch (`KeepVariableEntry.placeholder`), with an empty
 * `value_hash`. It is NOT a value: nothing is encrypted, nothing is pushed as a secret,
 * and no sentinel string stands in for one.
 *
 * Placeholder state comes from keep.lock and nowhere else. The `.env` comment line below
 * is written for a person to read; nothing parses it back.
 *
 * Writing a real value for the branch removes the flag (`SyncEngine.mergeWithKeep`).
 */
import { deriveResourceId } from '../crypto/resourceId';
import type { KeepFile, KeepVariableEntry, PlaceholderMarker } from '../types/index';

/** One name to record as a placeholder on a branch. */
export interface PlaceholderRequest {
  readonly name: string;
  readonly marker: PlaceholderMarker;
}

/** The placeholder marker on `name`'s entry for `branch`, if it has one. */
export function placeholderOf(keep: KeepFile | null | undefined, name: string, branch: string): PlaceholderMarker | undefined {
  return keep?.variables[name]?.find((e) => e.branch === branch)?.placeholder;
}

/** Every placeholder on `branch`, by name, in keep.lock order. */
export function placeholdersOnBranch(keep: KeepFile | null | undefined, branch: string): ReadonlyArray<{ readonly name: string; readonly marker: PlaceholderMarker }> {
  return Object.entries(keep?.variables ?? {}).flatMap(([name, entries]) => {
    const marker = entries.find((e) => e.branch === branch)?.placeholder;
    return marker === undefined ? [] : [{ name, marker }];
  });
}

/** True when the entry holds a real value (a non-empty hash). */
const hasValue = (entry: KeepVariableEntry | undefined): boolean => entry !== undefined && entry.value_hash !== '' && entry.placeholder === undefined;

function sameMarker(a: PlaceholderMarker | undefined, b: PlaceholderMarker): boolean {
  return a !== undefined && a.provider === b.provider && a.reason === b.reason;
}

function withPlaceholder(keep: KeepFile, branch: string, request: PlaceholderRequest): KeepFile {
  const entries = keep.variables[request.name] ?? [];
  const current = entries.find((e) => e.branch === branch);
  // A name that already holds a real value on this branch keeps it: a placeholder is only ever the absence of one.
  if (hasValue(current)) return keep;
  if (current !== undefined && current.value_hash === '' && sameMarker(current.placeholder, request.marker)) return keep;
  const next: KeepVariableEntry = {
    ...(current ?? { resource_id: deriveResourceId(branch, request.name) }),
    branch,
    value_hash: '',
    placeholder: request.marker,
  };
  const updated = current === undefined ? [...entries, next] : entries.map((e) => (e === current ? next : e));
  return { ...keep, variables: { ...keep.variables, [request.name]: updated } };
}

/**
 * `keep` with each request recorded as a placeholder on `branch`. Returns `keep` itself when
 * nothing changes, so a repeat import writes nothing. A name that already has a value on the
 * branch is left alone.
 */
export function withPlaceholders(keep: KeepFile, branch: string, requests: readonly PlaceholderRequest[]): KeepFile {
  return requests.reduce((acc, request) => withPlaceholder(acc, branch, request), keep);
}

/** The entry with its placeholder flag removed (a real value is being written for it). */
export function withoutPlaceholder(entry: KeepVariableEntry): KeepVariableEntry {
  const { placeholder: _removed, ...rest } = entry;
  return rest;
}

/**
 * `keep` with the flag removed from `names`' entries on `branch`: a value is being written locally for them
 * (the pin itself moves on the next push). Returns `keep` itself when none of them is a placeholder.
 */
export function clearedPlaceholders(keep: KeepFile, branch: string, names: readonly string[]): KeepFile {
  const flagged = names.filter((name) => placeholderOf(keep, name, branch) !== undefined);
  if (flagged.length === 0) return keep;
  return {
    ...keep,
    variables: {
      ...keep.variables,
      ...Object.fromEntries(flagged.map((name) => [name, keep.variables[name].map((e) => (e.branch === branch ? withoutPlaceholder(e) : e))] as const)),
    },
  };
}

// ── Words ───────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Readonly<Record<string, string>> = { vercel: 'Vercel' };

const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

/** What the provider holds the value as, for the "no value yet" line. A code in, words out. */
function reasonPhrase(marker: PlaceholderMarker): string {
  const provider = providerLabel(marker.provider);
  if (marker.reason === 'sensitive_unreadable') return `sensitive in ${provider}`; // COPY-FLAG
  if (marker.reason === 'legacy_secret_unreadable') return `legacy secret in ${provider}`; // COPY-FLAG
  if (marker.reason === 'value_not_decrypted') return `not decrypted by ${provider}`; // COPY-FLAG
  return `not readable from ${provider}`; // COPY-FLAG
}

/** `no value yet (sensitive in Vercel)`. */
export function placeholderLabel(marker: PlaceholderMarker): string {
  return `no value yet (${reasonPhrase(marker)})`; // COPY-FLAG
}

/** How to give the name a value. */
export function placeholderSetCommand(name: string): string {
  return `capy edit ${name}`;
}

/**
 * The `.env` comment for a placeholder. A comment line only, never a value. It is written for a
 * person to read; nothing in Capy reads it back.
 */
export function placeholderEnvNote(name: string, marker: PlaceholderMarker): string {
  return `# ${name} — not readable from ${providerLabel(marker.provider)}; set it with: ${placeholderSetCommand(name)}`; // COPY-FLAG
}

/**
 * Every note Capy has ever written for `name`, whatever provider it named: the exact lines to
 * remove once the name has a value or is gone. Whole-line equality, not a pattern.
 */
export function placeholderEnvNoteVariants(name: string): readonly string[] {
  return Object.keys(PROVIDER_LABELS).map((provider) => placeholderEnvNote(name, { provider, reason: '' }));
}

/** Placeholders as reported (human and JSON): the name and the stable code, nothing else. */
export function placeholdersReport(placeholders: ReadonlyArray<{ readonly name: string; readonly code: string }>): ReadonlyArray<{ name: string; code: string }> {
  return placeholders.map(({ name, code }) => ({ name, code }));
}

/**
 * `capy secrets` only: the org-wide index carries each location's value hash and not the placeholder
 * flag, so a row with an empty hash is the one it can call "no value yet" (the reason is not in the index).
 */
export const NO_VALUE_YET = 'no value yet'; // COPY-FLAG

/** The line a `capy secrets` row with no value shows where its value would be. */
export function noValueYetLine(name: string): string {
  return `${NO_VALUE_YET} — set it with: ${placeholderSetCommand(name)}`; // COPY-FLAG
}
