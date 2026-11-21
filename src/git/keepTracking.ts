import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function hasGitDirectory(folder: string): boolean {
  if (existsSync(join(folder, '.git'))) return true;
  const parent = dirname(folder);
  return folder !== parent && hasGitDirectory(parent);
}

/**
 * Git's own index and ignore rules are the tracking policy. A path already
 * in the index is tracked even if a later ignore rule matches it. Git's
 * check-ignore exits 1 for both tracked files and eligible untracked paths,
 * 0 for ignored paths and 128 outside a worktree. An error or missing Git
 * cannot authorize repository writes.
 */
export function keepLockTracking(cwd: string, relativePath = 'keep.lock'): 'git' | 'local' | 'unknown' {
  const status = spawnSync('git', ['check-ignore', '--quiet', '--', relativePath], {
    cwd,
    stdio: 'ignore',
  }).status;
  if (status === 0) return 'local';
  if (status === 1) return 'git';
  // A real plain folder needs no Git installation. If Git is unavailable or
  // fails inside a checkout, preserve its existing lockfile and Git config.
  return existsSync(cwd) && !process.env.GIT_DIR && !hasGitDirectory(resolve(cwd)) ? 'local' : 'unknown';
}

export function tracksKeepLock(cwd: string, relativePath = 'keep.lock'): boolean {
  return keepLockTracking(cwd, relativePath) === 'git';
}
