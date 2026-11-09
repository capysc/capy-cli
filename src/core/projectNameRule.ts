/**
 * The rule for a project name, in one place: the init prompt (`PromptEngine.promptForProjectName`) and
 * `capy org create-project` both use it, so they only ever change together.
 *
 * Non-empty, letters/numbers/hyphens/underscores only, and not the reserved system store name.
 */
import { ERROR_CODES } from '../types/index';
import { isReservedProjectName, PROJECT_NAME_RESERVED_MESSAGE } from '../system/reservedProjectName';

/** The allowed characters, as the regular expression the init prompt has always used. */
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;

/** The same rule as a string, for JSON (`elicitation.fields[].pattern`). */
export const PROJECT_NAME_PATTERN_SOURCE: string = PROJECT_NAME_PATTERN.source;

export interface ProjectNameProblem {
  /** The code to refuse with. */
  readonly code: typeof ERROR_CODES.PROJECT_NAME_INVALID | typeof ERROR_CODES.PROJECT_NAME_RESERVED;
  /** For a human to read; never branched on. */
  readonly message: string;
}

/** Why `input` is not an allowed project name, or null when it is. Checks in the order the init prompt always has. */
export function projectNameProblem(input: string): ProjectNameProblem | null {
  if (!input || input.trim().length === 0) {
    return { code: ERROR_CODES.PROJECT_NAME_INVALID, message: 'Project name cannot be empty' };
  }
  if (!PROJECT_NAME_PATTERN.test(input)) {
    return {
      code: ERROR_CODES.PROJECT_NAME_INVALID,
      message: 'Project name can only contain letters, numbers, hyphens, and underscores',
    };
  }
  if (isReservedProjectName(input)) {
    return { code: ERROR_CODES.PROJECT_NAME_RESERVED, message: PROJECT_NAME_RESERVED_MESSAGE };
  }
  return null;
}

/** The shape an inquirer `validate` wants: `true`, or the sentence to show. */
export function validateProjectNameInput(input: string): string | true {
  return projectNameProblem(input)?.message ?? true;
}
