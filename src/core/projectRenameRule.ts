/**
 * The rule for the name `capy projects rename` accepts, in one pure function.
 *
 * Two forms are allowed:
 *   - the hand-typed form: whatever `projectNameProblem` accepts (letters, numbers, hyphens, underscores);
 *   - the monorepo form discovery makes, `<repo>/<folder>/...`: non-empty `/`-separated segments, each one passing
 *     that same hand-typed rule on its own.
 * Either way the whole name stays within the length discovery refuses beyond (never truncated), and is not reserved.
 *
 * `projectNameProblem` itself, the create flow and discovery are not changed: this builds on them.
 */
import { ERROR_CODES } from '../types/index';
import { DISCOVERY_PROJECT_NAME_MAX_LENGTH } from '../commands/connectors/dokployDiscovery';
import { PROJECT_NAME_PATTERN, projectNameProblem, type ProjectNameProblem } from './projectNameRule';

export type RenameNameProblem = ProjectNameProblem;

/** The allowed new names as a regular expression, for JSON (`elicitation.fields[].pattern`): the hand-typed segment rule, one or more segments joined by `/`. */
const SEGMENT_SOURCE = PROJECT_NAME_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
export const PROJECT_RENAME_PATTERN_SOURCE = `^${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE})*$`;

/** Why `input` is not an allowed new name, or null when it is. */
export function renameNameProblem(input: string): RenameNameProblem | null {
  if (input.length > DISCOVERY_PROJECT_NAME_MAX_LENGTH) {
    return {
      code: ERROR_CODES.PROJECT_NAME_INVALID,
      message: `Project name is too long (max ${DISCOVERY_PROJECT_NAME_MAX_LENGTH})`, // COPY-FLAG
    };
  }
  return firstProblem(input.split('/'));
}

/** A name with no `/` is one segment, so the hand-typed rule is the monorepo rule's one-segment case. */
function firstProblem(segments: readonly string[]): RenameNameProblem | null {
  return segments.map(projectNameProblem).find((problem) => problem !== null) ?? null;
}
