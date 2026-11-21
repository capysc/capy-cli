import { spawnSync } from 'node:child_process';

/**
 * Git's own index and ignore rules are the tracking policy. A path already
 * in the index is tracked even if a later ignore rule matches it. Git's
 * check-ignore exits 1 for both tracked files and eligible untracked paths,
 * 0 for ignored paths and 128 outside a worktree. An error or missing Git
 * cannot authorize repository writes.
 */
export function tracksKeepLock(cwd: string): boolean {
  return spawnSync('git', ['check-ignore', '--quiet', '--', 'keep.lock'], {
    cwd,
    stdio: 'ignore',
  }).status === 1;
}
