/**
 * `capy sync --json` (docs/cli-setup-json.md) — the JSON-mode sync surface
 * tranche B adds for an already-initialized project (the counterpart to
 * `capy setup --json`'s plan/confirm). ISOLATED (mock.module): registered
 * in run-tests.sh.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

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
  const MockSyncEngine = {
    DEFAULT_BRANCH: 'development',
    computeKeepHash: mock(() => 'a'.repeat(64)),
  };
  return { SyncEngine: MockSyncEngine };
});
mock.module('../../src/git/installGitHooks', () => ({
  installGitHooks: mock(() => undefined),
}));
mock.module('../../src/config/globalConfig', () => ({
  writeKeepCache: mock(() => undefined),
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(async () => 'mock-project-key'),
}));
mock.module('../../src/sync/freeSyncKeyResolver', () => ({
  resolveFreeSyncProjectKey: mock(async () => 'mock-project-key'),
}));
mock.module('../../src/auth/deviceKey/grantResolver', () => ({
  createGrantResolutionOps: mock(() => ({
    fetchKeyEnc: mock(async () => ''),
    coDecrypt: mock(async (_orgId: string, ciphertext: string) => ciphertext),
  })),
}));

afterEach(() => {
  mock.restore();
});

import { SyncCommand } from '../../src/commands/syncCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { resolveProjectKey } from '../../src/crypto/keyResolver';
import { resolveFreeSyncProjectKey } from '../../src/sync/freeSyncKeyResolver';
import { writeKeepCache } from '../../src/config/globalConfig';
import { installGitHooks } from '../../src/git/installGitHooks';
import { ERROR_CODES } from '../../src/types/index';

const MockProjectManager = ProjectManager as any;
const MockFileManager = FileManager as any;
const MockAuthService = AuthService as any;
const MockServiceClient = ServiceClient as any;
const MockResolveProjectKey = resolveProjectKey as any;
const MockResolveFreeSyncProjectKey = resolveFreeSyncProjectKey as any;
const MockWriteKeepCache = writeKeepCache as any;
const MockInstallGitHooks = installGitHooks as any;

const PROJECT_STATE = {
  initialized: true,
  hasKeepFile: true,
  hasEnvFile: true,
  organizationId: 'org_1',
  projectId: 'proj_1',
  projectName: 'existing-project',
  activeBranch: 'development',
  userId: 'user_1',
};

function setupMocks(overrides: {
  readonly projectManager?: Readonly<Record<string, unknown>>;
  readonly fileManager?: Readonly<Record<string, unknown>>;
  readonly authService?: Readonly<Record<string, unknown>>;
  readonly serviceClient?: Readonly<Record<string, unknown>>;
} = {}) {
  process.exitCode = 0;
  const log = mock(() => undefined);
  spyOn(console, 'log').mockImplementation(log);

  const mockProjectManager = {
    detectProjectState: mock(async () => ({ ...PROJECT_STATE })),
    readEnvMeta: mock(() => ({ branch: 'development' })),
    readActiveBranch: mock(() => 'development'),
    writeActiveBranch: mock(() => undefined),
    readKeepFile: mock(() => ({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} })),
    readSyncState: mock(() => null),
    getEnvPath: mock(() => '/tmp/does-not-exist/.env'),
    ...overrides.projectManager,
  };
  const mockFileManager = {
    readEnvMeta: mock(() => ({ branch: 'development' })),
    readEnvFile: mock(() => ({})),
    parseEnvContent: mock(() => ({})),
    decryptValue: mock((value: string) => value),
    writeKeepFile: mock(() => undefined),
    ensureCapyGitignore: mock(() => undefined),
    writeEncryptedEnvFile: mock(() => undefined),
    writeSyncState: mock(() => undefined),
    ...overrides.fileManager,
  };
  const mockAuthService = {
    setSessionUserId: mock(() => undefined),
    authenticateSilent: mock(async () => ({ success: true, user_id: 'user_1', organizations: [{ id: 'org_1', name: 'test-org' }] })),
    getValidToken: mock(async () => null),
    ...overrides.authService,
  };
  const mockServiceClient = {
    setTokenProvider: mock(() => undefined),
    getBillingStatus: mock(async () => ({
      tier: 'free',
      grandfathered: false,
      status: null,
      seats: null,
      member_count: 1,
      project_count: 1,
    })),
    listProjects: mock(async () => [{ id: 'proj_default', name: 'default', organization_id: 'org_1' }]),
    listBranches: mock(async () => [{ id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false }]),
    getDecryptData: mock(async () => ({ env_content: '', decrypt_key: '', expires_at: new Date().toISOString() })),
    coDecrypt: mock(async () => ({ plaintext: '' })),
    wrapOuterLayer: mock(async () => ({ ciphertext: '' })),
    ...overrides.serviceClient,
  };

  MockProjectManager.mockImplementation(() => mockProjectManager);
  MockFileManager.mockImplementation(() => mockFileManager);
  MockAuthService.mockImplementation(() => mockAuthService);
  MockServiceClient.mockImplementation(() => mockServiceClient);
  MockResolveProjectKey.mockImplementation(async () => 'mock-project-key');
  MockResolveFreeSyncProjectKey.mockImplementation(async () => 'mock-project-key');
  return { log, mockProjectManager, mockFileManager, mockAuthService, mockServiceClient };
}

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function parsedOutput(log: ReturnType<typeof mock>): any {
  expect(log.mock.calls.length).toBe(1);
  return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe('SyncCommand — capy sync --json', () => {
  test('no keep.lock + paid billing: retains manifest initialization refusal', async () => {
    const { log, mockServiceClient } = setupMocks({
      projectManager: {
        detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false })),
        readSyncState: mock(() => ({
          last_sync: '',
          synced_variables: [],
          user_id: 'user_1',
          org_id: 'org_1',
        })),
      },
      serviceClient: {
        getBillingStatus: mock(async () => ({
          tier: 'business',
          grandfathered: false,
          status: 'active',
          seats: 2,
          member_count: 2,
          project_count: 1,
        })),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out).toEqual({ ok: false, code: ERROR_CODES.SYNC_NOT_INITIALIZED, detail: expect.any(String), remedy: 'capy setup --json' });
    expect(process.exitCode).toBe(1);
    expect(mockServiceClient.listProjects).not.toHaveBeenCalled();
  });

  test('no keep.lock + free billing: pulls the authoritative default-project snapshot without writing keep.lock', async () => {
    const { log, mockFileManager } = setupMocks({
      projectManager: {
        detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: true })),
        getEnvPath: mock(() => __filename),
        readSyncState: mock(() => ({
          last_sync: '2026-08-30T00:00:00.000Z',
          synced_variables: ['LOCAL_ONLY'],
          user_id: 'user_1',
          org_id: 'org_1',
          project_id: 'proj_default',
          project_name: 'default',
          sync_mode: 'free',
        })),
      },
      fileManager: {
        readEnvMeta: mock(() => ({ org_id: 'org_1', project_id: 'proj_default', branch: 'development' })),
        readEnvFile: mock(() => ({ LOCAL_ONLY: 'stale-local-value' })),
        parseEnvContent: mock(() => ({ REMOTE_ONLY: 'capy:rid:ciphertext' })),
        decryptValue: mock(() => 'authoritative-remote-value'),
      },
      serviceClient: {
        getDecryptData: mock(async () => ({
          env_content: 'REMOTE_ONLY=capy:rid:ciphertext\n',
          decrypt_key: '',
          expires_at: new Date().toISOString(),
          keep_file: JSON.stringify({
            version: '3.0',
            org_id: 'org_1',
            project_id: 'proj_default',
            project_name: 'default',
            variables: { REMOTE_ONLY: [{ resource_id: 'rid', value_hash: 'hash', branch: 'development' }] },
          }),
        })),
      },
    });

    await new SyncCommand().execute();

    const out = parsedOutput(log);
    expect(out).toMatchObject({
      ok: true,
      action: 'sync',
      sync_mode: 'free',
      sync_action: 'fetch_remote',
      branch: 'development',
      keep_lock_path: null,
      pulled_variables: 1,
    });
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(MockResolveFreeSyncProjectKey).toHaveBeenCalledWith(
      'org_1',
      'proj_default',
      'user_1',
      expect.objectContaining({ coDecrypt: expect.any(Function), wrapOuterLayer: expect.any(Function) }),
      expect.objectContaining({ fetchKeyEnc: expect.any(Function), coDecrypt: expect.any(Function) }),
    );
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledWith(
      { REMOTE_ONLY: 'authoritative-remote-value' },
      'mock-project-key',
      undefined,
      expect.objectContaining({ project_id: 'proj_default', project_name: 'default' }),
      'development',
    );
    expect(mockFileManager.writeSyncState).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org_1',
      project_id: 'proj_default',
      project_name: 'default',
      sync_mode: 'free',
      synced_variables: ['REMOTE_ONLY'],
    }));
  });

  test('no keep.lock + free billing + absent .env + empty remote marker: leaves .env absent but updates sync metadata', async () => {
    const { log, mockProjectManager, mockFileManager } = setupMocks({
      projectManager: {
        detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false })),
        readSyncState: mock(() => ({
          last_sync: '2026-08-30T00:00:00.000Z',
          synced_variables: [],
          user_id: 'user_1',
          org_id: 'org_1',
          project_id: 'proj_default',
          project_name: 'default',
          sync_mode: 'free',
        })),
      },
      fileManager: {
        readEnvMeta: mock(() => ({ org_id: 'org_1', project_id: 'proj_default', branch: 'development' })),
        parseEnvContent: mock(() => ({})),
      },
      serviceClient: {
        getDecryptData: mock(async () => ({
          env_content: '',
          decrypt_key: '',
          expires_at: new Date().toISOString(),
          keep_file: JSON.stringify({
            version: '3.0',
            org_id: 'org_1',
            project_id: 'proj_default',
            project_name: 'default',
            variables: {},
          }),
        })),
      },
    });

    await new SyncCommand().execute();

    const out = parsedOutput(log);
    expect(out).toMatchObject({
      ok: true,
      action: 'sync',
      sync_mode: 'free',
      sync_action: 'fetch_remote',
      pulled_variables: 0,
      keep_lock_path: null,
    });
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(mockFileManager.writeEncryptedEnvFile).not.toHaveBeenCalled();
    expect(mockProjectManager.writeActiveBranch).toHaveBeenCalledWith('development');
    expect(mockFileManager.ensureCapyGitignore).toHaveBeenCalledTimes(1);
    expect(mockFileManager.writeSyncState).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org_1',
      project_id: 'proj_default',
      project_name: 'default',
      sync_mode: 'free',
      synced_variables: [],
    }));
    expect(MockWriteKeepCache).toHaveBeenCalledWith('org_1', 'proj_default', 'a'.repeat(64), '');
    expect(MockInstallGitHooks).toHaveBeenCalledWith(false);
  });

  test('no keep.lock + free billing + existing .env + empty remote marker: replaces local file with authoritative empty remote', async () => {
    const { log, mockFileManager } = setupMocks({
      projectManager: {
        detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: true })),
        getEnvPath: mock(() => __filename),
        readSyncState: mock(() => ({
          last_sync: '2026-08-30T00:00:00.000Z',
          synced_variables: ['LOCAL_ONLY'],
          user_id: 'user_1',
          org_id: 'org_1',
          project_id: 'proj_default',
          project_name: 'default',
          sync_mode: 'free',
        })),
      },
      fileManager: {
        readEnvMeta: mock(() => ({ org_id: 'org_1', project_id: 'proj_default', branch: 'development' })),
        parseEnvContent: mock(() => ({})),
      },
      serviceClient: {
        getDecryptData: mock(async () => ({
          env_content: '',
          decrypt_key: '',
          expires_at: new Date().toISOString(),
          keep_file: JSON.stringify({
            version: '3.0',
            org_id: 'org_1',
            project_id: 'proj_default',
            project_name: 'default',
            variables: {},
          }),
        })),
      },
    });

    await new SyncCommand().execute();

    expect(parsedOutput(log)).toMatchObject({ ok: true, pulled_variables: 0 });
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledWith(
      {},
      'mock-project-key',
      undefined,
      expect.objectContaining({ project_id: 'proj_default', project_name: 'default' }),
      'development',
    );
    expect(mockFileManager.writeSyncState).toHaveBeenCalledWith(expect.objectContaining({
      synced_variables: [],
      sync_mode: 'free',
    }));
  });

  test('no keep.lock + free billing but no remote marker: refuses because first sync is incomplete', async () => {
    const { log, mockFileManager } = setupMocks({
      projectManager: {
        detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false })),
        readSyncState: mock(() => ({
          last_sync: '',
          synced_variables: [],
          user_id: 'user_1',
          org_id: 'org_1',
          sync_mode: 'free',
        })),
      },
    });

    await new SyncCommand().execute();

    expect(parsedOutput(log)).toEqual({
      ok: false,
      code: ERROR_CODES.SYNC_NOT_INITIALIZED,
      detail: 'the default project has not completed its first sync',
      remedy: 'capy setup --json',
    });
    expect(mockFileManager.writeEncryptedEnvFile).not.toHaveBeenCalled();
  });

  test('clean pull, no local .env: succeeds, reports pulled_variables and zero drift', async () => {
    const { log, mockFileManager } = setupMocks({
      fileManager: {
        parseEnvContent: mock(() => ({ DB_URL: 'capy:rid:ciphertext' })),
        decryptValue: mock(() => 'postgres://real-value'),
      },
      serviceClient: {
        getDecryptData: mock(async () => ({
          env_content: 'DB_URL=capy:rid:ciphertext\n',
          decrypt_key: '',
          expires_at: new Date().toISOString(),
          keep_file: JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} }),
        })),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.ok).toBe(true);
    expect(out.action).toBe('sync');
    expect(out.branch).toBe('development');
    expect(out.pulled_variables).toBe(1);
    expect(out.local_drift_resolved).toBe(0);
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledTimes(1);
    // Never a plaintext secret on stdout.
    expect(String(log.mock.calls[0]?.[0])).not.toContain('postgres://real-value');
  });

  test('local .env drift (value differs from Keep): SYNC_CONFLICT, exit EXIT_NEEDS_INPUT(3), names the drifted keys, writes nothing', async () => {
    const { log, mockFileManager } = setupMocks({
      projectManager: {
        getEnvPath: mock(() => __filename), // any real file — existsSync must be true
      },
      fileManager: {
        readEnvFile: mock(() => ({ DB_URL: 'local-plaintext-value' })),
      },
      serviceClient: {
        getDecryptData: mock(async () => ({
          env_content: '',
          decrypt_key: '',
          expires_at: new Date().toISOString(),
          keep_file: JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} }),
        })),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.SYNC_CONFLICT);
    expect(out.names).toEqual(['DB_URL']);
    expect(process.exitCode).toBe(3);
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
  });

  test('.env header / .capy-branch disagreement: refuses with the EXISTING CONFLICT_RESOLUTION code, not a new one', async () => {
    const { log } = setupMocks({
      projectManager: {
        readActiveBranch: mock(() => 'development'),
      },
      fileManager: {
        readEnvMeta: mock(() => ({ branch: 'main' })),
      },
      serviceClient: {
        listBranches: mock(async () => [
          { id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false },
          { id: 'b2', name: 'main', project_id: 'proj_1', is_protected: false },
        ]),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.CONFLICT_RESOLUTION);
  });

  test('stale .capy/branch (names a branch that no longer exists): self-heals to the .env header branch rather than refusing', async () => {
    const { log, mockProjectManager } = setupMocks({
      projectManager: {
        readActiveBranch: mock(() => 'deleted-branch'),
      },
      fileManager: {
        readEnvMeta: mock(() => ({ branch: 'development' })),
      },
      serviceClient: {
        listBranches: mock(async () => [{ id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false }]),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('development');
    expect(mockProjectManager.writeActiveBranch).toHaveBeenCalledWith('development');
  });

  test('no local branch signal, keep.lock pins more than one branch: SYNC_CONFLICT, exit EXIT_NEEDS_INPUT(3) — the would-prompt refusal', async () => {
    const { log } = setupMocks({
      projectManager: {
        readActiveBranch: mock(() => null),
        readKeepFile: mock(() => ({
          version: '3.0',
          org_id: 'org_1',
          project_id: 'proj_1',
          project_name: 'existing-project',
          variables: { A: [{ resource_id: 'r1', value_hash: 'h1', branch: 'development' }, { resource_id: 'r2', value_hash: 'h2', branch: 'main' }] },
        })),
      },
      fileManager: {
        readEnvMeta: mock(() => ({})),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.SYNC_CONFLICT);
    expect(process.exitCode).toBe(3);
  });

  test('no valid session: AUTH_FAILED, exit 1', async () => {
    const { log } = setupMocks({
      authService: {
        authenticateSilent: mock(async () => ({ success: false, error: 'no valid session' })),
      },
    });
    await new SyncCommand().execute();
    const out = parsedOutput(log);
    expect(out.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(process.exitCode).toBe(1);
  });
});
