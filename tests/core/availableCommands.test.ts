/**
 * The "Available commands" an unknown command prints is generated from the registered
 * program: every visible command is in it, no hidden one is. The pure builder is pinned
 * against a small hand-built tree; the built CLI (both entrypoints, needs `bun run build`
 * like tests/commands/helpJsonCli.test.ts) is checked against its own `help --json`.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Command } from 'commander';
import { availableCommandLines, unknownCommandText } from '../../src/core/availableCommands';

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (text: string): string => text.replace(ANSI, '');

function buildProgram(): Command {
  const program = new Command();
  program.name('capy').description('Capy CLI');
  program.command('status').description('Show status');
  program.command('invite <email>').description('Invite a teammate');
  program.command('run').description('Run a command');
  program.command('secret-thing', { hidden: true }).description('should never appear');
  return program;
}

describe('availableCommandLines', () => {
  test('lists the bare command and every visible command with its arguments and description', () => {
    const lines = availableCommandLines(buildProgram()).map(plain);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ {4}capy {2,}Sync secrets$/);
    expect(lines[1]).toMatch(/^ {4}capy status {2,}Show status$/);
    expect(lines[2]).toMatch(/^ {4}capy invite <email> {2,}Invite a teammate$/);
    expect(lines[3]).toMatch(/^ {4}capy run {2,}Run a command$/);
  });

  test('a hidden command is not listed', () => {
    expect(availableCommandLines(buildProgram()).map(plain).join('\n')).not.toContain('secret-thing');
  });

  test('descriptions start in one column', () => {
    const columns = availableCommandLines(buildProgram())
      .map(plain)
      .map((l) => l.search(/(Sync secrets|Show status|Invite a teammate|Run a command)/));
    expect(new Set(columns).size).toBe(1);
  });

  test('same look as before: the usage in bold, the description dim', () => {
    const [first] = availableCommandLines(buildProgram());
    expect(first).toContain('\x1b[1mcapy\x1b[0m');
    expect(first).toContain('\x1b[90mSync secrets\x1b[0m');
  });

  test('the bin name is the program name (capy-dev prints capy-dev)', () => {
    const program = new Command();
    program.name('capy-dev');
    program.command('edit').description('Edit');
    expect(availableCommandLines(program).map(plain).join('\n')).toContain('capy-dev edit');
  });

  test('unknownCommandText names the unknown command and the list', () => {
    const text = plain(unknownCommandText(buildProgram(), 'bogus'));
    expect(text).toContain('Unknown command: bogus');
    expect(text).toContain('Available commands:');
    expect(text).toContain('capy status');
  });
});

describe('the built CLI: unknown command output matches the registered commands', () => {
  const run = (entry: string, args: string[]): { stdout: string; code: number } => {
    const r = spawnSync('node', [join(__dirname, '../../dist', entry), ...args], { encoding: 'utf-8' });
    return { stdout: r.stdout ?? '', code: r.status ?? 1 };
  };

  const checkEntry = (entry: string, bin: string): void => {
    const doc = JSON.parse(run(entry, ['help', '--json']).stdout) as { commands: Array<{ name: string }> };
    const unknown = run(entry, ['definitely-not-a-command']);
    expect(unknown.code).toBe(1);
    const listed = plain(unknown.stdout)
      .split('\n')
      .filter((l) => l.startsWith('    '))
      .slice(1) // the bare command line
      .map((l) => l.trim().split(/\s+/)[1])
      .filter((word): word is string => word !== undefined && !word.startsWith('<'));
    // Every visible registered command is in the list ...
    doc.commands.forEach((c) => expect(listed, `${bin}: ${c.name} missing`).toContain(c.name));
    expect(doc.commands.length).toBeGreaterThan(20);
    // ... and nothing else is: the list is the registered set (hidden commands are not in `help --json` either).
    expect(new Set(listed).size).toBe(new Set(doc.commands.map((c) => c.name)).size);
  };

  test('capy', () => checkEntry('index.js', 'capy'));
  test('capy-dev', () => checkEntry('index-dev.js', 'capy-dev'));
});
