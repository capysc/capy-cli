import { describe, expect, test } from 'bun:test';
import { buildHostedCompletionPlan, CapyCommand } from '../../src/commands/capyCommand';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { KeepFile, SyncState } from '../../src/types';

const target = {
  orgId: 'org-one',
  orgName: 'First org',
  projectId: 'project-one',
  projectName: 'Shared name',
  branch: 'development',
} as const;

const keep: KeepFile = {
  version: '3.0',
  org_id: target.orgId,
  project_id: target.projectId,
  project_name: target.projectName,
  variables: {
    SENTINEL: [{
      branch: target.branch,
      resource_id: 'development:SENTINEL',
      value_hash: '0123456789abcdef',
    }],
  },
};

const readiness = {
  signup_complete: true,
  retryable: false,
  custody: {
    key_state: 'minted',
    ceremony_pending: false,
    has_live_wrapped_k_local: true,
  },
} as const;

type VerifyHostedInitialization = (
  context: Readonly<{
    transport: 'hosted';
    operationDeadline: number | null;
    authService: object;
    serviceClient: object;
  }>,
  target: Readonly<{ orgId: string; orgName: string; projectId: string; projectName: string; branch: string; syncMode?: 'free' }>,
) => Promise<Readonly<{ repositoryVerified: boolean; custodyVerified: boolean }>>;

const verifyHostedInitialization = (
  CapyCommand.prototype as unknown as Readonly<{
    verifyHostedInitialization: VerifyHostedInitialization;
  }>
).verifyHostedInitialization;

function subject(
  localKeep: KeepFile | null,
  branch: string | null,
  localValues: Readonly<Record<string, string>> = localKeep
    ? Object.fromEntries(Object.entries(localKeep.variables).flatMap(([name, entries]) => entries
        .filter((entry) => entry.branch === branch)
        .map((entry) => [name, `capy:${entry.resource_id}:sealed`])))
    : {},
): object {
  return {
    projectManager: {
      readKeepFile: () => localKeep,
      deriveActiveBranch: () => branch,
    },
    fileManager: {
      readEnvFile: () => localValues,
      readEnvMeta: () => localKeep && Object.keys(localValues).length > 0 ? ({
        org_id: localKeep.org_id,
        project_id: localKeep.project_id,
        branch: branch ?? undefined,
      }) : ({}),
    },
    options: {},
  };
}

function context(input: Readonly<{
  remoteKeep?: KeepFile | null;
  remoteHash?: string;
  remoteKeepText?: string;
  readiness?: typeof readiness;
  branchId?: string;
  branchProjectId?: string | null;
  projectName?: string;
  free?: boolean;
}> = {}): Readonly<{
  transport: 'hosted';
  operationDeadline: number | null;
  authService: object;
  serviceClient: object;
}> {
  const remoteKeep = input.remoteKeep === undefined ? keep : input.remoteKeep;
  const computedHash = remoteKeep ? SyncEngine.computeKeepHash(remoteKeep, target.branch) : undefined;
  return {
    transport: 'hosted',
    operationDeadline: null,
    authService: {
      assertRefreshAuthorityAvailable: () => undefined,
      getOrganizationId: () => target.orgId,
      getToken: () => ({ user_id: 'user_test', organization_id: target.orgId }),
    },
    serviceClient: {
      listProjects: async () => [{
        id: target.projectId,
        name: input.projectName ?? target.projectName,
        organization_id: target.orgId,
      }],
      listBranches: async () => [{
        id: input.branchId ?? 'branch-one',
        name: target.branch,
        ...(input.branchProjectId === null
          ? {}
          : { project_id: input.branchProjectId ?? target.projectId }),
        is_protected: false,
      }],
      getDecryptData: async () => ({
        env_content: '',
        decrypt_key: '',
        expires_at: '2099-01-01T00:00:00.000Z',
        ...(input.remoteKeepText !== undefined
          ? { keep_file: input.remoteKeepText }
          : remoteKeep ? { keep_file: JSON.stringify(remoteKeep) } : {}),
        ...(input.remoteHash !== undefined
          ? { keep_hash: input.remoteHash }
          : computedHash !== undefined
            ? { keep_hash: computedHash }
            : {}),
      }),
      getSignupReadiness: async () => input.readiness ?? readiness,
      getBillingStatus: async () => ({ tier: input.free ? 'free' : 'business', grandfathered: false }),
    },
  };
}

describe('CapyCommand hosted terminal verification', () => {
  test('requires the exact local target, authenticated project/branch and matching remote Keep hash', async () => {
    const verified = await verifyHostedInitialization.call(
      subject(keep, target.branch),
      context({ branchProjectId: null }),
      target,
    );
    expect(verified).toEqual({ repositoryVerified: true, custodyVerified: true });

    const drifted = await verifyHostedInitialization.call(
      subject(keep, target.branch),
      context({ remoteHash: `sha256:${'f'.repeat(64)}` }),
      target,
    );
    expect(drifted).toEqual({ repositoryVerified: false, custodyVerified: true });

    const missingLocalCiphertext = await verifyHostedInitialization.call(
      subject(keep, target.branch, {}),
      context(),
      target,
    );
    expect(missingLocalCiphertext.repositoryVerified).toBe(false);

    const conflictingBranchEcho = await verifyHostedInitialization.call(
      subject(keep, target.branch),
      context({ branchProjectId: 'project-other' }),
      target,
    );
    expect(conflictingBranchEcho.repositoryVerified).toBe(false);
  });

  test('keeps custody false when the authoritative signup boundary is incomplete', async () => {
    const incomplete = {
      signup_complete: false,
      retryable: true,
      custody: {
        key_state: 'minted',
        ceremony_pending: true,
        has_live_wrapped_k_local: true,
      },
    } as const;
    const verified = await verifyHostedInitialization.call(
      subject(keep, target.branch),
      context({ readiness: incomplete }),
      target,
    );
    expect(verified).toEqual({ repositoryVerified: true, custodyVerified: false });
  });

  test('accepts an authenticated empty project only when the local Keep is also empty', async () => {
    const emptyKeep: KeepFile = { ...keep, variables: {} };
    const verified = await verifyHostedInitialization.call(
      subject(emptyKeep, target.branch),
      context({ remoteKeep: null }),
      target,
    );
    expect(verified).toEqual({ repositoryVerified: true, custodyVerified: true });

    const missingRemote = await verifyHostedInitialization.call(
      subject(keep, target.branch),
      context({ remoteKeep: null }),
      target,
    );
    expect(missingRemote.repositoryVerified).toBe(false);
  });

  test('rejects malformed remote Keep data instead of treating it as an empty project', async () => {
    const emptyKeep: KeepFile = { ...keep, variables: {} };
    const malformed = await verifyHostedInitialization.call(
      subject(emptyKeep, target.branch),
      context({ remoteKeepText: '{not-json' }),
      target,
    );
    expect(malformed).toEqual({ repositoryVerified: false, custodyVerified: true });
  });

  test('preserves an explicit encrypt decline as cancelled when plaintext prevents repository verification', () => {
    expect(buildHostedCompletionPlan('cancelled', {
      repositoryVerified: false,
      custodyVerified: true,
    })).toEqual({
      status: 'cancelled',
      code: 'INIT_RUN_CANCELLED',
      effects: 'indeterminate',
      delivery: 'abort',
      failureCode: null,
    });
  });

  test('free completion requires exact runtime metadata, remote hash and ciphertext without keep.lock', async () => {
    const freeTarget = { ...target, projectName: 'default', syncMode: 'free' } as const;
    const freeKeep = { ...keep, project_name: 'default' };
    const sync: SyncState = {
      last_sync: '2026-09-11T17:00:00.000Z', synced_variables: ['SENTINEL'], user_id: 'user_test',
      org_id: target.orgId, project_id: target.projectId, project_name: 'default', sync_mode: 'free',
      keep_hash: { development: SyncEngine.computeKeepHash(freeKeep, target.branch) },
    };
    const freeSubject = (input: Readonly<{ state?: SyncState; localKeep?: KeepFile; values?: Readonly<Record<string, string>> }> = {}) => ({
      options: {},
      projectManager: { readKeepFile: () => input.localKeep ?? null, readActiveBranch: () => target.branch,
        readSyncState: () => input.state ?? sync },
      fileManager: { readEnvFile: () => input.values ?? { SENTINEL: 'capy:development:SENTINEL:sealed' },
        readEnvMeta: () => ({ org_id: target.orgId, project_id: target.projectId, branch: target.branch }) },
    });
    const remote = context({ free: true, projectName: 'default', remoteKeep: freeKeep });
    expect(await verifyHostedInitialization.call(freeSubject(), remote, freeTarget))
      .toEqual({ repositoryVerified: true, custodyVerified: true });
    for (const invalid of [
      { state: { ...sync, project_id: 'other' } },
      { state: { ...sync, keep_hash: { development: 'stale' } } },
      { state: { ...sync, synced_variables: [] } },
      { localKeep: freeKeep }, { values: { SENTINEL: 'plaintext' } },
    ]) expect((await verifyHostedInitialization.call(freeSubject(invalid), remote, freeTarget)).repositoryVerified).toBe(false);
    expect((await verifyHostedInitialization.call(freeSubject(),
      context({ free: false, projectName: 'default', remoteKeep: freeKeep }), freeTarget)).repositoryVerified).toBe(false);
    expect((await verifyHostedInitialization.call(freeSubject(),
      context({ free: true, projectName: 'default', remoteKeep: null }), freeTarget)).repositoryVerified).toBe(false);
  });
});
