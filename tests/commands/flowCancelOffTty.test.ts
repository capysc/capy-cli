/**
 * `capy flow cancel <id>` — end-to-end proof that the off-TTY confirmation
 * gate is actually wired from argv (src/index.ts) through to
 * FlowCancelCommand, with a genuinely non-TTY stdin.
 *
 * The command's own decision table (which code, which JSON shape, which
 * options combine to skip/force the refusal) is unit-tested in
 * tests/commands/flowCancelCommand.test.ts against a mocked AuthService/
 * ServiceClient. This file tests something that suite cannot: that spawning
 * the REAL built CLI with piped stdio (deterministically non-TTY on every
 * platform and in CI, unlike asserting to `process.stdin.isTTY` — readonly
 * in some runtimes and a cross-file leak either way) actually refuses before
 * doing any work, rather than hanging on a prompt or reaching the network.
 *
 * No keep.lock, no auth fixture, no mocked service: the refusal has to fire
 * before any of that would even be looked for, so none of it is set up.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI = join(__dirname, '../../dist/index.js');

function capyFlowCancel(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  // No `stdio` override: spawnSync's default is `'pipe'` for all three
  // streams, which is deterministically non-TTY on stdin regardless of
  // whether the parent test runner itself has one.
  const r = spawnSync('node', [CLI, 'flow', 'cancel', ...args], { cwd, encoding: 'utf-8', timeout: 15000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe('capy flow cancel — off-TTY (piped stdio, deterministically no TTY)', () => {
  const dir = join(tmpdir(), `capy-flow-cancel-${process.pid}-${Date.now()}`);

  test('refuses with EXIT_NEEDS_INPUT (3) before any work, and cancels nothing', () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const r = capyFlowCancel(['flow-abc'], dir);

    expect(r.code).toBe(3);
    expect(r.stderr).toContain('non-interactive');
    // The sanctioned alternative is named in the refusal.
    expect(r.stderr).toContain('--yes');
    // Never reached a confirmation prompt or any output claiming success.
    expect(r.stdout).not.toContain('cancelled');

    rmSync(dir, { recursive: true, force: true });
  });

  test('--json honours the same refusal as structured output instead of a bare exit', () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const r = capyFlowCancel(['flow-abc', '--json'], dir);

    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('FLOW_CANCEL_CONFIRMATION_REQUIRED');
    expect(parsed.flow_id).toBe('flow-abc');

    rmSync(dir, { recursive: true, force: true });
  });

  test('--non-tty forces the same refusal even if the flag itself were run at a real terminal', () => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const r = capyFlowCancel(['flow-abc', '--non-tty'], dir);

    expect(r.code).toBe(3);
    expect(r.stderr).toContain('non-interactive');

    rmSync(dir, { recursive: true, force: true });
  });
});
