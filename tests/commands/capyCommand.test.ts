import { mock, spyOn, beforeEach, afterEach, afterAll, describe, test, expect } from 'bun:test';

// Mock all dependencies — must come before imports of mocked modules
mock.module('../../src/core/projectManager', () => ({
  ProjectManager: mock(() => ({})),
}));
mock.module('../../src/files/fileManager', () => ({
  FileManager: mock(() => ({})),
}));
mock.module('../../src/auth/authService', () => ({
  AuthService: mock(() => ({})),
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: mock(() => ({})),
}));
mock.module('../../src/sync/syncEngine', () => ({
  SyncEngine: mock(() => ({})),
}));
mock.module('../../src/ui/promptEngine', () => ({
  PromptEngine: mock(() => ({})),
}));
mock.module('../../src/crypto/keyManager', () => ({
  generateSeedPhrase: mock(() => 'abandon '.repeat(23) + 'art'),
  validateSeedPhrase: mock(() => true),
  seedPhraseToMasterKey: mock(() => Buffer.alloc(32, 1)),
  encryptMasterKey: mock(() => 'encrypted-master-key'),
  deriveWrappingKey: mock(() => Buffer.alloc(32, 2)),
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(() => 'mock-derived-project-key-hex'),
  hasOrgKey: mock(() => true),
}));
mock.module('../../src/config/globalConfig', () => ({
  saveMasterKey: mock(() => undefined),
}));
mock.module('inquirer', () => ({
  default: {
    prompt: mock((questions: any) => {
      // Return appropriate defaults based on the prompt name
      const name = Array.isArray(questions) ? questions[0]?.name : questions?.name;
      if (name === 'selectedEnv') return Promise.resolve({ selectedEnv: 'local' });
      if (name === 'orgAction') return Promise.resolve({ orgAction: 'org-123' });
      if (name === 'confirmed') return Promise.resolve({ confirmed: true });
      return Promise.resolve({ orgId: 'org-123', orgName: 'Test Org' });
    }),
    Separator: class Separator { constructor() {} },
  },
}));
mock.module('../../src/ui/spinner', () => ({
  default: (text: string) => ({
    start: () => ({
      fail: mock(() => undefined),
      succeed: mock(() => undefined),
      stop: mock(() => undefined),
      text: ''
    })
  })
}));

afterAll(() => { mock.restore(); });

import { CapyCommand } from '../../src/commands/capyCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { SyncEngine } from '../../src/sync/syncEngine';
import { PromptEngine } from '../../src/ui/promptEngine';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import * as fs from 'fs';

const MockProjectManager = ProjectManager as any;
const MockFileManager = FileManager as any;
const MockAuthService = AuthService as any;
const MockServiceClient = ServiceClient as any;
const MockSyncEngine = SyncEngine as any;
const MockPromptEngine = PromptEngine as any;

describe('CapyCommand', () => {
  let capyCommand: CapyCommand;
  let mockProjectManager: any;
  let mockFileManager: any;
  let mockAuthService: any;
  let mockServiceClient: any;
  let mockSyncEngine: any;
  let mockPromptEngine: any;

  beforeEach(() => {
    // Mock process.exit globally to prevent child process crashes
    spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Create mock instances
    mockProjectManager = {
      detectProjectState: mock(() => undefined),
      getDefaultProjectName: mock(() => 'test-project'),
      getEnvPath: mock(() => '.env'),
      readKeepFile: mock(() => undefined),
      readDecryptKey: mock(() => undefined),
      readSyncState: mock(() => null),
      readActiveBranch: mock(() => null),
      readActiveEnvironment: mock(() => undefined),
      writeActiveEnvironment: mock(() => undefined),
      writeActiveBranch: mock(() => undefined),
      writeSyncStateUserId: mock(() => undefined)
    } as any;

    mockFileManager = {
      writeKeepFile: mock(() => undefined),
      writeDecryptKey: mock(() => undefined),
      writeSyncState: mock(() => undefined),
      writeEncryptedEnvFile: mock(() => undefined),
      readEnvFile: mock(() => ({})),
      readEncryptedEnvFile: mock(() => ({})),
      readEnvMeta: mock(() => ({})),
      parseEnvContent: mock(() => ({})),
      ensureCapyGitignore: mock(() => undefined),
      getEnvPathForEnvironment: mock((env: string) => env === 'local' ? '.env' : `.env.${env}`),
      isSnippetEncrypted: mock(() => false),
      isEncrypted: mock(() => false),
      decryptValue: mock((value: any) => value),
      createSnippetWithEncryption: mock((orig: string, enc: string) => `${enc}...${orig.slice(-3)}`),
    } as any;

    mockAuthService = {
      authenticate: mock(() => undefined),
      getToken: mock(() => undefined),
      setOrganizationId: mock(() => undefined),
      setSessionUserId: mock(() => undefined),
      createOrganization: mock(() => undefined)
    } as any;

    mockServiceClient = {
      setToken: mock(() => undefined),
      setTokenRefresher: mock(() => undefined),
      initializeProject: mock(() => undefined),
      getDecryptData: mock(() => undefined),
      pushVariables: mock(() => undefined),
      pushEnvironments: mock(() => Promise.resolve({ keep_hash: 'a'.repeat(64), environments: ['local'] })),
      getEnvironmentBlob: mock(() => Promise.resolve(null)),
    } as any;

    mockSyncEngine = {
      createDecryptKey: mock(() => 'mock-decrypt-key'),
      compareEnvironments: mock(() => undefined),
      formatSyncSummary: mock(() => undefined),
      validateDecisions: mock(() => []),
      applyDecisions: mock(() => undefined),
      mergeWithKeep: mock(() => undefined),
      generateSyncResult: mock(() => undefined)
    } as any;

    mockPromptEngine = {
      promptForProjectName: mock(() => undefined),
      promptForChanges: mock(() => undefined),
      confirmSync: mock(() => Promise.resolve(true) as any),
      displaySuccess: mock(() => undefined),
      displayError: mock(() => undefined),
      displayWarning: mock(() => undefined)
    } as any;

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
      MockProjectManager.mockClear();
      MockFileManager.mockClear();
      MockAuthService.mockClear();
      MockServiceClient.mockClear();
      MockSyncEngine.mockClear();
      MockPromptEngine.mockClear();
      
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

      const spy = spyOn(capyCommand as any, 'initializeProject').mockResolvedValue(undefined);

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
      const spy = spyOn(capyCommand as any, 'syncProject').mockResolvedValue(undefined);

      await capyCommand.execute();

      expect(mockProjectManager.detectProjectState).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(projectState);
    });

    test('should not initialize project if keep.lock file already exists', async () => {
      mockProjectManager.detectProjectState.mockResolvedValue({
        initialized: true,
        hasKeepFile: true,
        hasDecryptKey: false,
        hasEnvFile: false,
        projectName: 'existing-project',
        projectId: 'proj-123',
        organizationId: 'org-123'
      });

      const initSpy = spyOn(capyCommand as any, 'initializeProject').mockResolvedValue(undefined);
      const syncSpy = spyOn(capyCommand as any, 'syncProject').mockResolvedValue(undefined);

      await capyCommand.execute();

      expect(mockProjectManager.detectProjectState).toHaveBeenCalled();
      expect(initSpy).not.toHaveBeenCalled();
      expect(syncSpy).toHaveBeenCalled();
    });

    test('should handle errors properly', async () => {
      mockProjectManager.detectProjectState.mockRejectedValue(new Error('Test error'));

      // Mock process.exit to prevent actual exit during tests
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

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

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

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
      // v4: init no longer calls getDecryptData — new projects have nothing to fetch
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
    });

    test('should log correct message when keep.lock file is not found', async () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith('No keep.lock file found - initializing project...');
      
      consoleSpy.mockRestore();
    });

    test('should create keep.lock file with correct structure', async () => {
      await (capyCommand as any).initializeProject();

      expect(mockFileManager.writeKeepFile).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '4.0',
          org_id: 'capy-123',
          project_id: 'proj-123',
          project_name: 'test-project',
          variables: {}
        })
      );
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
      (mockProjectManager.getEnvPath as any) = mock(() => '/test/path/.env');
      
      // Mock that .env file exists and has variables
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true as any);
      
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

      mockServiceClient.pushEnvironments.mockResolvedValue({
        keep_hash: 'a'.repeat(64),
        environments: ['local'],
      });

      // Mock mergeWithKeep to return an updated keep
      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '4.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {
          API_KEY: { resource_id: 'res-1', local: 'testhash' },
          DB_URL: { resource_id: 'res-2', local: 'testhash' },
        }
      });

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found existing .env file with 2 variable(s)'));
      // v4: init uses pushEnvironments instead of pushVariables
      expect(mockServiceClient.pushEnvironments).toHaveBeenCalledWith(
        'proj-123',
        expect.any(String), // keep JSON
        expect.objectContaining({ local: expect.any(String) }), // environments blob
      );
      expect(mockSyncEngine.mergeWithKeep).toHaveBeenCalled();

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    test('should not attempt to sync if an existing .env file is empty', async () => {
      // Mock projectManager.getEnvPath to return a path
      (mockProjectManager.getEnvPath as any) = mock(() => '/test/path/.env');
      
      // Mock that .env file exists but is empty
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true as any);
      
      mockFileManager.readEnvFile.mockReturnValue({});

      await (capyCommand as any).initializeProject();

      // Should not attempt to push empty variables
      expect(mockServiceClient.pushVariables).not.toHaveBeenCalled();
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
      
      existsSyncSpy.mockRestore();
    });

    test('should complete initialization even if auto-sync fails', async () => {
      // Mock projectManager.getEnvPath to return a path
      (mockProjectManager.getEnvPath as any) = mock(() => '/test/path/.env');
      
      // Mock that .env file exists and has variables
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true as any);
      
      mockFileManager.readEnvFile.mockReturnValue({
        API_KEY: 'test-key'
      });

      // Mock second getDecryptData call for sync
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: 'decrypt-key-123',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      // Mock sync failure — v4 uses pushEnvironments
      mockServiceClient.pushEnvironments.mockRejectedValue(new Error('Network error'));

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      // Should complete initialization despite sync failure
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('You can run \'capy\' again to retry syncing'));
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('initializeProject — fresh account (no keep.lock, no .env)', () => {
    /**
     * Regression test: a brand-new user with no keep.lock file and no local .env
     * should be able to authenticate, create a project, and complete init
     * without the "No secrets stored" 404 from getDecryptData being treated
     * as an auth failure.
     */
    beforeEach(() => {
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
        org_id: 'org-123',
        project_id: 'proj-new',
        project_name: 'fresh-project',
        created: true
      });

      mockPromptEngine.promptForProjectName.mockResolvedValue('fresh-project');
    });

    test('should complete init when getDecryptData returns empty (no prior secrets)', async () => {
      // getDecryptData returns empty for a brand-new project (no secrets stored)
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: '',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      // No local .env file exists
      spyOn(fs, 'existsSync').mockReturnValue(false as any);

      await (capyCommand as any).initializeProject();

      // Auth should succeed
      expect(mockAuthService.authenticate).toHaveBeenCalled();
      expect(mockServiceClient.setToken).toHaveBeenCalled();

      // Project should be created
      expect(mockServiceClient.initializeProject).toHaveBeenCalledWith('fresh-project', 'org-123');

      // keep.lock file should be written with v4 format
      expect(mockFileManager.writeKeepFile).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '4.0',
          org_id: 'org-123',
          project_id: 'proj-new',
          project_name: 'fresh-project',
        })
      );

      // Should still set up gitignore
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
    });

    test('should complete init when getDecryptData throws 404', async () => {
      // getDecryptData throws a 404 (server returns "No secrets stored")
      mockServiceClient.getDecryptData.mockRejectedValue(
        new CapyError('No secrets stored for this project', 'SERVICE_ERROR', { status: 404 })
      );

      spyOn(fs, 'existsSync').mockReturnValue(false as any);

      await (capyCommand as any).initializeProject();

      // Should still complete — 404 during init is expected for new projects
      expect(mockAuthService.authenticate).toHaveBeenCalled();
      expect(mockServiceClient.initializeProject).toHaveBeenCalled();
      expect(mockFileManager.writeKeepFile).toHaveBeenCalled();
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();
    });

    test('should not confuse getDecryptData 404 with auth failure', async () => {
      // The key scenario: getDecryptData returns empty, auth is fine
      mockServiceClient.getDecryptData.mockResolvedValue({
        decrypt_key: '',
        env_content: '',
        expires_at: new Date().toISOString()
      });

      spyOn(fs, 'existsSync').mockReturnValue(false as any);

      // Should NOT throw an auth error
      await (capyCommand as any).initializeProject(); // will throw if it rejects

      // Auth service should be called exactly once (no retry loops)
      expect(mockAuthService.authenticate).toHaveBeenCalledTimes(1);
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
      organizationId: 'org-123',
      activeEnvironment: 'local' as const,
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

      // v4: sync uses getEnvironmentBlob, not getDecryptData
      mockServiceClient.getEnvironmentBlob.mockResolvedValue({
        env_file: 'REMOTE_VAR=remote_value',
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

      mockProjectManager.readKeepFile.mockReturnValue({
        version: '4.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {}
      });

      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '4.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {
          LOCAL_VAR: { resource_id: 'res-123', local: 'testhash' },
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
      // v4: uses getEnvironmentBlob, not getDecryptData
      expect(mockSyncEngine.compareEnvironments).toHaveBeenCalled();
      expect(mockPromptEngine.promptForChanges).toHaveBeenCalled();
      expect(mockPromptEngine.confirmSync).toHaveBeenCalled();
      // v4: sync is pull-only — no pushVariables call
      expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalled();
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
    });

    test('should read local env file for comparison', async () => {
      await (capyCommand as any).syncProject(mockProjectState);

      // v4: reads from environment-specific path (.env for local)
      expect(mockFileManager.readEnvFile).toHaveBeenCalledWith('.env');
    });

    test('should handle read failure for local env', async () => {
      mockFileManager.readEnvFile.mockImplementation(() => {
        throw new Error('Read failed');
      });

      // v4: sync continues with empty local env on read failure (no warning logged)
      await (capyCommand as any).syncProject(mockProjectState);

      // Should still complete sync flow (using empty local env)
      expect(mockSyncEngine.compareEnvironments).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    test('should use displayErrorAndExit for errors in execute', async () => {
      // The execute method now uses displayErrorAndExit from errorScreen module
      // We verify that errors don't propagate unhandled
      mockProjectManager.detectProjectState.mockRejectedValue(new Error('Test error'));

      const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      // execute() catches errors and calls displayErrorAndExit which calls process.exit
      await capyCommand.execute();

      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});