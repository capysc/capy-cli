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
 * the human, and the exit code is 1. One shape for every command that works without a project folder.
 */
export function exitOrgSelectionRequired(err: CapyError): never {
  console.log(JSON.stringify({ ok: false, code: err.code, message: err.message, orgs: err.details?.orgs ?? [] }, null, 2));
  return process.exit(1);
}
