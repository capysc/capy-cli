/**
 * `capy list` (read-only, CAP-659 Phase 2/3) — its two early refusals
 * ("no keep.lock found", "could not read keep.lock") now honor `--json`
 * the same way the third ("no active branch") already did.
 */
import { mock, spyOn, jest, describe, it, expect, beforeEach, afterAll } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockReadKeepFile = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
    readKeepFile: mockReadKeepFile,
  })),
}));

afterAll(() => mock.restore());

import { ListCommand } from '../../src/commands/listCommand';

function captureExit(): { exitCode: () => number | undefined; restore: () => void } {
  let code: number | undefined;
  const spy = spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`__exit_${c}__`);
  }) as never);
  return { exitCode: () => code, restore: () => spy.mockRestore() };
}

function captureOutput(): { stdout: () => string; stderr: () => string; restore: () => void } {
  let out = '';
  let err = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => { out += a.join(' ') + '\n'; }) as any);
  const errSpy = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => { err += a.join(' ') + '\n'; }) as any);
  return { stdout: () => out, stderr: () => err, restore: () => { log.mockRestore(); errSpy.mockRestore(); } };
}

describe('ListCommand', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no keep.lock, human mode: unchanged prose on stderr, exit 1', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: false });
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new ListCommand().execute({})).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(exit.exitCode()).toBe(1);
    expect(out.stderr()).toContain('No keep.lock found');
    expect(out.stdout()).toBe('');
  });

  it('no keep.lock, --json: coded JSON on stdout, nothing on stderr', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: false });
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new ListCommand().execute({ json: true })).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(exit.exitCode()).toBe(1);
    expect(out.stderr()).toBe('');
    expect(JSON.parse(out.stdout())).toEqual({ ok: false, code: 'NO_KEEP_FILE', error: expect.any(String) });
  });

  it('keep.lock unreadable, --json: coded JSON, same NO_KEEP_FILE code', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: true });
    mockReadKeepFile.mockReturnValue(null);
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new ListCommand().execute({ json: true })).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(JSON.parse(out.stdout())).toEqual({ ok: false, code: 'NO_KEEP_FILE', error: 'Could not read keep.lock' });
  });

  it('keep.lock unreadable, human mode: same prose as before', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: true });
    mockReadKeepFile.mockReturnValue(null);
    const exit = captureExit();
    const out = captureOutput();
    try {
      await expect(new ListCommand().execute({})).rejects.toThrow('__exit_1__');
    } finally {
      exit.restore();
      out.restore();
    }
    expect(out.stderr()).toContain('Could not read keep.lock');
  });

  it('no active branch, --json: unchanged shape (the one that was already correct)', async () => {
    mockDetectProjectState.mockResolvedValue({ initialized: true, activeBranch: null });
    mockReadKeepFile.mockReturnValue({ project_name: 'demo', variables: {} });
    const out = captureOutput();
    try {
      await new ListCommand().execute({ json: true });
    } finally {
      out.restore();
    }
    expect(JSON.parse(out.stdout())).toEqual({ projectName: 'demo', branch: null, variables: [] });
  });
});
