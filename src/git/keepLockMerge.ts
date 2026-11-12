/**
 * Three-way merge of a keep.lock, for the git merge driver.
 *
 * Git merges keep.lock as text, so two sides that touch neighbouring lines
 * conflict even when they do not disagree. This merges the FILE's meaning
 * instead: per name, per entry, per field, against the common ancestor.
 *
 * Pure: no I/O, no clock, nothing read from the environment. The caller
 * (`keepLockMergeDriver.ts`) reads and writes the files; the merged file is
 * serialized by `serializeKeep`, the one writer the CLI itself uses, so the
 * result is byte-identical to what the CLI would write for the same content.
 *
 * Every conflict carries a stable `code`. Nothing here ever decides anything
 * from a message.
 */
import { serializeKeep } from '../files/fileManager';
import type { KeepFile } from '../types/index';

type Obj = { readonly [key: string]: unknown };

export type KeepLockConflictCode =
  /** A side is not a valid keep.lock (or its JSON does not parse). Never silently picked. */
  | 'INVALID_KEEP_LOCK'
  /** A top-level identity field (`version`, `org_id`, `project_id`, `project_name`) was changed differently on both sides. */
  | 'TOP_LEVEL_DIVERGED'
  /** A top-level field the CLI's writer does not know. Writing the merge would drop it, so a person decides. */
  | 'UNKNOWN_TOP_LEVEL_FIELD'
  /** `deploy_revision` is not a count that can only grow, so its two sides cannot be added. */
  | 'DEPLOY_REVISION_UNORDERABLE'
  /** One side removed an entry (or a name) that the other side changed. */
  | 'ENTRY_REMOVED_AND_CHANGED'
  /** The same entry's `value_hash` was changed to different things on the two sides: a real disagreement. */
  | 'VALUE_HASH_DIVERGED'
  /** `changed_at` differs on both sides and the two dates cannot be ordered. */
  | 'CHANGED_AT_UNORDERABLE'
  /** Any other entry field was changed differently on both sides. */
  | 'ENTRY_FIELD_DIVERGED'
  /** One side removed a delivery target that the other side changed. */
  | 'TARGET_REMOVED_AND_CHANGED'
  /** The same delivery target was changed on both sides and the two `deployed_at` cannot be ordered. */
  | 'TARGET_DIVERGED';

export type KeepLockSide = 'base' | 'ours' | 'theirs';

export interface KeepLockConflictReason {
  readonly code: KeepLockConflictCode;
  /** INVALID_KEEP_LOCK only: which input. */
  readonly side?: KeepLockSide;
  /** The variable name, when the conflict is inside one. */
  readonly name?: string;
  /** The entry's branch, when the conflict is inside one. */
  readonly branch?: string;
  /** The entry or top-level field that diverged. */
  readonly field?: string;
  readonly provider?: string;
  readonly target?: string;
}

export type KeepLockMergeResult =
  | { readonly merged: KeepFile }
  | { readonly conflict: readonly KeepLockConflictReason[] };

export type KeepLockTextMergeResult =
  | { readonly merged: string }
  | { readonly conflict: readonly KeepLockConflictReason[] };

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasons: readonly KeepLockConflictReason[] };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (...reasons: readonly KeepLockConflictReason[]): Result<never> => ({ ok: false, reasons });

/** Every result's value, or every result's reasons when any failed. */
function all<T>(results: readonly Result<T>[]): Result<readonly T[]> {
  const reasons = results.flatMap((r) => (r.ok ? [] : r.reasons));
  return reasons.length > 0 ? fail(...reasons) : ok(results.flatMap((r) => (r.ok ? [r.value] : [])));
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

type ThreeWay = { readonly agreed: true; readonly value: unknown } | { readonly agreed: false };

/** One value, three versions: the side that changed it wins; both changed it differently is not agreed. */
function threeWay(base: unknown, ours: unknown, theirs: unknown): ThreeWay {
  if (deepEqual(ours, theirs)) return { agreed: true, value: ours };
  if (deepEqual(base, ours)) return { agreed: true, value: theirs };
  if (deepEqual(base, theirs)) return { agreed: true, value: ours };
  return { agreed: false };
}

/** Milliseconds for an ISO date string, or undefined when it is not one. */
function timeOf(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The later of two timestamps, or undefined when they cannot be ordered
 * (equal, or neither parses). A value that does not parse loses to one that does.
 */
function later<T>(a: T, aTime: number | undefined, b: T, bTime: number | undefined): T | undefined {
  if (aTime === undefined && bTime === undefined) return undefined;
  if (aTime === undefined) return b;
  if (bTime === undefined) return a;
  if (aTime === bTime) return undefined;
  return aTime > bTime ? a : b;
}

// ---------------------------------------------------------------------------
// Validation: a side is a keep.lock only if the parts the merge relies on are shaped right.
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = ['version', 'org_id', 'project_id', 'project_name'] as const;

function targetKey(element: Obj): string {
  return `${element.provider as string}\u0000${element.target as string}`;
}

function validTargets(targets: unknown): boolean {
  if (targets === undefined) return true;
  if (!Array.isArray(targets)) return false;
  const elements: readonly unknown[] = targets;
  const shaped = elements.every((e) => isObj(e) && typeof e.provider === 'string' && typeof e.target === 'string');
  return shaped && unique(elements.map((e) => targetKey(e as Obj))).length === elements.length;
}

function validEntries(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  const list: readonly unknown[] = entries;
  const shaped = list.every(
    (e) =>
      isObj(e) &&
      typeof e.resource_id === 'string' &&
      typeof e.value_hash === 'string' &&
      (e.branch === undefined || typeof e.branch === 'string') &&
      validTargets(e.targets),
  );
  return shaped && unique(list.map((e) => branchKey(e as Obj))).length === list.length;
}

function validKeep(raw: unknown): raw is Obj {
  if (!isObj(raw)) return false;
  if (!REQUIRED_STRING_FIELDS.every((f) => typeof raw[f] === 'string')) return false;
  const variables = raw.variables;
  return isObj(variables) && Object.values(variables).every(validEntries);
}

/** What identifies an entry within a name: its branch (an entry with no branch is the `''` branch). */
function branchKey(entry: Obj): string {
  return typeof entry.branch === 'string' ? entry.branch : '';
}

// ---------------------------------------------------------------------------
// Top-level fields
// ---------------------------------------------------------------------------

/** Names the file's own writer emits besides `variables` and the constant `_comment`. */
const IDENTITY_FIELDS: readonly string[] = REQUIRED_STRING_FIELDS;
const HANDLED_TOP_LEVEL: ReadonlySet<string> = new Set(['_comment', 'variables', 'deploy_revision', ...IDENTITY_FIELDS]);

function mergeIdentityField(base: Obj, ours: Obj, theirs: Obj, field: string): Result<unknown> {
  const three = threeWay(base[field], ours[field], theirs[field]);
  return three.agreed ? ok(three.value) : fail({ code: 'TOP_LEVEL_DIVERGED', field });
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * `deploy_revision` counts forced redeploys: `touchDeployKeep` raises it by
 * exactly one, nothing lowers it, and it is excluded from the keep hash. Two
 * sides that each redeployed since the ancestor each did so, so the merged
 * count is the ancestor's plus both sides' increases. A side below the
 * ancestor, or a value that is not a count, is not that kind of field: conflict.
 */
function mergeDeployRevision(base: Obj, ours: Obj, theirs: Obj): Result<number | undefined> {
  const values = [base.deploy_revision, ours.deploy_revision, theirs.deploy_revision];
  if (!values.every((v) => v === undefined || isCount(v))) return fail({ code: 'DEPLOY_REVISION_UNORDERABLE', field: 'deploy_revision' });
  const [b, o, t] = values.map((v) => (isCount(v) ? v : 0));
  if (o < b || t < b) return fail({ code: 'DEPLOY_REVISION_UNORDERABLE', field: 'deploy_revision' });
  const anySide = ours.deploy_revision !== undefined || theirs.deploy_revision !== undefined;
  return ok(anySide ? o + t - b : undefined);
}

function mergeTopLevel(
  base: Obj,
  ours: Obj,
  theirs: Obj,
): Result<{ readonly identity: Obj; readonly deployRevision: number | undefined }> {
  const unknown = unique([...Object.keys(ours), ...Object.keys(theirs)]).filter((k) => !HANDLED_TOP_LEVEL.has(k));
  if (unknown.length > 0) return fail(...unknown.map((field) => ({ code: 'UNKNOWN_TOP_LEVEL_FIELD' as const, field })));
  const identity = all(IDENTITY_FIELDS.map((f) => mergeIdentityField(base, ours, theirs, f)));
  const revision = mergeDeployRevision(base, ours, theirs);
  if (!identity.ok || !revision.ok) {
    return fail(...(identity.ok ? [] : identity.reasons), ...(revision.ok ? [] : revision.reasons));
  }
  return ok({
    identity: Object.fromEntries(IDENTITY_FIELDS.map((f, i) => [f, identity.value[i]])),
    deployRevision: revision.value,
  });
}

// ---------------------------------------------------------------------------
// Delivery targets (`targets`), merged by (provider, target)
// ---------------------------------------------------------------------------

type Where = { readonly name: string; readonly branch: string };

function mergeTarget(
  where: Where,
  key: string,
  base: Obj | undefined,
  ours: Obj | undefined,
  theirs: Obj | undefined,
): Result<Obj | undefined> {
  const three = threeWay(base, ours, theirs);
  if (three.agreed) return ok(three.value as Obj | undefined);
  const id = { ...where, provider: (ours ?? theirs ?? base)?.provider as string, target: (ours ?? theirs ?? base)?.target as string };
  if (ours === undefined || theirs === undefined) {
    return fail({ code: 'TARGET_REMOVED_AND_CHANGED', ...id });
  }
  const winner = later(ours, timeOf(ours.deployed_at), theirs, timeOf(theirs.deployed_at));
  return winner === undefined ? fail({ code: 'TARGET_DIVERGED', ...id }) : ok(winner);
}

function mergeTargets(where: Where, base: unknown, ours: unknown, theirs: unknown): Result<unknown> {
  const three = threeWay(base, ours, theirs);
  if (three.agreed) return ok(three.value);
  const elementsOf = (v: unknown): readonly Obj[] => (Array.isArray(v) ? (v as readonly Obj[]) : []);
  const [b, o, t] = [elementsOf(base), elementsOf(ours), elementsOf(theirs)];
  const keys = unique([...o, ...t, ...b].map(targetKey));
  const find = (list: readonly Obj[], key: string): Obj | undefined => list.find((e) => targetKey(e) === key);
  const merged = all(keys.map((key) => mergeTarget(where, key, find(b, key), find(o, key), find(t, key))));
  if (!merged.ok) return merged;
  const elements = merged.value.flatMap((e) => (e === undefined ? [] : [e]));
  if (deepEqual(elements, ours)) return ok(ours);
  if (deepEqual(elements, theirs)) return ok(theirs);
  const present = Array.isArray(ours) || Array.isArray(theirs);
  return ok(elements.length === 0 && !present ? undefined : elements);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Known entry fields in the order `KeepVariableEntry` declares them; a merged entry that matches neither side is written in this order. */
const ENTRY_FIELD_ORDER: readonly string[] = ['resource_id', 'branch', 'value_hash', 'changed_at', 'connector', 'placeholder', 'targets'];

function orderedEntry(fields: Obj): Obj {
  const present = Object.keys(fields);
  const keys = [...ENTRY_FIELD_ORDER.filter((k) => present.includes(k)), ...present.filter((k) => !ENTRY_FIELD_ORDER.includes(k))];
  return Object.fromEntries(keys.map((k) => [k, fields[k]]));
}

function mergeEntryField(
  where: Where,
  field: string,
  base: Obj,
  ours: Obj,
  theirs: Obj,
): Result<unknown> {
  if (field === 'targets') return mergeTargets(where, base.targets, ours.targets, theirs.targets);
  const three = threeWay(base[field], ours[field], theirs[field]);
  if (three.agreed) return ok(three.value);
  if (field === 'value_hash') return fail({ code: 'VALUE_HASH_DIVERGED', ...where, field });
  if (field === 'changed_at') {
    const [a, b] = [timeOf(ours[field]), timeOf(theirs[field])];
    // The same instant written two ways says the same thing: take the one that sorts first, so either side's merge writes the same file.
    if (a !== undefined && a === b) return ok(String(ours[field]) <= String(theirs[field]) ? ours[field] : theirs[field]);
    const winner = later(ours[field], a, theirs[field], b);
    return winner === undefined ? fail({ code: 'CHANGED_AT_UNORDERABLE', ...where, field }) : ok(winner);
  }
  return fail({ code: 'ENTRY_FIELD_DIVERGED', ...where, field });
}

function mergeEntryFields(where: Where, base: Obj, ours: Obj, theirs: Obj): Result<Obj> {
  const fields = unique([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  const merged = all(fields.map((field) => {
    const r = mergeEntryField(where, field, base, ours, theirs);
    return r.ok ? ok([field, r.value] as const) : r;
  }));
  if (!merged.ok) return merged;
  const present = Object.fromEntries(merged.value.filter(([, v]) => v !== undefined));
  if (deepEqual(present, ours)) return ok(ours);
  if (deepEqual(present, theirs)) return ok(theirs);
  return ok(orderedEntry(present));
}

function mergeEntry(
  where: Where,
  base: Obj | undefined,
  ours: Obj | undefined,
  theirs: Obj | undefined,
): Result<Obj | undefined> {
  if (ours !== undefined && theirs !== undefined) return mergeEntryFields(where, base ?? {}, ours, theirs);
  // One side no longer has the entry: removed there, or never added there.
  const three = threeWay(base, ours, theirs);
  return three.agreed ? ok(three.value as Obj | undefined) : fail({ code: 'ENTRY_REMOVED_AND_CHANGED', ...where });
}

function mergeName(
  name: string,
  base: readonly Obj[],
  ours: readonly Obj[],
  theirs: readonly Obj[],
): Result<readonly Obj[]> {
  const find = (list: readonly Obj[], key: string): Obj | undefined => list.find((e) => branchKey(e) === key);
  const branches = unique([...ours, ...theirs, ...base].map(branchKey));
  const merged = all(branches.map((branch) => mergeEntry({ name, branch }, find(base, branch), find(ours, branch), find(theirs, branch))));
  return merged.ok ? ok(merged.value.flatMap((e) => (e === undefined ? [] : [e]))) : merged;
}

function mergeVariables(base: Obj, ours: Obj, theirs: Obj): Result<Record<string, readonly Obj[]>> {
  const entriesOf = (variables: Obj, name: string): readonly Obj[] => (Object.hasOwn(variables, name) ? (variables[name] as readonly Obj[]) : []);
  const names = unique([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  const merged = all(names.map((name) => {
    const r = mergeName(name, entriesOf(base, name), entriesOf(ours, name), entriesOf(theirs, name));
    // A name left with no entries is gone, unless both sides still list it (an empty list stays as it was).
    const kept = r.ok && (r.value.length > 0 || (Object.hasOwn(ours, name) && Object.hasOwn(theirs, name)));
    if (!r.ok) return r;
    return ok(kept ? ([[name, r.value]] as const) : ([] as const));
  }));
  return merged.ok ? ok(Object.fromEntries(merged.value.flat())) : merged;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function invalidSides(
  base: unknown | null,
  ours: unknown,
  theirs: unknown,
): readonly KeepLockConflictReason[] {
  const checked: ReadonlyArray<readonly [KeepLockSide, boolean]> = [
    ['base', base === null || validKeep(base)],
    ['ours', validKeep(ours)],
    ['theirs', validKeep(theirs)],
  ];
  return checked.flatMap(([side, valid]) => (valid ? [] : [{ code: 'INVALID_KEEP_LOCK' as const, side }]));
}

/**
 * Merge `ours` and `theirs` (parsed JSON) against their common ancestor
 * `base`; `null` when there is no ancestor (both sides added the file), which
 * merges exactly as an empty one would.
 */
export function mergeKeepLock(base: unknown | null, ours: unknown, theirs: unknown): KeepLockMergeResult {
  const invalid = invalidSides(base, ours, theirs);
  if (invalid.length > 0) return { conflict: invalid };
  const [b, o, t] = [base === null ? {} : (base as Obj), ours as Obj, theirs as Obj];
  const top = mergeTopLevel(b, o, t);
  const variables = mergeVariables(
    base === null ? {} : (b.variables as Obj),
    o.variables as Obj,
    t.variables as Obj,
  );
  if (!top.ok || !variables.ok) {
    return { conflict: [...(top.ok ? [] : top.reasons), ...(variables.ok ? [] : variables.reasons)] };
  }
  const merged = {
    ...top.value.identity,
    ...(top.value.deployRevision === undefined ? {} : { deploy_revision: top.value.deployRevision }),
    variables: variables.value,
  } as unknown as KeepFile;
  return { merged };
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** An ancestor file that exists but whose JSON is the literal `null` is not "no ancestor"; it is not a keep.lock. */
function presentBase(parsed: ReturnType<typeof parseJson>): ReturnType<typeof parseJson> {
  return parsed.ok && parsed.value === null ? { ok: false } : parsed;
}

/**
 * The same merge over file text, returning the text the CLI would write.
 * `base` is `null` or blank when there is no ancestor (git hands an add/add
 * merge an empty ancestor file). Text that is not JSON is INVALID_KEEP_LOCK.
 */
export function mergeKeepLockText(base: string | null, ours: string, theirs: string): KeepLockTextMergeResult {
  const baseBlank = base === null || base.trim() === '';
  const parsed = {
    base: baseBlank ? ({ ok: true, value: null } as const) : presentBase(parseJson(base)),
    ours: parseJson(ours),
    theirs: parseJson(theirs),
  };
  const unparsed = (['base', 'ours', 'theirs'] as const).filter((side) => !parsed[side].ok);
  if (unparsed.length > 0) {
    return { conflict: unparsed.map((side) => ({ code: 'INVALID_KEEP_LOCK' as const, side })) };
  }
  const values = [parsed.base, parsed.ours, parsed.theirs].map((p) => (p.ok ? p.value : null));
  const result = mergeKeepLock(values[0], values[1], values[2]);
  return 'merged' in result ? { merged: serializeKeep(result.merged) } : result;
}
