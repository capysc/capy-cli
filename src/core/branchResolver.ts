import { Branch, CapyError, ERROR_CODES, KeepFile, SyncState } from '../types/index';

/**
 * Branch resolution for a project directory.
 *
 * Sources of truth, in order:
 *   1. The `.env` header (`# capy:branch=…`) — the branch the current secrets
 *      were actually encrypted for. Always honored when present.
 *   2. `.capy/branch` — the locally recorded checkout. Honored when `.env` is
 *      absent (a pull will materialize it).
 *   3. The server branch list — when neither file exists (fresh clone,
 *      Conductor workspace, wiped `.capy/`), pick the sole branch or prompt.
 *
 * `.capy/` is gitignored, so a missing `.capy/branch` is a NORMAL state and
 * must never be treated as an error — and no code path may invent a branch
 * name that was never written by the user or the server.
 */

export type LocalBranchResolution =
  /** A branch was determined from local files alone. */
  | {
      kind: 'resolved';
      branch: string;
      source: 'env-header' | 'branch-file';
      /** True when `.capy/branch` is missing/stale and should be rewritten. */
      rebuildBranchFile: boolean;
    }
  /** `.env` and `.capy/branch` both exist and genuinely disagree. */
  | { kind: 'conflict'; envBranch: string; fileBranch: string }
  /** No local signal — the caller must consult the server branch list. */
  | { kind: 'unknown' };

/** Branch names that have at least one variable entry in keep.lock. */
export function branchesFromKeep(keep: KeepFile | null | undefined): string[] {
  const names = new Set<string>();
  for (const entries of Object.values(keep?.variables ?? {})) {
    for (const entry of entries) {
      if (entry?.branch) names.add(entry.branch);
    }
  }
  return Array.from(names).sort();
}

/** Branch names recorded in sync-state's per-branch keep_hash map. */
export function syncedBranchNames(syncState: SyncState | null | undefined): string[] {
  const keepHash = syncState?.keep_hash;
  if (!keepHash || typeof keepHash === 'string') return [];
  return Object.keys(keepHash).sort();
}

/**
 * Resolve the active branch from local files only (no server, no prompt).
 * Rows 1–6 of the state matrix: any of `.env` header / `.capy/branch`
 * present is enough; both present and disagreeing is a genuine
 * interrupted-checkout conflict for the caller to reconcile.
 */
export function resolveBranchFromLocalState(signals: {
  envBranch?: string;
  fileBranch?: string;
}): LocalBranchResolution {
  const envBranch = signals.envBranch?.trim() || undefined;
  const fileBranch = signals.fileBranch?.trim() || undefined;

  if (envBranch && fileBranch) {
    if (envBranch === fileBranch) {
      return { kind: 'resolved', branch: envBranch, source: 'env-header', rebuildBranchFile: false };
    }
    return { kind: 'conflict', envBranch, fileBranch };
  }
  if (envBranch) {
    return { kind: 'resolved', branch: envBranch, source: 'env-header', rebuildBranchFile: true };
  }
  if (fileBranch) {
    return { kind: 'resolved', branch: fileBranch, source: 'branch-file', rebuildBranchFile: false };
  }
  return { kind: 'unknown' };
}

/**
 * Given the server branch list, decide whether a branch can be selected
 * without asking the user. Returns the branch name, or null when the choice
 * is ambiguous and the user must pick.
 *
 * A protected branch is never auto-selected — the guard keys off
 * `is_protected`, never the branch name — with one exception: when it is the
 * only branch in the project, there is no alternative.
 */
export function autoSelectBranch(branches: Branch[], synced: string[]): string | null {
  if (branches.length === 1) return branches[0].name;
  const syncedReal = synced
    .map(name => branches.find(b => b.name === name))
    .filter((b): b is Branch => b !== undefined);
  if (syncedReal.length === 1 && !syncedReal[0].is_protected) return syncedReal[0].name;
  return null;
}

/**
 * Default selection for the branch picker: the first non-protected branch.
 * Undefined when every branch is protected (the picker then has no
 * preselection; the user must make an explicit choice).
 */
export function defaultBranchChoice(branches: Branch[]): string | undefined {
  return branches.find(b => !b.is_protected)?.name;
}

/**
 * Server-assisted branch selection for the no-local-signal state (rows 7–8):
 * fetch the branch list, auto-select when unambiguous, otherwise prompt.
 * Dependency-injected so the flow (including the offline path) is testable
 * without a real server or TTY.
 */
export async function selectBranchWithServer(deps: {
  listBranches: () => Promise<Branch[]>;
  promptPick: (branches: Branch[], defaultName?: string) => Promise<string>;
  syncedBranches: string[];
}): Promise<string> {
  let branches: Branch[];
  try {
    branches = await deps.listBranches();
  } catch (err) {
    throw new CapyError(
      'Cannot determine the active branch: this directory has no .env and no .capy/branch, ' +
      'and the Capy service is unreachable to list branches.\n\n' +
      '  Reconnect and run capy again, or restore the .env for the branch you were on.',
      ERROR_CODES.NETWORK_ERROR,
      { cause: err },
    );
  }

  if (branches.length === 0) {
    throw new CapyError(
      'This project has no branches yet. Create one with: capy checkout -b <branch>',
      ERROR_CODES.BRANCH_NOT_FOUND,
    );
  }

  const auto = autoSelectBranch(branches, deps.syncedBranches);
  if (auto) return auto;

  return deps.promptPick(branches, defaultBranchChoice(branches));
}
