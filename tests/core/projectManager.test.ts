import { mock, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
mock.module('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

afterAll(() => { mock.restore(); });

import { join } from 'path';
import { ProjectManager } from '../../src/core/projectManager';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';

describe('ProjectManager', () => {
  let projectManager: ProjectManager;
  const testRoot = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();
    projectManager = new ProjectManager(testRoot);
  });

  describe('detectProjectState', () => {
    test('should detect uninitialized project when no keep.lock file exists', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, 'keep.lock')) return false;
        if (path === join(testRoot, '.capy/decrypt')) return false;
        if (path === join(testRoot, '.env')) return true;
        return false;
      });

      const state = await projectManager.detectProjectState();

      expect(state).toEqual({
        initialized: false,
        hasKeepFile: false,
        hasDecryptKey: false,
        hasEnvFile: true
      });
    });

    test('should detect initialized project with valid keep.lock file', async () => {
      const mockKeep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, 'keep.lock')) return true;
        if (path === join(testRoot, '.capy/decrypt')) return true;
        if (path === join(testRoot, '.env')) return true;
        return false;
      });

      mockReadFileSync.mockReturnValue(JSON.stringify(mockKeep));

      const state = await projectManager.detectProjectState();

      expect(state).toEqual({
        initialized: true,
        hasKeepFile: true,
        hasDecryptKey: true,
        hasEnvFile: true,
        projectName: 'test-project',
        organizationId: 'org_123',
        projectId: 'proj_456'
      });
    });

    test('should throw CapyError for invalid keep.lock file', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, 'keep.lock')) return true;
        return false;
      });

      mockReadFileSync.mockReturnValue('invalid json');

      await expect(projectManager.detectProjectState()).rejects.toThrow(CapyError);
      await expect(projectManager.detectProjectState()).rejects.toThrow('Invalid keep.lock file format');
    });
  });

  describe('readKeepFile', () => {
    test('should return null when keep.lock file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = projectManager.readKeepFile();

      expect(result).toBeNull();
    });

    test('should read and validate keep.lock file successfully', () => {
      const mockKeep = {
        version: '4.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {
          'API_KEY': {
            resource_id: 'res_789',
            local: 'abc12345',
          }
        }
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockKeep));

      const result = projectManager.readKeepFile();

      expect(result).toEqual(mockKeep);
      expect(mockReadFileSync).toHaveBeenCalledWith(join(testRoot, 'keep.lock'), 'utf-8');
    });

    test('should throw CapyError for malformed JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json');

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
      expect(() => projectManager.readKeepFile()).toThrow('Failed to read keep.lock file');
    });

    test('should throw CapyError for missing required fields', () => {
      const invalidKeep = {
        version: '3.0',
        // Missing required fields
        project_name: 'test'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidKeep));

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
    });

    test('should throw CapyError for invalid variables structure', () => {
      const invalidKeep = {
        version: '4.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: 'invalid' // Should be object
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidKeep));

      expect(() => projectManager.readKeepFile()).toThrow('Invalid variables structure');
    });
  });

  describe('getDefaultProjectName', () => {
    test('should generate clean project name from directory', () => {
      const manager = new ProjectManager('/path/to/My-Project_123');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('my-project-123');
    });

    test('should handle special characters', () => {
      const manager = new ProjectManager('/path/to/My@Project#$%');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('my-project');
    });

    test('should collapse multiple dashes', () => {
      const manager = new ProjectManager('/path/to/my---project');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('my-project');
    });

    test('should remove leading and trailing dashes', () => {
      const manager = new ProjectManager('/path/to/-my-project-');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('my-project');
    });

    test('should return fallback for invalid directory names', () => {
      const manager = new ProjectManager('/path/to/@#$%');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('my-project');
    });

    test('should handle single character directories', () => {
      const manager = new ProjectManager('/path/to/a');
      const name = manager.getDefaultProjectName();
      expect(name).toBe('a');
    });
  });

  describe('validateKeepFile', () => {
    test('should validate required fields', () => {
      const validKeep = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateKeepFile(validKeep)).not.toThrow();
    });

    test('should throw for missing version', () => {
      const invalidKeep = {
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateKeepFile(invalidKeep)).toThrow('Missing required field: version');
    });

    test('should throw for missing org_id', () => {
      const invalidKeep = {
        version: '3.0',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateKeepFile(invalidKeep)).toThrow('Missing required field: org_id');
    });

    test('should throw for invalid variables type', () => {
      const invalidKeep = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: 'not an object'
      };

      expect(() => (projectManager as any).validateKeepFile(invalidKeep)).toThrow('Invalid variables structure');
    });
  });

  describe('migrateKeepIfNeeded', () => {
    test('should migrate v2 keep to v3 by stripping timestamps', () => {
      const v2Keep = {
        version: '2.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_updated: '2024-06-15T12:00:00Z',
        variables: {
          API_KEY: [{
            resource_id: 'res_abc',
            created_at: '2024-01-01T00:00:00Z',
            value_hash: 'hash123'
          }]
        }
      };

      const result = (projectManager as any).migrateKeepIfNeeded(v2Keep);

      // v2 → v3 → v4: timestamps stripped, arrays converted to v4 flat objects
      expect(result.version).toBe('4.0');
      expect(result.created_at).toBeUndefined();
      expect(result.last_updated).toBeUndefined();
      // v4: variables are flat objects with env hashes, not arrays
      expect(result.variables.API_KEY.resource_id).toBe('res_abc');
      expect(result.variables.API_KEY.local).toBe('hash123');
    });

    test('should migrate v3 keep to v4', () => {
      const v3Keep = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {
          DB_URL: [{ resource_id: 'r1', value_hash: 'h1' }],
        }
      };

      const result = (projectManager as any).migrateKeepIfNeeded(v3Keep);

      expect(result.version).toBe('4.0');
      expect(result.variables.DB_URL.resource_id).toBe('r1');
      expect(result.variables.DB_URL.local).toBe('h1');
    });
  });

  describe('file path utilities', () => {
    test('should return correct keep path', () => {
      const path = (projectManager as any).getKeepPath();
      expect(path).toBe(join(testRoot, 'keep.lock'));
    });

    test('should return correct decrypt path', () => {
      const path = (projectManager as any).getDecryptPath();
      expect(path).toBe(join(testRoot, '.capy/decrypt'));
    });

    test('should return correct env path', () => {
      const path = (projectManager as any).getEnvPath();
      expect(path).toBe(join(testRoot, '.env'));
    });
  });
});