/**
 * `buildCliHelpDoc` (CAP-681) — pure Commander program -> JSON doc builder
 * behind `capy help --json`. Tested here against small hand-built `Command`
 * trees so the shape is pinned without needing the real CLI's ~35 commands
 * or a build; tests/commands/helpJsonCli.test.ts covers the real, built
 * `capy help --json` end to end.
 */
import { describe, test, expect } from 'bun:test';
import { Command, Option } from 'commander';
import { buildCliHelpDoc } from '../../src/core/cliHelpDoc';
import { ERROR_CODES } from '../../src/types/index';

function buildProgram(): Command {
  const program = new Command();
  program.name('capy').description('Capy CLI').version('9.9.9');

  program
    .command('status')
    .description('Show status')
    .option('--json', 'emit JSON');

  const deploy = program.command('deploy').description('Deploy things');
  deploy
    .command('targets-remove <name>')
    .description('Remove a target')
    .argument('[extra...]', 'extra positional')
    .option('--yes', 'skip confirmation')
    .option('--env <name>', 'target env', 'production')
    .option('--no-push', 'skip push');

  program.command('secret-thing', { hidden: true }).description('should never appear');

  return program;
}

describe('buildCliHelpDoc', () => {
  test('top-level shape: ok, name, version, conventions', () => {
    const doc = buildCliHelpDoc(buildProgram());
    expect(doc.ok).toBe(true);
    expect(doc.name).toBe('capy');
    expect(doc.version).toBe('9.9.9');
    expect(typeof doc.conventions.json).toBe('string');
    expect(typeof doc.conventions.codes).toBe('string');
  });

  test('CAP-703: publishes the deploy_dokploy_plan schema and the dokploy --discover mode (structured, supportsDryRun) under deploy', () => {
    const doc = buildCliHelpDoc(buildProgram());
    const schema = doc.schemas.deploy_dokploy_plan as any;
    expect(schema.required).toEqual(['version', 'entries']);
    expect(schema.properties.entries.items.required).toEqual(['project_id', 'branch', 'service_id', 'git_branch', 'vars']);
    const deploy = doc.commands.find((c) => c.name === 'deploy')!;
    expect(deploy.modes).toHaveLength(1);
    expect(deploy.modes![0]).toMatchObject({
      invocation: 'capy deploy dokploy --discover',
      supportsDryRun: true,
      supportsJson: true,
      alwaysJson: true,
      planSchema: 'deploy_dokploy_plan',
    });
    expect(deploy.modes![0].flags).toEqual(expect.arrayContaining(['--discover', '--plan', '--confirm', '--base-url', '--dry-run']));
    // A command with no modes carries no `modes` field at all.
    expect(doc.commands.find((c) => c.name === 'status')).not.toHaveProperty('modes');
  });

  test('includes every registered error code', () => {
    const doc = buildCliHelpDoc(buildProgram());
    expect(doc.errorCodes).toEqual(Object.values(ERROR_CODES));
    expect(doc.errorCodes).toContain('AGENTS_SETUP_NEEDS_TTY');
    expect(doc.errorCodes).toContain('AGENTS_BLOCK_MALFORMED');
  });

  test('nested subcommand path is space-joined and does not collide with a top-level command of the same name', () => {
    const doc = buildCliHelpDoc(buildProgram());
    const deploy = doc.commands.find((c) => c.name === 'deploy')!;
    expect(deploy.path).toBe('deploy');
    const remove = deploy.subcommands.find((c) => c.name === 'targets-remove')!;
    expect(remove.path).toBe('deploy targets-remove');
  });

  test('arguments carry name, required, variadic', () => {
    const doc = buildCliHelpDoc(buildProgram());
    const remove = doc.commands.find((c) => c.name === 'deploy')!.subcommands[0];
    expect(remove.arguments).toEqual([
      { name: 'name', required: true, variadic: false },
      { name: 'extra', required: false, variadic: true },
    ]);
  });

  test('options carry flags, long, description, default, negatable', () => {
    const doc = buildCliHelpDoc(buildProgram());
    const remove = doc.commands.find((c) => c.name === 'deploy')!.subcommands[0];
    const env = remove.options.find((o) => o.long === '--env')!;
    expect(env.default).toBe('production');
    expect(env.negatable).toBe(false);
    const noPush = remove.options.find((o) => o.long === '--no-push')!;
    expect(noPush.negatable).toBe(true);
    expect(noPush.default).toBeUndefined();
  });

  test('supportsJson is true only when a --json option is registered', () => {
    const doc = buildCliHelpDoc(buildProgram());
    const status = doc.commands.find((c) => c.name === 'status')!;
    const deploy = doc.commands.find((c) => c.name === 'deploy')!;
    expect(status.supportsJson).toBe(true);
    expect(deploy.supportsJson).toBe(false);
  });

  test('excludes hidden commands entirely', () => {
    const doc = buildCliHelpDoc(buildProgram());
    expect(doc.commands.some((c) => c.name === 'secret-thing')).toBe(false);
  });

  test('excludes hidden options', () => {
    const program = new Command();
    program.name('capy').version('1.0.0');
    const cmd = program.command('foo').description('x');
    cmd.addOption(new Option('--visible', 'shown'));
    cmd.addOption(new Option('--secret', 'not shown').hideHelp());
    const doc = buildCliHelpDoc(program);
    const foo = doc.commands.find((c) => c.name === 'foo')!;
    expect(foo.options.map((o) => o.long)).toEqual(['--visible']);
  });

  test('a short-only option (no long form) reports the short flag, not the value placeholder', () => {
    const program = new Command();
    program.name('capy').version('1.0.0');
    program.command('branch').description('x').option('-D <name>', 'Delete a branch');
    const doc = buildCliHelpDoc(program);
    const opt = doc.commands[0].options[0];
    expect(opt.long).toBe('-D');
  });
});
