/**
 * The one form bare `capy` hands the agent when it sets up a folder and questions are left (`INIT_INPUT_REQUIRED`).
 *
 * It asks only what is still unanswered, in this order: organization, project, then (for a new project) name, first
 * branch and protection. The name, branch and protection fields use the field names, wording, defaults and rules of
 * `capy project create`. `answer.rerun` is the exact command with the typed answers repeated and a `<placeholder>`
 * where an answer goes.
 */
import type { ElicitationField, ElicitationForm } from '../ui/elicitation';
import { setupDisplay } from '../ui/elicitationDisplay';
import type { SetupAnswers } from '../types/index';
import { BRANCH_DESCRIPTION, BRANCH_NAME_PATTERN_SOURCE, DEFAULT_FIRST_BRANCH, FIRST_BRANCH_QUESTION } from '../core/branchNameRule';
import { PROJECT_NAME_PATTERN_SOURCE } from '../core/projectNameRule';
import { NEW_PROJECT, type NewProjectGaps, type OrgRef, type ProjectRef } from '../core/initPlan';
import { binName } from './binName';
import { PROTECTED_NO, PROTECTED_YES, protectedQuestion } from './projectCreateCommand';

export interface SetupFormInput {
  /** The organization, when it is decided. */
  readonly org?: OrgRef;
  /** The organizations to choose between, when the organization is the question. */
  readonly orgChoices?: readonly OrgRef[];
  /** The organization's existing projects, when "which project" is a question ("new" is always one more answer). */
  readonly projects?: readonly ProjectRef[];
  /** The existing project the folder is being linked to, when one is chosen. */
  readonly existingProject?: ProjectRef;
  /** That project's branches, when "which branch" is the question. */
  readonly branchChoices?: readonly BranchChoice[];
  /** The answers a new project still needs, when it is being created and some are missing. */
  readonly gaps?: NewProjectGaps;
  /** What was typed already. */
  readonly answers: SetupAnswers;
  /** How many variables the folder's `.env` holds; 0 when it has none or there is no `.env`. */
  readonly variables: number;
  /** The name offered for a new project, when there is a sensible one. */
  readonly suggestedName?: string;
  /** `--env-path` and `--dry-run` as typed: the rerun repeats them. */
  readonly envPath?: string;
  readonly dryRun?: boolean;
  /** True under `capy-dev`, which does not set `CAPY_BIN_NAME`: the rerun then names `capy-dev`. */
  readonly devMode?: boolean;
}

/** One of an existing project's branches, as the form offers it. */
export interface BranchChoice {
  readonly name: string;
  readonly isProtected: boolean;
}

/** A regular-expression source that matches exactly one of `values`. */
function oneOf(values: readonly string[]): string {
  return `^(${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

/** A value as the shell takes it: as it is when it is plain, else in single quotes. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `--flag value` with the typed value, else with the placeholder when the flag is a question, else nothing. */
function flagWords(flag: string, typed: string | undefined, placeholder: string | undefined): readonly string[] {
  if (typed !== undefined) return [flag, shellWord(typed)];
  return placeholder === undefined ? [] : [flag, placeholder];
}

function rerunCommand(input: SetupFormInput): string {
  const { answers, gaps } = input;
  return [
    binName(input.devMode === true),
    ...flagWords('--env-path', input.envPath, undefined),
    ...(input.dryRun === true ? ['--dry-run'] : []),
    ...flagWords('--org', answers.org, input.orgChoices === undefined ? undefined : '<org>'),
    ...flagWords('--project', answers.project, input.projects === undefined ? undefined : '<project>'),
    ...flagWords('--name', answers.name, gaps?.name === true ? '<name>' : undefined),
    ...flagWords('--branch', answers.branch, gaps?.branch === true || input.branchChoices !== undefined ? '<branch>' : undefined),
    ...flagWords('--protected', answers.protectedAnswer, gaps?.isProtected === true ? '<protected>' : undefined),
    '--json',
  ].join(' ');
}

function orgField(orgs: readonly OrgRef[]): ElicitationField {
  return {
    name: 'org',
    type: 'string',
    pattern: oneOf(orgs.map((o) => o.id)),
    question: 'Select organization for project:', // the terminal's own wording
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
  };
}

function projectField(projects: readonly ProjectRef[]): ElicitationField {
  return {
    name: 'project',
    type: 'string',
    pattern: oneOf([NEW_PROJECT, ...projects.map((p) => p.id)]),
    question: 'Which project do you want to use?', // the terminal's own wording
    options: [
      { value: NEW_PROJECT, label: 'New project' }, // the terminal's own wording
      ...projects.map((p) => ({ value: p.id, label: p.name })),
    ],
  };
}

function nameField(suggestedName: string | undefined): ElicitationField {
  return {
    name: 'name',
    type: 'string',
    pattern: PROJECT_NAME_PATTERN_SOURCE,
    question: 'What should the project be called?', // COPY-FLAG: project create's wording
    ...(suggestedName === undefined ? {} : { default: suggestedName }),
  };
}

function branchField(answers: SetupAnswers): ElicitationField {
  return {
    name: 'branch',
    type: 'string',
    pattern: BRANCH_NAME_PATTERN_SOURCE,
    question: FIRST_BRANCH_QUESTION,
    default: answers.branch ?? DEFAULT_FIRST_BRANCH,
    description: BRANCH_DESCRIPTION,
  };
}

/** Which of an existing project's branches to use: a choice among them, with no default, so nothing is picked for the human. */
function existingBranchField(branches: readonly BranchChoice[]): ElicitationField {
  return {
    name: 'branch',
    type: 'string',
    pattern: oneOf(branches.map((b) => b.name)),
    question: 'Which branch do you want to use?', // the terminal's own wording
    options: branches.map((b) => ({ value: b.name, label: b.isProtected ? `${b.name} (protected)` : b.name })), // the terminal's own wording
  };
}

function protectedField(answers: SetupAnswers): ElicitationField {
  return {
    name: 'protected',
    type: 'string',
    pattern: `^(${PROTECTED_YES}|${PROTECTED_NO})$`,
    question: protectedQuestion(answers.branch),
    default: answers.protectedAnswer === PROTECTED_YES ? PROTECTED_YES : PROTECTED_NO,
    options: [
      { value: PROTECTED_YES, label: 'Yes' }, // COPY-FLAG
      { value: PROTECTED_NO, label: 'No' }, // COPY-FLAG
    ],
  };
}

function fieldsOf(input: SetupFormInput): readonly ElicitationField[] {
  const { gaps } = input;
  return [
    ...(input.orgChoices === undefined ? [] : [orgField(input.orgChoices)]),
    ...(input.projects === undefined ? [] : [projectField(input.projects)]),
    ...(input.branchChoices === undefined ? [] : [existingBranchField(input.branchChoices)]),
    ...(gaps?.name === true ? [nameField(input.suggestedName)] : []),
    ...(gaps?.branch === true ? [branchField(input.answers)] : []),
    ...(gaps?.isProtected === true ? [protectedField(input.answers)] : []),
  ];
}

/** The project cell of the summary: an existing project is not known yet; a new one is known by its typed name. */
function projectCell(input: SetupFormInput): string | undefined {
  if (input.projects !== undefined) return undefined;
  return input.existingProject?.name ?? input.answers.name;
}

export function setupForm(input: SetupFormInput): ElicitationForm {
  return {
    kind: 'form',
    question: 'How should Capy set up this folder?', // COPY-FLAG
    details: {
      ...(input.org === undefined ? {} : { org: { id: input.org.id, name: input.org.name } }),
      ...(input.orgChoices === undefined ? {} : { orgs: input.orgChoices.map((o) => ({ id: o.id, name: o.name })) }),
      ...(input.projects === undefined ? {} : { projects: input.projects.map((p) => ({ id: p.id, name: p.name })) }),
      ...(input.existingProject === undefined ? {} : { project: { id: input.existingProject.id, name: input.existingProject.name } }),
      ...(input.branchChoices === undefined ? {} : { branches: input.branchChoices.map((b) => ({ name: b.name, protected: b.isProtected })) }),
      // Only a new project needs these; with an existing project chosen they are left out.
      ...(input.projects !== undefined && input.gaps !== undefined ? { new_project_fields: fieldsOf({ ...input, orgChoices: undefined, projects: undefined }).map((f) => f.name) } : {}),
      variables: input.variables,
    },
    display: setupDisplay({
      org: input.org?.name,
      project: projectCell(input),
      branch: input.answers.branch,
      isProtected: input.answers.protectedAnswer === undefined ? undefined : input.answers.protectedAnswer === PROTECTED_YES,
      variables: input.variables,
      projectChoice: input.projects !== undefined,
      existingProject: input.existingProject !== undefined,
      branchDescription: BRANCH_DESCRIPTION,
    }),
    fields: fieldsOf(input),
    answer: { rerun: rerunCommand(input) },
  };
}
