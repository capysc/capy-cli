import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface AutoCommitResult {
  /** True when a commit containing keep.lock was created. */
  committed: boolean;
  /**
   * Why no commit happened. 'unchanged' and 'disabled' are silent;
   * everything else prints the drift warning.
   */
  reason?: 'disabled' | 'not_a_repo' | 'unchanged' | 'in_progress_operation' | 'commit_failed';
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

/**
 * Commit keep.lock after a sync/push changed it (CAP-303).
 *
 * The pin only protects the team once it is in git — an uncommitted
 * keep.lock is exactly the state that caused branch pins to silently
 * diverge. The rule "when pins change, commit them" is mechanical, so it
 * lives here in the CLI rather than in user (or agent) discipline. The
 * commit contains ONLY keep.lock: `git commit -- keep.lock` ignores
 * whatever else is staged, so a half-staged feature in progress is never
 * swept up.
 *
 * Never throws — a failed commit must not break the push that preceded it.
 * When keep.lock changed but cannot be committed (not a repo, mid-rebase,
 * commit error), a loud warning tells the user their team's pins are behind.
 *
 * Opt out with CAPY_NO_AUTOCOMMIT=1.
 */
export function autoCommitKeep(branch: string, projectRoot: string = process.cwd()): AutoCommitResult {
  if (process.env.CAPY_NO_AUTOCOMMIT === '1') {
    return { committed: false, reason: 'disabled' };
  }

  let inRepo = false;
  try {
    inRepo = git(projectRoot, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    inRepo = false;
  }
  if (!inRepo) {
    warnUncommitted('not in a git repository');
    return { committed: false, reason: 'not_a_repo' };
  }

  try {
    const status = git(projectRoot, ['status', '--porcelain', '--', 'keep.lock']).trim();
    if (!status) {
      return { committed: false, reason: 'unchanged' };
    }

    // A rebase/merge/cherry-pick in progress makes partial commits invalid
    // (and committing mid-operation would tangle the user's own work).
    const gitDir = git(projectRoot, ['rev-parse', '--git-dir']).trim();
    const absGitDir = join(projectRoot, gitDir);
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (existsSync(join(absGitDir, marker))) {
        warnUncommitted('a rebase/merge is in progress');
        return { committed: false, reason: 'in_progress_operation' };
      }
    }

    git(projectRoot, ['add', '--', 'keep.lock']);
    git(projectRoot, ['commit', '-m', `chore(capy): pin ${branch} secrets`, '--', 'keep.lock']);
    console.log(`> keep.lock committed ${'\x1b[90m'}(chore(capy): pin ${branch} secrets)\x1b[0m`);
    return { committed: true };
  } catch {
    warnUncommitted('git commit failed');
    return { committed: false, reason: 'commit_failed' };
  }
}

function warnUncommitted(cause: string): void {
  console.error(
    `${YELLOW('⚠')} keep.lock updated but not committed (${cause}).\n` +
    `  Your team's pins won't include this change until it is committed.\n` +
    `  Run: ${B('git add keep.lock && git commit')}`,
  );
}
