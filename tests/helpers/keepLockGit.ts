/**
 * Real-git scaffolding for the keep.lock merge driver tests: throwaway repos,
 * and a `capy` shim on PATH that runs this checkout's CLI from source, so git
 * calls the driver exactly as the installed config names it (`capy ...`).
 */
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

const CLI_ROOT = resolve(import.meta.dir, '../..');

export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fresh empty directory under the system temp dir. */
export function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A directory holding an executable `capy` that runs `src/index.ts` with bun.
 * Prepended to PATH for every git call, so a driver config of `capy
 * merge-keep-lock %O %A %B` resolves to this checkout's code.
 */
export function makeCapyShim(root: string): string {
  const dir = join(root, 'shim-bin');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'capy');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(CLI_ROOT, 'src', 'index.ts')}" "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

/** Git's environment for a test: no user/system config, a fixed identity, an empty HOME, optional PATH additions. */
export function gitEnv(home: string, extraPath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...(extraPath === undefined ? {} : { PATH: `${extraPath}${delimiter}${process.env.PATH ?? ''}` }),
  };
}

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = gitEnv(cwd)): GitRun {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8', env });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `git init` on `main` in `<root>/<name>`; returns the repo path. */
export function makeRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

// ---------------------------------------------------------------------------
// keep.lock fixtures
// ---------------------------------------------------------------------------

type Entry = Record<string, unknown>;

export const lockEntry = (name: string, branch: string, hash: string, extra: Entry = {}): Entry => ({
  resource_id: `id-${name}`,
  branch,
  value_hash: hash,
  ...extra,
});

/** A keep.lock exactly as the CLI writes it (`serializeKeep`), from its variables. */
export function lockText(variables: Record<string, Entry[]>): string {
  return serializeKeep({ version: '3.0', org_id: 'org', project_id: 'proj', project_name: 'proj-name', variables } as unknown as KeepFile);
}
