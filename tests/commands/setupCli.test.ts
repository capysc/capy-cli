/**
 * `capy setup` through the built entry points (CAP-891): the wiring `setupCommand.test.ts` stands in for. A temp HOME
 * with no session and a service address nothing listens on, so no pairing can complete: what is checked is that the
 * command parses its own "run this next", answers with exactly one JSON object, and never calls a folder set up while
 * nobody is signed in.
 *
 * Needs `dist/` (run `bun run build`), like `helpJsonCli.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const ENTRY_POINTS = [
  ['prod', join(CLI_ROOT, 'dist/index.js'), 'capy'],
  ['dev', join(CLI_ROOT, 'dist/index-dev.js'), 'capy-dev'],
] as const;

interface Run {
  readonly stdout: string;
  readonly code: number;
  readonly folder: string;
}

/** A fresh HOME and project folder, prepared by `prepare`, then `capy setup ...args` run in the folder. */
function setup(cli: string, args: readonly string[], prepare: (folder: string) => void = () => undefined): Run {
  const root = mkdtempSync(join(tmpdir(), 'capy-setup-cli-'));
  const folder = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(folder);
  mkdirSync(home);
  prepare(folder);
  const r = spawnSync('node', [cli, 'setup', ...args], {
    cwd: folder,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CAPY_API_URL: 'http://127.0.0.1:9', CAPY_WEB_NO_OPEN: '1', CAPY_NO_AUTOCOMMIT: '1', CAPY_NO_REPO_LINK: '1', VERCEL_TOKEN: '', DOKPLOY_API_KEY: '' },
  });
  return { stdout: r.stdout ?? '', code: r.status ?? 1, folder };
}

const linkedProject = (folder: string): void => {
  writeFileSync(join(folder, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'p_1', project_name: 'web', variables: {} }));
  mkdirSync(join(folder, '.capy'));
  writeFileSync(join(folder, '.capy', 'branch'), 'main');
};

describe.each(ENTRY_POINTS)('capy setup, %s entry point', (_name, cli, bin) => {
  test('a cloned project on a machine that was never paired is not complete, and nothing is written', () => {
    const run = setup(cli, ['--code', 'ABCD', '--json'], linkedProject);
    const body = JSON.parse(run.stdout);
    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(run.code).not.toBe(0);
    expect(run.stdout).not.toContain('"complete"');
    expect(existsSync(join(run.folder, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(run.folder, 'CLAUDE.md'))).toBe(false);
  });

  test('the rerun a folder form names parses: root options after the subcommand, and every answer flag', () => {
    const run = setup(cli, ['--folder', '.', '--env-path', 'app/.env', '--dry-run', '--share-setup', 'no', '--org', 'org_1', '--project', 'new', '--name', 'web', '--branch', 'development', '--protected', 'yes', '--json']);
    const body = JSON.parse(run.stdout);
    // Nobody is signed in and a dry run starts no pairing: the refusal points back at setup.
    expect(body).toMatchObject({ ok: false, code: 'AUTH_FAILED', next_command: `${bin} setup --json` });
    expect(run.code).toBe(1);
    const open = setup(cli, ['--folder', '.', '--dry-run', '--name', 'web', '--no-protected', '--no-share-setup', '--json']);
    expect(JSON.parse(open.stdout)).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    // With no --folder, the folder is asked first, and its rerun parses too.
    const asked = JSON.parse(setup(cli, ['--dry-run', '--json']).stdout);
    expect(asked).toMatchObject({ ok: false, code: 'INIT_INPUT_REQUIRED' });
    expect(asked.elicitation.answer.rerun).toBe(`${bin} setup --folder <folder> --dry-run --json`);
    const typed = setup(cli, asked.elicitation.answer.rerun.split(' ').slice(2).map((w: string) => (w === '<folder>' ? '.' : w)));
    expect(JSON.parse(typed.stdout)).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
  });

  test('a dry run in a linked folder with nobody signed in writes nothing', () => {
    const run = setup(cli, ['--dry-run', '--json'], linkedProject);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, code: 'AUTH_FAILED', next_command: `${bin} setup --json` });
    expect(existsSync(join(run.folder, 'AGENTS.md'))).toBe(false);
  });
});
