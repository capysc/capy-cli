/**
 * CAP-729, through the BUILT cli and its real argument parser (the piped harness: an isolated HOME and a mock service).
 * Needs `bun run build` first.
 *
 *   1. `org delete-project --force` reaches the command. The program defines `-f/--force` and `org` defines `--non-tty`,
 *      so commander gives those flags to the outer command and the subcommand's own options never hold them.
 *   2. A folder whose project was deleted (the service answers 410 `PROJECT_DELETED`): bare `capy`, `capy status` and
 *      `capy push` end non-zero with that code, offer no recreate, and leave keep.lock byte-identical.
 */
import { describe, test, expect } from 'bun:test';
import { Command } from 'commander';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withHarness, PROJECT_ID, type Harness } from '../helpers/pipedHarness';
import { lifecycleOptsFrom } from '../../src/commands/projectLifecycleCommand';

const NAME = 'DELETED_FOLDER_TOKEN';
const RESTORE = `capy org restore-project ${PROJECT_ID}`;
const QUIET = { CAPY_NO_REPO_LINK: '1' } as const;

const requests = (h: Harness, method: string) => h.requests().filter((r) => r.method === method && r.path.includes('/projects/'));

/** A folder with one real secret, then the project deleted on the service side and the keep cache gone (so a read must go to the service). */
async function deletedFolder(h: Harness): Promise<void> {
  const seeded = await h.run(['edit', NAME, '--json', '--no-pr'], 'first-value\n', undefined, QUIET);
  expect(seeded.code).toBe(0);
  rmSync(join(h.home, '.capy', 'keep'), { recursive: true, force: true });
  h.markProjectDeleted();
}

describe('org delete-project / restore-project / projects: flags the program or `org` also defines', () => {
  test('--force arrives: the DELETE body is {"force":true}; without it there is no body', async () => {
    await withHarness(async (h) => {
      const forced = await h.run(['org', 'delete-project', PROJECT_ID, '--force', '--yes', '--json']);
      expect(forced.code).toBe(0);
      const without = await h.run(['org', 'delete-project', PROJECT_ID, '--yes', '--json']);
      expect(without.code).toBe(0);

      const deletes = requests(h, 'DELETE');
      expect(deletes.map((r) => r.body)).toEqual([JSON.stringify({ force: true }), '']);
    });
  });

  test('-f, typed before the subcommand or after it, is the same flag', async () => {
    await withHarness(async (h) => {
      await h.run(['-f', 'org', 'delete-project', PROJECT_ID, '--yes', '--json']);
      await h.run(['org', 'delete-project', PROJECT_ID, '-f', '--yes', '--json']);
      expect(requests(h, 'DELETE').map((r) => r.body)).toEqual([JSON.stringify({ force: true }), JSON.stringify({ force: true })]);
    });
  });

  test('--dry-run still sends no DELETE', async () => {
    await withHarness(async (h) => {
      const out = await h.run(['org', 'delete-project', PROJECT_ID, '--dry-run', '--json']);
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, dry_run: true });
      expect(requests(h, 'DELETE')).toHaveLength(0);
    });
  });

  test('restore-project --yes --json posts the restore', async () => {
    await withHarness(async (h) => {
      const out = await h.run(['org', 'restore-project', PROJECT_ID, '--yes', '--json']);
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, project: { id: PROJECT_ID } });
      expect(requests(h, 'POST').map((r) => r.path)).toEqual([`/orgs/org_test_piped/projects/${PROJECT_ID}/restore`]);
    });
  });

  test('org projects --deleted asks the service for the deleted ones too', async () => {
    await withHarness(async (h) => {
      h.setBranches(PROJECT_ID, [{ id: 'br_1', name: 'production', is_protected: false }]);
      const out = await h.run(['org', 'projects', '--deleted', '--json']);
      expect(out.code).toBe(0);
      expect(h.requests().some((r) => r.method === 'GET' && r.path === '/projects?include_deleted=1')).toBe(true);
    });
  });
});

describe('lifecycleOptsFrom: --non-tty and --force, wherever the outer command took them', () => {
  /** The same shape as src/index.ts: the program has -f/--force and -d/--dry-run, `org` has --non-tty. */
  const parse = (argv: readonly string[]) => {
    const seen: Array<ReturnType<typeof lifecycleOptsFrom>> = [];
    const program = new Command().option('-f, --force').option('-d, --dry-run').exitOverride();
    const org = program.command('org').option('--non-tty').action(() => undefined);
    org
      .command('delete-project <ref>')
      .option('--force')
      .option('--yes')
      .option('--non-tty')
      .option('--json')
      .action((_ref: string, _options: unknown, command: Command) => seen.push(lifecycleOptsFrom(command)));
    program.parse(['bun', 'capy', ...argv]);
    return seen[0];
  };

  test('--non-tty reaches the command (org takes it)', () => {
    expect(parse(['org', 'delete-project', 'web', '--non-tty'])?.nonTty).toBe(true);
    expect(parse(['org', '--non-tty', 'delete-project', 'web'])?.nonTty).toBe(true);
  });

  test('--force reaches the command (the program takes it)', () => {
    expect(parse(['org', 'delete-project', 'web', '--force'])?.force).toBe(true);
    expect(parse(['org', 'delete-project', 'web'])?.force).toBe(false);
  });

  test('--yes, --json and --dry-run come through too', () => {
    expect(parse(['org', 'delete-project', 'web', '--yes', '--json', '--dry-run'])).toEqual({
      force: false,
      yes: true,
      nonTty: false,
      json: true,
      dryRun: true,
    });
  });
});

describe('a folder whose project was deleted (the service answers 410 PROJECT_DELETED)', () => {
  test('bare `capy`: exit 1, the deleted-project screen with the restore command, no recreate, no "up to date", keep.lock untouched', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const lockBefore = h.keepLockText();

      const out = await h.run([]);

      expect(out.code).toBe(1);
      expect(out.stdout).toContain('Project deleted');
      expect(out.stdout).toContain(RESTORE);
      const everything = `${out.stdout}\n${out.stderr}`;
      expect(everything).not.toContain('Everything is up to date');
      expect(everything).not.toContain('Cannot reach remote');
      expect(everything.toLowerCase()).not.toContain('recreate');
      expect(h.keepLockText()).toBe(lockBefore);
    });
  });

  test('bare `capy` leaves .env as it found it too', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const envBefore = readFileSync(join(h.project, '.env'), 'utf8');
      await h.run([]);
      expect(readFileSync(join(h.project, '.env'), 'utf8')).toBe(envBefore);
    });
  });

  test('`capy status --json`: exit 1, JSON with ok false and code PROJECT_DELETED, not inSync', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const lockBefore = h.keepLockText();

      const out = await h.run(['status', '--json']);

      expect(out.code).toBe(1);
      const body = JSON.parse(out.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, code: 'PROJECT_DELETED' });
      expect(body.inSync).toBeUndefined();
      expect(out.stdout.toLowerCase()).not.toContain('recreate');
      expect(h.keepLockText()).toBe(lockBefore);
    });
  });

  test('`capy status` (human): exit 1 and the restore command, no recreate', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const out = await h.run(['status']);
      expect(out.code).toBe(1);
      expect(out.stdout).toContain('Project deleted');
      expect(out.stdout).toContain(RESTORE);
      expect(`${out.stdout}${out.stderr}`.toLowerCase()).not.toContain('recreate');
    });
  });

  test('`capy push --non-tty` (off a terminal): exit 1, the code and the restore command on stderr, keep.lock untouched', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const lockBefore = h.keepLockText();

      const out = await h.run(['push', '--non-tty']);

      expect(out.code).toBe(1);
      expect(out.stderr).toContain('PROJECT_DELETED');
      expect(out.stderr).toContain(RESTORE);
      expect(`${out.stdout}${out.stderr}`.toLowerCase()).not.toContain('recreate');
      expect(h.keepLockText()).toBe(lockBefore);
    });
  });

  test('`capy edit NAME --json` (a command behind the gate): exit 1 with code PROJECT_DELETED in the JSON', async () => {
    await withHarness(async (h) => {
      await deletedFolder(h);
      const out = await h.run(['edit', NAME, '--json', '--no-pr'], 'second-value\n', undefined, QUIET);
      expect(out.code).toBe(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'PROJECT_DELETED' });
    });
  });
});
