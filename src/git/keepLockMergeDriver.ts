/**
 * The git merge driver for keep.lock: `<cmd> %O %A %B`.
 *
 * Git hands it the ancestor (%O), our version (%A) and their version (%B) as
 * files. On a clean merge the merged keep.lock is written over %A and the exit
 * code is 0.
 *
 * Whenever the merge cannot complete (a real disagreement, an invalid input,
 * a failed write) %A is left exactly as git's own text merge would leave it,
 * conflict markers included, and the exit code is `KEEP_LOCK_MERGE_CONFLICT_EXIT`.
 * A conflict must never leave %A as plain ours: `git add && git commit` would
 * then silently drop the other side.
 *
 * Non-interactive by construction: it reads three files, writes one, and
 * needs no login, network, terminal or working directory.
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { mergeKeepLockText, type KeepLockConflictReason } from './keepLockMerge';
import { KEEP_LOCK_MERGE_CONFLICT_EXIT } from './keepLockMergeInstall';

export interface KeepLockMergeDriverPaths {
  readonly ancestor: string;
  readonly ours: string;
  readonly theirs: string;
}

/**
 * What git tells the driver about the merge (`%X %S %Y %L`): the names it puts
 * in its own conflict markers, and the marker length. All optional; anything
 * absent, or left as git's unexpanded placeholder by an old git, falls back to
 * a plain default.
 */
export interface KeepLockMergeDriverLabels {
  readonly ours?: string;
  readonly base?: string;
  readonly theirs?: string;
  readonly markerSize?: string;
}

// COPY-FLAG
const CONFLICT_PREFIX = 'keep.lock conflict';
// COPY-FLAG
const WRITE_FAILED_CODE = 'WRITE_FAILED';

/** The file's text, or undefined when it cannot be read. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/** One stderr line for a reason: the prefix, then its code and whichever of its parts it has. Never a value. */
export function describeConflict(reason: KeepLockConflictReason): string {
  const parts = [reason.code, reason.side, reason.name, reason.branch, reason.field, reason.provider, reason.target];
  return [CONFLICT_PREFIX, ...parts.filter((p): p is string => p !== undefined)].join(' ');
}

function writeText(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// COPY-FLAG
const DEFAULT_OURS_LABEL = 'ours';
// COPY-FLAG
const DEFAULT_BASE_LABEL = 'base';
// COPY-FLAG
const DEFAULT_THEIRS_LABEL = 'theirs';

/** A label git passed, unless it is missing or still an unexpanded `%` placeholder. */
function labelOr(label: string | undefined, fallback: string): string {
  return label === undefined || label === '' || label.startsWith('%') ? fallback : label;
}

const oursLabel = (labels: KeepLockMergeDriverLabels): string => labelOr(labels.ours, DEFAULT_OURS_LABEL);
const baseLabel = (labels: KeepLockMergeDriverLabels): string => labelOr(labels.base, DEFAULT_BASE_LABEL);
const theirsLabel = (labels: KeepLockMergeDriverLabels): string => labelOr(labels.theirs, DEFAULT_THEIRS_LABEL);

function markerLength(markerSize: string | undefined): number {
  const n = Number.parseInt(markerSize ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : 7;
}

const endWithNewline = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** Both whole files as one conflict, in git's marker format: the last resort when git's own text merge cannot run. */
function wholeFileConflict(ours: string, theirs: string, labels: KeepLockMergeDriverLabels): string {
  const size = markerLength(labels.markerSize);
  return [
    `${'<'.repeat(size)} ${oursLabel(labels)}\n`,
    endWithNewline(ours),
    `${'='.repeat(size)}\n`,
    endWithNewline(theirs),
    `${'>'.repeat(size)} ${theirsLabel(labels)}\n`,
  ].join('');
}

/**
 * Leaves in %A what git's own text merge of the three files would: asks
 * `git merge-file` (which edits %A in place, markers included). If that cannot
 * run, writes both whole files as one conflict instead. Never leaves plain ours.
 */
function leaveTextMerge(
  paths: KeepLockMergeDriverPaths,
  ours: string,
  theirs: string,
  labels: KeepLockMergeDriverLabels,
): void {
  const r = spawnSync(
    'git',
    [
      'merge-file',
      '-L', oursLabel(labels),
      '-L', baseLabel(labels),
      '-L', theirsLabel(labels),
      `--marker-size=${markerLength(labels.markerSize)}`,
      paths.ours,
      paths.ancestor,
      paths.theirs,
    ],
    { stdio: 'ignore' },
  );
  // `git merge-file` exits with the number of conflicts (0 to 127), or 255 when it could not merge at all.
  const merged = r.error === undefined && r.status !== null && r.status >= 0 && r.status <= 127;
  if (!merged) writeText(paths.ours, wholeFileConflict(ours, theirs, labels));
}

/** The conflict reasons for an input that cannot be read at all. */
function unreadableReasons(
  ancestor: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
): readonly KeepLockConflictReason[] {
  const sides = [['base', ancestor], ['ours', ours], ['theirs', theirs]] as const;
  return sides.flatMap(([side, text]) => (text === undefined ? [{ code: 'INVALID_KEEP_LOCK' as const, side }] : []));
}

/**
 * Runs the merge. Returns the process exit code: 0 merged and written to the
 * ours path; `KEEP_LOCK_MERGE_CONFLICT_EXIT` conflict, with git's text merge
 * (markers) left in the ours path.
 */
export function runKeepLockMergeDriver(
  paths: KeepLockMergeDriverPaths,
  stderr: (line: string) => void,
  labels: KeepLockMergeDriverLabels = {},
): number {
  const ancestor = readText(paths.ancestor);
  const ours = readText(paths.ours);
  const theirs = readText(paths.theirs);
  if (ancestor === undefined || ours === undefined || theirs === undefined) {
    // An ancestor path that cannot be read is invalid input; only an empty file means "no ancestor".
    unreadableReasons(ancestor, ours, theirs).forEach((r) => stderr(describeConflict(r)));
    if (ours !== undefined && theirs !== undefined) leaveTextMerge(paths, ours, theirs, labels);
    return KEEP_LOCK_MERGE_CONFLICT_EXIT;
  }
  const result = mergeKeepLockText(ancestor, ours, theirs);
  if ('merged' in result && writeText(paths.ours, result.merged)) return 0;
  if ('conflict' in result) result.conflict.forEach((r) => stderr(describeConflict(r)));
  else {
    stderr(`${CONFLICT_PREFIX} ${WRITE_FAILED_CODE}`);
    // A failed write may have cut the file short: put ours back before git's text merge reads it.
    writeText(paths.ours, ours);
  }
  leaveTextMerge(paths, ours, theirs, labels);
  return KEEP_LOCK_MERGE_CONFLICT_EXIT;
}
