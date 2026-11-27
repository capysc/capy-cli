/**
 * The flags of bare `capy` that answer the setup questions of a folder that is not a project yet.
 *
 * Commander gives a root option to every subcommand that is typed after it: `capy status --json` would hand `--json`
 * to the root, and `capy project create --protected yes` would lose its `yes`. Several subcommands already use these
 * names (`--org`, `--project`, `--branch`, `--protected`, `--json`, `--non-tty`), so the flags are registered on the
 * root only when the command line has no subcommand: bare `capy` gets them, nothing else changes.
 */
import { Option, type Command } from 'commander';
import { isInteractive } from '../ui/interactive';
import type { SetupOptions } from '../types/index';

/** The flags, as commander options. `capy help --json` lists the same ones. */
export function bareSetupOptions(): readonly Option[] {
  return [
    new Option('--org <id|name>', 'the organization to set this folder up in (asked when you belong to more than one)'), // COPY-FLAG
    new Option('--project <id|name>', 'link this folder to an existing project in the organization, or "new" to create one'), // COPY-FLAG
    new Option('--name <name>', 'the name of a new project'), // COPY-FLAG
    new Option('--branch <name>', 'the first branch of a new project (offered by default: development), or the branch of an existing project to use; a Capy branch works like a git branch'), // COPY-FLAG
    new Option('--protected [yes|no]', 'whether the first branch is protected (invite-only)'),
    new Option('--no-protected', 'Create it open to the project'),
    new Option('--share-setup [yes|no]', 'whether keep.lock is committed so copies of the same code point to the same Capy project (asked in a git repository); no sets up this folder only'), // COPY-FLAG
    new Option('--no-share-setup', 'Set up this folder only'), // COPY-FLAG
    new Option('--json', 'emit machine-readable JSON instead of the human UI'),
    new Option('--non-tty', 'same as --json: never ask, and answer in JSON (agents/CI)'),
  ];
}

/** Whether an option takes a value after it, and whether that value is optional. */
interface ValueFlag {
  readonly flag: string;
  readonly optional: boolean;
}

function valueFlagsOf(options: readonly Option[]): readonly ValueFlag[] {
  return options
    .filter((o) => o.required === true || o.optional === true)
    .flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined).map((flag) => ({ flag, optional: o.optional === true })));
}

/**
 * The words of the command line that are neither a flag nor a flag's value. Stops at `--`.
 * `capy --name run` has none: `run` is the value of `--name`.
 */
function operandsOf(args: readonly string[], valueFlags: readonly ValueFlag[]): readonly string[] {
  const [head, ...rest] = args;
  if (head === undefined || head === '--') return [];
  if (!head.startsWith('-')) return [head, ...operandsOf(rest, valueFlags)];
  const takesValue = valueFlags.find((v) => v.flag === head);
  const [next, ...afterNext] = rest;
  const consumesNext = takesValue !== undefined && next !== undefined && (!takesValue.optional || !next.startsWith('-'));
  return operandsOf(consumesNext ? afterNext : rest, valueFlags);
}

/** Whether `argv` (as `process.argv`) is bare `capy`: no subcommand and no stray word. */
export function isBareInvocation(program: Command, argv: readonly string[]): boolean {
  const valueFlags = valueFlagsOf([...program.options, ...bareSetupOptions()]);
  return operandsOf(argv.slice(2), valueFlags).length === 0;
}

/** Puts the setup flags on the root when this is bare `capy`; leaves the program alone otherwise. */
export function registerBareSetupOptions(program: Command, argv: readonly string[]): void {
  if (!isBareInvocation(program, argv)) return;
  bareSetupOptions().forEach((option) => program.addOption(option));
}

/** A yes/no flag as the answer it stands for: bare `--flag` and `yes` are yes, `--no-flag` and `no` are no. */
function yesNoAnswerFrom(typed: unknown): string | undefined {
  if (typed === true) return 'yes';
  if (typed === false) return 'no';
  return typeof typed === 'string' ? typed.trim().toLowerCase() : undefined;
}

function textFrom(typed: unknown): string | undefined {
  return typeof typed === 'string' ? typed.trim() : undefined;
}

/** What the root's parsed options say about setting up a folder. */
export function setupOptionsFrom(opts: Readonly<Record<string, unknown>>): SetupOptions {
  const nonTty = opts.nonTty === true;
  // `--non-tty` is agent mode, and agent mode always answers in JSON: it means the same as `--json`.
  const json = opts.json === true || nonTty;
  const org = textFrom(opts.org);
  const project = textFrom(opts.project);
  const name = textFrom(opts.name);
  const branch = textFrom(opts.branch);
  const protectedAnswer = yesNoAnswerFrom(opts.protected);
  const shareAnswer = yesNoAnswerFrom(opts.shareSetup);
  const folder = textFrom(opts.folder);
  return {
    ...(org === undefined ? {} : { org }),
    ...(project === undefined ? {} : { project }),
    ...(name === undefined ? {} : { name }),
    ...(branch === undefined ? {} : { branch }),
    ...(protectedAnswer === undefined ? {} : { protectedAnswer }),
    ...(shareAnswer === undefined ? {} : { shareAnswer }),
    ...(folder === undefined ? {} : { folder }),
    json,
    nonTty,
    agentMode: json || !isInteractive(nonTty),
  };
}
