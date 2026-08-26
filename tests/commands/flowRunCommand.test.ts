/**
 * `capy flow run` — attach to a hosted-minted `checkout` flow instance and
 * drive it to completion.
 *
 * Two layers, mirroring flows/onboard's own driver.test.ts / executors.test.ts
 * split:
 *
 *   - the RECURSIVE DRIVER (`__testables.driveCheckoutFlow`), exercised
 *     directly against a fake `ServiceClient` and a REAL `ProjectManager`/
 *     `FileManager` pointed at a throwaway temp directory — the same "real FS,
 *     mocked network boundary" shape `tests/flows/executors.test.ts` uses.
 *     Covers: the confirm-pending poll budget, `switch_branch` execution
 *     (asserting the extracted `syncAndWriteBranch` — reused verbatim from
 *     `checkoutCommand.ts` — is reached with the RIGHT branch name),
 *     BRANCH_SWITCH_FAILED reporting, `done` rendering, and fail-closed
 *     refusal on a verb outside the vendored contract.
 *
 *   - the TOP-LEVEL COMMAND (`runFlowRunCommand`), with `AuthService` and
 *     `ServiceClient` mocked at the module boundary (same shape as
 *     tests/commands/flowCancelCommand.test.ts) — covers the no-session coded
 *     refusal and `GET /flows/mine` filtering (onboard instances and
 *     done/cancelled checkout instances are never attached to).
 *
 * `resolveProjectKey` (src/crypto/keyResolver.ts) is mocked throughout: real
 * key resolution needs a real local root + wrapped key.enc on disk, which is
 * exactly the machinery this file's tests are not about — a fixed key string
 * is enough to prove `switch_branch`'s own reuse of `syncAndWriteBranch`.
 *
 * Every test that needs a project directory gets its OWN, via `withProject`
 * below — created and torn down inside that one call, never a module-scope
 * `let` reassigned per test — so a branch switch one test performs on disk
 * can never leak into the next.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Captured BEFORE any mock.module() call below runs (ES import hoisting), so
// the mocked factories below can spread the genuine modules rather than
// `require()`-ing them from inside their own factory — which self-references
// the mock currently being constructed instead of the real thing.
//
// Both are needed because this file (unlike flowCancelCommand.test.ts) pulls
// in checkoutCommand.ts for `syncAndWriteBranch` — which imports
// statusCommand.ts, which imports OTHER named exports off authService.ts
// (`silentAuthFailureMessage`) and keyResolver.ts (`resolveFromLocalKey`,
// `decryptLocalMasterKeyHex`) that a bare replacement would leave undefined.
import * as keyResolverActual from '../../src/crypto/keyResolver';
import * as authServiceActual from '../../src/auth/authService';

const mockAuthenticateSilent = jest.fn();
const mockGetValidToken = jest.fn();
const mockSetSessionUserId = jest.fn();
const mockSetTokenProvider = jest.fn();
const mockListMyFlows = jest.fn();
const mockReportFlowObservations = jest.fn();
const mockGetFlowStep = jest.fn();
const mockListBranches = jest.fn();
const mockGetDecryptData = jest.fn();
const mockCoDecrypt = jest.fn();
const mockWrapOuterLayer = jest.fn();
const mockResolveProjectKey = jest.fn();

mock.module('../../src/auth/authService', () => ({
  ...authServiceActual,
  AuthService: jest.fn().mockImplementation(() => ({
    authenticateSilent: mockAuthenticateSilent,
    getValidToken: mockGetValidToken,
    setSessionUserId: mockSetSessionUserId,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetTokenProvider,
    listMyFlows: mockListMyFlows,
    reportFlowObservations: mockReportFlowObservations,
    getFlowStep: mockGetFlowStep,
    listBranches: mockListBranches,
    getDecryptData: mockGetDecryptData,
    coDecrypt: mockCoDecrypt,
    wrapOuterLayer: mockWrapOuterLayer,
  })),
}));

// Spread the REAL module rather than replacing it outright: checkoutCommand.ts
// (imported transitively for `syncAndWriteBranch`) pulls in statusCommand.ts →
// core/localUnlock.ts, which imports OTHER named exports off this same
// module (`resolveFromLocalKey`, `decryptLocalMasterKeyHex`) that a bare
// `{ resolveProjectKey: ... }` replacement would leave undefined.
mock.module('../../src/crypto/keyResolver', () => ({
  ...keyResolverActual,
  resolveProjectKey: mockResolveProjectKey,
}));

afterAll(() => {
  mock.restore();
});

// Top-level await, after the mock.module() calls above (which run first).
const { runFlowRunCommand, __testables } = await import('../../src/commands/flowRunCommand');
const { FLOW_CONTRACT_VERSION, FlowContractError, FLOW_ERROR_CODES } = await import('../../src/flows/validate');
const { ERROR_CODES } = await import('../../src/types/index');
const { ProjectManager } = await import('../../src/core/projectManager');
const { FileManager } = await import('../../src/files/fileManager');
const { ServiceClient } = await import('../../src/service/serviceClient');

const FLOW_ID = 'flow-checkout-1';
const PROJECT_ID = 'proj-1';
const ORG_ID = 'org-1';
const PROJECT_NAME = 'demo-project';

function checkoutEnvelope(over: Record<string, unknown>): Record<string, unknown> {
  return {
    contract_version: FLOW_CONTRACT_VERSION,
    flow_id: FLOW_ID,
    flow_type: 'checkout',
    step_id: `s-${Math.random().toString(36).slice(2, 8)}`,
    resumed: false,
    params: {},
    ...over,
  };
}

/**
 * A throwaway project directory — a real keep.lock (project `demo-project`)
 * and `.capy/branch` pinned to `main` — created for exactly the duration of
 * `run`, and removed once it settles either way. Never a module-scope
 * variable reassigned between tests: each call gets its own directory, so
 * one test's branch switch can never be visible to another's.
 */
async function withProject(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-flow-run-'));
  try {
    new FileManager(dir).writeKeepFile({
      version: '1',
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      project_name: PROJECT_NAME,
      variables: {},
    });
    new ProjectManager(dir).writeActiveBranch('main');
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeServiceClient(overrides: Partial<{ listBranches: unknown; getDecryptData: unknown }> = {}) {
  const serviceClient = new ServiceClient() as any;
  serviceClient.reportFlowObservations = mockReportFlowObservations;
  serviceClient.getFlowStep = mockGetFlowStep;
  serviceClient.listBranches = overrides.listBranches ?? mockListBranches;
  serviceClient.getDecryptData = overrides.getDecryptData ?? mockGetDecryptData;
  serviceClient.coDecrypt = mockCoDecrypt;
  serviceClient.wrapOuterLayer = mockWrapOuterLayer;
  return serviceClient;
}

function depsFor(dir: string) {
  return {
    projectManager: new ProjectManager(dir),
    fileManager: new FileManager(dir),
    serviceClient: fakeServiceClient(),
    userId: 'user-1',
    sleep: async () => {}, // fast — no real waiting in tests
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticateSilent.mockResolvedValue({ success: true, user_id: 'user-1' });
  mockGetValidToken.mockResolvedValue({ access_token: 'tok' });
  mockResolveProjectKey.mockResolvedValue('fake-project-key');
  mockGetDecryptData.mockResolvedValue({ env_content: '', decrypt_key: '', expires_at: new Date().toISOString() });
  mockGetFlowStep.mockResolvedValue({ step: null, derived_at: null, state: 'active' });
  process.exitCode = 0;
});

async function captured(run: () => Promise<void>): Promise<{ error: unknown; log: string; err: string }> {
  const logLines: string[] = [];
  const errLines: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errLines.push(args.map(String).join(' '));
  };
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  console.log = originalLog;
  console.error = originalErr;
  return { error, log: logLines.join('\n'), err: errLines.join('\n') };
}

describe('__testables.isDrivableCheckoutFlow — GET /flows/mine filtering', () => {
  test('ignores onboard instances', () => {
    expect(
      __testables.isDrivableCheckoutFlow({
        flow_id: 'f1',
        flow_type: 'onboard',
        contract_version: FLOW_CONTRACT_VERSION,
        repo_key: 'x',
        status: 'active',
        step: null,
      }),
    ).toBe(false);
  });

  test('ignores done and cancelled checkout instances', () => {
    for (const status of ['done', 'cancelled']) {
      expect(
        __testables.isDrivableCheckoutFlow({
          flow_id: 'f1',
          flow_type: 'checkout',
          contract_version: FLOW_CONTRACT_VERSION,
          repo_key: 'x',
          status,
          step: null,
        }),
      ).toBe(false);
    }
  });

  test('accepts an active checkout instance at a contract version this build supports', () => {
    expect(
      __testables.isDrivableCheckoutFlow({
        flow_id: 'f1',
        flow_type: 'checkout',
        contract_version: FLOW_CONTRACT_VERSION,
        repo_key: 'x',
        status: 'active',
        step: null,
      }),
    ).toBe(true);
  });

  test('refuses a contract version this build does not support', () => {
    expect(
      __testables.isDrivableCheckoutFlow({
        flow_id: 'f1',
        flow_type: 'checkout',
        contract_version: '999',
        repo_key: 'x',
        status: 'active',
        step: null,
      }),
    ).toBe(false);
  });
});

describe('__testables.driveCheckoutFlow — the recursive drive loop', () => {
  test('confirm → polls GET /flows/:id/next up to the budget, then reports confirm_pending (never answers the dialog, never re-POSTs)', async () => {
    await withProject(async (dir) => {
      const confirmStep = checkoutEnvelope({
        kind: 'confirm',
        dialog: 'checkout_plan',
        params: { plan_hash: 'h1', project_name: PROJECT_NAME, branch_name: 'feature-x' },
      });
      mockReportFlowObservations.mockResolvedValueOnce({ step: confirmStep });
      // GET keeps echoing back the SAME cached step_id — nothing has changed.
      mockGetFlowStep.mockResolvedValue({ step: confirmStep, derived_at: new Date().toISOString(), state: 'active' });

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(outcome.kind).toBe('confirm_pending');
      // Exactly ONE report (the one that surfaced the confirm) — polling
      // never reports observations, it only peeks.
      expect(mockReportFlowObservations).toHaveBeenCalledTimes(1);
      // POLL_ATTEMPTS (flowRunCommand.ts) is 3 — exhausted here.
      expect(mockGetFlowStep).toHaveBeenCalledTimes(3);
    });
  });

  test('confirm resolving mid-poll (human approved) is detected via GET, then a fresh POST advances into the local_action it unlocked', async () => {
    await withProject(async (dir) => {
      const confirmStep = checkoutEnvelope({
        kind: 'confirm',
        dialog: 'checkout_plan',
        params: { plan_hash: 'h1', project_name: PROJECT_NAME, branch_name: 'feature-x' },
      });
      const localActionStep = checkoutEnvelope({
        kind: 'local_action',
        verb: 'switch_branch',
        params: { project_name: PROJECT_NAME, branch_name: 'feature-x', consent_recorded: true },
      });
      const doneStep = checkoutEnvelope({
        kind: 'done',
        params: { project_name: PROJECT_NAME, branch_name: 'feature-x' },
      });
      mockReportFlowObservations
        .mockResolvedValueOnce({ step: confirmStep })
        .mockResolvedValueOnce({ step: localActionStep })
        .mockResolvedValueOnce({ step: doneStep });
      // POST /:id/confirm clears the cache to null the instant it records an
      // answer (service/src/routes/flows.ts) — the first GET peek sees that.
      mockGetFlowStep.mockResolvedValueOnce({ step: null, derived_at: null, state: 'active' });
      mockListBranches.mockResolvedValue([{ id: 'b1', name: 'feature-x', project_id: PROJECT_ID, is_protected: false }]);

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(mockGetFlowStep).toHaveBeenCalledTimes(1);
      expect(mockReportFlowObservations).toHaveBeenCalledTimes(3);
      expect(outcome.kind).toBe('done');
      expect(outcome.executed).toEqual([{ step_id: localActionStep.step_id, verb: 'switch_branch', outcome: 'ok', code: undefined }]);
    });
  });

  test('switch_branch reuses syncAndWriteBranch (checkoutCommand.ts) with the RIGHT branch, and completes to done', async () => {
    await withProject(async (dir) => {
      const localActionStep = checkoutEnvelope({
        kind: 'local_action',
        verb: 'switch_branch',
        params: { project_name: PROJECT_NAME, branch_name: 'feature-x', consent_recorded: true },
      });
      const doneStep = checkoutEnvelope({ kind: 'done', params: { project_name: PROJECT_NAME, branch_name: 'feature-x' } });
      mockReportFlowObservations.mockResolvedValueOnce({ step: localActionStep }).mockResolvedValueOnce({ step: doneStep });
      mockListBranches.mockResolvedValue([{ id: 'b1', name: 'feature-x', project_id: PROJECT_ID, is_protected: false }]);

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(mockListBranches).toHaveBeenCalledWith(PROJECT_ID);
      expect(mockGetDecryptData).toHaveBeenCalledWith(PROJECT_ID, 'feature-x', undefined, true);
      expect(new ProjectManager(dir).readActiveBranch()).toBe('feature-x');
      expect(outcome.kind).toBe('done');
      expect(outcome.executed).toEqual([{ step_id: localActionStep.step_id, verb: 'switch_branch', outcome: 'ok', code: undefined }]);

      // The SECOND report carries the executed step's outcome as `last_step` —
      // the checkout report schema, same shape onboard's own driver reports.
      const secondCallBody = mockReportFlowObservations.mock.calls[1][1];
      expect(secondCallBody.last_step).toEqual({ step_id: localActionStep.step_id, outcome: 'ok', code: undefined });
    });
  });

  test('a branch not found locally reports BRANCH_SWITCH_FAILED, never touches getDecryptData', async () => {
    await withProject(async (dir) => {
      const localActionStep = checkoutEnvelope({
        kind: 'local_action',
        verb: 'switch_branch',
        params: { project_name: PROJECT_NAME, branch_name: 'ghost-branch', consent_recorded: true },
      });
      const blockedStep = checkoutEnvelope({ kind: 'blocked', reason: 'branch_switch_failed', params: {} });
      mockReportFlowObservations.mockResolvedValueOnce({ step: localActionStep }).mockResolvedValueOnce({ step: blockedStep });
      mockListBranches.mockResolvedValue([]); // ghost-branch does not exist

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(mockGetDecryptData).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('blocked');
      expect(outcome.step.reason).toBe('branch_switch_failed');
      expect(outcome.executed).toEqual([
        { step_id: localActionStep.step_id, verb: 'switch_branch', outcome: 'failed', code: ERROR_CODES.BRANCH_SWITCH_FAILED },
      ]);

      const secondCallBody = mockReportFlowObservations.mock.calls[1][1];
      expect(secondCallBody.last_step).toEqual({
        step_id: localActionStep.step_id,
        outcome: 'failed',
        code: ERROR_CODES.BRANCH_SWITCH_FAILED,
      });
    });
  });

  test('done renders the project/branch from the terminal step\'s own params', async () => {
    await withProject(async (dir) => {
      const doneStep = checkoutEnvelope({ kind: 'done', params: { project_name: PROJECT_NAME, branch_name: 'main' } });
      mockReportFlowObservations.mockResolvedValue({ step: doneStep });

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(outcome.kind).toBe('done');
      expect(outcome.step.params).toEqual({ project_name: PROJECT_NAME, branch_name: 'main' });
    });
  });

  test('a blocked terminal reason (e.g. incompatible_project) is reported as blocked', async () => {
    await withProject(async (dir) => {
      const blockedStep = checkoutEnvelope({ kind: 'blocked', reason: 'checkout_declined', params: {} });
      mockReportFlowObservations.mockResolvedValue({ step: blockedStep });

      const outcome = await __testables.driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0);

      expect(outcome.kind).toBe('blocked');
      expect(outcome.step.reason).toBe('checkout_declined');
    });
  });

  test('fail-closed: a verb outside the vendored vocabulary refuses rather than executing anything', async () => {
    await withProject(async (dir) => {
      const bogusStep = checkoutEnvelope({
        kind: 'local_action',
        verb: 'rm_rf_everything',
        params: {},
      });
      mockReportFlowObservations.mockResolvedValue({ step: bogusStep });

      const err = await __testables
        .driveCheckoutFlow(depsFor(dir), FLOW_ID, { executed: [] }, 0)
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(FlowContractError);
      expect((err as InstanceType<typeof FlowContractError>).code).toBe(FLOW_ERROR_CODES.UNKNOWN_VERB);
      // Nothing was ever executed against the local branch.
      expect(mockGetDecryptData).not.toHaveBeenCalled();
      expect(new ProjectManager(dir).readActiveBranch()).toBe('main');
    });
  });
});

describe('__testables.computeRepoMatchesProject / computeSwitchCompleted', () => {
  test('repoMatchesProject is false with no keep.lock at all', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'capy-flow-run-empty-'));
    try {
      expect(__testables.computeRepoMatchesProject(new ProjectManager(emptyDir), PROJECT_NAME)).toBe(false);
      expect(__testables.computeRepoMatchesProject(new ProjectManager(emptyDir), undefined)).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('repoMatchesProject is optimistically true before any pinned name has been learned', async () => {
    await withProject(async (dir) => {
      expect(__testables.computeRepoMatchesProject(new ProjectManager(dir), undefined)).toBe(true);
    });
  });

  test('repoMatchesProject checks the real name once one is known', async () => {
    await withProject(async (dir) => {
      expect(__testables.computeRepoMatchesProject(new ProjectManager(dir), PROJECT_NAME)).toBe(true);
      expect(__testables.computeRepoMatchesProject(new ProjectManager(dir), 'some-other-project')).toBe(false);
    });
  });

  test('switchCompleted is false until the pinned branch is known AND active', async () => {
    await withProject(async (dir) => {
      expect(__testables.computeSwitchCompleted(new ProjectManager(dir), undefined)).toBe(false);
      expect(__testables.computeSwitchCompleted(new ProjectManager(dir), 'feature-x')).toBe(false);
      expect(__testables.computeSwitchCompleted(new ProjectManager(dir), 'main')).toBe(true);
    });
  });
});

describe('runFlowRunCommand — no session', () => {
  test('a silent-auth failure prints a coded refusal and exits non-zero, never calling listMyFlows', async () => {
    await withProject(async (dir) => {
      mockAuthenticateSilent.mockResolvedValue({ success: false, error: 'no session', error_code: undefined });

      const { log, err } = await captured(() => runFlowRunCommand({ json: true, targetDir: dir }));

      expect(process.exitCode).toBe(1);
      expect(mockListMyFlows).not.toHaveBeenCalled();
      const out = JSON.parse(log || err || '{}');
      expect(out.ok).toBe(false);
      expect(out.code).toBe(ERROR_CODES.AUTH_FAILED);
    });
  });
});

describe('runFlowRunCommand — GET /flows/mine discovery', () => {
  test('picks the first drivable checkout instance, ignoring an onboard instance ahead of it', async () => {
    await withProject(async (dir) => {
      mockListMyFlows.mockResolvedValue([
        { flow_id: 'onboard-1', flow_type: 'onboard', contract_version: FLOW_CONTRACT_VERSION, repo_key: 'x', status: 'active', step: null },
        { flow_id: FLOW_ID, flow_type: 'checkout', contract_version: FLOW_CONTRACT_VERSION, repo_key: 'y', status: 'active', step: null },
      ]);
      const doneStep = checkoutEnvelope({ kind: 'done', params: { project_name: PROJECT_NAME, branch_name: 'main' } });
      mockReportFlowObservations.mockResolvedValue({ step: doneStep });

      await captured(() => runFlowRunCommand({ json: true, targetDir: dir }));

      expect(mockReportFlowObservations).toHaveBeenCalledWith(FLOW_ID, expect.anything());
    });
  });

  test('no drivable checkout flow found: exits 0 with an informational result', async () => {
    await withProject(async (dir) => {
      mockListMyFlows.mockResolvedValue([
        { flow_id: 'onboard-1', flow_type: 'onboard', contract_version: FLOW_CONTRACT_VERSION, repo_key: 'x', status: 'active', step: null },
      ]);

      const { log } = await captured(() => runFlowRunCommand({ json: true, targetDir: dir }));

      expect(process.exitCode).toBe(0);
      expect(mockReportFlowObservations).not.toHaveBeenCalled();
      expect(JSON.parse(log).ok).toBe(true);
    });
  });
});
