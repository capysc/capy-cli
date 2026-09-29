/**
 * Single-keypress action pickers for `capy deploy`'s terminal prompts.
 *
 * Shows a help line styled like the rest of the CLI (dim gray, bold-white
 * key letters), reads ONE raw keypress, resolves to the chosen action.
 * Avoids the "type a letter then press enter" two-step that inquirer's
 * `expand` prompt makes you do.
 *
 * Two menus share one keypress reader (`readKeypressAction`):
 *  - `keypressConfirm` — the deploy confirm step (confirm/edit/delete/cancel).
 *  - `keypressPreflightMenu` (CAP-657 "no trap" follow-up) — what a failing
 *    preflight offers instead of just exiting (edit/retry/cancel).
 */

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`;

/**
 * Read one raw keypress from stdin and resolve it to a `T` via `classify`,
 * ignoring any key `classify` doesn't recognize (waits for the next one). A
 * non-TTY resolves immediately to `nonInteractiveDefault` — no listener is
 * ever attached, so there's nothing to hang waiting for input that can't
 * arrive. No mutable state: `classify` is a pure function of the raw key,
 * so there is never a "have we decided yet" flag to reassign — the promise
 * simply resolves the first time `classify` returns non-null.
 */
function readKeypressAction<T extends string>(
  message: string,
  helpLine: string,
  classify: (key: string) => T | null,
  nonInteractiveDefault: T,
): Promise<T> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const isTTY = stdin.isTTY;

    if (!isTTY) {
      resolve(nonInteractiveDefault);
      return;
    }

    // Print the question + help line, leave the cursor parked at end of line.
    process.stdout.write(`? ${message}\n  ${helpLine} `);

    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (key: string) => {
      const action = classify(key);
      // Any unrecognized key: ignore, wait for a recognized one.
      if (!action) return;

      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      // Echo the choice on its own line so the transcript reads naturally.
      process.stdout.write(`${action}\n`);
      resolve(action);
    };
    stdin.on('data', onData);
  });
}

// ── Deploy confirm step: confirm / edit / delete / cancel ──────────────────

export type DeployAction = 'confirm' | 'edit' | 'delete' | 'cancel';

export interface KeypressConfirmOptions {
  /** Headline shown above the key bindings, e.g. "Deploy now?" */
  message: string;
  /** When stdin isn't a TTY (CI), default to this action. */
  nonInteractiveDefault?: DeployAction;
}

const CONFIRM_HELP_LINE =
  KEY('c') +
  DIM(' confirm   ') +
  KEY('e') +
  DIM(' edit   ') +
  KEY('d') +
  DIM(' delete   ') +
  KEY('esc') +
  DIM(' exit');

function classifyDeployConfirmKey(key: string): DeployAction | null {
  const ch = key[0];
  const code = key.charCodeAt(0);
  if (ch === 'c' || ch === 'C' || code === 13 /* \r */ || code === 10 /* \n */) return 'confirm';
  if (ch === 'e' || ch === 'E') return 'edit';
  if (ch === 'd' || ch === 'D') return 'delete';
  if (code === 27 /* ESC */ || ch === 'q' || ch === 'Q' || code === 3 /* Ctrl-C */) return 'cancel';
  return null;
}

/**
 * Bindings:
 *   c, enter   → confirm
 *   e          → edit
 *   d          → delete
 *   esc, q     → cancel
 *   ctrl-c     → cancel (also exits the parent process if uncaught)
 */
export function keypressConfirm(opts: KeypressConfirmOptions): Promise<DeployAction> {
  return readKeypressAction(
    opts.message,
    CONFIRM_HELP_LINE,
    classifyDeployConfirmKey,
    opts.nonInteractiveDefault ?? 'cancel',
  );
}

// ── Preflight-failure menu (CAP-657 "no trap" follow-up) ────────────────────

export type PreflightFailureAction = 'edit' | 'retry' | 'cancel';

export interface KeypressPreflightMenuOptions {
  /** Headline shown above the key bindings — the already-printed failure reason precedes it. */
  message: string;
}

const PREFLIGHT_HELP_LINE =
  KEY('e') + DIM(' edit settings   ') + KEY('r') + DIM(' retry   ') + KEY('esc') + DIM(' cancel');

function classifyPreflightFailureKey(key: string): PreflightFailureAction | null {
  const ch = key[0];
  const code = key.charCodeAt(0);
  if (ch === 'e' || ch === 'E') return 'edit';
  if (ch === 'r' || ch === 'R') return 'retry';
  if (code === 27 /* ESC */ || ch === 'q' || ch === 'Q' || code === 3 /* Ctrl-C */) return 'cancel';
  return null;
}

/**
 * `capy deploy <target>` used to print a failing preflight's reason and
 * exit outright — a dead end at a real terminal, where "fix the thing that's
 * wrong and try again" is one keypress away. Offered ONLY at a TTY
 * (`deployCommand.ts` keeps today's immediate coded exit for `--yes`/
 * `--json`/non-TTY — see `resolveOrEditUntilPreflightPasses`'s own doc).
 *
 * Bindings:
 *   e       → edit target settings (re-enters the picker, saves, re-checks)
 *   r       → retry (re-runs preflight against the same target, unchanged)
 *   esc, q  → cancel (exits with the SAME coded failure preflight reported)
 *   ctrl-c  → cancel
 */
export function keypressPreflightMenu(
  opts: KeypressPreflightMenuOptions,
): Promise<PreflightFailureAction> {
  return readKeypressAction(opts.message, PREFLIGHT_HELP_LINE, classifyPreflightFailureKey, 'cancel');
}
