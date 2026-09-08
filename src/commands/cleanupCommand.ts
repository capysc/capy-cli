import { execFileSync } from 'child_process';
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'fs';
import { join, resolve } from 'path';
import { planHookCleanup } from '../git/planHookCleanup';

const hookNames = ['post-checkout', 'post-merge', 'pre-push'] as const;
type HookName = typeof hookNames[number];
interface Snapshot {
  readonly name: HookName;
  readonly path: string;
  readonly content: string;
  readonly dev: number;
  readonly ino: number;
}
interface Change extends Snapshot { readonly replacement: string }
export interface CleanupReport {
  readonly ok: boolean;
  readonly code: 'CLEANUP_DONE' | 'CLEANUP_UNCHANGED' | 'CLEANUP_REFUSED' | 'CLEANUP_FAILED';
  readonly message: string;
  readonly changedHooks: readonly HookName[];
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function readHook(fd: number): string {
  const bytes = readFileSync(fd);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Unsupported hook encoding');
  return content;
}

/** Do not follow hook symlinks, rewrite shared inodes, or change file permissions. */
function snapshot(path: string, name: HookName): Snapshot | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe hook');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile() || opened.nlink !== 1) throw new Error('Hook changed');
      return { name, path, content: readHook(fd), dev: opened.dev, ino: opened.ino };
    } finally { closeSync(fd); }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function applyChange(change: Change): void {
  const fd = openSync(change.path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== change.dev || stat.ino !== change.ino
      || readHook(fd) !== change.content) throw new Error('Hook changed');
    // The positional write must start at zero after the verification read.
    const bytes = Buffer.from(change.replacement, 'utf8');
    if (bytes.length > 0) {
      const writeAll = (offset: number): void => {
        if (offset === bytes.length) return;
        const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (written <= 0) throw new Error('Incomplete hook write');
        writeAll(offset + written);
      };
      writeAll(0);
    }
    ftruncateSync(fd, bytes.length);
  } finally { closeSync(fd); }
}

function applyChanges(changes: readonly Change[], completed: readonly HookName[] = []): CleanupReport {
  const [next, ...rest] = changes;
  if (!next) return {
    ok: true, code: completed.length ? 'CLEANUP_DONE' : 'CLEANUP_UNCHANGED',
    message: completed.length ? 'Removed Capy Git-hook blocks. Other hook content was preserved.' : 'No Capy Git-hook blocks found.',
    changedHooks: completed,
  };
  try {
    applyChange(next);
  } catch {
    return { ok: false, code: 'CLEANUP_FAILED', changedHooks: completed,
      message: `Could not finish cleaning ${next.name}. Inspect that hook before retrying; earlier completed changes are listed in changedHooks.` };
  }
  return applyChanges(rest, [...completed, next.name]);
}

export function cleanupGitHooks(): CleanupReport {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (resolve(gitDir) !== resolve(commonDir)) return {
      ok: false, code: 'CLEANUP_REFUSED', changedHooks: [],
      message: 'This worktree shares Git hooks. Run cleanup from the original repository checkout to remove its Capy hooks.',
    };
    const hooksDir = join(gitDir, 'hooks');
    try {
      if (!lstatSync(hooksDir).isDirectory()) throw new Error('Unsafe hooks directory');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return applyChanges([]);
      throw error;
    }
    // Inspect every target before writing any: malformed markers fail closed.
    const changes = hookNames.flatMap((name): readonly Change[] => {
      const current = snapshot(join(hooksDir, name), name);
      if (!current) return [];
      const plan = planHookCleanup(current.content);
      if (plan.kind === 'invalid') throw new Error('Ambiguous Capy markers');
      if (plan.kind === 'unchanged') return [];
      return [{ ...current, replacement: plan.content }];
    });
    return applyChanges(changes);
  } catch {
    return { ok: false, code: 'CLEANUP_REFUSED', changedHooks: [],
      message: 'No hooks were changed. Run inside a Git repository and check hook access, file links and Capy marker boundaries before retrying.' };
  }
}

export function cleanupCommand(options: Readonly<{ json?: boolean; nonTty?: boolean; yes?: boolean }> = {}): number {
  const report = cleanupGitHooks();
  console.log(options.json ? JSON.stringify(report) : report.message);
  return report.ok ? 0 : 1;
}
