/**
 * What bare `capy` still has to find out before it can set up a folder, as pure decisions.
 *
 * The same rules serve the terminal (a typed flag answers its prompt) and agent mode (a typed flag answers its
 * question; what is left is asked once, as one form). Nothing here reads a file or calls the service.
 */
import { ERROR_CODES } from '../types/index';
import type { SetupAnswers } from '../types/index';
import { BRANCH_NAME_PATTERN_SOURCE, branchNameProblem } from './branchNameRule';
import { PROJECT_NAME_PATTERN_SOURCE, projectNameProblem } from './projectNameRule';

export interface OrgRef {
  readonly id: string;
  readonly name: string;
}

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** The word `--project` takes to mean "create one": an id or a name that matches nothing is not this. */
export const NEW_PROJECT = 'new';

/** A refusal's parts, before it is given an exit code. */
export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

const PROTECTED_ANSWERS: readonly string[] = ['yes', 'no'];
const SHARE_ANSWERS: readonly string[] = ['yes', 'no'];

/**
 * The first typed answer that breaks a rule, before any network call, or null. A flag that cannot apply is not
 * checked: with `--project` naming an existing project, `--name` and `--protected` are ignored.
 */
export function answerProblem(answers: SetupAnswers): Problem | null {
  if (answers.encryptAnswer !== undefined && !SHARE_ANSWERS.includes(answers.encryptAnswer)) {
    return {
      code: ERROR_CODES.ENCRYPT_ENV_INVALID,
      message: '--encrypt-env takes yes or no.', // COPY-FLAG
      extra: { options: SHARE_ANSWERS },
    };
  }
  if (answers.shareAnswer !== undefined && !SHARE_ANSWERS.includes(answers.shareAnswer)) {
    return {
      code: ERROR_CODES.SHARE_SETUP_INVALID,
      message: '--share-setup takes yes or no.', // COPY-FLAG
      extra: { options: SHARE_ANSWERS },
    };
  }
  const linksExisting = answers.project !== undefined && answers.project !== NEW_PROJECT;
  const branchProblem = answers.branch === undefined ? null : branchNameProblem(answers.branch);
  if (branchProblem !== null) return { ...branchProblem, extra: { pattern: BRANCH_NAME_PATTERN_SOURCE } };
  if (linksExisting) return null;
  const nameProblem = answers.name === undefined ? null : projectNameProblem(answers.name);
  if (nameProblem !== null) {
    return {
      ...nameProblem,
      extra: nameProblem.code === ERROR_CODES.PROJECT_NAME_INVALID ? { pattern: PROJECT_NAME_PATTERN_SOURCE } : undefined,
    };
  }
  if (answers.protectedAnswer !== undefined && !PROTECTED_ANSWERS.includes(answers.protectedAnswer)) {
    return {
      code: ERROR_CODES.BRANCH_PROTECTION_INVALID,
      message: '--protected takes yes or no.', // COPY-FLAG: project create's wording
      extra: { options: PROTECTED_ANSWERS },
    };
  }
  return null;
}

/** Items whose id is `typed`, else whose name is `typed`, else whose name is `typed` ignoring case. */
function matchesOf<T extends { readonly id: string; readonly name: string }>(items: readonly T[], typed: string): readonly T[] {
  const byId = items.filter((i) => i.id === typed);
  if (byId.length > 0) return byId;
  const byName = items.filter((i) => i.name === typed);
  if (byName.length > 0) return byName;
  return items.filter((i) => i.name.toLowerCase() === typed.toLowerCase());
}

export type OrgChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'picked'; readonly org: OrgRef }
  | { readonly kind: 'ask'; readonly orgs: readonly OrgRef[] }
  | { readonly kind: 'unknown'; readonly typed: string }
  | { readonly kind: 'ambiguous'; readonly matches: readonly OrgRef[] };

/**
 * The organization to use. `--org` picks by id or name; with none typed, the only organization is not asked about
 * and several are asked.
 */
export function chooseOrg(orgs: readonly OrgRef[], typed: string | undefined): OrgChoice {
  if (typed !== undefined) {
    const matches = matchesOf(orgs, typed);
    if (matches.length === 1) return { kind: 'picked', org: matches[0] };
    return matches.length === 0 ? { kind: 'unknown', typed } : { kind: 'ambiguous', matches };
  }
  if (orgs.length === 0) return { kind: 'none' };
  return orgs.length === 1 ? { kind: 'picked', org: orgs[0] } : { kind: 'ask', orgs };
}

export type ProjectChoice =
  | { readonly kind: 'new' }
  | { readonly kind: 'existing'; readonly project: ProjectRef }
  | { readonly kind: 'ask'; readonly projects: readonly ProjectRef[] }
  | { readonly kind: 'unknown'; readonly typed: string }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ProjectRef[] };

/**
 * New project or an existing one. `--project new` and `--name` mean a new one, `--project <id|name>` an existing one.
 * With nothing typed: a new one when the organization has no projects (nothing to choose between), otherwise a question.
 */
export function chooseProject(projects: readonly ProjectRef[], answers: SetupAnswers): ProjectChoice {
  if (answers.project === NEW_PROJECT) return { kind: 'new' };
  if (answers.project !== undefined) {
    const matches = matchesOf(projects, answers.project);
    if (matches.length === 1) return { kind: 'existing', project: matches[0] };
    return matches.length === 0 ? { kind: 'unknown', typed: answers.project } : { kind: 'ambiguous', matches };
  }
  if (answers.name !== undefined || projects.length === 0) return { kind: 'new' };
  return { kind: 'ask', projects };
}

/** The answers a new project still needs: the ones not typed. */
export interface NewProjectGaps {
  readonly name: boolean;
  readonly branch: boolean;
  readonly isProtected: boolean;
}

export function newProjectGaps(answers: SetupAnswers): NewProjectGaps {
  return {
    name: answers.name === undefined,
    branch: answers.branch === undefined,
    // The terminal's setup never asks it: a new project's first branch starts open, and protection is a later action.
    // `--protected` still sets it when typed (Vincent, 2026-11-27).
    isProtected: false,
  };
}

export const hasGaps = (gaps: NewProjectGaps): boolean => gaps.name || gaps.branch || gaps.isProtected;

/** The organization choices that cannot go on. */
export type OrgBlocked = Exclude<OrgChoice, { readonly kind: 'picked' | 'ask' }>;

/** The refusal for an organization choice that cannot go on. */
export function orgChoiceProblem(choice: OrgBlocked, orgs: readonly OrgRef[]): Problem {
  if (choice.kind === 'none') return { code: ERROR_CODES.ORG_NOT_FOUND, message: 'No organizations available.' }; // COPY-FLAG
  if (choice.kind === 'unknown') {
    return { code: ERROR_CODES.ORG_NOT_FOUND, message: `No organization ${choice.typed} is available to this account.`, extra: { orgs } }; // COPY-FLAG
  }
  return {
    code: ERROR_CODES.ORG_SELECTION_REQUIRED,
    message: `More than one organization is named ${choice.matches[0].name}. Pass its id with --org.`, // COPY-FLAG
    extra: { orgs: choice.matches },
  };
}

/** The project choices that cannot go on. */
export type ProjectBlocked = Extract<ProjectChoice, { readonly kind: 'unknown' | 'ambiguous' }>;

/** The refusal for a project choice that cannot go on. */
export function projectChoiceProblem(choice: ProjectBlocked, org: OrgRef | undefined): Problem {
  if (choice.kind === 'unknown') {
    return { code: ERROR_CODES.PROJECT_NOT_FOUND, message: `No project named ${choice.typed} in this organization.`, extra: { name: choice.typed } }; // reused from project delete
  }
  return {
    code: ERROR_CODES.PROJECT_AMBIGUOUS,
    message: `More than one project is named ${choice.matches[0].name}.`, // reused from project delete
    extra: { matches: choice.matches, ...(org === undefined ? {} : { org }) },
  };
}
