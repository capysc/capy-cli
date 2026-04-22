import { mock, spyOn, beforeEach, afterAll, describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Mock all dependencies — must come before imports of mocked modules
// ---------------------------------------------------------------------------
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
  const { createHash: ch } = require('crypto');
  const computeKeepHash = (keep: any, branch?: string) => {
    const targetBranch = branch || 'development';
    const entries: string[] = [];
    for (const key of Object.keys(keep.variables).sort()) {
      const varEntries = keep.variables[key];
      const entry = varEntries.find((e: any) => e.branch === targetBranch);
      if (entry) {
        entries.push(`${key}:${entry.resource_id}:${entry.value_hash}`);
      }
    }
    return ch('sha256').update(entries.join('\n')).digest('hex');
  };
  const MockSyncEngine = mock(() => ({}));
  (MockSyncEngine as any).computeKeepHash = computeKeepHash;
  (MockSyncEngine as any).DEFAULT_BRANCH = 'development';
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
    prompt: mock(() => Promise.resolve({ action: 'skip' })),
    Separator: class Separator { constructor() {} },
  },
}));
mock.module('../../src/ui/spinner', () => ({
  default: (text: string) => ({
    start: () => ({
      fail: mock(() => undefined),
      succeed: mock(() => undefined),
      stop: mock(() => undefined),
      text: '',
    }),
  }),
}));

afterAll(() => { mock.restore(); });

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { CapyCommand } from '../../src/commands/capyCommand';
import { CheckoutCommand } from '../../src/commands/checkoutCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { SyncEngine } from '../../src/sync/syncEngine';
import { PromptEngine } from '../../src/ui/promptEngine';
import type { KeepFile } from '../../src/types/index';

const MockProjectManager = ProjectManager as any;
const MockFileManager = FileManager as any;
const MockAuthService = AuthService as any;
const MockServiceClient = ServiceClient as any;
const MockSyncEngine = SyncEngine as any;
const MockPromptEngine = PromptEngine as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

function makeKeep(
  vars: Record<string, { branch: string; value: string }[]>,
): KeepFile {
  const variables: Record<string, any[]> = {};
  for (const [key, entries] of Object.entries(vars)) {
    variables[key] = entries.map(e => ({
      branch: e.branch,
      resource_id: `${e.branch}:${key.toLowerCase()}`,
      value_hash: hash(e.value),
    }));
  }
  return {
    version: '3.0',
    org_id: 'org-123',
    project_id: 'proj-123',
    project_name: 'test-project',
    variables,
  };
}

/** Standard mock instances used by checkout tests. */
function createCheckoutMocks(overrides: {
  keep?: KeepFile;
  currentBranch?: string;
  syncState?: any;
  localPlaintext?: Record<string, string>;
}) {
  const keep = overrides.keep ?? makeKeep({
    API_KEY: [{ branch: 'development', value: 'dev-key-123' }],
    DB_URL: [{ branch: 'development', value: 'postgres://dev' }],
  });
  const currentBranch = overrides.currentBranch ?? 'development';
  const keepHash = (SyncEngine as any).computeKeepHash(keep, currentBranch);

  const mockProjectManager = {
    detectProjectState: mock(() => Promise.resolve({
      initialized: true,
      hasKeepFile: true,
      projectId: 'proj-123',
      organizationId: 'org-123',
      userId: 'user-456',
    })),
    readKeepFile: mock(() => keep),
    writeActiveBranch: mock(() => undefined),
    readActiveBranch: mock(() => currentBranch),
    readSyncState: mock(() => overrides.syncState ?? { keep_hash: { [currentBranch]: keepHash } }),
    writeSyncStateUserId: mock(() => undefined),
  };

  const mockFileManager = {
    writeKeepFile: mock(() => undefined),
    writeEncryptedEnvFile: mock(() => undefined),
    parseEnvContent: mock(() => ({})),
    decryptValue: mock((v: string) => v),
    readEncryptedEnvFile: mock(() => overrides.localPlaintext ?? {
      API_KEY: 'dev-key-123',
      DB_URL: 'postgres://dev',
    }),
  };

  const mockAuthService = {
    // Silent-fallback chain: cached authenticateSilent succeeds, so the chain
    // short-circuits before reaching authenticate() — but mock both for safety.
    authenticateSilent: mock(() => Promise.resolve({
      success: true,
      organization_id: 'org-123',
      user_id: 'user-456',
    })),
    authenticate: mock(() => Promise.resolve({
      success: true,
      organization_id: 'org-123',
      user_id: 'user-456',
    })),
    getToken: mock(() => ({
      access_token: 'token-123',
      refresh_token: 'refresh-123',
      expires_at: Date.now() + 3600000,
    })),
    setSessionUserId: mock(() => undefined),
    refreshToken: mock(() => Promise.resolve(false)),
  };

  const mockServiceClient = {
    setTokenProvider: mock(() => undefined),
    listBranches: mock(() => Promise.resolve([
      { name: 'development', is_protected: false },
      { name: 'staging', is_protected: false },
    ])),
    getDecryptData: mock(() => Promise.resolve({
      env_content: 'API_KEY=enc-key\nDB_URL=enc-url',
      keep_hash: 'a'.repeat(64),
      keep_file: JSON.stringify(keep),
    })),
    coDecrypt: mock(() => Promise.resolve({ plaintext: '' })),
    wrapOuterLayer: mock(() => Promise.resolve({ ciphertext: '' })),
  };

  return { mockProjectManager, mockFileManager, mockAuthService, mockServiceClient };
}

// ---------------------------------------------------------------------------
// Issue 1: Checkout blocks on uncommitted changes
// ---------------------------------------------------------------------------
describe('Checkout — blocks on uncommitted changes', () => {
  let exitSpy: any;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  test('blocks when .env has an edited variable', async () => {
    const mocks = createCheckoutMocks({
      localPlaintext: {
        API_KEY: 'CHANGED-key',  // differs from keep.lock hash
        DB_URL: 'postgres://dev',
      },
    });
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('staging');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy.mock.calls.some((c: any) =>
      c[0]?.includes('uncommitted changes')
    )).toBe(true);

    consoleSpy.mockRestore();
  });

  test('blocks when .env has a deleted variable', async () => {
    const mocks = createCheckoutMocks({
      localPlaintext: {
        // API_KEY missing — deleted from .env
        DB_URL: 'postgres://dev',
      },
    });
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('staging');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy.mock.calls.some((c: any) =>
      c[0]?.includes('uncommitted changes')
    )).toBe(true);

    consoleSpy.mockRestore();
  });

  test('blocks when .env has an added variable', async () => {
    const mocks = createCheckoutMocks({
      localPlaintext: {
        API_KEY: 'dev-key-123',
        DB_URL: 'postgres://dev',
        NEW_VAR: 'new-value',  // not in keep.lock
      },
    });
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('staging');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy.mock.calls.some((c: any) =>
      c[0]?.includes('uncommitted changes')
    )).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Issue 2: Checkout blocks on unpushed changes
// ---------------------------------------------------------------------------
describe('Checkout — blocks on unpushed changes', () => {
  let exitSpy: any;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  test('blocks when keep.lock hash differs from sync-state', async () => {
    const mocks = createCheckoutMocks({
      syncState: {
        keep_hash: { development: 'old-stale-hash' },  // doesn't match current keep.lock
      },
    });
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('staging');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy.mock.calls.some((c: any) =>
      c[0]?.includes('unpushed changes')
    )).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Clean checkout proceeds normally
// ---------------------------------------------------------------------------
describe('Checkout — proceeds when clean', () => {
  let exitSpy: any;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  test('checkout succeeds with no uncommitted or unpushed changes', async () => {
    const mocks = createCheckoutMocks({});
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('staging');

    // Should not have printed uncommitted/unpushed error
    expect(errorSpy.mock.calls.some((c: any) =>
      c[0]?.includes?.('uncommitted changes') || c[0]?.includes?.('unpushed changes')
    )).toBe(false);

    // Should have written the .env for the new branch
    expect(mocks.mockFileManager.writeEncryptedEnvFile).toHaveBeenCalled();

    errorSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  test('checkout -b skips dirty check even with uncommitted changes', async () => {
    const mocks = createCheckoutMocks({
      localPlaintext: {
        API_KEY: 'CHANGED-key',  // uncommitted edit
        DB_URL: 'postgres://dev',
      },
    });
    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);
    mocks.mockServiceClient.listBranches = mock(() => Promise.resolve([]));

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    // create: true bypasses dirty check
    await cmd.execute('new-feature', { create: true, protected: false });

    // Should not have exited with error about uncommitted changes
    const errorCalls = exitSpy.mock.calls;
    // The create path doesn't exit(1) for dirty state
    expect(consoleSpy.mock.calls.some((c: any) =>
      c[0]?.includes?.('uncommitted changes')
    )).toBe(false);

    consoleSpy.mockRestore();
  });

  test('checkout -b seeds new branch from current .env when remote has no snapshot', async () => {
    const currentPlaintext = {
      API_KEY: 'dev-key-123',
      DB_URL: 'postgres://dev',
    };
    const mocks = createCheckoutMocks({ localPlaintext: currentPlaintext });
    // Remote returns empty env_content (the new-branch case after the server fix).
    mocks.mockServiceClient.getDecryptData = mock(() => Promise.resolve({
      env_content: '',
      keep_hash: 'a'.repeat(64),
      keep_file: undefined,
    }));
    mocks.mockServiceClient.createBranch = mock(() => Promise.resolve({
      id: 'br-new', name: 'new-feature', project_id: 'proj-123', is_protected: false,
    }));

    MockProjectManager.mockImplementation(() => mocks.mockProjectManager);
    MockFileManager.mockImplementation(() => mocks.mockFileManager);
    MockAuthService.mockImplementation(() => mocks.mockAuthService);
    MockServiceClient.mockImplementation(() => mocks.mockServiceClient);

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const cmd = new CheckoutCommand();
    await cmd.execute('new-feature', { create: true, protected: false });

    // Seed path: writeEncryptedEnvFile must be called with the CURRENT
    // plaintext values, stamped under the NEW branch name. This is the
    // regression guard — prior behavior wiped .env on the no-snapshot case.
    const writeCalls = mocks.mockFileManager.writeEncryptedEnvFile.mock.calls;
    const seedCall = writeCalls.find((args: any[]) => args[4] === 'new-feature');
    expect(seedCall).toBeDefined();
    expect(seedCall[0]).toEqual(currentPlaintext);

    // Output mentions seeding so the user knows the carry-over happened.
    expect(consoleSpy.mock.calls.some((c: any) =>
      typeof c[0] === 'string' && c[0].includes('Seeded')
    )).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Direction detection uses branch-aware keep_hash
// ---------------------------------------------------------------------------
describe('Direction detection — branch-aware keep_hash', () => {
  let capyCommand: CapyCommand;
  let mockProjectManager: any;
  let mockFileManager: any;
  let mockAuthService: any;
  let mockServiceClient: any;
  let mockSyncEngine: any;
  let mockPromptEngine: any;

  const multiBranchKeep = makeKeep({
    API_KEY: [
      { branch: 'development', value: 'dev-key-123' },
      { branch: 'staging', value: 'staging-key-456' },
    ],
    DB_URL: [
      { branch: 'development', value: 'postgres://dev' },
      { branch: 'staging', value: 'postgres://staging' },
    ],
  });

  const devKeepHash = (SyncEngine as any).computeKeepHash(multiBranchKeep, 'development');
  const stagingKeepHash = (SyncEngine as any).computeKeepHash(multiBranchKeep, 'staging');

  beforeEach(() => {
    spyOn(process, 'exit').mockImplementation(() => undefined as never);

    mockProjectManager = {
      detectProjectState: mock(() => undefined),
      getDefaultProjectName: mock(() => 'test-project'),
      getEnvPath: mock(() => '.env'),
      readKeepFile: mock(() => undefined),
      readDecryptKey: mock(() => undefined),
      readSyncState: mock(() => null),
      readActiveBranch: mock(() => null),
      writeActiveBranch: mock(() => undefined),
      writeSyncStateUserId: mock(() => undefined),
    };
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
    };
    mockAuthService = {
      authenticate: mock(() => undefined),
      authenticateSilent: mock(() => Promise.resolve({ success: false })),
      getToken: mock(() => undefined),
      setOrganizationId: mock(() => undefined),
      setSessionUserId: mock(() => undefined),
      refreshToken: mock(() => Promise.resolve(false)),
      refreshWithCredentials: mock(() => Promise.resolve({ success: true })),
      createOrganization: mock(() => undefined),
    };
    mockServiceClient = {
      setTokenProvider: mock(() => undefined),
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
    };
    mockSyncEngine = {
      createDecryptKey: mock(() => 'mock-decrypt-key'),
      compareEnvironments: mock(() => undefined),
      formatSyncSummary: mock(() => undefined),
      validateDecisions: mock(() => []),
      applyDecisions: mock(() => undefined),
      mergeWithKeep: mock(() => undefined),
      generateSyncResult: mock(() => undefined),
    };
    mockPromptEngine = {
      promptForProjectName: mock(() => undefined),
      promptForChanges: mock(() => undefined),
      confirmSync: mock(() => Promise.resolve(true)),
      displaySuccess: mock(() => undefined),
      displayError: mock(() => undefined),
      displayWarning: mock(() => undefined),
    };

    MockProjectManager.mockImplementation(() => mockProjectManager);
    MockFileManager.mockImplementation(() => mockFileManager);
    MockAuthService.mockImplementation(() => mockAuthService);
    MockServiceClient.mockImplementation(() => mockServiceClient);
    MockSyncEngine.mockImplementation(() => mockSyncEngine);
    MockPromptEngine.mockImplementation(() => mockPromptEngine);

    capyCommand = new CapyCommand();
  });

  test('keep_hash differs between branches (sanity check)', () => {
    expect(devKeepHash).not.toBe(stagingKeepHash);
    expect(devKeepHash).toHaveLength(64);
    expect(stagingKeepHash).toHaveLength(64);
  });

  test('after branch switch, direction detection uses correct branch hash', async () => {
    // Scenario: User pushed on development, then switched to staging.
    // sync-state has per-branch hashes. On staging, direction detection
    // should use staging's hash, not development's.

    const projectState = {
      initialized: true,
      hasKeepFile: true,
      hasDecryptKey: true,
      hasEnvFile: true,
      projectName: 'test-project',
      projectId: 'proj-123',
      organizationId: 'org-123',
      activeBranch: 'staging',
    };

    mockProjectManager.readKeepFile.mockReturnValue(multiBranchKeep);

    // sync-state has BOTH branch hashes (branch-aware format)
    mockProjectManager.readSyncState.mockReturnValue({
      keep_hash: {
        development: devKeepHash,
        staging: stagingKeepHash,  // matches current keep.lock for staging
      },
      last_sync: new Date().toISOString(),
      synced_variables: ['API_KEY', 'DB_URL'],
    });

    // Local .env has a staging edit (user changed something)
    const stagingVars = { API_KEY: 'staging-key-new', DB_URL: 'postgres://staging' };
    mockFileManager.readEnvFile.mockReturnValue(stagingVars);
    mockFileManager.readEnvMeta.mockReturnValue({ org_id: 'org-123', project_id: 'proj-123' });

    // Remote matches pinned
    mockServiceClient.getDecryptData.mockResolvedValue({
      env_content: 'encrypted',
      keep_hash: 'a'.repeat(64),
    });
    mockFileManager.parseEnvContent.mockReturnValue({
      API_KEY: 'staging-key-456',
      DB_URL: 'postgres://staging',
    });
    mockFileManager.decryptValue.mockImplementation((v: string) => v);

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

    const promptCalls: any[] = [];
    const inquirer = (await import('inquirer')).default;
    const origPrompt = inquirer.prompt;
    (inquirer as any).prompt = async (questions: any) => {
      promptCalls.push(questions);
      return { action: 'skip' };
    };
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await (capyCommand as any).syncProject(projectState);
    } catch {}

    const actionPrompt = promptCalls.find((q: any) => {
      const question = Array.isArray(q) ? q[0] : q;
      return question.name === 'action';
    });
    const question = Array.isArray(actionPrompt) ? actionPrompt[0] : actionPrompt;
    const choiceValues = question?.choices?.map((c: any) => c.value);

    // With branch-aware keep_hash, staging's hash matches → user is NOT behind
    // → commit_local should be first (user is ahead with local edits)
    expect(choiceValues?.[0]).toBe('commit_local');

    consoleSpy.mockRestore();
    (inquirer as any).prompt = origPrompt;
  });
});
