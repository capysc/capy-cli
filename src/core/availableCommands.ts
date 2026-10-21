/**
 * The "Available commands" list an unknown command prints. Generated from the
 * registered Commander program (through `buildCliHelpDoc`, the same walk
 * `capy help --json` uses), so it cannot drift from the real command set:
 * a command added to an entrypoint is in the list, a hidden one never is.
 */
import type { Command } from 'commander';
import { buildCliHelpDoc, type CliArgumentDoc, type CliCommandDoc } from './cliHelpDoc';

const BOLD = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string): string => `\x1b[90m${s}\x1b[0m`;

const argumentText = (arg: CliArgumentDoc): string => {
  const name = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${name}>` : `[${name}]`;
};

/** `status`, `invite <email>`, `connect <provider>`: the command as it is typed, after the bin name. */
const usageOf = (command: CliCommandDoc): string => [command.name, ...command.arguments.map(argumentText)].join(' ');

/**
 * One line per visible top-level command: the bin name and usage in bold, the
 * description dimmed, descriptions aligned. The first line is the bare bin,
 * which syncs.
 */
export function availableCommandLines(program: Command): readonly string[] {
  const bin = program.name();
  const entries = [
    { typed: bin, description: 'Sync secrets' }, // COPY-FLAG
    ...buildCliHelpDoc(program).commands.map((command) => ({ typed: `${bin} ${usageOf(command)}`, description: command.description })),
  ];
  const width = Math.max(...entries.map((e) => e.typed.length)) + 2;
  return entries.map((e) => `    ${BOLD(e.typed)}${' '.repeat(width - e.typed.length)}${DIM(e.description)}`);
}

/** The whole unknown-command message, ready to print. */
export function unknownCommandText(program: Command, unknown: string): string {
  return ['', `  Unknown command: ${unknown}`, '', '  Available commands:', '', ...availableCommandLines(program), ''].join('\n');
}
