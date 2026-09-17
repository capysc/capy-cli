/** Reviewed paid-push execution with fictional, dependency-injected custody. */
import { expect, mock, test } from 'bun:test';
import { AuthService } from '../../src/auth/authService';
import { PushCommand } from '../../src/commands/pushCommand';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { ServiceClient, type BillingStatus } from '../../src/service/serviceClient';
import { ERROR_CODES, type AuthResult, type KeepFile, type ProjectState, type SyncState } from '../../src/types/index';

const serviceOrigin = 'https://service.example.invalid';
const runtimeKey = mock(async () => 'a'.repeat(64));
const writeCache = mock(() => undefined);
const autoCommit = mock(() => ({ committed: false, reason: 'unchanged' as const }));

mock.module('../../src/config/profileConfig', () => ({
  isLocalOnly: () => false,
  resolveActiveUrl: () => serviceOrigin,
}));
mock.module('../../src/config/globalConfig', () => ({
  LOCAL_USER_ID: 'local_user',
  writeKeepCache: writeCache,
}));
mock.module('../../src/sync/projectKeyResolver', () => ({ resolveConfiguredProjectKey: runtimeKey }));
mock.module('../../src/auth/deviceKey/grantResolver', () => ({ createGrantResolutionOps: () => ({}) }));
mock.module('../../src/git/autoCommitKeep', () => ({ autoCommitKeep: autoCommit }));
mock.module('../../src/ui/debug', () => ({ debugLine: () => undefined }));
mock.module('../../src/ui/spinner', () => ({ default: () => ({ start: () => ({ stop: () => undefined, fail: () => undefined, succeed: () => undefined }) }) }));

const keep: KeepFile = {
  version: '3.0',
  org_id: 'org_fixture',
  project_id: 'project_fixture',
  project_name: 'fixture-project',
  variables: {
    EXISTING: [{ branch: 'development', resource_id: 'existing-resource', value_hash: 'existing-hash' }],
  },
};

const projectState: ProjectState = {
  initialized: true,
  hasKeepFile: true,
  hasEnvFile: true,
  organizationId: keep.org_id,
  projectId: keep.project_id,
  projectName: keep.project_name,
  activeBranch: 'development',
  userId: 'user_fixture',
};

class FixtureProjectManager extends ProjectManager {
  readonly calls = mock(async () => this.states[Math.min(this.calls.mock.calls.length - 1, this.states.length - 1)]!);

  constructor(private readonly states: readonly ProjectState[]) {
    super('/fictional/repository');
  }

  override async detectProjectState(): Promise<ProjectState> {
    return this.calls();
  }

  override readKeepFile(): KeepFile {
    return keep;
  }

  override readSyncState(): SyncState {
    return { last_sync: '2026-09-08T00:00:00.000Z', user_id: 'user_fixture', synced_variables: [], keep_hash: { development: 'base-keep-hash' } };
  }
}

class FixtureFileManager extends FileManager {
  readonly keepWrites = mock((_keep: KeepFile) => undefined);
  readonly syncWrites = mock((_sync: SyncState) => undefined);

  constructor() {
    super('/fictional/repository');
  }

  override readEnvMeta(): { readonly org_id: string } {
    return { org_id: keep.org_id };
  }

  override readEnvFile(): Record<string, string> {
    return { EXISTING: 'fictional-local-value' };
  }

  override decryptValue(value: string, _key: string): string {
    return value;
  }

  override writeKeepFile(value: KeepFile): void {
    this.keepWrites(value);
  }

  override writeSyncState(value: SyncState): void {
    this.syncWrites(value);
  }
}

class FixtureAuthService extends AuthService {
  readonly sessionUsers = mock((_userId: string) => undefined);
  readonly silent = mock(async (): Promise<AuthResult> => ({ success: true, user_id: 'user_fixture', organization_id: keep.org_id }));

  constructor() {
    super(undefined, true);
  }

  override setSessionUserId(userId: string): void {
    this.sessionUsers(userId);
  }

  override async authenticateSilent(_organizationId?: string): Promise<AuthResult> {
    return this.silent();
  }
}

class FixtureServiceClient extends ServiceClient {
  readonly pushes = mock(async (_projectId: string, keepFile: string) => ({ keep_hash: 'next-keep-hash', keep_file: keepFile }));

  constructor() {
    super(undefined, true);
  }

  override async getBillingStatus(): Promise<BillingStatus> {
    return { tier: 'business', grandfathered: false, status: 'active', seats: 1, member_count: 1, project_count: 1 };
  }

  override async pushSecrets(
    projectId: string,
    keepFile: string,
    _envBlob: string,
    _branch: string,
    _baseKeepHash?: string,
  ): Promise<{ keep_hash: string; keep_file?: string }> {
    return this.pushes(projectId, keepFile);
  }
}

function fixture(states: readonly ProjectState[] = [projectState]) {
  const projectManager = new FixtureProjectManager(states);
  const fileManager = new FixtureFileManager();
  const authService = new FixtureAuthService();
  const serviceClient = new FixtureServiceClient();
  return {
    command: new PushCommand(true, projectManager, fileManager, authService, serviceClient),
    detectProjectState: projectManager.calls,
    writeKeepFile: fileManager.keepWrites,
    writeSyncState: fileManager.syncWrites,
    pushSecrets: serviceClient.pushes,
  } as const;
}

const options = { expectedUserId: 'user_fixture', serviceOrigin } as const;

test('paid JSON planning returns a names-only plan without a write', async () => {
  const result = fixture();
  const outcome = await result.command.executeJsonReview({ ...options, plan: true });

  expect(outcome).toMatchObject({ ok: true, code: 'PUSH_PLANNED', plan: {
    mode: 'paid_merge', user_id: 'user_fixture', variable_names: ['EXISTING'], removed_remote_names: [],
  } });
  expect(JSON.stringify(outcome)).not.toContain('fictional-local-value');
  expect(result.pushSecrets).not.toHaveBeenCalled();
  expect(result.writeKeepFile).not.toHaveBeenCalled();
  expect(result.writeSyncState).not.toHaveBeenCalled();
  expect(writeCache).not.toHaveBeenCalled();
  expect(autoCommit).not.toHaveBeenCalled();
});

test('the exact paid JSON plan confirms through the ordinary writer with a structured result', async () => {
  const planned = fixture();
  const plan = await planned.command.executeJsonReview({ ...options, plan: true });
  if (plan.code !== 'PUSH_PLANNED') throw new Error('EXPECTED_PAID_PLAN');
  const confirmed = fixture();
  const outcome = await confirmed.command.executeJsonReview({ ...options, confirm: plan.plan.plan_hash });

  expect(outcome).toMatchObject({ ok: true, code: 'PUSH_DONE', pushed_count: 1, removed_count: 0 });
  expect(confirmed.pushSecrets).toHaveBeenCalledTimes(1);
  expect(confirmed.writeKeepFile).toHaveBeenCalledTimes(1);
  expect(confirmed.writeSyncState).toHaveBeenCalledTimes(1);
  expect(writeCache).toHaveBeenCalledTimes(1);
  expect(autoCommit).toHaveBeenCalledTimes(1);
});

test('a changed paid project target refuses before the reviewed submit', async () => {
  const planned = fixture();
  const plan = await planned.command.executeJsonReview({ ...options, plan: true });
  if (plan.code !== 'PUSH_PLANNED') throw new Error('EXPECTED_PAID_PLAN');
  const changed = { ...projectState, projectId: 'project_changed' } as const;
  const confirmed = fixture([projectState, changed]);

  await expect(confirmed.command.executeJsonReview({ ...options, confirm: plan.plan.plan_hash })).rejects.toMatchObject({
    code: ERROR_CODES.SYNC_CONFLICT,
  });
  expect(confirmed.pushSecrets).not.toHaveBeenCalled();
  expect(confirmed.writeKeepFile).not.toHaveBeenCalled();
  expect(confirmed.writeSyncState).not.toHaveBeenCalled();
});
