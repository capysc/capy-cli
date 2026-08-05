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
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse repeatable `--help-url NAME=URL` flags into a name→url map (http(s) only). */
export function parseHelpUrls(pairs: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const url = pair.slice(eq + 1).trim();
    if (VAR_RE.test(name) && /^https?:\/\//i.test(url)) map[name] = url;
  }
  return map;
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
  constructor(private readonly devMode: boolean = false) {}

  async execute(varNames: string[], opts: AddOpts): Promise<void> {
    const names = varNames.map((n) => n.trim()).filter(Boolean);
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

    // Write all pairs, pushing once at the end (each write accumulates into the
    // local env so the final push carries every variable).
    const writeMany = async (pairs: SecretPair[]): Promise<void> => {
      for (let i = 0; i < pairs.length; i++) {
        const { name, value } = pairs[i];
        await writeAndSync(ctx, name, value, { push: push && i === pairs.length - 1 });
        ctx.localPlaintext[name] = value;
      }
    };

    let savedNames: string[];
    if (opts.web) {
      const helpUrls = parseHelpUrls(opts.helpUrls);
      const vars: IntakeVar[] = names.map((name) => ({ name, helpUrl: helpUrls[name] }));
      // The overwrite warning goes above whatever the caller asked for: the
      // consequence of pressing Save outranks the note explaining why the form
      // was opened.
      const warning = opts.force ? undefined : overwriteNotice(existing);
      const reason = [warning, opts.reason].filter(Boolean).join(' ') || undefined;
      let captured: string[] = [];
      await runWebIntake(
        // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
        // headless runs drive the loopback without hijacking a real browser.
        { vars, reason, open: opts.open !== false && !process.env.CAPY_WEB_NO_OPEN },
        async (pairs) => {
          await writeMany(pairs);
          captured = pairs.map((p) => p.name);
        },
      );
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
        return;
      }
      savedNames = captured;
    } else {
      if (opts.nonTty) {
        throw new CapyError(
          'Non-interactive add requires --web (browser intake). Re-run with --web.',
          ERROR_CODES.INVALID_FORMAT,
        );
      }
      const inquirer = (await import('inquirer')).default;
      const pairs: SecretPair[] = [];
      for (const name of names) {
        const { value } = await inquirer.prompt([{ type: 'password', name: 'value', message: `Value for ${name}:`, mask: '*' }]);
        if (!value) throw new CapyError(`No value entered for ${name}.`, ERROR_CODES.INVALID_FORMAT);
        pairs.push({ name, value });
      }
      await writeMany(pairs);
      savedNames = pairs.map((p) => p.name);
    }

    const where = push ? ` and synced to ${ctx.branch}` : ' (.env only — not pushed)';
    console.log(`✓ Saved ${savedNames.length} variable(s): ${savedNames.join(', ')}${where}.`);
  }
}
