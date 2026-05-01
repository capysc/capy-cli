/**
 * Single-keypress action picker for the `capy deploy` confirm step.
 *
 * Shows a help line styled like the rest of the CLI (dim gray, bold-white
 * key letters), reads ONE raw keypress, returns the chosen action. Avoids
 * the "type a letter then press enter" two-step that inquirer's `expand`
 * prompt makes you do.
 *
 * Bindings:
 *   c, enter   → confirm
 *   e          → edit
 *   d          → delete
 *   esc, q     → cancel
 *   ctrl-c     → cancel (also exits the parent process if uncaught)
 */

const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const KEY = (s: string) => `\x1b[1;97m${s}\x1b[0m`;

export type DeployAction = 'confirm' | 'edit' | 'delete' | 'cancel';

export interface KeypressConfirmOptions {
  /** Headline shown above the key bindings, e.g. "Deploy now?" */
  message: string;
  /** When stdin isn't a TTY (CI), default to this action. */
  nonInteractiveDefault?: DeployAction;
}

const HELP_LINE =
  KEY('c') +
  DIM(' confirm   ') +
  KEY('e') +
  DIM(' edit   ') +
  KEY('d') +
  DIM(' delete   ') +
  KEY('esc') +
  DIM(' exit');

export function keypressConfirm(
  opts: KeypressConfirmOptions,
): Promise<DeployAction> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const isTTY = stdin.isTTY;

    if (!isTTY) {
      resolve(opts.nonInteractiveDefault ?? 'cancel');
      return;
    }

    // Print the question + help line, leave the cursor parked at end of line.
    process.stdout.write(`? ${opts.message}\n  ${HELP_LINE} `);

    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (key: string) => {
      const ch = key[0];
      const code = key.charCodeAt(0);
      let action: DeployAction | null = null;

      if (ch === 'c' || ch === 'C' || code === 13 /* \r */ || code === 10 /* \n */) {
        action = 'confirm';
      } else if (ch === 'e' || ch === 'E') {
        action = 'edit';
      } else if (ch === 'd' || ch === 'D') {
        action = 'delete';
      } else if (
        code === 27 /* ESC */ ||
        ch === 'q' ||
        ch === 'Q' ||
        code === 3 /* Ctrl-C */
      ) {
        action = 'cancel';
      }
      // Any other key: ignore, wait for a recognized one.

      if (action) {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        // Echo the choice on its own line so the transcript reads naturally.
        process.stdout.write(`${action}\n`);
        resolve(action);
      }
    };
    stdin.on('data', onData);
  });
}
