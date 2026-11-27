/**
 * `--folder <path>` (`core/folderFlag.ts`): an existing folder is entered; anything else is FOLDER_NOT_FOUND before any
 * command runs, as JSON for an agent and as prose at a terminal.
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { enterFolder } from '../../src/core/folderFlag';

const ORIGIN = process.cwd();
afterEach(() => process.chdir(ORIGIN));

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

function attempt(folder: string, opts: Record<string, unknown>): { exitCode?: number; stdout: string; stderr: string } {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  let exitCode: number | undefined;
  try {
    enterFolder(folder, opts);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  }
  const stdout = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  return { exitCode, stdout, stderr };
}

describe('--folder', () => {
  test('an existing folder is entered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-folder-flag-'));
    const out = attempt(dir, { json: true });
    expect(out.exitCode).toBeUndefined();
    expect(process.cwd()).toBe(realpathSync(dir));
    process.chdir(ORIGIN);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing folder is FOLDER_NOT_FOUND in JSON for an agent, and nothing is entered', () => {
    const out = attempt(join(tmpdir(), 'capy-no-such-folder-9f2c'), { json: true });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'FOLDER_NOT_FOUND' });
    expect(process.cwd()).toBe(ORIGIN);
  });

  test('a file is not a folder either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-folder-flag-'));
    writeFileSync(join(dir, 'file'), 'x', 'utf-8');
    const out = attempt(join(dir, 'file'), { nonTty: true });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    rmSync(dir, { recursive: true, force: true });
  });
});
