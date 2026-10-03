/**
 * `capy remove NAME [NAME...]` (CAP-686) — delete variables from the ACTIVE
 * branch only. Other branches are untouched.
 *
 * Every refusal is coded (cardinal Rule: never branch on human-readable
 * strings) and `--json` output is pure JSON on stdout; prose only goes to
 * stderr, and only in human mode — same contract as `capy system set/rm`
 * (`systemCommand.ts`), which this file's shape mirrors closely.
 *
 * Cheap, local-only checks (name validity, VAR_NOT_FOUND, the TTY/confirm
 * gate) run BEFORE `resolveContext()` — which authenticates and decrypts
 * `.env` — the same ordering `rotateCommand.ts` uses so an unknown name or a
 * missing terminal is refused without ever touching the network.
 */
import inquirer from 'inquirer';
import { ProjectManager } from '../core/projectManager';
import { resolveContext, removeAndSync, listAllVarsOnBranch, ResolvedContext } from './connectors/shared';
import { hashValue } from './statusCommand';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { listTargets } from '../deploy/config';
import { CapyError, ERROR_CODES, KeepFile } from '../types/index';
import {
  recordsForRemoval,
  refuseBadPrFlags,
  reportKeepLockHuman,
  runKeepLockPrStep,
  withKeepLock,
  type PrFlags,
} from './keepLockPr';

export interface RemoveOpts {
  yes?: boolean;
  json?: boolean;
  nonTty?: boolean;
  /** `--pr` / `--no-pr` / `--pr-base`: answers the keep.lock PR step. */
  pr?: PrFlags;
}

/** Pure JSON refusal on stdout — never on stderr, so `--json` output stays parseable. */
function refuseJson(code: string, error: string, details: Record<string, unknown> | undefined, exitCode: number): never {
  console.log(JSON.stringify({ ok: false, code, error, ...(details ?? {}) }, null, 2));
  process.exit(exitCode);
}

/** Prose refusal on stderr — human mode only. */
function refuseHuman(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

function refuse(json: boolean, err: CapyError, exitCode: number = 1): never {
  if (json) refuseJson(err.code, err.message, err.details as Record<string, unknown> | undefined, exitCode);
  refuseHuman(err.message, exitCode);
}

/** Pinned value hashes for `branch`, keyed by variable name — same shape editCommand/statusCommand build. */
export function pinnedHashesFor(keep: KeepFile, branch: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(keep.variables).flatMap(([varName, entries]) => {
      const entry = entries.find((e) => e.branch === branch);
      return entry ? ([[varName, entry.value_hash]] as const) : [];
    }),
  );
}

/**
 * Names, OTHER than the ones being removed, whose local `.env` value
 * disagrees with the pinned baseline — new locally, changed locally, or
 * pinned but missing from `.env` entirely. Any of these would ride along,
 * unrelated, on the push `capy remove` is about to make.
 */
export function computeDrift(
  pinned: Record<string, string>,
  localPlaintext: Record<string, string>,
  removedNames: readonly string[],
): string[] {
  const removed = new Set(removedNames);
  const otherKeys = new Set(
    [...Object.keys(pinned), ...Object.keys(localPlaintext)].filter((k) => !removed.has(k)),
  );
  return Array.from(otherKeys)
    .filter((k) => pinned[k] !== (localPlaintext[k] !== undefined ? hashValue(localPlaintext[k]) : undefined))
    .sort();
}

export interface DeployTargetWarning {
  target: string;
  variable: string;
}

/** `.capy/deploy.json` targets whose `vars` include one of `removedNames`. Read-only — never edits deploy.json. */
export function deployTargetWarnings(cwd: string, removedNames: readonly string[]): DeployTargetWarning[] {
  const removed = new Set(removedNames);
  return listTargets(cwd).flatMap((target) =>
    target.vars.filter((v) => removed.has(v)).map((variable) => ({ target: target.name, variable })),
  );
}

/** `capy remove A, B from development` — the terminal confirm, with an explicit note when it clears the whole branch. */
export function confirmationMessage(names: readonly string[], branch: string, removingAll: boolean): string {
  const all = removingAll ? ' — this removes EVERY variable on this branch' : ''; // COPY-FLAG
  return `Remove ${names.join(', ')} from ${branch}${all}?`; // COPY-FLAG
}

function formatDeployWarning(w: DeployTargetWarning): string {
  return `Deploy target "${w.target}" still lists ${w.variable} in its vars.`; // COPY-FLAG
}

async function promptRemovalConfirmation(message: string): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    { type: 'confirm', name: 'confirmed', message, default: false },
  ]);
  return confirmed === true;
}

/**
 * Everything that needs `ctx` (an authenticated, decrypted `ResolvedContext`)
 * — the drift check, the deploy-target warning, the push, and the output.
 *
 * Split out from `RemoveCommand.execute` so it is directly testable with a
 * hand-built `ResolvedContext` (the same technique
 * `connectors/shared.ts`'s own `writeImportedAndSync` tests use), with no
 * real auth or network involved.
 */
export async function proceedWithRemoval(
  ctx: ResolvedContext,
  names: readonly string[],
  opts: { json: boolean; cwd: string; pr?: PrFlags; nonTty?: boolean },
): Promise<void> {
  const pinned = pinnedHashesFor(ctx.keep, ctx.branch);
  const drifted = computeDrift(pinned, ctx.localPlaintext, names);
  if (drifted.length > 0) {
    refuse(
      opts.json,
      new CapyError(
        `${drifted.join(', ')} ${drifted.length === 1 ? 'has' : 'have'} unpushed local changes. Push or revert them before removing.`, // COPY-FLAG
        ERROR_CODES.REMOVE_LOCAL_DRIFT,
        { drifted },
      ),
    );
  }

  const warnings = deployTargetWarnings(opts.cwd, names);

  await removeAndSync(ctx, names);

  // The removal is done whatever the PR step reports (it never throws).
  const outcome = await runKeepLockPrStep({
    command: 'remove',
    cwd: opts.cwd,
    records: recordsForRemoval(ctx.branch, names),
    localKeep: ctx.keep,
    flags: opts.pr ?? {},
    json: opts.json,
    nonTty: opts.nonTty,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        withKeepLock(
          {
            removed: names,
            branch: ctx.branch,
            ...(warnings.length > 0 ? { warnings: warnings.map(formatDeployWarning) } : {}),
          },
          outcome,
        ),
        null,
        2,
      ),
    );
    return;
  }

  for (const name of names) {
    console.log(`✓ Removed ${name}`); // COPY-FLAG
  }
  console.log(`Done. Removed ${names.length} variable(s) from ${ctx.branch}.`); // COPY-FLAG
  for (const w of warnings) {
    console.error(formatDeployWarning(w));
  }
  reportKeepLockHuman(outcome, { successTo: 'stdout', noteUnanswered: false });
}

export class RemoveCommand {
  constructor(private readonly devMode: boolean = false) {}

  async execute(varNames: string[], opts: RemoveOpts): Promise<void> {
    const json = opts.json === true;
    // Contradictory PR flags are refused before anything is changed.
    refuseBadPrFlags(opts.pr ?? {}, json);
    const names = varNames.map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
      refuse(json, new CapyError('No variable name given.', ERROR_CODES.INVALID_FORMAT));
    }

    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.deriveActiveBranch();

    if (!keep) {
      refuse(json, new CapyError('No keep.lock found in this directory. Run `capy` to initialize.', ERROR_CODES.NO_KEEP_FILE)); // COPY-FLAG
    }
    if (!branch) {
      refuse(json, new CapyError('No active branch. Run `capy` to select a branch.', ERROR_CODES.NO_ACTIVE_BRANCH)); // COPY-FLAG
    }

    const allVars = listAllVarsOnBranch(keep, branch);
    const missing = names.filter((n) => !allVars.includes(n));
    if (missing.length > 0) {
      refuse(
        json,
        new CapyError(
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on branch ${branch}.`, // COPY-FLAG
          ERROR_CODES.VAR_NOT_FOUND,
          { missing, branch, available: allVars },
        ),
      );
    }

    const removingAll = allVars.length === names.length && allVars.every((v) => names.includes(v));

    if (!opts.yes) {
      if (json || !isInteractive(opts.nonTty)) {
        refuse(
          json,
          new CapyError(
            '`capy remove` needs confirmation — pass --yes or run this in a terminal.', // COPY-FLAG
            ERROR_CODES.REMOVE_NEEDS_TTY,
          ),
          EXIT_NEEDS_INPUT,
        );
      }
      const confirmed = await promptRemovalConfirmation(confirmationMessage(names, branch, removingAll));
      if (!confirmed) {
        console.log('Cancelled.'); // COPY-FLAG
        return;
      }
    }

    // Everything above is local-only — no auth, no network. Only now do we
    // authenticate and decrypt `.env`, which the drift check and the push
    // both need.
    const ctx = await resolveContext({ devMode: this.devMode });
    await proceedWithRemoval(ctx, names, { json, cwd: process.cwd(), pr: opts.pr, nonTty: opts.nonTty });
  }
}
