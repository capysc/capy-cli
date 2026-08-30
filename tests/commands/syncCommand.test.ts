/**
 * `capy sync --json` (docs/cli-setup-json.md) — the JSON-mode sync surface
 * tranche B adds for an already-initialized project (the counterpart to
 * `capy setup --json`'s plan/confirm). ISOLATED (mock.module): registered
 * in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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
  const MockSyncEngine: any = mock(() => ({}));
  MockSyncEngine.DEFAULT_BRANCH = 'development';
  MockSyncEngine.computeKeepHash = mock(() => 'a'.repeat(64));
  return { SyncEngine: MockSyncEngine };
});
mock.module('../../src/git/installGitHooks', () => ({
  installGitHooks: mock(() => undefined),
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(async () => 'mock-project-key'),
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
import { ERROR_CODES } from '../../src/types/index';

const MockProjectManager = ProjectManager as any;
const MockFileManager = FileManager as any;
const MockAuthService = AuthService as any;
const MockServiceClient = ServiceClient as any;
const MockResolveProjectKey = resolveProjectKey as any;

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

let mockProjectManager: any;
let mockFileManager: any;
let mockAuthService: any;
let mockServiceClient: any;

let logs: string[] = [];
const originalLog = console.log;

beforeEach(() => {
  process.exitCode = 0;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  mockProjectManager = {
    detectProjectState: mock(async () => ({ ...PROJECT_STATE })),
    readEnvMeta: mock(() => ({ branch: 'development' })),
    readActiveBranch: mock(() => 'development'),
    writeActiveBranch: mock(() => undefined),
    readKeepFile: mock(() => ({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} })),
    readSyncState: mock(() => null),
    getEnvPath: mock(() => '/tmp/does-not-exist/.env'),
  };
  mockFileManager = {
    readEnvMeta: mock(() => ({ branch: 'development' })),
    readEnvFile: mock(() => ({})),
    parseEnvContent: mock(() => ({})),
    decryptValue: mock((value: string) => value),
    writeKeepFile: mock(() => undefined),
    ensureCapyGitignore: mock(() => undefined),
    writeEncryptedEnvFile: mock(() => undefined),
    writeSyncState: mock(() => undefined),
  };
  mockAuthService = {
    setSessionUserId: mock(() => undefined),
    authenticateSilent: mock(async () => ({ success: true, user_id: 'user_1', organizations: [{ id: 'org_1', name: 'test-org' }] })),
    getValidToken: mock(async () => null),
  };
  mockServiceClient = {
    setTokenProvider: mock(() => undefined),
    listBranches: mock(async () => [{ id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false }]),
    getDecryptData: mock(async () => ({ env_content: '', decrypt_key: '', expires_at: new Date().toISOString() })),
    coDecrypt: mock(async () => ({ plaintext: '' })),
    wrapOuterLayer: mock(async () => ({ ciphertext: '' })),
  };

  MockProjectManager.mockImplementation(() => mockProjectManager);
  MockFileManager.mockImplementation(() => mockFileManager);
  MockAuthService.mockImplementation(() => mockAuthService);
  MockServiceClient.mockImplementation(() => mockServiceClient);
  MockResolveProjectKey.mockImplementation(async () => 'mock-project-key');
});

afterEach(() => {
  console.log = originalLog;
  process.exitCode = 0;
});

function parsedOutput(): any {
  expect(logs.length).toBe(1);
  return JSON.parse(logs[0]!);
}

describe('SyncCommand — capy sync --json', () => {
  test('no keep.lock: SYNC_NOT_INITIALIZED, exit 1, remedy points at capy setup --json', async () => {
    mockProjectManager.detectProjectState = mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false }));
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out).toEqual({ ok: false, code: ERROR_CODES.SYNC_NOT_INITIALIZED, detail: expect.any(String), remedy: 'capy setup --json' });
    expect(process.exitCode).toBe(1);
  });

  test('clean pull, no local .env: succeeds, reports pulled_variables and zero drift', async () => {
    mockServiceClient.getDecryptData = mock(async () => ({
      env_content: 'DB_URL=capy:rid:ciphertext\n',
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_file: JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} }),
    }));
    mockFileManager.parseEnvContent = mock(() => ({ DB_URL: 'capy:rid:ciphertext' }));
    mockFileManager.decryptValue = mock(() => 'postgres://real-value');
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.action).toBe('sync');
    expect(out.branch).toBe('development');
    expect(out.pulled_variables).toBe(1);
    expect(out.local_drift_resolved).toBe(0);
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledTimes(1);
    // Never a plaintext secret on stdout.
    expect(logs[0]).not.toContain('postgres://real-value');
  });

  test('local .env drift (value differs from Keep): SYNC_CONFLICT, exit EXIT_NEEDS_INPUT(3), names the drifted keys, writes nothing', async () => {
    mockProjectManager.getEnvPath = mock(() => __filename); // any real file — existsSync must be true
    mockFileManager.readEnvFile = mock(() => ({ DB_URL: 'local-plaintext-value' }));
    mockServiceClient.getDecryptData = mock(async () => ({
      env_content: '',
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_file: JSON.stringify({ version: '3.0', org_id: 'org_1', project_id: 'proj_1', project_name: 'existing-project', variables: {} }),
    }));
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.SYNC_CONFLICT);
    expect(out.names).toEqual(['DB_URL']);
    expect(process.exitCode).toBe(3);
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
  });

  test('.env header / .capy-branch disagreement: refuses with the EXISTING CONFLICT_RESOLUTION code, not a new one', async () => {
    mockFileManager.readEnvMeta = mock(() => ({ branch: 'main' }));
    mockProjectManager.readActiveBranch = mock(() => 'development');
    mockServiceClient.listBranches = mock(async () => [
      { id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false },
      { id: 'b2', name: 'main', project_id: 'proj_1', is_protected: false },
    ]);
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.CONFLICT_RESOLUTION);
  });

  test('stale .capy/branch (names a branch that no longer exists): self-heals to the .env header branch rather than refusing', async () => {
    mockFileManager.readEnvMeta = mock(() => ({ branch: 'development' }));
    mockProjectManager.readActiveBranch = mock(() => 'deleted-branch');
    mockServiceClient.listBranches = mock(async () => [{ id: 'b1', name: 'development', project_id: 'proj_1', is_protected: false }]);
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('development');
    expect(mockProjectManager.writeActiveBranch).toHaveBeenCalledWith('development');
  });

  test('no local branch signal, keep.lock pins more than one branch: SYNC_CONFLICT, exit EXIT_NEEDS_INPUT(3) — the would-prompt refusal', async () => {
    mockFileManager.readEnvMeta = mock(() => ({}));
    mockProjectManager.readActiveBranch = mock(() => null);
    mockProjectManager.readKeepFile = mock(() => ({
      version: '3.0',
      org_id: 'org_1',
      project_id: 'proj_1',
      project_name: 'existing-project',
      variables: { A: [{ resource_id: 'r1', value_hash: 'h1', branch: 'development' }, { resource_id: 'r2', value_hash: 'h2', branch: 'main' }] },
    }));
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.SYNC_CONFLICT);
    expect(process.exitCode).toBe(3);
  });

  test('no valid session: AUTH_FAILED, exit 1', async () => {
    mockAuthService.authenticateSilent = mock(async () => ({ success: false, error: 'no valid session' }));
    await new SyncCommand().execute();
    const out = parsedOutput();
    expect(out.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(process.exitCode).toBe(1);
  });
});
