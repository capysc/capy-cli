/**
 * `capy merge-keep-lock <ancestor> <ours> <theirs>`: the entry point git calls
 * as the keep.lock merge driver (see `git/keepLockMergeDriver.ts`). Hidden from
 * help: it is for git, not for people.
 */
import { runKeepLockMergeDriver } from '../git/keepLockMergeDriver';

/** Runs the merge and returns the exit code git reads: 0 merged, non-zero conflict. */
export function mergeKeepLockCommand(ancestor: string, ours: string, theirs: string): number {
  return runKeepLockMergeDriver({ ancestor, ours, theirs }, (line) => {
    process.stderr.write(`${line}\n`);
  });
}
