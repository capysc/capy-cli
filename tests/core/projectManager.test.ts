import { jest } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ProjectManager } from '../../src/core/projectManager';
import { CapyError, ERROR_CODES, VaultFile } from '../../src/types/index';

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
    test('should detect uninitialized project when no .vault file exists', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.vault')) return false;
        if (path === join(testRoot, '.capy/decrypt')) return false;
        if (path === join(testRoot, '.env')) return true;
        return false;
      });

      const state = await projectManager.detectProjectState();

      expect(state).toEqual({
        initialized: false,
        hasVaultFile: false,
        hasDecryptKey: false,
        hasEnvFile: true
      });
    });

    test('should detect initialized project with valid .vault file', async () => {
      const mockVault: VaultFile = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_sync: '2024-01-01T00:00:00Z',
        variables: {}
      };

      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.vault')) return true;
        if (path === join(testRoot, '.capy/decrypt')) return true;
        if (path === join(testRoot, '.env')) return true;
        return false;
      });

      mockReadFileSync.mockReturnValue(JSON.stringify(mockVault));

      const state = await projectManager.detectProjectState();

      expect(state).toEqual({
        initialized: true,
        hasVaultFile: true,
        hasDecryptKey: true,
        hasEnvFile: true,
        projectName: 'test-project',
        organizationId: 'org_123',
        projectId: 'proj_456'
      });
    });

    test('should throw CapyError for invalid .vault file', async () => {
      mockExistsSync.mockImplementation((path) => {
        if (path === join(testRoot, '.vault')) return true;
        return false;
      });

      mockReadFileSync.mockReturnValue('invalid json');

      await expect(projectManager.detectProjectState()).rejects.toThrow(CapyError);
      await expect(projectManager.detectProjectState()).rejects.toThrow('Invalid .vault file format');
    });
  });

  describe('readVaultFile', () => {
    test('should return null when .vault file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = projectManager.readVaultFile();

      expect(result).toBeNull();
    });

    test('should read and validate .vault file successfully', () => {
      const mockVault: VaultFile = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_sync: '2024-01-01T00:00:00Z',
        variables: {
          'API_KEY': {
            resource_id: 'res_789',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
          }
        }
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockVault));

      const result = projectManager.readVaultFile();

      expect(result).toEqual(mockVault);
      expect(mockReadFileSync).toHaveBeenCalledWith(join(testRoot, '.vault'), 'utf-8');
    });

    test('should throw CapyError for malformed JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json');

      expect(() => projectManager.readVaultFile()).toThrow(CapyError);
      expect(() => projectManager.readVaultFile()).toThrow('Failed to read .vault file');
    });

    test('should throw CapyError for missing required fields', () => {
      const invalidVault = {
        version: '1.0',
        // Missing required fields
        project_name: 'test'
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidVault));

      expect(() => projectManager.readVaultFile()).toThrow(CapyError);
    });

    test('should throw CapyError for invalid variables structure', () => {
      const invalidVault = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        created_at: '2024-01-01T00:00:00Z',
        last_sync: '2024-01-01T00:00:00Z',
        variables: 'invalid' // Should be object
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidVault));

      expect(() => projectManager.readVaultFile()).toThrow('Invalid variables structure');
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

  describe('validateVaultFile', () => {
    test('should validate required fields', () => {
      const validVault = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateVaultFile(validVault)).not.toThrow();
    });

    test('should throw for missing version', () => {
      const invalidVault = {
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateVaultFile(invalidVault)).toThrow('Missing required field: version');
    });

    test('should throw for missing capy_id', () => {
      const invalidVault = {
        version: '1.0',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      expect(() => (projectManager as any).validateVaultFile(invalidVault)).toThrow('Missing required field: capy_id');
    });

    test('should throw for invalid variables type', () => {
      const invalidVault = {
        version: '1.0',
        capy_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: 'not an object'
      };

      expect(() => (projectManager as any).validateVaultFile(invalidVault)).toThrow('Invalid variables structure');
    });
  });

  describe('file path utilities', () => {
    test('should return correct vault path', () => {
      const path = (projectManager as any).getVaultPath();
      expect(path).toBe(join(testRoot, '.vault'));
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