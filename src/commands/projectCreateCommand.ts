/**
 * `capy org create-project [name]` (CAP-748).
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
 * Every refusal is coded, and every decision keys on a code, an HTTP status or a typed field, never on message
 * text. The service answers a duplicate name with a bare 409 and no `code`, so the STATUS decides that one.
 */
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { PROJECT_NAME_PATTERN_SOURCE, projectNameProblem } from '../core/projectNameRule';
import { BRANCH_DESCRIPTION, BRANCH_NAME_PATTERN_SOURCE, DEFAULT_FIRST_BRANCH, branchNameProblem } from '../core/branchNameRule';
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
    json: merged.json === true,
    nonTty: merged.nonTty === true,
    dryRun: merged.dryRun === true,
    ...(typeof merged.branch === 'string' ? { branch: merged.branch.trim() } : {}),
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

type CreateOutcome =
  | { readonly kind: 'needs-input'; readonly missing: 'name' | 'branch'; readonly elicitation: ElicitationForm; readonly org: OrgRef }
  | { readonly kind: 'exists'; readonly existing: ProjectRef; readonly org: OrgRef }
  | { readonly kind: 'dry-run'; readonly name: string; readonly branch: string; readonly org: OrgRef }
  | { readonly kind: 'branch-failed'; readonly project: ProjectRef; readonly branch: string; readonly org: OrgRef }
  | { readonly kind: 'created'; readonly project: ProjectRef; readonly branch: string; readonly org: OrgRef };

/** The folder's name as a project name, when it is allowed as one. The init prompt offers the same. */
function suggestedName(): string | undefined {
  const folderName = new ProjectManager().getDefaultProjectName();
  return projectNameProblem(folderName) === null ? folderName : undefined;
}

/**
 * The form that asks for the name and the first branch. Both fields are always there, filled with what was already
 * given, so the human sees and confirms both. `answer.rerun` keeps `<name>` and `<branch>` as the places the answers go.
 */
function createForm(org: OrgRef, name: string | undefined, branch: string | undefined): ElicitationForm {
  const nameDefault = name ?? suggestedName();
  return {
    kind: 'form',
    question: name === undefined
      ? 'What should the project and its first branch be called?' // COPY-FLAG
      : 'What should the first branch be called?', // COPY-FLAG
    details: { org: { id: org.id, name: org.name } },
    display: createProjectDisplay({ org, name, branch, branchDescription: BRANCH_DESCRIPTION }),
    fields: [
      {
        name: 'name',
        type: 'string',
        pattern: PROJECT_NAME_PATTERN_SOURCE,
        ...(nameDefault === undefined ? {} : { default: nameDefault }),
      },
      {
        name: 'branch',
        type: 'string',
        pattern: BRANCH_NAME_PATTERN_SOURCE,
        default: branch ?? DEFAULT_FIRST_BRANCH,
        description: BRANCH_DESCRIPTION,
      },
    ],
    answer: { rerun: 'capy org create-project <name> --branch <branch> --json' },
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
  if (name === undefined) {
    return { kind: 'needs-input', missing: 'name', elicitation: createForm(org, undefined, opts.branch), org };
  }

  // The clash is checked before the branch is asked, so nobody picks a branch for a project that cannot be created.
  const client: CreateClient = serviceClient;
  const existing = existingProjectNamed(await client.listProjects(), orgId, name);
  if (existing !== undefined) return { kind: 'exists', existing, org };

  const branch = await chooseBranch(opts.branch, agentMode);
  if (branch === undefined) {
    return { kind: 'needs-input', missing: 'branch', elicitation: createForm(org, name, undefined), org };
  }
  if (opts.dryRun === true) return { kind: 'dry-run', name, branch, org };

  const created = await client.initializeProject(name, orgId);
  const project: ProjectRef = { id: created.project_id, name: created.project_name };
  // The project exists from here on: a failed branch is reported with the project, never as "nothing happened".
  const branchMade = await settle(() => client.createBranch(project.id, branch, false));
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

function emitCreateOutcome(json: boolean, outcome: CreateOutcome): void {
  if (outcome.kind === 'needs-input') {
    return refuse(json, {
      code: outcome.missing === 'name' ? ERROR_CODES.PROJECT_NAME_REQUIRED : ERROR_CODES.BRANCH_NAME_REQUIRED,
      message: outcome.missing === 'name'
        ? '`capy org create-project` needs a project name. Pass it as an argument, or run it in a terminal.' // COPY-FLAG
        : '`capy org create-project` needs a first branch. Pass it with --branch, or run it in a terminal.', // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation },
      lines: [`  Organization: ${outcome.org.name}`], // COPY-FLAG
    });
  }
  if (outcome.kind === 'branch-failed') {
    return refuse(json, {
      code: ERROR_CODES.BRANCH_CREATE_FAILED,
      message: `Created project ${outcome.project.name}, but not its first branch ${outcome.branch}.`, // COPY-FLAG
      exitCode: 1,
      extra: { project: outcome.project, branch: { name: outcome.branch }, org: outcome.org },
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
      console.log(JSON.stringify({ ok: true, dry_run: true, project: { name: outcome.name }, branch: { name: outcome.branch }, org: outcome.org }, null, 2));
      return;
    }
    console.log(`Dry run: would create project ${outcome.name} with branch ${outcome.branch} in ${outcome.org.name}. Nothing was created.`); // COPY-FLAG
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, project: outcome.project, branch: { name: outcome.branch }, org: outcome.org }, null, 2));
    return;
  }
  console.log(`Created project ${outcome.project.name} with branch ${outcome.branch} in ${outcome.org.name}.`); // COPY-FLAG
}

/** `capy org create-project [name] [--dry-run] [--json]` */
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

  // A dry run asks nothing, and in a terminal the only thing left to do without a name or branch is ask.
  if (opts.dryRun === true && (name === undefined || opts.branch === undefined) && !agentMode) {
    return refuse(json, {
      code: ERROR_CODES.DRY_RUN_UNSUPPORTED,
      message: '`capy org create-project` would ask for the name or branch, so it cannot preview. Pass both.', // COPY-FLAG
      exitCode: 1,
    });
  }

  const settled = await settle(() => createFlow(name, opts, agentMode));
  if (!settled.ok) return refuse(json, createRefusalFor(settled.error));
  emitCreateOutcome(json, settled.value);
}
