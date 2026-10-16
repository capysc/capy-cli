/**
 * Conflicts everywhere (CAP-717; the contract is docs/conflict-resolution.md).
 *
 * Bare `capy` is the one conflict path. It compares three versions of every variable with
 * `compareSecrets` (pinned = keep.lock, local = `.env`, remote = Capy's latest) and the person answers per
 * variable with one of FOUR choices: `pinned` | `local` | `remote` | `delete`. This module is what lets a
 * caller that is NOT at a terminal give the same answers:
 *   - the rows: `compareSecrets` rows as the protocol reports them (fingerprints only, never a value);
 *   - `conflictIdOf`: the id that binds the answers to exactly the rows they were made against;
 *   - `parseConflictFlags`: `--resolve NAME=pinned|local|remote|delete` (a Dokploy value: `NAME@TARGET=local|remote`)
 *     and `--conflict <id>`, validated with coded errors;
 *   - `gateConflicts`: "apply the answers or refuse". Off a terminal a difference stops the write (nothing is
 *     written, exit 3, JSON on stdout, prose on stderr); a rerun with the right id and an answer for every row goes on.
 *
 * Nothing here ever holds, prints or throws a value.
 */
import { createHash } from 'crypto';
import { Option, type Command } from 'commander';
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import type { DiffResult } from './compareSecrets';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Bare `capy`'s four choices for a variable. */
export type Resolution = 'pinned' | 'local' | 'remote' | 'delete';
/** A Dokploy value has two: deliver Capy's (`local`) or keep the platform's and skip it (`remote`). */
export type TargetResolution = 'local' | 'remote';
/** Answers by key: `NAME` for a folder row, `NAME@TARGET` for a platform row. */
export type Resolutions = Readonly<Record<string, Resolution>>;

/** One `compareSecrets` row, as the protocol reports it. Fingerprints are `null` where there is no value. */
export interface SourceConflict {
  readonly name: string;
  readonly project: string;
  readonly branch: string;
  readonly type: DiffResult['type'];
  readonly pinned: string | null;
  readonly local: string | null;
  readonly remote: string | null;
}

/** A platform row (Dokploy): Capy's value against the one live on the platform. Only `local` / `remote` are allowed answers. */
export interface TargetConflict {
  readonly name: string;
  readonly target: string;
  readonly pinned: string | null;
  readonly local: string | null;
  readonly remote: string | null;
}

export type Conflict = SourceConflict | TargetConflict;

export const isTargetConflict = (c: Conflict): c is TargetConflict => 'target' in c;

/** The key an answer for `conflict` is given under. */
export const resolveKeyOf = (conflict: Conflict): string => (isTargetConflict(conflict) ? `${conflict.name}@${conflict.target}` : conflict.name);

/** Where the rows were found: what the id binds. `serverKeepHash` is the server's keep hash for the branch at the read. */
export interface ConflictView {
  readonly project: string;
  readonly branch: string;
  readonly serverKeepHash: string;
}

export interface ConflictScope extends ConflictView {
  readonly conflicts: readonly Conflict[];
}

/** The `compareSecrets` rows of `diffs` as protocol rows for `view`. */
export function sourceRowsOf(diffs: readonly DiffResult[], view: ConflictView): readonly SourceConflict[] {
  return diffs.map((d) => ({
    name: d.variable,
    project: view.project,
    branch: view.branch,
    type: d.type,
    pinned: d.pinned ?? null,
    local: d.local ?? null,
    remote: d.remote ?? null,
  }));
}

// ── The id ──────────────────────────────────────────────────────────────────

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sorted copy (`toSorted` is ES2023; this package targets older Node): the input is never changed. */
const sortedBy = <T>(items: readonly T[], compare: (a: T, b: T) => number): readonly T[] => Array.from(items).sort(compare);

const orderKey = (c: Conflict): string =>
  [isTargetConflict(c) ? 't' : 's', c.name, isTargetConflict(c) ? c.target : '', isTargetConflict(c) ? '' : c.project, isTargetConflict(c) ? '' : c.branch].join('\u0000');

/** The rows in the one order the id and the payload use. */
export const sortedConflicts = (conflicts: readonly Conflict[]): readonly Conflict[] => sortedBy(conflicts, (a, b) => byText(orderKey(a), orderKey(b)));

const canonical = (c: Conflict) => ({
  name: c.name,
  target: isTargetConflict(c) ? c.target : null,
  type: isTargetConflict(c) ? null : c.type,
  pinned: c.pinned,
  local: c.local,
  remote: c.remote,
});

/** Scopes of one (project, branch, server keep hash) become one scope. */
function mergedScopes(scopes: readonly ConflictScope[]): readonly ConflictScope[] {
  const keyOf = (s: ConflictScope): string => [s.project, s.branch, s.serverKeepHash].join('\u0000');
  return [...new Set(scopes.map(keyOf))].map((key) => {
    const group = scopes.filter((s) => keyOf(s) === key);
    return { ...group[0], conflicts: group.flatMap((s) => s.conflicts) };
  });
}

/**
 * `c_` + the first 12 hex of sha256 over the canonical JSON of the project, branch, the server's keep hash
 * for the branch and the sorted rows. A run that looked at several (project, branch) places binds all of
 * them: the same object per place, sorted. Anything that moved gives another id.
 */
export function conflictIdOf(scopes: readonly ConflictScope[]): string {
  const bound = sortedBy(
    mergedScopes(scopes).map((s) => ({ project: s.project, branch: s.branch, server_keep_hash: s.serverKeepHash, conflicts: sortedConflicts(s.conflicts).map(canonical) })),
    (a, b) => byText(`${a.project}\u0000${a.branch}\u0000${a.server_keep_hash}`, `${b.project}\u0000${b.branch}\u0000${b.server_keep_hash}`),
  );
  const body = bound.length === 1 ? bound[0] : bound;
  return `c_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
}

export const CONFLICT_ID_FORMAT = /^c_[0-9a-f]{12}$/;

// ── The payload and the refusal ─────────────────────────────────────────────

/** Exactly what stdout carries: `ok:false`, the code, the id, the rows. A preview adds `dry_run: true`. */
export interface ConflictPayload {
  readonly ok: false;
  readonly code: typeof ERROR_CODES.SECRETS_CONFLICT | typeof ERROR_CODES.SECRETS_CONFLICT_STALE;
  readonly conflict_id: string;
  readonly conflicts: readonly Conflict[];
  readonly dry_run?: true;
}

/** A write was stopped for a decision. Carries the payload; `code` is `SECRETS_CONFLICT` or `SECRETS_CONFLICT_STALE`. */
export class ConflictRefusal extends CapyError {
  constructor(
    readonly payload: ConflictPayload,
    message: string,
  ) {
    super(message, payload.code, { names: [...new Set(payload.conflicts.map((c) => c.name))], conflict_id: payload.conflict_id });
    this.name = 'ConflictRefusal';
  }
}

export const isConflictRefusal = (err: unknown): err is ConflictRefusal => err instanceof ConflictRefusal;

const namesOf = (conflicts: readonly Conflict[]): string => [...new Set(conflicts.map((c) => (isTargetConflict(c) ? `${c.name} on ${c.target}` : c.name)))].join(', ');

/** The refusal for `listed` (of the rows in `scopes`, whose id it carries). */
export function conflictRefusalFor(
  code: ConflictPayload['code'],
  scopes: readonly ConflictScope[],
  listed: readonly Conflict[] = scopes.flatMap((s) => s.conflicts),
  opts: { readonly dryRun?: boolean } = {},
): ConflictRefusal {
  const message =
    code === ERROR_CODES.SECRETS_CONFLICT_STALE
      ? `${namesOf(listed)}: the state changed since that id was issued. Nothing was written.` // COPY-FLAG
      : `${namesOf(listed)} differ between this folder and Capy. Nothing was written.`; // COPY-FLAG
  return new ConflictRefusal(
    { ok: false, code, conflict_id: conflictIdOf(scopes), conflicts: sortedConflicts(listed), ...(opts.dryRun === true ? { dry_run: true as const } : {}) },
    message,
  );
}

/** stdout: the payload as JSON (plus the caller's `extra` fields, e.g. a plan), nothing else. stderr: one line saying what to do. */
export function printConflictRefusal(refusal: ConflictRefusal, extra: object = {}): void {
  console.log(JSON.stringify({ ...refusal.payload, ...extra }, null, 2));
  console.error(refusal.message);
  console.error('Rerun with --resolve NAME=pinned|local|remote|delete for each name (NAME@TARGET=local|remote for a platform value) and --conflict <conflict_id>.'); // COPY-FLAG
}

/** Prints a `ConflictRefusal` and exits `EXIT_NEEDS_INPUT`; any other value is left to the caller. */
export function exitOnConflictRefusal(err: unknown): void {
  if (!isConflictRefusal(err)) return;
  printConflictRefusal(err);
  process.exit(EXIT_NEEDS_INPUT);
}

// ── The flags ───────────────────────────────────────────────────────────────

/** `--resolve` (repeatable) and `--conflict`, as commander hands them over. */
export interface RawConflictFlags {
  readonly resolve?: readonly string[];
  readonly conflict?: string;
}

export interface ConflictFlags {
  readonly resolutions: Resolutions;
  readonly conflictId: string | undefined;
}

export const NO_CONFLICT_FLAGS: ConflictFlags = { resolutions: {}, conflictId: undefined };

/** Whether the caller passed either flag. */
export const hasConflictFlags = (flags: ConflictFlags): boolean => flags.conflictId !== undefined || Object.keys(flags.resolutions).length > 0;

const RESOLVE_FORM = /^([A-Za-z_][A-Za-z0-9_]*)(?:@([^=@\s]+))?=(pinned|local|remote|delete)$/;

const invalid = (message: string): CapyError => new CapyError(message, ERROR_CODES.SECRETS_RESOLVE_INVALID);

function parseResolve(raw: string): readonly [string, Resolution] {
  const m = RESOLVE_FORM.exec(raw);
  if (m === null) throw invalid('--resolve takes NAME=pinned|local|remote|delete (NAME@TARGET=local|remote for a platform value).'); // COPY-FLAG
  // A platform value has no pinned snapshot to go back to and nothing to delete here.
  if (m[2] !== undefined && m[3] !== 'local' && m[3] !== 'remote') throw invalid('--resolve NAME@TARGET takes local or remote.'); // COPY-FLAG
  return [m[2] === undefined ? m[1] : `${m[1]}@${m[2]}`, m[3] as Resolution];
}

/**
 * Validates `--resolve` / `--conflict`. Throws a coded `CapyError`: `SECRETS_RESOLVE_INVALID` for a
 * bad form (or the same key answered twice, differently, or a malformed id), and
 * `SECRETS_RESOLVE_NEEDS_CONFLICT` for `--resolve` without `--conflict`. There is no resolve-all.
 */
export function parseConflictFlags(raw: RawConflictFlags): ConflictFlags {
  const pairs = (raw.resolve ?? []).map(parseResolve);
  const resolutions: Resolutions = Object.fromEntries(pairs);
  const contradicts = pairs.some(([key, choice]) => resolutions[key] !== choice);
  if (contradicts) throw invalid('--resolve gives one name two different answers.'); // COPY-FLAG
  if (raw.conflict !== undefined && !CONFLICT_ID_FORMAT.test(raw.conflict)) throw invalid('--conflict takes the conflict_id a conflict returned.'); // COPY-FLAG
  if (pairs.length > 0 && raw.conflict === undefined) {
    throw new CapyError('--resolve needs --conflict <conflict_id>: an answer is only valid for the rows it was made against.', ERROR_CODES.SECRETS_RESOLVE_NEEDS_CONFLICT); // COPY-FLAG
  }
  return { resolutions, conflictId: raw.conflict };
}

/**
 * `parseConflictFlags` for a command: a bad flag is refused (exit 1) with its code, JSON on stdout under
 * `--json`, the sentence on stderr otherwise. Nothing has been read or written yet.
 */
export function conflictFlagsOrExit(raw: RawConflictFlags, json: boolean): ConflictFlags {
  try {
    return parseConflictFlags(raw);
  } catch (err) {
    const coded = err instanceof CapyError ? err : invalid('Invalid --resolve or --conflict.'); // COPY-FLAG
    if (json) console.log(JSON.stringify({ ok: false, code: coded.code, error: coded.message }, null, 2));
    else console.error(coded.message);
    return process.exit(1);
  }
}

// ── Apply the answers, or refuse ────────────────────────────────────────────

/**
 * The decision step off a terminal. `scopes` hold every row found.
 *
 *   - none → nothing to answer;
 *   - no `--conflict` → `SECRETS_CONFLICT` with all of them;
 *   - `--conflict` that is not the id of exactly these → `SECRETS_CONFLICT_STALE` with the fresh ones (new id);
 *   - the id matches but a row has no `--resolve` → `SECRETS_CONFLICT` with the remaining ones
 *     (the id of the whole set, so the rerun keeps it);
 *   - otherwise the answers, keyed as given. A platform row's answer must be `local` or `remote`.
 *
 * `dryRun` reports the rows (with `dry_run: true`) and never applies. Throws `ConflictRefusal`.
 */
export function gateConflicts(flags: ConflictFlags, scopes: readonly ConflictScope[], opts: { readonly dryRun?: boolean } = {}): Resolutions {
  const all = scopes.flatMap((s) => s.conflicts);
  if (all.length === 0) return {};
  if (opts.dryRun === true) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, all, opts);
  if (flags.conflictId === undefined) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, all, opts);
  if (flags.conflictId !== conflictIdOf(scopes)) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT_STALE, scopes, all, opts);
  const open = all.filter((c) => flags.resolutions[resolveKeyOf(c)] === undefined);
  if (open.length > 0) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, open, opts);
  return Object.fromEntries(all.map((c) => [resolveKeyOf(c), flags.resolutions[resolveKeyOf(c)]]));
}

/** The folder answers of `resolutions` (keys without a target). */
export const sourceResolutions = (resolutions: Resolutions): Resolutions =>
  Object.fromEntries(Object.entries(resolutions).filter(([key]) => !key.includes('@')));

/** A platform answer together with the fingerprints it was made against: it applies to exactly that state and no other. */
export interface SeenResolution {
  readonly choice: TargetResolution;
  /** What Capy was about to deliver when the caller answered (`null`: nothing). */
  readonly local: string | null;
  /** What the platform held when the caller answered (`null`: nothing). */
  readonly remote: string | null;
}

/** `SeenResolution`s by NAME, for one target. */
export type SeenResolutions = Readonly<Record<string, SeenResolution>>;

/**
 * Binds the platform answers in `resolutions` to the rows they answered: each carries the `local` / `remote`
 * fingerprints of its row. A key that answers no listed row, or answers it with something other than
 * `local` / `remote`, is dropped. Pure; fingerprints only.
 */
export function seenResolutions(resolutions: Resolutions, conflicts: readonly Conflict[]): SeenResolutions {
  return Object.fromEntries(
    conflicts.flatMap((c) => {
      const choice = resolutions[resolveKeyOf(c)];
      return choice === 'local' || choice === 'remote' ? [[resolveKeyOf(c), { choice, local: c.local, remote: c.remote }] as const] : [];
    }),
  );
}

/** The answers for `target`, keyed by bare NAME. */
export const targetResolutions = <T>(resolutions: Readonly<Record<string, T>>, target: string): Readonly<Record<string, T>> =>
  Object.fromEntries(
    Object.entries(resolutions)
      .filter(([key]) => key.endsWith(`@${target}`))
      .map(([key, choice]) => [key.slice(0, key.length - target.length - 1), choice]),
  );

// ── The command line ────────────────────────────────────────────────────────

const collectResolve = (value: string, previous: string[]): string[] => [...previous, value];

/** `--resolve NAME=pinned|local|remote|delete` (repeatable). Every write command takes it; the root program takes it for bare `capy`. */
export const resolveOption = (): Option =>
  new Option(
    '--resolve <NAME=pinned|local|remote|delete>',
    'answer a difference from Capy: pinned, local, remote or delete (secrets set: local or remote); NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict)', // COPY-FLAG
  )
    .default([])
    .argParser(collectResolve);

/** `--conflict <conflict_id>`: binds `--resolve` to the rows that were seen. */
export const conflictOption = (): Option =>
  new Option('--conflict <conflict_id>', 'the conflict_id a conflict returned: binds --resolve to what was seen'); // COPY-FLAG

/**
 * `--resolve` / `--conflict` as typed, wherever they were typed: a flag the root program took (it takes
 * them for bare `capy`) is found through `optsWithGlobals`.
 */
export function rawConflictFlagsOf(command: Pick<Command, 'optsWithGlobals'>): RawConflictFlags {
  const opts = command.optsWithGlobals() as { resolve?: readonly string[]; conflict?: string };
  return { resolve: opts.resolve, conflict: opts.conflict };
}
