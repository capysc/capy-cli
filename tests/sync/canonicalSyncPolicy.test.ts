import { describe, expect, test } from 'bun:test';
import type {
  BillingResolvedSyncMode,
  CanonicalSyncFacts,
} from '../../src/sync/canonicalSyncPolicy';
import { planCanonicalSync } from '../../src/sync/canonicalSyncPolicy';

const FREE: BillingResolvedSyncMode = {
  source: 'billing',
  mode: 'free',
  orgId: 'org_personal',
  projectId: 'project_default',
  projectName: 'default',
  branch: 'development',
};

const PAID: BillingResolvedSyncMode = {
  source: 'billing',
  mode: 'paid',
  orgId: 'org_team',
  projectId: 'project_paid',
  branch: 'feature/onboarding',
};

function facts(overrides: Partial<CanonicalSyncFacts> = {}): CanonicalSyncFacts {
  return {
    authority: FREE,
    rootEnv: { exists: false, variableNames: [] },
    remote: { keepMarkerExists: false, variableNames: [] },
    ...overrides,
  };
}

describe('planCanonicalSync', () => {
  test('remote marker exists: remote wins and replaces local state', () => {
    const decision = planCanonicalSync(
      facts({
        rootEnv: { exists: true, variableNames: ['LOCAL_ONLY'] },
        remote: { keepMarkerExists: true, variableNames: ['REMOTE_ONLY'] },
      }),
    );

    expect(decision).toEqual({
      mode: 'free',
      action: 'fetch_remote',
      localKeepLock: 'forbidden',
      localEnv: 'replace_from_remote',
      remoteVariableNames: ['REMOTE_ONLY'],
    });
  });

  test('an empty remote marker is still authoritative remote state', () => {
    const decision = planCanonicalSync(
      facts({
        rootEnv: { exists: true, variableNames: ['STALE_LOCAL'] },
        remote: { keepMarkerExists: true, variableNames: [] },
      }),
    );

    expect(decision.action).toBe('fetch_remote');
    expect(decision.localKeepLock).toBe('forbidden');
  });

  test('no remote marker plus exact root .env: push local through canonical sync', () => {
    const decision = planCanonicalSync(
      facts({ rootEnv: { exists: true, variableNames: ['DATABASE_URL', 'WORKOS_API_KEY'] } }),
    );

    expect(decision).toEqual({
      mode: 'free',
      action: 'push_root_env',
      localKeepLock: 'forbidden',
      localEnv: 'encrypt_after_push',
      localVariableNames: ['DATABASE_URL', 'WORKOS_API_KEY'],
    });
  });

  test('an existing empty root .env still follows the local-push branch', () => {
    const decision = planCanonicalSync(facts({ rootEnv: { exists: true, variableNames: [] } }));

    expect(decision.action).toBe('push_root_env');
    expect(decision.localKeepLock).toBe('forbidden');
  });

  test('neither remote nor root .env: create only the empty remote marker', () => {
    expect(planCanonicalSync(facts())).toEqual({
      mode: 'free',
      action: 'create_empty_remote_marker',
      localKeepLock: 'forbidden',
      localEnv: 'leave_absent',
      message: 'No .env found',
    });
  });

  test('paid billing state delegates unchanged to the manifest corpus', () => {
    const decision = planCanonicalSync(
      facts({
        authority: PAID,
        rootEnv: { exists: false, variableNames: [] },
        remote: { keepMarkerExists: true, variableNames: ['REMOTE'] },
      }),
    );

    expect(decision).toEqual({
      mode: 'paid',
      action: 'delegate_paid_manifest',
      localKeepLock: 'paid_manifest_authority',
    });
  });

  test('copies caller-owned variable arrays into the immutable decision', () => {
    const remoteVariableNames = Object.freeze(['A', 'B']) as readonly string[];
    const decision = planCanonicalSync(
      facts({ remote: { keepMarkerExists: true, variableNames: remoteVariableNames } }),
    );

    expect(decision.action).toBe('fetch_remote');
    if (decision.action !== 'fetch_remote') throw new Error('unreachable');
    expect(decision.remoteVariableNames).toEqual(remoteVariableNames);
    expect(decision.remoteVariableNames).not.toBe(remoteVariableNames);
  });
});
