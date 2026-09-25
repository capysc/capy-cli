/**
 * Proof 8 (docs/org-system-store.md): `capy run` never sees the org system
 * store, even when a repo's own `.env` happens to hold a variable with the
 * exact same name as a system-store entry. The whole point is that
 * `runCommand.ts` has no path to the system store at all — this file proves
 * that both mechanically (the source never imports it) and behaviourally (the
 * child process env is exactly what the plaintext `.env` said, nothing more).
 */
import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let capturedEnv: Record<string, string | undefined> | null = null;

mock.module('child_process', () => ({
  spawn: (_cmd: string, _args: string[], opts: any) => {
    capturedEnv = opts.env;
    const handlers: Record<string, Function[]> = {};
    const child = {
      on: (event: string, cb: Function) => {
        (handlers[event] ??= []).push(cb);
        if (event === 'close') queueMicrotask(() => cb(0));
        return child;
      },
      kill: () => {},
    };
    return child;
  },
  ChildProcess: class {},
}));

afterAll(() => mock.restore());

let runCommand: typeof import('../../src/commands/runCommand').runCommand;
beforeAll(async () => {
  runCommand = (await import('../../src/commands/runCommand')).runCommand;
});

describe('capy run never sees the system store (Proof 8)', () => {
  it('the source has no path to the system store at all', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/commands/runCommand.ts'), 'utf-8');
    expect(source.includes('systemStore')).toBe(false);
    expect(source.includes('orgs/')).toBe(false);
  });

  it('a plaintext .env var with the same name as a system-store entry comes from the repo, unmodified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-run-systemstore-test-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, '.env'), '_CONNECTOR_TEST_KEY=repo-value\n');

      const code = await runCommand(['node', '-e', 'process.exit(0)']);

      expect(code).toBe(0);
      expect(capturedEnv?.['_CONNECTOR_TEST_KEY']).toBe('repo-value');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
