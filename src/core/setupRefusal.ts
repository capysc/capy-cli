/**
 * First-run setup with nobody to answer it.
 *
 * Bare `capy` in a folder that is not a project yet asks which organization, project and branch to use. Off a
 * terminal (or under `--dry-run` / `--resolve`, where nothing is asked) a picker would be drawn to nobody and the
 * run would end with exit 0 and no project. It stops here instead: a code on stdout and `EXIT_NEEDS_INPUT`.
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';

export const setupNeedsTerminal = (): CapyError =>
  new CapyError(
    'This folder is not a Capy project yet. Setting it up asks which organization, project and branch to use. Ask the human to run `capy` in a terminal in this folder, with no flags, and answer there.', // COPY-FLAG
    ERROR_CODES.SETUP_NEEDS_TTY,
  );

/** Prints the setup refusal as JSON and exits `EXIT_NEEDS_INPUT`; any other value is left to the caller. */
export function exitOnSetupRefusal(err: unknown): void {
  if (!(err instanceof CapyError) || err.code !== ERROR_CODES.SETUP_NEEDS_TTY) return;
  console.log(JSON.stringify({ ok: false, code: err.code, message: err.message }, null, 2));
  process.exit(EXIT_NEEDS_INPUT);
}
