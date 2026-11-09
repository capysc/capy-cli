/**
 * Process-level sandboxing for the connector tests. The few unavoidable
 * writes to Node's own globals (`process.env`, `process.stdin.isTTY`,
 * `process.exitCode`) live HERE, behind one function each, and every one is
 * restored in a `finally` — so no test file touches a global or keeps a
 * mutable binding of its own.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spyOn } from 'bun:test';

/** A throwaway directory (symlinks resolved), removed afterwards. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Points Capy's global config dir (`~/.capy` equivalent: session, wrapped
 * master key, keep cache) at a throwaway name for the duration, so a test
 * never reads or writes the developer's real one.
 */
export async function withIsolatedGlobalDir<T>(fn: () => Promise<T>): Promise<T> {
  const name = `.capy-test-vercel-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const saved = process.env.CAPY_GLOBAL_DIR_NAME;
  process.env.CAPY_GLOBAL_DIR_NAME = name;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
    else process.env.CAPY_GLOBAL_DIR_NAME = saved;
    rmSync(join(homedir(), name), { recursive: true, force: true });
  }
}

/**
 * `isInteractive()` also requires a real `process.stdin.isTTY`, which
 * `bun test` never has — `nonTty: false` alone cannot reach the interactive
 * branches.
 */
export async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
  }
}

/** A refusal sets `process.exitCode = 1` (right for the CLI); restore it so the test process itself still exits 0. */
export async function withExitCodeRestored<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = saved ?? 0;
  }
}

/**
 * Runs `fn` with `console.log` / `console.error` captured. Returns what each
 * printed, one string per call — the spies' own call records, so nothing is
 * pushed into a test-owned array.
 */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: readonly string[]; stderr: readonly string[] }> {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);
  try {
    const result = await fn();
    const flat = (calls: ReadonlyArray<readonly unknown[]>): readonly string[] => calls.map((a) => a.map(String).join(' '));
    return { result, stdout: flat(logSpy.mock.calls), stderr: flat(errSpy.mock.calls) };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

/** A git repo with one commit and (optionally) an `origin`. */
export function initRepo(dir: string, remoteUrl?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  if (remoteUrl) git(dir, ['remote', 'add', 'origin', remoteUrl]);
  writeFileSync(join(dir, 'README.md'), 'x');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}
