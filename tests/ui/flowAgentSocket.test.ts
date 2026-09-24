import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'bun:test';
import { attachFlowAgentRuntime, flowAgentPlanHash, type FlowAgentPlan } from '../../src/ui/flowAgentBridge';

type Json = Readonly<Record<string, unknown>>;
const socketPath = (): string => `${process.cwd()}/.flow-agent-${randomUUID()}.sock`;
const unixSocketsAvailable = await new Promise<boolean>(resolve => {
  const path = socketPath();
  const server = createServer();
  server.listen(path, () => server.close(() => {
    if (existsSync(path)) unlinkSync(path);
    resolve(true);
  }));
  server.once('error', () => resolve(false));
});
const socketTest = unixSocketsAvailable ? test : test.skip;
const planInput = (id: string): FlowAgentPlan => {
  const draft = { plan_id: id, plan_hash: '', summary: 'Configure the repository', files: [{ path: 'src/setup.ts', change: 'add setup', reason: 'configure the project' }], checks: ['bun test'] } as const;
  return { ...draft, plan_hash: flowAgentPlanHash(draft) };
};
const read = async (iterator: AsyncIterator<string>, count: number, values: readonly Json[] = []): Promise<readonly Json[]> => {
  if (values.length === count) return values;
  const next = await iterator.next();
  if (next.done) throw new Error('socket closed before a response');
  return read(iterator, count, [...values, JSON.parse(next.value) as Json]);
};
const exchange = async (path: string, requests: readonly Json[]): Promise<readonly Json[]> => new Promise((resolve, reject) => {
  const socket = createConnection(path);
  socket.once('error', reject);
  socket.once('connect', () => {
    const responses = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
    void read(responses, requests.length).then(values => {
      socket.end();
      resolve(values);
    }).catch(reject);
    requests.forEach(request => socket.write(`${JSON.stringify(request)}\n`));
  });
});
const events = (): Readonly<{ readonly stream: PassThrough; readonly collect: () => Promise<readonly Json[]> }> => {
  const stream = new PassThrough({ objectMode: true });
  const iterator = stream[Symbol.asyncIterator]();
  const collect = async (items: readonly Json[] = []): Promise<readonly Json[]> => {
    const next = await iterator.next();
    return next.done ? items : collect([...items, next.value as Json]);
  };
  return { stream, collect: () => collect() };
};
const runtimeInput = (flowId: string, eventStream: PassThrough, approved: boolean, continued: boolean) => ({
  flowId, ownerId: 'user-1', authenticate: async (token: string) => token === 'good-token', readHistory: async () => [{ type: 'persisted' }],
  emitOutput: async (data: Json) => { eventStream.write({ type: 'output', ...data }); },
  emitProgress: async (data: Json) => { eventStream.write({ type: 'progress', ...data }); },
  emitCompleted: async (goal: Json, result?: Json) => { eventStream.write({ type: 'completed', ...goal, result: result ?? {} }); },
  askPlanApproval: async () => approved,
  askContinuation: async () => continued,
  emitTerminal: async (data: Json) => { eventStream.write({ type: 'terminal', ...data }); },
  signChallenge: (nonce: string) => `signature:${flowId}:${nonce}`,
});
const request = (id: string, action: string, data: Json = {}, token: string = 'good-token'): Json => ({ v: 1, id, action, token, ...data });

describe('Flow agent Unix-socket bridge', () => {
  socketTest('authenticates a challenge and preserves state across pipelined and sequential attachments', async () => {
    const path = socketPath();
    const emitted = events();
    const runtime = await attachFlowAgentRuntime({ ...runtimeInput('flow-socket', emitted.stream, true, true), socketPath: path });
    const nonce = randomUUID();
    const initial = await exchange(path, [
      { v: 1, action: 'challenge', flow_id: 'flow-socket', nonce },
      request('bad', 'status', {}, 'bad-token'),
      request('status', 'status'),
    ]);
    expect(initial).toMatchObject([
      { ok: true, flow_id: 'flow-socket', nonce, signature: `signature:flow-socket:${nonce}` },
      { ok: false, code: 'FLOW_ATTACHMENT_FORBIDDEN' },
      { ok: true, state: 'awaiting_approval' },
    ]);
    const analysis = await exchange(path, [request('analysis', 'analysis', { analysis: { summary: 'Inspected the repository', findings: ['One setup file is needed'] } })]);
    expect(analysis[0]).toMatchObject({ ok: true, accepted: 'analysis' });
    const plan = planInput('plan-socket');
    const approval = await exchange(path, [request('plan', 'plan', { plan })]);
    expect(approval[0]).toMatchObject({ decision: 'yes', plan_hash: plan.plan_hash });
    const grant = request('grant', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash });
    const grants = await exchange(path, [grant, grant]);
    expect(grants[0]).toEqual(grants[1]);
    const applicationId = grants[0].application_id;
    const completion = await exchange(path, [request('complete', 'complete', { plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: applicationId, result: { summary: 'Applied setup', checks: ['bun test'] } })]);
    expect(completion[0]).toMatchObject({ outcome: 'succeeded' });
    await runtime.finished;
    emitted.stream.end();
    const all = await emitted.collect();
    expect(all.some(event => event.kind === 'analysis')).toBe(true);
    expect(all.filter(event => event.kind === 'apply_started')).toHaveLength(1);
    expect(all.find(event => event.type === 'terminal')).toMatchObject({ status: 'succeeded' });
  });

  socketTest('declining a plan closes without starting another goal', async () => {
    const path = socketPath();
    const emitted = events();
    const runtime = await attachFlowAgentRuntime({ ...runtimeInput('flow-decline', emitted.stream, false, true), socketPath: path });
    const plan = planInput('plan-decline');
    const response = await exchange(path, [request('plan', 'plan', { plan })]);
    expect(response[0]).toMatchObject({ decision: 'no' });
    await runtime.finished;
    emitted.stream.end();
    const all = await emitted.collect();
    expect(all.some(event => event.kind === 'goal_start')).toBe(false);
    expect(all.find(event => event.type === 'terminal')).toMatchObject({ status: 'cancelled', code: 'PLAN_DECLINED' });
  });

  socketTest('starts an explicit dynamic next goal, then accepts a terminal cancellation', async () => {
    const path = socketPath();
    const emitted = events();
    const runtime = await attachFlowAgentRuntime({ ...runtimeInput('flow-next', emitted.stream, true, true), socketPath: path });
    const plan = planInput('plan-next');
    await exchange(path, [request('plan', 'plan', { plan })]);
    const grant = await exchange(path, [request('grant', 'begin_apply', { plan_id: plan.plan_id, plan_hash: plan.plan_hash })]);
    await exchange(path, [request('complete', 'complete', { plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: grant[0].application_id, result: { summary: 'Project setup complete', checks: ['bun test'] }, next_offer: { goal_id: 'deploy_setup', goal_name: 'Deploy Setup', prompt: 'Continue with deploy setup?' } })]);
    const cancelled = await exchange(path, [request('cancel', 'terminal', { outcome: 'cancelled', code: 'AGENT_STOPPED' })]);
    expect(cancelled[0]).toMatchObject({ outcome: 'cancelled' });
    await runtime.finished;
    emitted.stream.end();
    const all = await emitted.collect();
    expect(all.find(event => event.kind === 'goal_start')).toMatchObject({ goal_id: 'deploy_setup', goal_name: 'Deploy Setup' });
    expect(all.find(event => event.type === 'terminal')).toMatchObject({ status: 'cancelled', code: 'AGENT_STOPPED' });
  });

  socketTest('resolves a runtime closed while idle', async () => {
    const path = socketPath();
    const emitted = events();
    const runtime = await attachFlowAgentRuntime({ ...runtimeInput('flow-idle', emitted.stream, true, true), socketPath: path });
    await runtime.close();
    await runtime.finished;
    emitted.stream.end();
    expect(await emitted.collect()).toEqual([]);
  });
});
