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
 * Git writes the tracked file itself (`checkout-index`), so its bytes, line
 * endings and mode are exactly what git would check out. Nothing here
 * re-applies the sparse-checkout list to the working tree: only the one
 * `.gitignore` path, its skip-worktree flag and one line of the list change.
 *
 * Planning returns immutable data; the apply functions perform the writes.
 */
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs `git <args>` in `cwd`. Injectable so tests can simulate failures. */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult;

/**
 * Variables that point git at a repository, work tree or index other than the
 * one found from the folder. They are dropped so every question and every
 * write is about the folder's own repository, never another one the caller's
 * environment happens to name.
 */
const REPOSITORY_REDIRECTS: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

const folderScopedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !REPOSITORY_REDIRECTS.has(name)));

/** Text output only: nothing that needs exact bytes may go through here. */
export const runGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8', env: folderScopedEnv() });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
};

/** Why a tracked, off-disk `.gitignore` cannot be brought into the checkout. */
export type NotInCheckoutReason =
  | 'cone-mode'
  | 'sparse-disabled'
  | 'sparse-list-missing'
  | 'index-unreadable'
  | 'prefix-unknown'
  | 'toplevel-unknown'
  | 'not-regular-file'
  | 'unmerged';

export type MissingGitignorePlan =
  /** Not tracked, not a git repo, or git is unavailable: create the file as usual. */
  | { readonly kind: 'create-new' }
  /** Tracked, and the index copy already holds every wanted entry. Change nothing. */
  | { readonly kind: 'nothing-to-do' }
  /** Tracked but deleted locally (not sparse): have git write the index copy back, then append. */
  | { readonly kind: 'restore-from-index' }
  /**
   * Tracked and kept off disk by sparse checkout: have git write the file,
   * clear its skip-worktree flag and add this one pattern to `listPath`.
   */
  | { readonly kind: 'sparse-add'; readonly listPath: string; readonly pattern: string }
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

interface IndexEntry {
  /** `git ls-files -t` letter: H cached, S skip-worktree, M unmerged. */
  readonly tag: string;
  readonly mode: string;
  readonly stage: string;
  readonly lineCount: number;
}

const INDEX_LINE = /^(\S) (\d{6}) \S+ (\d)\t/;

/** Index entry for `.gitignore` in `cwd`; null if untracked or not a repo; undefined if unreadable. */
function indexEntry(cwd: string, run: GitRunner): IndexEntry | null | undefined {
  const r = run(['ls-files', '-t', '-s', '--', '.gitignore'], cwd);
  if (r.code !== 0) return null;
  const lines = r.stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const match = INDEX_LINE.exec(lines[0] ?? '');
  if (match === null) return undefined;
  return { tag: match[1] ?? '', mode: match[2] ?? '', stage: match[3] ?? '', lineCount: lines.length };
}

function isConeMode(cwd: string, run: GitRunner): boolean {
  // --bool: git reads yes, on, 1 and true (any case) alike.
  const r = run(['config', '--bool', '--get', 'core.sparseCheckoutCone'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

function isSparseEnabled(cwd: string, run: GitRunner): boolean {
  const r = run(['config', '--bool', '--get', 'core.sparseCheckout'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

function sparsePlan(cwd: string, run: GitRunner): MissingGitignorePlan {
  if (isConeMode(cwd, run)) return { kind: 'not-in-checkout', reason: 'cone-mode' };
  if (!isSparseEnabled(cwd, run)) return { kind: 'not-in-checkout', reason: 'sparse-disabled' };
  const prefix = run(['rev-parse', '--show-prefix'], cwd);
  if (prefix.code !== 0) return { kind: 'not-in-checkout', reason: 'prefix-unknown' };
  const fromTop = prefix.stdout.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(fromTop)) return { kind: 'not-in-checkout', reason: 'prefix-unknown' };
  const listRel = run(['rev-parse', '--git-path', 'info/sparse-checkout'], cwd);
  if (listRel.code !== 0) return { kind: 'not-in-checkout', reason: 'toplevel-unknown' };
  const listPath = resolve(cwd, listRel.stdout.replace(/\r?\n$/, ''));
  // A missing list must not be created: it would narrow the whole checkout to one path.
  if (!existsSync(listPath)) return { kind: 'not-in-checkout', reason: 'sparse-list-missing' };
  return { kind: 'sparse-add', listPath, pattern: `/${escapeSparsePattern(fromTop)}.gitignore` };
}

/** True when anything (file, directory, symlink, dangling or not) is at `path`. */
function somethingAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function trackedPlan(
  entry: IndexEntry,
  cwd: string,
  entries: readonly string[],
  run: GitRunner,
): MissingGitignorePlan {
  if (entry.tag !== 'S' && entry.tag !== 'H' && entry.tag !== 'M') return { kind: 'create-new' };
  if (entry.tag === 'M' || entry.stage !== '0' || entry.lineCount !== 1) {
    return { kind: 'not-in-checkout', reason: 'unmerged' };
  }
  // A symlink (or anything but a plain file) must come back exactly as git has it, and Capy
  // must not append through it into another tracked file. A dangling symlink already on disk
  // is not "absent" either: git would not write over it.
  if ((entry.mode !== '100644' && entry.mode !== '100755') || somethingAt(resolve(cwd, '.gitignore'))) {
    return { kind: 'not-in-checkout', reason: 'not-regular-file' };
  }
  // Text only, for the "is every entry already there" check; the file itself is written by git.
  const index = run(['show', ':./.gitignore'], cwd);
  if (index.code !== 0) return { kind: 'not-in-checkout', reason: 'index-unreadable' };
  if (entriesMissingFrom(index.stdout, entries).length === 0) return { kind: 'nothing-to-do' };
  if (entry.tag === 'H') return { kind: 'restore-from-index' };
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
  const entry = indexEntry(cwd, run);
  if (entry === null) return { kind: 'create-new' };
  if (entry === undefined) return { kind: 'not-in-checkout', reason: 'index-unreadable' };
  return trackedPlan(entry, cwd, entries, run);
}

export type ApplyOutcome =
  | 'ok'
  | 'git-refused'
  | 'not-on-disk'
  | 'list-unwritable'
  /** Another writer got there first (file on disk or flag already cleared): nothing was touched. */
  | 'changed-concurrently'
  /** A step failed and undoing the earlier steps failed too. */
  | 'rollback-failed';

function removeFile(path: string): boolean {
  if (!somethingAt(path)) return true;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Has git write the index copy of `.gitignore` to disk; never overwrites an existing file. */
export function restoreFromIndex(cwd: string, gitignorePath: string, run: GitRunner = runGit): ApplyOutcome {
  if (run(['checkout-index', '--', '.gitignore'], cwd).code !== 0) return 'git-refused';
  return somethingAt(gitignorePath) ? 'ok' : 'not-on-disk';
}

function restoreFlag(cwd: string, run: GitRunner): boolean {
  return run(['update-index', '--skip-worktree', '--', '.gitignore'], cwd).code === 0;
}

/** True while the path is still flagged skip-worktree with nothing on disk: the state that was planned for. */
function stillAsPlanned(cwd: string, gitignorePath: string, run: GitRunner): boolean {
  const entry = indexEntry(cwd, run);
  return entry !== null && entry !== undefined && entry.tag === 'S' && !somethingAt(gitignorePath);
}

function appendToList(listPath: string, pattern: string): boolean {
  try {
    const existing = readFileSync(listPath);
    const needsNewline = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
    appendFileSync(listPath, (needsNewline ? '\n' : '') + pattern + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings one tracked, skip-worktree `.gitignore` into the checkout without
 * re-applying the sparse list to anything else: clear that one path's flag,
 * have git write that one file, then add that one pattern to the list. If a
 * step fails, only what this call did is undone: the file is removed only when
 * this call's own `checkout-index` wrote it, and a file or flag that another
 * writer changed is never touched.
 */
export function addToSparseCheckout(
  cwd: string,
  gitignorePath: string,
  listPath: string,
  pattern: string,
  run: GitRunner = runGit,
): ApplyOutcome {
  // Another process may have finished the same job since the plan was made.
  if (!stillAsPlanned(cwd, gitignorePath, run)) return 'changed-concurrently';
  if (run(['update-index', '--no-skip-worktree', '--', '.gitignore'], cwd).code !== 0) return 'git-refused';
  // `checkout-index` without force never overwrites: success means this call created the file.
  const written = restoreFromIndex(cwd, gitignorePath, run);
  if (written === 'git-refused' && somethingAt(gitignorePath)) {
    // Someone else's file is there now; their file, flag and list entry stand.
    return 'changed-concurrently';
  }
  if (written !== 'ok') {
    return restoreFlag(cwd, run) ? written : 'rollback-failed';
  }
  if (!appendToList(listPath, pattern)) {
    // The file is this call's own, so it is the only file removed.
    const removed = removeFile(gitignorePath);
    const flagged = restoreFlag(cwd, run);
    return removed && flagged ? 'list-unwritable' : 'rollback-failed';
  }
  return 'ok';
}
