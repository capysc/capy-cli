import { createHash } from 'crypto';
import {
  EnvVariable,
  ChangeSet,
  ConflictVariable,
  UserDecisions,
  SyncResult,
  KeepFile,
  KeepVariableEntry,
  SyncState,
} from '../types/index';

export class SyncEngine {
  /**
   * Extract resource_id from capy:{resource_id}:{encrypted_value} format
   */
  private extractResourceId(value: string): string | null {
    if (value.startsWith('capy:')) {
      const parts = value.split(':');
      if (parts.length >= 3) {
        return parts[1]; // Return the resource_id part
      }
    }
    return null;
  }

  compareEnvironments(
    local: Record<string, string>,
    remote: Record<string, string>,
    localEncrypted?: Record<string, string>,
    remoteEncrypted?: Record<string, string>,
    syncState?: SyncState | null
  ): ChangeSet {
    const syncedKeys = new Set(syncState ? syncState.synced_variables : []);
    const localKeys = Object.keys(local);
    const plain = (name: string, value: string, source: EnvVariable['source'], encrypted: boolean): EnvVariable => ({ name, value, source, encrypted });

    // A name both sides have is: marked deleted on remote, a conflict, or unchanged.
    const both = localKeys.filter((key) => key in remote);
    const isDeletedMarker = (key: string): boolean => remote[key] === 'capy:deleted';

    const conflicts: ConflictVariable[] = both
      .filter((key) => !isDeletedMarker(key) && local[key] !== remote[key])
      .map((key) => {
        // Conflict - check if resource_ids differ using encrypted versions
        const localResourceId = this.extractResourceId(localEncrypted ? localEncrypted[key] : local[key]);
        const remoteResourceId = this.extractResourceId(remoteEncrypted ? remoteEncrypted[key] : remote[key]);
        const isNew =
          (localResourceId !== null && remoteResourceId !== null && localResourceId !== remoteResourceId) ||
          (localResourceId === null && remoteResourceId !== null);
        return { name: key, localValue: local[key], remoteValue: remote[key], isNew };
      });

    // Remote variables not in local (a deleted marker for a name local lacks is not a new remote variable).
    const remoteOnly = Object.keys(remote).filter((key) => !(key in local) && !isDeletedMarker(key));

    return {
      newLocal: localKeys.filter((key) => !(key in remote)).map((key) => plain(key, local[key], 'local', false)),
      // Variable never synced to this machine → new remote variable (or first sync)
      newRemote: remoteOnly.filter((key) => !syncedKeys.has(key)).map((key) => plain(key, remote[key], 'remote', true)),
      conflicts,
      unchanged: both.filter((key) => !isDeletedMarker(key) && local[key] === remote[key]).map((key) => plain(key, local[key], 'both', false)),
      // Remote variable marked as deleted
      deleted: both.filter(isDeletedMarker).map((key) => plain(key, local[key], 'local', false)),
      // Variable was synced before but now missing locally → user deleted it locally
      deletedLocal: remoteOnly.filter((key) => syncedKeys.has(key)).map((key) => plain(key, remote[key], 'remote', true)),
    };
  }

  applyDecisions(
    local: Record<string, string>,
    remote: Record<string, string>,
    decisions: UserDecisions
  ): Record<string, string> {
    // Start from remote as the base — unchanged variables keep their remote value (deletion markers removed)
    const base = Object.fromEntries(Object.entries(remote).filter(([, value]) => value !== 'capy:deleted'));

    // New local-only variables are included only if the user chose to push them; an explicit push decision
    // (local value wins) and "keep local" for conflicts both take the local value.
    const fromLocal = Object.fromEntries(
      [...new Set([...decisions.pushVariables, ...decisions.keepLocal])]
        .filter((name) => local[name] !== undefined)
        .map((name) => [name, local[name]] as const),
    );

    // Apply user's explicit pull decisions (remote value wins)
    const pulled = Object.fromEntries(
      decisions.pullVariables
        .filter((name) => remote[name] !== undefined && remote[name] !== 'capy:deleted')
        .map((name) => [name, remote[name]] as const),
    );

    // Delete variables the user confirmed for deletion
    const gone = new Set([...decisions.deleteLocal, ...decisions.deleteRemote]);
    return Object.fromEntries(Object.entries({ ...base, ...fromLocal, ...pulled }).filter(([name]) => !gone.has(name)));
  }

  generateSyncResult(
    changeSet: ChangeSet,
    decisions: UserDecisions,
    errors: string[] = []
  ): SyncResult {
    const pushed = decisions.pushVariables;
    const pulled = decisions.pullVariables;
    const resolved = [...decisions.keepLocal, ...decisions.keepRemote];

    // Deduplicate: pushed conflicts are in both pushVariables and keepLocal
    const allNames = new Set([
      ...changeSet.unchanged.map(v => v.name),
      ...pushed,
      ...pulled,
      ...resolved,
    ]);
    const totalVariables = allNames.size;

    return {
      success: errors.length === 0,
      pushed,
      pulled,
      conflicts: resolved,
      errors,
      totalVariables
    };
  }

  /**
   * Merge pushed variables into a v3 keep.lock file.
   * Updates the value hash for the specified branch.
   */
  mergeWithKeep(
    keep: KeepFile,
    pushedVariables: Record<string, { resource_id: string; value_hash?: string }>,
    branch?: string,
  ): KeepFile {
    const targetBranch = branch || SyncEngine.DEFAULT_BRANCH;
    const merged = Object.fromEntries(
      Object.entries(pushedVariables).map(([varName, data]) => {
        // Clone existing entries
        const entries = (keep.variables[varName] || []).map(e => ({ ...e }));

        // Find existing entry for this branch
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

        return [varName, idx >= 0 ? entries.map((e, i) => (i === idx ? entry : e)) : [...entries, entry]] as const;
      }),
    );

    return { ...keep, variables: { ...keep.variables, ...merged } };
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

    const names = new Set([...Object.keys(local.variables), ...Object.keys(server.variables)]);
    const variables: KeepFile['variables'] = Object.fromEntries(
      [...names].flatMap((name) => {
        const merged = [
          ...(local.variables[name] || []).filter(e => e.branch !== branch),
          ...(server.variables[name] || []).filter(e => e.branch === branch),
        ];
        return merged.length > 0 ? [[name, merged] as const] : [];
      }),
    );

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

  formatSyncSummary(changeSet: ChangeSet): string {
    return [
      changeSet.newLocal.length > 0 ? `${changeSet.newLocal.length} new local variable(s)` : '',
      changeSet.newRemote.length > 0 ? `${changeSet.newRemote.length} new remote variable(s)` : '',
      changeSet.deleted.length > 0 ? `${changeSet.deleted.length} deleted variable(s)` : '',
      changeSet.conflicts.length > 0 ? `${changeSet.conflicts.length} conflict(s)` : '',
      changeSet.unchanged.length > 0 ? `${changeSet.unchanged.length} unchanged` : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  validateDecisions(decisions: UserDecisions, changeSet: ChangeSet): string[] {
    const localVarNames = changeSet.newLocal.map(v => v.name);
    const conflictNames = changeSet.conflicts.map(c => c.name);
    const deletedVarNames = changeSet.deleted.map(v => v.name);
    const remoteVarNames = changeSet.newRemote.map(v => v.name);
    const deletedLocalVarNames = changeSet.deletedLocal.map(v => v.name);
    const allResolutions = [...decisions.keepLocal, ...decisions.keepRemote];

    return [
      ...decisions.pushVariables
        .filter((varName) => !localVarNames.includes(varName) && !conflictNames.includes(varName) && !deletedVarNames.includes(varName))
        .map((varName) => `Cannot push ${varName}: not a new local variable, conflict, or deleted variable`),
      ...decisions.pullVariables
        .filter((varName) => !remoteVarNames.includes(varName) && !deletedLocalVarNames.includes(varName))
        .map((varName) => `Cannot pull ${varName}: not a new remote variable or locally deleted variable`),
      ...allResolutions
        .filter((varName) => !conflictNames.includes(varName))
        .map((varName) => `Cannot resolve ${varName}: not a conflict`),
      ...(new Set(allResolutions).size !== allResolutions.length ? ['Duplicate conflict resolutions detected'] : []),
    ];
  }

  static readonly DEFAULT_BRANCH = 'development';

  /**
   * v3: Compute a content-addressed hash from keep.lock.
   * Filters by branch, then hashes sorted variable names + value hashes.
   */
  static computeKeepHash(keep: KeepFile, branch?: string): string {
    const targetBranch = branch || SyncEngine.DEFAULT_BRANCH;
    const entries = Object.keys(keep.variables)
      .sort()
      .flatMap((key) => {
        const entry = keep.variables[key].find(e => e.branch === targetBranch);
        return entry ? [`${key}:${entry.resource_id}:${entry.value_hash}`] : [];
      });
    return createHash('sha256').update(entries.join('\n')).digest('hex');
  }
}
