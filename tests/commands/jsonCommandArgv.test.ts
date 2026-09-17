import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

// Execute the real registrations with Commander, replacing only the command
// implementation. Importing the production entrypoint itself would apply its
// production environment pins and touch the user's global authentication.
function registration(entrypoint: string, name: string) {
  const source = readFileSync(resolve(import.meta.dir, '../../src', entrypoint), 'utf8');
  const start = source.indexOf(`program\n  .command('${name}')`);
  const end = source.indexOf('\nprogram\n', start + 1);
  if (start < 0 || end < 0) throw new Error('Command registration missing');
  const rootJsonOption = source.split('\n').find(line => line.trim().startsWith(".option('--json'"));
  if (!rootJsonOption) throw new Error('Root JSON option missing');
  const execute = mock(async (...args: readonly unknown[]) => args);
  class CommandImplementation {
    constructor(..._args: readonly unknown[]) {}
    execute(...args: readonly unknown[]) { return execute(...args); }
  }
  const program = new Command();
  new Function('program', `program${rootJsonOption};`)(program);
  const body = source.slice(start, end)
    .replace("await import('./commands/setupCommand')", 'await load()')
    .replace("await import('./commands/syncCommand')", 'await load()');
  new Function('program', 'load', 'expectedUserIdFor', 'process', 'console', body)(
    program,
    async () => ({ SetupCommand: CommandImplementation, SyncCommand: CommandImplementation }),
    () => undefined,
    { exit: (code: number): never => { throw new Error(`exit:${code}`); } },
    { error: () => undefined },
  );
  return { program, execute };
}

for (const entrypoint of ['index.ts', 'index-dev.ts']) {
  describe(`${entrypoint} JSON command arguments`, () => {
    for (const name of ['setup', 'sync']) {
      for (const args of [['--json', name], [name, '--json']]) {
        test(args.join(' '), async () => {
          const command = registration(entrypoint, name);
          await command.program.parseAsync(args, { from: 'user' });
          expect(command.execute).toHaveBeenCalledTimes(1);
        });
      }
      test(`${name} still requires JSON mode`, async () => {
        const command = registration(entrypoint, name);
        await expect(command.program.parseAsync([name], { from: 'user' })).rejects.toThrow('exit:1');
        expect(command.execute).not.toHaveBeenCalled();
      });
    }
  });
}
