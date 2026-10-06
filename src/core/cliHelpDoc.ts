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
import { DEPLOY_DOKPLOY_PLAN_SCHEMA } from '../commands/deployDiscover/schema';

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

/**
 * A way of running a command that is not a sub-command of its own (`capy deploy dokploy --discover`):
 * what to type, which flags belong to it, and what it reads. Structured, so an agent never has to
 * parse prose to learn that a mode exists.
 */
export interface CliModeDoc {
  /** What is typed, e.g. `capy deploy dokploy --discover`. */
  invocation: string;
  description: string;
  /** The flags that belong to this mode (a subset of the command's `options`). */
  flags: string[];
  supportsJson: boolean;
  /** Always prints exactly what `--json` prints, in a terminal or not, and never prompts. */
  alwaysJson: boolean;
  supportsDryRun: boolean;
  /** Key under the top-level `schemas` of the file this mode reads (`--plan`), when it reads one. */
  planSchema?: string;
}

export interface CliCommandDoc {
  name: string;
  /** Full space-joined path from the root, e.g. "deploy targets-remove". */
  path: string;
  description: string;
  arguments: CliArgumentDoc[];
  options: CliOptionDoc[];
  supportsJson: boolean;
  /** Honors the global `-d/--dry-run` (previews, or refuses a path that cannot preview with `DRY_RUN_UNSUPPORTED`). */
  supportsDryRun: boolean;
  /** Modes of this command that are not sub-commands, when it has any. */
  modes?: CliModeDoc[];
  subcommands: CliCommandDoc[];
}

export interface CliHelpDoc {
  ok: true;
  name: string;
  version: string;
  commands: CliCommandDoc[];
  /** JSON Schemas of the files commands read, by name (`deploy_dokploy_plan`). */
  schemas: Record<string, unknown>;
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

/**
 * The commands that honor the global `--dry-run`. A command is listed only once
 * it previews or refuses; the rest still ignore the flag.
 */
export const DRY_RUN_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'agents',
  'connect',
  'deploy',
  'edit',
  'remove',
  'secrets',
  'secrets set',
]);

/** The JSON Schemas published in `capy help --json`. */
export const HELP_SCHEMAS: Readonly<Record<string, unknown>> = {
  deploy_dokploy_plan: DEPLOY_DOKPLOY_PLAN_SCHEMA,
};

/** Modes that are flags of a command rather than sub-commands, by command path. */
export const COMMAND_MODES: Readonly<Record<string, readonly CliModeDoc[]>> = {
  deploy: [
    {
      invocation: 'capy deploy dokploy --discover',
      // COPY-FLAG: minimal and neutral.
      description: 'Find the Dokploy services that match Capy projects, check a plan for them, and write the deploy targets as one pull request per repo. Pushes no values.',
      flags: ['--discover', '--plan', '--confirm', '--base-url', '--dry-run', '--json'],
      supportsJson: true,
      alwaysJson: true,
      supportsDryRun: true,
      planSchema: 'deploy_dokploy_plan',
    },
  ],
};

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
    supportsDryRun: DRY_RUN_COMMANDS.has(path),
    ...(COMMAND_MODES[path] ? { modes: COMMAND_MODES[path].map((m) => ({ ...m, flags: [...m.flags] })) } : {}),
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
    schemas: { ...HELP_SCHEMAS },
    errorCodes: Object.values(ERROR_CODES),
    conventions: {
      json: 'Pass --json on any command whose supportsJson is true and parse stdout as JSON; prose (progress, prompts, errors) goes to stderr so stdout stays pure JSON.',
      codes: 'Branch only on the machine-readable `code` field (from --json output or a CapyError), never on human-readable message text — messages may be reworded without notice.',
    },
  };
}
