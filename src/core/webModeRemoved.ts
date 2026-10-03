/**
 * `--web` is gone. An agent that still passes it must be told so, with a coded
 * refusal, rather than have the command run in a terminal nobody is watching.
 *
 * The flag stays declared (hidden from help and from `capy help --json`) so it
 * parses wherever it used to, and the program's `preAction` hook calls
 * {@link refuseWebMode} before any handler runs. The command is never executed.
 */
import { ERROR_CODES } from '../types/index';

/** COPY-FLAG: minimal-neutral. Callers branch on the code, never on this text. */
export const WEB_MODE_REMOVED_MESSAGE =
  '--web was removed. Run the command in a terminal, or pipe values (see capy help).';

/**
 * Refuses and exits 1. `--json`: `{ ok:false, code, error }` as pure JSON on
 * stdout. Otherwise the sentence on stderr.
 */
export function refuseWebMode(json: boolean): never {
  if (json) {
    console.log(
      JSON.stringify({ ok: false, code: ERROR_CODES.WEB_MODE_REMOVED, error: WEB_MODE_REMOVED_MESSAGE }, null, 2),
    );
  } else {
    console.error(WEB_MODE_REMOVED_MESSAGE);
  }
  process.exit(1);
}
