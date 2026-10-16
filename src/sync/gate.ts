/**
 * Bare `capy` runs first (CAP-711; the contract is docs/conflict-resolution.md).
 *
 * Every command that writes from a folder (`capy edit`, `add`, `remove`, `connect` (discovery too), `rotate`, `push`,
 * `deploy` in every mode, `deploy revoke`, `deploy targets-remove`) calls `gateFirst` as its VERY FIRST step, before any prompt, preflight, plan or confirm screen, and nothing
 * lets a command skip it. It runs bare `capy`'s own sync (`CapyCommand.runSync`: the code `capy` runs, not a
 * copy) and then runs it again until the folder and Capy agree on every variable of the branch, or until the
 * person cancels or chooses "Continue working", in which case the command writes nothing and ends.
 *
 * Off a terminal (`--non-tty`, `--json`, an agent, CI, or given `--resolve`) nobody can answer bare `capy`'s
 * menu: the differences stop the command (exit 3, the rows and a `conflict_id` on stdout), and a rerun with
 * `--resolve` + `--conflict` answers them (sync/conflicts.ts).
 *
 * After the gate the folder equals Capy for the branch, so the command applies ONLY its own change on top of
 * Capy's latest and uploads it with `base_keep_hash` (sync/commit.ts). If the server refuses that upload as stale
 * (someone saved in between) the command runs this gate again and tries once more (`commitGated`).
 */
import { existsSync } from 'fs';
import { isInteractive } from '../ui/interactive';
import {
  exitOnConflictRefusal,
  hasConflictFlags,
  isConflictRefusal,
  parseConflictFlags,
  type ConflictPayload,
  type RawConflictFlags,
} from './conflicts';
import {
  commitFolder,
  isStaleBase,
  readLocalPlaintext,
  type Changes,
  type FolderCommit,
  type FolderCommitOptions,
  type FolderContext,
} from './commit';
import { CapyError, ERROR_CODES } from '../types/index';
import type { SyncOutcome } from '../commands/capyCommand';

export interface GateOptions {
  readonly devMode?: boolean;
  /** `--json`: stdout belongs to the command's JSON, so the differences are reported rather than asked. */
  readonly json?: boolean;
  /** `--non-tty`: treat stdin as not a terminal even when it is one. */
  readonly nonTty?: boolean;
  /** `--resolve` / `--conflict` as typed. */
  readonly conflictFlags?: RawConflictFlags;
  /** The command is a `--dry-run`: differences are reported (with `dry_run`), never answered or applied. */
  readonly dryRun?: boolean;
  /** How a failure of the sync itself (no session, Capy unreachable) ends the command. Default: coded JSON under `--json`, the error screen otherwise. */
  readonly refuse?: (err: unknown) => never;
  /**
   * The folder bare `capy` runs in, when it is not the working directory (discovery writes into other checkouts).
   * A folder that does not exist yet has nothing to compare, so it counts as in sync.
   */
  readonly cwd?: string;
  /** A difference nobody can answer is thrown to the caller instead of ending the process (a multi-folder run reports it per folder). */
  readonly throwConflicts?: boolean;
}

/** `in-sync`: the command may go on. `stopped`: the person cancelled; the command writes nothing and ends (exit 0). */
export type GateResult = 'in-sync' | 'stopped';

/** One run of bare `capy`'s sync. Injected so a test can stand in for the whole of Keep. */
export type SyncRunner = (opts: GateOptions, protocol: boolean) => Promise<SyncOutcome>;

/** Whether the typed `--resolve` / `--conflict` are there. A malformed flag counts: the command refuses it on its own, before anything is read. */
function givesFlags(raw: RawConflictFlags): boolean {
  try {
    return hasConflictFlags(parseConflictFlags(raw));
  } catch {
    return true;
  }
}

/** Whether the differences are answered by `--resolve` instead of asked: off a terminal, under `--json` or `--dry-run`, or given those flags. */
export function answersByProtocol(opts: GateOptions): boolean {
  return opts.dryRun === true || opts.json === true || !isInteractive(opts.nonTty) || givesFlags(opts.conflictFlags ?? {});
}

/**
 * `work` with `dir` as the working directory, then back. Bare `capy` is written against the working directory (its
 * managers, git, the kick cleanup), so another checkout is synced by standing in it, not by a second implementation.
 * Callers run one folder at a time: nothing else may run while the directory is changed.
 */
async function inDirectory<T>(dir: string | undefined, work: () => Promise<T>, absent: T): Promise<T> {
  if (dir === undefined) return work();
  if (!existsSync(dir)) return absent;
  const origin = process.cwd();
  process.chdir(dir);
  try {
    return await work();
  } finally {
    process.chdir(origin);
  }
}

/** The real runner: a fresh `CapyCommand` doing exactly what `capy` does, in `opts.cwd` when given. */
const runBareCapy: SyncRunner = (opts, protocol) =>
  inDirectory<SyncOutcome>(
    opts.cwd,
    async () => {
      const { CapyCommand } = await import('../commands/capyCommand');
      return new CapyCommand({ protocol, silentAuthOnly: protocol, quiet: true, conflictFlags: opts.conflictFlags, dryRun: opts.dryRun }, opts.devMode === true).runSync();
    },
    'up-to-date',
  );

async function repeat(run: () => Promise<SyncOutcome>): Promise<GateResult> {
  const outcome = await run();
  if (outcome === 'up-to-date') return 'in-sync';
  if (outcome === 'stopped') return 'stopped';
  // The sync changed something: compare again. Any difference left (e.g. after "Individually resolve") shows the menu again.
  return repeat(run);
}

/** Bare `capy` until the folder and Capy agree. A difference nobody can answer is thrown (a `ConflictRefusal`). */
const syncUntilInSync = (opts: GateOptions, runner: SyncRunner): Promise<GateResult> => repeat(() => runner(opts, answersByProtocol(opts)));

/** The outcome of `work` as a value, so what follows it is not inside its own `catch`. */
const outcomeOf = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * Runs bare `capy` until the folder and Capy agree. A difference nobody can answer ends the process here (exit 3,
 * the payload on stdout); an error is thrown as it is.
 */
export async function ensureInSync(opts: GateOptions = {}, runner: SyncRunner = runBareCapy): Promise<GateResult> {
  const done = await outcomeOf(syncUntilInSync(opts, runner));
  if (done.ok) return done.value;
  if (opts.throwConflicts !== true) exitOnConflictRefusal(done.error);
  throw done.error;
}

/** What bare `capy` found in one folder that is not the working directory. */
export type FolderSync =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `SECRETS_CONFLICT` / `SECRETS_CONFLICT_STALE` for a difference to decide, `FOLDER_SYNC_STOPPED` when the person stopped, else the error's own code. */
      readonly code: string;
      readonly message: string;
      /** The rows and `conflict_id` of a difference nobody could answer (fingerprints only). */
      readonly conflict?: ConflictPayload;
    };

/** The code of a sync that was stopped (the person cancelled or chose "Continue working"). */
export const FOLDER_SYNC_STOPPED = 'STOPPED';

const folderSyncFailure = (err: unknown): FolderSync => {
  if (isConflictRefusal(err)) return { ok: false, code: err.code, message: err.message, conflict: err.payload };
  if (err instanceof CapyError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: ERROR_CODES.SERVICE_ERROR, message: 'The sync did not complete.' }; // COPY-FLAG
};

/**
 * Bare `capy` in `dir` (a checkout other than the working directory) until it and Capy agree: the step before anything is
 * written into that folder. Never ends the process: a difference nobody can answer, a stop or a failure comes back as the
 * folder's own coded result, and nothing has been written into it.
 */
export async function syncFolder(dir: string, opts: GateOptions = {}, runner: SyncRunner = runBareCapy): Promise<FolderSync> {
  const done = await outcomeOf(syncUntilInSync({ ...opts, cwd: dir }, runner));
  if (!done.ok) return folderSyncFailure(done.error);
  return done.value === 'in-sync' ? { ok: true } : { ok: false, code: FOLDER_SYNC_STOPPED, message: 'Stopped. Nothing was written.' }; // COPY-FLAG
}

/** The gate stopped (the person cancelled or chose "Continue working"): the command ends here, exit 0, nothing written. */
export function stopWithNothingWritten(): never {
  console.error('Stopped. Nothing was written.'); // COPY-FLAG
  return process.exit(0);
}

/** The sync itself failed (a coded `CapyError`: no session, Capy unreachable): the command ends with that code, not a stack. */
async function failedSync(err: unknown, opts: GateOptions): Promise<never> {
  if (opts.refuse !== undefined) return opts.refuse(err);
  const coded = err instanceof CapyError ? err : new CapyError('The sync did not complete.', ERROR_CODES.SERVICE_ERROR); // COPY-FLAG
  if (opts.json === true) {
    console.log(JSON.stringify({ ok: false, code: coded.code, error: coded.message }, null, 2));
    return process.exit(1);
  }
  // Off a terminal (no one to read the error screen, stdout reserved for payloads): the code and what to do, on stderr.
  if (answersByProtocol(opts)) {
    console.error(`${coded.code}: ${coded.message}`);
    return process.exit(1);
  }
  const { displayErrorAndExit } = await import('../ui/errorScreen');
  return displayErrorAndExit(err);
}

/** The gate as a command's first step: a stop ends the command on the spot, and so does a failure of the sync. */
export async function gateFirst(opts: GateOptions = {}, runner: SyncRunner = runBareCapy): Promise<void> {
  const done = await outcomeOf(syncUntilInSync(opts, runner));
  if (!done.ok) {
    exitOnConflictRefusal(done.error);
    return failedSync(done.error, opts);
  }
  if (done.value === 'stopped') stopWithNothingWritten();
}

/** A folder context the gate can be re-run for (`ResolvedContext` has all of it). */
export type GatedFolder = FolderContext & { readonly gate?: GateOptions };

/** The same folder, read again from disk: bare `capy` may have moved keep.lock and `.env` since the context was made. */
function reread<C extends GatedFolder>(ctx: C): C {
  return { ...ctx, keep: ctx.pm.readKeepFile() ?? ctx.keep, localPlaintext: readLocalPlaintext(ctx.fileManager, ctx.projectKey) };
}

/**
 * `commitFolder` (the command's own change onto Capy's latest, with `base_keep_hash`) and, if the server refuses it
 * as stale because someone saved in between, bare `capy` again and one more attempt from the folder as it is then.
 * A stop in that second gate ends the command (nothing written); a second stale refusal is thrown
 * (`SECRETS_STALE_BASE`, exit 1). A context without `gate` throws the stale refusal as it is. A context for another
 * checkout than the working directory (discovery) carries a gate with that folder as `cwd`, so the retry runs bare `capy`
 * there.
 */
export async function commitGated<C extends GatedFolder>(
  ctx: C,
  changes: Changes,
  opts: FolderCommitOptions = {},
  runner: SyncRunner = runBareCapy,
): Promise<FolderCommit> {
  const attempt = async (folder: C, options: FolderCommitOptions, retried: boolean): Promise<FolderCommit> => {
    try {
      return await commitFolder(folder, changes, options);
    } catch (err) {
      if (!isStaleBase(err) || retried || ctx.gate === undefined) throw err;
      return (await ensureInSync(ctx.gate, runner)) === 'in-sync'
        ? attempt(reread(folder), { ...options, seen: undefined }, true)
        : stopWithNothingWritten();
    }
  };
  return attempt(ctx, opts, false);
}
