import { EventEmitter, once } from 'node:events';
import { CapyError, ERROR_CODES } from '../types';
import { resolveContext, writeAndSync, type ResolvedContext } from './connectors/shared';
import { MAX_PIPED_BYTES, readPipedValue, refuseInvalidName, refusePiped } from './pipedValue';
import { runPipedWrite, variableExists } from './pipedWrite';
import { runWebIntake, parseVars, type SecretPair } from '../ui/secretIntakeScreen';
import type { IntakeVar } from '../ui/screens/contract';
import {
  recordsForWrite,
  refuseBadPrFlags,
  reportKeepLockHuman,
  runKeepLockPrStep,
  type PrFlags,
} from './keepLockPr';

// The intake moved to `ui/secretIntakeScreen.ts` with the compiled screen it
// now serves. Re-exported here because this is where the flow is entered from
// and where its tests have always looked for it.
export { runWebIntake, parseVars, type SecretPair };

export interface AddOpts {
  web?: boolean;
  reason?: string;
  /** Repeatable `--help-url NAME=URL` pairs: a per-variable "where to find this" link. */
  helpUrls?: string[];
  /** false when --no-open was passed (commander negation). */
  open?: boolean;
  noPush?: boolean;
  force?: boolean;
  nonTty?: boolean;
  /** Piped mode: pure JSON on stdout. */
  json?: boolean;
  /** `--pr` / `--no-pr` / `--pr-base`: answers the keep.lock PR step. */
  pr?: PrFlags;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse repeatable `--help-url NAME=URL` flags into a name→url map (http(s) only). */
export function parseHelpUrls(pairs: string[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (pairs ?? []).flatMap((pair) => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return [];
      const name = pair.slice(0, eq).trim();
      const url = pair.slice(eq + 1).trim();
      return VAR_RE.test(name) && /^https?:\/\//i.test(url) ? [[name, url] as const] : [];
    }),
  );
}

/**
 * The terminal's overwrite confirm, in a form the intake page can carry.
 *
 * The CLI's own sentence, verbatim, because two wordings for one thing is a
 * bug. `--web` used to skip this question entirely — the confirm is gated on
 * `!opts.web` — so a browser intake silently overwrote existing values with no
 * mention anywhere. It cannot be a second screen (the intake form is the whole
 * flow and has no confirm step), so it is stated above the form and the Save
 * button is the answer: closing the window changes nothing, which is what
 * refusing meant in the terminal too.
 */
export function overwriteNotice(existing: string[]): string | undefined {
  return existing.length > 0 ? `${existing.join(', ')} already exist(s). Overwrite?` : undefined;
}

/**
 * Piped mode is "a value arrives on stdin, and there is no `--web`". It is
 * decided by stdin alone. `--non-tty` with a real terminal on stdin is NOT
 * piped (nothing was piped, and reading the keyboard would hang), so it still
 * reaches the refusal below that points at `--web`.
 */
export function isPipedAdd(opts: AddOpts): boolean {
  return opts.web !== true && process.stdin.isTTY !== true;
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
    if (isPipedAdd(opts)) return this.executePiped(names, opts);

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
    if (existing.length > 0 && !opts.force && !opts.web && !opts.nonTty) {
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        { type: 'confirm', name: 'ok', message: `${existing.join(', ')} already exist(s). Overwrite?`, default: false },
      ]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const savedNames = opts.web
      ? await this.collectViaBrowser(ctx, names, existing, opts, push)
      : await this.collectViaTerminal(ctx, names, opts, push);
    // The browser was closed without saving: already reported, nothing to confirm.
    if (savedNames === undefined) return;

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

  /**
   * The browser intake. Returns the names that were saved, or `undefined` when
   * the form was closed without saving (reported here).
   */
  private async collectViaBrowser(
    ctx: ResolvedContext,
    names: readonly string[],
    existing: readonly string[],
    opts: AddOpts,
    push: boolean,
  ): Promise<string[] | undefined> {
    const helpUrls = parseHelpUrls(opts.helpUrls);
    const vars: IntakeVar[] = names.map((name) => ({ name, helpUrl: helpUrls[name] }));
    // The overwrite warning goes above whatever the caller asked for: the
    // consequence of pressing Save outranks the note explaining why the form
    // was opened.
    const warning = opts.force ? undefined : overwriteNotice([...existing]);
    const reason = [warning, opts.reason].filter(Boolean).join(' ') || undefined;

    // `onSubmit` having run is the only signal that the form was filled in (a
    // closed window and a step nobody answered both resolve the intake the same
    // way). It is announced on a one-shot channel rather than written to a
    // variable, so nothing here is reassigned.
    const bus = new EventEmitter();
    const submitted = once(bus, 'submitted');
    await runWebIntake(
      // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
      // headless runs drive the loopback without hijacking a real browser.
      { vars, reason, open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN },
      async (pairs) => {
        await writeInOrder(ctx, pairs, push);
        bus.emit('submitted', pairs.map((p) => p.name));
      },
    );
    // First in the list wins when both are already settled: a submission that
    // happened beats the "nothing was entered" fallback.
    const [captured] = (await Promise.race([submitted, Promise.resolve([[]] as [string[]])])) as [string[]];

    // The intake resolves whether or not it was filled in — a closed window
    // and a step nobody answered both land here — and this is the only
    // signal that separates them from a save. Without it the command ran on
    // to `✓ Saved 0 variable(s): ` and reported a refusal as a success,
    // which for an overwrite is the difference between "I left it alone" and
    // "I replaced it".
    //
    // A PRINTED LINE AND A NORMAL RETURN, not a throw. Closing the window is
    // a refusal, and a refusal is one of the two endings this flow HAS — it
    // is not a fault. Throwing here reached the process-level
    // `unhandledRejection` handler (nothing between here and `program.parse`
    // catches it), which printed the sentence a second time under a node
    // stack trace and exited 1: a person who declined an overwrite was shown
    // a crash. The terminal path for the identical refusal prints `Aborted.`
    // and returns 0.
    if (captured.length === 0) {
      console.log('\n  Nothing was added. The browser was closed without saving.\n');
      return undefined;
    }
    return captured;
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
        'Non-interactive add requires --web (browser intake). Re-run with --web.',
        ERROR_CODES.INVALID_FORMAT,
      );
    }
    const pairs = await promptForValues(names);
    await writeInOrder(ctx, pairs, push);
    return pairs.map((p) => p.name);
  }
}
