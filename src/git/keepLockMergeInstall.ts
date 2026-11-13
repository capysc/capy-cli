/**
 * Installs the keep.lock merge driver in a git clone, without touching its
 * working tree.
 *
 * Two pieces, both needed for git to use the driver, both private to the clone:
 *  - the clone's own attributes file (`git rev-parse --git-path
 *    info/attributes`; for a linked worktree or a submodule this is the shared
 *    or module git directory's, wherever git itself reads it) maps every
 *    `keep.lock`, at any depth since the pattern has no slash, to the driver
 *    by name. It is not a tracked file: nothing to commit, nothing in
 *    `git status`, and `.gitattributes` is never created or edited.
 *  - the clone's LOCAL git config says what command the name runs.
 *
 * If either piece is missing git falls back to its text merge, so a clone that
 * never installed degrades to exactly what it did before.
 *
 * Idempotent, and it NEVER throws: callers are commands that write keep.lock
 * and must carry on exactly as before when this cannot install.
 */
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * The driver command's exit code for "could not merge; %A holds git's own text
 * merge, markers included". Not 1: the install's shell line treats every other
 * non-zero status (a crash, an older capy without the command, 126/127 for a
 * missing binary) as "the command did not run" and falls back to git's text
 * merge itself.
 */
export const KEEP_LOCK_MERGE_CONFLICT_EXIT = 2;

/** The driver's name in the attributes file and in git config (`merge.<name>.driver`). */
export const KEEP_LOCK_MERGE_DRIVER_NAME = 'capy-keep-lock';

/** The attributes line this adds. */
export const KEEP_LOCK_ATTRIBUTES_LINE = `keep.lock merge=${KEEP_LOCK_MERGE_DRIVER_NAME}`;

/** The hidden command's name: it is also how an installed config value is recognised as ours. */
const DRIVER_COMMAND_NAME = 'merge-keep-lock';

const BIN_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * What the driver's config value runs, as one shell line: this CLI's own
 * binary name, the hidden command, and git's placeholders (the three files,
 * the conflict labels, the marker size).
 *
 * The command exits 0 (merged) or `KEEP_LOCK_MERGE_CONFLICT_EXIT` (it left
 * git's own text merge, markers included, in %A). ANY other status means the
 * command did not do its job: the binary missing or not executable (126, 127),
 * an older capy without the command, a crash. Then the line runs `git
 * merge-file` on the same three files itself and returns its status, so a
 * conflict is never left as plain "ours" with no markers. The fallback is
 * never run after the command has already written its result.
 */
export function keepLockMergeDriverCommand(binName: string | undefined = process.env.CAPY_BIN_NAME): string {
  const bin = binName !== undefined && BIN_NAME_PATTERN.test(binName) ? binName : 'capy';
  const conflict = KEEP_LOCK_MERGE_CONFLICT_EXIT;
  return [
    `${bin} ${DRIVER_COMMAND_NAME} %O %A %B %X %S %Y %L`,
    's=$?',
    '[ $s -eq 0 ] && exit 0',
    `[ $s -eq ${conflict} ] && exit ${conflict}`,
    'git merge-file -L %X -L %S -L %Y --marker-size=%L %A %O %B',
    'exit $?',
  ].join('; ');
}

/** Whether a configured driver value is one this module wrote (under any binary name). */
function isOurDriverValue(value: string): boolean {
  return value.includes(` ${DRIVER_COMMAND_NAME} %O %A %B`);
}

export type KeepLockMergeInstallResult =
  | { readonly installed: true; readonly attributes: 'added' | 'present'; readonly config: 'set' | 'present' }
  | { readonly installed: false; readonly code: 'NOT_A_GIT_REPO' | 'FOREIGN_MERGE_ATTRIBUTE' | 'INSTALL_FAILED' };

/**
 * How an attributes text already maps `keep.lock`'s `merge` attribute.
 * The last `merge` setting on a line whose pattern is exactly `keep.lock`
 * wins, as it does in git: `ours` (this driver), `foreign` (anything else,
 * including `-merge` and `merge=union`: the owner chose it, leave it), or
 * `none`.
 */
export function keepLockMergeMapping(content: string): 'ours' | 'foreign' | 'none' {
  const settings = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((tokens) => tokens[0] === 'keep.lock')
    .flatMap((tokens) => tokens.slice(1))
    .filter((attr) => attr === 'merge' || attr === '-merge' || attr === '!merge' || attr.startsWith('merge='));
  const last = settings.at(-1);
  if (last === undefined) return 'none';
  return last === `merge=${KEEP_LOCK_MERGE_DRIVER_NAME}` ? 'ours' : 'foreign';
}

function git(args: readonly string[], cwd: string): { readonly code: number; readonly stdout: string } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

const readIfPresent = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf-8') : '');

/**
 * Sets the driver command in the clone's local config, unless a driver of ours
 * is already there: an installed value is left as it is (a repo used through
 * two binary names must not flip between them), only an absent or foreign one
 * is set. `undefined` when git would not set it.
 */
function ensureLocalConfig(root: string): 'set' | 'present' | undefined {
  const key = `merge.${KEEP_LOCK_MERGE_DRIVER_NAME}.driver`;
  const current = git(['config', '--local', '--get', key], root);
  if (current.code === 0 && isOurDriverValue(current.stdout.trim())) return 'present';
  const set = git(['config', '--local', key, keepLockMergeDriverCommand()], root);
  return set.code === 0 ? 'set' : undefined;
}

/** Appends the mapping line to the clone's attributes file, keeping everything already in it. */
function appendMapping(path: string, existing: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${KEEP_LOCK_ATTRIBUTES_LINE}\n`, 'utf-8');
}

function install(dir: string): KeepLockMergeInstallResult {
  // One call: the work tree's root, and where git reads this clone's own attributes (relative to `dir`).
  const where = git(['rev-parse', '--show-toplevel', '--git-path', 'info/attributes'], dir);
  const [root, infoPath] = where.stdout.split('\n').map((line) => line.trim());
  if (where.code !== 0 || !root || !infoPath) return { installed: false, code: 'NOT_A_GIT_REPO' };
  const trackedMapping = keepLockMergeMapping(readIfPresent(join(root, '.gitattributes')));
  const info = resolve(dir, infoPath);
  const infoText = readIfPresent(info);
  const infoMapping = keepLockMergeMapping(infoText);
  // A mapping someone else wrote for keep.lock, in either place, is theirs: leave everything alone.
  if (trackedMapping === 'foreign' || infoMapping === 'foreign') return { installed: false, code: 'FOREIGN_MERGE_ATTRIBUTE' };
  const config = ensureLocalConfig(root);
  if (config === undefined) return { installed: false, code: 'INSTALL_FAILED' };
  const mapped = trackedMapping === 'ours' || infoMapping === 'ours';
  // Config first: the mapping never lands before the command it names exists.
  if (!mapped) appendMapping(info, infoText);
  return { installed: true, attributes: mapped ? 'present' : 'added', config };
}

/**
 * Installs the merge driver for the git repo containing `dir`. Does nothing
 * outside a git repo. Never throws: any failure is `INSTALL_FAILED`.
 */
export function installKeepLockMergeDriver(dir: string): KeepLockMergeInstallResult {
  try {
    return install(dir);
  } catch {
    return { installed: false, code: 'INSTALL_FAILED' };
  }
}
