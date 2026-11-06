/**
 * `capy org delete-project` and `capy org restore-project` (CAP-729).
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
 */
import inquirer from 'inquirer';
import { resolveOrgContext } from '../core/orgContext';
import { excludeSystemProject } from '../system/reservedProjectName';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { CapyError, ERROR_CODES } from '../types/index';
import type { DeleteProjectResponse, LiveDeployTokenInfo } from '../service/serviceClient';

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

interface ProjectRef {
  id: string;
  name: string;
  deleted_at?: string | null;
}

/** The 403 codes the service sends that reach the client as a PERMISSION_DENIED with the server's code in `details.code`. */
const CODED_FORBIDDEN: ReadonlySet<string> = new Set([
  ERROR_CODES.PROJECT_DELETE_OWNER_ONLY,
  ERROR_CODES.SYSTEM_STORE_IMMUTABLE,
]);

interface Refusal {
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

function refusalFor(err: unknown): Refusal {
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
  if (code === ERROR_CODES.PROJECT_AMBIGUOUS) {
    const matches: readonly ProjectRef[] = Array.isArray(err.details?.matches) ? err.details.matches : [];
    return {
      code,
      message: err.message,
      exitCode: 1,
      extra: { matches: matches.map((m) => ({ id: m.id, name: m.name })) },
      lines: matches.map((m) => `  ${m.id}  ${m.name}`),
    };
  }
  return { code, message: err.message, exitCode: 1 };
}

/** The refusal on the right stream: JSON on stdout under `--json`, prose on stderr otherwise. Never returns. */
function refuse(json: boolean, r: Refusal): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, code: r.code, error: r.message, ...(r.extra ?? {}) }, null, 2));
  } else {
    console.error(r.message);
    (r.lines ?? []).forEach((l) => console.error(l));
  }
  return process.exit(r.exitCode);
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Runs `fn` and returns what it threw as a value, so a refusal's `process.exit` is never caught by the code that raised it. */
async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
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

/**
 * One project, or a coded refusal. No match is passed through as an id: the service answers PROJECT_NOT_FOUND for a typo,
 * and a non-owner (whose listing hides deleted projects) still gets the owner-only refusal rather than a vague "not found".
 */
function pickOne(projects: readonly ProjectRef[], ref: string, preferDeleted: boolean): ProjectRef {
  const matches = matchProjects(projects, ref, preferDeleted);
  if (matches.length === 0) return { id: ref, name: ref };
  if (matches.length === 1) return matches[0];
  throw new CapyError(
    `More than one project matches "${ref}". Use the id.`, // COPY-FLAG
    ERROR_CODES.PROJECT_AMBIGUOUS,
    { matches },
  );
}

function refuseWithoutTerminal(json: boolean, what: string): never {
  return refuse(json, {
    code: ERROR_CODES.CONFIRMATION_REQUIRED,
    message: `\`${what}\` needs confirmation. Pass --yes, or run it in a terminal.`, // COPY-FLAG
    exitCode: EXIT_NEEDS_INPUT,
  });
}

function liveOnly<T extends { revoked_at: string | null }>(tokens: readonly T[]): readonly T[] {
  return tokens.filter((t) => t.revoked_at === null);
}

type DeleteOutcome =
  | { readonly kind: 'dry-run'; readonly project: ProjectRef; readonly tokens: readonly LiveDeployTokenInfo[] }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deleted'; readonly result: DeleteProjectResponse };

function showPreview(json: boolean, project: ProjectRef, tokens: readonly LiveDeployTokenInfo[], force: boolean): void {
  say(json, '');
  say(json, `  Project: ${project.name} (${project.id})`); // COPY-FLAG
  say(json, tokens.length === 0 ? '  No live deploy tokens.' : `  Live deploy tokens: ${tokens.length}`); // COPY-FLAG
  tokens.forEach((t) => say(json, `    ${describeToken(t)}`));
  if (tokens.length > 0) {
    say(json, force
      ? '  --force: those deploys stop on their next restart.' // COPY-FLAG
      : '  Without --force the delete is refused while these exist.'); // COPY-FLAG
  }
  say(json, '');
}

async function deleteFlow(ref: string, opts: DeleteProjectOpts): Promise<DeleteOutcome> {
  const json = opts.json === true;
  const force = opts.force === true;
  const { orgId, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true);
  const project = pickOne(await serviceClient.listProjects(), ref, false);

  // The token list is only read when it is shown: a dry run, or a person about to be asked.
  const showsPreview = opts.dryRun === true || opts.yes !== true;
  const tokens = showsPreview ? liveOnly((await serviceClient.listDeployTokens(orgId, project.id)).tokens) : [];

  if (opts.dryRun === true) return { kind: 'dry-run', project, tokens };

  if (opts.yes !== true) {
    showPreview(json, project, tokens, force);
    if (!(await confirm(json, `Delete project ${project.name}?`))) return { kind: 'cancelled' }; // COPY-FLAG
  }
  return { kind: 'deleted', result: await serviceClient.deleteProject(orgId, project.id, force) };
}

function restoreHint(id: string): string {
  return `capy org restore-project ${id}`;
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
    showPreview(false, project, tokens, force);
    console.log('Dry run: nothing was deleted.'); // COPY-FLAG
    return;
  }
  const { project, live_deploy_tokens } = outcome.result;
  if (json) {
    console.log(JSON.stringify({ ok: true, project, live_deploy_tokens }, null, 2));
    return;
  }
  console.log(`Deleted project ${project.name}.`); // COPY-FLAG
  console.log(`An owner can restore it with: ${restoreHint(project.id)}`); // COPY-FLAG
}

/** `capy org delete-project <name-or-id> [--force] [--yes] [--dry-run] [--json]` */
export async function deleteProjectCommand(ref: string, opts: DeleteProjectOpts): Promise<void> {
  const json = opts.json === true;

  // Before any network call: no terminal and no --yes means nobody can answer. A dry run asks nothing.
  if (opts.dryRun !== true && opts.yes !== true && !isInteractive(opts.nonTty)) {
    refuseWithoutTerminal(json, 'capy org delete-project');
  }

  const settled = await settle(() => deleteFlow(ref, opts));
  if (!settled.ok) return refuse(json, refusalFor(settled.error));
  emitDeleteOutcome(json, opts.force === true, settled.value);
}

type RestoreOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'restored'; readonly project: { readonly id: string; readonly name: string } };

async function restoreFlow(ref: string, opts: ProjectLifecycleOpts): Promise<RestoreOutcome> {
  const json = opts.json === true;
  const { orgId, serviceClient } = await resolveOrgContext(opts.apiUrl, opts.devMode === true);
  // Only an owner's `include_deleted` is honoured; for anyone else the service answers with the live projects, and the id still works.
  const project = pickOne(await serviceClient.listProjects({ includeDeleted: true }), ref, true);

  if (opts.yes !== true && !(await confirm(json, `Restore project ${project.name}?`))) return { kind: 'cancelled' }; // COPY-FLAG

  const result = await serviceClient.restoreProject(orgId, project.id);
  return { kind: 'restored', project: result.project };
}

function emitRestoreOutcome(json: boolean, outcome: RestoreOutcome): void {
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

/** `capy org restore-project <name-or-id> [--yes] [--json]` */
export async function restoreProjectCommand(ref: string, opts: ProjectLifecycleOpts): Promise<void> {
  const json = opts.json === true;

  if (opts.yes !== true && !isInteractive(opts.nonTty)) {
    refuseWithoutTerminal(json, 'capy org restore-project');
  }

  const settled = await settle(() => restoreFlow(ref, opts));
  if (!settled.ok) return refuse(json, refusalFor(settled.error));
  emitRestoreOutcome(json, settled.value);
}
