/** Exercises the resumed CLI adapter through its encrypted bootstrap, checkpoint,
 * service lease transport, and public agent socket. */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { existsSync, unlinkSync } from 'node:fs';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'resume-user';
const ORG_ID = 'resume-org';
const ORIGIN = 'https://resume.fixture.test';
const REPO = 'sha256:resume-repository';
const RUNTIME = '22222222-2222-4222-8222-222222222222';
const ROOT = Buffer.alloc(32, 9);
const FLOW_DIRECTORY = '/tmp/capy-flow-resume-fixture';

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class { async detectProjectState(): Promise<Readonly<{ readonly initialized: false; readonly userId: string; readonly projectName: undefined; readonly activeBranch: null }>> { return { initialized: false, userId: USER_ID, projectName: undefined, activeBranch: null }; } },
}));
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent(): Promise<Readonly<{ readonly success: true; readonly user_id: string; readonly organization_id: string }>> { return { success: true, user_id: USER_ID, organization_id: ORG_ID }; }
    async getValidToken(): Promise<Readonly<{ readonly access_token: string; readonly user_id: string }>> { return { access_token: 'resume-token', user_id: USER_ID }; }
  },
}));
mock.module('../../src/config/globalConfig', () => ({ readLocalRoot: () => ROOT, getGlobalCapyDir: () => FLOW_DIRECTORY }));
mock.module('../../src/config/profileConfig', () => ({ resolveActiveUrl: () => ORIGIN }));
mock.module('../../src/auth/initRunIdentity', () => ({ resolveInitRunIdentity: () => ({ runtimeId: RUNTIME, repositoryFingerprint: REPO, repositoryRoot: '/fixture', machineName: 'fixture' }) }));
mock.module('../../src/ui/screens/keepScreens', () => ({ keepOrigin: () => 'https://keep.fixture.test' }));

import { runFlowAgentCommand } from '../../src/commands/flowAgentCommand';
import { flowAgentPlanHash, flowAgentSocketPath, type FlowAgentState } from '../../src/ui/flowAgentBridge';
import { runResumedFlowInteraction } from '../../src/ui/flowInteraction';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { openFlowRecoveryCheckpoint, saveFlowRecoveryBootstrap, sealFlowRecoveryCheckpoint, type FlowRecoveryBinding } from '../../src/ui/flowRecoveryStore';
import { mintPageKeypairPageSide } from '../helpers/sealEnvelope';

type Json = Readonly<Record<string, unknown>>;
const plan = (() => {
  const draft = { plan_id: 'resume-plan', plan_hash: '', summary: 'Apply recovered setup', files: [{ path: 'src/setup.ts', change: 'resume setup', reason: 'finish setup' }], checks: ['bun test'] } as const;
  return { ...draft, plan_hash: flowAgentPlanHash(draft) };
})();
const recoveredState: FlowAgentState = { goal: { goal_id: 'project_setup', goal_name: 'Project Setup' }, completedGoalIds: [], plan, approved: true, application_id: 'existing-application', terminal: false, replays: [] };
const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);
const response = (value: Json): Response => Response.json(value);
const invoke = async (body: Json): Promise<Json> => {
  const input = Readable.from([`${JSON.stringify(body)}\n`]);
  const output = new Promise<string>(resolve => {
    const writable = new Writable({ write: (chunk, _encoding, callback) => { resolve(chunk.toString()); callback(); } });
    void runFlowAgentCommand(input, writable, { flowId: FLOW_ID, devMode: false });
  });
  return JSON.parse(await output) as Json;
};
const waitForSocket = async (tries = 50): Promise<void> => {
  if (existsSync(flowAgentSocketPath(FLOW_ID))) return;
  if (tries === 0) throw new Error('FLOW_AGENT_SOCKET_NOT_READY');
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  return waitForSocket(tries - 1);
};
afterEach(() => {
  const path = flowAgentSocketPath(FLOW_ID);
  if (existsSync(path)) unlinkSync(path);
});
const collect = async (iterator: AsyncIterator<Json>, values: readonly Json[] = []): Promise<readonly Json[]> => {
  const next = await iterator.next();
  return next.done ? values : collect(iterator, [...values, next.value]);
};
const aborted = (signal: AbortSignal | null): Promise<never> => new Promise((_resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const checkpointJournal = (calls: readonly Json[], binding: FlowRecoveryBinding, journal: readonly Json[] = []): boolean => {
  const call = calls[0];
  if (!call) return true;
  if (call.route === 'checkpoint-write' && typeof call.envelope === 'string') {
    const opened = openFlowRecoveryCheckpoint(ROOT, binding, call.envelope);
    const saved = Array.isArray(opened?.journal) ? opened.journal.filter(entry => entry !== null && typeof entry === 'object') as readonly Json[] : [];
    return checkpointJournal(calls.slice(1), binding, saved);
  }
  if (call.route === 'append') {
    const covered = typeof call.id === 'string' && typeof call.envelope === 'string'
      && journal.some(entry => entry.id === call.id && entry.envelope === call.envelope);
    return covered && checkpointJournal(calls.slice(1), binding, journal);
  }
  return checkpointJournal(calls.slice(1), binding, journal);
};
type CheckpointStep = Readonly<{ readonly expected: string; readonly next: string }>;
type PersistedMessage = Readonly<{ readonly v: 1; readonly id: string; readonly correlation_id: string; readonly direction: 'cli_to_browser'; readonly type: 'output'; readonly envelope: string; readonly sequence: number }>;
const service = (binding: FlowRecoveryBinding, checkpoint: string, pagePubkey: string, checkpointSteps: readonly CheckpointStep[] = [], messages: readonly PersistedMessage[] = []): Readonly<{ readonly fetch: typeof globalThis.fetch; readonly observed: () => Promise<readonly Json[]> }> => {
  const callStream = new PassThrough({ objectMode: true });
  const callIterator = callStream[Symbol.asyncIterator]() as AsyncIterator<Json>;
  const checkpointIterator = Readable.from(checkpointSteps)[Symbol.asyncIterator]();
  const record = (body: Json): Json => ({ ...body, headers: {} });
  const history = (after = 0): Json => ({ flow_id: FLOW_ID, owner: USER_ID, runtime_id: RUNTIME, repo_fingerprint: REPO, client_pubkey: binding.client_pubkey, page_pubkey: pagePubkey, state: 'active', cursor: messages.length, messages: after === 0 ? messages : [], cli_attached: true });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Json : {};
    if (method === 'POST' && url.pathname === `/flows/${FLOW_ID}/resume`) return response({ ...history(), lease_id: 'lease-resumed', expires_at: '2030-01-01T00:00:00.000Z' });
    if (method === 'GET' && url.pathname === `/flows/${FLOW_ID}/messages`) {
      if (header(init, 'x-capy-cli-lease-id') && url.searchParams.get('wait_ms') !== '0') return aborted(init?.signal ?? null);
      if (header(init, 'x-capy-cli-lease-id')) callStream.write({ ...record(body), route: 'read', lease_id: header(init, 'x-capy-cli-lease-id') });
      return response(history(Number(url.searchParams.get('after') ?? '0')));
    }
    if (method === 'GET' && url.pathname === `/flows/${FLOW_ID}/checkpoint`) {
      callStream.write({ route: 'checkpoint-read', lease_id: header(init, 'x-capy-cli-lease-id') });
      return response({ flow_id: FLOW_ID, runtime_id: RUNTIME, repo_fingerprint: REPO, client_pubkey: binding.client_pubkey, revision: 'r1', envelope: checkpoint });
    }
    if (method === 'POST' && url.pathname === `/flows/${FLOW_ID}/checkpoint`) {
      callStream.write({ ...record(body), route: 'checkpoint-write' });
      const step = await checkpointIterator.next();
      if (checkpointSteps.length === 0) return response({ flow_id: FLOW_ID, runtime_id: RUNTIME, repo_fingerprint: REPO, client_pubkey: binding.client_pubkey, revision: 'r-free' });
      if (step.done || body.revision !== step.value.expected || body.lease_id !== 'lease-resumed') return Response.json({ code: 'CONVERSATION_CHECKPOINT_CONFLICT' }, { status: 409 });
      return response({ flow_id: FLOW_ID, runtime_id: RUNTIME, repo_fingerprint: REPO, client_pubkey: binding.client_pubkey, revision: step.value.next });
    }
    if (method === 'POST' && url.pathname === `/flows/${FLOW_ID}/messages`) {
      callStream.write({ ...record(body), route: 'append' });
      return response({ ok: true });
    }
    return response({ code: 'UNEXPECTED' });
  };
  return { fetch, observed: async () => { callStream.end(); return collect(callIterator); } };
};

describe('resumed Flow adapter integration', () => {
  test('restores an applying checkpoint without a second grant and completes on the same fenced flow', async () => {
    const keys = mintConnectionKeypair();
    const binding: FlowRecoveryBinding = { flow_id: FLOW_ID, runtime_id: RUNTIME, origin: ORIGIN, owner_id: USER_ID, organization_id: ORG_ID, repo_fingerprint: REPO, client_pubkey: keys.publicKeyB64 };
    saveFlowRecoveryBootstrap(ROOT, binding, keys);
    const checkpoint = sealFlowRecoveryCheckpoint(ROOT, binding, { v: 1, phase: 'agent', agent_state: recoveredState, journal: [] });
    const page = await mintPageKeypairPageSide();
    const fixture = service(binding, checkpoint, page.pagePubkeyB64);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const running = runResumedFlowInteraction(FLOW_ID, false);
      await waitForSocket();
      const status = await invoke({ v: 1, id: 'status', action: 'status' });
      expect(status).toMatchObject({ ok: true, state: 'applying', application_id: 'existing-application' });
      const read = await invoke({ v: 1, id: 'read', action: 'read' });
      expect(read).toMatchObject({ ok: true, flow_id: FLOW_ID, history: [] });
      const duplicate = await invoke({ v: 1, id: 'grant-again', action: 'begin_apply', plan_id: plan.plan_id, plan_hash: plan.plan_hash });
      expect(duplicate).toMatchObject({ ok: false, code: 'APPLY_ALREADY_STARTED' });
      const complete = await invoke({ v: 1, id: 'complete', action: 'complete', plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: 'existing-application', result: { summary: 'Recovered apply completed', checks: ['bun test'] } });
      expect(complete).toMatchObject({ ok: true, outcome: 'succeeded' });
      await running;
      const calls = await fixture.observed();
      expect(calls.filter(call => call.route === 'append').some(call => call.type === 'goal')).toBe(true);
      expect(calls.filter(call => call.route === 'checkpoint-write').every(call => call.lease_id === 'lease-resumed')).toBe(true);
      expect(calls.filter(call => call.route === 'append').every(call => call.lease_id === 'lease-resumed')).toBe(true);
      expect(calls.some(call => call.route === 'checkpoint-read' && call.lease_id === 'lease-resumed')).toBe(true);
    } finally { stdout.mockRestore(); fetchSpy.mockRestore(); }
  });

  test('reconstructs a journal-backed approved checkpoint and advances fenced CAS before completion', async () => {
    const keys = mintConnectionKeypair();
    const binding: FlowRecoveryBinding = { flow_id: FLOW_ID, runtime_id: RUNTIME, origin: ORIGIN, owner_id: USER_ID, organization_id: ORG_ID, repo_fingerprint: REPO, client_pubkey: keys.publicKeyB64 };
    saveFlowRecoveryBootstrap(ROOT, binding, keys);
    const journal = [{ id: 'prior-output', type: 'output', data: { message: 'Already inspected' }, envelope: 'opaque-history-record' }] as const;
    const approved: FlowAgentState = { ...recoveredState, application_id: null };
    const checkpoint = sealFlowRecoveryCheckpoint(ROOT, binding, { v: 1, phase: 'agent', agent_state: approved, journal });
    const page = await mintPageKeypairPageSide();
    const fixture = service(binding, checkpoint, page.pagePubkeyB64, [
      { expected: 'r1', next: 'r2' }, { expected: 'r2', next: 'r3' }, { expected: 'r3', next: 'r4' },
      { expected: 'r4', next: 'r5' }, { expected: 'r5', next: 'r6' }, { expected: 'r6', next: 'r7' },
    ], [{ v: 1, id: 'prior-output', correlation_id: 'prior-output', direction: 'cli_to_browser', type: 'output', envelope: 'opaque-history-record', sequence: 1 }]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const running = runResumedFlowInteraction(FLOW_ID, false);
      await waitForSocket();
      const read = await invoke({ v: 1, id: 'read-history', action: 'read' });
      expect(read).toMatchObject({ ok: true, history: [{ id: 'prior-output', type: 'output', data: { message: 'Already inspected' } }] });
      const grant = await invoke({ v: 1, id: 'grant', action: 'begin_apply', plan_id: plan.plan_id, plan_hash: plan.plan_hash });
      expect(grant).toMatchObject({ ok: true, authorization: 'granted' });
      const applicationId = grant.application_id as string;
      const complete = await invoke({ v: 1, id: 'complete-approved', action: 'complete', plan_id: plan.plan_id, plan_hash: plan.plan_hash, application_id: applicationId, result: { summary: 'Approved apply completed', checks: ['bun test'] } });
      expect(complete).toMatchObject({ ok: true, outcome: 'succeeded' });
      await running;
      const calls = await fixture.observed();
      expect(calls.filter(call => call.route === 'checkpoint-write').map(call => call.revision)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
      expect(calls.filter(call => call.route === 'checkpoint-write').every(call => call.lease_id === 'lease-resumed')).toBe(true);
      expect(checkpointJournal(calls, binding)).toBe(true);
      expect(calls.find(call => call.route === 'append' && call.type === 'goal')?.outcome).toBe('succeeded');
    } finally { stdout.mockRestore(); fetchSpy.mockRestore(); }
  });
});
