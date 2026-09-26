import { describe, expect, test } from 'bun:test';
import { flowAgentPlanHash, initialFlowAgentState, processFlowAgentRequest, type FlowAgentPlan } from '../../src/ui/flowAgentBridge';

const basePlan = {
  plan_id: 'plan-1', summary: 'Add project setup', files: [{ path: 'src/setup.ts', change: 'add setup', reason: 'configure project' }], checks: ['bun test'],
} as const;
const plan: FlowAgentPlan = { ...basePlan, plan_hash: flowAgentPlanHash({ ...basePlan, plan_hash: 'ignored' }) };
const runtime = {
  flowId: 'flow-1', ownerId: 'user-1', authenticate: async (token: string) => token === 'local-token', readHistory: async () => [],
  emitOutput: async () => undefined, emitProgress: async () => undefined, emitCompleted: async () => undefined,
  askPlanApproval: async () => true, askContinuation: async () => false, emitTerminal: async () => undefined, signChallenge: () => 'signature',
} as const;
const request = (id: string, action: 'plan' | 'begin_apply' | 'complete', extra: Readonly<Record<string, unknown>> = {}) => ({ v: 1 as const, id, action, token: 'local-token', ...extra });
const body = (value: unknown): string => JSON.stringify(value);

describe('Flow agent bridge', () => {
  test('requires an approved, single-use application grant and replays an identical grant', async () => {
    const before = await processFlowAgentRequest(initialFlowAgentState(), request('before', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash }), body('before'), runtime);
    expect(before.response.code).toBe('PLAN_NOT_APPROVED');
    const approved = await processFlowAgentRequest(before.state, request('plan', 'plan', { plan }), body('plan'), runtime);
    expect(approved.response).toMatchObject({ decision: 'yes', plan_id: plan.plan_id });
    const grantRequest = request('grant', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash });
    const granted = await processFlowAgentRequest(approved.state, grantRequest, body('grant'), runtime);
    const replay = await processFlowAgentRequest(granted.state, grantRequest, body('grant'), runtime);
    expect(replay.response).toEqual(granted.response);
    const rejected = await processFlowAgentRequest(replay.state, request('wrong', 'complete', { plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: 'wrong', result: { summary: 'done', checks: ['bun test'] } }), body('wrong'), runtime);
    expect(rejected.response.code).toBe('APPLICATION_NOT_AUTHORIZED');
    const completed = await processFlowAgentRequest(rejected.state, request('complete', 'complete', { plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: granted.response.application_id, result: { summary: 'done', checks: ['bun test'] } }), body('complete'), runtime);
    expect(completed.response.outcome).toBe('succeeded');
    expect(completed.state.terminal).toBe(true);
  });
});

test('durable application grant is saved before it is emitted and survives reconnection', async () => {
  const saveState = (await import('bun:test')).mock(async (_state: import('../../src/ui/flowAgentBridge').FlowAgentState) => undefined);
  const approved = { ...initialFlowAgentState(), plan, approved: true };
  const granted = await processFlowAgentRequest(approved, request('apply-durable', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash }), 'apply-durable', {
    ...runtime, saveState,
    emitProgress: async () => { expect(saveState.mock.calls[0]?.[0].application_id).toBeString(); },
  });
  const restored = JSON.parse(JSON.stringify(saveState.mock.calls.at(-1)?.[0]));
  const duplicate = await processFlowAgentRequest(restored, request('apply-again', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash }), 'apply-again', runtime);
  expect(duplicate.response.code).toBe('APPLY_ALREADY_STARTED');
  expect(restored.application_id).toBe(granted.response.application_id);
});

test('checkpoint failure cannot grant apply', async () => {
  const emitProgress = (await import('bun:test')).mock(async () => undefined);
  await expect(processFlowAgentRequest({ ...initialFlowAgentState(), plan, approved: true }, request('apply', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash }), 'apply', {
    ...runtime, emitProgress, saveState: async () => { throw new Error('checkpoint unavailable'); },
  })).rejects.toThrow('checkpoint unavailable');
  expect(emitProgress).not.toHaveBeenCalled();
});

test('onboarding apply is terminal even when caller supplies another offer', async () => {
  const askContinuation = (await import('bun:test')).mock(async () => true);
  const completed = await processFlowAgentRequest({ ...initialFlowAgentState(), plan, approved: true, application_id: 'apply-1' }, request('done', 'complete', {
    plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: 'apply-1', result: { summary: 'Configured', checks: [] },
    next_offer: { goal_id: 'another', goal_name: 'Another', prompt: 'Continue?' },
  }), 'done', { ...runtime, askContinuation });
  expect(completed.state.terminal).toBe(true);
  expect(askContinuation).not.toHaveBeenCalled();
});

test('explicit closure preserves an unaccomplished goal as skipped', async () => {
  const emitTerminal = (await import('bun:test')).mock(async (_data: Readonly<Record<string, unknown>>) => undefined);
  const closed = await processFlowAgentRequest(initialFlowAgentState(), { v: 1, id: 'close', action: 'terminal', token: 'local-token', outcome: 'skipped', reason: 'User chose to finish without project configuration.' }, 'close', { ...runtime, emitTerminal });
  expect(closed.state.terminal).toBe(true);
  expect(closed.state.approved).toBe(false);
  expect(emitTerminal.mock.calls[0]?.[0].status).toBe('skipped');
});

test('status and history reads do not rewrite the durable checkpoint', async () => {
  const saveState = (await import('bun:test')).mock(async () => undefined);
  const state = initialFlowAgentState();
  for (const action of ['status', 'read'] as const) {
    const response = await processFlowAgentRequest(state, { v: 1, id: action, action, token: 'local-token' }, action, { ...runtime, saveState });
    expect(response.state).toBe(state);
  }
  expect(saveState).not.toHaveBeenCalled();
});

test('the emitted approval prompt is checkpointed before waiting for the answer', async () => {
  const saveState = (await import('bun:test')).mock(async (_state: import('../../src/ui/flowAgentBridge').FlowAgentState) => undefined);
  await processFlowAgentRequest(initialFlowAgentState(), request('prompt', 'plan', { plan }), 'prompt', {
    ...runtime, saveState,
    askPlanApproval: async (_goal, _plan, onPromptEmitted) => {
      expect(saveState).toHaveBeenCalledTimes(1);
      await onPromptEmitted?.();
      expect(saveState).toHaveBeenCalledTimes(2);
      expect(saveState.mock.calls[1]?.[0]).toMatchObject({ plan, approved: false });
      return true;
    },
  });
  expect(saveState.mock.calls.at(-1)?.[0].approved).toBe(true);
});
