import { SyncEngine } from '../../src/sync/syncEngine';
import { ChangeSet, UserDecisions, KeepFile, ConflictVariable } from '../../src/types/index';

describe('SyncEngine', () => {
  let syncEngine: SyncEngine;

  beforeEach(() => {
    syncEngine = new SyncEngine();
  });

  describe('compareEnvironments', () => {
    test('should identify new local variables', () => {
      const local = { LOCAL_VAR: 'local_value', SHARED_VAR: 'shared' };
      const remote = { SHARED_VAR: 'shared' };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.newLocal).toHaveLength(1);
      expect(result.newLocal[0]).toEqual({
        name: 'LOCAL_VAR',
        value: 'local_value',
        source: 'local',
        encrypted: false
      });
    });

    test('should identify new remote variables', () => {
      const local = { SHARED_VAR: 'shared' };
      const remote = { REMOTE_VAR: 'remote_value', SHARED_VAR: 'shared' };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.newRemote).toHaveLength(1);
      expect(result.newRemote[0]).toEqual({
        name: 'REMOTE_VAR',
        value: 'remote_value',
        source: 'remote',
        encrypted: true
      });
    });

    test('should identify conflicts', () => {
      const local = { CONFLICT_VAR: 'local_value', SHARED_VAR: 'shared' };
      const remote = { CONFLICT_VAR: 'remote_value', SHARED_VAR: 'shared' };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        name: 'CONFLICT_VAR',
        localValue: 'local_value',
        remoteValue: 'remote_value',
        isNew: false
      });
    });

    test('should mark conflict as isNew when resource_ids differ', () => {
      const local = { 
        VAR1: 'capy:res_var1_abc123:encrypted_local_data' 
      };
      const remote = { 
        VAR1: 'capy:res_var1_xyz789:encrypted_remote_data' 
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        name: 'VAR1',
        localValue: 'capy:res_var1_abc123:encrypted_local_data',
        remoteValue: 'capy:res_var1_xyz789:encrypted_remote_data',
        isNew: true
      });
    });

    test('should not mark conflict as isNew when resource_ids match', () => {
      const local = { 
        VAR1: 'capy:res_var1_abc123:encrypted_local_data' 
      };
      const remote = { 
        VAR1: 'capy:res_var1_abc123:encrypted_remote_data' 
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        name: 'VAR1',
        localValue: 'capy:res_var1_abc123:encrypted_local_data',
        remoteValue: 'capy:res_var1_abc123:encrypted_remote_data',
        isNew: false
      });
    });

    test('should not mark conflict as isNew when values are not encrypted', () => {
      const local = { VAR1: 'plain_local_value' };
      const remote = { VAR1: 'plain_remote_value' };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        name: 'VAR1',
        localValue: 'plain_local_value',
        remoteValue: 'plain_remote_value',
        isNew: false
      });
    });

    test('should mark conflict as isNew when local is plaintext but remote has resource_id', () => {
      const local = { 
        VAR1: 'plaintext_value' 
      };
      const remote = { 
        VAR1: 'capy:res_var1_abc123:encrypted_remote_data' 
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        name: 'VAR1',
        localValue: 'plaintext_value',
        remoteValue: 'capy:res_var1_abc123:encrypted_remote_data',
        isNew: true
      });
    });

    test('should identify unchanged variables', () => {
      const local = { SAME_VAR: 'same_value', DIFF_VAR: 'local' };
      const remote = { SAME_VAR: 'same_value', DIFF_VAR: 'remote' };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.unchanged).toHaveLength(1);
      expect(result.unchanged[0]).toEqual({
        name: 'SAME_VAR',
        value: 'same_value',
        source: 'both',
        encrypted: false
      });
    });

    test('should handle empty environments', () => {
      const result = syncEngine.compareEnvironments({}, {});

      expect(result.newLocal).toHaveLength(0);
      expect(result.newRemote).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
    });

    test('should handle complex scenario with all types', () => {
      const local = {
        ONLY_LOCAL: 'local',
        CONFLICT_VAR: 'local_conflict',
        UNCHANGED: 'same'
      };
      const remote = {
        ONLY_REMOTE: 'remote',
        CONFLICT_VAR: 'remote_conflict',
        UNCHANGED: 'same'
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.newLocal).toHaveLength(1);
      expect(result.newRemote).toHaveLength(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.unchanged).toHaveLength(1);
    });

    test('should identify deleted variables marked as capy:deleted', () => {
      const local = {
        DELETED_VAR: 'local_value',
        NORMAL_VAR: 'normal'
      };
      const remote = {
        DELETED_VAR: 'capy:deleted',
        NORMAL_VAR: 'normal'
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]).toEqual({
        name: 'DELETED_VAR',
        value: 'local_value',
        source: 'local',
        encrypted: false
      });
      expect(result.unchanged).toHaveLength(1);
    });

    test('should not show capy:deleted markers for non-existent local variables', () => {
      const local = {
        NORMAL_VAR: 'normal'
      };
      const remote = {
        DELETED_VAR: 'capy:deleted',
        NORMAL_VAR: 'normal'
      };

      const result = syncEngine.compareEnvironments(local, remote);

      expect(result.deleted).toHaveLength(0);
      expect(result.newRemote).toHaveLength(0); // capy:deleted shouldn't show as new remote
      expect(result.unchanged).toHaveLength(1);
    });
  });

  describe('applyDecisions', () => {
    test('should apply pull decisions', () => {
      const local = { LOCAL_VAR: 'local' };
      const remote = { REMOTE_VAR: 'remote' };
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: ['REMOTE_VAR'],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const result = syncEngine.applyDecisions(local, remote, decisions);

      expect(result).toEqual({
        LOCAL_VAR: 'local',
        REMOTE_VAR: 'remote'
      });
    });

    test('should apply conflict resolutions', () => {
      const local = { CONFLICT: 'local_value' };
      const remote = { CONFLICT: 'remote_value' };
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: ['CONFLICT'],
        deleteLocal: [],
      deleteRemote: []
      };

      const result = syncEngine.applyDecisions(local, remote, decisions);

      expect(result.CONFLICT).toBe('remote_value');
    });

    test('should handle empty decisions', () => {
      const local = { VAR1: 'value1' };
      const remote = { VAR2: 'value2' };
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const result = syncEngine.applyDecisions(local, remote, decisions);

      expect(result).toEqual(local);
    });

    test('should delete local variables when user confirms deletion', () => {
      const local = {
        DELETE_ME: 'local_value',
        KEEP_ME: 'keep_value'
      };
      const remote = {
        DELETE_ME: 'capy:deleted',
        KEEP_ME: 'keep_value'
      };
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: ['DELETE_ME'],
        deleteRemote: []
      };

      const result = syncEngine.applyDecisions(local, remote, decisions);

      expect(result).toEqual({
        KEEP_ME: 'keep_value'
      });
      expect(result.DELETE_ME).toBeUndefined();
    });
  });

  describe('generateSyncResult', () => {
    test('should generate successful sync result', () => {
      const changeSet: ChangeSet = {
        newLocal: [{ name: 'LOCAL', value: 'val', source: 'local', encrypted: false }],
        newRemote: [{ name: 'REMOTE', value: 'val', source: 'remote', encrypted: true }],
        conflicts: [{ name: 'CONFLICT', localValue: 'local', remoteValue: 'remote' }],
        unchanged: [{ name: 'SAME', value: 'val', source: 'both', encrypted: false }],
        deleted: [],
        deletedLocal: []
      };

      const decisions: UserDecisions = {
        pushVariables: ['LOCAL'],
        pullVariables: ['REMOTE'],
        keepLocal: [],
        keepRemote: ['CONFLICT'],
        deleteLocal: [],
      deleteRemote: []
      };

      const result = syncEngine.generateSyncResult(changeSet, decisions);

      expect(result).toEqual({
        success: true,
        pushed: ['LOCAL'],
        pulled: ['REMOTE'],
        conflicts: ['CONFLICT'],
        errors: [],
        totalVariables: 4
      });
    });

    test('should generate failed sync result with errors', () => {
      const changeSet: ChangeSet = {
        newLocal: [],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = ['Network error', 'Permission denied'];
      const result = syncEngine.generateSyncResult(changeSet, decisions, errors);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(errors);
    });
  });

  describe('mergeWithKeep', () => {
    test('should update existing variables in keep', () => {
      const keep: KeepFile = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test',
        created_at: '2024-01-01T00:00:00Z',
        last_sync: '2024-01-01T00:00:00Z',
        variables: {
          EXISTING_VAR: {
            resource_id: 'res_old',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
          }
        }
      };

      const pushedVariables = {
        EXISTING_VAR: { resource_id: 'res_new' }
      };

      const result = syncEngine.mergeWithKeep(keep, pushedVariables);

      expect(result.variables.EXISTING_VAR.resource_id).toBe('res_new');
      expect(result.variables.EXISTING_VAR.updated_at).not.toBe('2024-01-01T00:00:00Z');
      expect(result.last_sync).not.toBe('2024-01-01T00:00:00Z');
    });

    test('should add new variables to keep', () => {
      const keep: KeepFile = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test',
        created_at: '2024-01-01T00:00:00Z',
        last_sync: '2024-01-01T00:00:00Z',
        variables: {}
      };

      const pushedVariables = {
        NEW_VAR: { resource_id: 'res_123' }
      };

      const result = syncEngine.mergeWithKeep(keep, pushedVariables);

      expect(result.variables.NEW_VAR).toBeDefined();
      expect(result.variables.NEW_VAR.resource_id).toBe('res_123');
      expect(result.variables.NEW_VAR.created_at).toBeDefined();
      expect(result.variables.NEW_VAR.updated_at).toBeDefined();
    });
  });

  describe('createDecryptKey', () => {
    test('should create decrypt key with proper structure', () => {
      const orgId = 'org_123';
      const projectId = 'proj_456';
      const userId = 'user_789';
      const decryptionKey = 'decrypt_key_abc';
      const permissions = ['VAR1', 'VAR2'];

      const result = syncEngine.createDecryptKey(orgId, projectId, userId, decryptionKey, permissions);

      expect(result.version).toBe('1.0');
      expect(result.capy_id).toBe(orgId);
      expect(result.project_id).toBe(projectId);
      expect(result.user_id).toBe(userId);
      expect(result.decryption_key).toBe(decryptionKey);
      expect(result.permissions).toEqual(permissions);
      expect(result.expires_at).toBeDefined();
      
      // Check that expiration is 30 days from now
      const expiresAt = new Date(result.expires_at);
      const expectedExpiration = new Date();
      expectedExpiration.setDate(expectedExpiration.getDate() + 30);
      
      expect(Math.abs(expiresAt.getTime() - expectedExpiration.getTime())).toBeLessThan(1000);
    });
  });

  describe('formatSyncSummary', () => {
    test('should format comprehensive sync summary', () => {
      const changeSet: ChangeSet = {
        newLocal: [
          { name: 'LOCAL1', value: 'val1', source: 'local', encrypted: false },
          { name: 'LOCAL2', value: 'val2', source: 'local', encrypted: false }
        ],
        newRemote: [
          { name: 'REMOTE1', value: 'val1', source: 'remote', encrypted: true }
        ],
        conflicts: [
          { name: 'CONFLICT1', localValue: 'local', remoteValue: 'remote' }
        ],
        unchanged: [
          { name: 'SAME1', value: 'val1', source: 'both', encrypted: false },
          { name: 'SAME2', value: 'val2', source: 'both', encrypted: false },
          { name: 'SAME3', value: 'val3', source: 'both', encrypted: false }
        ],
        deleted: [],
        deletedLocal: []
      };

      const result = syncEngine.formatSyncSummary(changeSet);

      expect(result).toContain('📤 2 new local variable(s)');
      expect(result).toContain('📥 1 new remote variable(s)');
      expect(result).toContain('⚠️  1 conflict(s)');
      expect(result).toContain('✓ 3 unchanged');
    });

    test('should handle empty change set', () => {
      const changeSet: ChangeSet = {
        newLocal: [],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      const result = syncEngine.formatSyncSummary(changeSet);

      expect(result).toBe('');
    });

    test('should handle partial change set', () => {
      const changeSet: ChangeSet = {
        newLocal: [{ name: 'LOCAL', value: 'val', source: 'local', encrypted: false }],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      const result = syncEngine.formatSyncSummary(changeSet);

      expect(result).toBe('📤 1 new local variable(s)');
    });
  });

  describe('validateDecisions', () => {
    const changeSet: ChangeSet = {
      newLocal: [
        { name: 'LOCAL1', value: 'val1', source: 'local', encrypted: false },
        { name: 'LOCAL2', value: 'val2', source: 'local', encrypted: false }
      ],
      newRemote: [
        { name: 'REMOTE1', value: 'val1', source: 'remote', encrypted: true }
      ],
      conflicts: [
        { name: 'CONFLICT1', localValue: 'local', remoteValue: 'remote' }
      ],
      unchanged: [],
        deleted: [],
        deletedLocal: []
    };

    test('should validate correct decisions', () => {
      const decisions: UserDecisions = {
        pushVariables: ['LOCAL1'],
        pullVariables: ['REMOTE1'],
        keepLocal: ['CONFLICT1'],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = syncEngine.validateDecisions(decisions, changeSet);

      expect(errors).toHaveLength(0);
    });

    test('should detect invalid push variables', () => {
      const decisions: UserDecisions = {
        pushVariables: ['INVALID_VAR'],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = syncEngine.validateDecisions(decisions, changeSet);

      expect(errors).toContain('Cannot push INVALID_VAR: not a new local variable, conflict, or deleted variable');
    });

    test('should detect invalid pull variables', () => {
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: ['INVALID_VAR'],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = syncEngine.validateDecisions(decisions, changeSet);

      expect(errors).toContain('Cannot pull INVALID_VAR: not a new remote variable or locally deleted variable');
    });

    test('should detect invalid conflict resolutions', () => {
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: ['INVALID_CONFLICT'],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = syncEngine.validateDecisions(decisions, changeSet);

      expect(errors).toContain('Cannot resolve INVALID_CONFLICT: not a conflict');
    });

    test('should detect duplicate conflict resolutions', () => {
      const decisions: UserDecisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: ['CONFLICT1'],
        keepRemote: ['CONFLICT1'],
        deleteLocal: [],
      deleteRemote: []
      };

      const errors = syncEngine.validateDecisions(decisions, changeSet);

      expect(errors).toContain('Duplicate conflict resolutions detected');
    });
  });
});