/**
 * Minimal git helpers for `capy deploy`.
 *
 * The connector flow guards the working tree before pushing any vendor state
 * so the deploy is reproducible from a known commit. We auto-commit the
 * `keep.lock` change (always safe — no secrets, just hashes) but refuse to
 * deploy with other uncommitted code changes.
 */
import { spawnSync } from 'child_process';

export interface GitStatusEntry {
  /** Two-character short status from `git status --porcelain`. */
  code: string;
  path: string;
}

function git(args: string[], cwd: string, stdin?: string): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    input: stdin,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

export function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).code === 0;
}

export function currentBranch(cwd: string): string | null {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function getStatus(cwd: string): GitStatusEntry[] {
  const r = git(['status', '--porcelain'], cwd);
  if (r.code !== 0) return [];
  const out: GitStatusEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    out.push({ code: line.slice(0, 2), path: line.slice(3) });
  }
  return out;
}

/**
 * The single file `capy deploy` ever auto-commits. `keep.lock` carries no
 * secrets — only var-name hashes — so committing it on the user's behalf is
 * always safe. Everything else stays the user's to commit (or not).
 */
const KEEP_LOCK = 'keep.lock';

/**
 * Returns true if the user has unstaged changes to keep.lock that the deploy
 * flow needs to bake into a commit. False if keep.lock is already clean
 * (or if the file doesn't exist).
 */
export function hasKeepLockChanges(cwd: string): boolean {
  return getStatus(cwd).some((e) => e.path === KEEP_LOCK);
}

/**
 * Returns true if the user has any other working-tree changes besides
 * keep.lock. The caller doesn't refuse on this — it just decides whether a
 * stash dance is needed before switching branches in CI mode.
 */
export function hasOtherChanges(cwd: string): boolean {
  return getStatus(cwd).some((e) => e.path !== KEEP_LOCK);
}

export function stageAndCommit(
  cwd: string,
  paths: string[],
  message: string,
): { ok: boolean; error?: string } {
  if (paths.length === 0) return { ok: true };
  const add = git(['add', '--', ...paths], cwd);
  if (add.code !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
  }
  const commit = git(['commit', '-m', message], cwd);
  if (commit.code !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
  }
  return { ok: true };
}

export function checkoutNewBranch(
  cwd: string,
  name: string,
): { ok: boolean; error?: string } {
  const r = git(['checkout', '-b', name], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
}

/**
 * Stash everything in the working tree EXCEPT keep.lock. Used in CI mode so
 * the user's in-progress source changes survive the branch switch and don't
 * sneak into the deploy PR. Returns a stash ref the caller passes to
 * `popStash` after returning to the original branch.
 *
 * Returns null if there was nothing to stash (no other changes).
 */
export function stashOtherChanges(
  cwd: string,
): { ok: boolean; stashed: boolean; error?: string } {
  if (!hasOtherChanges(cwd)) return { ok: true, stashed: false };
  // `git stash push -u -- ':!keep.lock'` stashes all changes (incl. untracked)
  // except keep.lock. The pathspec magic word ':!' excludes a path.
  const r = git(
    [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'capy-deploy: temporary stash of non-keep.lock changes',
      '--',
      ':!keep.lock',
    ],
    cwd,
  );
  if (r.code !== 0) {
    return { ok: false, stashed: false, error: r.stderr.trim() };
  }
  return { ok: true, stashed: true };
}

export function popStash(cwd: string): { ok: boolean; error?: string } {
  const r = git(['stash', 'pop'], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
}

export function checkoutBranch(
  cwd: string,
  name: string,
): { ok: boolean; error?: string } {
  const r = git(['checkout', name], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
}

export function pushBranch(
  cwd: string,
  branch: string,
): { ok: boolean; error?: string } {
  const r = git(['push', '-u', 'origin', branch], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
}

/**
 * Creates a PR via `gh pr create`. Returns the PR URL on success, or null
 * + a manual-instructions string if `gh` isn't available or fails.
 */
export function createPr(
  cwd: string,
  title: string,
  body: string,
  base: string = 'main',
): { ok: boolean; url?: string; manualHint?: string; error?: string } {
  const which = spawnSync('which', ['gh'], { encoding: 'utf-8' });
  if (which.status !== 0) {
    return {
      ok: false,
      manualHint:
        `gh CLI not installed. Open the PR manually:\n` +
        `  https://github.com/<owner>/<repo>/compare/${base}...$(git rev-parse --abbrev-ref HEAD)?expand=1\n` +
        `Title: ${title}`,
    };
  }
  const r = spawnSync(
    'gh',
    ['pr', 'create', '--base', base, '--title', title, '--body', body],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  // gh prints the PR URL on stdout.
  const url = r.stdout.trim().split('\n').filter(Boolean).pop();
  return { ok: true, url: url || undefined };
}
