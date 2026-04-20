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
mock.module('../../src/sync/syncEngine', () => {
  const MockSyncEngine = mock(() => ({}));
  (MockSyncEngine as any).computeKeepHash = mock(() => 'mock-keep-hash');
  return { SyncEngine: MockSyncEngine };
});
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
  resolveProjectKey: mock(async () => 'mock-derived-project-key-hex'),
  wrapAndSaveMasterKey: mock(async () => undefined),
  hasOrgKey: mock(() => true),
}));
mock.module('../../src/config/globalConfig', () => ({
  writeKeepCache: mock(() => undefined),
  fetchSecretsWithCache: mock(async () => null),
}));
mock.module('inquirer', () => ({
  default: {
    prompt: mock((questions: any) => {
      // Return appropriate defaults based on the prompt name
      const name = Array.isArray(questions) ? questions[0]?.name : questions?.name;
      if (name === 'initChoice') return Promise.resolve({ initChoice: 'development' });
      if (name === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: 'development' });
      if (name === 'orgAction') return Promise.resolve({ orgAction: 'org-123' });
      if (name === 'confirmed') return Promise.resolve({ confirmed: true });
      if (name === 'action') return Promise.resolve({ action: 'commit_local' });
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
      backupPlaintextEnv: mock(() => false),
      isSnippetEncrypted: mock(() => false),
      isEncrypted: mock(() => false),
      decryptValue: mock((value: any) => value),
      createSnippetWithEncryption: mock((orig: string, enc: string) => `${enc}...${orig.slice(-3)}`),
    } as any;

    mockAuthService = {
      authenticate: mock(() => undefined),
      authenticateSilent: mock(() => Promise.resolve({ success: false })),
      getToken: mock(() => undefined),
      setOrganizationId: mock(() => undefined),
      setSessionUserId: mock(() => undefined),
      refreshToken: mock(() => Promise.resolve(false)),
      refreshWithCredentials: mock(() => Promise.resolve({ success: true })),
      createOrganization: mock(() => undefined)
    } as any;

    mockServiceClient = {
      setToken: mock(() => undefined),
      setTokenRefresher: mock(() => undefined),
      initializeProject: mock(() => undefined),
      getDecryptData: mock(() => undefined),
      pushVariables: mock(() => undefined),
      pushSecrets: mock(() => Promise.resolve({ keep_hash: 'a'.repeat(64) })),
      getSecrets: mock(() => Promise.resolve(null)),
      createBranch: mock(() => Promise.resolve({ id: 'b1', name: 'staging', project_id: 'p1', is_protected: false })),
      listBranches: mock(() => Promise.resolve([])),
      coDecrypt: mock(() => Promise.resolve({ plaintext: '' })),
      wrapOuterLayer: mock(() => Promise.resolve({ ciphertext: '' })),
      listProjects: mock(() => Promise.resolve([])),
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

    test('creates the chosen initial branch (unprotected development by default)', async () => {
      // Regression guard: POST /projects no longer auto-creates a branch,
      // so init MUST call createBranch exactly once with the user's chosen
      // name + protection. Default inquirer response here is 'development'
      // unprotected.
      await (capyCommand as any).initializeProject();

      const createBranchCalls = mockServiceClient.createBranch.mock.calls;
      expect(createBranchCalls.length).toBe(1);
      expect(createBranchCalls[0][0]).toBe('proj-123');        // projectId
      expect(createBranchCalls[0][1]).toBe('development');      // branch name
      expect(createBranchCalls[0][2]).toBe(false);              // isProtected
    });

    test('creates a protected production branch when user picks production in the prompt', async () => {
      const inquirer = (await import('inquirer')).default;
      const originalPrompt = inquirer.prompt;
      // @ts-expect-error overriding mock for this test
      inquirer.prompt = mock((questions: any) => {
        const name = Array.isArray(questions) ? questions[0]?.name : questions?.name;
        if (name === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: 'production' });
        if (name === 'orgAction') return Promise.resolve({ orgAction: 'org-123' });
        if (name === 'confirmed') return Promise.resolve({ confirmed: true });
        if (name === 'action') return Promise.resolve({ action: 'commit_local' });
        return Promise.resolve({});
      });

      try {
        await (capyCommand as any).initializeProject();

        const createBranchCalls = mockServiceClient.createBranch.mock.calls;
        expect(createBranchCalls.length).toBe(1);
        expect(createBranchCalls[0][1]).toBe('production');
        expect(createBranchCalls[0][2]).toBe(true);
        expect(mockProjectManager.writeActiveBranch).toHaveBeenCalledWith('production');
      } finally {
        // @ts-expect-error restore
        inquirer.prompt = originalPrompt;
      }
    });

    test('creates a custom-named branch when user picks custom in the prompt', async () => {
      const inquirer = (await import('inquirer')).default;
      const originalPrompt = inquirer.prompt;
      // @ts-expect-error overriding mock for this test
      inquirer.prompt = mock((questions: any) => {
        const qs = Array.isArray(questions) ? questions : [questions];
        const firstName = qs[0]?.name;
        if (firstName === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: 'custom' });
        if (firstName === 'name') return Promise.resolve({ name: 'main', isProtected: false });
        if (firstName === 'orgAction') return Promise.resolve({ orgAction: 'org-123' });
        if (firstName === 'confirmed') return Promise.resolve({ confirmed: true });
        if (firstName === 'action') return Promise.resolve({ action: 'commit_local' });
        return Promise.resolve({});
      });

      try {
        await (capyCommand as any).initializeProject();

        const createBranchCalls = mockServiceClient.createBranch.mock.calls;
        expect(createBranchCalls.length).toBe(1);
        expect(createBranchCalls[0][1]).toBe('main');
        expect(createBranchCalls[0][2]).toBe(false);
        expect(mockProjectManager.writeActiveBranch).toHaveBeenCalledWith('main');
      } finally {
        // @ts-expect-error restore
        inquirer.prompt = originalPrompt;
      }
    });

    test('should log correct message when keep.lock file is not found', async () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith('Welcome to Capy\n');
      
      consoleSpy.mockRestore();
    });

    test('should create keep.lock file with correct structure', async () => {
      await (capyCommand as any).initializeProject();

      expect(mockFileManager.writeKeepFile).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '3.0',
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

      mockServiceClient.pushSecrets.mockResolvedValue({
        keep_hash: 'a'.repeat(64),
      });

      // Mock mergeWithKeep to return an updated keep
      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '3.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {
          API_KEY: [{ resource_id: 'res-1', value_hash: 'testhash' }],
          DB_URL: [{ resource_id: 'res-2', value_hash: 'testhash' }],
        }
      });

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found .env with 2 secrets'));
      expect(mockServiceClient.pushSecrets).toHaveBeenCalledWith(
        'proj-123',
        expect.any(String), // keep JSON
        expect.any(String), // env_blob
        expect.any(String), // branch
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

      // Mock sync failure
      mockServiceClient.pushSecrets.mockRejectedValue(new Error('Network error'));

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).initializeProject();

      // Should complete initialization despite sync failure
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/You can run .*capy.* again to retry syncing/));
      expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalled();

      existsSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('initializeProject — multi-org selector', () => {
    test('should show org picker with all orgs when user has >1 org and none selected', async () => {
      // Setup: auth returns 2 orgs but no org selected (organization_id: '')
      // This simulates the multi-org flow where the server returns no access token
      mockAuthService.authenticate.mockResolvedValue({
        success: true,
        organization_id: '',
        user_id: 'user-456',
        user_email: 'test@example.com',
        organizations: [
          { id: 'org-A', workos_org_id: 'workos-A', name: 'Org Alpha' },
          { id: 'org-B', workos_org_id: 'workos-B', name: 'Org Beta' },
        ],
        _refresh_token: 'refresh-token',
      });
      mockAuthService.authenticateSilent.mockResolvedValue({ success: false });
      mockAuthService.getToken.mockReturnValue({
        access_token: 'token', refresh_token: 'refresh',
        expires_at: Date.now() + 3600000, organization_id: 'org-A',
        user_id: 'user-456',
      });
      mockAuthService.refreshWithCredentials.mockResolvedValue({
        success: true, organization_id: 'org-A', user_id: 'user-456',
      });
      mockServiceClient.initializeProject.mockResolvedValue({
        org_id: 'org-A', project_id: 'proj-1', project_name: 'test', created: true,
      });
      mockServiceClient.listProjects.mockResolvedValue([]);

      // Capture prompt calls to verify choices
      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        const q = Array.isArray(questions) ? questions[0] : questions;
        // Org picker: select org-A
        if (q.name === 'orgId') return { orgId: 'org-A' };
        // Project name
        if (q.name === 'projectName') return { projectName: 'test' };
        // Branch
        if (q.name === 'initChoice') return { initChoice: 'development' };
        return {};
      };

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).initializeProject();
      } catch {
        // May throw due to incomplete mock chain — we only care about the prompt
      }

      // Find the org picker prompt (the one with 'orgId' as name)
      const orgPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'orgId';
      });
      const question = Array.isArray(orgPrompt) ? orgPrompt[0] : orgPrompt;
      const orgNames = question?.choices
        ?.filter((c: any) => typeof c === 'object' && c.name)
        .map((c: any) => c.name);

      expect(orgNames).toContain('Org Alpha');
      expect(orgNames).toContain('Org Beta');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
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

      // keep.lock file should be written with v3 format
      expect(mockFileManager.writeKeepFile).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '3.0',
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
    };

    beforeEach(() => {
      // syncProject tries authenticateSilent first, then falls back to authenticate
      mockAuthService.authenticateSilent.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com',
        _auth_method: 'cached',
      });
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

      // v3: sync uses getSecrets
      mockServiceClient.getSecrets.mockResolvedValue(null);

      mockFileManager.parseEnvContent.mockReturnValue({});
      mockFileManager.readEnvFile.mockReturnValue({});

      mockProjectManager.readKeepFile.mockReturnValue({
        version: '3.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {}
      });

      mockSyncEngine.mergeWithKeep.mockReturnValue({
        version: '3.0',
        org_id: 'capy-123',
        project_id: 'proj-123',
        project_name: 'test-project',
        variables: {}
      });
    });

    test('should complete sync flow — no changes', async () => {
      // With empty keep.lock and no local env, everything is up to date
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      await (capyCommand as any).syncProject(mockProjectState);

      // syncProject tries authenticateSilent first
      expect(mockAuthService.authenticateSilent).toHaveBeenCalledWith('org-123');
      expect(consoleSpy).toHaveBeenCalledWith('Everything is up to date!');

      consoleSpy.mockRestore();
    });

    test('should handle authentication failure during sync', async () => {
      mockAuthService.authenticateSilent.mockResolvedValue({ success: false });
      mockAuthService.authenticate.mockResolvedValue({
        success: false,
        error: 'Auth failed'
      });

      await expect((capyCommand as any).syncProject(mockProjectState)).rejects.toThrow(CapyError);
    });

    test('should handle read failure for local env', async () => {
      mockFileManager.readEnvFile.mockImplementation(() => {
        throw new Error('Read failed');
      });

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      // v3: sync continues with empty local env on read failure
      await (capyCommand as any).syncProject(mockProjectState);

      // Should still complete (no changes with empty env and empty keep)
      expect(consoleSpy).toHaveBeenCalledWith('Everything is up to date!');

      consoleSpy.mockRestore();
    });
  });

  describe('syncProject — onboarding menu (empty local .env)', () => {
    const mockProjectState = {
      initialized: true,
      hasKeepFile: true,
      hasDecryptKey: true,
      hasEnvFile: true,
      projectName: 'test-project',
      projectId: 'proj-123',
      organizationId: 'org-123',
      activeBranch: 'development',
    };

    // Hash must match what hashValue() produces for the plaintext
    const { createHash } = require('crypto');
    const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

    const remoteVars: Record<string, string> = {
      API_KEY: 'sk_test_123',
      DB_URL: 'postgres://localhost/app',
    };
    const remoteHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(remoteVars)) {
      remoteHashes[k] = hash(v);
    }

    // keep.lock with pinned hashes matching remote
    const makeKeep = (hashes: Record<string, string>) => ({
      version: '3.0',
      org_id: 'org-123',
      project_id: 'proj-123',
      project_name: 'test-project',
      variables: Object.fromEntries(
        Object.entries(hashes).map(([k, h]) => [k, [{ branch: 'development', resource_id: `dev:${k}`, value_hash: h }]])
      ),
    });

    beforeEach(() => {
      mockAuthService.authenticateSilent.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com',
        _auth_method: 'cached',
      });
      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456',
      });

      // Local .env is empty
      mockFileManager.readEnvFile.mockReturnValue({});

      // Remote returns secrets
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: 'encrypted-blob',
        keep_hash: 'a'.repeat(64),
      });
      // parseEnvContent returns the "encrypted" values, decryptValue passes through
      mockFileManager.parseEnvContent.mockReturnValue(remoteVars);
      mockFileManager.decryptValue.mockImplementation((v: string) => v);
    });

    test('should only show retrieve option when pinned matches remote and .env is foreign', async () => {
      // Pinned matches remote
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(remoteHashes));
      // .env has no metadata (not initialized to this project)
      mockFileManager.readEnvMeta.mockReturnValue({});

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {
        // May throw after skip — we only care about the menu choices
      }

      // Find the action prompt
      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Should only have retrieve_pinned + skip (no commit_local, no individual)
      expect(choiceValues).toContain('retrieve_pinned');
      expect(choiceValues).not.toContain('commit_local');
      expect(choiceValues).not.toContain('individual');
      expect(choiceValues).toContain('skip');

      // Local column should be hidden (onboarding — all dashes is noise)
      const logCalls = consoleSpy.mock.calls.map((c: any) => c[0]).join('\n');
      const headerLine = logCalls.split('\n').find((l: string) => l.includes('Variable'));
      expect(headerLine).not.toContain('Local');
      // Remote column should be hidden (pinned matches remote)
      expect(headerLine).not.toContain('Remote');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });

    test('should show both retrieve options when pinned differs from remote and .env is foreign', async () => {
      // Pinned has different hashes than remote
      const staleHashes: Record<string, string> = {
        API_KEY: 'aaaa' + 'bbbb' + 'cccc' + 'dddd',
        DB_URL: 'eeee' + 'ffff' + '0000' + '1111',
      };
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(staleHashes));
      // .env belongs to a different org
      mockFileManager.readEnvMeta.mockReturnValue({ org_id: 'other-org', project_id: 'other-proj' });

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {
        // May throw after skip
      }

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Should have both retrieve options but no commit_local or individual
      expect(choiceValues).toContain('retrieve_pinned');
      expect(choiceValues).toContain('retrieve_remote');
      expect(choiceValues).not.toContain('commit_local');
      expect(choiceValues).not.toContain('individual');

      // Local column should be hidden, Remote column should be shown
      const logCalls = consoleSpy.mock.calls.map((c: any) => c[0]).join('\n');
      const headerLine = logCalls.split('\n').find((l: string) => l.includes('Variable'));
      expect(headerLine).not.toContain('Local');
      expect(headerLine).toContain('Remote');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });

    test('should show full menu when .env is empty but belongs to this project (deliberate deletions)', async () => {
      // Pinned matches remote
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(remoteHashes));
      // .env IS initialized to this project
      mockFileManager.readEnvMeta.mockReturnValue({ org_id: 'org-123', project_id: 'proj-123' });

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {
        // May throw after skip
      }

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Should have the normal menu with commit_local option (these are deliberate deletions)
      expect(choiceValues).toContain('commit_local');
      expect(choiceValues).toContain('retrieve_pinned');

      // Local column SHOULD be shown (not onboarding — deliberate deletions)
      const logCalls = consoleSpy.mock.calls.map((c: any) => c[0]).join('\n');
      const headerLine = logCalls.split('\n').find((l: string) => l.includes('Variable'));
      expect(headerLine).toContain('Local');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });
  });

  describe('syncProject — direction detection (ahead vs behind)', () => {
    const { createHash } = require('crypto');
    const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

    const oldVars: Record<string, string> = { API_KEY: 'old_key_123', DB_URL: 'postgres://old' };
    const newVars: Record<string, string> = { API_KEY: 'new_key_456', DB_URL: 'postgres://new' };
    const oldHashes: Record<string, string> = {};
    const newHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(oldVars)) oldHashes[k] = hash(v);
    for (const [k, v] of Object.entries(newVars)) newHashes[k] = hash(v);

    const makeKeep = (hashes: Record<string, string>) => ({
      version: '3.0',
      org_id: 'org-123',
      project_id: 'proj-123',
      project_name: 'test-project',
      variables: Object.fromEntries(
        Object.entries(hashes).map(([k, h]) => [k, [{ branch: 'development', resource_id: `dev:${k}`, value_hash: h }]])
      ),
    });

    const mockProjectState = {
      initialized: true,
      hasKeepFile: true,
      hasDecryptKey: true,
      hasEnvFile: true,
      projectName: 'test-project',
      projectId: 'proj-123',
      organizationId: 'org-123',
      activeBranch: 'development',
    };

    beforeEach(() => {
      mockAuthService.authenticateSilent.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        user_id: 'user-456',
        user_email: 'test@example.com',
        _auth_method: 'cached',
      });
      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456',
      });
      mockFileManager.readEnvMeta.mockReturnValue({ org_id: 'org-123', project_id: 'proj-123' });
      mockFileManager.parseEnvContent.mockReturnValue({});
      mockFileManager.decryptValue.mockImplementation((v: string) => v);
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: null,
        keep_hash: 'a'.repeat(64),
      });
    });

    test('state 2a (ahead): user edited .env, keep_hash matches → Commit local first', async () => {
      // keep.lock has old hashes (unchanged since last sync)
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(oldHashes));
      // Local .env has new values
      mockFileManager.readEnvFile.mockReturnValue(newVars);
      // Remote matches pinned (old)
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: 'encrypted',
        keep_hash: 'a'.repeat(64),
      });
      mockFileManager.parseEnvContent.mockReturnValue(oldVars);
      // sync-state keep_hash matches current keep.lock → user is ahead
      mockProjectManager.readSyncState.mockReturnValue({ keep_hash: 'mock-keep-hash' });

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {}

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Commit local should be first (user is ahead)
      expect(choiceValues[0]).toBe('commit_local');
      expect(choiceValues).toContain('retrieve_pinned');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });

    test('state 2b (behind): git pull updated keep.lock, keep_hash differs → Retrieve pinned first', async () => {
      // keep.lock has NEW hashes (updated via git pull)
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(newHashes));
      // Local .env has old values (stale)
      mockFileManager.readEnvFile.mockReturnValue(oldVars);
      // Remote matches pinned (new)
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: 'encrypted',
        keep_hash: 'a'.repeat(64),
      });
      mockFileManager.parseEnvContent.mockReturnValue(newVars);
      // sync-state keep_hash is OLD (from before git pull) → mismatch → user is behind
      mockProjectManager.readSyncState.mockReturnValue({ keep_hash: 'old-keep-hash' });
      // computeKeepHash returns something different from 'old-keep-hash'
      const { SyncEngine } = await import('../../src/sync/syncEngine');
      (SyncEngine as any).computeKeepHash = mock(() => 'new-keep-hash');

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {}

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Retrieve pinned should be first (user is behind)
      expect(choiceValues[0]).toBe('retrieve_pinned');
      expect(choiceValues).toContain('commit_local');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
      (SyncEngine as any).computeKeepHash = mock(() => 'mock-keep-hash');
    });

    test('state 3: remote ahead of pinned → Retrieve remote first', async () => {
      // keep.lock has old hashes
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(oldHashes));
      // Local matches pinned (old)
      mockFileManager.readEnvFile.mockReturnValue(oldVars);
      // Remote has new values (teammate pushed but user hasn't pulled keep.lock)
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: 'encrypted',
        keep_hash: 'a'.repeat(64),
      });
      mockFileManager.parseEnvContent.mockReturnValue(newVars);

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {}

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Retrieve remote should be first
      expect(choiceValues[0]).toBe('retrieve_remote');
      expect(choiceValues).toContain('retrieve_pinned');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });

    test('no sync-state keep_hash (first run) → falls back to current behavior', async () => {
      // keep.lock has new hashes
      mockProjectManager.readKeepFile.mockReturnValue(makeKeep(newHashes));
      // Local has old values
      mockFileManager.readEnvFile.mockReturnValue(oldVars);
      // Remote matches pinned
      mockServiceClient.getDecryptData.mockResolvedValue({
        env_content: 'encrypted',
        keep_hash: 'a'.repeat(64),
      });
      mockFileManager.parseEnvContent.mockReturnValue(newVars);
      // No keep_hash in sync-state
      mockProjectManager.readSyncState.mockReturnValue({ last_sync: '2026-01-01', synced_variables: [] });

      const promptCalls: any[] = [];
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        promptCalls.push(questions);
        return { action: 'skip' };
      };
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).syncProject(mockProjectState);
      } catch {}

      const actionPrompt = promptCalls.find((q: any) => {
        const question = Array.isArray(q) ? q[0] : q;
        return question.name === 'action';
      });
      const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
      const choiceValues = question?.choices?.map((c: any) => c.value);

      // Fallback: commit local first (current behavior)
      expect(choiceValues[0]).toBe('commit_local');
      expect(choiceValues).toContain('retrieve_pinned');

      consoleSpy.mockRestore();
      (inquirer as any).prompt = origPrompt;
    });
  });

  describe('initializeProject — pending invite (no local key)', () => {
    beforeEach(() => {
      // User authenticates to an org they were invited to but haven't redeemed
      mockAuthService.authenticate.mockResolvedValue({
        success: true,
        organization_id: 'org-123',
        organization_name: 'Test Org',
        user_id: 'user-456',
        user_email: 'test@example.com',
        organizations: [{ id: 'org-123', workos_org_id: 'workos-org-123', name: 'Test Org' }],
      });

      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-123',
        user_id: 'user-456',
      });
    });

    test('should throw with redeem instructions when user has no local key for existing org', async () => {
      // hasOrgKey returns false — user was invited but hasn't redeemed
      const { hasOrgKey } = await import('../../src/crypto/keyResolver');
      (hasOrgKey as any).mockReturnValue(false);

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await expect((capyCommand as any).initializeProject()).rejects.toThrow('no encryption key');
        await expect((capyCommand as any).initializeProject()).rejects.toThrow('capy redeem');
      } finally {
        (hasOrgKey as any).mockReturnValue(true);
        consoleSpy.mockRestore();
      }
    });

    test('should not prompt for seed phrase when user has no key for existing org', async () => {
      const { hasOrgKey } = await import('../../src/crypto/keyResolver');
      (hasOrgKey as any).mockReturnValue(false);

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).initializeProject().catch(() => {});
      } finally {
        (hasOrgKey as any).mockReturnValue(true);
        consoleSpy.mockRestore();
      }

      // Should NOT have called createOrganization or initializeProject on service
      expect(mockServiceClient.initializeProject).not.toHaveBeenCalled();
    });
  });

  describe('initializeProject — new org creation is atomic with seed phrase', () => {
    beforeEach(() => {
      // No orgs — user will be prompted to create one
      mockAuthService.authenticate.mockResolvedValue({
        success: true,
        organization_id: '',
        user_id: 'user-456',
        user_email: 'test@example.com',
        organizations: [],
        _refresh_token: 'refresh-token',
      });

      mockAuthService.getToken.mockReturnValue({
        access_token: 'token-123',
        refresh_token: 'refresh-123',
        expires_at: Date.now() + 3600000,
        organization_id: 'org-new',
        user_id: 'user-456',
      });

      mockAuthService.createOrganization.mockResolvedValue({
        id: 'org-new',
        workos_org_id: 'workos-new',
        name: 'New Org',
      });

      mockServiceClient.initializeProject.mockResolvedValue({
        org_id: 'org-new',
        project_id: 'proj-new',
        project_name: 'test',
        created: true,
      });

      mockServiceClient.listProjects.mockResolvedValue([]);
    });

    test('should re-prompt and not create org while user declines seed phrase', async () => {
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      let confirmCalls = 0;
      (inquirer as any).prompt = async (questions: any) => {
        const q = Array.isArray(questions) ? questions[0] : questions;
        if (q.name === 'orgName') return { orgName: 'New Org' };
        if (q.name === 'confirmed') {
          confirmCalls += 1;
          // Decline twice, then accept — verifies the loop re-prompts
          if (confirmCalls < 3) return { confirmed: false };
          return { confirmed: true };
        }
        if (q.name === 'initChoice') return { initChoice: 'development' };
        return {};
      };

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).initializeProject();
        // Confirmation was re-prompted until user accepted
        expect(confirmCalls).toBe(3);
        // Org was only created after the user confirmed
        expect(mockAuthService.createOrganization).toHaveBeenCalledTimes(1);
      } finally {
        (inquirer as any).prompt = origPrompt;
        consoleSpy.mockRestore();
      }
    });

    test('should create org and save key when user confirms seed phrase', async () => {
      const inquirer = (await import('inquirer')).default;
      const origPrompt = inquirer.prompt;
      (inquirer as any).prompt = async (questions: any) => {
        const q = Array.isArray(questions) ? questions[0] : questions;
        if (q.name === 'orgName') return { orgName: 'New Org' };
        if (q.name === 'confirmed') return { confirmed: true };
        if (q.name === 'initChoice') return { initChoice: 'development' };
        return {};
      };

      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

      try {
        await (capyCommand as any).initializeProject();

        expect(mockAuthService.createOrganization).toHaveBeenCalledWith(
          'New Org', 'refresh-token', 'user-456'
        );

        const { wrapAndSaveMasterKey } = await import('../../src/crypto/keyResolver');
        expect(wrapAndSaveMasterKey).toHaveBeenCalled();
      } finally {
        (inquirer as any).prompt = origPrompt;
        consoleSpy.mockRestore();
      }
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