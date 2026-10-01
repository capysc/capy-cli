/**
 * CAP-520 / CAP-659 — the shared non-interactive auth gate, exercised
 * end-to-end through the real BUILT CLI (`capy-dev`, needs `bun run build`
 * first, same constraint as `helpJsonCli.test.ts`).
 *
 * Every case here runs with: no TTY (stdin is closed input, same as a piped
 * or agent-spawned run), an isolated global dir (`CAPY_GLOBAL_DIR_NAME`, so
 * there is no cached session — a fresh machine), and an unreachable
 * `CAPY_API_URL` (so if the gate were ever bypassed, the run would fail
 * loudly on a connection error rather than quietly appearing to work).
 *
 * Deliberately `capy-dev` (`dist/index-dev.js`), never `capy` (`dist/
 * index.js`): the prod entrypoint's `applyProdPins()` strips
 * `CAPY_API_URL`/`CAPY_GLOBAL_DIR_NAME` overrides and always resolves
 * against the real `~/.capy` — there is no way to isolate it from a real
 * signed-in developer's session, so it must never be spawned in a test.
 *
 * What each case proves:
 *  - exits `3` (`EXIT_NEEDS_INPUT`), not `1` and not left hanging
 *  - returns well inside a few seconds — the bug this closes was a 5-MINUTE
 *    hang (the OAuth callback server's own timeout), so a fast exit is
 *    itself evidence the browser/callback-server path was never reached
 *  - under `--json`, stdout is parseable as exactly one `{ok:false,
 *    code:'AUTH_NEEDS_TTY'}` object; otherwise stdout carries no sign-in
 *    prose (the hint goes to stderr)
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

/** A fresh temp dir per case, isolated `CAPY_GLOBAL_DIR_NAME`, no TTY (closed stdin), no reachable server. */
function runGated(args: string[]): { stdout: string; stderr: string; code: number; ms: number } {
  const cwd = mkdtempSync(join(tmpdir(), 'capy-auth-needs-tty-'));
  const start = Date.now();
  try {
    const r = spawnSync('node', [DEV_CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      input: '', // closed stdin — never a TTY, same as a piped/agent run
      env: {
        ...process.env,
        CAPY_GLOBAL_DIR_NAME: '.capy-auth-needs-tty-test', // fresh — no cached session
        CAPY_WEB_NO_OPEN: '1', // belt-and-suspenders: never opens a real browser either
        CAPY_API_URL: 'http://127.0.0.1:1', // unreachable — loud failure if the gate is ever bypassed
      },
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1, ms: Date.now() - start };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const EXIT_NEEDS_INPUT = 3;
// Generous relative to the 300_000ms (5 min) OAuth callback timeout this
// closes — anything this far under it proves the browser/server path was
// never started, without being so tight it flakes on a loaded CI box.
const MAX_MS = 10_000;

describe('non-interactive auth gate (CAP-520/CAP-659) — real CLI, no TTY, no session', () => {
  test('bare `capy-dev`: refuses instead of opening a browser', () => {
    const { code, stdout, stderr, ms } = runGated([]);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(stdout).not.toContain('Starting OAuth');
    expect(stdout).not.toContain('If the browser'); // the auth_url prose never reaches stdout
    expect(stderr).toContain('Run `capy` in a terminal to sign in.');
  });

  test('`secrets --json`: pure JSON refusal on stdout, nothing else', () => {
    const { code, stdout, ms } = runGated(['secrets', '--json']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    const parsed = JSON.parse(stdout); // throws if stdout isn't pure JSON
    expect(parsed).toEqual({ ok: false, code: 'AUTH_NEEDS_TTY' });
  });

  test('`projects --json`: same coded JSON shape', () => {
    const { code, stdout, ms } = runGated(['projects', '--json']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(JSON.parse(stdout)).toEqual({ ok: false, code: 'AUTH_NEEDS_TTY' });
  });

  test('`invite <email> --json --non-tty`: the flag alone is enough (no stdin probe needed)', () => {
    const { code, stdout, ms } = runGated(['invite', 'teammate@example.com', '--json', '--non-tty']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(JSON.parse(stdout)).toEqual({ ok: false, code: 'AUTH_NEEDS_TTY' });
  });

  test('`system list --json`: org-system-store path reaches the same gate', () => {
    const { code, stdout, ms } = runGated(['system', 'list', '--json']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUTH_NEEDS_TTY');
  });

  test('`kick <email>`: no --json on this command — stderr hint, pure-empty stdout', () => {
    const { code, stdout, stderr, ms } = runGated(['kick', 'teammate@example.com']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(stdout).toBe('');
    expect(stderr).toContain('Run `capy` in a terminal to sign in.');
  });

  test('`org`: refuses before any org picker renders', () => {
    const { code, stderr, ms } = runGated(['org']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(stderr).toContain('Run `capy` in a terminal to sign in.');
  });

  test('`recover`: refuses before printing "Launching browser" — that promise is never made and then broken', () => {
    const { code, stdout, stderr, ms } = runGated(['recover']);
    expect(code).toBe(EXIT_NEEDS_INPUT);
    expect(ms).toBeLessThan(MAX_MS);
    expect(stdout).not.toContain('Launching browser');
    expect(stderr).toContain('Run `capy` in a terminal to sign in.');
  });
});
