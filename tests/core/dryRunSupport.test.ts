/**
 * CAP-659 Phase 1 — the dry-run support table and its coverage guarantee.
 *
 * Two layers, matching the house pattern in `tests/core/cliHelpDoc.test.ts`
 * (hand-built trees) + `tests/commands/helpJsonCli.test.ts` (the real,
 * built CLI):
 *   1. `dryRunCommandPaths` against small hand-built Commander trees,
 *      including a HIDDEN command — proves the walker really does include
 *      hidden commands, which capy-cli's real `main` tree has none of today
 *      to exercise this against.
 *   2. The real support table against the real, built CLI's command list
 *      (`capy help --json`, the same source of truth
 *      `tests/docs/cliReferenceStaleness.test.ts` trusts) — every
 *      non-hidden registered command must have an entry (or a documented
 *      override), and the table must not name a command that doesn't exist.
 *      Needs `bun run build` first, same as the other tests that spawn
 *      `dist/`.
 */
import { describe, test, expect } from 'bun:test';
import { Command } from 'commander';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  COMMAND_DRY_RUN_SUPPORT,
  KNOWN_ACTIONLESS_PARENT_PATHS,
  ROOT_COMMAND_PATH,
  dryRunCommandPaths,
  resolveDryRunSupport,
} from '../../src/core/dryRunSupport';

const PROD_CLI = join(__dirname, '../../dist/index.js');

function flattenHelpPaths(commands: any[]): string[] {
  return commands.flatMap((c: any) => [c.path, ...flattenHelpPaths(c.subcommands ?? [])]);
}

// Commands whose dry-run level depends on the invocation, not just the
// path — their table entry is a conservative baseline only, never the
// final answer. See `src/core/dryRunSupport.ts`'s own overrides.
const OVERRIDDEN_PATHS = new Set(['deploy', 'connect', 'branch']);

describe('dryRunCommandPaths — walks a hand-built tree, hidden included', () => {
  function buildTree(): Command {
    const program = new Command();
    program.name('capy').description('Capy CLI').version('9.9.9');
    program.action(() => {}); // bare root has its own action, like the real CLI

    program.command('status').description('Show status').action(() => {});

    const deploy = program.command('deploy').description('Deploy').action(() => {});
    deploy.command('revoke <id>').description('Revoke').action(() => {});

    // A bare parent with NO action of its own — like the real `profile`/
    // `system` — must be left out: Commander dispatches it straight to
    // `--help` without ever reaching a `preAction` hook.
    const profile = program.command('profile').description('Manage profiles');
    profile.command('list').description('List').action(() => {});

    // Hidden, with its own action — must still be walked.
    program.command('__internal-only', { hidden: true }).description('hidden').action(() => {});

    return program;
  }

  test('includes the bare root, leaf commands and nested subcommands', () => {
    const paths = dryRunCommandPaths(buildTree());
    expect(paths).toContain(ROOT_COMMAND_PATH);
    expect(paths).toContain('status');
    expect(paths).toContain('deploy');
    expect(paths).toContain('deploy revoke');
    expect(paths).toContain('profile list');
  });

  test('includes a hidden command', () => {
    const paths = dryRunCommandPaths(buildTree());
    expect(paths).toContain('__internal-only');
  });

  test('excludes a bare parent with no action of its own', () => {
    const paths = dryRunCommandPaths(buildTree());
    expect(paths).not.toContain('profile');
  });

  test('a program with no bare-root action omits the root path', () => {
    const program = new Command();
    program.name('capy');
    program.command('status').action(() => {});
    const paths = dryRunCommandPaths(program);
    expect(paths).not.toContain(ROOT_COMMAND_PATH);
    expect(paths).toContain('status');
  });
});

describe('COMMAND_DRY_RUN_SUPPORT — coverage against the real, built CLI', () => {
  test('every real, registered command has a table entry or a documented override', () => {
    const help = spawnSync('node', [PROD_CLI, 'help', '--json'], { encoding: 'utf-8' });
    expect(help.status).toBe(0);
    const doc = JSON.parse(help.stdout);
    const realPaths = new Set(flattenHelpPaths(doc.commands));

    const missing = [...realPaths].filter(
      (path) =>
        !OVERRIDDEN_PATHS.has(path) &&
        !COMMAND_DRY_RUN_SUPPORT.has(path) &&
        !KNOWN_ACTIONLESS_PARENT_PATHS.has(path),
    );
    expect(missing, `real commands with no dry-run support entry: ${missing.join(', ')}`).toEqual([]);
  });

  test('the bare root has an entry', () => {
    expect(COMMAND_DRY_RUN_SUPPORT.has(ROOT_COMMAND_PATH)).toBe(true);
  });

  test('every table entry names a real command, the bare root, or a documented override path', () => {
    const help = spawnSync('node', [PROD_CLI, 'help', '--json'], { encoding: 'utf-8' });
    const doc = JSON.parse(help.stdout);
    const realPaths = new Set(flattenHelpPaths(doc.commands));

    const stale = [...COMMAND_DRY_RUN_SUPPORT.keys()].filter(
      (path) => path !== ROOT_COMMAND_PATH && !realPaths.has(path),
    );
    expect(stale, `table entries naming commands that don't exist: ${stale.join(', ')}`).toEqual([]);
  });

  test('known actionless parents have no table entry (nothing can run there under --dry-run)', () => {
    for (const path of KNOWN_ACTIONLESS_PARENT_PATHS) {
      expect(COMMAND_DRY_RUN_SUPPORT.has(path), `"${path}" has a table entry but is documented as actionless`).toBe(false);
    }
  });

  test('every overridden path is itself a real, registered command', () => {
    const help = spawnSync('node', [PROD_CLI, 'help', '--json'], { encoding: 'utf-8' });
    const doc = JSON.parse(help.stdout);
    const realPaths = new Set(flattenHelpPaths(doc.commands));
    for (const path of OVERRIDDEN_PATHS) {
      expect(realPaths.has(path), `override path "${path}" is not a real command`).toBe(true);
    }
  });
});

describe('resolveDryRunSupport', () => {
  test('falls back to the flat table for an ordinary path', () => {
    expect(resolveDryRunSupport('status')).toBe('read_only');
    expect(resolveDryRunSupport('cleanup')).toBe('unsupported');
  });

  test('an unmapped path resolves to undefined (guard treats it as unsupported)', () => {
    expect(resolveDryRunSupport('this-command-does-not-exist')).toBeUndefined();
  });

  test('deploy: token mode (no target/connect/positional) is unsupported', () => {
    expect(resolveDryRunSupport('deploy', { opts: {}, args: [] })).toBe('unsupported');
  });

  test('deploy: --target flips to preview', () => {
    expect(resolveDryRunSupport('deploy', { opts: { target: 'worker-prod' }, args: [] })).toBe('preview');
  });

  test('deploy: --connect flips to preview', () => {
    expect(resolveDryRunSupport('deploy', { opts: { connect: true }, args: [] })).toBe('preview');
  });

  test('deploy: a positional target flips to preview', () => {
    expect(resolveDryRunSupport('deploy', { opts: {}, args: ['worker-prod'] })).toBe('preview');
  });

  test('connect: no provider is read_only', () => {
    expect(resolveDryRunSupport('connect', { opts: {}, args: [] })).toBe('read_only');
  });

  test('connect: a provider is unsupported', () => {
    expect(resolveDryRunSupport('connect', { opts: {}, args: ['stripe'] })).toBe('unsupported');
  });

  test('branch: no -D is read_only', () => {
    expect(resolveDryRunSupport('branch', { opts: {}, args: [] })).toBe('read_only');
  });

  test('branch: -D is unsupported', () => {
    expect(resolveDryRunSupport('branch', { opts: { D: 'some-branch' }, args: [] })).toBe('unsupported');
  });
});
