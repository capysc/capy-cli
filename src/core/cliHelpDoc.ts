/**
 * Builds a stable, machine-readable document describing every command this
 * CLI registers — served by `capy help --json` (CAP-681).
 *
 * The whole point is that this can never drift from the real command tree:
 * `buildCliHelpDoc` walks the live Commander `program` object at runtime
 * rather than hand-maintaining a parallel list, so a command added to
 * `index.ts`/`index-dev.ts` shows up here automatically. It is a pure
 * function (`Command` in, plain data out) so it is testable without spawning
 * a process.
 */
import type { Argument, Command, Option } from 'commander';
import { ERROR_CODES } from '../types/index';

export interface CliArgumentDoc {
  name: string;
  required: boolean;
  variadic: boolean;
}

export interface CliOptionDoc {
  flags: string;
  long: string;
  description: string;
  default?: unknown;
  negatable: boolean;
}

export interface CliCommandDoc {
  name: string;
  /** Full space-joined path from the root, e.g. "deploy targets-remove". */
  path: string;
  description: string;
  arguments: CliArgumentDoc[];
  options: CliOptionDoc[];
  supportsJson: boolean;
  subcommands: CliCommandDoc[];
}

export interface CliHelpDoc {
  ok: true;
  name: string;
  version: string;
  commands: CliCommandDoc[];
  errorCodes: string[];
  conventions: {
    json: string;
    codes: string;
  };
}

/** Commander doesn't expose a public getter for a hidden command — `._hidden` is the only signal. */
function isHiddenCommand(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

function optionDoc(option: Option): CliOptionDoc {
  const withDefault: CliOptionDoc = {
    flags: option.flags,
    // A short-only option (e.g. `-D <name>`) has no `.long` — fall back to
    // the bare short flag rather than the full `flags` string, so `long`
    // never carries a value placeholder.
    long: option.long ?? option.short ?? option.flags,
    description: option.description ?? '',
    negatable: option.negate === true,
  };
  return option.defaultValue !== undefined
    ? { ...withDefault, default: option.defaultValue }
    : withDefault;
}

function argumentDoc(arg: Argument): CliArgumentDoc {
  return {
    name: arg.name(),
    required: arg.required,
    variadic: arg.variadic,
  };
}

function commandDoc(cmd: Command, parentPath: string): CliCommandDoc {
  const name = cmd.name();
  const path = parentPath ? `${parentPath} ${name}` : name;
  const options = cmd.options.filter((o) => o.hidden !== true).map(optionDoc);
  const subcommands = cmd.commands.filter((c) => !isHiddenCommand(c)).map((c) => commandDoc(c, path));

  return {
    name,
    path,
    description: cmd.description() ?? '',
    arguments: (cmd.registeredArguments ?? []).map(argumentDoc),
    options,
    supportsJson: options.some((o) => o.long === '--json'),
    subcommands,
  };
}

/** Pure: walks the fully-registered `program` tree into a stable JSON document. */
export function buildCliHelpDoc(program: Command): CliHelpDoc {
  const commands = program.commands.filter((c) => !isHiddenCommand(c)).map((c) => commandDoc(c, ''));

  return {
    ok: true,
    name: program.name(),
    version: program.version() ?? '',
    commands,
    errorCodes: Object.values(ERROR_CODES),
    conventions: {
      json: 'Pass --json on any command whose supportsJson is true and parse stdout as JSON; prose (progress, prompts, errors) goes to stderr so stdout stays pure JSON.',
      codes: 'Branch only on the machine-readable `code` field (from --json output or a CapyError), never on human-readable message text — messages may be reworded without notice.',
    },
  };
}
