import { describe, expect, mock, test } from 'bun:test';
import {
  planFreeLocklessPush,
  selectFreeLocklessPushMode,
  tryFreeLocklessPush,
} from '../../src/sync/freeLocklessPush';
import {
  resolveContext as resolveSharedContext,
  syncResolvedSnapshot,
  type ResolvedContext,
} from '../../src/commands/connectors/shared';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { BillingStatus } from '../../src/service/serviceClient';

const FREE: BillingStatus = {
  tier: 'free', grandfathered: false, status: null, seats: null,
  member_count: 1, project_count: 1,
};
const PAID: BillingStatus = {
  tier: 'business', grandfathered: false, status: 'active', seats: 2,
  member_count: 2, project_count: 1,
};
const REMOTE_KEEP: KeepFile = {
  version: '3.0', org_id: 'org_1', project_id: 'project_default', project_name: 'default',
  variables: {
    KEEP_ME: [{ branch: 'development', resource_id: 'rid-keep', value_hash: 'old' }],
    DELETE_A: [{ branch: 'development', resource_id: 'rid-a', value_hash: 'old' }],
    DELETE_B: [{ branch: 'development', resource_id: 'rid-b', value_hash: 'old' }],
  },
};

function dependencies(input: {
  readonly billing?: BillingStatus;
  readonly local?: Readonly<Record<string, string>>;
  readonly confirm?: boolean;
  readonly localOnly?: boolean;
  readonly remoteKeepExists?: boolean;
  readonly silentAuth?: { readonly success: boolean; readonly user_id?: string; readonly organization_id?: string; readonly error?: string };
  readonly interactiveAuth?: { readonly success: boolean; readonly user_id?: string; readonly organization_id?: string; readonly error?: string };
} = {}) {
  const local = input.local ?? { KEEP_ME: 'new-local-value' };
  const writeActiveBranch = mock(() => undefined);
  const ensureCapyGitignore = mock(() => undefined);
  const backupPlaintextEnv = mock(() => undefined);
  const ctx = {
    pm: { readSyncState: mock(() => null), writeActiveBranch },
    fileManager: {
      readEnvFile: mock(() => local), decryptValue: mock((value: string) => value),
      ensureCapyGitignore, backupPlaintextEnv,
    },
    authService: {}, serviceClient: {}, orgId: 'org_1', projectId: 'project_default',
    branch: 'development', userId: 'user_1', projectKey: 'test-project-key',
    keep: REMOTE_KEEP, localPlaintext: {}, lockless: true,
    base_keep_hash: 'a'.repeat(64), identitySource: 'header',
    remoteKeepExists: input.remoteKeepExists ?? true,
  } as unknown as ResolvedContext;
  const syncSnapshot = mock(async (
    _context: ResolvedContext,
    _snapshot: Readonly<Record<string, string>>,
    options: { readonly beforeLocalWrite?: () => void },
  ) => options.beforeLocalWrite?.());
  const resolveContext = mock(async (options: { readonly forceLockless?: boolean }) =>
    options.forceLockless ? ctx : { ...ctx, lockless: false });
  const confirmDestructivePush = mock(async () => input.confirm ?? false);
  const deps = {
    projectManager: {
      readSyncState: mock(() => ({ user_id: 'user_1', org_id: 'org_1' })),
    },
    fileManager: {
      readEnvMeta: mock(() => ({ org_id: 'org_1' })), readEnvFile: mock(() => local),
    },
    authService: {
      setSessionUserId: mock(() => undefined),
      authenticateSilent: mock(async () => input.silentAuth ?? ({ success: true, user_id: 'user_1', organization_id: 'org_1' })),
      authenticate: mock(async () => input.interactiveAuth ?? ({ success: false, error: 'interactive authentication was not expected' })),
      getValidToken: mock(async () => null),
    },
    serviceClient: { getBillingStatus: mock(async () => input.billing ?? FREE) },
    devMode: true, localOnly: input.localOnly ?? false, confirmDestructivePush,
    resolveContext: resolveContext as unknown as typeof resolveSharedContext,
    syncSnapshot: syncSnapshot as unknown as typeof syncResolvedSnapshot,
    installHooks: mock(() => undefined), report: mock(() => undefined),
  };
  return {
    deps, ctx, syncSnapshot, resolveContext, confirmDestructivePush,
    writeActiveBranch, ensureCapyGitignore, backupPlaintextEnv,
  };
}

describe('free lockless destructive-push policy', () => {
  test('warns whenever explicit replacement would remove one or more remote values', () => {
    expect(planFreeLocklessPush(['A'], ['A', 'B'])).toMatchObject({
      deletedRemoteVariableNames: ['B'], requiresDestructiveConfirmation: true,
    });
    expect(planFreeLocklessPush(['A'], ['C', 'A', 'B'])).toEqual({
      localVariableNames: ['A'], remoteVariableNames: ['A', 'B', 'C'],
      deletedRemoteVariableNames: ['B', 'C'], requiresDestructiveConfirmation: true,
    });
  });

  test('exactly one removed remote variable requires confirmation; zero removed does not', () => {
    expect(planFreeLocklessPush(['A'], ['A'])).toMatchObject({
      deletedRemoteVariableNames: [], requiresDestructiveConfirmation: false,
    });
    expect(planFreeLocklessPush(['A'], ['A', 'B'])).toMatchObject({
      deletedRemoteVariableNames: ['B'], requiresDestructiveConfirmation: true,
    });
  });

  test('declining a delete warning performs no sync and exposes names, never values', async () => {
    const { deps, syncSnapshot, confirmDestructivePush } = dependencies();
    const outcome = await tryFreeLocklessPush(deps)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.SYNC_CONFLICT, details: { names: ['DELETE_A', 'DELETE_B'] } },
    });
    expect(JSON.stringify(outcome)).not.toContain('new-local-value');
    expect(confirmDestructivePush).toHaveBeenCalledTimes(1);
    expect(syncSnapshot).not.toHaveBeenCalled();
  });

  test('approved replacement delegates the whole snapshot to the canonical sync corpus', async () => {
    const result = dependencies({ confirm: true });
    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: true });
    expect(result.syncSnapshot).toHaveBeenCalledWith(
      result.ctx,
      { KEEP_ME: 'new-local-value' },
      expect.objectContaining({ primaryVarNames: ['KEEP_ME', 'DELETE_A', 'DELETE_B'] }),
    );
    expect(result.writeActiveBranch).toHaveBeenCalledWith('development');
    expect(result.ensureCapyGitignore).toHaveBeenCalledTimes(1);
    expect(result.backupPlaintextEnv).toHaveBeenCalledWith(undefined, true);
  });

  test('a one-value removal now requires confirmation before it delegates to the sync corpus', async () => {
    const result = dependencies({
      local: { KEEP_ME: 'new-local-value', DELETE_A: 'kept-local-value' },
      confirm: true,
    });
    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: true });
    expect(result.confirmDestructivePush).toHaveBeenCalledTimes(1);
    expect(result.syncSnapshot).toHaveBeenCalledTimes(1);
  });

  test('declining a one-value removal performs no sync', async () => {
    const result = dependencies({
      local: { KEEP_ME: 'new-local-value', DELETE_A: 'kept-local-value' },
      confirm: false,
    });
    await expect(tryFreeLocklessPush(result.deps)).rejects.toMatchObject({
      code: ERROR_CODES.SYNC_CONFLICT,
      details: { names: ['DELETE_B'] },
    });
    expect(result.syncSnapshot).not.toHaveBeenCalled();
  });

  test('a missing remote marker refuses before the canonical write corpus', async () => {
    const result = dependencies({ remoteKeepExists: false });
    await expect(tryFreeLocklessPush(result.deps)).rejects.toMatchObject({ code: ERROR_CODES.SYNC_NOT_INITIALIZED });
    expect(result.syncSnapshot).not.toHaveBeenCalled();
  });

  test('paid billing returns before lockless context resolution or free writes', async () => {
    const result = dependencies({ billing: PAID });
    expect(selectFreeLocklessPushMode({ localOnly: false, billing: PAID })).toBe('paid_manifest');
    expect(await tryFreeLocklessPush(result.deps)).toMatchObject({ handled: false });
    expect(result.resolveContext).not.toHaveBeenCalled();
    expect(result.syncSnapshot).not.toHaveBeenCalled();
  });

  test('grandfathered billing is isolated with paid mode even when its UI tier is free', async () => {
    const grandfathered = { ...FREE, grandfathered: true };
    const result = dependencies({ billing: grandfathered });
    expect(selectFreeLocklessPushMode({ localOnly: false, billing: grandfathered })).toBe('paid_manifest');
    expect(await tryFreeLocklessPush(result.deps)).toMatchObject({ handled: false });
    expect(result.resolveContext).not.toHaveBeenCalled();
    expect(result.syncSnapshot).not.toHaveBeenCalled();
  });

  test('paid billing preserves the silent-to-interactive fallback and returns that one auth result to the manifest path', async () => {
    const interactiveAuth = { success: true as const, user_id: 'interactive_user', organization_id: 'org_1' };
    const result = dependencies({
      billing: PAID,
      silentAuth: { success: false, error: 'expired session' },
      interactiveAuth,
    });

    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: false, authResult: interactiveAuth });
    expect(result.deps.authService.authenticateSilent).toHaveBeenCalledTimes(2);
    expect(result.deps.authService.authenticate).toHaveBeenCalledWith('org_1');
    expect(result.resolveContext).not.toHaveBeenCalled();
  });

  test('grandfathered billing preserves the silent-to-interactive fallback and returns that one auth result to the manifest path', async () => {
    const interactiveAuth = { success: true as const, user_id: 'legacy_user', organization_id: 'org_1' };
    const result = dependencies({
      billing: { ...FREE, grandfathered: true },
      silentAuth: { success: false, error: 'expired session' },
      interactiveAuth,
    });

    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: false, authResult: interactiveAuth });
    expect(result.deps.authService.authenticateSilent).toHaveBeenCalledTimes(2);
    expect(result.deps.authService.authenticate).toHaveBeenCalledWith('org_1');
    expect(result.resolveContext).not.toHaveBeenCalled();
  });

  test('true local-only mode bypasses billing and the entire hosted path', async () => {
    const result = dependencies({ localOnly: true });
    expect(selectFreeLocklessPushMode({ localOnly: true, billing: FREE })).toBe('local_only');
    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: false });
    expect(result.deps.serviceClient.getBillingStatus).not.toHaveBeenCalled();
    expect(result.resolveContext).not.toHaveBeenCalled();
    expect(result.syncSnapshot).not.toHaveBeenCalled();
  });

  test('free billing forces lockless resolution even when a stale local keep.lock exists', async () => {
    const result = dependencies({ confirm: true });
    expect(await tryFreeLocklessPush(result.deps)).toEqual({ handled: true });
    expect(result.resolveContext).toHaveBeenCalledWith(expect.objectContaining({
      forceLockless: true,
      authResult: expect.objectContaining({ user_id: 'user_1' }),
    }));
    expect(result.deps.authService.authenticateSilent).toHaveBeenCalledTimes(1);
    expect(result.syncSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('canonical snapshot CAS boundary', () => {
  test('a concurrent change to a value this snapshot deletes refuses before retry or local writes', async () => {
    const changedRemote: KeepFile = {
      ...REMOTE_KEEP,
      variables: {
        ...REMOTE_KEEP.variables,
        DELETE_A: [{ branch: 'development', resource_id: 'rid-a-new', value_hash: 'newer' }],
      },
    };
    const pushSecrets = mock(async () => {
      throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
        keep_hash: 'b'.repeat(64), keep_file: JSON.stringify(changedRemote),
      });
    });
    const writeEncryptedEnvFile = mock(() => undefined);
    const writeSyncState = mock(() => undefined);
    const cacheRemote = mock(() => undefined);
    const confirmOverwrite = mock(async () => false);
    const ctx = {
      pm: { readSyncState: mock(() => null) },
      fileManager: { writeEncryptedEnvFile, writeSyncState },
      serviceClient: { pushSecrets, getSecrets: mock(async () => null) },
      orgId: 'org_1', projectId: 'project_default', branch: 'development',
      userId: 'user_1', projectKey: 'b'.repeat(64), keep: REMOTE_KEEP,
      localPlaintext: {}, lockless: true, base_keep_hash: 'a'.repeat(64),
      remoteKeepExists: true,
    } as unknown as ResolvedContext;

    await expect(syncResolvedSnapshot(ctx, { KEEP_ME: 'local' }, {
      primaryVarNames: ['KEEP_ME', 'DELETE_A', 'DELETE_B'], confirmOverwrite, cacheRemote,
    })).rejects.toMatchObject({ code: ERROR_CODES.STALE_KEEP_HASH });
    expect(confirmOverwrite).toHaveBeenCalledWith(['DELETE_A'], []);
    expect(pushSecrets).toHaveBeenCalledTimes(1);
    expect(cacheRemote).not.toHaveBeenCalled();
    expect(writeEncryptedEnvFile).not.toHaveBeenCalled();
    expect(writeSyncState).not.toHaveBeenCalled();
  });
});
