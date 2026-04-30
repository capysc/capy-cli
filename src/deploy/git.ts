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
 * Files whose working-tree state may legitimately change as part of a
 * `capy deploy` invocation and which we'll auto-commit. Anything outside this
 * set must be committed by the user before deploying.
 */
const ALLOWED_AUTOCOMMIT_PATHS = new Set(['keep.lock']);

export interface GuardResult {
  ok: boolean;
  /** Files outside the allow-list that need user attention. */
  blockingChanges: GitStatusEntry[];
  /** Files in the allow-list that we'll auto-commit. */
  autoCommitChanges: GitStatusEntry[];
}

export function guardWorkingTree(cwd: string): GuardResult {
  const entries = getStatus(cwd);
  const blockingChanges: GitStatusEntry[] = [];
  const autoCommitChanges: GitStatusEntry[] = [];
  for (const e of entries) {
    if (ALLOWED_AUTOCOMMIT_PATHS.has(e.path)) {
      autoCommitChanges.push(e);
    } else {
      blockingChanges.push(e);
    }
  }
  return {
    ok: blockingChanges.length === 0,
    blockingChanges,
    autoCommitChanges,
  };
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
