/**
 * The one form bare `capy` hands the agent when it sets up a folder and questions are left (`INIT_INPUT_REQUIRED`).
 *
 * It asks only what is still unanswered, in this order: organization, project, then (for a new project) name, first
 * branch and protection. The name, branch and protection fields use the field names, wording, defaults and rules of
 * `capy project create`. `answer.rerun` is the exact command with the typed answers repeated and a `<placeholder>`
 * where an answer goes.
 */
import type { ElicitationField, ElicitationForm } from '../ui/elicitation';
import { SETUP_SHARING_QUESTION, SHARE_CHOICE, THIS_FOLDER_CHOICE, FOLDER_QUESTION } from '../ui/projectSetup';
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
  /** When "which folder" is the question (no `--folder` was typed): this folder and the subfolders offered. Asked alone. */
  readonly folderChoices?: FolderChoices;
  /** The folder being set up, as its full path (shown in the table). */
  readonly folder?: string;
  /** True inside a git repository, where keep.lock can be shared; with `askShare` false the answer is `answers.shareAnswer`. */
  readonly inGit?: boolean;
  /** When the terminal's encrypt confirm is the question: a new project, a `.env` with variables, no `--encrypt-env`. */
  readonly askEncrypt?: EncryptQuestion;
  /** True when "keep this setup to the folder, or share it through Git" is a question (a git repository, no `--share-setup`). */
  readonly askShare?: boolean;
}

/** The folder question's choices: this folder (its full path) and up to two subfolders, by their names. */
export interface FolderChoices {
  readonly here: string;
  readonly subfolders: readonly string[];
}

/** What the encrypt confirm names: asked once the project's name and first branch are known, as the terminal asks it. */
export interface EncryptQuestion {
  readonly variables: number;
  readonly project: string;
  readonly org: string;
  readonly branch: string;
}

/** The answers `--share-setup` takes. */
export const SHARE_YES = 'yes';
export const SHARE_NO = 'no';

/** A typed folder: a relative or absolute path with only characters that are safe in a shell word. */
export const FOLDER_PATTERN_SOURCE = '^[A-Za-z0-9_@%+=:,./~-]+$';

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
export function shellWord(value: string): string {
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
    ...flagWords('--folder', answers.folder, input.folderChoices === undefined ? undefined : '<folder>'),
    ...flagWords('--env-path', input.envPath, undefined),
    ...(input.dryRun === true ? ['--dry-run'] : []),
    ...flagWords('--org', answers.org, input.orgChoices === undefined ? undefined : '<org>'),
    ...flagWords('--project', answers.project, input.projects === undefined ? undefined : '<project>'),
    ...flagWords('--name', answers.name, gaps?.name === true ? '<name>' : undefined),
    ...flagWords('--branch', answers.branch, gaps?.branch === true || input.branchChoices !== undefined ? '<branch>' : undefined),
    ...flagWords('--protected', answers.protectedAnswer, gaps?.isProtected === true ? '<protected>' : undefined),
    ...flagWords('--share-setup', answers.shareAnswer, input.askShare === true ? '<share>' : undefined),
    ...flagWords('--encrypt-env', answers.encryptAnswer, input.askEncrypt === undefined ? undefined : '<encrypt>'),
    '--json',
  ].join(' ');
}

function orgField(orgs: readonly OrgRef[]): ElicitationField {
  return {
    name: 'org',
    type: 'string',
    pattern: oneOf(orgs.map((o) => o.id)),
    question: 'Select organization for project:', // the terminal's own wording
    description: 'The organization this folder\'s project belongs to.', // COPY-FLAG: spec 3l
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
  };
}

function projectField(projects: readonly ProjectRef[], variables: number): ElicitationField {
  return {
    name: 'project',
    type: 'string',
    pattern: oneOf([NEW_PROJECT, ...projects.map((p) => p.id)]),
    question: 'Which project do you want to use?', // the terminal's own wording
    description: 'The Capy project this folder links to.', // COPY-FLAG: spec 3l
    options: [
      {
        value: NEW_PROJECT,
        label: 'New project', // the terminal's own wording
        description: variables > 0 ? 'Import this folder\'s .env into a new project' : 'Start a new project for this folder', // COPY-FLAG
      },
      ...projects.map((p) => ({
        value: p.id,
        label: p.name,
        description: variables > 0 ? 'Link this folder to it. Its secrets replace this .env, and a copy of the old one is kept' : 'Link this folder to it', // COPY-FLAG
      })),
    ],
  };
}

function nameField(suggestedName: string | undefined): ElicitationField {
  return {
    name: 'name',
    type: 'string',
    pattern: PROJECT_NAME_PATTERN_SOURCE,
    question: 'What should the project be called?', // COPY-FLAG: project create's wording
    description: 'The name your team sees in Keep. It can be renamed later.', // COPY-FLAG: spec 3l
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
    description: 'The branch this folder reads its secrets from.', // COPY-FLAG: spec 3l
    options: branches.map((b) => ({
      value: b.name,
      label: b.isProtected ? `${b.name} (protected)` : b.name, // the terminal's own wording
      description: b.isProtected ? 'Invite-only: only people added to the branch can use its secrets' : 'Everyone on the project can use its secrets', // COPY-FLAG
    })),
  };
}

function protectedField(answers: SetupAnswers): ElicitationField {
  return {
    name: 'protected',
    type: 'string',
    pattern: `^(${PROTECTED_YES}|${PROTECTED_NO})$`,
    question: protectedQuestion(answers.branch),
    default: answers.protectedAnswer === PROTECTED_YES ? PROTECTED_YES : PROTECTED_NO,
    description: 'A protected branch is invite-only: only people added to the branch can read or change its secrets.', // COPY-FLAG: spec 3l
    options: [
      { value: PROTECTED_YES, label: 'Yes', description: 'Invite-only. Only people you add to the branch can use its secrets' }, // COPY-FLAG
      { value: PROTECTED_NO, label: 'No', description: 'Everyone on the project can use its secrets' }, // COPY-FLAG
    ],
  };
}

/**
 * Which folder to set up, as the terminal's folder picker asks it: this folder, the subfolders that look like a
 * project, or a path the human types. A typed path is checked on the rerun (`--folder` must be an existing folder).
 */
function folderField(choices: FolderChoices): ElicitationField {
  return {
    name: 'folder',
    type: 'string',
    pattern: FOLDER_PATTERN_SOURCE,
    question: FOLDER_QUESTION,
    description: 'Capy sets up the folder you choose: its .env, and keep.lock.', // COPY-FLAG
    options: [
      { value: '.', label: THIS_FOLDER_CHOICE, description: choices.here },
      ...choices.subfolders.map((name) => ({ value: name, label: `${name}/`, description: 'Holds a .env or a package file' })), // COPY-FLAG
    ],
    other: true,
  };
}

/** Keepless (this folder only) or shared through Git: the terminal's question, choices and descriptions, word for word. */
function shareField(): ElicitationField {
  return {
    name: 'share',
    type: 'string',
    pattern: `^(${SHARE_YES}|${SHARE_NO})$`,
    question: SETUP_SHARING_QUESTION,
    description: 'Whether keep.lock, which names this folder\'s Capy project, is committed to Git.', // COPY-FLAG
    options: [
      { value: SHARE_NO, label: SHARE_CHOICE.folderOnly.label, description: SHARE_CHOICE.folderOnly.description },
      { value: SHARE_YES, label: SHARE_CHOICE.shared.label, description: SHARE_CHOICE.shared.description },
    ],
  };
}

/** The terminal's confirm before a new project encrypts the `.env` and pushes it; No creates nothing. */
function encryptField(q: EncryptQuestion): ElicitationField {
  const secrets = `${q.variables} secrets`; // the terminal's own wording, whatever the count
  return {
    name: 'encrypt',
    type: 'string',
    pattern: `^(${SHARE_YES}|${SHARE_NO})$`,
    question: `Encrypt these ${secrets} and push to ${q.project} (${q.org}) on ${q.branch}?`, // COPY-FLAG: the terminal's wording
    description: 'After this the .env holds ciphertext, so check this is the right project first.', // COPY-FLAG
    options: [
      { value: SHARE_YES, label: 'Yes', description: `Create ${q.project}, encrypt the .env and push its ${secrets}` }, // COPY-FLAG
      { value: SHARE_NO, label: 'No', description: 'Nothing is created and the .env is not changed' }, // COPY-FLAG
    ],
  };
}

function fieldsOf(input: SetupFormInput): readonly ElicitationField[] {
  const { gaps } = input;
  // The folder decides everything after it (its .env, whether it is in Git), so it is asked alone.
  if (input.folderChoices !== undefined) return [folderField(input.folderChoices)];
  return [
    ...(input.orgChoices === undefined ? [] : [orgField(input.orgChoices)]),
    ...(input.projects === undefined ? [] : [projectField(input.projects, input.variables)]),
    ...(input.branchChoices === undefined ? [] : [existingBranchField(input.branchChoices)]),
    ...(gaps?.name === true ? [nameField(input.suggestedName)] : []),
    ...(gaps?.branch === true ? [branchField(input.answers)] : []),
    ...(gaps?.isProtected === true ? [protectedField(input.answers)] : []),
    ...(input.askShare === true ? [shareField()] : []),
    ...(input.askEncrypt === undefined ? [] : [encryptField(input.askEncrypt)]),
  ];
}

/** The project cell of the summary: an existing project is not known yet; a new one is known by its typed name. */
function projectCell(input: SetupFormInput): string | undefined {
  if (input.projects !== undefined) return undefined;
  return input.existingProject?.name ?? input.answers.name;
}

/** The table's sharing row: still to choose, or the answer typed; none outside Git or while the folder is the question. */
function sharingCell(input: SetupFormInput): { readonly sharing?: 'ask' | 'shared' | 'folder-only' } {
  if (input.folderChoices !== undefined || input.inGit !== true) return {};
  if (input.askShare === true) return { sharing: 'ask' };
  return { sharing: input.answers.shareAnswer === SHARE_YES ? 'shared' : 'folder-only' };
}

export function setupForm(input: SetupFormInput): ElicitationForm {
  return {
    kind: 'form',
    question: 'How should Capy set up this folder?', // COPY-FLAG
    details: {
      ...(input.folderChoices === undefined ? {} : { folder: { here: input.folderChoices.here, subfolders: input.folderChoices.subfolders } }),
      ...(input.org === undefined ? {} : { org: { id: input.org.id, name: input.org.name } }),
      ...(input.orgChoices === undefined ? {} : { orgs: input.orgChoices.map((o) => ({ id: o.id, name: o.name })) }),
      ...(input.projects === undefined ? {} : { projects: input.projects.map((p) => ({ id: p.id, name: p.name })) }),
      ...(input.existingProject === undefined ? {} : { project: { id: input.existingProject.id, name: input.existingProject.name } }),
      ...(input.branchChoices === undefined ? {} : { branches: input.branchChoices.map((b) => ({ name: b.name, protected: b.isProtected })) }),
      // Only a new project needs these; with an existing project chosen they are left out.
      ...(input.projects !== undefined && input.gaps !== undefined ? { new_project_fields: fieldsOf({ ...input, orgChoices: undefined, projects: undefined, askShare: false, askEncrypt: undefined }).map((f) => f.name) } : {}),
      variables: input.variables,
    },
    display: setupDisplay({
      org: input.org?.name,
      project: projectCell(input),
      branch: input.answers.branch,
      // Setup never asks protection: without --protected the first branch starts open, so the table says No, not "to choose".
      isProtected: input.answers.protectedAnswer === PROTECTED_YES,
      variables: input.variables,
      projectChoice: input.projects !== undefined,
      existingProject: input.existingProject !== undefined,
      firstBranchOfExisting: input.existingProject !== undefined && input.gaps?.branch === true,
      branchDescription: BRANCH_DESCRIPTION,
      ...(input.folderChoices === undefined ? { folder: input.folder } : {}),
      ...sharingCell(input),
    }),
    fields: fieldsOf(input),
    answer: { rerun: rerunCommand(input) },
  };
}
