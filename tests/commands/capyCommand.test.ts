import { jest } from '@jest/globals';
import { CapyCommand } from '../../src/commands/capyCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { SyncEngine } from '../../src/sync/syncEngine';
import { PromptEngine } from '../../src/ui/promptEngine';
import { CapyError, ERROR_CODES } from '../../src/types/index';

// Mock all dependencies
jest.mock('../../src/core/projectManager');
jest.mock('../../src/files/fileManager');
jest.mock('../../src/auth/authService');
jest.mock('../../src/service/serviceClient');
jest.mock('../../src/sync/syncEngine');
jest.mock('../../src/ui/promptEngine');
jest.mock('inquirer');
jest.mock('../../src/ui/spinner', () => ({
  __esModule: true,
  default: (text: string) => ({
    start: () => ({
      fail: jest.fn(),
      succeed: jest.fn(),
      text: ''
    })
  })
}));

const MockProjectManager = ProjectManager as jest.MockedClass<typeof ProjectManager>;
const MockFileManager = FileManager as jest.MockedClass<typeof FileManager>;
const MockAuthService = AuthService as jest.MockedClass<typeof AuthService>;
const MockServiceClient = ServiceClient as jest.MockedClass<typeof ServiceClient>;
const MockSyncEngine = SyncEngine as jest.MockedClass<typeof SyncEngine>;
const MockPromptEngine = PromptEngine as jest.MockedClass<typeof PromptEngine>;

describe('CapyCommand', () => {
  let capyCommand: CapyCommand;
  let mockProjectManager: jest.Mocked<ProjectManager>;
  let mockFileManager: jest.Mocked<FileManager>;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockServiceClient: jest.Mocked<ServiceClient>;
  let mockSyncEngine: jest.Mocked<SyncEngine>;
  let mockPromptEngine: jest.Mocked<PromptEngine>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock process.exit globally to prevent child process crashes
    jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Create mock instances
    mockProjectManager = {
      detectProjectState: jest.fn(),
      getDefaultProjectName: jest.fn().mockReturnValue('test-project'),
      getEnvPath: jest.fn().mockReturnValue('.env'),
      readKeepFile: jest.fn(),
      readDecryptKey: jest.fn(),
      readSyncState: jest.fn().mockReturnValue(null),
      readActiveBranch: jest.fn().mockReturnValue(null)
    } as any;

    mockFileManager = {
      writeKeepFile: jest.fn(),
      writeDecryptKey: jest.fn(),
      writeSyncState: jest.fn(),
      writeEncryptedEnvFile: jest.fn(),
      readEnvFile: jest.fn().mockReturnValue({}),
      readEncryptedEnvFile: jest.fn().mockReturnValue({}),
      parseEnvContent: jest.fn().mockReturnValue({}),
      ensureCapyGitignore: jest.fn(),
      isSnippetEncrypted: jest.fn().mockReturnValue(false),
      isEncrypted: jest.fn().mockReturnValue(false),
      decryptValue: jest.fn((value) => value)
    } as any;

    mockAuthService = {
      authenticate: jest.fn(),
      getToken: jest.fn(),
      setOrganizationId: jest.fn(),
      createOrganization: jest.fn()
    } as any;

    mockServiceClient = {
      setToken: jest.fn(),
      setTokenRefresher: jest.fn(),
      initializeProject: jest.fn(),
      getDecryptData: jest.fn(),
      pushVariables: jest.fn()
    } as any;

    mockSyncEngine = {
      createDecryptKey: jest.fn().mockReturnValue('mock-decrypt-key'),
      compareEnvironments: jest.fn(),
      formatSyncSummary: jest.fn(),
      validateDecisions: jest.fn().mockReturnValue([]),
      applyDecisions: jest.fn(),
      mergeWithKeep: jest.fn(),
      generateSyncResult: jest.fn()
    } as any;

    mockPromptEngine = {
      promptForProjectName: jest.fn(),
      promptForChanges: jest.fn(),
      confirmSync: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      displaySuccess: jest.fn(),
      displayError: jest.fn(),
      displayWarning: jest.fn()
    } as any;

    // Mock inquirer to auto-answer org selection prompts
    const mockInquirer = require('inquirer');
    mockInquirer.default = {
      prompt: (jest.fn() as any).mockResolvedValue({ orgId: 'org-123', orgName: 'Test Org' }),
      Separator: class Separator { constructor() {} },
    };

    // Mock constructors
    MockProjectManager.mockImplementation(() => mockProjectManager);
    MockFileManager.mockImplementation(() => mockFileManager);
    MockAuthService.mockImplementation(() => mockAuthService);
    MockServiceClient.mockImplementation(() => mockServiceClient);
    MockSyncEngine.mockImplementation(() => mockSyncEngine);
    MockPromptEngine.mockImplementation(() => mockPromptEngine);

    capyCommand = new CapyCommand();
  });

  describe('constructor', () => {
    test('should initialize all dependencies', () => {
      // Reset call counts since we already have one capyCommand instance from beforeEach
      jest.clearAllMocks();
      
      const command = new CapyCommand();
      
      expect(MockProjectManager).toHaveBeenCalledTimes(1);
      expect(MockFileManager).toHaveBeenCalledTimes(1);
      expect(MockAuthService).toHaveBeenCalledTimes(1);
      expect(MockServiceClient).toHaveBeenCalledTimes(1);
      expect(MockSyncEngine).toHaveBeenCalledTimes(1);
      expect(MockPromptEngine).toHaveBeenCalledTimes(1);
    });

    test('should accept options', () => {
      const options = { envPath: '.env.custom', verbose: true };
      const command = new CapyCommand(options);
      
      expect((command as any).options).toEqual(options);
    });
  });

  describe('execute', () => {
    test('should initialize project when not initialized', async () => {
      mockProjectManager.detectProjectState.mockResolvedValue({
        initialized: false,
        hasKeepFile: false,
        hasDecryptKey: false,
        hasEnvFile: false,
        projectName: undefined,
        projectId: undefined,
        organizationId: undefined
      });

      const spy = jest.spyOn(capyCommand as any, 'initializeProject').mockResolvedValue(undefined);

      await capyCommand.execute();

      expect(mockProjectManager.detectProjectState).toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
    });

    test('should sync project when initialized', async () => {
      const projectState = {
        initialized: true,
        hasKeepFile: true,
        hasDecryptKey: true,
        hasEnvFile: true,
        projectName: 'test-project',
        projectId: 'proj-123',
        organizationId: 'org-123'
      };

      mockProjectManager.detectProjectState.mockResolvedValue(projectState);
      const spy = jest.spyOn(capyCommand as any, 'syncProject').mockResolvedValue(undefined);

      await capyCommand.execute();

      expect(mockProjectManager.detectProjectState).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(projectState);
    });

    test('should not initialize project if .keep file already exists', async () => {
      mockProjectManager.detectProjectState.mockResolvedValue({
        initialized: true,
        hasKeepFile: true,
        hasDecryptKey: false,
        hasEnvFile: false,
        projectName: 'existing-project',
        projectId: 'proj-123',
        organizationId: 'org-123'
      });

      const initSpy = jest.spyOn(capyCommand as any, 'initializeProject').mockResolvedValue(undefined);
      const syncSpy = jest.spyOn(capyCommand as any, 'syncProject').mockResolvedValue(undefined);

      await capyCommand.execute();

      expect(mockProjectManager.detectProjectState).toHaveBeenCalled();
      expect(initSpy).not.toHaveBeenCalled();
      expect(syncSpy).toHaveBeenCalled();
    });

    test('should handle errors properly', async () => {
      mockProjectManager.detectProjectState.mockRejectedValue(new Error('Test error'));

      // Mock process.exit to prevent actual exit during tests
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await capyCommand.execute();

      // execute() catches errors and calls displayErrorAndExit which calls process.exit(1)
      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });

    test('should handle scenario where project state detection fails during initialization', async () => {
      mockProjectManager.detectProjectState.mockRejectedValue(
        new CapyError('Failed to detect project state', ERROR_CODES.INVALID_FORMAT)
      );

      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await capyCommand.execute();

      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe('initializeProject', () => {
    beforeEach(() => {
      // Mock successful authentication
      mockAuthService.authenticate.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        organization_name: 'Test Org',
        user_id: 'user-456',
        user_email: 'test@example.com',
        organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }]
      });

      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      });

      mockServiceClient.initializeProject.mockResolvedValue({
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        created: true
      });

      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: 'TEST_VAR=value',
        expires_at: new Date().toISOString()
      });

      mockPromptEngine.promptForProjectName.mockResolvedValue('test-project');
      mockFileManager.parseEnvContent.mockReturnValue({ TEST_VAR: 'value' });
    });

    test('should complete initialization flow successfully', async () => {
      await (capyCommand as any).initializeProject();

      expect(mockAuthService.authenticate).toHaveBeenCalled();
      expect(mockServiceClient.setToken).toHaveBeenCalled();
      expect(mockPromptEngine.promptForProjectName).toHaveBeenCalledWith('test-project');
      expect(mockServiceClient.initializeProject).toHaveBeenCalledWith('test-project', 'org-123');
      expect(mockFileManager.writeKeepFile).toHaveBeenCalled();
      expect(mockServiceClient.getDecryptData).toHaveBeenCalledWith('proj-123');
      expect(mockFileManager.writeDecryptKey).toHaveBeenCalled();
      expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalled();
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
    });

    test('should log correct message when .keep file is not found', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith('No .keep file found - initializing project...');
      
      consoleSpy.mockRestore();
    });

    test('should create .keep file with correct structure', async () => {
      await (capyCommand as any).initializeProject();

      expect(mockFileManager.writeKeepFile).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '2.0',
          org_id: 'capy-123',
          project_id: 'proj-123',
          project_name: 'test-project',
          variables: {}
        })
      );
      
      // Verify that created_at and last_sync are timestamps
      const keepArg = mockFileManager.writeKeepFile.mock.calls[0][0];
      expect(keepArg.created_at).toBeDefined();
      expect(keepArg.last_sync).toBeDefined();
      expect(new Date(keepArg.created_at).toString()).not.toBe('Invalid Date');
      expect(new Date(keepArg.last_sync).toString()).not.toBe('Invalid Date');
    });

    test('should handle authentication failure', async () => {
      mockAuthService.authenticate.mockResolvedValue({
        success: false,
        error: 'Auth failed'
      });

      await expect((capyCommand as any).initializeProject()).rejects.toThrow(CapyError);
      await expect((capyCommand as any).initializeProject()).rejects.toThrow('Auth failed');
    });

    test('should handle no existing variables gracefully', async () => {
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      mockFileManager.parseEnvContent.mockReturnValue({});

      await (capyCommand as any).initializeProject();

      expect(mockFileManager.writeEncryptedEnvFile).not.toHaveBeenCalled();
    });

    test('should handle service errors during project creation', async () => {
      mockServiceClient.getDecryptData.mockRejectedValue(new Error('Service error'));

      await (capyCommand as any).initializeProject();

      // Should continue despite service error for new projects
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
    });

    test('should auto-sync variables from an existing non-empty .env file during project initialization', async () => {
      // Mock projectManager.getEnvPath to return a path
      (mockProjectManager.getEnvPath as jest.Mock) = jest.fn().mockReturnValue('/test/path/.env');
      
      // Mock that .env file exists and has variables
      const mockFs = require('fs');
      const existsSyncSpy = jest.spyOn(mockFs, 'existsSync').mockReturnValue(true);
      
      mockFileManager.readEnvFile.mockReturnValue({
        API_KEY: 'test-key',
        DB_URL: 'postgres://localhost'
      });

      // Mock second getDecryptData call for sync
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      mockServiceClient.pushVariables.mockResolvedValue({
        success: true,
        variables: {
          API_KEY: { resource_id: 'res-1', success: true },
          DB_URL: { resource_id: 'res-2', success: true }
        }
      });

      // Mock mergeWithKeep to return an updated keep
      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '2.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        created_at: new Date().toISOString(),
        last_sync: new Date().toISOString(),
        variables: {
          API_KEY: [{ resource_id: 'res-1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
          DB_URL: [{ resource_id: 'res-2', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]
        }
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found existing .env file with 2 variable(s)'));
      expect(mockServiceClient.pushVariables).toHaveBeenCalledWith(
        'proj-123',
        { API_KEY: 'test-key', DB_URL: 'postgres://localhost' },
        expect.any(Object)
      );
      expect(mockSyncEngine.mergeWithKeep).toHaveBeenCalled();

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    test('should not attempt to sync if an existing .env file is empty', async () => {
      // Mock projectManager.getEnvPath to return a path
      (mockProjectManager.getEnvPath as jest.Mock) = jest.fn().mockReturnValue('/test/path/.env');
      
      // Mock that .env file exists but is empty
      const mockFs = require('fs');
      const existsSyncSpy = jest.spyOn(mockFs, 'existsSync').mockReturnValue(true);
      
      mockFileManager.readEnvFile.mockReturnValue({});

      await (capyCommand as any).initializeProject();

      // Should not attempt to push empty variables
      expect(mockServiceClient.pushVariables).not.toHaveBeenCalled();
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
      
      existsSyncSpy.mockRestore();
    });

    test('should complete initialization even if auto-sync fails', async () => {
      // Mock projectManager.getEnvPath to return a path
      (mockProjectManager.getEnvPath as jest.Mock) = jest.fn().mockReturnValue('/test/path/.env');
      
      // Mock that .env file exists and has variables
      const mockFs = require('fs');
      const existsSyncSpy = jest.spyOn(mockFs, 'existsSync').mockReturnValue(true);
      
      mockFileManager.readEnvFile.mockReturnValue({
        API_KEY: 'test-key'
      });

      // Mock second getDecryptData call for sync
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      // Mock sync failure
      mockServiceClient.pushVariables.mockRejectedValue(new Error('Network error'));

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      // Should complete initialization despite sync failure
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('You can run \'capy\' again to retry syncing'));
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('syncProject', () => {
    const mockProjectState = {
      initialized: true,
      hasKeepFile: true,
      hasDecryptKey: true,
      hasEnvFile: true,
      projectName: 'test-project',
      projectId: 'proj-123',
      organizationId: 'org-123'
    };

    beforeEach(() => {
      mockAuthService.authenticate.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com'
      });

      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456'
      });

      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: 'REMOTE_VAR=remote_value',
        expires_at: new Date().toISOString()
      });

      mockFileManager.parseEnvContent.mockReturnValue({ REMOTE_VAR: 'remote_value' });
      mockFileManager.readEnvFile.mockReturnValue({ LOCAL_VAR: 'local_value' });
      
      mockSyncEngine.compareEnvironments.mockReturnValue({
        newLocal: [{ name: 'LOCAL_VAR', value: 'local_value', source: 'local', encrypted: false }],
        newRemote: [{ name: 'REMOTE_VAR', value: 'remote_value', source: 'remote', encrypted: false }],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      });

      mockSyncEngine.formatSyncSummary.mockReturnValue('1 new local, 1 new remote');
      mockPromptEngine.promptForChanges.mockResolvedValue({
        pushVariables: ['LOCAL_VAR'],
        pullVariables: ['REMOTE_VAR'],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      });

      mockSyncEngine.applyDecisions.mockReturnValue({
        LOCAL_VAR: 'local_value',
        REMOTE_VAR: 'remote_value'
      });

      mockServiceClient.pushVariables.mockResolvedValue({
        success: true,
        variables: { 
          LOCAL_VAR: {
            resource_id: 'res-123',
            success: true
          }
        }
      });

      mockProjectManager.readKeepFile.mockReturnValue({
        version: '2.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        created_at: new Date().toISOString(),
        last_sync: new Date().toISOString(),
        variables: {}
      });

      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '2.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        created_at: new Date().toISOString(),
        last_sync: new Date().toISOString(),
        variables: {
          LOCAL_VAR: [{
            resource_id: 'res-123',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }]
        }
      });

      mockSyncEngine.generateSyncResult.mockReturnValue({
        success: true,
        pushed: ['LOCAL_VAR'],
        pulled: ['REMOTE_VAR'],
        conflicts: [],
        errors: [],
        totalVariables: 2
      });
    });

    test('should complete sync flow successfully', async () => {
      await (capyCommand as any).syncProject(mockProjectState);

      expect(mockAuthService.authenticate).toHaveBeenCalledWith('org-123');
      expect(mockServiceClient.getDecryptData).toHaveBeenCalledWith('proj-123', undefined);
      expect(mockSyncEngine.compareEnvironments).toHaveBeenCalled();
      expect(mockPromptEngine.promptForChanges).toHaveBeenCalled();
      expect(mockPromptEngine.confirmSync).toHaveBeenCalled();
      // Push sends the full finalEnv (from applyDecisions), not just changed vars
      expect(mockServiceClient.pushVariables).toHaveBeenCalledWith('proj-123', { LOCAL_VAR: 'local_value', REMOTE_VAR: 'remote_value' }, expect.any(Object), undefined);
      expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalled();
      expect(mockFileManager.writeDecryptKey).toHaveBeenCalled();
    });

    test('should handle no changes scenario', async () => {
      mockSyncEngine.compareEnvironments.mockReturnValue({
        newLocal: [],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      });

      await (capyCommand as any).syncProject(mockProjectState);

      expect(mockPromptEngine.displaySuccess).toHaveBeenCalledWith('Everything is up to date!');
      expect(mockPromptEngine.promptForChanges).not.toHaveBeenCalled();
    });

    test('should handle authentication failure during sync', async () => {
      mockAuthService.authenticate.mockResolvedValue({
        success: false,
        error: 'Auth failed'
      });

      await expect((capyCommand as any).syncProject(mockProjectState)).rejects.toThrow(CapyError);
    });

    test('should handle conflict resolution', async () => {
      mockSyncEngine.compareEnvironments.mockReturnValue({
        newLocal: [],
        newRemote: [],
        conflicts: [{ name: 'CONFLICT_VAR', localValue: 'local', remoteValue: 'remote' }],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      });

      mockPromptEngine.promptForChanges.mockResolvedValue({
        pushVariables: [],
        pullVariables: [],
        keepLocal: ['CONFLICT_VAR'],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      });

      await (capyCommand as any).syncProject(mockProjectState);

      expect(mockPromptEngine.promptForChanges).toHaveBeenCalled();
      expect(mockSyncEngine.validateDecisions).toHaveBeenCalled();
    });

    test('should handle validation errors', async () => {
      mockSyncEngine.validateDecisions.mockReturnValue(['Invalid decision']);

      await expect((capyCommand as any).syncProject(mockProjectState)).rejects.toThrow(CapyError);
      await expect((capyCommand as any).syncProject(mockProjectState)).rejects.toThrow('Invalid sync decisions');
    });

    test('should handle cancelled sync', async () => {
      mockPromptEngine.confirmSync.mockResolvedValue(false);

      await (capyCommand as any).syncProject(mockProjectState);

      expect(mockPromptEngine.displayWarning).toHaveBeenCalledWith('Sync cancelled');
      expect(mockServiceClient.pushVariables).not.toHaveBeenCalled();
    });

    test('should read local env file for comparison', async () => {
      await (capyCommand as any).syncProject(mockProjectState);

      // Should read encrypted .env file to preserve resource_ids for comparison
      expect(mockFileManager.readEnvFile).toHaveBeenCalledWith(undefined);
    });

    test('should handle read failure for local env', async () => {
      mockFileManager.readEnvFile.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await (capyCommand as any).syncProject(mockProjectState);

      // Should continue with empty local env if read fails
      expect(consoleSpy).toHaveBeenCalledWith('Failed to read local .env');
      
      consoleSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    test('should use displayErrorAndExit for errors in execute', async () => {
      // The execute method now uses displayErrorAndExit from errorScreen module
      // We verify that errors don't propagate unhandled
      mockProjectManager.detectProjectState.mockRejectedValue(new Error('Test error'));

      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      // execute() catches errors and calls displayErrorAndExit which calls process.exit
      await capyCommand.execute();

      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});