/**
 * `--web` was removed. An agent that still passes it gets the coded refusal
 * `WEB_MODE_REMOVED` and exit 1, and the command is NOT run.
 *
 * Exercised against the real BUILT cli (both entrypoints) — needs
 * `bun run build` first, like the other tests that spawn `dist/`. A throwaway
 * HOME and an empty working directory mean that a command which did run would
 * print its own refusal (no keep.lock, no session) instead of this one.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD_CLI = join(__dirname, '../../dist/index.js');
const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

function run(cli: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const home = mkdtempSync(join(tmpdir(), 'capy-webgone-'));
  try {
    const r = spawnSync('node', [cli, ...args], {
      encoding: 'utf-8',
      cwd: home,
      env: { ...process.env, HOME: home, CAPY_WEB_NO_OPEN: '1' },
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('--web is refused with WEB_MODE_REMOVED', () => {
  for (const [name, cli] of [['capy', PROD_CLI], ['capy-dev', DEV_CLI]] as const) {
    test(`${name}: --json prints { ok:false, code, error } on stdout and exits 1`, () => {
      const r = run(cli, ['--web', 'info', '--json']);
      expect(r.code).toBe(1);
      const body = JSON.parse(r.stdout);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('WEB_MODE_REMOVED');
      expect(typeof body.error).toBe('string');
    });

    test(`${name}: without --json the sentence goes to stderr, stdout stays empty, exit 1`, () => {
      const r = run(cli, ['--web', 'info']);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  }

  test('wherever the flag sits, the command does not run', () => {
    for (const args of [
      ['info', '--web'],
      ['add', 'SOME_NAME', '--web', '--json'],
      ['edit', '--web', '--json'],
      ['deploy', '--web', '--json'],
      ['rotate', '--web', '--json'],
    ]) {
      const r = run(PROD_CLI, args);
      expect(r.code, args.join(' ')).toBe(1);
      const out = r.stdout.trim();
      // A command that ran would have refused for its own reason (no keep.lock).
      if (out.startsWith('{')) expect(JSON.parse(out).code, args.join(' ')).toBe('WEB_MODE_REMOVED');
      else expect(r.stderr, args.join(' ')).not.toContain('keep.lock');
    }
  });
});

describe('help hides the flag but lists the code', () => {
  test('--web is in no option list of `capy help --json`; the error code is listed', () => {
    const r = run(PROD_CLI, ['help', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const optionFlags: string[] = [];
    const visit = (cmds: any[]): void => {
      for (const c of cmds) {
        for (const o of c.options) optionFlags.push(o.long);
        visit(c.subcommands);
      }
    };
    visit(doc.commands);
    expect(optionFlags).not.toContain('--web');
    expect(doc.errorCodes).toContain('WEB_MODE_REMOVED');
  });

  test('--web is not in the human --help either', () => {
    const r = run(PROD_CLI, ['--help']);
    expect(r.stdout).not.toContain('--web');
  });
});
