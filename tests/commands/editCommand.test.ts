/**
 * `capy edit`'s terminal TUI (`EditScreen.run()`) enters the alternate
 * screen and draws every variable's plaintext unconditionally, with no TTY
 * check of its own — its only non-interactive handling is `ExitPromptError`
 * at the first keypress read, which fires AFTER the plaintext screen has
 * already gone out over stdout. `--web` exists specifically because of this
 * gap (see EditOpts' own docblock), but nothing stopped a caller from
 * omitting it.
 *
 * The fix this pins: `EditCommand.execute()` decides BEFORE doing any work
 * at all — before `ProjectManager`, before decrypting anything — via the
 * pure `editSurfaceIsSafe()` predicate, refusing with a coded error when
 * neither `--web` nor a real TTY on both streams is present.
 *
 * Test shape, deliberately: the decision table is unit-tested on the pure
 * predicate (no process state touched — assigning to or redefining
 * `process.std*.isTTY` is readonly in some runtimes and leaks a changed
 * property descriptor into sibling test files either way), and the wiring
 * is proven end-to-end by spawning the built CLI with piped stdio, which is
 * deterministically non-TTY on both streams in every environment.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { editSurfaceIsSafe } from '../../src/commands/editCommand';
import { ERROR_CODES } from '../../src/types/index';

const CLI = join(__dirname, '../../dist/index.js');

/** The alt-screen escape `EditScreen.run()` opens with — its presence on a
 * captured stdout is the leak this whole fix exists to prevent. */
const ALT_SCREEN_ENTER = '\x1b[?1049h';

function capyEdit(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, 'edit', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    env: {
      ...process.env,
      // Hermetic in every environment (CI has no auth state and may stall on
      // real network): past the guard, lock-less identity resolution must
      // fail FAST and OFFLINE — a discard-port origin refuses instantly, and
      // an isolated HOME keeps the developer's real ~/.capy-dev out of the
      // spawned process entirely. Neither affects the pre-network guard
      // refusal these tests pin.
      CAPY_API_URL: 'http://127.0.0.1:9',
      HOME: cwd,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe('editSurfaceIsSafe — the decision table', () => {
  test('--web is safe regardless of TTY state', () => {
    expect(editSurfaceIsSafe(true, false, false)).toBe(true);
    expect(editSurfaceIsSafe(true, undefined, undefined)).toBe(true);
    expect(editSurfaceIsSafe(true, true, true)).toBe(true);
  });

  test('a real terminal on both ends is safe', () => {
    expect(editSurfaceIsSafe(undefined, true, true)).toBe(true);
    expect(editSurfaceIsSafe(false, true, true)).toBe(true);
  });

  test('a missing TTY on either stream is unsafe (the leak is on stdout, not just stdin)', () => {
    expect(editSurfaceIsSafe(undefined, false, false)).toBe(false);
    expect(editSurfaceIsSafe(undefined, true, false)).toBe(false); // redirected stdout
    expect(editSurfaceIsSafe(undefined, false, true)).toBe(false); // piped stdin
  });

  test('the spawned-process shape (isTTY undefined) is unsafe', () => {
    expect(editSurfaceIsSafe(undefined, undefined, undefined)).toBe(false);
    expect(editSurfaceIsSafe(undefined, true, undefined)).toBe(false);
    expect(editSurfaceIsSafe(undefined, undefined, true)).toBe(false);
  });
});

describe('capy edit spawned headless (piped stdio — deterministically no TTY)', () => {
  const dir = join(tmpdir(), `capy-edit-cmd-${process.pid}-${Date.now()}`);

  test('refuses with the coded error before any work; no alt-screen, no prompt, non-zero exit', () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const r = capyEdit([], dir);

    expect(r.code).not.toBe(0);
    // The stable code travels with the thrown CapyError and appears in the
    // process's error output — the machine-visible signal of THIS refusal,
    // as opposed to any later one.
    expect(r.stderr).toContain(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    // The refusal names the sanctioned alternative.
    expect(r.stderr).toContain('capy edit --web');
    // And the leak itself cannot have happened: the alternate screen was
    // never entered and stdout carries nothing at all.
    expect(r.stdout).not.toContain(ALT_SCREEN_ENTER);
    expect(r.stdout).toBe('');

    rmSync(dir, { recursive: true, force: true });
  });

  test('--web passes the guard and reaches the same pre-existing keep.lock check as always', () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // No keep.lock in the directory. Single-user lock-less mode means this is
    // no longer a refusal ("No keep.lock" is gone): a run that clears the
    // surface guard proceeds into lock-less identity resolution, which in
    // this headless spawn fails further along (auth/project lookup). The
    // guard-passed evidence is the ABSENCE of the gate's code and of any
    // alt-screen write — asserted the same as before.
    const r = capyEdit(['--web'], dir);

    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    expect(r.stdout).not.toContain(ALT_SCREEN_ENTER);

    rmSync(dir, { recursive: true, force: true });
  });
});
