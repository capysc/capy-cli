/**
 * The rule for a branch name, as the service checks it on `POST /projects/:id/branches` (service
 * `routes/projects.ts` `validateBranchName`). The service answers a bad name with a bare 400 and no code, so the CLI
 * checks first and refuses with BRANCH_NAME_INVALID before any request. Change both together.
 */
import { ERROR_CODES } from '../types/index';

/** Starts with a letter or number; then letters, numbers, `.`, `_` and `-`. */
export const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The same rule as a string, for JSON (`elicitation.fields[].pattern`). */
export const BRANCH_NAME_PATTERN_SOURCE: string = BRANCH_NAME_PATTERN.source;

export const BRANCH_NAME_MAX_LENGTH = 128;

/** The branch a new project starts with unless someone picks another. Bare `capy` and `capy org` offer the same. */
export const DEFAULT_FIRST_BRANCH = 'development';

/** What a Capy branch is. Approved wording (Vince, 2026-11-09): use it verbatim. */
export const BRANCH_DESCRIPTION = 'A Capy branch works like a git branch. Capy branches can be used to set different variables for different environments.';

/** The question for the first branch. Approved wording (Vince, 2026-11-09): use it verbatim. */
export const FIRST_BRANCH_QUESTION = 'What should its first branch be called?';

export interface BranchNameProblem {
  readonly code: typeof ERROR_CODES.BRANCH_NAME_INVALID;
  /** For a human to read; never branched on. These are the service's own sentences. */
  readonly message: string;
}

/** Why `input` is not a branch name the service accepts, or null when it is. Same checks, same order as the service. */
export function branchNameProblem(input: string): BranchNameProblem | null {
  const message = branchNameMessage(input);
  return message === null ? null : { code: ERROR_CODES.BRANCH_NAME_INVALID, message };
}

function branchNameMessage(input: string): string | null {
  if (!input || input.length === 0) return 'Branch name cannot be empty';
  if (input.length > BRANCH_NAME_MAX_LENGTH) return `Branch name too long (max ${BRANCH_NAME_MAX_LENGTH})`;
  if (input.includes('..')) return 'Branch name cannot contain ".."';
  if (!BRANCH_NAME_PATTERN.test(input)) return 'Branch name must start with a letter or number';
  return null;
}

/** The shape an inquirer `validate` wants: `true`, or the sentence to show. */
export function validateBranchNameInput(input: string): string | true {
  return branchNameProblem(input.trim())?.message ?? true;
}
