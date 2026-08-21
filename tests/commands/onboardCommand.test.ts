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
    next() {
      throw new StopAfterConfirm('stop: next() reached after confirm');
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
  process.exitCode = exitCode;
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
    try {
      await runOnboardCommand({ json: true, flowId: 'flow-3', accepted: true, targetDir }, false);
    } finally {
      restore();
    }
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
    expect(process.exitCode).not.toBe(1);
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
