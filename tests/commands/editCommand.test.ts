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
import { describe, test, expect, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, spawn } from 'child_process';

import { authenticateForEdit, editSurfaceIsSafe } from '../../src/commands/editCommand';
import { ERROR_CODES, type AuthResult } from '../../src/types/index';

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

const PRINTED_URL = /http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+/;

/**
 * Same as `capyEdit`, for a run that clears the TTY guard (`--web`) and can
 * reach a real error's `--web` ending page. `src/ui/endingPage.ts` holds the
 * process open until a browser has fetched that page (bounded by its own
 * 60s ceiling) — under `bun test` (`NODE_ENV=test`) nothing ever opens one
 * automatically (see `openScreen.ts`'s own suppression), so a plain
 * `spawnSync` would sit on that ceiling and blow past both its own 10s
 * timeout and bun's shorter default per-test timeout.
 *
 * `tests/commands/rotateRefusals.test.ts` hits the identical contract
 * in-process by fetching the printed URL itself; this does the same thing
 * across a real subprocess boundary — spawn async, watch stdout for the
 * loopback URL the run prints, fetch it to unblock the wait, then let the
 * process reach its actual exit.
 */
async function capyEditWeb(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = spawn('node', [CLI, 'edit', ...args], {
    cwd,
    env: {
      ...process.env,
      CAPY_API_URL: 'http://127.0.0.1:9',
      HOME: cwd,
    },
  });
  const collected = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => { collected.stdout += chunk.toString('utf-8'); });
  child.stderr.on('data', (chunk: Buffer) => { collected.stderr += chunk.toString('utf-8'); });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const url = collected.stdout.match(PRINTED_URL)?.[0];
    if (url) {
      await fetch(url).catch(() => {});
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const code = await exited;
  return { stdout: collected.stdout, stderr: collected.stderr, code: code ?? 1 };
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

const authenticated = (userId: string): AuthResult => ({ success: true, user_id: userId });
const notAuthenticated = (): AuthResult => ({ success: false });

describe('authenticateForEdit', () => {
  test('uses one scoped silent check for a hosted identity and never repairs authentication', async () => {
    const authenticateSilent = mock(async () => authenticated('user_fixture'));
    const authenticate = mock(async () => authenticated('user_fixture'));

    const result = await authenticateForEdit(
      { authenticateSilent, authenticate },
      'org_fixture',
      'user_fixture',
    );

    expect(result).toEqual(authenticated('user_fixture'));
    expect(authenticateSilent).toHaveBeenCalledTimes(1);
    expect(authenticateSilent).toHaveBeenCalledWith('org_fixture');
    expect(authenticate).not.toHaveBeenCalled();
  });

  test('rejects a missing or mismatched hosted session without an account-switch fallback', async () => {
    const missingSilent = mock(async () => notAuthenticated());
    const missingInteractive = mock(async () => authenticated('user_fixture'));
    const mismatchSilent = mock(async () => authenticated('other_user'));
    const mismatchInteractive = mock(async () => authenticated('user_fixture'));

    await expect(authenticateForEdit(
      { authenticateSilent: missingSilent, authenticate: missingInteractive },
      'org_fixture',
      'user_fixture',
    )).rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });
    await expect(authenticateForEdit(
      { authenticateSilent: mismatchSilent, authenticate: mismatchInteractive },
      'org_fixture',
      'user_fixture',
    )).rejects.toMatchObject({ code: ERROR_CODES.AUTH_FAILED });

    expect(missingSilent).toHaveBeenCalledWith('org_fixture');
    expect(missingInteractive).not.toHaveBeenCalled();
    expect(mismatchSilent).toHaveBeenCalledWith('org_fixture');
    expect(mismatchInteractive).not.toHaveBeenCalled();
  });

  test('retains the ordinary interactive fallback after both silent checks fail', async () => {
    const authenticateSilent = mock(async () => notAuthenticated());
    const authenticate = mock(async () => authenticated('user_fixture'));

    const result = await authenticateForEdit({ authenticateSilent, authenticate }, 'org_fixture');

    expect(result).toEqual(authenticated('user_fixture'));
    expect(authenticateSilent).toHaveBeenNthCalledWith(1, 'org_fixture');
    expect(authenticateSilent).toHaveBeenNthCalledWith(2);
    expect(authenticate).toHaveBeenCalledWith('org_fixture');
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

  test('--web passes the guard and reaches the same pre-existing keep.lock check as always', async () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // No keep.lock in the directory: `--web` clears the TTY safety guard
    // (`editSurfaceIsSafe`, unit-tested above) and reaches the same
    // NO_KEEP_FILE refusal every other entry to `capy edit` hits — it just
    // gets there through the web ending page instead of a plain terminal
    // exit. The guard-passed evidence is the ABSENCE of the guard's own code
    // and of any alt-screen write.
    const r = await capyEditWeb(['--web'], dir);

    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain(ERROR_CODES.EDIT_SCREEN_UNSAFE_SURFACE);
    expect(r.stdout).not.toContain(ALT_SCREEN_ENTER);

    rmSync(dir, { recursive: true, force: true });
  });
});
