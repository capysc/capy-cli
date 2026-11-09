/**
 * `capy org create-project [name]` (CAP-748).
 *
 * Creates a project in the ACTIVE organization with the same service call the init flow uses
 * (`ServiceClient.initializeProject`), and nothing else: it does not link the current folder, write a keep.lock,
 * make a branch or touch a key. Bare `capy` still does those.
 *
 * Agent mode (`--json`, `--non-tty`, or stdin that is not a terminal) never opens a prompt. With no name it refuses
 * with PROJECT_NAME_REQUIRED (exit 3) and an `elicitation` of kind "form" (`ui/elicitation.ts`) that the agent puts
 * to the human. In a terminal it asks for the name with the init prompt.
 *
 * Every refusal is coded, and every decision keys on a code, an HTTP status or a typed field, never on message
 * text. The service answers a duplicate name with a bare 409 and no `code`, so the STATUS decides that one.
 */
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { PROJECT_NAME_PATTERN_SOURCE, projectNameProblem } from '../core/projectNameRule';
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
  };
}

interface OrgRef {
  readonly id: string;
  readonly name: string;
}

type CreateOutcome =
  | { readonly kind: 'needs-name'; readonly elicitation: ElicitationForm; readonly org: OrgRef }
  | { readonly kind: 'dry-run'; readonly name: string; readonly org: OrgRef }
  | { readonly kind: 'created'; readonly project: { readonly id: string; readonly name: string }; readonly org: OrgRef };

/** The folder's name as a project name, when it is allowed as one. The init prompt offers the same. */
function suggestedName(): string | undefined {
  const folderName = new ProjectManager().getDefaultProjectName();
  return projectNameProblem(folderName) === null ? folderName : undefined;
}

/** The form that asks for the name. `answer.rerun` keeps `<name>` as the place the answer goes. */
function nameForm(org: OrgRef): ElicitationForm {
  const suggestion = suggestedName();
  return {
    kind: 'form',
    question: 'What should the project be called?', // COPY-FLAG
    details: { org: { id: org.id, name: org.name } },
    display: createProjectDisplay(org),
    fields: [{
      name: 'name',
      type: 'string',
      pattern: PROJECT_NAME_PATTERN_SOURCE,
      ...(suggestion === undefined ? {} : { default: suggestion }),
    }],
    answer: { rerun: 'capy org create-project <name> --json' },
  };
}

/** The name: as typed, else (in a terminal) as asked, else none. */
async function chooseName(typed: string | undefined, agentMode: boolean): Promise<string | undefined> {
  if (typed !== undefined) return typed;
  if (agentMode) return undefined;
  return new PromptEngine().promptForProjectName(new ProjectManager().getDefaultProjectName());
}

async function createFlow(typed: string | undefined, opts: CreateProjectOpts, agentMode: boolean): Promise<CreateOutcome> {
  // Agent mode never opens a prompt, not even to pick an organization.
  const { orgId, orgName, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true, { promptForOrg: !agentMode });
  const org: OrgRef = { id: orgId, name: orgName };

  const name = await chooseName(typed, agentMode);
  if (name === undefined) return { kind: 'needs-name', elicitation: nameForm(org), org };
  if (opts.dryRun === true) return { kind: 'dry-run', name, org };

  const created = await serviceClient.initializeProject(name, orgId);
  return { kind: 'created', project: { id: created.project_id, name: created.project_name }, org };
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
  if (outcome.kind === 'needs-name') {
    return refuse(json, {
      code: ERROR_CODES.PROJECT_NAME_REQUIRED,
      message: '`capy org create-project` needs a project name. Pass it as an argument, or run it in a terminal.', // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation },
      lines: [`  Organization: ${outcome.org.name}`], // COPY-FLAG
    });
  }
  if (outcome.kind === 'dry-run') {
    if (json) {
      console.log(JSON.stringify({ ok: true, dry_run: true, project: { name: outcome.name }, org: outcome.org }, null, 2));
      return;
    }
    console.log(`Dry run: would create project ${outcome.name} in ${outcome.org.name}. Nothing was created.`); // COPY-FLAG
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, project: outcome.project, org: outcome.org }, null, 2));
    return;
  }
  console.log(`Created project ${outcome.project.name} in ${outcome.org.name}.`); // COPY-FLAG
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

  // A dry run asks nothing, and in a terminal the only thing left to do without a name is ask.
  if (opts.dryRun === true && name === undefined && !agentMode) {
    return refuse(json, {
      code: ERROR_CODES.DRY_RUN_UNSUPPORTED,
      message: '`capy org create-project` would ask for the name, so it cannot preview. Pass the name.', // COPY-FLAG
      exitCode: 1,
    });
  }

  const settled = await settle(() => createFlow(name, opts, agentMode));
  if (!settled.ok) return refuse(json, createRefusalFor(settled.error));
  emitCreateOutcome(json, settled.value);
}
