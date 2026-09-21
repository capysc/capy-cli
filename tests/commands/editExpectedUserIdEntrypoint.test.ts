import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

const EXPECTED_USER_ID = 'user_edit_entrypoint_fixture';

function editRegistration(entrypoint: 'index.ts' | 'index-dev.ts') {
  const source = readFileSync(resolve(import.meta.dir, '../../src', entrypoint), 'utf8');
  const start = source.indexOf("program\n  .command('edit')");
  const end = source.indexOf(entrypoint === 'index-dev.ts' ? '\nconst deploy' : '\nprogram\n', start + 1);
  if (start < 0 || end < 0) throw new Error('Edit command registration missing');
  const execute = mock(async (...args: readonly unknown[]) => args);
  class EditCommandImplementation {
    constructor(..._args: readonly unknown[]) {}
    execute(...args: readonly unknown[]) { return execute(...args); }
  }
  const program = new Command();
  program.option('--web').option('--expected-user-id <id>');
  const body = source.slice(start, end).replace("await import('./commands/editCommand')", 'await load()');
  new Function('program', 'load', 'expectedUserIdFor', 'process', body)(
    program,
    async () => ({ EditCommand: EditCommandImplementation }),
    (command: Command) => (command.optsWithGlobals() as Readonly<Record<string, unknown>>).expectedUserId,
    { env: { CAPY_API_URL: 'http://127.0.0.1:9' } },
  );
  return { program, execute } as const;
}

for (const entrypoint of ['index.ts', 'index-dev.ts'] as const) {
  describe(`${entrypoint} edit expected-user-id`, () => {
    test('passes the hosted identity and web surface to EditCommand', async () => {
      const registration = editRegistration(entrypoint);

      await registration.program.parseAsync(
        ['edit', '--web', '--expected-user-id', EXPECTED_USER_ID],
        { from: 'user' },
      );

      expect(registration.execute).toHaveBeenCalledWith({
        web: true,
        expectedUserId: EXPECTED_USER_ID,
      });
    });
  });
}
