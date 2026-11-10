/**
 * `capy project create [name]` (CAP-748).
 *
 * Creates a project in the ACTIVE organization with the same service call the init flow uses
 * (`ServiceClient.initializeProject`), then its first branch (`createBranch`), and nothing else: it does not link the
 * current folder, write a keep.lock or touch a key. Bare `capy` still does those.
 *
 * Agent mode (`--json`, `--non-tty`, or stdin that is not a terminal) never opens a prompt. With no name it refuses
 * with PROJECT_NAME_REQUIRED, and with a name but no `--branch` with BRANCH_NAME_REQUIRED (both exit 3), each with
 * an `elicitation` of kind "form" (`ui/elicitation.ts`) asking for both, that the agent puts to the human. In a
 * terminal it asks for the name with the init prompt and for the branch with the init branch question.
 *
 * Whether the first branch is protected (invite-only) is asked the way `capy checkout -b` asks it: a yes/no in a
 * terminal, and the same yes/no as a field of the elicitation (BRANCH_PROTECTION_REQUIRED when only that is missing).
 *
 * Every refusal is coded, and every decision keys on a code, an HTTP status or a typed field, never on message
 * text. The service answers a duplicate name with a bare 409 and no `code`, so the STATUS decides that one.
 */
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { PROJECT_NAME_PATTERN_SOURCE, projectNameProblem } from '../core/projectNameRule';
import { BRANCH_DESCRIPTION, BRANCH_NAME_PATTERN_SOURCE, DEFAULT_FIRST_BRANCH, FIRST_BRANCH_QUESTION, branchNameProblem } from '../core/branchNameRule';
import { PromptEngine } from '../ui/promptEngine';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import type { ElicitationForm } from '../ui/elicitation';
import { createProjectDisplay } from '../ui/elicitationDisplay';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuse, refusalFor, settle, type Refusal } from './projectLifecycleCommand';

export interface CreateProjectOpts {
  json?: boolean;
  /** `--non-tty`: treat stdin as not a terminal, so the name is never asked. */
  nonTty?: boolean;
  /** The global `--dry-run`: check the name and the organization, create nothing. */
  dryRun?: boolean;
  /** `--branch <name>`: the project's first branch. */
  branch?: string;
  /** `--protected yes|no` as typed: whether the first branch is invite-only. Checked before anything is sent. */
  protectedAnswer?: string;
  apiUrl?: string;
  devMode?: boolean;
}

/** What commander hands an action's `command`: only the merged view is needed. */
interface CommandWithGlobals {
  optsWithGlobals(): Record<string, unknown>;
}

/** The options as typed, wherever commander put them (`--non-tty` is taken by `org`, `--dry-run` by the program). */
export function createProjectOptsFrom(command: CommandWithGlobals): CreateProjectOpts {
  const merged = command.optsWithGlobals();
  return {
    // `--non-tty` is agent mode, and agent mode always answers in JSON: it means the same as `--json`.
    json: merged.json === true || merged.nonTty === true,
    nonTty: merged.nonTty === true,
    dryRun: merged.dryRun === true,
    ...(typeof merged.branch === 'string' ? { branch: merged.branch.trim() } : {}),
    ...(typeof merged.protected === 'string' ? { protectedAnswer: merged.protected.trim().toLowerCase() } : {}),
  };
}

interface OrgRef {
  readonly id: string;
  readonly name: string;
}

interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** The first branch as it will be created. */
interface FirstBranch {
  readonly name: string;
  readonly protected: boolean;
}

type CreateOutcome =
  | { readonly kind: 'needs-input'; readonly missing: 'name' | 'branch' | 'protected'; readonly elicitation: ElicitationForm; readonly org: OrgRef }
  | { readonly kind: 'exists'; readonly existing: ProjectRef; readonly org: OrgRef }
  | { readonly kind: 'dry-run'; readonly name: string; readonly branch: FirstBranch; readonly org: OrgRef }
  | { readonly kind: 'branch-failed'; readonly project: ProjectRef; readonly branch: FirstBranch; readonly org: OrgRef }
  | { readonly kind: 'created'; readonly project: ProjectRef; readonly branch: FirstBranch; readonly org: OrgRef };

/** `--protected` answers, as the elicitation's options carry them. */
const PROTECTED_YES = 'yes';
const PROTECTED_NO = 'no';

/** The answer typed with `--protected`, as a boolean; undefined when none was typed. Checked to be yes or no first. */
function protectedFrom(answer: string | undefined): boolean | undefined {
  if (answer === undefined) return undefined;
  return answer === PROTECTED_YES;
}

/** The yes/no question, worded as `capy checkout -b` asks it. Before the branch has a name it says "the first branch". */
function protectedQuestion(branch: string | undefined): string {
  return branch === undefined
    ? 'Make the first branch a protected branch? (invite-only)' // COPY-FLAG: checkout's wording, adapted for an unnamed branch
    : `Make "${branch}" a protected branch? (invite-only)`;
}

/**
 * The folder's name as a project name, when it is allowed as one and no live project in the org has it already.
 * The init prompt offers the same name; a taken one would only be refused with PROJECT_NAME_EXISTS, so it is never offered.
 */
function suggestedName(isTaken: (name: string) => boolean): string | undefined {
  const folderName = new ProjectManager().getDefaultProjectName();
  return projectNameProblem(folderName) === null && !isTaken(folderName) ? folderName : undefined;
}

/**
 * The form that asks for the name and the first branch. Both fields are always there, filled with what was already
 * given, so the human sees and confirms both. `answer.rerun` keeps `<name>` and `<branch>` as the places the answers go.
 */
function createForm(
  org: OrgRef,
  name: string | undefined,
  branch: string | undefined,
  isProtected: boolean | undefined,
  isTaken: (name: string) => boolean,
): ElicitationForm {
  const nameDefault = name ?? suggestedName(isTaken);
  return {
    kind: 'form',
    question: name === undefined
      ? 'What should the project and its first branch be called?' // COPY-FLAG
      : 'What should the first branch be called?', // COPY-FLAG
    details: { org: { id: org.id, name: org.name } },
    display: createProjectDisplay({ org, name, branch, isProtected, branchDescription: BRANCH_DESCRIPTION }),
    fields: [
      {
        name: 'name',
        type: 'string',
        pattern: PROJECT_NAME_PATTERN_SOURCE,
        question: 'What should the project be called?', // COPY-FLAG
        ...(nameDefault === undefined ? {} : { default: nameDefault }),
      },
      {
        name: 'branch',
        type: 'string',
        pattern: BRANCH_NAME_PATTERN_SOURCE,
        question: FIRST_BRANCH_QUESTION,
        default: branch ?? DEFAULT_FIRST_BRANCH,
        description: BRANCH_DESCRIPTION,
      },
      {
        name: 'protected',
        type: 'string',
        pattern: `^(${PROTECTED_YES}|${PROTECTED_NO})$`,
        question: protectedQuestion(branch),
        default: isProtected === true ? PROTECTED_YES : PROTECTED_NO,
        options: [
          { value: PROTECTED_YES, label: 'Yes' }, // COPY-FLAG
          { value: PROTECTED_NO, label: 'No' }, // COPY-FLAG
        ],
      },
    ],
    answer: { rerun: 'capy project create <name> --branch <branch> --protected <protected> --json' },
  };
}

/** The name: as typed, else (in a terminal) as asked, else none. */
async function chooseName(typed: string | undefined, agentMode: boolean): Promise<string | undefined> {
  if (typed !== undefined) return typed;
  if (agentMode) return undefined;
  return new PromptEngine().promptForProjectName(new ProjectManager().getDefaultProjectName());
}

/** The first branch: as typed, else (in a terminal) as asked, else none. */
async function chooseBranch(typed: string | undefined, agentMode: boolean): Promise<string | undefined> {
  if (typed !== undefined) return typed;
  if (agentMode) return undefined;
  return new PromptEngine().promptForFirstBranch();
}

/** Whether the first branch is protected: as typed, else (in a terminal) as asked, else none. */
async function chooseProtected(typed: boolean | undefined, branch: string, agentMode: boolean): Promise<boolean | undefined> {
  if (typed !== undefined) return typed;
  if (agentMode) return undefined;
  return new PromptEngine().promptForBranchProtected(branch);
}

/** The client calls `createFlow` makes: resolving the org hands it over already signed in. */
interface CreateClient {
  listProjects(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string; readonly organization_id: string }>>;
  initializeProject(name: string, orgId: string): Promise<{ readonly project_id: string; readonly project_name: string }>;
  createBranch(projectId: string, name: string, isProtected?: boolean): Promise<unknown>;
}

/**
 * A live project in `orgId` that already has this name, compared trimmed and ignoring case. The service itself
 * allows two projects with one name, so this check is what stops a second one (an agent retrying, a typo in case).
 * Deleted projects are not listed, so a deleted project's name can be used again.
 */
export function existingProjectNamed(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly organization_id: string }>,
  orgId: string,
  name: string,
): { readonly id: string; readonly name: string } | undefined {
  const wanted = name.trim().toLowerCase();
  const match = projects.find((p) => p.organization_id === orgId && p.name.trim().toLowerCase() === wanted);
  return match === undefined ? undefined : { id: match.id, name: match.name };
}

async function createFlow(typed: string | undefined, opts: CreateProjectOpts, agentMode: boolean): Promise<CreateOutcome> {
  // Agent mode never opens a prompt, not even to pick an organization.
  const { orgId, orgName, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true, { promptForOrg: !agentMode });
  const org: OrgRef = { id: orgId, name: orgName };

  const name = await chooseName(typed, agentMode);
  const client: CreateClient = serviceClient;
  const projects = await client.listProjects();
  const isTaken = (candidate: string) => existingProjectNamed(projects, orgId, candidate) !== undefined;
  const typedProtected = protectedFrom(opts.protectedAnswer);
  if (name === undefined) {
    return { kind: 'needs-input', missing: 'name', elicitation: createForm(org, undefined, opts.branch, typedProtected, isTaken), org };
  }

  // The clash is checked before the branch is asked, so nobody picks a branch for a project that cannot be created.
  const existing = existingProjectNamed(projects, orgId, name);
  if (existing !== undefined) return { kind: 'exists', existing, org };

  const branchName = await chooseBranch(opts.branch, agentMode);
  if (branchName === undefined) {
    return { kind: 'needs-input', missing: 'branch', elicitation: createForm(org, name, undefined, typedProtected, isTaken), org };
  }
  const isProtected = await chooseProtected(typedProtected, branchName, agentMode);
  if (isProtected === undefined) {
    return { kind: 'needs-input', missing: 'protected', elicitation: createForm(org, name, branchName, undefined, isTaken), org };
  }
  const branch: FirstBranch = { name: branchName, protected: isProtected };
  if (opts.dryRun === true) return { kind: 'dry-run', name, branch, org };

  const created = await client.initializeProject(name, orgId);
  const project: ProjectRef = { id: created.project_id, name: created.project_name };
  // The project exists from here on: a failed branch is reported with the project, never as "nothing happened".
  const branchMade = await settle(() => client.createBranch(project.id, branch.name, branch.protected));
  return branchMade.ok
    ? { kind: 'created', project, branch, org }
    : { kind: 'branch-failed', project, branch, org };
}

/** The refusal for a failed create: a duplicate name by its HTTP status, everything else as the lifecycle commands refuse it. */
function createRefusalFor(err: unknown): Refusal {
  if (err instanceof CapyError && err.code === ERROR_CODES.SERVICE_ERROR && err.details?.status === 409) {
    return {
      code: ERROR_CODES.PROJECT_NAME_EXISTS,
      message: 'This organization already has a project with that name.', // COPY-FLAG
      exitCode: 1,
    };
  }
  return refusalFor(err);
}

/** The refusal for each thing that can still be missing, with nobody to ask. */
const NEEDS_INPUT: Readonly<Record<'name' | 'branch' | 'protected', { readonly code: string; readonly message: string }>> = {
  name: {
    code: ERROR_CODES.PROJECT_NAME_REQUIRED,
    message: '`capy project create` needs a project name. Pass it as an argument, or run it in a terminal.', // COPY-FLAG
  },
  branch: {
    code: ERROR_CODES.BRANCH_NAME_REQUIRED,
    message: '`capy project create` needs a first branch. Pass it with --branch, or run it in a terminal.', // COPY-FLAG
  },
  protected: {
    code: ERROR_CODES.BRANCH_PROTECTION_REQUIRED,
    message: '`capy project create` needs to know whether the first branch is protected. Pass --protected yes or no, or run it in a terminal.', // COPY-FLAG
  },
};

/** The branch as JSON reports it. */
function branchJson(branch: FirstBranch): { readonly name: string; readonly protected: boolean } {
  return { name: branch.name, protected: branch.protected };
}

function emitCreateOutcome(json: boolean, outcome: CreateOutcome): void {
  if (outcome.kind === 'needs-input') {
    const { code, message } = NEEDS_INPUT[outcome.missing];
    return refuse(json, {
      code,
      message,
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation },
      lines: [`  Organization: ${outcome.org.name}`], // COPY-FLAG
    });
  }
  if (outcome.kind === 'branch-failed') {
    return refuse(json, {
      code: ERROR_CODES.BRANCH_CREATE_FAILED,
      message: `Created project ${outcome.project.name}, but not its first branch ${outcome.branch.name}.`, // COPY-FLAG
      exitCode: 1,
      extra: { project: outcome.project, branch: branchJson(outcome.branch), org: outcome.org },
    });
  }
  if (outcome.kind === 'exists') {
    return refuse(json, {
      code: ERROR_CODES.PROJECT_NAME_EXISTS,
      message: 'This organization already has a project with that name.', // COPY-FLAG
      exitCode: 1,
      extra: { project: outcome.existing, org: outcome.org },
      lines: [`  ${outcome.existing.id}  ${outcome.existing.name}`],
    });
  }
  if (outcome.kind === 'dry-run') {
    if (json) {
      console.log(JSON.stringify({ ok: true, dry_run: true, project: { name: outcome.name }, branch: branchJson(outcome.branch), org: outcome.org }, null, 2));
      return;
    }
    console.log(`Dry run: would create project ${outcome.name} with branch ${outcome.branch.name} in ${outcome.org.name}. Nothing was created.`); // COPY-FLAG
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, project: outcome.project, branch: branchJson(outcome.branch), org: outcome.org }, null, 2));
    return;
  }
  console.log(`Created project ${outcome.project.name} with branch ${outcome.branch.name} in ${outcome.org.name}.`); // COPY-FLAG
  if (outcome.branch.protected) console.log(`"${outcome.branch.name}" is a protected branch — access is invite-only`);
}

/** `capy project create [name] [--dry-run] [--json]` */
export async function createProjectCommand(name: string | undefined, opts: CreateProjectOpts): Promise<void> {
  const json = opts.json === true;
  const agentMode = json || !isInteractive(opts.nonTty);

  // Before any network call: a name that breaks the rule never leaves this process.
  const problem = name === undefined ? null : projectNameProblem(name);
  if (problem !== null) {
    return refuse(json, {
      code: problem.code,
      message: problem.message,
      exitCode: 1,
      extra: problem.code === ERROR_CODES.PROJECT_NAME_INVALID ? { pattern: PROJECT_NAME_PATTERN_SOURCE } : undefined,
    });
  }

  const branchProblem = opts.branch === undefined ? null : branchNameProblem(opts.branch);
  if (branchProblem !== null) {
    return refuse(json, {
      code: branchProblem.code,
      message: branchProblem.message,
      exitCode: 1,
      extra: { pattern: BRANCH_NAME_PATTERN_SOURCE },
    });
  }

  if (opts.protectedAnswer !== undefined && opts.protectedAnswer !== PROTECTED_YES && opts.protectedAnswer !== PROTECTED_NO) {
    return refuse(json, {
      code: ERROR_CODES.BRANCH_PROTECTION_INVALID,
      message: '--protected takes yes or no.', // COPY-FLAG
      exitCode: 1,
      extra: { options: [PROTECTED_YES, PROTECTED_NO] },
    });
  }

  // A dry run asks nothing, and in a terminal the only thing left to do without a name, branch or protection is ask.
  const missingSomething = name === undefined || opts.branch === undefined || opts.protectedAnswer === undefined;
  if (opts.dryRun === true && missingSomething && !agentMode) {
    return refuse(json, {
      code: ERROR_CODES.DRY_RUN_UNSUPPORTED,
      message: '`capy project create` would ask for the name, branch or protection, so it cannot preview. Pass all three.', // COPY-FLAG
      exitCode: 1,
    });
  }

  const settled = await settle(() => createFlow(name, opts, agentMode));
  if (!settled.ok) return refuse(json, createRefusalFor(settled.error));
  emitCreateOutcome(json, settled.value);
}
