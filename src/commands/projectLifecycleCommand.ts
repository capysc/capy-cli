/**
 * `capy project delete` and `capy project restore` (CAP-729).
 *
 * A delete hides a project; it destroys nothing, and an org owner can restore
 * it. The service decides everything that matters (who may delete, whether live
 * deploy tokens block it, whether the project is the system store); this file
 * resolves the name the person typed, asks the question, and shows the answer.
 *
 * Every refusal is coded, and every decision here keys on a code, a status or a
 * structured field, never on message text. `--json` is the MCP contract: pure
 * JSON on stdout, prose on stderr, and a stable `code` on every refusal.
 *
 * `--dry-run` reads the project and its deploy tokens and stops. The service has
 * no dry run, so the DELETE is simply never sent.
 *
 * Without `--yes` and with nobody to ask (agent mode), `project delete` refuses with CONFIRMATION_REQUIRED (exit 3)
 * and an `elicitation` (kind "confirm", `ui/elicitation.ts`): the project, the org, its branches, its variable
 * NAMES (never a value or a hash) and its live deploy tokens, so the agent can put the question to the human.
 * In a terminal the same summary is printed before the Yes/No question.
 */
import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { excludeSystemProject } from '../system/reservedProjectName';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { CapyError, ERROR_CODES } from '../types/index';
import type { DeleteProjectResponse, LiveDeployTokenInfo } from '../service/serviceClient';
import type { ElicitationConfirm, ElicitationForm } from '../ui/elicitation';
import { chooseProjectDisplay, deleteProjectDisplay, restoreProjectDisplay } from '../ui/elicitationDisplay';
import { formatRelativeTime } from '../ui/relativeTime';
import { variableBranchesFromKeep, type VariableBranches } from '../core/keepVariableNames';

export interface ProjectLifecycleOpts {
  json?: boolean;
  yes?: boolean;
  /** `--non-tty`: treat stdin as not a terminal, so the confirmation is refused unless `--yes`. */
  nonTty?: boolean;
  apiUrl?: string;
  devMode?: boolean;
}

export interface DeleteProjectOpts extends ProjectLifecycleOpts {
  /** Delete even though the project has live deploy tokens. Those deploys stop on their next restart. */
  force?: boolean;
  /** The global `--dry-run`: show what would happen; send nothing that writes. */
  dryRun?: boolean;
}

export interface RestoreProjectOpts extends ProjectLifecycleOpts {
  /** The global `--dry-run`: show which project would be restored; send nothing that writes. */
  dryRun?: boolean;
}

/** What commander hands an action's `command`: only the merged view is needed. */
interface CommandWithGlobals {
  optsWithGlobals(): Record<string, unknown>;
}

/**
 * The options of `project delete` / `project restore` as typed, wherever commander put them.
 *
 * A flag that the program or `org` also defines (`--force`, `--non-tty`, `--dry-run`) is taken by that outer command
 * and never reaches the subcommand's own options, so reading `options.force` there is always undefined. The merged view
 * has every one of them; `--yes` and `--json` come out of it the same way, so a later outer flag of that name cannot shadow them.
 */
export function lifecycleOptsFrom(command: CommandWithGlobals): DeleteProjectOpts {
  const merged = command.optsWithGlobals();
  return {
    force: merged.force === true,
    yes: merged.yes === true,
    nonTty: merged.nonTty === true,
    json: merged.json === true,
    dryRun: merged.dryRun === true,
  };
}

interface ProjectRef {
  id: string;
  name: string;
  deleted_at?: string | null;
  /** Absent from services that predate it. */
  created_at?: string | null;
}

/** The 403 codes the service sends that reach the client as a PERMISSION_DENIED with the server's code in `details.code`. */
const CODED_FORBIDDEN: ReadonlySet<string> = new Set([
  ERROR_CODES.PROJECT_DELETE_OWNER_ONLY,
  ERROR_CODES.SYSTEM_STORE_IMMUTABLE,
]);

export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  /** Extra structured fields for `--json` (the token list, the ambiguous ids). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Extra prose lines for the human refusal. */
  readonly lines?: readonly string[];
}

/** The code a thrown error carries: the server's own 403 code when the client wrapped it as PERMISSION_DENIED. */
function codeOf(err: CapyError): string {
  const serverCode = err.details?.code;
  return err.code === ERROR_CODES.PERMISSION_DENIED && typeof serverCode === 'string' && CODED_FORBIDDEN.has(serverCode)
    ? serverCode
    : err.code;
}

function liveTokensOf(err: CapyError): readonly LiveDeployTokenInfo[] {
  const tokens = err.details?.data?.live_deploy_tokens;
  return Array.isArray(tokens) ? tokens : [];
}

function describeToken(t: LiveDeployTokenInfo): string {
  return `${t.deploy_id}${t.label ? `  ${t.label}` : ''}  (created ${t.created_at})`; // COPY-FLAG
}

export function refusalFor(err: unknown): Refusal {
  if (!(err instanceof CapyError)) {
    return { code: ERROR_CODES.SERVICE_ERROR, message: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  const code = codeOf(err);
  if (code === ERROR_CODES.PROJECT_HAS_LIVE_DEPLOY_TOKENS) {
    const tokens = liveTokensOf(err);
    return {
      code,
      message: 'This project has live deploy tokens.', // COPY-FLAG
      exitCode: 1,
      extra: { live_deploy_tokens: tokens },
      lines: [
        ...tokens.map((t) => `  ${describeToken(t)}`),
        '--force deletes the project anyway. Those deploys stop on their next restart.', // COPY-FLAG
      ],
    };
  }
  if (code === ERROR_CODES.ORG_SELECTION_REQUIRED) {
    return { code, message: err.message, exitCode: EXIT_NEEDS_INPUT, extra: { orgs: Array.isArray(err.details?.orgs) ? err.details.orgs : [] } };
  }
  return { code, message: err.message, exitCode: 1 };
}

/** The refusal on the right stream: JSON on stdout under `--json`, prose on stderr otherwise. Never returns. */
export function refuse(json: boolean, r: Refusal): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, code: r.code, error: r.message, ...(r.extra ?? {}) }, null, 2));
  } else {
    console.error(r.message);
    (r.lines ?? []).forEach((l) => console.error(l));
  }
  return process.exit(r.exitCode);
}

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Runs `fn` and returns what it threw as a value, so a refusal's `process.exit` is never caught by the code that raised it. */
export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  return fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** Prose goes to stdout in human mode and to stderr under `--json`, so stdout stays pure JSON. */
function say(json: boolean, line: string): void {
  if (json) console.error(line);
  else console.log(line);
}

/** `--json` renders the prompt on stderr; `inquirer.prompt` always writes to stdout. */
function promptModuleFor(json: boolean): typeof inquirer.prompt {
  return json ? inquirer.createPromptModule({ output: process.stderr }) : inquirer.prompt;
}

async function confirm(json: boolean, message: string): Promise<boolean> {
  const { confirmed } = await promptModuleFor(json)([{ type: 'confirm', name: 'confirmed', message, default: false }]);
  return confirmed === true;
}

/**
 * The projects a name or id points at. An id wins over a name; the system store never matches.
 * `preferDeleted` (restore) narrows to deleted projects when any match, so a live twin with the same name is not picked.
 */
function matchProjects(projects: readonly ProjectRef[], ref: string, preferDeleted: boolean): readonly ProjectRef[] {
  const candidates = excludeSystemProject(projects);
  const byId = candidates.filter((p) => p.id === ref);
  const matches = byId.length > 0 ? byId : candidates.filter((p) => p.name === ref);
  const deleted = matches.filter((p) => p.deleted_at !== null && p.deleted_at !== undefined);
  return preferDeleted && deleted.length > 0 ? deleted : matches;
}

/** A project id as the service mints them. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Resolved =
  | { readonly kind: 'one'; readonly project: ProjectRef }
  | { readonly kind: 'many'; readonly matches: readonly ProjectRef[] };

/**
 * What the name or id the person typed points at.
 *
 * A name that matches nothing is refused here with PROJECT_NOT_FOUND, before anything is read or asked. An id that
 * matches nothing still goes to the service, which answers for it: not found, or the owner-only refusal for a non-owner
 * (whose listing hides deleted projects).
 */
function resolveRef(projects: readonly ProjectRef[], ref: string, preferDeleted: boolean): Resolved {
  const matches = matchProjects(projects, ref, preferDeleted);
  if (matches.length === 1) return { kind: 'one', project: matches[0] };
  if (matches.length > 1) return { kind: 'many', matches };
  if (PROJECT_ID_PATTERN.test(ref)) return { kind: 'one', project: { id: ref, name: ref } };
  throw new CapyError(
    `No project named ${ref} in this organization.`, // COPY-FLAG
    ERROR_CODES.PROJECT_NOT_FOUND,
    { name: ref },
  );
}

/** One of several projects with the same name, with what tells them apart. `variables` is undefined when it could not be read. */
interface Candidate {
  readonly project: ProjectRef;
  readonly variables: number | undefined;
}

/** Each match with its variable count, oldest first. Best effort: an unreadable count is shown as such, never as 0. */
async function candidatesOf(client: DeleteDetailsClient, matches: readonly ProjectRef[]): Promise<readonly Candidate[]> {
  const candidates = await Promise.all(matches.map(async (project): Promise<Candidate> => {
    const details = await readDeleteDetails(client, project.id);
    return { project, variables: details.unavailable.includes('variables') ? undefined : details.variables.length };
  }));
  // A fresh copy sorted as it is built (the lib target predates toSorted); `candidates` itself is never changed.
  return [...candidates].sort((a, b) => (a.project.created_at ?? '').localeCompare(b.project.created_at ?? ''));
}

/** "web · 45 variables · created 2 days ago": the name, the variable count, and how long ago it was created. */
function candidateLabel(c: Candidate, now: Date): string {
  const variables = c.variables === undefined
    ? 'variables could not be read' // COPY-FLAG
    : `${c.variables} ${c.variables === 1 ? 'variable' : 'variables'}`; // COPY-FLAG
  const created = c.project.created_at ? [`created ${formatRelativeTime(c.project.created_at, now)}`] : []; // COPY-FLAG
  return [c.project.name, variables, ...created].join(' · ');
}

/** The pick-one elicitation: the answer is a project id, and `rerun` carries it back into the same command. */
function chooseElicitation(org: OrgRef, ref: string, candidates: readonly Candidate[], rerun: string): ElicitationForm {
  const now = new Date();
  const labels = candidates.map((c) => candidateLabel(c, now));
  return {
    kind: 'form',
    question: `Which ${ref}?`, // COPY-FLAG
    details: {
      org: { id: org.id, name: org.name },
      matches: candidates.map((c) => ({
        id: c.project.id,
        name: c.project.name,
        created_at: c.project.created_at ?? null,
        variables: c.variables ?? null,
      })),
    },
    display: chooseProjectDisplay(labels),
    fields: [{
      name: 'project',
      type: 'string',
      pattern: `^(${candidates.map((c) => c.project.id).join('|')})$`,
      options: candidates.map((c, i) => ({ value: c.project.id, label: labels[i] })),
    }],
    answer: { rerun },
  };
}

type Picked =
  | { readonly kind: 'picked'; readonly project: ProjectRef }
  | { readonly kind: 'needs-choice'; readonly elicitation: ElicitationForm; readonly lines: readonly string[] };

interface PickContext {
  readonly json: boolean;
  readonly agentMode: boolean;
  readonly org: OrgRef;
  readonly ref: string;
  readonly client: DeleteDetailsClient;
  /** The command that answers the choice, with `<project>` where the chosen id goes. */
  readonly rerun: string;
}

/**
 * The one project to act on. Several with the same name: in a terminal, an arrow-key list; with nobody to ask, the
 * pick-one elicitation. Never a guess, and `--yes` never chooses.
 */
async function pickProject(resolved: Resolved, ctx: PickContext): Promise<Picked> {
  if (resolved.kind === 'one') return { kind: 'picked', project: resolved.project };
  const candidates = await candidatesOf(ctx.client, resolved.matches);
  if (ctx.agentMode) {
    const elicitation = chooseElicitation(ctx.org, ctx.ref, candidates, ctx.rerun);
    return { kind: 'needs-choice', elicitation, lines: elicitation.fields[0].options?.map((o) => `  ${o.value}  ${o.label}`) ?? [] };
  }
  const now = new Date();
  const { projectId } = await promptModuleFor(ctx.json)([{
    type: 'list',
    name: 'projectId',
    message: `Which ${ctx.ref}?`, // COPY-FLAG
    choices: candidates.map((c) => ({ name: candidateLabel(c, now), value: c.project.id })),
  }]);
  const chosen = candidates.find((c) => c.project.id === projectId);
  if (chosen === undefined) throw new CapyError(`No project named ${ctx.ref} in this organization.`, ERROR_CODES.PROJECT_NOT_FOUND); // COPY-FLAG
  return { kind: 'picked', project: chosen.project };
}

/** The refusal that hands the choice to the agent: PROJECT_AMBIGUOUS, exit 3, with the elicitation. */
function choiceRefusal(picked: Extract<Picked, { kind: 'needs-choice' }>, ref: string): Refusal {
  return {
    code: ERROR_CODES.PROJECT_AMBIGUOUS,
    message: `More than one project is named ${ref}.`, // COPY-FLAG
    exitCode: EXIT_NEEDS_INPUT,
    extra: { elicitation: picked.elicitation },
    lines: picked.lines,
  };
}

function liveOnly<T extends { revoked_at: string | null }>(tokens: readonly T[]): readonly T[] {
  return tokens.filter((t) => t.revoked_at === null);
}

/** What the person is shown, and the agent is told, about a project before it is deleted. Names only. */
interface DeleteDetails {
  readonly branches: readonly string[];
  readonly variables: readonly VariableBranches[];
  /** The parts that could not be read. Never "none": an unread part is not an empty one. */
  readonly unavailable: readonly ('branches' | 'variables')[];
}

type KeepRead =
  | { readonly kind: 'keep'; readonly variables: readonly VariableBranches[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

/** The slice of the service client `readDeleteDetails` uses. */
interface DeleteDetailsClient {
  listBranches(projectId: string): Promise<ReadonlyArray<{ readonly name: string }>>;
  getLatestSecrets(projectId: string, branch: string): Promise<{ readonly keep_hash: string; readonly keep_file?: string } | null>;
}

/**
 * The variable names of the project's latest keep.lock, as the service returns it (it is one file for every branch).
 * Tries each branch in turn until one returns it. Only names and branches leave this function: the blob that comes
 * with the keep.lock is never read.
 */
async function readKeepVariables(
  client: DeleteDetailsClient,
  projectId: string,
  branches: readonly string[],
  failedBefore: boolean,
): Promise<KeepRead> {
  if (branches.length === 0) return { kind: failedBefore ? 'unavailable' : 'none' };
  const [branch, ...rest] = branches;
  const read = await settle(() => client.getLatestSecrets(projectId, branch));
  if (!read.ok) return readKeepVariables(client, projectId, rest, true);
  const variables = read.value === null ? undefined : variableBranchesFromKeep(read.value.keep_file);
  return variables === undefined ? readKeepVariables(client, projectId, rest, failedBefore) : { kind: 'keep', variables };
}

/** Best effort: a part that cannot be read is reported as `unavailable`, and the question is still asked. */
async function readDeleteDetails(client: DeleteDetailsClient, projectId: string): Promise<DeleteDetails> {
  const listed = await settle(() => client.listBranches(projectId));
  if (!listed.ok || !Array.isArray(listed.value)) return { branches: [], variables: [], unavailable: ['branches', 'variables'] };
  const branches = listed.value.map((b) => b.name);
  const keep = await readKeepVariables(client, projectId, branches, false);
  return {
    branches,
    variables: keep.kind === 'keep' ? keep.variables : [],
    unavailable: keep.kind === 'unavailable' ? ['variables'] : [],
  };
}

interface OrgRef {
  readonly id: string;
  readonly name: string;
}

/** The exact command that answers Yes: the project's id (never its name), and `--force` only if it was passed. */
function deleteYesCommand(projectId: string, force: boolean): string {
  return `capy project delete ${projectId} ${force ? '--force ' : ''}--yes --json`;
}

/** The confirm elicitation for a delete. Names and ids only: a variable is its name and its branches, never more. */
function deleteElicitation(
  org: OrgRef,
  project: ProjectRef,
  tokens: readonly LiveDeployTokenInfo[],
  details: DeleteDetails,
  force: boolean,
): ElicitationConfirm {
  return {
    kind: 'confirm',
    question: `Delete project ${project.name}?`, // COPY-FLAG
    details: {
      org: { id: org.id, name: org.name },
      project: { id: project.id, name: project.name },
      branches: details.branches,
      variables: details.variables.map((v) => ({ name: v.name, branches: v.branches })),
      live_deploy_tokens: tokens.map((t) => ({ deploy_id: t.deploy_id, label: t.label })),
      ...(details.unavailable.length > 0 ? { unavailable: details.unavailable } : {}),
    },
    display: deleteProjectDisplay({
      org,
      project,
      branches: details.branches,
      variables: details.variables,
      liveDeployTokens: tokens,
      unavailable: details.unavailable,
    }),
    answer: { yes: deleteYesCommand(project.id, force) },
  };
}

type DeleteOutcome =
  | { readonly kind: 'dry-run'; readonly project: ProjectRef; readonly tokens: readonly LiveDeployTokenInfo[] }
  | { readonly kind: 'needs-confirmation'; readonly elicitation: ElicitationConfirm; readonly lines: readonly string[] }
  | { readonly kind: 'needs-choice'; readonly refusal: Refusal }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deleted'; readonly result: DeleteProjectResponse };

function summaryLines(org: OrgRef, details: DeleteDetails): readonly string[] {
  return [
    `  Organization: ${org.name}`, // COPY-FLAG
    details.unavailable.includes('branches')
      ? '  Branches: could not be read.' // COPY-FLAG
      : details.branches.length === 0 ? '  No branches.' : `  Branches: ${details.branches.join(', ')}`, // COPY-FLAG
    details.unavailable.includes('variables')
      ? '  Variables: could not be read.' // COPY-FLAG
      : `  Variables: ${details.variables.length}`, // COPY-FLAG
    ...details.variables.map((v) => `    ${v.name}${v.branches.length === 0 ? '' : `  (${v.branches.join(', ')})`}`),
  ];
}

/** What the person is shown about the project. Without `summary` (a dry run) it is the short preview. */
function previewLines(
  project: ProjectRef,
  tokens: readonly LiveDeployTokenInfo[],
  force: boolean,
  summary?: { readonly org: OrgRef; readonly details: DeleteDetails },
): readonly string[] {
  return [
    '',
    `  Project: ${project.name} (${project.id})`, // COPY-FLAG
    ...(summary === undefined ? [] : summaryLines(summary.org, summary.details)),
    tokens.length === 0 ? '  No live deploy tokens.' : `  Live deploy tokens: ${tokens.length}`, // COPY-FLAG
    ...tokens.map((t) => `    ${describeToken(t)}`),
    ...(tokens.length === 0 ? [] : [force
      ? '  --force: those deploys stop on their next restart.' // COPY-FLAG
      : '  Without --force the delete is refused while these exist.']), // COPY-FLAG
    '',
  ];
}

function showPreview(json: boolean, lines: readonly string[]): void {
  lines.forEach((l) => say(json, l));
}

async function deleteFlow(ref: string, opts: DeleteProjectOpts): Promise<DeleteOutcome> {
  const json = opts.json === true;
  const force = opts.force === true;
  const agentMode = json || !isInteractive(opts.nonTty);
  // Agent mode never opens a prompt, not even to pick an organization.
  const { orgId, orgName, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true, { promptForOrg: !agentMode });
  const org: OrgRef = { id: orgId, name: orgName };
  const picked = await pickProject(resolveRef(await serviceClient.listProjects(), ref, false), {
    json,
    agentMode,
    org,
    ref,
    client: serviceClient,
    rerun: `capy project delete <project> ${force ? '--force ' : ''}--json`,
  });
  if (picked.kind === 'needs-choice') return { kind: 'needs-choice', refusal: choiceRefusal(picked, ref) };
  const project = picked.project;

  // The token list is only read when it is shown: a dry run, or a person about to be asked.
  const asks = opts.dryRun !== true && opts.yes !== true;
  const tokens = opts.dryRun === true || asks ? liveOnly((await serviceClient.listDeployTokens(orgId, project.id)).tokens) : [];

  if (opts.dryRun === true) return { kind: 'dry-run', project, tokens };

  if (asks) {
    const details = await readDeleteDetails(serviceClient, project.id);
    const lines = previewLines(project, tokens, force, { org, details });
    // Nobody to ask: hand the question to the agent that ran this, and write nothing.
    if (agentMode) return { kind: 'needs-confirmation', elicitation: deleteElicitation(org, project, tokens, details, force), lines };
    showPreview(json, lines);
    if (!(await confirm(json, `Delete project ${project.name}?`))) return { kind: 'cancelled' }; // COPY-FLAG
  }
  return { kind: 'deleted', result: await serviceClient.deleteProject(orgId, project.id, force) };
}

function restoreHint(id: string): string {
  return `capy project restore ${id}`;
}

function emitDeleteOutcome(json: boolean, force: boolean, outcome: DeleteOutcome): void {
  if (outcome.kind === 'cancelled') {
    if (json) console.log(JSON.stringify({ ok: false, code: ERROR_CODES.CANCELLED, error: 'Cancelled.' }, null, 2)); // COPY-FLAG
    else console.log('Cancelled.'); // COPY-FLAG
    return;
  }
  if (outcome.kind === 'dry-run') {
    const { project, tokens } = outcome;
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        dry_run: true,
        project: { id: project.id, name: project.name },
        live_deploy_tokens: tokens,
        requires_force: tokens.length > 0 && !force,
      }, null, 2));
      return;
    }
    showPreview(false, previewLines(project, tokens, force));
    console.log('Dry run: nothing was deleted.'); // COPY-FLAG
    return;
  }
  if (outcome.kind === 'needs-choice') return refuse(json, outcome.refusal);
  if (outcome.kind === 'needs-confirmation') {
    return refuse(json, {
      code: ERROR_CODES.CONFIRMATION_REQUIRED,
      message: '`capy project delete` needs confirmation. Pass --yes, or run it in a terminal.', // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation },
      lines: outcome.lines,
    });
  }
  const { project, live_deploy_tokens } = outcome.result;
  if (json) {
    console.log(JSON.stringify({ ok: true, project, live_deploy_tokens }, null, 2));
    return;
  }
  console.log(`Deleted project ${project.name}.`); // COPY-FLAG
  console.log(`An owner can restore it with: ${restoreHint(project.id)}`); // COPY-FLAG
}

/** `capy project delete <name-or-id> [--force] [--yes] [--dry-run] [--json]` */
export async function deleteProjectCommand(ref: string, opts: DeleteProjectOpts): Promise<void> {
  const json = opts.json === true;

  // No terminal and no --yes means nobody can answer: the flow stops with the question as an elicitation (exit 3).
  // It reads the project first, because the question has to say what would be deleted. A dry run asks nothing.
  const settled = await settle(() => deleteFlow(ref, opts));
  if (!settled.ok) return refuse(json, refusalFor(settled.error));
  emitDeleteOutcome(json, opts.force === true, settled.value);
}

type RestoreOutcome =
  | { readonly kind: 'dry-run'; readonly project: ProjectRef }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'needs-choice'; readonly refusal: Refusal }
  | { readonly kind: 'needs-confirmation'; readonly elicitation: ElicitationConfirm }
  | { readonly kind: 'restored'; readonly project: { readonly id: string; readonly name: string } };

/** The confirm elicitation for a restore: the project, its org and when it was deleted. The yes command names the project by id. */
function restoreElicitation(org: OrgRef, project: ProjectRef): ElicitationConfirm {
  const deletedAt = project.deleted_at ?? null;
  return {
    kind: 'confirm',
    question: `Restore project ${project.name}?`, // COPY-FLAG: the terminal question, word for word
    details: {
      org: { id: org.id, name: org.name },
      project: { id: project.id, name: project.name, deleted_at: deletedAt },
    },
    display: restoreProjectDisplay({ org, project: { id: project.id, name: project.name }, deletedAt }),
    answer: { yes: `capy project restore ${project.id} --yes --json` },
  };
}

async function restoreFlow(ref: string, opts: RestoreProjectOpts): Promise<RestoreOutcome> {
  const json = opts.json === true;
  const agentMode = json || !isInteractive(opts.nonTty);
  // Agent mode never opens a prompt, not even to pick an organization.
  const { orgId, orgName, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true, { promptForOrg: !agentMode });
  const org: OrgRef = { id: orgId, name: orgName };
  // Only an owner's `include_deleted` is honoured; for anyone else the service answers with the live projects, and the id still works.
  const picked = await pickProject(resolveRef(await serviceClient.listProjects({ includeDeleted: true }), ref, true), {
    json,
    agentMode,
    org,
    ref,
    client: serviceClient,
    rerun: `capy project restore <project> ${opts.yes === true ? '--yes ' : ''}--json`,
  });
  if (picked.kind === 'needs-choice') return { kind: 'needs-choice', refusal: choiceRefusal(picked, ref) };
  const project = picked.project;
  // A dry run reads which project would come back and stops before anything that writes.
  if (opts.dryRun === true) return { kind: 'dry-run', project };

  if (opts.yes !== true) {
    // Nobody to ask: hand the question to the agent that ran this, and restore nothing.
    if (agentMode) return { kind: 'needs-confirmation', elicitation: restoreElicitation(org, project) };
    if (!(await confirm(json, `Restore project ${project.name}?`))) return { kind: 'cancelled' }; // COPY-FLAG
  }

  const result = await serviceClient.restoreProject(orgId, project.id);
  return { kind: 'restored', project: result.project };
}

function emitRestoreOutcome(json: boolean, outcome: RestoreOutcome): void {
  if (outcome.kind === 'dry-run') {
    const { project } = outcome;
    if (json) {
      console.log(JSON.stringify({ ok: true, dry_run: true, project: { id: project.id, name: project.name } }, null, 2));
      return;
    }
    console.log(`Would restore project ${project.name} (${project.id}).`); // COPY-FLAG
    console.log('Dry run: nothing was restored.'); // COPY-FLAG
    return;
  }
  if (outcome.kind === 'needs-choice') return refuse(json, outcome.refusal);
  if (outcome.kind === 'needs-confirmation') {
    return refuse(json, {
      code: ERROR_CODES.CONFIRMATION_REQUIRED,
      message: '`capy project restore` needs confirmation. Pass --yes, or run it in a terminal.', // COPY-FLAG
      exitCode: EXIT_NEEDS_INPUT,
      extra: { elicitation: outcome.elicitation },
    });
  }
  if (outcome.kind === 'cancelled') {
    if (json) console.log(JSON.stringify({ ok: false, code: ERROR_CODES.CANCELLED, error: 'Cancelled.' }, null, 2)); // COPY-FLAG
    else console.log('Cancelled.'); // COPY-FLAG
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, project: outcome.project }, null, 2));
    return;
  }
  console.log(`Restored project ${outcome.project.name}.`); // COPY-FLAG
}

/** `capy project restore <name-or-id> [--yes] [--dry-run] [--json]` */
export async function restoreProjectCommand(ref: string, opts: RestoreProjectOpts): Promise<void> {
  const json = opts.json === true;

  // No terminal and no --yes means nobody can answer: the flow stops with the question as an elicitation (exit 3).
  // It reads the project first, because the question has to say what would be restored.
  const settled = await settle(() => restoreFlow(ref, opts));
  if (!settled.ok) return refuse(json, refusalFor(settled.error));
  emitRestoreOutcome(json, settled.value);
}
