import { createHash } from 'crypto';
import { KeepFile, KeepVariableEntry } from '../types/index';

export class SyncEngine {
  /**
   * Merge pushed variables into a v3 keep.lock file.
   * Updates the value hash for the specified branch.
   */
  mergeWithKeep(
    keep: KeepFile,
    pushedVariables: Record<string, { resource_id: string; value_hash?: string }>,
    branch?: string,
  ): KeepFile {
    const updatedKeep = { ...keep, variables: { ...keep.variables } };

    for (const [varName, data] of Object.entries(pushedVariables)) {
      const existing = updatedKeep.variables[varName] || [];
      // Clone existing entries
      const entries = existing.map(e => ({ ...e }));

      // Find existing entry for this branch
      const targetBranch = branch || SyncEngine.DEFAULT_BRANCH;
      const idx = entries.findIndex(e => e.branch === targetBranch);

      // Preserve any extra fields on the existing entry (e.g. `connector`
      // metadata set by `capy connect`). Without the spread, every sync
      // would clobber them.
      const entry: KeepVariableEntry = {
        ...(idx >= 0 ? entries[idx] : {}),
        resource_id: data.resource_id,
        value_hash: data.value_hash || '',
        branch: targetBranch,
      };

      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }

      updatedKeep.variables[varName] = entries;
    }

    return updatedKeep;
  }

  /**
   * Splice one branch's entries from `server` into `local`, leaving every
   * other branch's entries untouched (CAP-303).
   *
   * keep.lock is git-owned: a sync or push on branch X has no authority over
   * branch Y's pins, so adopting a server keep wholesale would let whatever
   * the last pusher's file looked like erase branches it didn't have. The
   * result is `local` with its `branch` entries replaced by `server`'s
   * (adds, updates, and deletions on that branch all honored). Entries with
   * no `branch` field never match and are preserved from `local`.
   *
   * `local` null (bootstrap — no keep.lock yet) → adopt `server` as-is.
   */
  static spliceKeepBranch(local: KeepFile | null, server: KeepFile, branch: string): KeepFile {
    if (!local) return server;

    const variables: KeepFile['variables'] = {};
    const names = new Set([...Object.keys(local.variables), ...Object.keys(server.variables)]);

    for (const name of names) {
      const localEntries = local.variables[name] || [];
      const serverEntries = server.variables[name] || [];
      const merged = [
        ...localEntries.filter(e => e.branch !== branch),
        ...serverEntries.filter(e => e.branch === branch),
      ];
      if (merged.length > 0) {
        variables[name] = merged;
      }
    }

    return { ...local, variables };
  }

  /**
   * Pick the keep.lock to write after a push to `branch`. The push response's
   * keep_file carries server-assigned `changed_at` timestamps for the pushed
   * branch — splice that branch's entries in so the local copy (and the
   * committed one) gets them immediately. All other branches' entries stay
   * exactly as the local file has them: the server's copy is the union of
   * every machine's last push and has no authority over branches this push
   * didn't touch. Falls back to the locally-merged keep when the server
   * didn't send one (older service) or sent something unparseable.
   */
  static adoptServerKeep(serverKeepJson: string | undefined, fallback: KeepFile, branch: string): KeepFile {
    if (!serverKeepJson) return fallback;
    try {
      const parsed = JSON.parse(serverKeepJson) as KeepFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.variables) return fallback;
      return SyncEngine.spliceKeepBranch(fallback, parsed, branch);
    } catch {
      return fallback;
    }
  }

  static readonly DEFAULT_BRANCH = 'development';

  /**
   * v3: Compute a content-addressed hash from keep.lock.
   * Filters by branch, then hashes sorted variable names + value hashes.
   */
  static computeKeepHash(keep: KeepFile, branch?: string): string {
    const targetBranch = branch || SyncEngine.DEFAULT_BRANCH;
    const entries: string[] = [];
    for (const key of Object.keys(keep.variables).sort()) {
      const varEntries = keep.variables[key];
      const entry = varEntries.find(e => e.branch === targetBranch);
      if (entry) {
        entries.push(`${key}:${entry.resource_id}:${entry.value_hash}`);
      }
    }
    return createHash('sha256').update(entries.join('\n')).digest('hex');
  }
}
