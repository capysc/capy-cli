import { describe, expect, mock, test } from 'bun:test';
import {
  planFreeLocklessPush,
  selectFreeLocklessPushMode,
  tryFreeLocklessPush,
} from '../../src/sync/freeLocklessPush';
import { ERROR_CODES } from '../../src/types/index';
import type { BillingStatus } from '../../src/service/serviceClient';

const FREE: BillingStatus = {
  tier: 'free',
  grandfathered: false,
  status: null,
  seats: null,
  member_count: 1,
  project_count: 1,
};
const PAID: BillingStatus = {
  tier: 'business',
  grandfathered: false,
  status: 'active',
  seats: 2,
  member_count: 2,
  project_count: 1,
};

const remoteKeep = JSON.stringify({
  version: '3.0',
  org_id: 'org_1',
  project_id: 'project_default',
  project_name: 'default',
  variables: {
    KEEP_ME: [{ branch: 'development', resource_id: 'rid-keep', value_hash: 'old' }],
    DELETE_A: [{ branch: 'development', resource_id: 'rid-a', value_hash: 'old' }],
    DELETE_B: [{ branch: 'development', resource_id: 'rid-b', value_hash: 'old' }],
  },
});

function dependencies(input: {
  readonly billing?: BillingStatus;
  readonly local?: Readonly<Record<string, string>>;
  readonly confirm?: boolean;
  readonly initialized?: boolean;
} = {}) {
  const pushSecrets = mock(async () => ({ keep_hash: 'b'.repeat(64) }));
  const writeKeepFile = mock(() => undefined);
  const writeSyncState = mock(() => undefined);
  const confirmDestructivePush = mock(async () => input.confirm ?? false);
  const deps = {
    projectManager: {
      detectProjectState: mock(async () => ({
        initialized: input.initialized ?? false,
        hasKeepFile: input.initialized ?? false,
        hasEnvFile: true,
        activeBranch: input.initialized ? 'feature/existing' : null,
      })),
      readSyncState: mock(() => ({
        last_sync: '2026-09-01T00:00:00.000Z',
        synced_variables: ['KEEP_ME', 'DELETE_A', 'DELETE_B'],
        user_id: 'user_1',
        org_id: 'org_1',
        project_id: 'project_default',
        project_name: 'default',
        sync_mode: 'free' as const,
      })),
      writeActiveBranch: mock(() => undefined),
      writeKeepFile,
    },
    fileManager: {
      readEnvMeta: mock(() => ({ org_id: 'org_1', project_id: 'project_default', branch: 'development' })),
      readEnvFile: mock(() => input.local ?? { KEEP_ME: 'new-local-value' }),
      decryptValue: mock((value: string) => value),
      ensureCapyGitignore: mock(() => undefined),
      backupPlaintextEnv: mock(() => undefined),
      writeEncryptedEnvFile: mock(() => undefined),
      writeSyncState,
    },
    authService: {
      setSessionUserId: mock(() => undefined),
      authenticateSilent: mock(async () => ({
        success: true,
        user_id: 'user_1',
        organization_id: 'org_1',
        organizations: [{ id: 'org_1', name: 'Personal' }],
      })),
      getValidToken: mock(async () => null),
    },
    serviceClient: {
      getBillingStatus: mock(async () => input.billing ?? FREE),
      listProjects: mock(async () => [{ id: 'project_default', name: 'default', organization_id: 'org_1' }]),
      getDecryptData: mock(async () => ({ keep_file: remoteKeep, env_content: '', decrypt_key: '', expires_at: '' })),
      pushSecrets,
      coDecrypt: mock(async (_orgId: string, ciphertext: string) => ({ plaintext: ciphertext })),
      wrapOuterLayer: mock(async (_orgId: string, plaintext: string) => ({ ciphertext: plaintext })),
    },
    devMode: true,
    confirmDestructivePush,
    resolveProjectKey: mock(async () => 'test-project-key'),
    grantResolutionOps: {
      fetchKeyEnc: mock(async () => ''),
      coDecrypt: mock(async (_orgId: string, ciphertext: string) => ciphertext),
    },
    cacheRemote: mock(() => undefined),
    installHooks: mock(() => undefined),
    report: mock(() => undefined),
  };
  return { deps, pushSecrets, writeKeepFile, writeSyncState, confirmDestructivePush };
}

describe('free lockless destructive-push policy', () => {
  test('warns only when explicit replacement removes multiple remote values', () => {
    expect(planFreeLocklessPush(['A'], ['A', 'B'])).toMatchObject({
      deletedRemoteVariableNames: ['B'],
      requiresDestructiveConfirmation: false,
    });
    expect(planFreeLocklessPush(['A'], ['C', 'A', 'B'])).toEqual({
      localVariableNames: ['A'],
      remoteVariableNames: ['A', 'B', 'C'],
      deletedRemoteVariableNames: ['B', 'C'],
      requiresDestructiveConfirmation: true,
    });
  });

  test('declining a multi-delete warning performs no push and exposes names, never values', async () => {
    const { deps, pushSecrets, confirmDestructivePush } = dependencies();

    const outcome = await tryFreeLocklessPush(deps)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    expect(outcome).toMatchObject({
      ok: false,
      error: {
      code: ERROR_CODES.SYNC_CONFLICT,
      details: { names: ['DELETE_A', 'DELETE_B'] },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('new-local-value');
    expect(confirmDestructivePush).toHaveBeenCalledTimes(1);
    expect(deps.resolveProjectKey).not.toHaveBeenCalled();
    expect(pushSecrets).not.toHaveBeenCalled();
  });

  test('approved replacement deletes missing remote entries without writing keep.lock', async () => {
    const { deps, pushSecrets, writeKeepFile, writeSyncState } = dependencies({ confirm: true });

    expect(await tryFreeLocklessPush(deps)).toBe(true);
    expect(pushSecrets).toHaveBeenCalledTimes(1);
    const pushedKeep = JSON.parse(pushSecrets.mock.calls[0]![1] as string);
    expect(Object.keys(pushedKeep.variables)).toEqual(['KEEP_ME']);
    expect(pushSecrets.mock.calls[0]![4]).toMatch(/^[a-f0-9]{64}$/);
    expect(writeKeepFile).not.toHaveBeenCalled();
    expect(writeSyncState).toHaveBeenCalledWith(expect.objectContaining({
      sync_mode: 'free',
      synced_variables: ['KEEP_ME'],
    }));
  });

  test('a one-value removal pushes immediately without invoking the multi-delete gate', async () => {
    const { deps, pushSecrets, confirmDestructivePush } = dependencies({
      local: { KEEP_ME: 'new-local-value', DELETE_A: 'kept-local-value' },
    });

    expect(await tryFreeLocklessPush(deps)).toBe(true);
    expect(confirmDestructivePush).not.toHaveBeenCalled();
    expect(pushSecrets).toHaveBeenCalledTimes(1);
    const pushedKeep = JSON.parse(pushSecrets.mock.calls[0]![1] as string);
    expect(Object.keys(pushedKeep.variables)).toHaveLength(2);
    expect(Object.keys(pushedKeep.variables)).toEqual(expect.arrayContaining(['DELETE_A', 'KEEP_ME']));
  });

  test('paid billing returns to the existing manifest command before free project/key/write calls', async () => {
    const { deps, pushSecrets, confirmDestructivePush } = dependencies({ billing: PAID });

    expect(selectFreeLocklessPushMode({ initialized: false, billing: PAID })).toBe('paid_manifest_required');
    expect(await tryFreeLocklessPush(deps)).toBe(false);
    expect(deps.serviceClient.listProjects).not.toHaveBeenCalled();
    expect(deps.serviceClient.getDecryptData).not.toHaveBeenCalled();
    expect(deps.resolveProjectKey).not.toHaveBeenCalled();
    expect(confirmDestructivePush).not.toHaveBeenCalled();
    expect(pushSecrets).not.toHaveBeenCalled();
  });

  test('grandfathered billing is isolated with paid mode even when its UI tier is free', async () => {
    const grandfathered = { ...FREE, grandfathered: true };
    const { deps, pushSecrets } = dependencies({ billing: grandfathered });

    expect(selectFreeLocklessPushMode({ initialized: false, billing: grandfathered })).toBe('paid_manifest_required');
    expect(await tryFreeLocklessPush(deps)).toBe(false);
    expect(deps.serviceClient.listProjects).not.toHaveBeenCalled();
    expect(deps.serviceClient.getDecryptData).not.toHaveBeenCalled();
    expect(deps.resolveProjectKey).not.toHaveBeenCalled();
    expect(pushSecrets).not.toHaveBeenCalled();
  });

  test('an existing local manifest bypasses billing and the entire free path', async () => {
    const { deps, pushSecrets } = dependencies({ initialized: true });

    expect(selectFreeLocklessPushMode({ initialized: true, billing: FREE })).toBe('existing_manifest');
    expect(await tryFreeLocklessPush(deps)).toBe(false);
    expect(deps.serviceClient.getBillingStatus).not.toHaveBeenCalled();
    expect(pushSecrets).not.toHaveBeenCalled();
  });
});
