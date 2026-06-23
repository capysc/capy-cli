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

/**
 * Returns local branch names sorted by most-recently-committed-first.
 * Used to populate the "open the deploy PR against which branch?" picker
 * with sensible suggestions (main / master / develop / staging / etc.).
 */
export function listLocalBranches(cwd: string): string[] {
  const r = git(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'],
    cwd,
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
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
 * Stash everything in the working tree EXCEPT keep.lock. Used in DIRECT
 * mode where we stay on the current branch — keep.lock can ride along in
 * the working tree across the commit, and the user's other in-progress
 * changes go to the stash so the deploy ships from a clean HEAD + keep.lock
 * state. Restored on success or failure via `popStash`.
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

/**
 * Stash EVERYTHING in the working tree (incl. keep.lock and untracked
 * files). Used in CI mode where we need to switch to a fresh branch
 * derived from the target branch — the keep.lock change has to be lifted
 * off the current tree before the branch switch and replayed onto the
 * deploy branch.
 *
 * Returns `stashed: false` when the working tree is already clean.
 */
export function stashAllChanges(
  cwd: string,
): { ok: boolean; stashed: boolean; error?: string } {
  const status = getStatus(cwd);
  if (status.length === 0) return { ok: true, stashed: false };
  const r = git(
    [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'capy-deploy: temporary stash of all working changes',
    ],
    cwd,
  );
  if (r.code !== 0) {
    return { ok: false, stashed: false, error: r.stderr.trim() };
  }
  return { ok: true, stashed: true };
}

/**
 * `git fetch origin <branch>` so `origin/<branch>` reflects the remote tip
 * before we branch off it. Without this, a stale local `origin/main` would
 * make the deploy PR diverge from what main actually has.
 */
export function fetchRemoteBranch(
  cwd: string,
  branch: string,
  remote: string = 'origin',
): { ok: boolean; error?: string } {
  const r = git(['fetch', remote, branch], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
}

/**
 * Create a new branch starting from a specific ref (e.g. `origin/main`)
 * rather than from the current HEAD. CI mode uses this so the deploy PR's
 * diff is exactly keep.lock vs the target branch — not whatever the user
 * happens to have on their current branch.
 */
export function checkoutNewBranchFrom(
  cwd: string,
  name: string,
  startPoint: string,
): { ok: boolean; error?: string } {
  const r = git(['checkout', '-b', name, startPoint], cwd);
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() };
  }
  return { ok: true };
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

/**
 * Discard uncommitted working-tree changes to specific paths (best-effort).
 * `capy deploy`'s CI secrets-only path replays keep.lock onto the deploy branch
 * without committing it; that dirty file makes `git checkout <originalBranch>`
 * abort ("local changes would be overwritten"). Dropping it is safe — the
 * user's real keep.lock is committed on their branch or in the stash we made.
 */
export function discardPaths(
  cwd: string,
  paths: string[],
): { ok: boolean; error?: string } {
  const r = git(['checkout', '--', ...paths], cwd);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
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

/** Repo-root-relative path of a file in `cwd` (e.g. `service/keep.lock`). */
export function repoRelPath(cwd: string, file: string): string {
  const prefix = git(['rev-parse', '--show-prefix'], cwd).stdout.trim();
  return prefix + file;
}

/**
 * Read a file's content at a git ref without touching the working tree
 * (`git show <ref>:<repo-rel-path>`). Returns null if the file doesn't exist
 * there (e.g. a brand-new target whose base branch has no keep.lock yet).
 */
export function readFileAtRef(
  cwd: string,
  ref: string,
  repoRelFile: string,
): string | null {
  const r = git(['show', `${ref}:${repoRelFile}`], cwd);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Create an isolated linked worktree on a NEW branch off `startPoint`
 * (e.g. `origin/staging`). The user's working tree and current branch are never
 * touched — this fixes the stash/checkout/pop dance that
 * stranded users on `capy-deploy-*` branches.
 */
export function worktreeAddNewBranch(
  cwd: string,
  dir: string,
  branch: string,
  startPoint: string,
): { ok: boolean; error?: string } {
  const r = git(['worktree', 'add', '-b', branch, dir, startPoint], cwd);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
  return { ok: true };
}

/** Tear down a linked worktree (best-effort; --force removes even if dirty). */
export function worktreeRemove(cwd: string, dir: string): { ok: boolean; error?: string } {
  const r = git(['worktree', 'remove', '--force', dir], cwd);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
  return { ok: true };
}

/** Delete a local branch (cleanup after the worktree PR is pushed). */
export function deleteLocalBranch(cwd: string, branch: string): { ok: boolean; error?: string } {
  const r = git(['branch', '-D', branch], cwd);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
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
