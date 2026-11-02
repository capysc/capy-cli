/**
 * `capy help --json` lists `edit [name]` (both entrypoints register it) and the
 * piped-value error codes. Spawns the BUILT cli; needs `bun run build`.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROD_CLI = join(__dirname, '../../dist/index.js');
const DEV_CLI = join(__dirname, '../../dist/index-dev.js');

interface CommandDoc {
  path: string;
  arguments: { name: string; required: boolean; variadic: boolean }[];
  options: { long: string }[];
  supportsJson: boolean;
  subcommands: CommandDoc[];
}

function helpDoc(cli: string): { commands: CommandDoc[]; errorCodes: string[] } {
  const r = spawnSync('node', [cli, 'help', '--json'], { encoding: 'utf-8' });
  return JSON.parse(r.stdout);
}

describe.each([
  ['capy', PROD_CLI],
  ['capy-dev', DEV_CLI],
])('%s help --json', (_name, cli) => {
  const doc = helpDoc(cli);
  const command = (path: string): CommandDoc => {
    const found = doc.commands.find((c) => c.path === path);
    if (!found) throw new Error(`no ${path} in help --json`);
    return found;
  };

  test('edit takes an optional [name] and supports --json, --no-push, --non-tty', () => {
    const edit = command('edit');
    expect(edit.arguments).toEqual([{ name: 'name', required: false, variadic: false }]);
    expect(edit.supportsJson).toBe(true);
    const flags = edit.options.map((o) => o.long);
    expect(flags).toContain('--json');
    expect(flags).toContain('--no-push');
    expect(flags).toContain('--non-tty');
  });

  test('add supports --json (piped value)', () => {
    expect(command('add').supportsJson).toBe(true);
  });

  test('the piped-value error codes are listed', () => {
    for (const code of ['EDIT_NEEDS_TTY', 'STDIN_EMPTY', 'STDIN_TOO_LARGE', 'ADD_STDIN_ONE_NAME', 'ADD_VAR_EXISTS', 'EDIT_STDIN_LOCAL_ONLY']) {
      expect(doc.errorCodes).toContain(code);
    }
  });
});
