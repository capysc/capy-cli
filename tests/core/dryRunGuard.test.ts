/**
 * The global `-d/--dry-run` never runs a command for real. A command either honors it (DRY_RUN_COMMANDS), only
 * reads, or is refused with DRY_RUN_UNSUPPORTED before its handler starts (src/core/dryRunGuard.ts).
 *
 * The unit half pins the classification; the CLI half runs the built CLI (dist/index.js, `bun run build`) in an
 * empty folder, where any command that got as far as its handler would fail some other way, so exit 1 plus the
 * refusal sentence proves the guard stopped it first.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { DRY_RUN_COMMANDS } from '../../src/core/cliHelpDoc';
import { commandPath, dryRunRefusal } from '../../src/core/dryRunGuard';

describe('dryRunRefusal', () => {
  test('commands that preview are allowed', () => {
    for (const path of DRY_RUN_COMMANDS) expect(dryRunRefusal(path, {})).toBeUndefined();
  });

  test('bare capy is left to CapyCommand (it previews a sync, refuses first-time setup)', () => {
    expect(dryRunRefusal('', {})).toBeUndefined();
  });

  test('commands that only read are allowed', () => {
    for (const path of ['status', 'info', 'list', 'help', 'branch', 'deploy list', 'deploy targets', 'profile list']) {
      expect(dryRunRefusal(path, {})).toBeUndefined();
    }
  });

  test('a read command used in a mode that writes is refused', () => {
    expect(dryRunRefusal('branch', { D: 'staging' })).toContain('capy branch');
    expect(dryRunRefusal('users', {})).toContain('capy users');
    expect(dryRunRefusal('users', { json: true })).toBeUndefined();
  });

  test('commands that change state and cannot preview are refused', () => {
    for (const path of ['checkout', 'push', 'kick', 'invite', 'rotate', 'org', 'logout', 'lock', 'deploy revoke', 'system rm', 'recover', 'cleanup']) {
      expect(dryRunRefusal(path, {})).toContain(`capy ${path}`);
    }
  });

  test('capy run explains how to pass --dry-run to the child command', () => {
    expect(dryRunRefusal('run', {})).toContain('capy run -- <cmd> --dry-run');
  });
});

describe('commandPath', () => {
  test('names from the root down, without the root', () => {
    const root = new Command('capy');
    const deploy = root.command('deploy');
    const remove = deploy.command('targets-remove');
    expect(commandPath(root)).toBe('');
    expect(commandPath(deploy)).toBe('deploy');
    expect(commandPath(remove)).toBe('deploy targets-remove');
  });
});

describe('the built CLI refuses --dry-run before a command that cannot preview runs', () => {
  const run = (args: string[]): { stdout: string; stderr: string; code: number; files: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-dry-run-guard-'));
    try {
      const r = spawnSync('node', [join(__dirname, '../../dist/index.js'), ...args], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, CAPY_WEB_NO_OPEN: '1', CAPY_NO_REPO_LINK: '1' },
      });
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1, files: readdirSync(dir) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.each([
    [['checkout', 'staging', '--dry-run'], 'capy checkout'],
    [['--dry-run', 'kick', 'someone@example.test'], 'capy kick'],
    [['branch', '-D', 'staging', '--dry-run'], 'capy branch'],
    [['cleanup', '-d'], 'capy cleanup'],
  ])('%p', (args, name) => {
    const r = run(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`--dry-run isn't available for ${name}`);
    expect(r.files).toEqual([]);
  });

  test('--json gets the refusal as JSON on stdout', () => {
    const r = run(['checkout', 'staging', '--dry-run', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 'DRY_RUN_UNSUPPORTED' });
    expect(r.files).toEqual([]);
  });

  test('users is refused without --json (its screen can change roles)', () => {
    const r = run(['users', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--dry-run isn't available for capy users");
  });

  test('bare capy in a folder that is not set up refuses and creates nothing', () => {
    const r = run(['--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--dry-run can't preview first-time setup");
    expect(r.files).toEqual([]);
  });
});
