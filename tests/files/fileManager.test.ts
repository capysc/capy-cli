import { jest } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { FileManager } from '../../src/files/fileManager';
import { KeepFile, DecryptKey, CapyError, ERROR_CODES } from '../../src/types/index';

// Mock fs module
jest.mock('fs');

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockAppendFileSync = appendFileSync as jest.MockedFunction<typeof appendFileSync>;
const mockChmodSync = chmodSync as jest.MockedFunction<typeof chmodSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>;

describe('FileManager', () => {
  let fileManager: FileManager;
  const testRoot = '/test/project';

  beforeEach(() => {
    jest.clearAllMocks();
    fileManager = new FileManager(testRoot);

    // Setup default mock behaviors
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockWriteFileSync.mockImplementation(() => {});
    mockAppendFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => {});
    mockUnlinkSync.mockImplementation(() => {});
  });

  describe('readEnvFile', () => {
    test('should read and parse existing .env file', () => {
      const envContent = 'API_KEY=test123\nDB_URL=postgres://localhost';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(envContent);

      const result = fileManager.readEnvFile();

      expect(result).toEqual({
        API_KEY: 'test123',
        DB_URL: 'postgres://localhost'
      });
      expect(mockReadFileSync).toHaveBeenCalledWith(join(testRoot, '.env'), 'utf-8');
    });

    test('should return empty object for non-existent file', () => {
      mockExistsSync.mockReturnValue(false);

      const result = fileManager.readEnvFile();

      expect(result).toEqual({});
    });

    test('should read from custom path', () => {
      const customPath = '/custom/.env';
      const envContent = 'CUSTOM=value';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(envContent);

      const result = fileManager.readEnvFile(customPath);

      expect(result).toEqual({ CUSTOM: 'value' });
      expect(mockReadFileSync).toHaveBeenCalledWith(customPath, 'utf-8');
    });

    test('should throw CapyError on read failure', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => fileManager.readEnvFile()).toThrow(CapyError);
      expect(() => fileManager.readEnvFile()).toThrow('Failed to read .env file');
    });
  });

  describe('writeEnvFile', () => {
    test('should write variables to .env file', () => {
      const variables = { API_KEY: 'test123', DB_URL: 'postgres://localhost' };
      mockExistsSync.mockReturnValue(false); // No backup needed

      fileManager.writeEnvFile(variables);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join(testRoot, '.env'),
        'API_KEY=test123\nDB_URL=postgres://localhost\n',
        'utf-8'
      );
    });

    test('should create directory if it does not exist', () => {
      const variables = { API_KEY: 'test123' };
      const envPath = join(testRoot, 'subdir', '.env');
      mockExistsSync.mockImplementation((path) => {
        if (path === dirname(envPath)) return false;
        return false;
      });

      fileManager.writeEnvFile(variables, envPath);

      expect(mockMkdirSync).toHaveBeenCalledWith(dirname(envPath), { recursive: true });
    });

    test('should create and remove backup on successful write', () => {
      const variables = { API_KEY: 'test123' };
      const envPath = join(testRoot, '.env');
      const backupPath = `${envPath}.backup`;

      // Mock existing file for backup
      mockExistsSync.mockImplementation((path) => {
        if (path === envPath) return true;
        if (path === backupPath) return true;
        if (path === dirname(envPath)) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue('old content');

      fileManager.writeEnvFile(variables);

      // Should create backup
      expect(mockWriteFileSync).toHaveBeenCalledWith(backupPath, 'old content', 'utf-8');
      // Should write new content
      expect(mockWriteFileSync).toHaveBeenCalledWith(envPath, 'API_KEY=test123\n', 'utf-8');
      // Should remove backup
      expect(mockUnlinkSync).toHaveBeenCalledWith(backupPath);
    });

    test('should restore backup on write failure', () => {
      const variables = { API_KEY: 'test123' };
      const envPath = join(testRoot, '.env');
      const backupPath = `${envPath}.backup`;

      mockExistsSync.mockImplementation((path) => {
        if (path === envPath) return true;
        if (path === backupPath) return true;
        if (path === dirname(envPath)) return true;
        return false;
      });

      (mockReadFileSync as any).mockImplementation((path: any) => {
        if (path === envPath) return 'old content';
        if (path === backupPath) return 'old content';
        return '';
      });

      // Mock write failure
      let writeCallCount = 0;
      mockWriteFileSync.mockImplementation((path, content) => {
        writeCallCount++;
        if (writeCallCount === 2) { // Second call is the actual write
          throw new Error('Write failed');
        }
      });

      expect(() => fileManager.writeEnvFile(variables)).toThrow(CapyError);

      // Should restore backup
      expect(mockWriteFileSync).toHaveBeenCalledWith(envPath, 'old content', 'utf-8');
    });
  });

  describe('parseEnvContent', () => {
    test('should parse env content string', () => {
      const content = 'API_KEY=test123\nDB_URL=postgres://localhost\n# Comment\nEMPTY=';

      const result = fileManager.parseEnvContent(content);

      expect(result).toEqual({
        API_KEY: 'test123',
        DB_URL: 'postgres://localhost',
        EMPTY: ''
      });
    });

    test('should handle empty content', () => {
      const result = fileManager.parseEnvContent('');
      expect(result).toEqual({});
    });
  });

  describe('writeKeepFile', () => {
    test('should write keep file with proper formatting', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      mockExistsSync.mockReturnValue(false); // No backup needed

      fileManager.writeKeepFile(keep);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join(testRoot, 'keep.lock'),
        JSON.stringify(keep, null, 2) + '\n',
        'utf-8'
      );
    });

    test('should handle write failure with backup restoration', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {}
      };

      const keepPath = join(testRoot, 'keep.lock');
      mockExistsSync.mockImplementation((path) => path === keepPath);
      mockReadFileSync.mockReturnValue('old keep content');

      let writeCallCount = 0;
      mockWriteFileSync.mockImplementation(() => {
        writeCallCount++;
        if (writeCallCount === 2) {
          throw new Error('Write failed');
        }
      });

      expect(() => fileManager.writeKeepFile(keep)).toThrow(CapyError);
    });
  });

  describe('writeKeepFile deterministic output', () => {
    test('should sort variables alphabetically and entries by branch', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test-project',
        variables: {
          ZEBRA_VAR: [{ resource_id: 'res_z', value_hash: 'hz' }],
          ALPHA_VAR: [
            { resource_id: 'res_a_staging', branch: 'staging', value_hash: 'has' },
            { resource_id: 'res_a', value_hash: 'ha' },
          ],
          MIDDLE_VAR: [{ resource_id: 'res_m', value_hash: 'hm' }],
        }
      };

      mockExistsSync.mockReturnValue(false);
      fileManager.writeKeepFile(keep);

      const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      // Variables should be sorted alphabetically
      const varNames = Object.keys(parsed.variables);
      expect(varNames).toEqual(['ALPHA_VAR', 'MIDDLE_VAR', 'ZEBRA_VAR']);

      // Entries should be sorted: branchless first, then alphabetical
      expect(parsed.variables.ALPHA_VAR[0].branch).toBeUndefined();
      expect(parsed.variables.ALPHA_VAR[1].branch).toBe('staging');
    });

    test('should produce identical output regardless of insertion order', () => {
      const keepA: KeepFile = {
        version: '3.0',
        org_id: 'org_1',
        project_id: 'proj_1',
        project_name: 'test',
        variables: {
          B_VAR: [{ resource_id: 'rb', value_hash: 'hb' }],
          A_VAR: [{ resource_id: 'ra', value_hash: 'ha' }],
        }
      };

      const keepB: KeepFile = {
        version: '3.0',
        org_id: 'org_1',
        project_id: 'proj_1',
        project_name: 'test',
        variables: {
          A_VAR: [{ resource_id: 'ra', value_hash: 'ha' }],
          B_VAR: [{ resource_id: 'rb', value_hash: 'hb' }],
        }
      };

      mockExistsSync.mockReturnValue(false);

      fileManager.writeKeepFile(keepA);
      const outputA = mockWriteFileSync.mock.calls[0][1] as string;

      mockWriteFileSync.mockClear();

      fileManager.writeKeepFile(keepB);
      const outputB = mockWriteFileSync.mock.calls[0][1] as string;

      expect(outputA).toBe(outputB);
    });
  });

  describe('writeDecryptKey', () => {
    test('should write decrypt key with secure permissions', () => {
      const decryptKey: DecryptKey = {
        version: '1.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        user_id: 'user_789',
        decryption_key: 'key_abc',
        expires_at: '2024-02-01T00:00:00Z',
        permissions: ['VAR1', 'VAR2']
      };

      mockExistsSync.mockReturnValue(false); // No backup needed

      fileManager.writeDecryptKey(decryptKey);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join(testRoot, '.capy/decrypt'),
        JSON.stringify(decryptKey, null, 2) + '\n',
        { encoding: 'utf-8', mode: 0o600 }
      );
    });

    test('should handle write failure with error throwing', () => {
      const decryptKey: DecryptKey = {
        version: '1.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        user_id: 'user_789',
        decryption_key: 'key_abc',
        expires_at: '2024-02-01T00:00:00Z',
        permissions: []
      };

      mockExistsSync.mockReturnValue(false);
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => fileManager.writeDecryptKey(decryptKey)).toThrow(CapyError);
      expect(() => fileManager.writeDecryptKey(decryptKey)).toThrow('Failed to write decrypt file');
    });
  });

  describe('updateGitignore', () => {
    test('should add new entries to .gitignore', () => {
      const entries = ['.env', '.capy/decrypt'];
      mockExistsSync.mockReturnValue(false); // No existing .gitignore

      fileManager.updateGitignore(entries);

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '\n# Capy\n',
        'utf-8'
      );
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '.env\n.capy/decrypt\n',
        'utf-8'
      );
    });

    test('should not add duplicate entries', () => {
      const entries = ['.env', '.capy/decrypt'];
      const existingContent = '.env\nnode_modules\n.capy/decrypt\n';

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(existingContent);

      fileManager.updateGitignore(entries);

      // Should not append anything since entries already exist
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    test('should add only missing entries', () => {
      const entries = ['.env', '.capy/decrypt', '.capy/token'];
      const existingContent = '.env\nnode_modules\n';

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(existingContent);

      fileManager.updateGitignore(entries);

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '\n# Capy\n',
        'utf-8'
      );
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '.capy/decrypt\n.capy/token\n',
        'utf-8'
      );
    });

    test('should handle existing .gitignore without trailing newline', () => {
      const entries = ['.env'];
      const existingContent = 'node_modules'; // No trailing newline

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(existingContent);

      fileManager.updateGitignore(entries);

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '\n',
        'utf-8'
      );
    });

    test('should throw CapyError on write failure', () => {
      const entries = ['.env'];
      mockExistsSync.mockReturnValue(false);
      mockAppendFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => fileManager.updateGitignore(entries)).toThrow(CapyError);
      expect(() => fileManager.updateGitignore(entries)).toThrow('Failed to update .gitignore');
    });
  });

  describe('ensureCapyGitignore', () => {
    test('should ensure .env and .capy are in .gitignore', () => {
      const existingContent = 'node_modules\n';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(existingContent);

      fileManager.ensureCapyGitignore();

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '\n# Capy\n',
        'utf-8'
      );
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        '.env\n.capy\n',
        'utf-8'
      );
    });
  });

  describe('backup operations', () => {
    test('should create backup for existing file', () => {
      const filePath = '/test/file.txt';
      const backupPath = '/test/file.txt.backup';
      const content = 'file content';

      mockExistsSync.mockImplementation((path) => path === filePath);
      mockReadFileSync.mockReturnValue(content);

      const result = (fileManager as any).createBackup(filePath);

      expect(result).toBe(backupPath);
      expect(mockWriteFileSync).toHaveBeenCalledWith(backupPath, content, 'utf-8');
    });

    test('should return null for non-existent file', () => {
      mockExistsSync.mockReturnValue(false);

      const result = (fileManager as any).createBackup('/test/nonexistent.txt');

      expect(result).toBeNull();
    });

    test('should restore backup successfully', () => {
      const backupPath = '/test/file.txt.backup';
      const originalPath = '/test/file.txt';
      const backupContent = 'backup content';

      mockExistsSync.mockImplementation((path) => path === backupPath);
      mockReadFileSync.mockReturnValue(backupContent);

      (fileManager as any).restoreBackup(backupPath, originalPath);

      expect(mockWriteFileSync).toHaveBeenCalledWith(originalPath, backupContent, 'utf-8');
      expect(mockUnlinkSync).toHaveBeenCalledWith(backupPath);
    });

    test('should handle backup restoration failure silently', () => {
      const backupPath = '/test/file.txt.backup';
      const originalPath = '/test/file.txt';

      mockReadFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });

      expect(() => (fileManager as any).restoreBackup(backupPath, originalPath)).not.toThrow();
    });

    test('should remove backup file', () => {
      const backupPath = '/test/file.txt.backup';
      mockExistsSync.mockReturnValue(true);

      (fileManager as any).removeBackup(backupPath);

      expect(mockUnlinkSync).toHaveBeenCalledWith(backupPath);
    });

    test('should handle backup removal failure silently', () => {
      const backupPath = '/test/file.txt.backup';
      mockExistsSync.mockReturnValue(true);
      mockUnlinkSync.mockImplementation(() => {
        throw new Error('Unlink failed');
      });

      expect(() => (fileManager as any).removeBackup(backupPath)).not.toThrow();
    });
  });

  describe('ensureDirectoryExists', () => {
    test('should create directory if it does not exist', () => {
      const dirPath = '/test/new/directory';
      mockExistsSync.mockReturnValue(false);

      (fileManager as any).ensureDirectoryExists(dirPath);

      expect(mockMkdirSync).toHaveBeenCalledWith(dirPath, { recursive: true });
    });

    test('should not create directory if it already exists', () => {
      const dirPath = '/test/existing/directory';
      mockExistsSync.mockReturnValue(true);

      (fileManager as any).ensureDirectoryExists(dirPath);

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('backupPlaintextEnv', () => {
    test('should backup plaintext .env to .env.pre-capy.old with warning header', () => {
      const envContent = 'DB_URL=postgres://localhost\nAPI_KEY=sk_live_abc123\n';
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === join(testRoot, '.env')) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(envContent);

      const result = fileManager.backupPlaintextEnv();

      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join(testRoot, '.env.pre-capy.old'),
        expect.stringContaining('From Capy'),
        'utf-8'
      );
      // Verify the original content is included after the header
      const writtenContent = (mockWriteFileSync as jest.Mock).mock.calls.find(
        (c: any[]) => String(c[0]).endsWith('.env.pre-capy.old')
      )?.[1] as string;
      expect(writtenContent).toContain('# DB_URL=postgres://localhost');
      expect(writtenContent).toContain('# API_KEY=sk_live_abc123');
      expect(writtenContent).toContain('unencrypted');
    });

    test('should add .env.pre-capy.old to .gitignore', () => {
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === join(testRoot, '.env')) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue('KEY=plaintext_value\n');

      fileManager.backupPlaintextEnv();

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        join(testRoot, '.gitignore'),
        expect.stringContaining('.env.pre-capy.old'),
        'utf-8'
      );
    });

    test('should return false if .env does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = fileManager.backupPlaintextEnv();

      expect(result).toBe(false);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    test('should return false if .env is already encrypted', () => {
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === join(testRoot, '.env')) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(
        'DB_URL=capy:abc12:encrypted_data\nAPI_KEY=capy:def34:encrypted_data\n'
      );

      const result = fileManager.backupPlaintextEnv();

      expect(result).toBe(false);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    test('should backup if mix of plaintext and encrypted values', () => {
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === join(testRoot, '.env')) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(
        'DB_URL=capy:abc12:encrypted_data\nNEW_KEY=plaintext_value\n'
      );

      const result = fileManager.backupPlaintextEnv();

      expect(result).toBe(true);
    });

    test('should use custom path when provided', () => {
      const customPath = '/custom/.env';
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === customPath) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue('KEY=value\n');

      fileManager.backupPlaintextEnv(customPath);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/custom/.env.pre-capy.old',
        expect.stringContaining('# KEY=value'),
        'utf-8'
      );
    });
  });
});