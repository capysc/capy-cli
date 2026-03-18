import { 
  EnvVariable, 
  ChangeSet, 
  ConflictVariable,
  UserDecisions,
  SyncResult,
  KeepFile,
  DecryptKey,
  SyncState
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
    const localKeys = new Set(Object.keys(local));
    const remoteKeys = new Set(Object.keys(remote));
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
        
        // Mark as NEW if:
        // 1. Both have resource_ids and they differ (local value changed)
        // 2. Remote has resource_id but local is plaintext (user manually edited to plaintext)
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
    const result: Record<string, string> = { ...local };

    // Pull remote variables
    for (const varName of decisions.pullVariables) {
      if (remote[varName] !== undefined && remote[varName] !== 'capy:deleted') {
        result[varName] = remote[varName];
      }
    }

    // Keep remote values for conflicts
    for (const varName of decisions.keepRemote) {
      if (remote[varName] !== undefined && remote[varName] !== 'capy:deleted') {
        result[varName] = remote[varName];
      } else if (remote[varName] === 'capy:deleted') {
        // Remote is deleted, remove from local
        delete result[varName];
      }
    }

    // Delete local variables that user confirmed
    for (const varName of decisions.deleteLocal) {
      delete result[varName];
    }

    // Keep local values (already in result)
    // Remove variables that shouldn't be pushed
    const allLocalVars = Object.keys(local);
    const varsToKeepLocal = allLocalVars.filter(
      v => !decisions.pushVariables.includes(v)
    );

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
    
    const totalVariables = 
      changeSet.unchanged.length + 
      pushed.length + 
      pulled.length + 
      resolved.length;

    return {
      success: errors.length === 0,
      pushed,
      pulled,
      conflicts: resolved,
      errors,
      totalVariables
    };
  }

  mergeWithKeep(
    keep: KeepFile,
    pushedVariables: Record<string, { resource_id: string }>
  ): KeepFile {
    const updatedKeep = { ...keep };
    const now = new Date().toISOString();

    for (const [varName, data] of Object.entries(pushedVariables)) {
      if (updatedKeep.variables[varName]) {
        // Update existing variable
        updatedKeep.variables[varName].resource_id = data.resource_id;
        updatedKeep.variables[varName].updated_at = now;
      } else {
        // Add new variable
        updatedKeep.variables[varName] = {
          resource_id: data.resource_id,
          created_at: now,
          updated_at: now
        };
      }
    }

    updatedKeep.last_sync = now;
    return updatedKeep;
  }

  createDecryptKey(
    organizationId: string,
    projectId: string,
    userId: string,
    decryptionKey: string,
    variableNames: string[]
  ): DecryptKey {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days expiration

    return {
      version: '1.0',
      capy_id: organizationId,
      project_id: projectId,
      user_id: userId,
      decryption_key: decryptionKey,
      expires_at: expiresAt.toISOString(),
      permissions: variableNames
    };
  }

  formatSyncSummary(changeSet: ChangeSet): string {
    const lines: string[] = [];
    
    if (changeSet.newLocal.length > 0) {
      lines.push(`📤 ${changeSet.newLocal.length} new local variable(s)`);
    }
    
    if (changeSet.newRemote.length > 0) {
      lines.push(`📥 ${changeSet.newRemote.length} new remote variable(s)`);
    }
    
    if (changeSet.deleted.length > 0) {
      lines.push(`🗑️  ${changeSet.deleted.length} deleted variable(s)`);
    }
    
    if (changeSet.conflicts.length > 0) {
      lines.push(`⚠️  ${changeSet.conflicts.length} conflict(s)`);
    }
    
    if (changeSet.unchanged.length > 0) {
      lines.push(`✓ ${changeSet.unchanged.length} unchanged`);
    }

    return lines.join('\n');
  }

  validateDecisions(decisions: UserDecisions, changeSet: ChangeSet): string[] {
    const errors: string[] = [];
    
    // Validate push variables exist in newLocal OR are conflict variables being kept local OR are deleted variables being restored
    const localVarNames = changeSet.newLocal.map(v => v.name);
    const conflictNames = changeSet.conflicts.map(c => c.name);
    const deletedVarNames = changeSet.deleted.map(v => v.name);
    for (const varName of decisions.pushVariables) {
      if (!localVarNames.includes(varName) && !conflictNames.includes(varName) && !deletedVarNames.includes(varName)) {
        errors.push(`Cannot push ${varName}: not a new local variable, conflict, or deleted variable`);
      }
    }

    // Validate pull variables exist in newRemote OR deletedLocal (for restore)
    const remoteVarNames = changeSet.newRemote.map(v => v.name);
    const deletedLocalVarNames = changeSet.deletedLocal.map(v => v.name);
    for (const varName of decisions.pullVariables) {
      if (!remoteVarNames.includes(varName) && !deletedLocalVarNames.includes(varName)) {
        errors.push(`Cannot pull ${varName}: not a new remote variable or locally deleted variable`);
      }
    }

    // Validate conflict resolutions
    const allResolutions = [...decisions.keepLocal, ...decisions.keepRemote];
    for (const varName of allResolutions) {
      if (!conflictNames.includes(varName)) {
        errors.push(`Cannot resolve ${varName}: not a conflict`);
      }
    }

    // Check for duplicate resolutions
    const resolutionSet = new Set(allResolutions);
    if (resolutionSet.size !== allResolutions.length) {
      errors.push('Duplicate conflict resolutions detected');
    }

    return errors;
  }
}