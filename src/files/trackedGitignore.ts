/**
 * Decides what to do when Capy needs to add entries to a folder's
 * `.gitignore` and there is no `.gitignore` on disk.
 *
 * "Not on disk" does not mean "does not exist": with git sparse checkout the
 * file can be tracked (and still applied by git from its index) while being
 * kept off the working tree. Creating a fresh file there would make git show
 * the customer's tracked `.gitignore` as replaced. So before creating
 * anything, ask git whether the path is tracked, and plan accordingly.
 *
 * Everything here returns immutable data; the caller performs the writes.
 */
import { spawnSync } from 'child_process';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs `git <args>` in `cwd`. Injectable so tests can simulate failures. */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult;

export const runGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
};

/** Why a tracked, off-disk `.gitignore` cannot be brought into the checkout. */
export type NotInCheckoutReason = 'cone-mode' | 'index-unreadable' | 'prefix-unknown' | 'toplevel-unknown';

export type MissingGitignorePlan =
  /** Not tracked, not a git repo, or git is unavailable: create the file as usual. */
  | { readonly kind: 'create-new' }
  /** Tracked, and the index copy already holds every wanted entry. Change nothing. */
  | { readonly kind: 'nothing-to-do' }
  /** Tracked but deleted locally (not sparse): write the index copy back, then append. */
  | { readonly kind: 'restore-from-index'; readonly indexContent: string }
  /** Tracked and kept off disk by sparse checkout: ask git (run from `topLevel`) to add this one path. */
  | { readonly kind: 'sparse-add'; readonly topLevel: string; readonly pattern: string }
  /** Tracked, entries missing, and there is no safe way to get the file on disk. */
  | { readonly kind: 'not-in-checkout'; readonly reason: NotInCheckoutReason };

/** The entries that no (trimmed) line of `content` already holds. */
export function entriesMissingFrom(content: string, entries: readonly string[]): readonly string[] {
  const existingLines = new Set(
    content.split('\n').map((line) => line.trim()).filter(Boolean),
  );
  return entries.filter((entry) => !existingLines.has(entry));
}

/** Escapes characters that git would read as pattern syntax in a sparse-checkout path. */
export function escapeSparsePattern(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, (ch) => `\\${ch}`);
}

/** `git ls-files -t` status letter for `.gitignore` in `cwd`, or null if untracked / not a repo. */
function trackedStatus(cwd: string, run: GitRunner): string | null {
  const r = run(['ls-files', '-t', '--', '.gitignore'], cwd);
  if (r.code !== 0) return null;
  const firstLine = r.stdout.split('\n')[0] ?? '';
  return firstLine.length > 0 ? firstLine.charAt(0) : null;
}

function isConeMode(cwd: string, run: GitRunner): boolean {
  const r = run(['config', '--get', 'core.sparseCheckoutCone'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

function sparsePlan(cwd: string, run: GitRunner): MissingGitignorePlan {
  if (isConeMode(cwd, run)) return { kind: 'not-in-checkout', reason: 'cone-mode' };
  const prefix = run(['rev-parse', '--show-prefix'], cwd);
  if (prefix.code !== 0) return { kind: 'not-in-checkout', reason: 'prefix-unknown' };
  const top = run(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return { kind: 'not-in-checkout', reason: 'toplevel-unknown' };
  const fromTop = prefix.stdout.replace(/\r?\n$/, '');
  return {
    kind: 'sparse-add',
    topLevel: top.stdout.replace(/\r?\n$/, ''),
    pattern: `/${escapeSparsePattern(fromTop)}.gitignore`,
  };
}

function trackedPlan(
  status: string,
  cwd: string,
  entries: readonly string[],
  run: GitRunner,
): MissingGitignorePlan {
  if (status !== 'S' && status !== 'H') return { kind: 'create-new' };
  const index = run(['show', ':./.gitignore'], cwd);
  if (index.code !== 0) return { kind: 'not-in-checkout', reason: 'index-unreadable' };
  if (entriesMissingFrom(index.stdout, entries).length === 0) return { kind: 'nothing-to-do' };
  if (status === 'H') return { kind: 'restore-from-index', indexContent: index.stdout };
  return sparsePlan(cwd, run);
}

/**
 * What to do about a `.gitignore` that is not on disk in `cwd`. Only call
 * this when the file is absent; it never touches the disk or git state.
 */
export function planMissingGitignore(
  cwd: string,
  entries: readonly string[],
  run: GitRunner = runGit,
): MissingGitignorePlan {
  const status = trackedStatus(cwd, run);
  if (status === null) return { kind: 'create-new' };
  return trackedPlan(status, cwd, entries, run);
}

/** Adds one path to the sparse-checkout list; git writes the tracked file to disk. */
export function addToSparseCheckout(topLevel: string, pattern: string, run: GitRunner = runGit): boolean {
  return run(['sparse-checkout', 'add', pattern], topLevel).code === 0;
}
