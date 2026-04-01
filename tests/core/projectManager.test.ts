import { jest } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ProjectManager } from '../../src/core/projectManager';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';

// Mock fs module
jest.mock('fs');
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('ProjectManager', () => {
  let projectManager: ProjectManager;
  const testRoot = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();
    projectManager = new ProjectManager(testRoot);
  });

  describe('detectProjectState', () => {
    test('should detect uninitialized project when no .keep file exists', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.keep')) return false;
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

    test('should detect initialized project with valid .keep file', async () => {
      const mockKeep: KeepFile = {
        version: '2.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_updated: '2024-01-01T00:00:00Z',
        variables: {}
      };

      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.keep')) return true;
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

    test('should throw CapyError for invalid .keep file', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.keep')) return true;
        return false;
      });

      mockReadFileSync.mockReturnValue('invalid json');

      await expect(projectManager.detectProjectState()).rejects.toThrow(CapyError);
      await expect(projectManager.detectProjectState()).rejects.toThrow('Invalid .keep file format');
    });
  });

  describe('readKeepFile', () => {
    test('should return null when .keep file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = projectManager.readKeepFile();

      expect(result).toBeNull();
    });

    test('should read and validate .keep file successfully', () => {
      const mockKeep: KeepFile = {
        version: '2.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_updated: '2024-01-01T00:00:00Z',
        variables: {
          'API_KEY': [{
            resource_id: 'res_789',
            created_at: '2024-01-01T00:00:00Z',
            value_hash: 'abc12345'
          }]
        }
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockKeep));

      const result = projectManager.readKeepFile();

      expect(result).toEqual(mockKeep);
      expect(mockReadFileSync).toHaveBeenCalledWith(join(testRoot, '.keep'), 'utf-8');
    });

    test('should throw CapyError for malformed JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json');

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
      expect(() => projectManager.readKeepFile()).toThrow('Failed to read .keep file');
    });

    test('should throw CapyError for missing required fields', () => {
      const invalidKeep = {
        version: '2.0',
        // Missing required fields
        project_name: 'test'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidKeep));

      expect(() => projectManager.readKeepFile()).toThrow(CapyError);
    });

    test('should throw CapyError for invalid variables structure', () => {
      const invalidKeep = {
        version: '2.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_updated: '2024-01-01T00:00:00Z',
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
        version: '2.0',
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
        version: '2.0',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateKeepFile(invalidKeep)).toThrow('Missing required field: org_id');
    });

    test('should throw for invalid variables type', () => {
      const invalidKeep = {
        version: '2.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: 'not an object'
      };

      expect(() => (projectManager as any).validateKeepFile(invalidKeep)).toThrow('Invalid variables structure');
    });
  });

  describe('file path utilities', () => {
    test('should return correct keep path', () => {
      const path = (projectManager as any).getKeepPath();
      expect(path).toBe(join(testRoot, '.keep'));
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