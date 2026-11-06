import { createHash } from 'crypto';

/**
 * Hash a plaintext value the same way keep.lock stores it.
 */
export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface DiffResult {
  variable: string;
  type: 'new' | 'changed' | 'deleted';
  pinned?: string;
  local?: string;
  remote?: string;
}

type Hash = string | undefined;

/** `new`, `changed` or `deleted` for a row that is known to differ (any hash may be absent). */
function diffTypeOf(pinnedHash: Hash, localHash: Hash, remoteHash: Hash): DiffResult['type'] {
  if (!pinnedHash && !localHash && remoteHash) return 'new';
  if (!pinnedHash && localHash && !remoteHash) return 'new';
  if (pinnedHash && !remoteHash && !localHash) return 'deleted';
  if ((pinnedHash && !remoteHash) || (!pinnedHash && remoteHash)) return remoteHash ? 'new' : 'deleted';
  return 'changed';
}

/**
 * Compare three sources: pinned (keep.lock hashes), local (.env values), remote (Keep values).
 * Returns diff results and column visibility flags.
 */
export function compareSecrets(
  pinned: Record<string, string>, // variable -> value_hash
  local: Record<string, string>, // variable -> value hash of the .env value
  remote: Record<string, string>, // variable -> value hash of the Keep value
): { diffs: DiffResult[]; showLocal: boolean; showRemote: boolean } {
  const hasRemote = Object.keys(remote).length > 0;

  const allVars = [...new Set([...Object.keys(pinned), ...Object.keys(local), ...(hasRemote ? Object.keys(remote) : [])])];

  // If remote has no data at all, treat each variable as matching pinned.
  // If remote has data but this variable is missing, it's a real absence.
  const rows = allVars
    .map((variable) => ({
      variable,
      pinnedHash: pinned[variable] as Hash,
      localHash: local[variable] as Hash,
      remoteHash: (hasRemote ? remote[variable] : pinned[variable]) as Hash,
    }))
    // Silent reconcile (CAP-307): no pinned baseline yet, but local and remote
    // already agree. There is nothing to push (remote already holds this exact
    // value) and nothing to pull — so don't report a diff and don't let this
    // variable flip the showLocal/showRemote direction hints. The pin is adopted
    // naturally via the "Everything is up to date!" path when no other variable
    // differs. Scoped tightly: only when pinned is absent AND local === remote
    // (both present); genuine divergence (local !== remote) still surfaces.
    .filter((r) => !(!r.pinnedHash && r.localHash !== undefined && r.localHash === r.remoteHash));

  const diffs: DiffResult[] = rows
    // Only report rows with mismatches
    .filter((r) => !(r.pinnedHash === r.localHash && r.pinnedHash === r.remoteHash))
    .filter((r) => !(!r.pinnedHash && !r.localHash && !r.remoteHash))
    .map((r) => ({
      variable: r.variable,
      type: diffTypeOf(r.pinnedHash, r.localHash, r.remoteHash),
      pinned: r.pinnedHash || undefined,
      local: r.localHash || undefined,
      remote: r.remoteHash || undefined,
    }));

  // Column visibility:
  // If all local values match pinned → hide Local column
  // If all remote values match pinned → hide Remote column
  return {
    diffs,
    showLocal: rows.some((r) => r.localHash !== r.pinnedHash),
    showRemote: rows.some((r) => r.remoteHash !== r.pinnedHash),
  };
}
