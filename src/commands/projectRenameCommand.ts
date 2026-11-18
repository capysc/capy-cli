/**
 * `capy projects rename [new-name]`.
 *
 * Renames the project of the current folder (the one its keep.lock names) in the organization the keep.lock
 * belongs to, then sets `project_name` in this folder's keep.lock copies. The service decides who may rename, which
 * names are taken and which projects cannot be renamed; this file checks the name's shape before anything is sent,
 * calls the service, and only after the service has said yes rewrites the file. A refusal leaves keep.lock as it was.
 *
 * It never prompts. With no name it refuses with PROJECT_NAME_REQUIRED (exit 3) and an `elicitation` of kind "form"
 * (`ui/elicitation.ts`), offering as the default the monorepo name for this folder when that name is allowed, free
 * and different from the current one. The caller (an agent) picks the name; nothing here forces one.
 *
 * `--json` (or `--non-tty`) is the machine contract: pure JSON on stdout, a stable `code` on every refusal. Every
 * decision keys on a code, an HTTP status or a typed field, never on message text.
 *
 * `--dry-run` reads the project list to say what would change and sends nothing that writes; the service has no
 * dry run, so the PATCH is simply never sent, and no file is touched.
 *
 * `--project <name-or-id>` renames that project of the active organization instead, from any folder, the way
 * `capy project delete` finds one (an id wins over a name; several with one name is PROJECT_AMBIGUOUS, exit 3, with a
 * pick-one `elicitation`). keep.lock is rewritten only when this folder's keep.lock names that same project;
 * otherwise no file is touched.
 */
import { relative } from 'path';
import { resolveOrgContext } from '../core/orgContext';
import { ProjectManager } from '../core/projectManager';
import { PROJECT_RENAME_PATTERN_SOURCE, renameNameProblem } from '../core/projectRenameRule';
import { FileManager } from '../files/fileManager';
import { isGitRepo, originRemoteUrl, repoRelPath } from '../deploy/git';
import { defaultDiscoveryProjectName, parseGitRemoteUrl } from './connectors/dokployDiscovery';
import { existingProjectNamed } from './projectCreateCommand';
import { choiceRefusal, pickProject, refuse, refusalFor, resolveRef, settle, type DeleteDetailsClient, type Refusal } from './projectLifecycleCommand';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import type { ElicitationForm } from '../ui/elicitation';
import { renameProjectDisplay } from '../ui/elicitationDisplay';
import { CapyError, ERROR_CODES } from '../types/index';

export interface RenameProjectOpts {
  json?: boolean;
  /** `--non-tty`: same as `--json` (agent mode always answers in JSON). */
  nonTty?: boolean;
  /** The global `--dry-run`: say what would change, change nothing. */
  dryRun?: boolean;
  /** `--project <name-or-id>`: the project to rename, instead of the one this folder's keep.lock names. */
  project?: string;
  apiUrl?: string;
  devMode?: boolean;
}

/** What commander hands an action's `command`: only the merged view is needed. */
interface CommandWithGlobals {
  optsWithGlobals(): Record<string, unknown>;
}

/** The options as typed, wherever commander put them (`--non-tty` is taken by `org`, `--dry-run` by the program). */
export function renameProjectOptsFrom(command: CommandWithGlobals): RenameProjectOpts {
  const merged = command.optsWithGlobals();
  return {
    json: merged.json === true || merged.nonTty === true,
    nonTty: merged.nonTty === true,
    dryRun: merged.dryRun === true,
    project: typeof merged.project === 'string' ? merged.project : undefined,
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

/** The project this folder's keep.lock names. */
interface FolderProject extends ProjectRef {
  readonly orgId: string;
}

type RenameOutcome =
  | { readonly kind: 'needs-choice'; readonly refusal: Refusal }
  | { readonly kind: 'needs-input'; readonly project: ProjectRef; readonly org: OrgRef; readonly elicitation: ElicitationForm; readonly suggestion: string | undefined }
  | { readonly kind: 'exists'; readonly existing: ProjectRef; readonly org: OrgRef }
  | { readonly kind: 'not-found'; readonly project: ProjectRef }
  | { readonly kind: 'dry-run'; readonly project: ProjectRef; readonly name: string; readonly org: OrgRef; readonly files: readonly string[] }
  | { readonly kind: 'renamed'; readonly project: ProjectRef; readonly previousName: string; readonly changed: boolean; readonly org: OrgRef; readonly files: readonly string[] }
  | { readonly kind: 'local-failed'; readonly project: ProjectRef; readonly previousName: string; readonly org: OrgRef };

/** What commands print for a path in this folder: relative to it. */
const shownPaths = (paths: readonly string[]): readonly string[] => paths.map((p) => relative(process.cwd(), p));

/** The project this folder's keep.lock names, or null when the folder has no keep.lock. */
async function readFolderProject(): Promise<FolderProject | null> {
  const state = await new ProjectManager().detectProjectState();
  if (!state.hasKeepFile || state.projectId === undefined || state.organizationId === undefined) return null;
  return { id: state.projectId, name: state.projectName ?? state.projectId, orgId: state.organizationId };
}

/**
 * The monorepo name for this folder (`<repo>/<folder path from the git root>`, or just `<repo>` at the root), the way
 * discovery names it; undefined when this is not a git repo, or the name is not an allowed one, is taken by another
 * live project in the org, or is the name the project already has.
 */
export function suggestedRenameName(
  cwd: string,
  currentName: string,
  isTaken: (name: string) => boolean,
): string | undefined {
  if (!isGitRepo(cwd)) return undefined;
  const origin = originRemoteUrl(cwd);
  const remote = origin === null ? null : parseGitRemoteUrl(origin);
  const folder = repoRelPath(cwd, '').replace(/\/+$/, '');
  const candidate = defaultDiscoveryProjectName(cwd, folder, remote);
  const usable = renameNameProblem(candidate) === null && candidate !== currentName && !isTaken(candidate);
  return usable ? candidate : undefined;
}

/** The form that asks for the new name, with the suggestion (when there is one) as the default. */
function renameForm(org: OrgRef, project: ProjectRef, suggestion: string | undefined, rerun: string): ElicitationForm {
  return {
    kind: 'form',
    question: 'What should the project be renamed to?', // COPY-FLAG
    details: { org: { id: org.id, name: org.name }, project: { id: project.id, name: project.name } },
    display: renameProjectDisplay({ org, project, suggestion }),
    fields: [{
      name: 'name',
      type: 'string',
      pattern: PROJECT_RENAME_PATTERN_SOURCE,
      question: 'What should the project be called?', // COPY-FLAG
      ...(suggestion === undefined ? {} : { default: suggestion }),
    }],
    answer: { rerun },
  };
}

/** The client calls the flow makes: resolving the org hands it over already signed in. */
interface RenameClient extends DeleteDetailsClient {
  listProjects(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string; readonly organization_id: string }>>;
  /** What the service answered, unchecked: `renamedProjectOf` says whether it can be used. */
  renameProject(orgId: string, projectId: string, name: string): Promise<unknown>;
}

/** The renamed project of a 200 answer, or null when the answer does not carry this project's id and name. */
function renamedProjectOf(answer: unknown, projectId: string): ProjectRef | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const project: unknown = (answer as { project?: unknown }).project;
  if (typeof project !== 'object' || project === null) return null;
  const { id, name } = project as { id?: unknown; name?: unknown };
  if (id !== projectId || typeof name !== 'string') return null;
  return name === '' ? null : { id, name };
}

/** The service answered 200 with something that is not the renamed project (or not JSON). Nothing is claimed about the rename. */
function badServiceAnswer(): CapyError {
  return new CapyError(
    'The service answered, but not with the renamed project.', // COPY-FLAG
    ERROR_CODES.SERVICE_ERROR,
    { status: 200, reason: 'unusable_response' },
  );
}

/** The optional fields of a usable answer: `changed` is true only when the service says so, `previous_name` only when it is text. */
function answerExtras(answer: unknown): { readonly changed: boolean; readonly previousName: string | undefined } {
  const { changed, previous_name: previous } = answer as { changed?: unknown; previous_name?: unknown };
  return { changed: changed === true, previousName: typeof previous === 'string' ? previous : undefined };
}

/** The live projects of the org other than the one being renamed. */
function othersIn(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly organization_id: string }>,
  projectId: string,
) {
  return projects.filter((p) => p.id !== projectId);
}

type RenameTarget =
  | { readonly kind: 'picked'; readonly project: ProjectRef }
  | { readonly kind: 'needs-choice'; readonly refusal: Refusal };

/** The command that answers a pick between projects of one name, with `<project>` where the chosen id goes. */
function chooseRerun(typed: string | undefined): string {
  return typed === undefined ? 'capy projects rename --project <project> --json' : `capy projects rename ${typed} --project <project> --json`;
}

/**
 * The project to rename: the folder's own, or the one `--project` names in this organization. Several projects with
 * that name is never guessed and never asked in a prompt: the choice goes back as PROJECT_AMBIGUOUS.
 */
async function renameTarget(
  named: string | undefined,
  folder: FolderProject | null,
  typed: string | undefined,
  org: OrgRef,
  client: RenameClient,
): Promise<RenameTarget> {
  if (named === undefined) {
    if (folder === null) throw new CapyError('This folder has no keep.lock.', ERROR_CODES.NO_KEEP_FILE); // COPY-FLAG
    return { kind: 'picked', project: { id: folder.id, name: folder.name } };
  }
  const inOrg = (await client.listProjects()).filter((p) => p.organization_id === org.id);
  const picked = await pickProject(resolveRef(inOrg, named, false), { json: true, agentMode: true, org, ref: named, client, rerun: chooseRerun(typed) });
  if (picked.kind === 'needs-choice') return { kind: 'needs-choice', refusal: choiceRefusal(picked, named) };
  return { kind: 'picked', project: { id: picked.project.id, name: picked.project.name } };
}

async function renameFlow(typed: string | undefined, folder: FolderProject | null, opts: RenameProjectOpts): Promise<RenameOutcome> {
  const named = opts.project;
  // Before any network call: every keep.lock copy must be one that can be rewritten, or nothing is renamed.
  const planned = typed === undefined || named !== undefined ? [] : new FileManager().planKeepProjectName(typed);

  // The folder's own org wins inside resolveOrgContext; nothing is ever asked.
  const { orgId, orgName, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true, { promptForOrg: false });
  const org: OrgRef = { id: orgId, name: orgName };
  const client: RenameClient = serviceClient;
  const target = await renameTarget(named, folder, typed, org, client);
  if (target.kind === 'needs-choice') return { kind: 'needs-choice', refusal: target.refusal };
  const project = target.project;
  // Only this folder's own project has a keep.lock here to follow the new name.
  const inFolder = folder !== null && folder.id === project.id;

  if (typed === undefined) {
    if (named !== undefined) {
      return { kind: 'needs-input', project, org, elicitation: renameForm(org, project, undefined, `capy projects rename <name> --project ${project.id} --json`), suggestion: undefined };
    }
    const projects = othersIn(await client.listProjects(), project.id);
    const suggestion = suggestedRenameName(process.cwd(), project.name, (n) => existingProjectNamed(projects, orgId, n) !== undefined);
    return { kind: 'needs-input', project, org, elicitation: renameForm(org, project, suggestion, 'capy projects rename <name> --json'), suggestion };
  }

  // With `--project`, the same check as above, now that the project is known to be this folder's.
  const rewrites = named !== undefined && inFolder ? new FileManager().planKeepProjectName(typed) : planned;

  if (opts.dryRun === true) return dryRunOutcome(typed, project, org, client, shownPaths(rewrites.map((p) => p.path)));

  const sent = await settle(() => client.renameProject(orgId, project.id, typed));
  // An answer that is not JSON is as unusable as one without the project: it is neither a rename nor a refusal.
  if (!sent.ok) throw sent.error instanceof CapyError ? sent.error : badServiceAnswer();
  const renamed = renamedProjectOf(sent.value, project.id);
  if (renamed === null) throw badServiceAnswer();
  const { changed, previousName } = answerExtras(sent.value);
  if (!inFolder) return { kind: 'renamed', project: renamed, previousName: previousName ?? project.name, changed, org, files: [] };

  // The local files follow the service's answer (its stored name), even when the service had nothing to change.
  const written = await settle(async () => {
    const files = new FileManager();
    return files.writeKeepRewrites(files.planKeepProjectName(renamed.name));
  });
  if (!written.ok) return { kind: 'local-failed', project: renamed, previousName: previousName ?? project.name, org };
  return { kind: 'renamed', project: renamed, previousName: previousName ?? project.name, changed, org, files: shownPaths(written.value) };
}

/** What a real run would do, read from the project list and the planned keep.lock rewrites alone. */
async function dryRunOutcome(
  name: string,
  project: ProjectRef,
  org: OrgRef,
  client: RenameClient,
  files: readonly string[],
): Promise<RenameOutcome> {
  const all = await client.listProjects();
  if (!all.some((p) => p.id === project.id)) return { kind: 'not-found', project };
  const clash = existingProjectNamed(othersIn(all, project.id), org.id, name);
  if (clash !== undefined) return { kind: 'exists', existing: clash, org };
  return { kind: 'dry-run', project, name, org, files };
}

const NAME_EXISTS_MESSAGE = 'This organization already has a project with that name.'; // COPY-FLAG: same wording as `capy project create`

/** The codes the service sends for a refused name, in the body of a 400 or 409 (which reach the client as a generic service error). */
const NAME_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.PROJECT_NAME_EXISTS,
  ERROR_CODES.PROJECT_NAME_INVALID,
  ERROR_CODES.PROJECT_NAME_RESERVED,
]);

/** The service's own code from the body of a refused request, when it sent one of the name codes. */
function nameCodeOf(err: CapyError): string | undefined {
  const code: unknown = err.details?.data?.code;
  return typeof code === 'string' && NAME_CODES.has(code) ? code : undefined;
}

/** The refusal for a failed rename: a refused name by the service's code, everything else as the lifecycle commands refuse it. */
function renameRefusalFor(err: unknown): Refusal {
  const code = err instanceof CapyError ? nameCodeOf(err) : undefined;
  if (!(err instanceof CapyError) || code === undefined) return refusalFor(err);
  if (code === ERROR_CODES.PROJECT_NAME_EXISTS) {
    const existing: unknown = err.details?.data?.existing_project;
    return { code, message: NAME_EXISTS_MESSAGE, exitCode: 1, extra: existing === undefined ? undefined : { project: existing } };
  }
  return { code, message: err.message, exitCode: 1 };
}

function emitRenameOutcome(json: boolean, outcome: RenameOutcome): void {
  if (outcome.kind === 'needs-choice') return refuse(json, outcome.refusal);
  if (outcome.kind === 'needs-input') {
    return refuse(json, {
      code: ERROR_CODES.PROJECT_NAME_REQUIRED,
      message: '`capy projects rename` needs the new name. Pass it as an argument.', // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation, project: outcome.project, org: outcome.org },
      lines: outcome.suggestion === undefined ? [] : [`  Suggested: ${outcome.suggestion}`], // COPY-FLAG
    });
  }
  if (outcome.kind === 'exists') {
    return refuse(json, {
      code: ERROR_CODES.PROJECT_NAME_EXISTS,
      message: NAME_EXISTS_MESSAGE,
      exitCode: 1,
      extra: { project: outcome.existing, org: outcome.org },
      lines: [`  ${outcome.existing.id}  ${outcome.existing.name}`],
    });
  }
  if (outcome.kind === 'not-found') {
    return refuse(json, {
      code: ERROR_CODES.PROJECT_NOT_FOUND,
      message: `This organization has no live project ${outcome.project.id}.`, // COPY-FLAG
      exitCode: 1,
      extra: { project: outcome.project },
    });
  }
  if (outcome.kind === 'local-failed') {
    return refuse(json, {
      code: ERROR_CODES.KEEP_LOCK_UPDATE_FAILED,
      message: 'Renamed the project, but keep.lock could not be updated.', // COPY-FLAG
      exitCode: 1,
      extra: { renamed: true, project: outcome.project, previous_name: outcome.previousName, org: outcome.org },
    });
  }
  if (outcome.kind === 'dry-run') {
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        dry_run: true,
        project: { id: outcome.project.id, name: outcome.project.name },
        new_name: outcome.name,
        changed: outcome.project.name !== outcome.name,
        keep_lock: { would_update: outcome.files },
        org: outcome.org,
      }, null, 2));
      return;
    }
    console.log(`Dry run: would rename project ${outcome.project.name} to ${outcome.name} in ${outcome.org.name}. Nothing was changed.`); // COPY-FLAG
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      changed: outcome.changed,
      project: outcome.project,
      previous_name: outcome.previousName,
      keep_lock: { updated: outcome.files },
      org: outcome.org,
    }, null, 2));
    return;
  }
  console.log(`Renamed project ${outcome.previousName} to ${outcome.project.name} in ${outcome.org.name}.`); // COPY-FLAG
}

/** `capy projects rename [new-name] [--dry-run] [--json]` */
export async function renameProjectCommand(name: string | undefined, opts: RenameProjectOpts): Promise<void> {
  const json = opts.json === true;

  const folder = await settle(readFolderProject);
  if (!folder.ok) return refuse(json, refusalFor(folder.error));
  const project = folder.value;
  if (project === null && opts.project === undefined) {
    return refuse(json, {
      code: ERROR_CODES.NO_KEEP_FILE,
      message: 'This folder has no keep.lock, so there is no project to rename.', // COPY-FLAG
      exitCode: 1,
    });
  }

  // Before any network call: a name that breaks the rule never leaves this process.
  const problem = name === undefined ? null : renameNameProblem(name);
  if (problem !== null) {
    return refuse(json, {
      code: problem.code,
      message: problem.message,
      exitCode: 1,
      extra: { pattern: PROJECT_RENAME_PATTERN_SOURCE },
    });
  }

  const settled = await settle(() => renameFlow(name, project, opts));
  if (!settled.ok) return refuse(json, renameRefusalFor(settled.error));
  emitRenameOutcome(json, settled.value);
}
