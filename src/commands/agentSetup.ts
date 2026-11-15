/**
 * Bare `capy` in a folder that is not a Capy project yet, with nobody to ask (agent mode: `--json`, `--non-tty`, or
 * stdin that is not a terminal).
 *
 * It reads first (the session, the organizations, the organization's projects, the folder's `.env`) and then does one
 * of two things:
 *   - questions are left: it refuses once with `INIT_INPUT_REQUIRED` (exit 3) and one form that carries every
 *     unanswered question (`setupForm.ts`). Nothing is created and nothing is written.
 *   - everything is answered (by flags): it validates the answers against the service again, then creates the
 *     project, links the folder (keep.lock) straight away, creates the first branch, and pushes the `.env`.
 *
 * Linking right after the project exists is what makes a failed run resumable: the link also leaves a pending-setup
 * marker in the folder's `.capy` sync state (org, project, first branch, protection). The same command, run again in
 * a folder whose marker names the project keep.lock names, with answers that agree with the marker, finishes what is
 * missing instead of creating a second project (`agentResume`). The last step clears the marker. A linked folder with
 * no marker is a healthy project: its setup flags change nothing.
 *
 * Every refusal is coded and every decision keys on a code, a status or a typed field, never on message text. JSON goes
 * to stdout and prose to stderr. No value from the `.env` is ever written to either: names and counts only.
 */
import { existsSync } from 'fs';
import type { AuthResult, CliOptions, KeepFile, PendingSetup, ProjectInitResult, ProjectState, SetupOptions } from '../types/index';
import { CapyError, ERROR_CODES, setSyncKeepHash } from '../types/index';
import type { AuthService } from '../auth/authService';
import { silentAuthFailureMessage } from '../auth/authService';
import type { ServiceClient } from '../service/serviceClient';
import type { ProjectManager } from '../core/projectManager';
import type { FileManager } from '../files/fileManager';
import { SyncEngine } from '../sync/syncEngine';
import { hasOrgKey, resolveProjectKey, type KeyServiceOps } from '../crypto/keyResolver';
import { excludeSystemProject } from '../system/reservedProjectName';
import { orgKeyMissingMessage } from '../core/orgKeyMissing';
import { givenSetupFlags, pendingDisagreements, pendingSetupOf } from '../core/pendingSetup';
import {
  FIRST_BRANCH_DEFAULT,
  answerProblem,
  chooseOrg,
  chooseProject,
  hasGaps,
  newProjectGaps,
  orgChoiceProblem,
  projectChoiceProblem,
  type OrgRef,
  type Problem,
  type ProjectRef,
} from '../core/initPlan';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { refusalFor, settle, type Refusal } from './projectLifecycleCommand';
import { PROTECTED_YES, createRefusalFor, existingProjectNamed, suggestedName } from './projectCreateCommand';
import type { ElicitationForm } from '../ui/elicitation';
import { setupForm } from './setupForm';

/** The result of a push of the `.env`, as `CapyCommand.pushAndEncryptLocalEnv` reports it. */
export type PushOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly pushedToKeep: boolean; readonly backupWritten: boolean; readonly envRewritten: boolean };

/** What agent-mode setup needs from `CapyCommand`; its own members, handed over so the logic is not copied. */
export interface AgentSetupDeps {
  readonly options: CliOptions;
  readonly authService: AuthService;
  readonly serviceClient: ServiceClient;
  readonly projectManager: ProjectManager;
  readonly fileManager: FileManager;
  readonly keyServiceOps: KeyServiceOps;
  /** Decrypts `.env` entries that are already encrypted (and refuses, by name, any that belong to another project). */
  readonly decryptLocalEnv: (raw: Readonly<Record<string, string>>, key: string) => Record<string, string>;
  readonly pushEnv: (
    localEnv: Readonly<Record<string, string>>,
    key: string,
    branch: string,
    keep: KeepFile,
    project: ProjectInitResult,
    auth: AuthResult,
  ) => Promise<PushOutcome>;
  readonly stageKeepLock: () => void;
  readonly installGitHooks: () => void;
}

/** What setup ends with: a refusal to print (and exit with), or a result to print. */
export type AgentOutcome =
  | { readonly kind: 'refusal'; readonly refusal: Refusal }
  | { readonly kind: 'done'; readonly result: Readonly<Record<string, unknown>> };

const refusalOutcome = (refusal: Refusal): AgentOutcome => ({ kind: 'refusal', refusal });

/** A rule that was broken: exit 1, except a choice only the person can make (several organizations of one name), which is exit 3. */
const problemOutcome = (problem: Problem): AgentOutcome =>
  refusalOutcome({
    code: problem.code,
    message: problem.message,
    exitCode: problem.code === ERROR_CODES.ORG_SELECTION_REQUIRED ? EXIT_NEEDS_INPUT : 1,
    ...(problem.extra === undefined ? {} : { extra: problem.extra }),
  });

/** The folder's `.env`: whether there is one and how many variables it holds. Never a name or a value. */
interface EnvFacts {
  readonly exists: boolean;
  readonly variables: number;
}

function envFactsOf(deps: AgentSetupDeps): EnvFacts {
  const exists = existsSync(deps.projectManager.getEnvPath(deps.options.envPath));
  return exists
    ? { exists, variables: Object.keys(deps.fileManager.readEnvFile(deps.options.envPath)).length }
    : { exists, variables: 0 };
}

/** The silent sign-in failures that a browser cannot fix (an unreachable service, a failing refresh). */
function isTransientAuthFailure(auth: AuthResult): boolean {
  return auth.error_code === 'network' || auth.error_code === 'server_error';
}

/**
 * Nobody to sign in: never a browser. Pairing is the way to get a session, so the refusal says that command is next.
 * A failure the browser could not fix anyway (offline, a failing service) keeps the existing sentence and names none.
 */
function notSignedIn(auth: AuthResult): Refusal {
  const reason = auth.error_code ?? 'no_session';
  if (isTransientAuthFailure(auth)) {
    return { code: ERROR_CODES.AUTH_FAILED, message: silentAuthFailureMessage(auth), exitCode: 1, extra: { reason } };
  }
  return {
    code: ERROR_CODES.AUTH_FAILED,
    message: `${auth.error || 'Not authenticated'}. Run \`capy pair\` to sign in.`, // COPY-FLAG
    exitCode: 1,
    extra: { reason, next_command: 'capy pair' },
  };
}

type SignedIn =
  | { readonly ok: true; readonly auth: AuthResult }
  | { readonly ok: false; readonly refusal: Refusal };

/** A session from what is stored, scoped to `orgId` when there is one; never a browser. */
async function signIn(deps: AgentSetupDeps, orgId: string | undefined): Promise<SignedIn> {
  const attempt = await settle(async () => {
    const scoped = await deps.authService.authenticateSilent(orgId);
    return scoped.success || orgId === undefined ? scoped : deps.authService.authenticateSilent();
  });
  if (!attempt.ok) return { ok: false, refusal: refusalFor(attempt.error) };
  if (!attempt.value.success) return { ok: false, refusal: notSignedIn(attempt.value) };
  return { ok: true, auth: attempt.value };
}

/** A session scoped to the organization that was chosen. An organization the service does not know is ORG_NOT_FOUND. */
async function scopeToOrg(deps: AgentSetupDeps, org: OrgRef): Promise<SignedIn> {
  const attempt = await settle(() => deps.authService.authenticateSilent(org.id));
  if (!attempt.ok) return { ok: false, refusal: refusalFor(attempt.error) };
  if (attempt.value.success) return { ok: true, auth: attempt.value };
  if (attempt.value.error_code === 'org_not_found') {
    return { ok: false, refusal: { code: ERROR_CODES.ORG_NOT_FOUND, message: `No organization ${org.name} is available to this account.`, exitCode: 1, extra: { org } } }; // COPY-FLAG
  }
  return { ok: false, refusal: notSignedIn(attempt.value) };
}

const orgRefsOf = (auth: AuthResult): readonly OrgRef[] => (auth.organizations ?? []).map((o) => ({ id: o.id, name: o.name }));

/** A refusal with the project (and organization) it happened to attached: the project exists, so it is never "nothing happened". */
function withProject(refusal: Refusal, org: OrgRef, project: ProjectRef): AgentOutcome {
  return refusalOutcome({ ...refusal, extra: { ...(refusal.extra ?? {}), project, org } });
}

/** Everything a run needs once the organization, the session and the project's identity are known. */
interface RunContext {
  readonly org: OrgRef;
  readonly auth: AuthResult;
  readonly userId: string;
  readonly env: EnvFacts;
  readonly dryRun: boolean;
}

/** The first branch's name and protection, as every JSON result reports it (`protected` is null when it was not asked). */
const branchJson = (name: string, isProtected: boolean | null) => ({ name, protected: isProtected });

/** The folder's keep.lock for a project, with no variables yet. */
const identityKeep = (project: ProjectInitResult): KeepFile => ({
  version: '3.0',
  org_id: project.org_id,
  project_id: project.project_id,
  project_name: project.project_name,
  variables: {},
});

type PushedEnv =
  | { readonly ok: true; readonly pushed: number }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Encrypts the folder's `.env` and pushes it to `branch`. Nothing to push is a push of 0. A value that is already
 * encrypted must decrypt with this project's key (the cross-org guard names the variables and refuses).
 */
async function pushFolderEnv(
  deps: AgentSetupDeps,
  ctx: RunContext,
  project: ProjectInitResult,
  keep: KeepFile,
  encryptionKey: string,
  branch: string,
): Promise<PushedEnv> {
  if (ctx.env.variables === 0) return { ok: true, pushed: 0 };
  const prepared = await settle(async () => deps.decryptLocalEnv(deps.fileManager.readEnvFile(deps.options.envPath), encryptionKey));
  if (!prepared.ok) return { ok: false, refusal: refusalFor(prepared.error) };
  const result = await deps.pushEnv(prepared.value, encryptionKey, branch, keep, project, ctx.auth);
  if (!result.ok) return { ok: false, refusal: refusalFor(result.error) };
  deps.stageKeepLock();
  return { ok: true, pushed: Object.keys(prepared.value).length };
}

// ---------------------------------------------------------------------------------------------------------------------
// A new project
// ---------------------------------------------------------------------------------------------------------------------

interface NewProject {
  readonly name: string;
  readonly branch: string;
  readonly isProtected: boolean;
}

/** The marker a setup leaves while it is unfinished: what a rerun has to agree with. */
const pendingOf = (project: ProjectInitResult, plan: NewProject): PendingSetup => ({
  org_id: project.org_id,
  project_id: project.project_id,
  branch: plan.branch,
  protected: plan.isProtected,
});

/** Creates the project, links the folder, creates the first branch and pushes the `.env`, in that order. */
async function createAndLink(deps: AgentSetupDeps, ctx: RunContext, plan: NewProject): Promise<AgentOutcome> {
  const created = await settle(() => deps.serviceClient.initializeProject(plan.name, ctx.org.id));
  if (!created.ok) return refusalOutcome(createRefusalFor(created.error));
  const project = created.value;
  const ref: ProjectRef = { id: project.project_id, name: project.project_name };

  // The link comes first: from here on the folder names the project, so a failed run is finished by running it again.
  const linked = await settle(async () => {
    deps.projectManager.writeSyncStateUserId(ctx.userId);
    deps.fileManager.writeKeepFile(identityKeep(project));
    deps.projectManager.writePendingSetup(pendingOf(project, plan));
  });
  if (!linked.ok) return withProject(refusalFor(linked.error), ctx.org, ref);

  return finishSetup(deps, ctx, project, plan, true);
}

/**
 * The steps after the folder is linked: the key, the first branch (made unless it is already there), the local branch
 * file, and the `.env`. The same steps finish a run that stopped half way (`agentResume`).
 */
async function finishSetup(
  deps: AgentSetupDeps,
  ctx: RunContext,
  project: ProjectInitResult,
  plan: NewProject,
  createBranch: boolean,
): Promise<AgentOutcome> {
  const ref: ProjectRef = { id: project.project_id, name: project.project_name };
  const key = await settle(() => resolveProjectKey(ctx.org.id, project.project_id, ctx.userId, deps.keyServiceOps));
  if (!key.ok) return withProject(refusalFor(key.error), ctx.org, ref);

  if (createBranch) {
    const made = await settle(() => deps.serviceClient.createBranch(project.project_id, plan.branch, plan.isProtected));
    if (!made.ok) {
      return withProject({
        code: ERROR_CODES.BRANCH_CREATE_FAILED,
        message: `Created project ${ref.name}, but not its first branch ${plan.branch}.`, // project create's wording
        exitCode: 1,
        extra: { branch: branchJson(plan.branch, plan.isProtected) },
      }, ctx.org, ref);
    }
  }

  const local = await settle(async () => {
    deps.projectManager.writeActiveBranch(plan.branch);
    deps.fileManager.ensureCapyGitignore();
    deps.stageKeepLock();
  });
  if (!local.ok) return withProject(refusalFor(local.error), ctx.org, ref);

  const keep = deps.projectManager.readKeepFile() ?? identityKeep(project);
  const pushed = await pushFolderEnv(deps, ctx, project, keep, key.value, plan.branch);
  // A push rewrites the sync state: the marker is written again, so it outlives the push until the last step is done.
  const marked = await settle(async () => deps.projectManager.writePendingSetup(pendingOf(project, plan)));
  if (!pushed.ok) return withProject({ ...pushed.refusal, extra: { ...(pushed.refusal.extra ?? {}), branch: branchJson(plan.branch, plan.isProtected), pushed: 0 } }, ctx.org, ref);
  if (!marked.ok) return withProject(refusalFor(marked.error), ctx.org, ref);

  const closed = await settle(async () => {
    deps.installGitHooks();
    deps.projectManager.clearPendingSetup();
  });
  if (!closed.ok) return withProject(refusalFor(closed.error), ctx.org, ref);
  return {
    kind: 'done',
    result: {
      ok: true,
      created: true,
      org: ctx.org,
      project: ref,
      branch: branchJson(plan.branch, plan.isProtected),
      pushed: pushed.pushed,
      env_found: ctx.env.exists,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// An existing project
// ---------------------------------------------------------------------------------------------------------------------

/** The keep.lock of a project with no secrets yet; the folder is linked and nothing is pulled. */
function linkEmptyProject(deps: AgentSetupDeps, ctx: RunContext, project: ProjectRef, branch: string): AgentOutcome {
  deps.fileManager.writeKeepFile({ version: '3.0', org_id: ctx.org.id, project_id: project.id, project_name: project.name, variables: {} });
  deps.projectManager.writeActiveBranch(branch);
  deps.fileManager.ensureCapyGitignore();
  deps.installGitHooks();
  return linkedResult(ctx, project, branch, 0);
}

function linkedResult(ctx: RunContext, project: ProjectRef, branch: string, pulled: number): AgentOutcome {
  return {
    kind: 'done',
    result: { ok: true, created: false, org: ctx.org, project, branch: branchJson(branch, null), pushed: 0, pulled, env_found: ctx.env.exists },
  };
}

/** Pulls `branch` of an existing project into the folder, as the terminal does: keep.lock, the branch file and an encrypted `.env`. */
async function linkExisting(deps: AgentSetupDeps, ctx: RunContext, project: ProjectRef, branch: string): Promise<AgentOutcome> {
  const key = await settle(() => resolveProjectKey(ctx.org.id, project.id, ctx.userId, deps.keyServiceOps));
  if (!key.ok) return refusalOutcome(refusalFor(key.error));
  const fetched = await settle(() => deps.serviceClient.getDecryptData(project.id, branch, undefined, true));
  if (!fetched.ok) return pullFailed(deps, ctx, project, branch, fetched.error);
  if (!fetched.value.keep_file) return outcomeOf(() => linkEmptyProject(deps, ctx, project, branch));

  const data = fetched.value;
  const written = await settle(async () => {
    const serverKeep: KeepFile = { ...(JSON.parse(data.keep_file as string) as KeepFile), org_id: ctx.org.id, project_id: project.id, project_name: project.name };
    const plaintext = decryptedVariables(deps, data.env_content, key.value);
    // The folder's own plaintext variables are about to be replaced by the project's: keep a copy of them first.
    if (ctx.env.variables > 0) deps.fileManager.backupPlaintextEnv(deps.options.envPath, (line) => console.error(line));
    deps.projectManager.writeSyncStateUserId(ctx.userId);
    deps.fileManager.writeKeepFile(serverKeep);
    deps.projectManager.writeActiveBranch(branch);
    deps.fileManager.ensureCapyGitignore();
    deps.fileManager.writeEncryptedEnvFile(plaintext, key.value, deps.options.envPath, serverKeep, branch);
    deps.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(plaintext),
      user_id: ctx.userId,
      keep_hash: setSyncKeepHash(null, branch, SyncEngine.computeKeepHash(serverKeep, branch)),
    });
    deps.stageKeepLock();
    deps.installGitHooks();
    return Object.keys(plaintext).length;
  });
  return written.ok ? linkedResult(ctx, project, branch, written.value) : refusalOutcome(refusalFor(written.error));
}

/** The variables the person may read, decrypted. One they lack permission for is skipped, as the terminal skips it. */
function decryptedVariables(deps: AgentSetupDeps, envContent: string | undefined, key: string): Record<string, string> {
  const encrypted = envContent ? deps.fileManager.parseEnvContent(envContent) : {};
  return Object.fromEntries(
    Object.entries(encrypted).flatMap(([name, value]) => {
      const plain = settleSync(() => deps.fileManager.decryptValue(value, key));
      return plain === undefined ? [] : [[name, plain] as const];
    }),
  );
}

/** `fn`'s value, or undefined when it throws. */
function settleSync<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Runs `step`; what it throws is a refusal, not an exception. */
async function outcomeOf(step: () => AgentOutcome): Promise<AgentOutcome> {
  const done = await settle(async () => step());
  return done.ok ? done.value : refusalOutcome(refusalFor(done.error));
}

/** A project with no secrets answers a pull with a coded 404 (NO_SECRETS): the folder is linked and nothing is pulled. Anything else is a refusal. */
async function pullFailed(deps: AgentSetupDeps, ctx: RunContext, project: ProjectRef, branch: string, error: unknown): Promise<AgentOutcome> {
  const empty = error instanceof CapyError && error.details?.status === 404 && error.code === ERROR_CODES.NO_SECRETS;
  if (empty) return outcomeOf(() => linkEmptyProject(deps, ctx, project, branch));
  return refusalOutcome({ ...refusalFor(error), extra: { project, org: ctx.org } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading state, then asking or acting
// ---------------------------------------------------------------------------------------------------------------------

function dryRunOutcome(ctx: RunContext, project: object, branch: object, pushes: number): AgentOutcome {
  return { kind: 'done', result: { ok: true, dry_run: true, org: ctx.org, project, branch, would_push: pushes, env_found: ctx.env.exists } };
}

/** Everything is answered: validate it against the service once more, then act. */
async function act(deps: AgentSetupDeps, setup: SetupOptions, ctx: RunContext, projects: readonly ProjectRef[]): Promise<AgentOutcome> {
  const choice = chooseProject(projects, setup);
  if (choice.kind === 'unknown' || choice.kind === 'ambiguous') return problemOutcome(projectChoiceProblem(choice, ctx.org));
  if (choice.kind === 'existing') {
    const branch = setup.branch ?? FIRST_BRANCH_DEFAULT;
    if (ctx.dryRun) return dryRunOutcome(ctx, choice.project, branchJson(branch, null), 0);
    return linkExisting(deps, ctx, choice.project, branch);
  }
  return actNew(deps, setup, ctx, projects, choice.kind === 'ask' ? choice.projects : undefined);
}

/** The organization's projects in the shape `existingProjectNamed` reads. */
const listedIn = (org: OrgRef, projects: readonly ProjectRef[]) => projects.map((p) => ({ ...p, organization_id: org.id }));

/** A new project: ask for what is missing, else check the name is free and create it. */
async function actNew(
  deps: AgentSetupDeps,
  setup: SetupOptions,
  ctx: RunContext,
  projects: readonly ProjectRef[],
  asked: readonly ProjectRef[] | undefined,
): Promise<AgentOutcome> {
  const gaps = newProjectGaps(setup);
  if (asked !== undefined || hasGaps(gaps)) {
    const isTaken = (candidate: string) => existingProjectNamed(listedIn(ctx.org, projects), ctx.org.id, candidate) !== undefined;
    return needsInput(setupForm({
      org: ctx.org,
      projects: asked,
      gaps,
      answers: setup,
      variables: ctx.env.variables,
      suggestedName: suggestedName(isTaken),
      envPath: deps.options.envPath,
      dryRun: ctx.dryRun,
    }));
  }
  const name = setup.name as string;
  const taken = existingProjectNamed(listedIn(ctx.org, projects), ctx.org.id, name);
  if (taken !== undefined) {
    return refusalOutcome({
      code: ERROR_CODES.PROJECT_NAME_EXISTS,
      message: 'This organization already has a project with that name.', // project create's wording
      exitCode: 1,
      extra: { project: taken, org: ctx.org },
    });
  }
  const plan: NewProject = { name, branch: setup.branch as string, isProtected: setup.protectedAnswer === PROTECTED_YES };
  if (ctx.dryRun) return dryRunOutcome(ctx, { name }, branchJson(plan.branch, plan.isProtected), ctx.env.variables);
  return createAndLink(deps, ctx, plan);
}

/** The one refusal that hands every unanswered question to the agent. Exit 3. */
function needsInput(form: ElicitationForm): AgentOutcome {
  return refusalOutcome({
    code: ERROR_CODES.INIT_INPUT_REQUIRED,
    message: '`capy` needs answers to set up this folder. Pass them as flags, or run it in a terminal.', // COPY-FLAG
    exitCode: EXIT_NEEDS_INPUT,
    extra: { elicitation: form },
  });
}

/** The organization is decided and the session is scoped to it: the key, the projects, then ask or act. */
async function withOrg(deps: AgentSetupDeps, setup: SetupOptions, env: EnvFacts, org: OrgRef): Promise<AgentOutcome> {
  const scoped = await scopeToOrg(deps, org);
  if (!scoped.ok) return refusalOutcome(scoped.refusal);
  const userId = scoped.auth.user_id;
  if (userId === undefined) return refusalOutcome(notSignedIn({ success: false, error: 'No user', error_code: 'no_session' }));
  // A teammate invited to this organization has no key on this device until they redeem the invite.
  if (!hasOrgKey(org.id, userId)) {
    return refusalOutcome({ code: ERROR_CODES.AUTH_FAILED, message: orgKeyMissingMessage(org.name), exitCode: 1, extra: { org } });
  }

  const listed = await settle(() => deps.serviceClient.listProjects());
  // "The lookup failed" is not "this organization has none": it must never end in creating a project.
  if (!listed.ok) {
    const cause = listed.error instanceof CapyError ? listed.error.code : ERROR_CODES.SERVICE_ERROR;
    return refusalOutcome({
      code: ERROR_CODES.PROJECT_LOOKUP_FAILED,
      message: 'Could not read the projects of this organization, so nothing was created.', // COPY-FLAG
      exitCode: 1,
      extra: { org, cause },
    });
  }
  const projects: readonly ProjectRef[] = excludeSystemProject(listed.value.filter((p) => p.organization_id === org.id)).map((p) => ({ id: p.id, name: p.name }));
  return act(deps, setup, { org, auth: scoped.auth, userId, env, dryRun: deps.options.dryRun === true }, projects);
}

/**
 * Sets up a folder that is not a project yet. Never prompts, never opens a browser, never throws: a failure is a
 * refusal with a code.
 */
export async function agentSetup(deps: AgentSetupDeps, setup: SetupOptions): Promise<AgentOutcome> {
  const problem = answerProblem(setup);
  if (problem !== null) return problemOutcome(problem);

  const env = await settle(async () => envFactsOf(deps));
  if (!env.ok) return refusalOutcome(refusalFor(env.error));

  const signed = await signIn(deps, deps.projectManager.readSyncState()?.org_id);
  if (!signed.ok) return refusalOutcome(signed.refusal);

  const orgs = orgRefsOf(signed.auth);
  const choice = chooseOrg(orgs, setup.org);
  if (choice.kind === 'none' || choice.kind === 'unknown' || choice.kind === 'ambiguous') return problemOutcome(orgChoiceProblem(choice, orgs));
  if (choice.kind === 'ask') {
    // The projects to choose from are the organization's, so the organization is asked first and the rest on the next run.
    return needsInput(setupForm({
      orgChoices: choice.orgs,
      answers: setup,
      variables: env.value.variables,
      envPath: deps.options.envPath,
      dryRun: deps.options.dryRun === true,
    }));
  }
  return withOrg(deps, setup, env.value, choice.org);
}

// ---------------------------------------------------------------------------------------------------------------------
// A run that stopped half way
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a linked folder's run does with the setup flags: end with a result or a refusal, or go on to the sync a linked
 * folder always gets. `ignoredFlags` are the setup flags that were typed and applied to nothing (a healthy project is
 * not set up again), so the sync's answer can say so.
 */
export type LinkedStep = AgentOutcome | { readonly kind: 'sync'; readonly ignoredFlags: readonly string[] };

const syncStep = (ignoredFlags: readonly string[]): LinkedStep => ({ kind: 'sync', ignoredFlags });

/** The refusal for answers that differ from the setup the folder is in the middle of. Names the flags, never a value. */
function pendingMismatch(pending: PendingSetup, projectName: string, flags: readonly string[]): AgentOutcome {
  return refusalOutcome({
    code: ERROR_CODES.SETUP_PENDING_MISMATCH,
    message: 'An earlier setup of this folder did not finish, and these answers differ from it. Run the same command again with its answers.', // COPY-FLAG
    exitCode: 1,
    extra: {
      org: { id: pending.org_id },
      project: { id: pending.project_id, name: projectName },
      branch: branchJson(pending.branch, pending.protected),
      differs: flags,
    },
  });
}

/**
 * The same command, run again in a folder that is already linked, after a run that stopped after the project was
 * created. It resumes only when the folder carries the pending-setup marker for the project keep.lock names, and
 * `--name`, `--branch` and `--protected` are all given and agree with it. It then finishes the missing steps: the
 * first branch, the local branch file, the `.env` push.
 *
 * With the marker, and a typed flag that differs from it: a refusal (SETUP_PENDING_MISMATCH), nothing changed.
 * In every other case the folder is a healthy project (or the flags are not that rerun): bare `capy` syncs the
 * folder as it always has, and the setup flags that were typed are reported as ignored.
 */
export async function agentResume(deps: AgentSetupDeps, setup: SetupOptions, state: ProjectState): Promise<LinkedStep> {
  const { projectId, organizationId, projectName } = state;
  const typed = givenSetupFlags(setup);
  const pending = pendingSetupOf(deps.projectManager.readSyncState());
  const marked = pending !== undefined && state.hasKeepFile && pending.project_id === projectId && pending.org_id === organizationId;
  if (!marked || projectName === undefined) return syncStep(typed);

  const differs = pendingDisagreements(setup, pending, { projectId: pending.project_id, projectName });
  if (differs.length > 0) return pendingMismatch(pending, projectName, differs);
  // A typed --org is checked whatever else was typed: another organization is a refusal, never a sync.
  const orgDiffers = await orgMismatch(deps, setup, pending, projectName);
  if (orgDiffers !== undefined) return orgDiffers;
  const complete = setup.name === projectName && setup.branch !== undefined && setup.protectedAnswer !== undefined;
  if (!complete) return syncStep(typed);

  const problem = answerProblem(setup);
  if (problem !== null) return problemOutcome(problem);
  return resumeSetup(deps, setup, pending, projectName);
}

/** Whether `--org`, when typed, names the organization of the pending setup. Not typed: it agrees. */
function orgAgrees(typed: string | undefined, orgs: readonly OrgRef[], pending: PendingSetup): boolean {
  if (typed === undefined) return true;
  const choice = chooseOrg(orgs, typed);
  return choice.kind === 'picked' && choice.org.id === pending.org_id;
}

/** With `--org` typed: the refusal when it does not name the pending setup's organization (the session resolves it). Nothing is written. */
async function orgMismatch(deps: AgentSetupDeps, setup: SetupOptions, pending: PendingSetup, projectName: string): Promise<AgentOutcome | undefined> {
  if (setup.org === undefined) return undefined;
  const signed = await signIn(deps, pending.org_id);
  if (!signed.ok) return refusalOutcome(signed.refusal);
  return orgAgrees(setup.org, orgRefsOf(signed.auth), pending) ? undefined : pendingMismatch(pending, projectName, ['--org']);
}

async function resumeSetup(deps: AgentSetupDeps, setup: SetupOptions, pending: PendingSetup, projectName: string): Promise<LinkedStep> {
  const env = await settle(async () => envFactsOf(deps));
  if (!env.ok) return refusalOutcome(refusalFor(env.error));
  const signed = await signIn(deps, pending.org_id);
  if (!signed.ok) return refusalOutcome(signed.refusal);
  const orgs = orgRefsOf(signed.auth);
  const org = orgs.find((o) => o.id === pending.org_id) ?? { id: pending.org_id, name: pending.org_id };
  const scoped = await scopeToOrg(deps, org);
  if (!scoped.ok) return refusalOutcome(scoped.refusal);
  const userId = scoped.auth.user_id;
  if (userId === undefined) return refusalOutcome(notSignedIn({ success: false, error: 'No user', error_code: 'no_session' }));

  const plan: NewProject = { name: projectName, branch: pending.branch, isProtected: pending.protected };
  const branches = await settle(() => deps.serviceClient.listBranches(pending.project_id));
  if (!branches.ok) return refusalOutcome(refusalFor(branches.error));

  const branchMissing = !branches.value.some((b) => b.name === plan.branch);
  const noLocalBranch = deps.projectManager.readActiveBranch() === null;
  const envUnpushed = env.value.variables > 0 && deps.fileManager.readEnvMeta(deps.options.envPath).project_id !== pending.project_id;
  const ctx: RunContext = { org, auth: scoped.auth, userId, env: env.value, dryRun: deps.options.dryRun === true };
  if (!branchMissing && !noLocalBranch && !envUnpushed) {
    // Nothing is left to do: the setup is complete, so the marker goes (a dry run changes nothing) and the folder syncs.
    if (!ctx.dryRun) deps.projectManager.clearPendingSetup();
    return syncStep([]);
  }

  const project: ProjectInitResult = { org_id: org.id, project_id: pending.project_id, project_name: projectName, created: false };
  if (ctx.dryRun) return dryRunOutcome(ctx, { id: pending.project_id, name: projectName }, branchJson(plan.branch, plan.isProtected), envUnpushed ? env.value.variables : 0);
  const finished = await finishSetup(deps, ctx, project, plan, branchMissing);
  return finished.kind === 'done' ? { kind: 'done', result: { ...finished.result, created: false, resumed: true } } : finished;
}
