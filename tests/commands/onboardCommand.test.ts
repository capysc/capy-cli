/**
 * `runOnboardCommand`'s confirm handling.
 *
 * Bug A (CAPY-ONBOARD-SESSION-DUMP.md §3): `--confirm <planHash>` is
 * OPTIONAL now — when `--accepted` arrives with no `--confirm`, this process
 * computes the plan_hash it confirms with LOCALLY, from the same plan it
 * would post at flow-creation time, instead of requiring a caller (an MCP
 * tool, whose model may never have seen a real hash — some clients redact
 * high-entropy tool-result strings before the model reads them) to echo one
 * back.
 *
 * Bug B/E: a service 409 on confirm (the plan moved under the human) must
 * produce exactly one coded, parseable JSON object on stdout in `--json`
 * mode — never the raw "Flow request failed: ..." prose that used to escape
 * through `displayErrorAndExit` before this fix.
 */
import { mock, describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Real module, never mocked here. `runOnboardCommand` sets these as a
// process-global side effect (`../ui/webMode` — see that module's own doc:
// "Process-global, and legitimately so") whenever a test passes
// `brokerCeremony`/`json`, and NEVER unsets them itself — a real CLI
// invocation is one process per run, so there is nothing to reset FOR. A
// `bun test` run sharing one process across every file in this batch is
// exactly the case that doc didn't anticipate: left set, `isBrokerCeremonyMode()`
// stays true for every OTHER file's tests in the same process afterward,
// which is what `ui/errorScreen.ts`'s `isWebMode() && !isBrokerCeremonyMode()`
// gate reads to decide whether to serve a `--web` loopback page at all — a
// leak here silently starves totally unrelated `--web` refusal tests
// (`rotateRefusals.test.ts`) elsewhere in the same run. Reset unconditionally
// in `restore()` below, which every test in this file already calls.
import { setBrokerCeremonyMode, setOnboardJsonMode } from '../../src/ui/webMode';

// Mock homedir to an empty temp dir BEFORE importing anything that reads
// os.homedir() — same convention as tests/flows/driver.test.ts. An empty
// home means `AuthService` finds no session file and `authenticateSilent`
// returns fast with `success:false`, no network call.
const tempHome = mkdtempSync(join(tmpdir(), 'capy-onboardcmd-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

// The confirm call is the only thing under test — replace `FlowClient` so
// nothing here makes a real HTTP request. `FlowHttpError` stays the REAL
// class: `onboardCommand.ts` does `err instanceof FlowHttpError`, so a fake
// class here would silently break that branch.
const realFlowClientModule = require('../../src/flows/client');

let confirmCalls: Array<{ flowId: string; planHash: string; accepted: boolean }> = [];
let confirmBehavior: (planHash: string) => void = () => undefined;
let createCalls: Array<Record<string, unknown>> = [];
/** CAP-487: the flow-resolving create. Default preserves the pre-existing tests: create is never legitimately reached there. */
let createBehavior: () => unknown = () => {
  throw new StopAfterConfirm('stop: create() reached after confirm');
};
/**
 * Default preserves every pre-existing test in this file (none of them
 * legitimately reach `next()`: they exercise the `--accepted`/confirm
 * handling above, which returns or re-drives before `runOnboardFlow`'s own
 * loop ever calls it). Overridable the same way `confirmBehavior`/
 * `createBehavior` are, for the broker-ceremony coded-failure tests below.
 */
let nextBehavior: () => unknown = () => {
  throw new StopAfterConfirm('stop: next() reached after confirm');
};
/** Every `next()` call's own request body — additive: only read by the RESUME-plan tests below, which need to see what the driver actually sent. */
let nextCalls: Array<Record<string, unknown>> = [];
/** Thrown by the fake transport's other methods — these tests only care about `confirm`'s own call, not what the driver does afterward. */
class StopAfterConfirm extends Error {}

mock.module('../../src/flows/client', () => {
  class FakeFlowClient {
    confirm(flowId: string, planHash: string, accepted: boolean) {
      confirmCalls.push({ flowId, planHash, accepted });
      confirmBehavior(planHash);
      return Promise.resolve({});
    }
    create(body: Record<string, unknown>) {
      createCalls.push(body);
      return Promise.resolve(createBehavior());
    }
    next(_flowId: string, body: Record<string, unknown>) {
      nextCalls.push(body);
      return Promise.resolve(nextBehavior());
    }
    cancel() {
      return Promise.resolve();
    }
  }
  return { ...realFlowClientModule, FlowClient: FakeFlowClient };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let targetDir: string;
let logs: string[];
let errs: string[];
let realLog: typeof console.log;
let realErr: typeof console.error;
let exitCode: number | string | undefined;

beforeEach(() => {
  confirmCalls = [];
  confirmBehavior = () => undefined;
  createCalls = [];
  createBehavior = () => {
    throw new StopAfterConfirm('stop: create() reached after confirm');
  };
  nextBehavior = () => {
    throw new StopAfterConfirm('stop: next() reached after confirm');
  };
  nextCalls = [];
  targetDir = mkdtempSync(join(tmpdir(), 'capy-onboardcmd-target-'));
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: 'onboardcmd-fixture', scripts: {} }));
  logs = [];
  errs = [];
  realLog = console.log;
  realErr = console.error;
  console.log = ((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  }) as typeof console.error;
  exitCode = process.exitCode;
  process.exitCode = undefined;
});

function restore(): void {
  console.log = realLog;
  console.error = realErr;
  rmSync(targetDir, { recursive: true, force: true });
  // Bun (unlike Node) does NOT treat `process.exitCode = undefined` as
  // clearing a prior nonzero value — restoring a saved `undefined` over the
  // exit 1 the broker-ceremony failure tests legitimately produce left that
  // 1 in place, and the whole batch `bun test` process then exited 1 while
  // reporting 0 failing tests (run-tests.sh's "FAIL: batch run"). `?? 0`
  // keeps a genuinely saved nonzero and actually clears otherwise. Tests
  // that assert on the command's exit code snapshot it BEFORE this runs —
  // see `runCapturingExitCode`.
  process.exitCode = exitCode ?? 0;
  // See the import comment above: unconditional, every test, so a leaked
  // `true` from THIS file's `brokerCeremony`/`json` tests can never survive
  // into another file sharing this same `bun test` process.
  setBrokerCeremonyMode(false);
  setOnboardJsonMode(false);
}

/**
 * Runs a command thunk, snapshots `process.exitCode` before `restore()`
 * clears it (see restore's comment on Bun's `= undefined` no-op), and always
 * restores. Assertions must use the returned snapshot, never the live
 * `process.exitCode` after restore.
 */
async function runCapturingExitCode(run: () => Promise<unknown>): Promise<number | string | undefined> {
  try {
    await run();
    return process.exitCode;
  } finally {
    restore();
  }
}

describe('runOnboardCommand: --confirm is optional (Bug A)', () => {
  it('accepted with no --confirm computes and sends the plan_hash locally', async () => {
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    const { buildPlan } = await import('../../src/flows/onboard/plan');
    try {
      await runOnboardCommand({ json: true, flowId: 'flow-1', accepted: true, targetDir }, false).catch((err) => {
        if (!(err instanceof StopAfterConfirm)) throw err;
      });
    } finally {
      restore();
    }
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].flowId).toBe('flow-1');
    expect(confirmCalls[0].accepted).toBe(true);
    // The SAME hash `buildPlan` (what a fresh flow-creation call would post)
    // produces for this exact directory — this process's own value, never
    // something round-tripped through a caller.
    const expected = buildPlan({ targetDir }).planHash;
    expect(confirmCalls[0].planHash).toBe(expected);
    expect(confirmCalls[0].planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an explicit --confirm is still honored, unchanged', async () => {
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    try {
      await runOnboardCommand(
        { json: true, flowId: 'flow-2', confirm: 'explicit-hash-value', accepted: false, targetDir },
        false,
      ).catch((err) => {
        if (!(err instanceof StopAfterConfirm)) throw err;
      });
    } finally {
      restore();
    }
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].planHash).toBe('explicit-hash-value');
    expect(confirmCalls[0].accepted).toBe(false);
  });

  it('--confirm alone, with no --accepted, answers nothing (the gate is `accepted`, not `confirm`)', async () => {
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    try {
      // No --flow-id either: if this treated `confirm` as the gate it would
      // throw "needs --flow-id" here. It must not even reach that check.
      await runOnboardCommand({ json: true, confirm: 'some-hash', targetDir }, false).catch(() => undefined);
    } finally {
      restore();
    }
    expect(confirmCalls).toEqual([]);
  });
});

describe('runOnboardCommand: --accepted with no --flow-id resolves the flow itself (CAP-487)', () => {
  it('resolves via the repo_key create/attach path and confirms on the resolved instance', async () => {
    createBehavior = () => ({
      flow_id: 'resolved-flow',
      flow_type: 'onboard',
      contract_version: '1',
      binding: 'identified',
      resumed: true,
      step: null,
    });
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    const { buildPlan } = await import('../../src/flows/onboard/plan');
    try {
      await runOnboardCommand({ json: true, accepted: true, targetDir }, false).catch((err) => {
        if (!(err instanceof StopAfterConfirm)) throw err;
      });
    } finally {
      restore();
    }
    // One resolving create, carrying this repo's own identity + plan.
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].repo_key).toBe(targetDir);
    expect((createCalls[0].plan as Record<string, unknown>).plan_hash).toBe(
      buildPlan({ targetDir }).planHash,
    );
    // The confirm landed on the instance the create resolved — never thrown
    // away, never "needs --flow-id".
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].flowId).toBe('resolved-flow');
    expect(confirmCalls[0].accepted).toBe(true);
  });

  it('a create that answers with a blocked step is reported as that step — the confirm never fires', async () => {
    createBehavior = () => ({
      step: {
        contract_version: '1',
        flow_id: 'someone-elses-flow',
        flow_type: 'onboard',
        step_id: 'someone-elses-flow-blocked',
        kind: 'blocked',
        resumed: false,
        reason: 'concurrent_flow',
        params: {},
      },
    });
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    try {
      await runOnboardCommand({ json: true, accepted: true, targetDir }, false);
    } finally {
      restore();
    }
    expect(confirmCalls).toEqual([]);
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.step.kind).toBe('blocked');
    expect(parsed.step.reason).toBe('concurrent_flow');
  });

  it('an explicit --flow-id still skips the resolving create entirely', async () => {
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    try {
      await runOnboardCommand({ json: true, flowId: 'flow-explicit', accepted: true, targetDir }, false).catch(
        (err) => {
          if (!(err instanceof StopAfterConfirm)) throw err;
        },
      );
    } finally {
      restore();
    }
    // With an explicit id there is no resolving create, and the re-drive
    // resumes the same instance (no driver-side create either).
    expect(createCalls).toEqual([]);
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].flowId).toBe('flow-explicit');
  });
});

describe('runOnboardCommand: a 409 on confirm is a coded, parseable JSON result (Bug B/E)', () => {
  it('prints exactly one JSON object on stdout — never the raw "Flow request failed" prose', async () => {
    const { FlowHttpError } = await import('../../src/flows/client');
    confirmBehavior = () => {
      throw new FlowHttpError(409, 'CONFLICT_RESOLUTION');
    };
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    const exitCodeAfterRun = await runCapturingExitCode(() =>
      runOnboardCommand({ json: true, flowId: 'flow-3', accepted: true, targetDir }, false),
    );
    // Exactly one console.log call, and it parses as ONE JSON object.
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.flow_id).toBe('flow-3');
    expect(parsed.step.kind).toBe('blocked');
    expect(parsed.step.reason).toBe('plan_changed');
    // Never the raw prose an MCP caller used to see verbatim.
    expect(logs[0]).not.toContain('Flow request failed');
    expect(logs.join('\n')).not.toContain('CONFLICT_RESOLUTION');
    // A blocked step in --json mode is a legitimate stop, not a crash: exit
    // code is never forced non-zero for it (module doc: only a genuine
    // failure exits non-zero).
    expect(exitCodeAfterRun).not.toBe(1);
  });

  it('a non-409 error is NOT swallowed — still propagates', async () => {
    confirmBehavior = () => {
      throw new Error('totally unrelated failure');
    };
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    let threw = false;
    try {
      await runOnboardCommand({ json: true, flowId: 'flow-4', accepted: true, targetDir }, false);
    } catch {
      threw = true;
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(logs).toEqual([]);
  });
});

describe('runOnboardCommand: --broker-ceremony --json surfaces a coded flow-service failure off `next`', () => {
  // The service refuses a `next` report offering a client_pubkey different
  // from the one already registered for this instance with a 409 coded
  // CLIENT_PUBKEY_CONFLICT — fatal for a broker-ceremony run (a ceremony
  // sealed to a missing/other key is unusable). Before this fix, an escaped
  // `FlowHttpError` on this belt-and-suspenders path always collapsed to the
  // generic SERVICE_ERROR (the catch only ever read a `CapyError`'s code) —
  // this asserts the service's own code now survives, same as it already did
  // on the TTY path (`ui/errorScreen.ts`'s `FlowHttpError` handling).
  it('a 409 CLIENT_PUBKEY_CONFLICT is reported with the SERVICE\'s own code, not the generic fallback', async () => {
    const { FlowHttpError } = await import('../../src/flows/client');
    nextBehavior = () => {
      throw new FlowHttpError(409, 'CLIENT_PUBKEY_CONFLICT');
    };
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    const exitCodeAfterRun = await runCapturingExitCode(() =>
      runOnboardCommand(
        { json: true, flowId: 'flow-broker-1', flowSecret: 'sekrit', brokerCeremony: true, targetDir },
        false,
      ),
    );
    // Exactly one coded object on stderr — never a step shape, never the raw
    // "Flow request failed: ..." prose.
    expect(errs.length).toBe(1);
    const parsed = JSON.parse(errs[0]);
    expect(parsed.error).toBe('onboard_failed');
    expect(parsed.code).toBe('CLIENT_PUBKEY_CONFLICT');
    expect(exitCodeAfterRun).toBe(1);
    expect(logs).toEqual([]);
  });

  it('an unrecognised FlowHttpError code still falls back to the generic service error (unchanged)', async () => {
    const { FlowHttpError } = await import('../../src/flows/client');
    nextBehavior = () => {
      throw new FlowHttpError(409, 'SOME_FUTURE_CODE_THIS_BUILD_DOES_NOT_KNOW');
    };
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    try {
      await runOnboardCommand(
        { json: true, flowId: 'flow-broker-2', flowSecret: 'sekrit', brokerCeremony: true, targetDir },
        false,
      );
    } finally {
      restore();
    }
    expect(errs.length).toBe(1);
    const parsed = JSON.parse(errs[0]);
    expect(parsed.code).toBe('SERVICE_ERROR');
  });
});

describe('runOnboardCommand: a RESUME reports its own computed plan on the first next() call', () => {
  // Dev-rig bug: `capy onboard --flow-id X --flow-secret Y --json` against a
  // flow minted by the hosted MCP (`minted_for: 'remote'`) reached the
  // confirm/onboard_plan step with EMPTY plan facts — target_dir "",
  // variable_count 0, plan_hash "" — even though the target dir held a real
  // `.env` with one variable. The service only ever gets plan facts from a
  // client-reported `body.plan`, and a remote mint's create body never had
  // one to begin with (no local directory at mint time); the driver's `next`
  // report is the only place left to carry it. No `--accepted` here: this is
  // the plain resume path, not the confirm-answering one the tests above
  // exercise.
  it('sends target_dir/variable_count/plan_hash facts on next() when resuming, with no create call at all', async () => {
    writeFileSync(join(targetDir, '.env'), 'API_KEY=shh\n');
    const { FLOW_CONTRACT_VERSION } = await import('../../src/flows/validate');
    nextBehavior = () => ({
      step: {
        contract_version: FLOW_CONTRACT_VERSION,
        flow_id: 'flow-resume-1',
        flow_type: 'onboard',
        step_id: 'flow-resume-1-done',
        kind: 'done',
        resumed: true,
        params: {},
      },
    });
    const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
    const { buildPlan } = await import('../../src/flows/onboard/plan');
    try {
      await runOnboardCommand({ json: true, flowId: 'flow-resume-1', flowSecret: 'sekrit', targetDir }, false);
    } finally {
      restore();
    }
    // Resuming an existing instance never calls create — only next().
    expect(createCalls).toEqual([]);
    expect(nextCalls.length).toBe(1);
    const sentPlan = nextCalls[0].plan as Record<string, unknown> | undefined;
    expect(sentPlan).toBeDefined();
    expect(sentPlan?.plan_hash).toBe(buildPlan({ targetDir }).planHash);
    expect(sentPlan?.target_dir).toBe(targetDir);
    expect(sentPlan?.variable_count).toBe(1);
  });
});
