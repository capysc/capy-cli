import { spyOn, jest, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CapyCommand } from '../../src/commands/capyCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { SyncEngine } from '../../src/sync/syncEngine';
import { PromptEngine } from '../../src/ui/promptEngine';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, KeepFile } from '../../src/types/index';
import * as fs from 'fs';

// Integration tests - testing components working together without full mocking
describe('CLI Integration Tests', () => {
  let tempDir: string;
  let capyCommand: CapyCommand;
  let projectManager: ProjectManager;
  let fileManager: FileManager;
  let syncEngine: SyncEngine;

  const mockConfig = {
    workos: {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      redirectUri: 'http://localhost:3001/callback',
      baseUrl: 'https://api.workos.com'
    },
    service: {
      url: 'http://localhost:3002'
    }
  };

  beforeEach(() => {
    // Use a real temp directory path for integration testing
    tempDir = '/tmp/capy-test-' + Date.now();
    
    // Create real instances for integration testing
    projectManager = new ProjectManager(tempDir);
    fileManager = new FileManager(tempDir);
    syncEngine = new SyncEngine();
  });

  describe('Project State Detection Integration', () => {
    test('should correctly detect uninitialized project state', async () => {
      // Mock file system operations since we're not actually creating files
      spyOn(fs, 'existsSync').mockImplementation((path: any) => {
        if (path.includes('keep.lock')) return false;
        if (path.includes('.env')) return true;
        return false;
      });

      const state = await projectManager.detectProjectState();

      expect(state).toMatchObject({
        initialized: false,
        hasKeepFile: false,
        hasEnvFile: true,
        activeBranch: null,
      });
    });

    test('should correctly detect initialized project state', async () => {
      const mockKeep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      spyOn(fs, 'existsSync').mockImplementation((path: any) => {
        if (path.includes('keep.lock')) return true;
        if (path.includes('.env')) return true;
        return false;
      });

      spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockKeep));

      const state = await projectManager.detectProjectState();

      expect(state).toMatchObject({
        initialized: true,
        hasKeepFile: true,
        hasEnvFile: true,
        projectName: 'test-project',
        organizationId: 'org_123',
        projectId: 'proj_456',
        activeBranch: null,
      });
    });
  });

  describe('File Operations Integration', () => {
    test('should handle env file parsing correctly', () => {
      const envContent = `API_KEY=secret123
DB_URL=postgres://localhost:5432/db
EMPTY_VAR=
# This is a comment
DEBUG=true`;

      const result = fileManager.parseEnvContent(envContent);

      expect(result).toEqual({
        API_KEY: 'secret123',
        DB_URL: 'postgres://localhost:5432/db',
        EMPTY_VAR: '',
        DEBUG: 'true'
      });
    });

    test('should create proper keep file structure', () => {
      const mockKeep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'integration-test',
        variables: {
          API_KEY: [
            { resource_id: 'res_123', value_hash: 'testhash' },
          ]
        }
      };

      const writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      fileManager.writeKeepFile(mockKeep);

      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining('keep.lock'),
        expect.stringContaining('"version": "3.0"'),
        'utf-8'
      );
    });

  });

  describe('Sync Engine Integration', () => {
    test('should correctly compare local and remote environments', () => {
      const localEnv = {
        LOCAL_ONLY: 'local_value',
        CONFLICT_VAR: 'local_conflict',
        SAME_VAR: 'same_value'
      };

      const remoteEnv = {
        REMOTE_ONLY: 'remote_value',
        CONFLICT_VAR: 'remote_conflict',
        SAME_VAR: 'same_value'
      };

      const changeSet = syncEngine.compareEnvironments(localEnv, remoteEnv);

      expect(changeSet.newLocal).toHaveLength(1);
      expect(changeSet.newLocal[0].name).toBe('LOCAL_ONLY');
      
      expect(changeSet.newRemote).toHaveLength(1);
      expect(changeSet.newRemote[0].name).toBe('REMOTE_ONLY');
      
      expect(changeSet.conflicts).toHaveLength(1);
      expect(changeSet.conflicts[0].name).toBe('CONFLICT_VAR');
      
      expect(changeSet.unchanged).toHaveLength(1);
      expect(changeSet.unchanged[0].name).toBe('SAME_VAR');
    });

    test('should apply user decisions correctly', () => {
      const localEnv = { LOCAL_VAR: 'local' };
      const remoteEnv = { REMOTE_VAR: 'remote', CONFLICT: 'remote_val' };
      
      const decisions = {
        pushVariables: ['LOCAL_VAR'],
        pullVariables: ['REMOTE_VAR'],
        keepLocal: [],
        keepRemote: ['CONFLICT'],
        deleteLocal: [],
      deleteRemote: []
      };

      const result = syncEngine.applyDecisions(localEnv, remoteEnv, decisions);

      expect(result).toEqual({
        LOCAL_VAR: 'local',
        REMOTE_VAR: 'remote',
        CONFLICT: 'remote_val'
      });
    });

    test('should merge keep file with pushed variables', () => {
      const originalKeep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test',
        variables: {
          EXISTING_VAR: [
            { resource_id: 'res_old', value_hash: 'abc12345', branch: 'development' },
          ]
        }
      };

      const pushedVariables = {
        NEW_VAR: { resource_id: 'res_new', value_hash: 'h1' },
        EXISTING_VAR: { resource_id: 'res_updated', value_hash: 'h2' }
      };

      const updatedKeep = syncEngine.mergeWithKeep(originalKeep, pushedVariables);

      expect(updatedKeep.variables.NEW_VAR).toBeDefined();
      expect(updatedKeep.variables.NEW_VAR[0].resource_id).toBe('res_new');
      expect(updatedKeep.variables.EXISTING_VAR[0].resource_id).toBe('res_updated');
    });

    test('should validate user decisions correctly', () => {
      const changeSet = {
        newLocal: [{ name: 'LOCAL_VAR', value: 'val', source: 'local' as const, encrypted: false }],
        newRemote: [{ name: 'REMOTE_VAR', value: 'val', source: 'remote' as const, encrypted: true }],
        conflicts: [{ name: 'CONFLICT_VAR', localValue: 'local', remoteValue: 'remote' }],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      // Valid decisions
      const validDecisions = {
        pushVariables: ['LOCAL_VAR'],
        pullVariables: ['REMOTE_VAR'],
        keepLocal: ['CONFLICT_VAR'],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const validErrors = syncEngine.validateDecisions(validDecisions, changeSet);
      expect(validErrors).toHaveLength(0);

      // Invalid decisions
      const invalidDecisions = {
        pushVariables: ['INVALID_VAR'],
        pullVariables: ['REMOTE_VAR'],
        keepLocal: ['CONFLICT_VAR'],
        keepRemote: ['CONFLICT_VAR'], // Duplicate conflict resolution
        deleteLocal: [],
      deleteRemote: []
      };

      const invalidErrors = syncEngine.validateDecisions(invalidDecisions, changeSet);
      expect(invalidErrors.length).toBeGreaterThan(0);
      expect(invalidErrors).toContain('Cannot push INVALID_VAR: not a new local variable, conflict, or deleted variable');
      expect(invalidErrors).toContain('Duplicate conflict resolutions detected');
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle malformed keep file gracefully', () => {
      spyOn(fs, 'existsSync').mockReturnValue(true);
      spyOn(fs, 'readFileSync').mockReturnValue('invalid json');

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
      expect(() => projectManager.readKeepFile()).toThrow('Failed to read keep.lock file');
    });

    test('should handle missing required keep file fields', () => {
      const invalidKeep = {
        version: '3.0',
        // Missing required fields
        project_name: 'test'
      };

      spyOn(fs, 'existsSync').mockReturnValue(true);
      spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(invalidKeep));

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
    });

    test('should generate proper error messages for sync failures', () => {
      const changeSet = {
        newLocal: [],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };
      
      const decisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };
      
      const errors = ['Network timeout', 'Permission denied'];
      
      const syncResult = syncEngine.generateSyncResult(changeSet, decisions, errors);
      
      expect(syncResult.success).toBe(false);
      expect(syncResult.errors).toEqual(errors);
    });
  });

  describe('Project Name Generation Integration', () => {
    test('should generate clean project names from directory paths', () => {
      const testCases = [
        { input: '/path/to/My-Project_123', expected: 'my-project-123' },
        { input: '/path/to/My@Project#$%', expected: 'my-project' },
        { input: '/path/to/my---project', expected: 'my-project' },
        { input: '/path/to/-my-project-', expected: 'my-project' },
        { input: '/path/to/@#$%', expected: 'my-project' },
        { input: '/path/to/a', expected: 'a' }
      ];

      testCases.forEach(({ input, expected }) => {
        const manager = new ProjectManager(input);
        const result = manager.getDefaultProjectName();
        expect(result).toBe(expected);
      });
    });
  });

  afterEach(() => {
    // Clean up mocks
    jest.restoreAllMocks(); // Bun supports this via jest global
  });
});