/**
 * Conflicts everywhere (CAP-717; the contract is docs/conflict-resolution.md).
 *
 * ONE module for what every write command shares when two sides changed the same name:
 *   - the vocabulary: a conflict is a NAME where the other side moved since `pinned`
 *     and differs from `yours`; fingerprints only (the 16-hex `value_hash`), never a value;
 *   - `conflictIdOf`: the id that binds a decision to the exact conflicts it was made against;
 *   - `parseConflictFlags`: `--resolve NAME=mine|theirs` (target form `NAME@TARGET=...`) and
 *     `--conflict <id>`, validated with coded errors;
 *   - `gateConflicts`: "apply the resolutions or refuse". Off a terminal a conflict stops the
 *     write (nothing is written, exit 3, JSON on stdout, prose on stderr); a rerun with the
 *     right id and a decision for every conflicting name goes on.
 *
 * No command keeps a copy of any of this. Nothing here ever holds, prints or throws a value.
 */
import { createHash } from 'crypto';
import { Option, type Command } from 'commander';
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The caller's answer for a name the other side changed under it: keep theirs, or overwrite with mine. */
export type Resolution = 'mine' | 'theirs';
/** Decisions by key: `NAME` for a source conflict, `NAME@TARGET` for a target conflict. */
export type Resolutions = Readonly<Record<string, Resolution>>;

/** Folder (or earlier read) against the Capy server. Fingerprints are `null` where there is no value (absent, or a deletion). */
export interface SourceConflict {
  readonly kind: 'source';
  readonly name: string;
  readonly project: string;
  readonly branch: string;
  readonly pinned: string | null;
  readonly yours: string | null;
  readonly theirs: string | null;
  /** When the server's value last changed, if the server says. */
  readonly theirs_changed_at?: string;
}

/** Capy against the platform's live value (Dokploy). */
export interface TargetConflict {
  readonly kind: 'target';
  readonly name: string;
  readonly target: string;
  readonly pinned: string | null;
  readonly yours: string | null;
  readonly theirs: string | null;
}

export type Conflict = SourceConflict | TargetConflict;

/** The key a decision for `conflict` is given under. */
export const resolveKeyOf = (conflict: Conflict): string => (conflict.kind === 'source' ? conflict.name : `${conflict.name}@${conflict.target}`);

/** Where conflicts were found: what the id binds. `serverKeepHash` is the server's keep hash for the branch at the read. */
export interface ConflictScope {
  readonly project: string;
  readonly branch: string;
  readonly serverKeepHash: string;
  readonly conflicts: readonly Conflict[];
}

/** What a commit path hands its decider: where it is looking. */
export interface ConflictView {
  readonly project: string;
  readonly branch: string;
  readonly serverKeepHash: string;
}

/** Decides the conflicts a write found (or throws a `ConflictRefusal`). Receives only the source conflicts of one scope. */
export type ConflictDecider = (found: readonly SourceConflict[], view: ConflictView) => Resolutions | Promise<Resolutions>;

// ── The id ──────────────────────────────────────────────────────────────────

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sorted copy (`toSorted` is ES2023; this package targets older Node): the input is never changed. */
const sortedBy = <T>(items: readonly T[], compare: (a: T, b: T) => number): readonly T[] => Array.from(items).sort(compare);

const orderKey = (c: Conflict): string => [c.kind, c.name, c.kind === 'target' ? c.target : '', c.kind === 'source' ? c.project : '', c.kind === 'source' ? c.branch : ''].join('\u0000');

/** The conflicts in the one order the id and the payload use. */
export const sortedConflicts = (conflicts: readonly Conflict[]): readonly Conflict[] => sortedBy(conflicts, (a, b) => byText(orderKey(a), orderKey(b)));

const canonical = (c: Conflict) => ({
  kind: c.kind,
  name: c.name,
  target: c.kind === 'target' ? c.target : null,
  pinned: c.pinned,
  yours: c.yours,
  theirs: c.theirs,
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
 * `c_` + the first 12 hex of sha256 over the canonical JSON of the project, branch, the server's
 * keep hash for the branch, and the sorted conflicts (kind, name, target, pinned, yours, theirs).
 * A run that looked at several (project, branch) places binds all of them: the same object per
 * place, sorted. Anything that moved gives another id.
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

/** Exactly what stdout carries: `ok:false`, the code, the id, the conflicts. A preview adds `dry_run: true`. */
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

const namesOf = (conflicts: readonly Conflict[]): string => [...new Set(conflicts.map((c) => (c.kind === 'target' ? `${c.name} on ${c.target}` : c.name)))].join(', ');

/** The refusal for `listed` (of the conflicts in `scopes`, whose id it carries). */
export function conflictRefusalFor(
  code: ConflictPayload['code'],
  scopes: readonly ConflictScope[],
  listed: readonly Conflict[] = scopes.flatMap((s) => s.conflicts),
  opts: { readonly dryRun?: boolean } = {},
): ConflictRefusal {
  const message =
    code === ERROR_CODES.SECRETS_CONFLICT_STALE
      ? `${namesOf(listed)}: the conflict changed since that id was issued. Nothing was written.` // COPY-FLAG
      : `${namesOf(listed)} changed since this was last synced. Nothing was written.`; // COPY-FLAG
  return new ConflictRefusal(
    { ok: false, code, conflict_id: conflictIdOf(scopes), conflicts: sortedConflicts(listed), ...(opts.dryRun === true ? { dry_run: true as const } : {}) },
    message,
  );
}

/** stdout: the payload as JSON (plus the caller's `extra` fields, e.g. a plan), nothing else. stderr: one line saying what to do. */
export function printConflictRefusal(refusal: ConflictRefusal, extra: object = {}): void {
  console.log(JSON.stringify({ ...refusal.payload, ...extra }, null, 2));
  console.error(refusal.message);
  console.error('Rerun with --resolve NAME=mine|theirs for each name (NAME@TARGET for a target) and --conflict <conflict_id>.'); // COPY-FLAG
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

const RESOLVE_FORM = /^([A-Za-z_][A-Za-z0-9_]*)(?:@([^=@\s]+))?=(mine|theirs)$/;

const invalid = (message: string): CapyError => new CapyError(message, ERROR_CODES.SECRETS_RESOLVE_INVALID);

function parseResolve(raw: string): readonly [string, Resolution] {
  const m = RESOLVE_FORM.exec(raw);
  if (m === null) throw invalid('--resolve takes NAME=mine or NAME=theirs (NAME@TARGET=mine|theirs for a target).'); // COPY-FLAG
  return [m[2] === undefined ? m[1] : `${m[1]}@${m[2]}`, m[3] as Resolution];
}

/**
 * Validates `--resolve` / `--conflict`. Throws a coded `CapyError`: `SECRETS_RESOLVE_INVALID` for a
 * bad form (or the same key decided twice, differently, or a malformed id), and
 * `SECRETS_RESOLVE_NEEDS_CONFLICT` for `--resolve` without `--conflict`. There is no resolve-all.
 */
export function parseConflictFlags(raw: RawConflictFlags): ConflictFlags {
  const pairs = (raw.resolve ?? []).map(parseResolve);
  const resolutions: Resolutions = Object.fromEntries(pairs);
  const contradicts = pairs.some(([key, choice]) => resolutions[key] !== choice);
  if (contradicts) throw invalid('--resolve gives one name two different answers.'); // COPY-FLAG
  if (raw.conflict !== undefined && !CONFLICT_ID_FORMAT.test(raw.conflict)) throw invalid('--conflict takes the conflict_id a conflict returned.'); // COPY-FLAG
  if (pairs.length > 0 && raw.conflict === undefined) {
    throw new CapyError('--resolve needs --conflict <conflict_id>: a decision is only valid for the conflicts it was made against.', ERROR_CODES.SECRETS_RESOLVE_NEEDS_CONFLICT); // COPY-FLAG
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

// ── Apply the resolutions, or refuse ────────────────────────────────────────

/**
 * The decision step of every command. `scopes` hold every conflict the write found (resolved or not).
 *
 *   - none → nothing to decide;
 *   - no `--conflict` → `SECRETS_CONFLICT` with all of them;
 *   - `--conflict` that is not the id of exactly these → `SECRETS_CONFLICT_STALE` with the fresh ones (new id);
 *   - the id matches but a conflicting name has no `--resolve` → `SECRETS_CONFLICT` with the remaining ones
 *     (the id of the whole set, so the rerun keeps it);
 *   - otherwise the decisions, keyed as given.
 *
 * Throws `ConflictRefusal`; returns only decisions that cover every conflict.
 */
export function gateConflicts(flags: ConflictFlags, scopes: readonly ConflictScope[], opts: { readonly dryRun?: boolean } = {}): Resolutions {
  const all = scopes.flatMap((s) => s.conflicts);
  if (all.length === 0) return {};
  if (flags.conflictId === undefined) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, all, opts);
  if (flags.conflictId !== conflictIdOf(scopes)) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT_STALE, scopes, all, opts);
  const open = all.filter((c) => flags.resolutions[resolveKeyOf(c)] === undefined);
  if (open.length > 0) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, open, opts);
  return Object.fromEntries(all.map((c) => [resolveKeyOf(c), flags.resolutions[resolveKeyOf(c)]]));
}

/** The decider of a `--dry-run`: any conflict is reported (with `dry_run: true`) and nothing is decided. */
export const previewDecider: ConflictDecider = (found, view) => {
  throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [{ ...view, conflicts: found }], found, { dryRun: true });
};

/** The decider for a command that follows the protocol: the flags decide, or the write is refused. */
export const protocolDecider = (flags: ConflictFlags): ConflictDecider => (found, view) => gateConflicts(flags, [{ ...view, conflicts: found }]);

/** The source decisions of `resolutions` (keys without a target). */
export const sourceResolutions = (resolutions: Resolutions): Resolutions =>
  Object.fromEntries(Object.entries(resolutions).filter(([key]) => !key.includes('@')));

/** A decision together with the fingerprints it was made against: it applies to exactly that state and no other. */
export interface SeenResolution {
  readonly choice: Resolution;
  /** What the other side held when the caller decided (`null`: nothing). */
  readonly theirs: string | null;
  /** What was about to be written when the caller decided. */
  readonly yours: string | null;
}

/** `SeenResolution`s by key, in the same key form as `Resolutions`. */
export type SeenResolutions = Readonly<Record<string, SeenResolution>>;

/**
 * Binds `resolutions` to the conflicts they answered: each decision carries the `theirs` / `yours` fingerprints of
 * the conflict it was made for. A key that answers no listed conflict is dropped. Pure; fingerprints only.
 */
export function seenResolutions(resolutions: Resolutions, conflicts: readonly Conflict[]): SeenResolutions {
  return Object.fromEntries(
    conflicts.flatMap((c) => {
      const choice = resolutions[resolveKeyOf(c)];
      return choice === undefined ? [] : [[resolveKeyOf(c), { choice, theirs: c.theirs, yours: c.yours }] as const];
    }),
  );
}

/** The decisions for `target`, keyed by bare NAME. */
export const targetResolutions = <T>(resolutions: Readonly<Record<string, T>>, target: string): Readonly<Record<string, T>> =>
  Object.fromEntries(
    Object.entries(resolutions)
      .filter(([key]) => key.endsWith(`@${target}`))
      .map(([key, choice]) => [key.slice(0, key.length - target.length - 1), choice]),
  );

// ── The command line ────────────────────────────────────────────────────────

const collectResolve = (value: string, previous: string[]): string[] => [...previous, value];

/** `--resolve NAME=mine|theirs` (repeatable). Every write command takes it; the root program takes it for bare `capy`. */
export const resolveOption = (): Option =>
  new Option(
    '--resolve <NAME=mine|theirs>',
    'decide a conflict: keep your value (mine) or theirs; NAME@TARGET=... for a deploy target (repeatable, needs --conflict)', // COPY-FLAG
  )
    .default([])
    .argParser(collectResolve);

/** `--conflict <conflict_id>`: binds `--resolve` to the conflicts that were seen. */
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
