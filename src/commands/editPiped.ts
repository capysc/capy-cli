/**
 * `capy edit [NAME]` — which mode a given invocation is in, and piped mode.
 *
 * The decision is a pure function of three facts (a name, whether stdin is a
 * terminal, `--non-tty`) and is made BEFORE anything is drawn and before any
 * auth or network call, so `capy edit </dev/null` refuses immediately instead
 * of writing an ANSI screen into captured stdout and hanging on a stdin that
 * never delivers a key.
 *
 * | name | stdin   | mode     |
 * |------|---------|----------|
 * | any  | TTY     | `tui`    |
 * | yes  | not TTY | `piped`  |
 * | no   | not TTY | `refuse` |
 *
 * `--non-tty` takes the TTY off the table. A name with `--non-tty` on a real
 * terminal has nothing piped to read, so it refuses rather than block on the
 * keyboard.
 */
import { ERROR_CODES } from '../types/index';
import { isLocalOnly } from '../config/profileConfig';
import { MAX_PIPED_BYTES, readPipedValue, refuseInvalidName, refusePiped } from './pipedValue';
import { isValidVarName, runPipedWrite } from './pipedWrite';
import type { PrFlags } from './keepLockPr';

export type EditMode = 'tui' | 'piped' | 'refuse';

export interface EditModeFacts {
  readonly hasName: boolean;
  readonly stdinIsTTY: boolean;
  readonly nonTty: boolean;
}

export function decideEditMode(facts: EditModeFacts): EditMode {
  const { hasName, stdinIsTTY, nonTty } = facts;
  if (stdinIsTTY && !nonTty) return 'tui';
  const somethingIsPiped = !stdinIsTTY;
  if (hasName) return somethingIsPiped ? 'piped' : 'refuse';
  return 'refuse';
}

/** `EDIT_NEEDS_TTY`, exit 3. Hint verbatim from the spec. */
export function refuseEditNeedsTty(json: boolean): never {
  return refusePiped(
    json,
    ERROR_CODES.EDIT_NEEDS_TTY,
    'capy edit needs a terminal. pipe a value: <cmd> | capy edit NAME, or run in a terminal', // COPY-FLAG
  );
}

export interface EditPipedOpts {
  readonly json: boolean;
  readonly push: boolean;
  readonly devMode: boolean;
  /** `--pr` / `--no-pr` / `--pr-base`: answers the keep.lock PR step. */
  readonly pr?: PrFlags;
  /** `--dry-run`: say what would happen; change nothing. */
  readonly dryRun?: boolean;
}

/** `<cmd> | capy edit NAME`: read stdin, set the variable, report. Never prompts. */
export async function editPipedCommand(name: string, opts: EditPipedOpts): Promise<void> {
  if (!isValidVarName(name)) return refuseInvalidName(opts.json);
  if (isLocalOnly()) {
    return refusePiped(
      opts.json,
      ERROR_CODES.EDIT_STDIN_LOCAL_ONLY,
      'Piped values need an organization. This profile is local-only.', // COPY-FLAG
    );
  }

  const piped = await readPipedValue(process.stdin, MAX_PIPED_BYTES);
  if (!piped.ok) return refusePiped(opts.json, piped.code, piped.error);

  await runPipedWrite(name, piped.value, { ...opts, command: 'edit' });
}
