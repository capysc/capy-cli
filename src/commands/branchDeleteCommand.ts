/**
 * `capy branch -D <name>` — delete one secret branch.
 *
 * It asks first. With no terminal to ask in (stdin is not a terminal, `--json`, or `--non-tty`) and no `--yes`, it
 * refuses with CONFIRMATION_REQUIRED (exit 3) before it prints a prompt, authenticates or sends anything — the same
 * gate, exit code and `--json` shape as `capy remove` and `capy project delete`. On a terminal without `--yes` the
 * prompt and its wording are unchanged.
 *
 * Every refusal under `--json` is coded and pure JSON on stdout (`{ ok: false, code, error }`); prose only goes to
 * stderr, and only in human mode. A refusal from the service passes its own `code` through when it sends one; the
 * message is shown, never parsed.
 *
 * The work lives here, once, for both entrypoints (`index.ts`, `index-dev.ts`).
 */
import type { Branch } from '../types/index';
import { CapyError, ERROR_CODES } from '../types/index';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { refuse, settle, type Refusal } from './projectLifecycleCommand';
import { commandLine, confirmElicitation, needsHumanYes } from './agentConfirm';

export interface BranchDeleteOpts {
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly nonTty?: boolean;
}

export interface BranchDeleteDeps {
  readonly projectId: string;
  readonly activeBranch: string | null | undefined;
  /** The command that switches branches, for the "cannot delete the current branch" line (`capy` or `capy-dev`). */
  readonly checkoutHint: string;
  /** Wraps the command in the terminal's bold; the plain text goes in `--json`. */
  readonly emphasize: (s: string) => string;
  readonly listBranches: (projectId: string) => Promise<readonly Branch[]>;
  readonly deleteBranch: (projectId: string, branchId: string) => Promise<void>;
  /** The terminal question. Only called on a terminal, without `--yes`. */
  readonly confirm: (message: string) => Promise<boolean>;
}

type Outcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'is-current' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'deleted'; readonly branch: Branch };

/** True when `-D` cannot ask: no `--yes`, and `--json`, `--non-tty` or a stdin that is not a terminal. */
export function needsConfirmation(opts: BranchDeleteOpts): boolean {
  if (opts.yes === true) return false;
  return opts.json === true || !isInteractive(opts.nonTty);
}

/**
 * The refusal for `needsConfirmation`: nothing is printed as a prompt, nothing is sent, nothing is deleted. Never
 * returns. Agent mode, so always JSON, with a `confirm` asking the terminal's question (spec 3l, CAP-909).
 */
export function refuseNeedsConfirmation(name: string, devMode: boolean): never {
  return refuse(true, {
    code: ERROR_CODES.CONFIRMATION_REQUIRED,
    message: needsHumanYes('capy branch -D'),
    exitCode: EXIT_NEEDS_INPUT,
    extra: {
      elicitation: confirmElicitation({
        question: deletePromptMessage(name),
        rows: [['Branch', name], ['Secrets', 'all of this branch\'s values are deleted']], // COPY-FLAG
        details: { branch: { name } },
        yes: commandLine(devMode, ['branch', '-D', name, '--yes', '--json']),
      }),
    },
  });
}

/** The confirmation question, word for word what the prompt has always said. */
export function deletePromptMessage(name: string): string {
  return `Delete branch "${name}"? This will remove all its secrets.`;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The machine-readable code of a failed request: the service's own `code` field when its response carried one
 * (in the body, or on a 403 where the client lifts it), else the client's classification.
 */
export function codeOfFailure(err: unknown): string {
  if (!(err instanceof CapyError)) return ERROR_CODES.SERVICE_ERROR;
  const body: unknown = err.details?.data;
  const fromBody = typeof body === 'object' && body !== null ? stringOrUndefined((body as { code?: unknown }).code) : undefined;
  return fromBody ?? stringOrUndefined(err.details?.code) ?? err.code;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deleteFlow(deps: BranchDeleteDeps, name: string, opts: BranchDeleteOpts): Promise<Outcome> {
  const branches = await deps.listBranches(deps.projectId);
  const branch = branches.find((b) => b.name === name);
  if (!branch) return { kind: 'not-found' };
  if (branch.name === deps.activeBranch) return { kind: 'is-current' };
  // Without `--yes` this only runs on a terminal: `needsConfirmation` refused every other case before any request.
  if (opts.yes !== true && !(await deps.confirm(deletePromptMessage(name)))) return { kind: 'declined' };
  await deps.deleteBranch(deps.projectId, branch.id);
  return { kind: 'deleted', branch };
}

function currentBranchMessage(deps: BranchDeleteDeps, emphasize: (s: string) => string): string {
  return `Cannot delete the current branch. Switch first with: ${emphasize(`${deps.checkoutHint} checkout <other-branch>`)}`;
}

function outcomeRefusal(deps: BranchDeleteDeps, name: string, json: boolean, kind: 'not-found' | 'is-current'): Refusal {
  if (kind === 'not-found') {
    return { code: ERROR_CODES.BRANCH_NOT_FOUND, message: `Branch "${name}" not found`, exitCode: 1 };
  }
  // The terminal's bold is for people; `--json` carries the plain text.
  const emphasize = json ? (s: string) => s : deps.emphasize;
  return {
    code: ERROR_CODES.CANNOT_DELETE_CURRENT_BRANCH,
    message: currentBranchMessage(deps, emphasize),
    exitCode: 1,
  };
}

/** The two stops that were always plain `console.log` + exit 1 in human mode stay exactly that; `--json` gets the coded refusal. */
function stopOnOutcome(deps: BranchDeleteDeps, name: string, json: boolean, kind: 'not-found' | 'is-current'): never {
  const refusal = outcomeRefusal(deps, name, json, kind);
  if (json) return refuse(true, refusal);
  console.log(refusal.message);
  return process.exit(refusal.exitCode);
}

/**
 * Runs the delete. A failed request is shown by the caller's error screen in human mode (rethrown), and as
 * `{ ok: false, code, error }` under `--json`.
 */
export async function runBranchDelete(deps: BranchDeleteDeps, name: string, opts: BranchDeleteOpts): Promise<void> {
  const json = opts.json === true;
  const settled = await settle(() => deleteFlow(deps, name, opts));
  if (!settled.ok) {
    if (!json) throw settled.error;
    return refuse(true, { code: codeOfFailure(settled.error), message: messageOf(settled.error), exitCode: 1 });
  }
  const outcome = settled.value;
  if (outcome.kind === 'not-found' || outcome.kind === 'is-current') return stopOnOutcome(deps, name, json, outcome.kind);
  if (outcome.kind === 'declined') return;
  if (json) {
    console.log(JSON.stringify({ ok: true, branch: { id: outcome.branch.id, name: outcome.branch.name } }, null, 2));
    return;
  }
  console.log(`Deleted branch "${name}"`);
}

/** The terminal question, via inquirer — the same prompt `capy branch -D` has always shown. */
export async function promptConfirm(message: string): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message,
    default: false,
  }]);
  return confirm === true;
}
