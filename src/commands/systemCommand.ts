/**
 * `capy system set|list|rm` — the org system store (CAP-664).
 *
 * Every refusal is coded (cardinal Rule: never branch on human-readable
 * strings) and `--json` output is pure JSON on stdout; prose only goes to
 * stderr, and only in human mode.
 *
 * Each command's pre-checks (name validation, TTY/confirmation) run OUTSIDE
 * any try/catch that also handles the store's own errors: `refuse*()` below
 * calls `process.exit`, which never returns in production, but a test that
 * mocks `process.exit` to throw (the only way to test an exit code without
 * killing the runner) needs that throw to propagate rather than be caught a
 * second time by a surrounding try/catch and re-coded as a generic failure.
 */
import inquirer from 'inquirer';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { openSystemStore, assertValidConnectorName } from '../system/systemStore';
import { CapyError, ERROR_CODES } from '../types/index';

export interface SystemCommandOpts {
  org?: string;
  json?: boolean;
  apiUrl?: string;
  devMode?: boolean;
}

export interface SystemRmOpts extends SystemCommandOpts {
  yes?: boolean;
}

/** Pure JSON refusal on stdout — never on stderr, so `--json` output stays parseable. */
function refuseJson(code: string, error: string, exitCode: number): never {
  console.log(JSON.stringify({ ok: false, code, error }, null, 2));
  process.exit(exitCode);
}

/** Prose refusal on stderr — human mode only. */
function refuseHuman(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function refuse(json: boolean, code: string, message: string, exitCode: number): never {
  if (json) refuseJson(code, message, exitCode);
  refuseHuman(message, exitCode);
}

function exitCodeFor(code: string): number {
  return code === ERROR_CODES.SYSTEM_STORE_NEEDS_TTY ? EXIT_NEEDS_INPUT : 1;
}

/** Every refusal a store operation can throw, coded and routed to the right stream. */
function refuseError(err: unknown, json: boolean): never {
  if (err instanceof CapyError) {
    refuse(json, err.code, err.message, exitCodeFor(err.code));
  }
  const message = err instanceof Error ? err.message : String(err);
  refuse(json, ERROR_CODES.SERVICE_ERROR, message, 1);
}

/** Validates `name` and exits with a coded refusal on failure — before any network call. */
function requireValidName(name: string, json: boolean): void {
  try {
    assertValidConnectorName(name);
  } catch (err) {
    refuseError(err, json);
  }
}

/** Exits with `SYSTEM_STORE_NEEDS_TTY` when there is no terminal to ask a human. */
function requireTty(json: boolean, message: string): void {
  if (!isInteractive()) {
    refuse(json, ERROR_CODES.SYSTEM_STORE_NEEDS_TTY, message, EXIT_NEEDS_INPUT);
  }
}

/**
 * Under `--json`, stdout must stay pure JSON — so a prompt that still has to
 * run (there IS a terminal) renders itself to stderr instead of stdout.
 * `inquirer.prompt` always writes to stdout; a self-contained module created
 * with `createPromptModule({ output })` is the one way to redirect it.
 */
function promptModuleFor(json: boolean): typeof inquirer.prompt {
  return json ? inquirer.createPromptModule({ output: process.stderr }) : inquirer.prompt;
}

async function promptForHiddenValue(name: string, json: boolean): Promise<string> {
  const { value } = await promptModuleFor(json)([
    {
      type: 'password',
      name: 'value',
      message: `Value for ${name}:`, // COPY-FLAG
      mask: '*',
      validate: (input: string) => (input.trim().length > 0 ? true : 'Value cannot be empty'), // COPY-FLAG
    },
  ]);
  return String(value).trim();
}

async function promptForRemovalConfirmation(name: string, json: boolean): Promise<boolean> {
  const { confirmed } = await promptModuleFor(json)([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Remove ${name} from this org's system store?`, // COPY-FLAG
      default: false,
    },
  ]);
  return confirmed === true;
}

/** `capy system set <NAME>` — hidden prompt only; the value is never a flag or argument. */
export async function systemSetCommand(name: string, opts: SystemCommandOpts): Promise<void> {
  const json = opts.json === true;

  // Before any network call — see docs/org-system-store.md Proof 3.
  requireValidName(name, json);
  requireTty(json, `\`capy system set\` needs a terminal to prompt for the value — there is no --value flag.`); // COPY-FLAG

  const value = await promptForHiddenValue(name, json);

  try {
    const store = await openSystemStore({ orgId: opts.org, apiUrl: opts.apiUrl, devMode: opts.devMode });
    await store.set(name, value);

    if (json) {
      console.log(JSON.stringify({ ok: true, name }, null, 2));
      return;
    }
    console.log(`Saved ${name}.`); // COPY-FLAG — never echoes the value
  } catch (err) {
    refuseError(err, json);
  }
}

/** `capy system list [--json]` — names + `changed_at` only, never values. */
export async function systemListCommand(opts: SystemCommandOpts): Promise<void> {
  const json = opts.json === true;
  try {
    const store = await openSystemStore({ orgId: opts.org, apiUrl: opts.apiUrl, devMode: opts.devMode });
    const names = store.listNames();

    if (json) {
      console.log(JSON.stringify({ ok: true, names }, null, 2));
      return;
    }

    if (names.length === 0) {
      console.log('No entries in this org\'s system store.'); // COPY-FLAG
      return;
    }
    console.log('');
    for (const entry of names) {
      const when = entry.changed_at ? ` (changed ${entry.changed_at})` : ''; // COPY-FLAG
      console.log(`  ${entry.name}${when}`);
    }
    console.log('');
  } catch (err) {
    refuseError(err, json);
  }
}

/** `capy system rm <NAME> [--yes]` — confirms unless `--yes`; default answer is no. */
export async function systemRmCommand(name: string, opts: SystemRmOpts): Promise<void> {
  const json = opts.json === true;

  // Before any network call — see docs/org-system-store.md Proof 3.
  requireValidName(name, json);
  if (!opts.yes) {
    requireTty(json, `\`capy system rm\` needs confirmation — pass --yes or run this in a terminal.`); // COPY-FLAG
  }

  const confirmed = opts.yes === true || (await promptForRemovalConfirmation(name, json));
  if (!confirmed) {
    if (json) {
      console.log(JSON.stringify({ ok: false, code: ERROR_CODES.CANCELLED, error: 'Cancelled.' }, null, 2));
      return;
    }
    console.log('Cancelled.'); // COPY-FLAG
    return;
  }

  try {
    const store = await openSystemStore({ orgId: opts.org, apiUrl: opts.apiUrl, devMode: opts.devMode });
    await store.remove(name);

    if (json) {
      console.log(JSON.stringify({ ok: true, name }, null, 2));
      return;
    }
    console.log(`Removed ${name}.`); // COPY-FLAG
  } catch (err) {
    refuseError(err, json);
  }
}
