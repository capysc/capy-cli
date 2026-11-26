/**
 * Spec 3l (CAP-909): a yes/no the terminal asks is, with nobody to ask, a `confirm` elicitation on the refusal. The
 * question is the terminal's, word for word; `display` lists what the yes acts on; `answer.yes` is the same command
 * with the flag that answers it. The refusal's message never tells the agent to add that flag itself.
 */
import type { ElicitationConfirm, ElicitationField, ElicitationForm } from '../ui/elicitation';
import { rowsDisplay } from '../ui/elicitationDisplay';
import { binName } from './binName';

/** A word as the shell takes it: as it is when it is plain, else in single quotes. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A command line from words, each quoted for the shell, starting with the binary this process runs as. */
export function commandLine(devMode: boolean, words: readonly string[]): string {
  return [binName(devMode), ...words.map(shellWord)].join(' ');
}

/**
 * This run's own command, as typed, with each `add` group (a flag, or a flag and its value) set once and `--json` at
 * the end: the command that answers the question. A group's flag already typed is replaced, not repeated. `argv` is
 * the words after the binary.
 */
/**
 * The program-level `--folder` as typed (`--folder X` or `--folder=X`, before or after the subcommand), for an answer
 * command built from scratch: without it the yes would run in the agent's own folder, on another project or org.
 */
export function folderWords(argv: readonly string[] = process.argv.slice(2)): string[] {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && i + 1 < argv.length) return ['--folder', argv[i + 1]];
    if (argv[i].startsWith('--folder=')) return ['--folder', argv[i].slice('--folder='.length)];
  }
  return [];
}

/** An answer command built from its words, repeating this run's `--folder` first so it acts on the same project. */
export function answerLine(devMode: boolean, words: readonly string[], argv: readonly string[] = process.argv.slice(2)): string {
  return commandLine(devMode, [...folderWords(argv), ...words]);
}

export function rerunWith(devMode: boolean, add: ReadonlyArray<readonly string[]>, argv: readonly string[] = process.argv.slice(2)): string {
  let words = argv.filter((w) => w !== '--json' && w !== '--non-tty');
  for (const group of add) {
    const at = words.indexOf(group[0]);
    if (at >= 0) words = [...words.slice(0, at), ...words.slice(at + group.length)];
  }
  return commandLine(devMode, [...words, ...add.flat(), '--json']);
}

export function confirmElicitation(input: {
  readonly question: string;
  readonly rows: ReadonlyArray<readonly [string, string]>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly yes: string;
}): ElicitationConfirm {
  return { kind: 'confirm', question: input.question, details: input.details, display: rowsDisplay(input.rows), answer: { yes: input.yes } };
}

/** The refusal message under `--json`: says a human must answer, never which flag to add. */
export function needsHumanYes(command: string): string {
  return `\`${command}\` needs a yes from the human first. Ask the elicitation's question.`; // COPY-FLAG
}

/** The keep.lock PR flags as typed, for a command that repeats them. */
export function prFlagWords(pr: { readonly pr?: boolean; readonly noPr?: boolean; readonly prBase?: string } | undefined): string[] {
  if (pr === undefined) return [];
  return [...(pr.pr === true ? ['--pr'] : []), ...(pr.noPr === true ? ['--no-pr'] : []), ...(pr.prBase !== undefined ? ['--pr-base', pr.prBase] : [])];
}

/**
 * A connector's yes/no, with nobody to ask: the terminal's multi-line message becomes the confirm. Its first line is
 * the question; every following line is one row of the table, as the terminal lists it.
 */
export function confirmFromTerminalMessage(message: string, devMode: boolean, details: Readonly<Record<string, unknown>>): ElicitationConfirm {
  const [question, ...lines] = message.split('\n');
  const rows = lines.map((l) => l.trim()).filter((l) => l.length > 0).map((l, i) => [String(i + 1), l] as const);
  return confirmElicitation({ question, rows: rows.length > 0 ? rows : [['', question]], details, yes: rerunWith(devMode, [['--yes']]) });
}

/** A typed answer that goes into a command line as it is: only characters a shell word keeps as they are. */
export const SHELL_SAFE_PATTERN = '^[A-Za-z0-9._:/@%+=,-]+$';

/**
 * This run's own command, as typed, with `raw` added before `--json`: `raw` holds a form's `<field>` placeholders,
 * which are filled in by whoever runs it, so it is not quoted. Its flags must not be typed already.
 */
export function rerunAdding(
  devMode: boolean,
  raw: string,
  argv: readonly string[] = process.argv.slice(2),
  tail: '--json' | '--non-tty' = '--json',
): string {
  const base = rerunWith(devMode, [], argv);
  return `${base.slice(0, -' --json'.length)} ${raw} ${tail}`;
}

/** A pick or a typed answer the terminal asks, with nobody to ask (spec 3l): a `form` with the terminal's questions. */
export function formElicitation(input: {
  readonly question: string;
  readonly rows: ReadonlyArray<readonly [string, string]>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly fields: readonly ElicitationField[];
  readonly rerun: string;
}): ElicitationForm {
  return { kind: 'form', question: input.question, details: input.details, display: rowsDisplay(input.rows), fields: input.fields, answer: { rerun: input.rerun } };
}

/** The refusal message of a pick: says a human must choose, never which flag answers it. */
export function needsHumanChoice(command: string): string {
  return `\`${command}\` needs the human to choose first. Ask the elicitation's question.`; // COPY-FLAG
}

/**
 * A pick the terminal would ask, with nobody to ask (spec 3l): prints the coded JSON refusal with a one-field `form`
 * whose options are the terminal's choices, then exits 3. `add` is what the rerun adds, with `<field>` in it. A
 * command with no `--json` reruns with `--non-tty`. A choice that is not a plain shell word is offered quoted.
 */
export function refusePick(input: {
  readonly code: string;
  readonly command: string;
  readonly lead: string;
  readonly field: { readonly name: string; readonly question: string; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }> };
  readonly rows: ReadonlyArray<readonly [string, string]>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly add: string;
  readonly devMode: boolean;
  readonly tail?: '--json' | '--non-tty';
}): never {
  // A value the shell would split or expand goes in quoted, so no choice is ever dropped; the pattern then lists them.
  const options = input.field.options.map((o) => ({ value: shellWord(o.value), label: o.label }));
  const safe = new RegExp(SHELL_SAFE_PATTERN);
  const pattern = options.every((o) => safe.test(o.value))
    ? SHELL_SAFE_PATTERN
    : `^(${options.map((o) => o.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
  console.log(JSON.stringify({
    ok: false,
    code: input.code,
    error: `${input.lead} ${needsHumanChoice(input.command)}`,
    elicitation: formElicitation({
      question: input.field.question,
      rows: input.rows,
      details: input.details,
      fields: [{ name: input.field.name, type: 'string', pattern, question: input.field.question, options }],
      rerun: rerunAdding(input.devMode, input.add, process.argv.slice(2), input.tail ?? '--json'),
    }),
  }, null, 2));
  process.exit(3);
}
