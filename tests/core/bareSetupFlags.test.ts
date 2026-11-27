/**
 * The setup flags of bare `capy` (`core/bareSetupFlags.ts`): they exist for bare `capy` only, and the flags of the
 * same names on subcommands (`--json`, `--branch`, `--protected <yes|no>`, `--org`, `--project`) are untouched.
 */
import { describe, test, expect, mock } from 'bun:test';
import { Command, Option } from 'commander';
import { isBareInvocation, registerBareSetupOptions, setupOptionsFrom } from '../../src/core/bareSetupFlags';

/** A program shaped like the CLI: root options of its own, and subcommands that reuse the setup flags' names. What each action received is recorded by a mock. */
function program(argv: readonly string[]) {
  const onRoot = mock((_options: Record<string, unknown>) => undefined);
  const onStatus = mock((_options: Record<string, unknown>) => undefined);
  const onCreate = mock((_name: string | undefined, _options: Record<string, unknown>) => undefined);
  const onInvite = mock((_email: string, _options: Record<string, unknown>) => undefined);
  const onPair = mock((_options: Record<string, unknown>) => undefined);
  const root = new Command()
    .name('capy')
    .exitOverride()
    .option('--env-path <path>', 'x')
    .option('-d, --dry-run', 'x')
    .addOption(new Option('--resolve <a>', 'x'))
    .action((options) => onRoot(options));
  root.command('status').option('--json', 'x').action((options) => onStatus(options));
  root.command('project').command('create [name]').option('--branch <name>', 'x').option('--protected <yes|no>', 'x').option('--json', 'x')
    .action((name, options) => onCreate(name, options));
  root.command('invite <email>').option('--project <id|name>', 'x').action((email, options) => onInvite(email, options));
  root.command('pair').option('--json', 'x').option('--force', 'x').option('--email <email>', 'x').option('--wait', 'x').option('--cancel', 'x')
    .action((options) => onPair(options));
  registerBareSetupOptions(root, ['node', 'capy', ...argv]);
  root.parse(['node', 'capy', ...argv]);
  return {
    root: onRoot.mock.calls[0]?.[0],
    status: onStatus.mock.calls[0]?.[0],
    create: onCreate.mock.calls[0] === undefined ? undefined : { name: onCreate.mock.calls[0][0], ...onCreate.mock.calls[0][1] },
    pair: onPair.mock.calls[0]?.[0],
    invite: onInvite.mock.calls[0] === undefined ? undefined : { email: onInvite.mock.calls[0][0], ...onInvite.mock.calls[0][1] },
  };
}

describe('which command lines are bare `capy`', () => {
  const root = new Command().option('--env-path <path>', 'x').option('-d, --dry-run', 'x');
  test.each([
    [[], true],
    [['--json'], true],
    [['--name', 'run', '--org', 'Acme'], true],
    [['--env-path', 'x.env', '--branch', 'main'], true],
    [['--protected', '--json'], true],
    [['--protected', 'yes', '--json'], true],
    [['status', '--json'], false],
    [['pair', '--email', 'a@b.co', '--json'], false],
    [['pair', '--wait'], false],
    [['pair', '--cancel'], false],
    [['project', 'create', '--branch', 'x'], false],
    [['--dry-run', 'push'], false],
    [['bogus'], false],
  ] as const)('%j -> %p', (args, expected) => {
    expect(isBareInvocation(root, ['node', 'capy', ...args])).toBe(expected);
  });
});

describe('registration', () => {
  test('bare `capy` takes every setup flag', () => {
    const seen = program(['--org', 'Acme', '--project', 'new', '--name', 'demo', '--branch', 'main', '--no-protected', '--json']);
    expect(seen.root).toMatchObject({ org: 'Acme', project: 'new', name: 'demo', branch: 'main', protected: false, json: true });
  });

  test('--protected alone, with yes and with no', () => {
    expect(program(['--protected']).root).toMatchObject({ protected: true });
    expect(program(['--protected', 'yes', '--json']).root).toMatchObject({ protected: 'yes', json: true });
    expect(program(['--protected', 'no']).root).toMatchObject({ protected: 'no' });
    expect(program([]).root).not.toHaveProperty('protected');
  });

  test('--share-setup alone, with yes and with no, and --no-share-setup', () => {
    expect(program(['--share-setup']).root).toMatchObject({ shareSetup: true });
    expect(program(['--share-setup', 'yes', '--json']).root).toMatchObject({ shareSetup: 'yes', json: true });
    expect(program(['--no-share-setup']).root).toMatchObject({ shareSetup: false });
    expect(program([]).root).not.toHaveProperty('shareSetup');
  });

  test('a subcommand keeps its own flags of the same names', () => {
    expect(program(['status', '--json']).status).toEqual({ json: true });
    expect(program(['project', 'create', 'demo', '--branch', 'main', '--protected', 'yes', '--json']).create)
      .toEqual({ name: 'demo', branch: 'main', protected: 'yes', json: true });
    expect(program(['invite', 'a@b.co', '--project', 'web']).invite).toEqual({ email: 'a@b.co', project: 'web' });
  });

  test('`capy pair` keeps --email, --wait, --cancel, --json and --force', () => {
    expect(program(['pair', '--email', 'a@b.co', '--json']).pair).toEqual({ email: 'a@b.co', json: true });
    expect(program(['pair', '--wait']).pair).toEqual({ wait: true });
    expect(program(['pair', '--cancel']).pair).toEqual({ cancel: true });
    expect(program(['pair', '--force', '--json']).pair).toEqual({ force: true, json: true });
    expect(program(['pair', '--email', 'a@b.co', '--json']).root).toBeUndefined();
  });

  test('the program is left alone when it is not bare', () => {
    const root = new Command().option('--env-path <path>', 'x');
    registerBareSetupOptions(root, ['node', 'capy', 'status']);
    expect(root.options.map((o) => o.long)).toEqual(['--env-path']);
  });
});

describe('what the options say', () => {
  test('--non-tty means --json, and either one is agent mode', () => {
    expect(setupOptionsFrom({ nonTty: true })).toMatchObject({ json: true, nonTty: true, agentMode: true });
    expect(setupOptionsFrom({ json: true })).toMatchObject({ json: true, nonTty: false, agentMode: true });
  });

  test('answers are trimmed, and --protected is yes or no', () => {
    expect(setupOptionsFrom({ org: ' Acme ', name: ' demo', branch: 'main ', project: 'new', protected: true }))
      .toMatchObject({ org: 'Acme', name: 'demo', branch: 'main', project: 'new', protectedAnswer: 'yes' });
    expect(setupOptionsFrom({ protected: false }).protectedAnswer).toBe('no');
    expect(setupOptionsFrom({ protected: ' NO ' }).protectedAnswer).toBe('no');
    expect(setupOptionsFrom({})).not.toHaveProperty('protectedAnswer');
  });

  test('--share-setup is yes or no, and --folder is the folder as typed', () => {
    expect(setupOptionsFrom({ shareSetup: true }).shareAnswer).toBe('yes');
    expect(setupOptionsFrom({ shareSetup: false }).shareAnswer).toBe('no');
    expect(setupOptionsFrom({ shareSetup: ' Yes ' }).shareAnswer).toBe('yes');
    expect(setupOptionsFrom({ folder: ' apps/web ' }).folder).toBe('apps/web');
    expect(setupOptionsFrom({})).not.toHaveProperty('shareAnswer');
    expect(setupOptionsFrom({ encryptEnv: true }).encryptAnswer).toBe('yes');
    expect(setupOptionsFrom({ encryptEnv: false }).encryptAnswer).toBe('no');
    expect(setupOptionsFrom({})).not.toHaveProperty('encryptAnswer');
    expect(setupOptionsFrom({})).not.toHaveProperty('folder');
  });
});
