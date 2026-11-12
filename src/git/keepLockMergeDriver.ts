/**
 * The git merge driver for keep.lock: `<cmd> %O %A %B`.
 *
 * Git hands it the ancestor (%O), our version (%A) and their version (%B) as
 * files. On a clean merge the merged keep.lock is written over %A and the exit
 * code is 0. On a conflict %A is left exactly as it was, the reasons go to
 * stderr, and the exit code is 1, which makes git mark the file conflicted the
 * way it does for any text conflict.
 *
 * Non-interactive by construction: it reads three files, writes one, and
 * needs no login, network, terminal or working directory.
 */
import { readFileSync, writeFileSync } from 'fs';
import { mergeKeepLockText, type KeepLockConflictReason } from './keepLockMerge';

export interface KeepLockMergeDriverPaths {
  readonly ancestor: string;
  readonly ours: string;
  readonly theirs: string;
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

function writeMerged(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** The reasons for an ours or theirs file that cannot be read at all. */
function unreadableReasons(ours: string | undefined, theirs: string | undefined): readonly KeepLockConflictReason[] {
  return [
    ...(ours === undefined ? [{ code: 'INVALID_KEEP_LOCK' as const, side: 'ours' as const }] : []),
    ...(theirs === undefined ? [{ code: 'INVALID_KEEP_LOCK' as const, side: 'theirs' as const }] : []),
  ];
}

/**
 * Runs the merge. Returns the process exit code: 0 merged and written to the
 * ours path, 1 conflict (nothing written).
 */
export function runKeepLockMergeDriver(paths: KeepLockMergeDriverPaths, stderr: (line: string) => void): number {
  const ancestor = readText(paths.ancestor);
  const ours = readText(paths.ours);
  const theirs = readText(paths.theirs);
  if (ours === undefined || theirs === undefined) {
    unreadableReasons(ours, theirs).forEach((r) => stderr(describeConflict(r)));
    return 1;
  }
  const result = mergeKeepLockText(ancestor ?? null, ours, theirs);
  if ('conflict' in result) {
    result.conflict.forEach((r) => stderr(describeConflict(r)));
    return 1;
  }
  if (!writeMerged(paths.ours, result.merged)) {
    stderr(`${CONFLICT_PREFIX} ${WRITE_FAILED_CODE}`);
    return 1;
  }
  return 0;
}
