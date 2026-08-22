/**
 * The onboard flow's sensors.
 *
 * The CLI keeps its sensors and its actuators and loses the wiring: this module
 * REPORTS what is true of a directory and knows nothing about what any of it
 * means. Nothing here decides that a missing keep.lock means "initialize" — the
 * service does, from the predicate table.
 *
 * Every predicate is re-derived on every call. Nothing is cached, nothing is
 * remembered between calls, and the definitions are the contract's
 * (`contract/observations.json`), implemented with this CLI's own existing
 * readers rather than fresh filesystem logic.
 *
 * Booleans and names only ever leave here. No value, no snippet of one.
 */
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { resolveBranchFromLocalState, branchesFromKeep, syncedBranchNames } from '../../core/branchResolver';
import { KeepFile } from '../../types/index';

export interface OnboardObservations {
  targetDirValid: boolean;
  hasCapyDir: boolean;
  hasKeepLock: boolean;
  envMetaRecoverable: boolean;
  envStillPlaintext: boolean;
  commandsWrapped: boolean;
  branchConflict: boolean;
  /** A hint. The service derives its own answer and its answer wins. */
  sessionLive: boolean;
  /**
   * The org named by keep.lock (or the .env header when keep.lock is absent)
   * has its master key confirmed on this device. VACUOUSLY TRUE only when no
   * org is named locally; with an org named, unconfirmed reports FALSE — see
   * `orgKeyOnDevice` below.
   */
  orgKeyOnDevice: boolean;
}

export interface ObserveOptions {
  targetDir: string;
  /** Whether a usable session exists. Supplied by the caller, which owns the auth service. */
  sessionLive: boolean;
  /** Alternate .env path, matching the CLI's --env-path option. */
  envPath?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `.env` header and `.capy/branch` disagree, and the `.capy/branch` side
 * names a branch this directory actually knows about.
 *
 * A stale cache is NOT a conflict: when `.capy/branch` names nothing real, the
 * header simply wins and the cache gets rebuilt. Only the locally-checkable
 * half is decided here — the CLI's own reconciler is the thing that can ask the
 * server, and this sensor must never make a network call.
 */
function branchConflict(pm: ProjectManager, fm: FileManager, envPath?: string): boolean {
  const envMeta = fm.readEnvMeta(envPath);
  const local = resolveBranchFromLocalState({
    envBranch: envMeta.branch,
    fileBranch: pm.readActiveBranch() ?? undefined,
  });
  if (local.kind !== 'conflict') return false;

  let keep: KeepFile | null = null;
  try {
    keep = pm.readKeepFile();
  } catch {
    keep = null;
  }
  const knownLocally = new Set([...branchesFromKeep(keep), ...syncedBranchNames(pm.readSyncState())]);
  return knownLocally.has(local.fileBranch);
}

/**
 * Whether every local edit the onboarding plan would make is already applied.
 * A directory with nothing to wrap is vacuously TRUE — otherwise the flow would
 * loop on a verb that can never flip its own predicate.
 */
function commandsWrapped(targetDir: string): boolean {
  const { computeRunWrapEdits } = require('./edits') as typeof import('./edits');
  const { computeAgentDocsEdits } = require('./agentDocs') as typeof import('./agentDocs');
  const edits = [...computeRunWrapEdits(targetDir), ...computeAgentDocsEdits(targetDir)];
  return edits.every((e) => e.noop);
}

/**
 * CAP-382 Case C, as an observation: does THIS device hold the master key for
 * the org named locally?
 *
 * VACUOUSLY TRUE only when no org is named locally at all (no keep.lock, no
 * .env header) — there is nothing to check `hasOrgKey` against. That is the
 * one vacuous arm the contract keeps (`U4` in `scripts/gen-onboard-table.ts`).
 *
 * When an org IS named, an unconfirmed key is a MISSING key: no session yet,
 * no recorded userId yet, or `hasOrgKey` false all report FALSE. The old
 * vacuous-true arms here (CAP-485) were exactly what let a second device
 * declare an already-onboarded repo `done` without ever signing in or
 * unlocking — with no session the table's own priority order routes to
 * `authenticate` first, and `unlock_org_key` (which resolves the userId from
 * the live session and records it in sync-state) follows once one exists.
 */
function orgKeyOnDevice(pm: ProjectManager, fm: FileManager, sessionLive: boolean, envPath?: string): boolean {
  let keep: KeepFile | null = null;
  try {
    keep = pm.readKeepFile();
  } catch {
    keep = null;
  }
  const orgId = keep?.org_id ?? fm.readEnvMeta(envPath).org_id ?? null;
  if (!orgId) return true;

  if (!sessionLive) return false;

  const userId = pm.readSyncState()?.user_id;
  if (!userId) return false;

  const { hasOrgKey } = require('../../crypto/keyResolver') as typeof import('../../crypto/keyResolver');
  return hasOrgKey(orgId, userId);
}

/**
 * Is there env work for this directory?
 *
 * Plaintext values are the classic case. The second case is a FRESH CLONE of
 * an onboarded repo: keep.lock is present but `.env` does not exist at all,
 * because `.env` is gitignored by design. `hasPlaintextValues` answers false
 * there — nothing is plaintext when nothing is on disk — so the flow treated
 * `encrypt_env` as already satisfied, skipped it, and reached `done` having
 * never run the sync that MATERIALISES the variables. The user got a
 * successful onboard and an empty directory.
 *
 * `encrypt_env` is the ordinary sync path (see its executor), so "the .env is
 * not here yet" is env work exactly like "the .env is still plaintext".
 */
function envWorkPending(pm: ProjectManager, fm: FileManager, targetDir: string, envPath?: string): boolean {
  if (fm.hasPlaintextValues(envPath)) return true;
  if (!existsSync(pm.getKeepPath())) return false;
  return !existsSync(envPath ?? join(targetDir, '.env'));
}

export function observeOnboard(opts: ObserveOptions): OnboardObservations {
  const { targetDir } = opts;

  // Every other predicate is a fact ABOUT this directory, so none of them can
  // be true when it is not there.
  if (!isDirectory(targetDir)) {
    return {
      targetDirValid: false,
      hasCapyDir: false,
      hasKeepLock: false,
      envMetaRecoverable: false,
      envStillPlaintext: false,
      commandsWrapped: false,
      branchConflict: false,
      sessionLive: opts.sessionLive,
      // Vacuously true: no target dir means no org can be named locally.
      orgKeyOnDevice: true,
    };
  }

  const pm = new ProjectManager(targetDir);
  const fm = new FileManager(targetDir);
  const envMeta = fm.readEnvMeta(opts.envPath);

  return {
    targetDirValid: true,
    hasCapyDir: existsSync(pm.getCapyDir()),
    // EXISTENCE ONLY, deliberately: a corrupt keep.lock reported as absent
    // would route the flow at initializing over a git-owned file. Corruption
    // surfaces instead as the failure code of the first step that reads it.
    hasKeepLock: existsSync(pm.getKeepPath()),
    envMetaRecoverable: Boolean(envMeta.org_id && envMeta.project_id),
    // The CLI's own definition, not a second parser: `hasPlaintextValues` is
    // the exact predicate `backupPlaintextEnv` uses to decide whether there is
    // anything to protect, so a quoted or exported value classifies here the
    // way it classifies where it matters.
    envStillPlaintext: envWorkPending(pm, fm, targetDir, opts.envPath),
    commandsWrapped: commandsWrapped(targetDir),
    branchConflict: branchConflict(pm, fm, opts.envPath),
    sessionLive: opts.sessionLive,
    orgKeyOnDevice: orgKeyOnDevice(pm, fm, opts.sessionLive, opts.envPath),
  };
}
