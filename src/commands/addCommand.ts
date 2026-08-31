import { CapyError, ERROR_CODES } from '../types';
import { resolveContext, writeAndSync } from './connectors/shared';
import { runWebIntake, parseVars, type SecretPair } from '../ui/secretIntakeScreen';
import type { IntakeVar } from '../ui/screens/contract';

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
  /** Explicit human approval to create the first local .env in lock-less mode. */
  createEnv?: boolean;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIRST_SECRET_ENV_QUESTION = 'Create .env for this project?';

export interface FirstSecretEnvState {
  readonly lockless: boolean;
  readonly localEnvExists: boolean;
  readonly remoteEnvExists: boolean;
  readonly createEnvApproved: boolean;
}

export interface FirstSecretEnvDecision {
  readonly code: typeof ERROR_CODES.FIRST_SECRET_ENV_REQUIRED;
  readonly question: typeof FIRST_SECRET_ENV_QUESTION;
  readonly retryFlag: '--create-env';
}

export interface AddCommandDependencies {
  readonly resolveContext: typeof resolveContext;
  readonly writeAndSync: typeof writeAndSync;
  readonly runWebIntake: typeof runWebIntake;
}

const DEFAULT_DEPENDENCIES: AddCommandDependencies = { resolveContext, writeAndSync, runWebIntake };

/**
 * Free lock-less onboarding deliberately leaves `.env` absent when there were
 * no secrets to import. The first later secret write therefore needs a real
 * human decision before any intake surface asks for a value. Paid/keep.lock
 * projects and either existing environment source stay on their established
 * paths unchanged.
 */
export function firstSecretEnvDecision(state: FirstSecretEnvState): FirstSecretEnvDecision | null {
  if (!state.lockless || state.localEnvExists || state.remoteEnvExists || state.createEnvApproved) return null;
  return {
    code: ERROR_CODES.FIRST_SECRET_ENV_REQUIRED,
    question: FIRST_SECRET_ENV_QUESTION,
    retryFlag: '--create-env',
  };
}

function remoteEnvironmentExists(ctx: Pick<Awaited<ReturnType<typeof resolveContext>>, 'keep' | 'branch'>): boolean {
  return Object.values(ctx.keep.variables).some((entries) => entries.some((entry) => entry.branch === ctx.branch));
}

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

export class AddCommand {
  constructor(
    private readonly devMode: boolean = false,
    private readonly dependencies: AddCommandDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async execute(varNames: string[], opts: AddOpts): Promise<void> {
    const names = varNames.map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new CapyError('No variable name given.', ERROR_CODES.INVALID_FORMAT);
    }
    const invalidName = names.find((name) => !VAR_RE.test(name));
    if (invalidName !== undefined) {
      throw new CapyError(`"${invalidName}" is not a valid environment variable name.`, ERROR_CODES.INVALID_FORMAT);
    }

    const ctx = await this.dependencies.resolveContext({ devMode: this.devMode });
    const push = opts.noPush !== true;
    const firstSecretDecision = !ctx.lockless
      ? null
      : firstSecretEnvDecision({
        lockless: true,
        localEnvExists: (await ctx.pm.detectProjectState()).hasEnvFile,
        remoteEnvExists: remoteEnvironmentExists(ctx),
        createEnvApproved: opts.createEnv === true,
      });
    if (firstSecretDecision !== null) {
      if (opts.nonTty) {
        throw new CapyError(
          `No local or remote .env exists. Ask the user: "${firstSecretDecision.question}" If approved, retry with ${firstSecretDecision.retryFlag}.`,
          firstSecretDecision.code,
          {
            decision: 'create_env',
            question: firstSecretDecision.question,
            retry_flag: firstSecretDecision.retryFlag,
          },
        );
      }
      console.log('No local or remote .env exists.');
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        { type: 'confirm', name: 'ok', message: firstSecretDecision.question, default: true },
      ]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    const existing = names.filter((n) => n in ctx.localPlaintext);
    if (existing.length > 0 && !opts.force && !opts.web && !opts.nonTty) {
      // Context ABOVE the question, never folded into it — the question
      // itself (`overwriteNotice`'s sentence, inlined here) is tested
      // verbatim and stays byte-identical either way. Dynamic import, like
      // `inquirer` below: a test drives this command's `--web` path against a
      // `connectors/shared` replaced wholesale by `mock.module` (only
      // `resolveContext`/`writeAndSync` provided) — a static named import of
      // anything else from that module would fail to link before the test
      // ever reaches this branch.
      const { conflictContextLines } = await import('./connectors/shared');
      for (const line of conflictContextLines(ctx.keep, existing, ctx.branch)) {
        console.log(line);
      }
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        { type: 'confirm', name: 'ok', message: `${existing.join(', ')} already exist(s). Overwrite?`, default: false },
      ]);
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    // The push-time counterpart of the "already exists locally" confirm
    // above: a lock-less push discovers, via a 409 STALE_KEEP_HASH, that one
    // of these exact names changed on the server since `ctx` was resolved —
    // someone (or another machine) beat this write there. Same refusal
    // convention as everywhere else in this command: `--force` always says
    // yes, `--web`/`--nonTty` have no secondary confirm surface to ask on so
    // they refuse (the intake form's only "yes" is Save, already spent), and
    // a real TTY gets the same inquirer confirm shape as the local gate
    // above — same sentence, "changed on the server" instead of "already
    // exist(s)" because it's a different fact.
    const confirmOverwrite = async (changedNames: string[], contextLines: string[]): Promise<boolean> => {
      if (opts.force) return true;
      if (opts.web || opts.nonTty) return false;
      for (const line of contextLines) console.log(line);
      const { conflictOverwriteQuestion } = await import('./connectors/shared');
      const inquirer = (await import('inquirer')).default;
      const { ok } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'ok',
          message: conflictOverwriteQuestion(changedNames),
          default: false,
        },
      ]);
      return ok;
    };

    // Write all pairs, pushing once at the end (each write accumulates into the
    // local env so the final push carries every variable).
    const writeMany = async (
      pairs: readonly SecretPair[],
      index: number = 0,
      currentCtx: typeof ctx = ctx,
    ): Promise<void> => {
      const pair = pairs[index];
      if (pair === undefined) return;
      await this.dependencies.writeAndSync(currentCtx, pair.name, pair.value, {
        push: push && index === pairs.length - 1,
        confirmOverwrite,
      });
      return writeMany(pairs, index + 1, {
        ...currentCtx,
        localPlaintext: { ...currentCtx.localPlaintext, [pair.name]: pair.value },
      });
    };

    const savedNames = await (async (): Promise<readonly string[]> => {
      if (!opts.web) {
        if (opts.nonTty) {
          throw new CapyError(
            'Non-interactive add requires --web (browser intake). Re-run with --web.',
            ERROR_CODES.INVALID_FORMAT,
          );
        }
        const inquirer = (await import('inquirer')).default;
        const collectPairs = async (remaining: readonly string[]): Promise<readonly SecretPair[]> => {
          const [name, ...rest] = remaining;
          if (name === undefined) return [];
          const { value } = await inquirer.prompt([
            { type: 'password', name: 'value', message: `Value for ${name}:`, mask: '*' },
          ]);
          if (!value) throw new CapyError(`No value entered for ${name}.`, ERROR_CODES.INVALID_FORMAT);
          return [{ name, value }, ...(await collectPairs(rest))];
        };
        const pairs = await collectPairs(names);
        await writeMany(pairs);
        return pairs.map((pair) => pair.name);
      }

      const helpUrls = parseHelpUrls(opts.helpUrls);
      const vars: IntakeVar[] = names.map((name) => ({ name, helpUrl: helpUrls[name] }));
      // The overwrite warning goes above whatever the caller asked for: the
      // consequence of pressing Save outranks the note explaining why the form
      // was opened.
      const warning = opts.force ? undefined : overwriteNotice(existing);
      const reason = [warning, opts.reason].filter(Boolean).join(' ') || undefined;
      const captured = await new Promise<readonly string[]>((resolve, reject) => {
        this.dependencies.runWebIntake(
          // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
          // headless runs drive the loopback without hijacking a real browser.
          // `authService` opts this call into the keep-hosted transport when
          // CAPY_KEEP_SCREENS=1 (W2-A) — omitted, this is unreachable and the
          // flow is the loopback-only path unchanged.
          {
            vars,
            reason,
            open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN,
            authService: ctx.authService,
          },
          async (pairs) => {
            await writeMany(pairs);
            resolve(pairs.map((pair) => pair.name));
          },
        ).then(() => resolve([]), reject);
      });
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
      // a crash. The terminal path for the identical refusal, twenty lines up,
      // prints `Aborted.` and returns 0.
      if (captured.length === 0) {
        console.log('\n  Nothing was added. The browser was closed without saving.\n');
        return [];
      }
      return captured;
    })();

    if (savedNames.length === 0) return;

    const where = push ? ` and synced to ${ctx.branch}` : ' (.env only — not pushed)';
    console.log(`✓ Saved ${savedNames.length} variable(s): ${savedNames.join(', ')}${where}.`);
  }
}
