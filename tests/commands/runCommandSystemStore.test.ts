import { mock, describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const spawn = mock((_cmd: string, _args: readonly string[], _opts: Readonly<{ env: Readonly<Record<string, string | undefined>> }>) => ({
  on: (event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'close') queueMicrotask(() => cb(0));
  },
  kill: () => {},
}));
mock.module('child_process', () => ({ spawn, ChildProcess: class {} }));
afterAll(() => mock.restore());
const { runCommand } = await import('../../src/commands/runCommand');

describe('capy run never sees the system store', () => {
  it('the source has no path to the system store', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/commands/runCommand.ts'), 'utf-8');
    expect(source.includes('systemStore')).toBe(false);
    expect(source.includes('orgs/')).toBe(false);
  });
  it('an explicitly selected repo variable is passed without consulting the system store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-run-systemstore-test-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync(join(dir, '.env'), '_CONNECTOR_TEST_KEY=repo-value\n');
      writeFileSync(join(dir, 'keep.lock'), JSON.stringify({org_id:'o',project_id:'p',variables:{}}));
      mkdirSync(join(dir,'.capy'));
      writeFileSync(join(dir,'.capy','branch'),'local');
      const code = await runCommand(['node', '-e', 'process.exit(0)'], false, {org:'o',project:'p',branch:'local',only:'_CONNECTOR_TEST_KEY'});
      expect(code).toBe(0);
      expect(spawn.mock.calls.at(-1)?.[2].env['_CONNECTOR_TEST_KEY']).toBe('repo-value');
    } finally {
      process.chdir(cwd);
      rmSync(dir, {recursive:true,force:true});
    }
  });
});
