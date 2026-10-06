/**
 * `capy secrets deploy` in `capy help --json` (CAP-704), against the real BUILT CLI, both
 * entrypoints — needs `bun run build` first, like the other tests that spawn `dist/`.
 * It is listed the way `secrets set` is: a path, a variadic name argument, `--json`,
 * `--dry-run`, and its new error codes.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { spawnSync } from 'child_process';

const CLIS = { prod: join(__dirname, '../../dist/index.js'), dev: join(__dirname, '../../dist/index-dev.js') } as const;

function help(cliPath: string) {
  const r = spawnSync('node', [cliPath, 'help', '--json'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

const flatten = (cmds: any[]): any[] => cmds.flatMap((c) => [c, ...flatten(c.subcommands ?? [])]);

describe.each(Object.entries(CLIS))('capy help --json (%s)', (_label, cli) => {
  const doc = help(cli);
  const byPath = Object.fromEntries(flatten(doc.commands).map((c: any) => [c.path, c]));

  test('lists `secrets deploy` next to `secrets set`, with a variadic name, --json and --dry-run', () => {
    expect(byPath['secrets set']).toBeDefined();
    const deploy = byPath['secrets deploy'];
    expect(deploy).toBeDefined();
    expect(deploy.arguments).toEqual([{ name: 'names', required: true, variadic: true }]);
    expect(deploy.supportsJson).toBe(true);
    expect(deploy.supportsDryRun).toBe(true);
    const flags = deploy.options.map((o: any) => o.long);
    for (const flag of ['--json', '--row', '--all-rows', '--exclude', '--confirm']) expect(flags).toContain(flag);
    // It takes no value (it deploys what Capy holds) and has no PR switches.
    expect(flags).not.toContain('--no-pr');
  });

  test('carries its error codes', () => {
    for (const code of ['DEPLOY_BATCH_PARTIAL', 'DEPLOY_NOTHING_TO_DEPLOY', 'DEPLOY_VARS_MISSING', 'DEPLOY_PREFLIGHT_FAILED', 'DEPLOY_PUSH_FAILED']) {
      expect(doc.errorCodes).toContain(code);
    }
  });
});
