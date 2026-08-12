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
import { isReservedRuntimeVar } from '../core/reservedVars';

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
    // Reserved runtime variables are filtered out HERE, at the one place every
    // downstream category is derived from, so a rename cannot leave a path
    // behind (CAP-424). They are machine-local runtime config, not project
    // secrets, and every category below gets them wrong in its own way — most
    // destructively `conflicts`, since SECRETS_BLOB is per-deploy-target by
    // construction: two droplets legitimately hold different values for the
    // same name, and "keep remote" would overwrite one machine's deploy
    // credential with another's, leaving it unable to boot. There is no
    // correct resolution because the premise that a name has one right value
    // per branch is false for these.
    const localKeys = new Set(Object.keys(local).filter((k) => !isReservedRuntimeVar(k)));
    const remoteKeys = new Set(Object.keys(remote).filter((k) => !isReservedRuntimeVar(k)));
    const syncedKeys = syncState ? new Set(syncState.synced_variables) : new Set();

    const newLocal: EnvVariable[] = [];
    const newRemote: EnvVariable[] = [];
    const conflicts: ConflictVariable[] = [];
    const unchanged: EnvVariable[] = [];
    const deleted: EnvVariable[] = [];
    const deletedLocal: EnvVariable[] = [];

    // Check local variables
    for (const key of localKeys) {
      if (!remoteKeys.has(key)) {
        // New local variable
        newLocal.push({
          name: key,
          value: local[key],
          source: 'local',
          encrypted: false
        });
      } else if (remote[key] === 'capy:deleted') {
        // Remote variable marked as deleted
        deleted.push({
          name: key,
          value: local[key],
          source: 'local',
          encrypted: false
        });
      } else if (local[key] !== remote[key]) {
        // Conflict - check if resource_ids differ using encrypted versions
        const localEncryptedValue = localEncrypted ? localEncrypted[key] : local[key];
        const remoteEncryptedValue = remoteEncrypted ? remoteEncrypted[key] : remote[key];

        const localResourceId = this.extractResourceId(localEncryptedValue);
        const remoteResourceId = this.extractResourceId(remoteEncryptedValue);

        const isNew = (localResourceId !== null &&
                       remoteResourceId !== null &&
                       localResourceId !== remoteResourceId) ||
                      (localResourceId === null && remoteResourceId !== null);

        conflicts.push({
          name: key,
          localValue: local[key],
          remoteValue: remote[key],
          isNew
        });
      } else {
        // Unchanged
        unchanged.push({
          name: key,
          value: local[key],
          source: 'both',
          encrypted: false
        });
      }
    }

    // Check remote variables not in local
    for (const key of remoteKeys) {
      // Skip deleted markers if they don't exist locally (already handled above)
      if (!localKeys.has(key) && remote[key] !== 'capy:deleted') {
        // Check if this variable was previously synced to this machine
        if (syncedKeys.has(key)) {
          // Variable was synced before but now missing locally
          // → User deleted it locally
          deletedLocal.push({
            name: key,
            value: remote[key],
            source: 'remote',
            encrypted: true
          });
        } else {
          // Variable never synced to this machine
          // → New remote variable (or first sync)
          newRemote.push({
            name: key,
            value: remote[key],
            source: 'remote',
            encrypted: true
          });
        }
      }
    }

    return {
      newLocal,
      newRemote,
      conflicts,
      unchanged,
      deleted,
      deletedLocal
    };
  }

  applyDecisions(
    local: Record<string, string>,
    remote: Record<string, string>,
    decisions: UserDecisions
  ): Record<string, string> {
    // Start from remote as the base — unchanged variables keep their remote value
    const result: Record<string, string> = { ...remote };

    // Remove deletion markers
    for (const key of Object.keys(result)) {
      if (result[key] === 'capy:deleted') {
        delete result[key];
      }
    }

    // Add unchanged local-only variables (not in remote, not conflicts)
    for (const key of Object.keys(local)) {
      if (!(key in remote)) {
        // New local variable — only include if user chose to push
        if (decisions.pushVariables.includes(key)) {
          result[key] = local[key];
        }
      }
    }

    // Apply user's explicit push decisions (local value wins)
    for (const varName of decisions.pushVariables) {
      if (local[varName] !== undefined) {
        result[varName] = local[varName];
      }
    }

    // Keep local values for conflicts resolved as "keep local" (not pushed)
    for (const varName of decisions.keepLocal) {
      if (local[varName] !== undefined) {
        result[varName] = local[varName];
      }
    }

    // Apply user's explicit pull decisions (remote value wins, already in result)
    for (const varName of decisions.pullVariables) {
      if (remote[varName] !== undefined && remote[varName] !== 'capy:deleted') {
        result[varName] = remote[varName];
      }
    }

    // Delete variables the user confirmed for deletion
    for (const varName of decisions.deleteLocal) {
      delete result[varName];
    }
    for (const varName of decisions.deleteRemote) {
      delete result[varName];
    }

    return result;
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

  formatSyncSummary(changeSet: ChangeSet): string {
    const lines: string[] = [];

    if (changeSet.newLocal.length > 0) {
      lines.push(`${changeSet.newLocal.length} new local variable(s)`);
    }

    if (changeSet.newRemote.length > 0) {
      lines.push(`${changeSet.newRemote.length} new remote variable(s)`);
    }

    if (changeSet.deleted.length > 0) {
      lines.push(`${changeSet.deleted.length} deleted variable(s)`);
    }

    if (changeSet.conflicts.length > 0) {
      lines.push(`${changeSet.conflicts.length} conflict(s)`);
    }

    if (changeSet.unchanged.length > 0) {
      lines.push(`${changeSet.unchanged.length} unchanged`);
    }

    return lines.join('\n');
  }

  validateDecisions(decisions: UserDecisions, changeSet: ChangeSet): string[] {
    const errors: string[] = [];

    const localVarNames = changeSet.newLocal.map(v => v.name);
    const conflictNames = changeSet.conflicts.map(c => c.name);
    const deletedVarNames = changeSet.deleted.map(v => v.name);
    for (const varName of decisions.pushVariables) {
      if (!localVarNames.includes(varName) && !conflictNames.includes(varName) && !deletedVarNames.includes(varName)) {
        errors.push(`Cannot push ${varName}: not a new local variable, conflict, or deleted variable`);
      }
    }

    const remoteVarNames = changeSet.newRemote.map(v => v.name);
    const deletedLocalVarNames = changeSet.deletedLocal.map(v => v.name);
    for (const varName of decisions.pullVariables) {
      if (!remoteVarNames.includes(varName) && !deletedLocalVarNames.includes(varName)) {
        errors.push(`Cannot pull ${varName}: not a new remote variable or locally deleted variable`);
      }
    }

    const allResolutions = [...decisions.keepLocal, ...decisions.keepRemote];
    for (const varName of allResolutions) {
      if (!conflictNames.includes(varName)) {
        errors.push(`Cannot resolve ${varName}: not a conflict`);
      }
    }

    const resolutionSet = new Set(allResolutions);
    if (resolutionSet.size !== allResolutions.length) {
      errors.push('Duplicate conflict resolutions detected');
    }

    return errors;
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
