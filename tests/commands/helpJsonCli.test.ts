/**
 * `capy help --json` and the `--help` footer, exercised against the real
 * BUILT CLI (both entrypoints) — needs `bun run build` first, same as the
 * other tests that spawn `dist/`. `tests/core/cliHelpDoc.test.ts` pins the
 * builder's shape against small hand-built Commander trees; this file
 * confirms the real ~35-command tree comes out sane and that both `capy`
 * and `capy-dev` produce it (CAP-681).
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { spawnSync } from 'child_process';

const PROD_CLI = join(__dirname, '../../dist/index.js');
const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

function run(cliPath: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [cliPath, ...args], { encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe('capy help --json', () => {
  test('prod: valid JSON, includes the known-load-bearing commands', () => {
    const { stdout, code } = run(PROD_CLI, ['help', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.ok).toBe(true);
    expect(doc.name).toBe('capy');
    expect(typeof doc.version).toBe('string');

    const paths = flatten(doc.commands).map((c: any) => c.path);
    for (const expected of ['deploy', 'deploy targets', 'deploy targets-remove', 'connect', 'system', 'system set', 'projects', 'agents', 'help']) {
      expect(paths, `missing "${expected}" in help --json`).toContain(expected);
    }
  });

  test('prod: supportsJson is accurate for a few known commands', () => {
    const { stdout } = run(PROD_CLI, ['help', '--json']);
    const doc = JSON.parse(stdout);
    const byPath = Object.fromEntries(flatten(doc.commands).map((c: any) => [c.path, c]));
    expect(byPath['status'].supportsJson).toBe(true);
    expect(byPath['agents'].supportsJson).toBe(true);
    expect(byPath['system set'].supportsJson).toBe(true);
    // `run` passes everything through to the child process — never has --json.
    expect(byPath['run'].supportsJson).toBe(false);
  });

  test('prod: no hidden option leaks through (run\'s own -h/--help is disabled and never listed)', () => {
    const { stdout } = run(PROD_CLI, ['help', '--json']);
    const doc = JSON.parse(stdout);
    const byPath = Object.fromEntries(flatten(doc.commands).map((c: any) => [c.path, c]));
    const flags = (byPath['run'].options as any[]).map((o) => o.long);
    expect(flags).not.toContain('--help');
    expect(flags).not.toContain('-h');
  });

  test('prod: carries the org system store and agent-onboarding error codes', () => {
    const { stdout } = run(PROD_CLI, ['help', '--json']);
    const doc = JSON.parse(stdout);
    expect(doc.errorCodes).toContain('SYSTEM_STORE_ADMIN_ONLY');
    expect(doc.errorCodes).toContain('AGENTS_SETUP_NEEDS_TTY');
    expect(doc.errorCodes).toContain('AGENTS_BLOCK_MALFORMED');
  });

  test('dev: also serves help --json, with its own program name', () => {
    const { stdout, code } = run(DEV_CLI, ['help', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.ok).toBe(true);
    expect(doc.name).toBe('capy-dev');
    const paths = flatten(doc.commands).map((c: any) => c.path);
    expect(paths).toContain('agents');
  });

  test('the exact footer sentence is appended to root --help on both entrypoints, and only there', () => {
    const FOOTER = 'Agents: run `capy help --json` for a machine-readable command reference.';
    const prodRoot = run(PROD_CLI, ['--help']);
    expect(prodRoot.stdout).toContain(FOOTER);
    const devRoot = run(DEV_CLI, ['--help']);
    expect(devRoot.stdout).toContain(FOOTER);

    // Root help only — a subcommand's own --help must not repeat it.
    const prodSub = run(PROD_CLI, ['status', '--help']);
    expect(prodSub.stdout).not.toContain(FOOTER);
  });
});

describe('capy deploy dokploy --discover (CAP-703), both entrypoints', () => {
  test.each([
    ['prod', PROD_CLI],
    ['dev', DEV_CLI],
  ])('%s: the deploy command lists --discover, --plan, --confirm and --base-url', (_name, cli) => {
    const { stdout } = run(cli, ['deploy', '--help']);
    for (const flag of ['--discover', '--plan <file>', '--confirm <plan_id>', '--base-url <url>']) {
      expect(stdout, `missing ${flag}`).toContain(flag);
    }
  });

  test.each([
    ['prod', PROD_CLI],
    ['dev', DEV_CLI],
  ])('%s: --discover on another target is a JSON refusal on stdout, in a terminal or not', (_name, cli) => {
    const { stdout, code } = run(cli, ['deploy', 'aws-ssm', '--discover']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'DISCOVER_UNSUPPORTED_TARGET' });
  });

  test.each([
    ['prod', PROD_CLI],
    ['dev', DEV_CLI],
  ])('%s: --confirm without --plan is a coded refusal before anything is read', (_name, cli) => {
    const { stdout, code } = run(cli, ['deploy', 'dokploy', '--discover', '--confirm', 'abc', '--base-url', 'https://dokploy.example.com']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'PLAN_REQUIRED' });
  });

  test('help --json lists the mode with supportsDryRun and publishes the plan schema', () => {
    const doc = JSON.parse(run(PROD_CLI, ['help', '--json']).stdout);
    const deploy = flatten(doc.commands).find((c: any) => c.path === 'deploy');
    expect(deploy.supportsDryRun).toBe(true);
    expect(deploy.modes[0]).toMatchObject({ invocation: 'capy deploy dokploy --discover', supportsDryRun: true, alwaysJson: true, planSchema: 'deploy_dokploy_plan' });
    expect(doc.schemas.deploy_dokploy_plan.properties.entries.items.required).toContain('service_id');
    expect(doc.errorCodes).toEqual(expect.arrayContaining(['PLAN_CHANGED', 'SERVICE_NOT_FOUND', 'DUPLICATE_ENTRY', 'TARGET_EXISTS']));
  });
});

function flatten(commands: any[]): any[] {
  return commands.flatMap((c) => [c, ...flatten(c.subcommands ?? [])]);
}
