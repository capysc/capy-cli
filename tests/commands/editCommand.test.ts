/**
 * `capy edit`'s terminal TUI (`EditScreen.run()`) enters the alternate
 * screen and draws every variable's plaintext unconditionally, with no TTY
 * check of its own — `editScreen.ts`'s only non-interactive handling is
 * `ExitPromptError` at the first keypress read, which fires AFTER the
 * plaintext screen has already gone out over stdout. `--web` exists
 * specifically because of this gap (see EditOpts' own docblock), but
 * nothing stopped a caller from omitting it.
 *
 * The fix this pins: `EditCommand.execute()` now decides BEFORE doing any
 * work at all — before `ProjectManager`, before decrypting anything —
 * refusing with a coded error when neither stdin nor stdout is a real TTY
 * and `--web` wasn't passed. These tests prove: (1) the refusal fires for
 * every combination of a missing TTY on either stream, with nothing at all
 * printed; (2) `--web` bypasses it, same as before; (3) a real terminal on
 * both ends is unaffected — the run proceeds to the same pre-existing
 * checks it always has.
 */
import { describe, test, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { EditCommand } from '../../src/commands/editCommand';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const savedStdinTTY = process.stdin.isTTY;
const savedStdoutTTY = process.stdout.isTTY;
const withTty = (stdin: boolean | undefined, stdout: boolean | undefined) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
};

/** Everything the command wrote, in order — same helper shape as the other command-level tests. */
function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return {
    out: () => buf,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutTTY, configurable: true });
});

describe('EditCommand — no real terminal, no --web', () => {
  test('refuses with a coded error before touching the project; nothing printed', async () => {
    withTty(false, false);
    const cap = captureOutput();
    let caught: unknown;
    try {
      await new EditCommand().execute({});
    } catch (err) {
      caught = err;
    } finally {
      cap.restore();
    }

    expect(caught).toBeInstanceOf(CapyError);
    expect((caught as CapyError).code).toBe(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    // No secret value can leak because nothing — not even a status line —
    // was written. The guard fires before `ProjectManager` is ever
    // constructed, so there is no project state to have decrypted yet.
    expect(cap.out()).toBe('');
  });

  test('refuses when stdin is a TTY but stdout is not (redirected output)', async () => {
    withTty(true, false);
    const cap = captureOutput();
    let caught: unknown;
    try {
      await new EditCommand().execute({});
    } catch (err) {
      caught = err;
    } finally {
      cap.restore();
    }
    expect((caught as CapyError)?.code).toBe(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    expect(cap.out()).toBe('');
  });

  test('refuses when stdout is a TTY but stdin is not (piped input)', async () => {
    withTty(false, true);
    const cap = captureOutput();
    let caught: unknown;
    try {
      await new EditCommand().execute({});
    } catch (err) {
      caught = err;
    } finally {
      cap.restore();
    }
    expect((caught as CapyError)?.code).toBe(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    expect(cap.out()).toBe('');
  });

  test('the refusal names the --web escape hatch', async () => {
    withTty(false, false);
    const cap = captureOutput();
    try {
      await new EditCommand().execute({});
    } catch (err) {
      expect((err as CapyError).message).toContain('capy edit --web');
    } finally {
      cap.restore();
    }
  });
});

// ── Past the guard: same pre-existing checks, unaffected ───────────────────
//
// Both scenarios below chdir into a fresh directory with no keep.lock, so
// `EditCommand.execute()` — once it clears the new TTY guard — hits the same
// "No keep.lock found" refusal it always has. That refusal calls
// `process.exit(1)` directly rather than throwing, so it's mocked the same
// way the rest of this suite mocks a hard process.exit.

const TEST_DIR = join(tmpdir(), `capy-edit-cmd-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

describe('EditCommand — past the guard', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
    mockExit.mockClear();
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('--web bypasses the terminal-only refusal even with no TTY at all', async () => {
    withTty(false, false);
    const cap = captureOutput();
    try {
      await expect(new EditCommand().execute({ web: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    // Reached the pre-existing "no keep.lock" refusal, not the new one.
    expect(cap.out()).toContain('No keep.lock');
    expect(cap.out()).not.toContain('draw a full-screen editor');
  });

  test('a real terminal on both ends is unaffected: same pre-existing checks run', async () => {
    withTty(true, true);
    const cap = captureOutput();
    try {
      await expect(new EditCommand().execute({})).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('No keep.lock');
    expect(cap.out()).not.toContain('draw a full-screen editor');
  });
});
