import { CapyError, ERROR_CODES } from '../types';
import { resolveContext, writeAndSync, type ResolvedContext } from './connectors/shared';
import { MAX_PIPED_BYTES, readPipedValue, refuseInvalidName, refusePiped } from './pipedValue';
import { runPipedWrite, variableExists } from './pipedWrite';
import {
  recordsForWrite,
  refuseBadPrFlags,
  reportKeepLockHuman,
  runKeepLockPrStep,
  type PrFlags,
} from './keepLockPr';

/** One name and the value entered for it. */
export interface SecretPair {
  readonly name: string;
  readonly value: string;
}

export interface AddOpts {
  noPush?: boolean;
  force?: boolean;
  nonTty?: boolean;
  /** Piped mode: pure JSON on stdout. */
  json?: boolean;
  /** `--pr` / `--no-pr` / `--pr-base`: answers the keep.lock PR step. */
  pr?: PrFlags;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Piped mode is "a value arrives on stdin". It is decided by stdin alone.
 * `--non-tty` with a real terminal on stdin is NOT piped (nothing was piped,
 * and reading the keyboard would hang), so it reaches the refusal below.
 */
export function isPipedAdd(): boolean {
  return process.stdin.isTTY !== true;
}

/** Asks for each value in turn, hidden. Sequential by construction: one prompt, then the rest. */
async function promptForValues(names: readonly string[], done: readonly SecretPair[] = []): Promise<SecretPair[]> {
  if (names.length === 0) return [...done];
  const [name, ...rest] = names;
  const inquirer = (await import('inquirer')).default;
  const { value } = await inquirer.prompt([{ type: 'password', name: 'value', message: `Value for ${name}:`, mask: '*' }]);
  if (!value) throw new CapyError(`No value entered for ${name}.`, ERROR_CODES.INVALID_FORMAT);
  return promptForValues(rest, [...done, { name, value }]);
}

/**
 * Writes each pair in turn, pushing once at the end. Each write accumulates into
 * the local env (a new context per step, never a mutated one) so the final push
 * carries every variable.
 */
async function writeInOrder(
  ctx: ResolvedContext,
  pairs: readonly SecretPair[],
  push: boolean,
): Promise<void> {
  if (pairs.length === 0) return;
  const [{ name, value }, ...rest] = pairs;
  await writeAndSync(ctx, name, value, { push: push && rest.length === 0 });
  return writeInOrder({ ...ctx, localPlaintext: { ...ctx.localPlaintext, [name]: value } }, rest, push);
}

export class AddCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(varNames: string[], opts: AddOpts): Promise<void> {
    const names = varNames.map((n) => n.trim()).filter(Boolean);

    // Contradictory PR flags are refused before anything is changed.
    refuseBadPrFlags(opts.pr ?? {}, opts.json === true);

    // `<cmd> | capy add NAME`: the value comes from stdin and nothing prompts.
    if (isPipedAdd()) return this.executePiped(names, opts);

    if (names.length === 0) {
      throw new CapyError('No variable name given.', ERROR_CODES.INVALID_FORMAT);
    }
    for (const name of names) {
      if (!VAR_RE.test(name)) {
        throw new CapyError(`"${name}" is not a valid environment variable name.`, ERROR_CODES.INVALID_FORMAT);
      }
    }

    const ctx = await resolveContext({ devMode: this.devMode });
    const push = opts.noPush !== true;

    const existing = names.filter((n) => n in ctx.localPlaintext);
    if (existing.length > 0 && !opts.force && !opts.nonTty) {
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        { type: 'confirm', name: 'ok', message: `${existing.join(', ')} already exist(s). Overwrite?`, default: false },
      ]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const savedNames = await this.collectViaTerminal(ctx, names, opts, push);

    const where = push ? ` and synced to ${ctx.branch}` : ' (.env only — not pushed)';
    console.log(`✓ Saved ${savedNames.length} variable(s): ${savedNames.join(', ')}${where}.`);

    const outcome = await runKeepLockPrStep({
      command: 'add',
      cwd: process.cwd(),
      records: recordsForWrite(ctx.keep, ctx.pm.readKeepFile(), ctx.branch, savedNames),
      localKeep: ctx.keep,
      flags: opts.pr ?? {},
      json: opts.json === true,
      nonTty: opts.nonTty,
    });
    reportKeepLockHuman(outcome, { successTo: 'stdout', noteUnanswered: false });
  }

  /** `<cmd> | capy add NAME`. One name, one pipe; an existing name needs `--force`. */
  private async executePiped(names: readonly string[], opts: AddOpts): Promise<void> {
    const json = opts.json === true;
    if (names.length === 0) {
      return refusePiped(json, ERROR_CODES.INVALID_FORMAT, 'No variable name given.'); // COPY-FLAG
    }
    if (names.length > 1) {
      return refusePiped(
        json,
        ERROR_CODES.ADD_STDIN_ONE_NAME,
        'A piped value takes one variable name. Pipe once per variable: <cmd> | capy add NAME', // COPY-FLAG
      );
    }
    const [name] = names;
    // The argument is not echoed: a `NAME=value` typed by mistake must not be printed back.
    if (!VAR_RE.test(name)) return refuseInvalidName(json);

    const piped = await readPipedValue(process.stdin, MAX_PIPED_BYTES);
    if (!piped.ok) return refusePiped(json, piped.code, piped.error);

    await runPipedWrite(name, piped.value, {
      json,
      push: opts.noPush !== true,
      devMode: this.devMode,
      command: 'add',
      pr: opts.pr,
      gate: (ctx) =>
        variableExists(ctx, name) && opts.force !== true
          ? {
              code: ERROR_CODES.ADD_VAR_EXISTS,
              error: `${name} already exists. Pass --force to overwrite it, or use: capy edit ${name}`, // COPY-FLAG
            }
          : undefined,
    });
  }

  /** The hidden terminal prompt, one value per name. */
  private async collectViaTerminal(
    ctx: ResolvedContext,
    names: readonly string[],
    opts: AddOpts,
    push: boolean,
  ): Promise<string[]> {
    if (opts.nonTty) {
      throw new CapyError(
        // COPY-FLAG
        'Non-interactive add reads the value from stdin: <cmd> | capy add NAME',
        ERROR_CODES.INVALID_FORMAT,
      );
    }
    const pairs = await promptForValues(names);
    await writeInOrder(ctx, pairs, push);
    return pairs.map((p) => p.name);
  }
}
