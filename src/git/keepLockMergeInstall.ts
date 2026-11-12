/**
 * Installs the keep.lock merge driver in a git clone.
 *
 * Two pieces, both needed for git to use the driver:
 *  - `.gitattributes` at the repo root maps every `keep.lock` (at any depth,
 *    since the pattern has no slash) to the driver by name. It is a normal
 *    tracked file: committing it gives every clone the mapping.
 *  - the clone's LOCAL git config says what command the name runs. Config is
 *    never shared by git, so each clone gets it from its own capy.
 *
 * If either piece is missing git falls back to its text merge, so a clone
 * that never installed degrades to exactly what it did before.
 *
 * Idempotent, and it NEVER throws: callers are commands that write keep.lock
 * and must carry on exactly as before when this cannot install.
 */
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** The driver's name in `.gitattributes` and in git config (`merge.<name>.driver`). */
export const KEEP_LOCK_MERGE_DRIVER_NAME = 'capy-keep-lock';

/** The `.gitattributes` line this adds. */
export const KEEP_LOCK_GITATTRIBUTES_LINE = `keep.lock merge=${KEEP_LOCK_MERGE_DRIVER_NAME}`;

const BIN_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** What the driver's config value runs: this CLI's own binary name, then the hidden command and git's three file placeholders. */
export function keepLockMergeDriverCommand(binName: string | undefined = process.env.CAPY_BIN_NAME): string {
  const bin = binName !== undefined && BIN_NAME_PATTERN.test(binName) ? binName : 'capy';
  return `${bin} merge-keep-lock %O %A %B`;
}

export type KeepLockMergeInstallResult =
  | { readonly installed: true; readonly attributes: 'added' | 'present'; readonly config: 'set' | 'present' }
  | { readonly installed: false; readonly code: 'NOT_A_GIT_REPO' | 'FOREIGN_MERGE_ATTRIBUTE' | 'INSTALL_FAILED' };

/**
 * How a `.gitattributes` text already maps `keep.lock`'s `merge` attribute.
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

/** Sets the driver command in the clone's local config unless it is already that. */
function ensureLocalConfig(root: string): 'set' | 'present' {
  const key = `merge.${KEEP_LOCK_MERGE_DRIVER_NAME}.driver`;
  const wanted = keepLockMergeDriverCommand();
  const current = git(['config', '--local', '--get', key], root);
  if (current.code === 0 && current.stdout.trim() === wanted) return 'present';
  const set = git(['config', '--local', key, wanted], root);
  if (set.code !== 0) throw new Error('git config failed');
  return 'set';
}

/** Appends the mapping line, keeping everything already in the file and its order. */
function appendMapping(path: string, existing: string): void {
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${KEEP_LOCK_GITATTRIBUTES_LINE}\n`, 'utf-8');
}

function install(dir: string): KeepLockMergeInstallResult {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  const root = top.stdout.trim();
  if (top.code !== 0 || root === '') return { installed: false, code: 'NOT_A_GIT_REPO' };
  const attributesPath = join(root, '.gitattributes');
  const existing = existsSync(attributesPath) ? readFileSync(attributesPath, 'utf-8') : '';
  const mapping = keepLockMergeMapping(existing);
  if (mapping === 'foreign') return { installed: false, code: 'FOREIGN_MERGE_ATTRIBUTE' };
  // Config first: the mapping never lands before the command it names exists.
  const config = ensureLocalConfig(root);
  if (mapping === 'none') appendMapping(attributesPath, existing);
  return { installed: true, attributes: mapping === 'none' ? 'added' : 'present', config };
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
