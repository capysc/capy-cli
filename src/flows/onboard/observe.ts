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
 * `.env` holds at least one value that is not capy ciphertext.
 *
 * The same test `FileManager.backupPlaintextEnv` makes before deciding there is
 * something to protect: a value not starting with `capy:`. No .env at all, and
 * a fully encrypted one, are both FALSE — there is nothing to encrypt in
 * either, and they must sequence identically.
 */
function envStillPlaintext(envFile: string): boolean {
  if (!existsSync(envFile)) return false;
  const { readFileSync } = require('fs') as typeof import('fs');
  const content = readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const value = trimmed.slice(eq + 1);
    if (!value.startsWith('capy:')) return true;
  }
  return false;
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
    };
  }

  const pm = new ProjectManager(targetDir);
  const fm = new FileManager(targetDir);
  const envFile = opts.envPath ?? join(targetDir, '.env');
  const envMeta = fm.readEnvMeta(opts.envPath);

  return {
    targetDirValid: true,
    hasCapyDir: existsSync(pm.getCapyDir()),
    // EXISTENCE ONLY, deliberately: a corrupt keep.lock reported as absent
    // would route the flow at initializing over a git-owned file. Corruption
    // surfaces instead as the failure code of the first step that reads it.
    hasKeepLock: existsSync(pm.getKeepPath()),
    envMetaRecoverable: Boolean(envMeta.org_id && envMeta.project_id),
    envStillPlaintext: envStillPlaintext(envFile),
    commandsWrapped: commandsWrapped(targetDir),
    branchConflict: branchConflict(pm, fm, opts.envPath),
    sessionLive: opts.sessionLive,
  };
}
