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
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import { DRY_RUN_UNSUPPORTED_MESSAGES } from './pipedValue';
import { listTargets } from '../deploy/config';
import { CapyError, ERROR_CODES } from '../types/index';
import { checkFolder, isSecretsConflict } from '../sync/commit';
import { conflictFlagsOrExit, exitOnConflictRefusal, hasConflictFlags, previewDecider, type RawConflictFlags } from '../sync/conflicts';
import {
  previewKeepLockPrStep,
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
  /** The global `--dry-run`: say what would be removed; change nothing. The confirmation prompt refuses (`DRY_RUN_UNSUPPORTED`). */
  dryRun?: boolean;
  /** `--resolve` / `--conflict` as typed (CAP-717): they decide a conflict on a name being removed. */
  conflictFlags?: RawConflictFlags;
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
 * — the deploy-target warning, the push, and the output.
 *
 * Split out from `RemoveCommand.execute` so it is directly testable with a
 * hand-built `ResolvedContext` (the same technique
 * `connectors/shared.ts`'s own `writeImportedAndSync` tests use), with no
 * real auth or network involved.
 */
export async function proceedWithRemoval(
  ctx: ResolvedContext,
  names: readonly string[],
  opts: { json: boolean; cwd: string; pr?: PrFlags; nonTty?: boolean; dryRun?: boolean },
): Promise<void> {
  const warnings = deployTargetWarnings(opts.cwd, names);

  if (opts.dryRun === true) {
    // A name someone else changed since this folder's pin is reported with its conflict_id; nothing is written either way.
    await checkFolder(ctx, { set: {}, remove: names }, { decide: previewDecider }).catch((err: unknown) => {
      exitOnConflictRefusal(err);
      return Promise.reject(err);
    });
    // Everything above only read. Nothing below this line runs: no removal, no push, no PR.
    const preview = await previewKeepLockPrStep({ changed: true, cwd: opts.cwd, flags: opts.pr ?? {} });
    if (opts.json) {
      console.log(
        JSON.stringify(
          withKeepLock(
            {
              removed: names,
              branch: ctx.branch,
              dry_run: true,
              ...(warnings.length > 0 ? { warnings: warnings.map(formatDeployWarning) } : {}),
            },
            preview,
          ),
          null,
          2,
        ),
      );
      return;
    }
    console.error(`Dry run: would remove ${names.join(', ')} from ${ctx.branch}. Nothing was changed.`); // COPY-FLAG
    warnings.forEach((w) => console.error(formatDeployWarning(w)));
    return;
  }

  // A name someone else changed on the server since this folder's pin is a refusal, not a silent overwrite:
  // the protocol's payload when the command follows it (exit 3), the plain refusal otherwise.
  await removeAndSync(ctx, names).catch((err: unknown) => {
    exitOnConflictRefusal(err);
    return isSecretsConflict(err) ? refuse(opts.json, err) : Promise.reject(err);
  });

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
    const flags = conflictFlagsOrExit(opts.conflictFlags ?? {}, json);
    // The confirmation prompt would really remove: a dry run never runs for real. Before anything else.
    if (opts.dryRun === true && opts.yes !== true && !json && isInteractive(opts.nonTty)) {
      refuse(json, new CapyError(DRY_RUN_UNSUPPORTED_MESSAGES.remove, ERROR_CODES.DRY_RUN_UNSUPPORTED));
    }
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

    // A dry run never asks and never needs `--yes`: it only says what would be removed.
    if (!opts.yes && opts.dryRun !== true) {
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
    // authenticate and decrypt `.env`, which the push needs.
    // Off a terminal (or given --resolve), a conflict follows the protocol: nothing is removed, exit 3, the payload on stdout.
    const protocol = json || !isInteractive(opts.nonTty) || hasConflictFlags(flags);
    const ctx = await resolveContext({ devMode: this.devMode, json, dryRun: opts.dryRun === true, ...(protocol ? { conflicts: flags } : {}) });
    await proceedWithRemoval(ctx, names, { json, cwd: process.cwd(), pr: opts.pr, nonTty: opts.nonTty, dryRun: opts.dryRun === true });
  }
}
