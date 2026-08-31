/**
 * `capy setup --json` (docs/cli-setup-json.md) — the plan/confirm surface
 * tranche B adds. ISOLATED (mock.module): registered in run-tests.sh.
 *
 * Every assertion here parses the captured `console.log` call as JSON first
 * — a parse failure is the test failure, per the spec's own "JSON purity"
 * law (stdout carries exactly one JSON document, nothing else).
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
  const MockSyncEngine: any = mock(() => ({
    mergeWithKeep: mock((keep: any, pushedVars: Record<string, { resource_id: string; value_hash: string }>, branch: string) => ({
      ...keep,
      variables: {
        ...keep.variables,
        ...Object.fromEntries(Object.entries(pushedVars).map(([name, v]) => [name, [{ ...v, branch }]])),
      },
    })),
  }));
  MockSyncEngine.DEFAULT_BRANCH = 'development';
  MockSyncEngine.adoptServerKeep = mock((_serverJson: unknown, fallback: unknown) => fallback);
  MockSyncEngine.computeKeepHash = mock(() => 'a'.repeat(64));
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

afterEach(() => {
  mock.restore();
});

import { SetupCommand } from '../../src/commands/setupCommand';
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

const ORG = { id: 'org_1', name: 'test-org', workos_org_id: 'workos_1' };

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
    detectProjectState: mock(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false })),
    getDefaultProjectName: mock(() => 'my-repo'),
    writeKeepFile: mock(() => undefined),
    writeActiveBranch: mock(() => undefined),
  };
  mockFileManager = {
    readEnvFile: mock(() => ({})),
    parseEnvContent: mock(() => ({})),
    writeKeepFile: mock(() => undefined),
    ensureCapyGitignore: mock(() => undefined),
    decryptValue: mock((value: string) => value),
    backupPlaintextEnv: mock(() => false),
    writeEncryptedEnvFile: mock(() => undefined),
    writeSyncState: mock(() => undefined),
  };
  mockAuthService = {
    authenticateSilent: mock(async () => ({ success: true, user_id: 'user_1', organizations: [ORG], organization_id: ORG.id })),
    getValidToken: mock(async () => null),
  };
  mockServiceClient = {
    setTokenProvider: mock(() => undefined),
    getBillingStatus: mock(async () => ({ tier: 'business', grandfathered: false, status: 'active', seats: 3, member_count: 3, project_count: 0 })),
    listProjects: mock(async () => []),
    initializeProject: mock(async () => ({ org_id: ORG.id, project_id: 'proj_new', project_name: 'my-repo', created: true })),
    createBranch: mock(async () => ({ id: 'b1', name: 'development', project_id: 'proj_new', is_protected: false })),
    getDecryptData: mock(async () => ({ env_content: '', decrypt_key: '', expires_at: new Date().toISOString() })),
    pushSecrets: mock(async () => ({ keep_hash: 'a'.repeat(64) })),
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

/** The one console.log call every command under test makes — parses it as JSON, the pure-stdout oracle. */
function parsedOutput(): any {
  expect(logs.length).toBe(1);
  return JSON.parse(logs[0]!);
}

describe('SetupCommand — plan (capy setup --json)', () => {
  test('org has zero projects: plans to create one named from the directory', async () => {
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.action).toBe('create_project');
    expect(out.project).toEqual({ id: '', name: 'my-repo', status: 'new' });
    expect(out.org).toEqual({ id: ORG.id, name: ORG.name });
    expect(out.branch).toBe('development');
    expect(typeof out.plan_hash).toBe('string');
    expect(out.plan_hash.startsWith('sha256:')).toBe(true);
    expect(out.confirm_command).toBe(`capy setup --json --confirm ${out.plan_hash}`);
    expect(out.will_write).toEqual(['keep.lock']);
    expect(out.env).toEqual({ path: '.env', variable_count: 0, variable_names: [] });
  });

  test('org has exactly one project: plans to adopt it', async () => {
    mockServiceClient.listProjects = mock(async () => [{ id: 'proj_existing', name: 'existing-project', organization_id: ORG.id }]);
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.action).toBe('adopt_project');
    expect(out.project).toEqual({ id: 'proj_existing', name: 'existing-project', status: 'existing' });
  });

  test('local .env variable names are reported (names only)', async () => {
    mockFileManager.readEnvFile = mock(() => ({ STRIPE_KEY: 'sk_test_x', DB_URL: 'postgres://x' }));
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.env.variable_count).toBe(2);
    expect(out.env.variable_names).toEqual(['DB_URL', 'STRIPE_KEY']);
    expect(out.will_write).toEqual(['keep.lock', '.env']);
    // Names only — no value anywhere in the payload.
    expect(logs[0]).not.toContain('sk_test_x');
    expect(logs[0]).not.toContain('postgres://x');
  });

  test('plan is deterministic: identical local state produces an identical hash', async () => {
    await new SetupCommand().execute({});
    const first = parsedOutput();
    logs.length = 0;
    await new SetupCommand().execute({});
    const second = parsedOutput();
    expect(second.plan_hash).toBe(first.plan_hash);
  });

  test('already initialized: SETUP_ALREADY_INITIALIZED, exit 1, never touches auth/listProjects', async () => {
    mockProjectManager.detectProjectState = mock(async () => ({ initialized: true, hasKeepFile: true, hasEnvFile: true }));
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out).toEqual({ ok: false, code: ERROR_CODES.SETUP_ALREADY_INITIALIZED, detail: expect.any(String), remedy: 'capy sync --json' });
    expect(process.exitCode).toBe(1);
    expect(mockAuthService.authenticateSilent).not.toHaveBeenCalled();
  });

  test('no valid session: AUTH_FAILED, exit 1, no TTY prompt attempted', async () => {
    mockAuthService.authenticateSilent = mock(async () => ({ success: false, error: 'no valid session' }));
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(process.exitCode).toBe(1);
  });

  test('zero organizations: NO_ORGANIZATIONS, exit 1', async () => {
    mockAuthService.authenticateSilent = mock(async () => ({ success: true, user_id: 'user_1', organizations: [] }));
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.code).toBe(ERROR_CODES.NO_ORGANIZATIONS);
    expect(process.exitCode).toBe(1);
  });

  test('multiple organizations, none active: ORG_AMBIGUOUS, exit EXIT_NEEDS_INPUT(3) — the would-prompt refusal', async () => {
    const ORG2 = { id: 'org_2', name: 'other-org', workos_org_id: 'workos_2' };
    mockAuthService.authenticateSilent = mock(async () => ({ success: true, user_id: 'user_1', organizations: [ORG, ORG2], organization_id: undefined }));
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.code).toBe(ERROR_CODES.ORG_AMBIGUOUS);
    expect(process.exitCode).toBe(3);
  });

  test('organization holds more than one project: AMBIGUOUS_PROJECT, exit EXIT_NEEDS_INPUT(3) — the would-prompt refusal', async () => {
    mockServiceClient.listProjects = mock(async () => [
      { id: 'p1', name: 'proj-one', organization_id: ORG.id },
      { id: 'p2', name: 'proj-two', organization_id: ORG.id },
    ]);
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.AMBIGUOUS_PROJECT);
    expect(process.exitCode).toBe(3);
    expect(out.projects).toEqual([
      { id: 'p1', name: 'proj-one' },
      { id: 'p2', name: 'proj-two' },
    ]);
  });

  test('listProjects network failure: coded refusal, never a stack trace on stdout', async () => {
    mockServiceClient.listProjects = mock(async () => {
      throw new Error('ECONNREFUSED');
    });
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(typeof out.code).toBe('string');
    expect(process.exitCode).toBe(1);
  });
});

describe('SetupCommand — apply (capy setup --json --confirm <hash>)', () => {
  async function planHash(): Promise<string> {
    await new SetupCommand().execute({});
    const out = parsedOutput();
    logs.length = 0;
    return out.plan_hash;
  }

  test('hash mismatch: PLAN_CHANGED, exit 1, nothing written', async () => {
    await new SetupCommand().execute({ confirm: 'sha256:' + '0'.repeat(64) });
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.PLAN_CHANGED);
    expect(process.exitCode).toBe(1);
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(mockServiceClient.initializeProject).not.toHaveBeenCalled();
  });

  test('matching hash, zero local secrets: creates the project, writes keep.lock, reports zero secrets written', async () => {
    const hash = await planHash();
    await new SetupCommand().execute({ confirm: hash });
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.action).toBe('create_project');
    expect(out.secrets_written).toBe(0);
    expect(out.keep_lock_path).toBe('keep.lock');
    expect(mockServiceClient.initializeProject).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.createBranch).toHaveBeenCalledTimes(1);
    expect(mockFileManager.writeKeepFile).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.pushSecrets).not.toHaveBeenCalled();
  });

  test('matching hash, local secrets present: encrypts + pushes, reports the count', async () => {
    mockFileManager.readEnvFile = mock(() => ({ STRIPE_KEY: 'sk_test_x' }));
    const hash = await planHash();
    await new SetupCommand().execute({ confirm: hash });
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.secrets_written).toBe(1);
    expect(mockServiceClient.pushSecrets).toHaveBeenCalledTimes(1);
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledTimes(1);
    // Never a plaintext secret on stdout.
    expect(logs[0]).not.toContain('sk_test_x');
  });

  test('cross-org ciphertext guard: a capy:-prefixed value this key cannot decrypt refuses PERMISSION_DENIED with names only, and does not push', async () => {
    mockFileManager.readEnvFile = mock(() => ({ FOREIGN: 'capy:rid:ciphertext-from-another-project' }));
    mockFileManager.decryptValue = mock(() => {
      throw new Error('bad auth tag');
    });
    const hash = await planHash();
    await new SetupCommand().execute({ confirm: hash });
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.PERMISSION_DENIED);
    expect(out.names).toEqual(['FOREIGN']);
    expect(out.env_rewritten).toBe(false);
    expect(mockServiceClient.pushSecrets).not.toHaveBeenCalled();
  });

  test('adopt existing project: pulls the current keep.json baseline instead of creating', async () => {
    mockServiceClient.listProjects = mock(async () => [{ id: 'proj_existing', name: 'existing-project', organization_id: ORG.id }]);
    mockServiceClient.getDecryptData = mock(async () => ({
      env_content: '',
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_file: JSON.stringify({ version: '3.0', org_id: ORG.id, project_id: 'proj_existing', project_name: 'existing-project', variables: {} }),
    }));
    const hash = await planHash();
    await new SetupCommand().execute({ confirm: hash });
    const out = parsedOutput();
    expect(out.ok).toBe(true);
    expect(out.action).toBe('adopt_project');
    expect(mockServiceClient.initializeProject).not.toHaveBeenCalled();
    expect(mockServiceClient.getDecryptData).toHaveBeenCalledTimes(1);
  });

  test('push fails mid-apply: coded refusal reports env_rewritten:false, pushed:false — nothing silently half-done', async () => {
    mockFileManager.readEnvFile = mock(() => ({ STRIPE_KEY: 'sk_test_x' }));
    mockServiceClient.pushSecrets = mock(async () => {
      throw new Error('service unavailable');
    });
    const hash = await planHash();
    await new SetupCommand().execute({ confirm: hash });
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.env_rewritten).toBe(false);
    expect(out.pushed).toBe(false);
    expect(mockFileManager.writeEncryptedEnvFile).not.toHaveBeenCalled();
  });
});

describe('SetupCommand — billing-authoritative free onboarding', () => {
  function useFreeDefaultProject(): void {
    mockProjectManager.detectProjectState.mockImplementation(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: false }));
    mockServiceClient.getBillingStatus.mockImplementation(async () => ({
      tier: 'free',
      grandfathered: false,
      status: null,
      seats: null,
      member_count: 1,
      project_count: 1,
    }));
    mockServiceClient.listProjects.mockImplementation(async () => [{ id: 'project_default', name: 'default', organization_id: ORG.id }]);
  }

  async function planHash(): Promise<string> {
    await new SetupCommand().execute({});
    return JSON.parse(logs.at(-1)!).plan_hash;
  }

  test('remote marker wins over local values and the plan forbids local keep.lock', async () => {
    useFreeDefaultProject();
    mockProjectManager.detectProjectState.mockImplementation(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: true }));
    mockFileManager.readEnvFile.mockImplementation(() => ({ STALE_LOCAL: 'old' }));
    mockServiceClient.getDecryptData.mockImplementation(async () => ({
      env_content: '',
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_file: JSON.stringify({ version: '3.0', org_id: ORG.id, project_id: 'project_default', project_name: 'default', variables: {} }),
    }));

    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.sync_mode).toBe('free');
    expect(out.sync_action).toBe('fetch_remote');
    expect(out.keep_lock_path).toBeNull();
    expect(out.will_write).toEqual(['.env']);
  });

  test('remote fetch applies without ever materializing the authoritative remote keep.lock locally', async () => {
    useFreeDefaultProject();
    mockProjectManager.detectProjectState.mockImplementation(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: true }));
    mockFileManager.readEnvFile.mockImplementation(() => ({ STALE_LOCAL: 'old' }));
    mockServiceClient.getDecryptData.mockImplementation(async () => ({
      env_content: 'REMOTE_ONLY=encrypted',
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_file: JSON.stringify({
        version: '3.0',
        org_id: ORG.id,
        project_id: 'project_default',
        project_name: 'default',
        variables: { REMOTE_ONLY: [] },
      }),
    }));
    mockFileManager.parseEnvContent.mockImplementation(() => ({ REMOTE_ONLY: 'encrypted' }));
    const hash = await planHash();

    await new SetupCommand().execute({ confirm: hash });
    const out = JSON.parse(logs.at(-1)!);
    expect(out.sync_mode).toBe('free');
    expect(out.sync_action).toBe('fetch_remote');
    expect(out.keep_lock_path).toBeNull();
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledTimes(1);
  });

  test('local-only root .env pushes through the canonical corpus without writing keep.lock', async () => {
    useFreeDefaultProject();
    mockProjectManager.detectProjectState.mockImplementation(async () => ({ initialized: false, hasKeepFile: false, hasEnvFile: true }));
    mockFileManager.readEnvFile.mockImplementation(() => ({ API_KEY: 'secret' }));
    const hash = await planHash();

    await new SetupCommand().execute({ confirm: hash });
    const out = JSON.parse(logs.at(-1)!);
    expect(out.ok).toBe(true);
    expect(out.sync_action).toBe('push_root_env');
    expect(out.keep_lock_path).toBeNull();
    expect(mockServiceClient.pushSecrets).toHaveBeenCalledTimes(1);
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(mockFileManager.writeEncryptedEnvFile).toHaveBeenCalledTimes(1);
  });

  test('no local or remote env creates an empty remote marker and leaves .env absent', async () => {
    useFreeDefaultProject();
    const hash = await planHash();

    await new SetupCommand().execute({ confirm: hash });
    const out = JSON.parse(logs.at(-1)!);
    expect(out.ok).toBe(true);
    expect(out.sync_action).toBe('create_empty_remote_marker');
    expect(out.keep_lock_path).toBeNull();
    expect(mockServiceClient.pushSecrets).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.pushSecrets.mock.calls[0]?.[2]).toBe('');
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
    expect(mockFileManager.writeEncryptedEnvFile).not.toHaveBeenCalled();
  });

  test('a missing default project refuses instead of silently inferring paid mode', async () => {
    useFreeDefaultProject();
    mockServiceClient.listProjects.mockImplementation(async () => []);
    await new SetupCommand().execute({});
    const out = parsedOutput();
    expect(out.ok).toBe(false);
    expect(out.code).toBe(ERROR_CODES.SERVICE_ERROR);
    expect(mockFileManager.writeKeepFile).not.toHaveBeenCalled();
  });

  test('grandfathered free billing delegates to the unchanged paid manifest executor', async () => {
    mockServiceClient.getBillingStatus.mockImplementation(async () => ({
      tier: 'free',
      grandfathered: true,
      status: null,
      seats: null,
      member_count: 1,
      project_count: 0,
    }));
    const hash = await planHash();

    await new SetupCommand().execute({ confirm: hash });
    const out = JSON.parse(logs.at(-1)!);
    expect(out.keep_lock_path).toBe('keep.lock');
    expect(mockFileManager.writeKeepFile).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.getDecryptData).not.toHaveBeenCalled();
  });
});
