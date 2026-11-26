import { CapyError, ERROR_CODES } from '../types/index';

/**
 * The refusal `resolveOrgContext` throws when the folder names no organization, the person belongs to several, and
 * nobody can be asked which (`--json`, or no terminal). An organization is never guessed: at a terminal the person
 * picks, and here the run ends with the orgs for the agent to show the human.
 */
export const isOrgSelectionRequired = (err: unknown): err is CapyError =>
  err instanceof CapyError && err.code === ERROR_CODES.ORG_SELECTION_REQUIRED;

/**
 * Ends a run that could not ask which organization: the refusal is JSON on stdout with the code and the orgs to show
 * the human, the terminal's pick as a form, and the exit code is 3. One shape for every command that works without a project folder.
 */
export function exitOrgSelectionRequired(err: CapyError): never {
  console.log(JSON.stringify({
    ok: false,
    code: err.code,
    message: err.message,
    orgs: err.details?.orgs ?? [],
    ...(err.details?.elicitation === undefined ? {} : { elicitation: err.details.elicitation }),
  }, null, 2));
  // A choice only the human can make (spec 3l): exit 3, like every other elicitation.
  return process.exit(3);
}

const ORG_REFUSALS: readonly string[] = [ERROR_CODES.ORG_SELECTION_REQUIRED, ERROR_CODES.ORG_NOT_FOUND, ERROR_CODES.ORG_FOLDER_MISMATCH];

/**
 * An organization refusal that reached the top of the run uncaught (a command that does not catch it itself): the
 * same coded JSON on stdout, never a stack trace. Returns false for anything else.
 */
export function exitIfOrgRefusal(err: unknown): boolean {
  if (!(err instanceof CapyError) || !ORG_REFUSALS.includes(err.code)) return false;
  if (err.code === ERROR_CODES.ORG_SELECTION_REQUIRED) return exitOrgSelectionRequired(err);
  console.log(JSON.stringify({ ok: false, code: err.code, message: err.message, ...(err.details ?? {}) }, null, 2));
  return process.exit(1);
}
