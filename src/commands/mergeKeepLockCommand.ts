/**
 * `capy merge-keep-lock <ancestor> <ours> <theirs> [ours-label] [base-label] [theirs-label] [marker-size]`:
 * the entry point git calls as the keep.lock merge driver (see
 * `git/keepLockMergeDriver.ts`). Hidden from help: it is for git, not for people.
 * The optional labels and marker size are git's `%X %S %Y %L`, used only so a
 * conflict is marked the way git's own text merge would mark it.
 */
import { runKeepLockMergeDriver } from '../git/keepLockMergeDriver';

/** Runs the merge and returns the exit code git reads: 0 merged, non-zero conflict (with markers left in `ours`). */
export function mergeKeepLockCommand(
  ancestor: string,
  ours: string,
  theirs: string,
  ourLabel?: string,
  baseLabel?: string,
  theirLabel?: string,
  markerSize?: string,
): number {
  return runKeepLockMergeDriver(
    { ancestor, ours, theirs },
    (line) => {
      process.stderr.write(`${line}\n`);
    },
    { ours: ourLabel, base: baseLabel, theirs: theirLabel, markerSize },
  );
}
