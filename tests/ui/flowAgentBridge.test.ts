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
