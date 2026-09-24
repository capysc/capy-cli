/**
 * ISOLATED (mock.module): drives the real Flow adapter, encrypted browser
 * envelopes, local attachment socket, and flow-agent command as one chain.
 * Authentication, project discovery, and the conversation service are the
 * only synthetic prerequisites; no account, provider, or key store is used.
 */
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { mintPageKeypairPageSide, openRequestEnvelopePageSide, sealEnvelopePageSide } from '../helpers/sealEnvelope';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-flow-agent';
const ORG_ID = 'org-flow-agent';
const ACCESS_TOKEN = 'synthetic-flow-agent-token';
const REPOSITORY_FINGERPRINT = 'sha256:synthetic-flow-agent-repository';
const SERVICE_ORIGIN = 'https://flow.fixture.test';

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class {
    async detectProjectState(): Promise<Readonly<{ readonly initialized: false; readonly userId: string }>> {
      return { initialized: false, userId: USER_ID };
    }
  },
}));
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent(): Promise<Readonly<{ readonly success: true; readonly user_id: string; readonly organization_id: string }>> {
      return { success: true, user_id: USER_ID, organization_id: ORG_ID };
    }

    async getValidToken(): Promise<Readonly<{ readonly access_token: string; readonly user_id: string }>> {
      return { access_token: ACCESS_TOKEN, user_id: USER_ID };
    }
  },
}));
mock.module('../../src/config/globalConfig', () => ({ readLocalRoot: () => Buffer.alloc(32, 7) }));
mock.module('../../src/config/profileConfig', () => ({ resolveActiveUrl: () => SERVICE_ORIGIN }));
mock.module('../../src/auth/initRunIdentity', () => ({
  resolveInitRunIdentity: () => ({
    runtimeId: '22222222-2222-4222-8222-222222222222',
    repositoryFingerprint: REPOSITORY_FINGERPRINT,
    repositoryRoot: '/synthetic/flow-agent-repository',
    machineName: 'flow-agent-fixture',
  }),
}));
mock.module('../../src/ui/screens/keepScreens', () => ({ keepOrigin: () => 'https://keep.fixture.test' }));

import { runFlowAgentCommand } from '../../src/commands/flowAgentCommand';
import { emitInteractionGoal } from '../../src/ui/interaction';
import { runWithFlowInteraction } from '../../src/ui/flowInteraction';

type Json = Readonly<Record<string, unknown>>;
type ServiceMessage = Readonly<{
  readonly v: 1;
  readonly id: string;
  readonly correlation_id: string;
  readonly direction: 'browser_to_cli';
  readonly type: 'answer';
  readonly envelope: string;
  readonly sequence: number;
}>;
type ObservedWrite = Readonly<{ readonly body: Json; readonly plaintext: Json }>;

const collect = async <T>(iterator: AsyncIterator<T>, items: readonly T[] = []): Promise<readonly T[]> => {
  const next = await iterator.next();
  return next.done ? items : collect(iterator, [...items, next.value]);
};
const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);
const responseJson = (value: Json): Response => Response.json(value);
const answerMessage = async (
  clientPubkeyB64: string,
  pagePrivateKey: CryptoKey,
  correlationId: string,
  value: boolean,
): Promise<ServiceMessage> => {
  const id = randomUUID();
  const payload = { v: 1, flow_id: FLOW_ID, id, correlation_id: correlationId, type: 'answer', data: { value } } as const;
  return {
    v: 1,
    id,
    correlation_id: correlationId,
    direction: 'browser_to_cli',
    type: 'answer',
    envelope: await sealEnvelopePageSide({ plaintext: JSON.stringify(payload), connectionId: `${FLOW_ID}:${id}`, clientPubkeyB64 }),
    sequence: 1,
  };
};
const waitForBrowserMessage = async (
  iterator: AsyncIterator<ServiceMessage>,
  signal: AbortSignal | null,
): Promise<IteratorResult<ServiceMessage>> => {
  if (signal?.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal?.reason ?? new Error('fixture request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    void iterator.next().then(
      next => { signal?.removeEventListener('abort', abort); resolve(next); },
      error => { signal?.removeEventListener('abort', abort); reject(error); },
    );
  });
};

const fixtureService = async (): Promise<Readonly<{
  readonly fetch: typeof globalThis.fetch;
  readonly goalStarted: Promise<void>;
  readonly observed: () => Promise<readonly ObservedWrite[]>;
}>> => fixtureServiceWithAnswers([true, true]);

const fixtureServiceWithAnswers = async (answers: readonly boolean[]): Promise<Readonly<{
  readonly fetch: typeof globalThis.fetch;
  readonly goalStarted: Promise<void>;
  readonly observed: () => Promise<readonly ObservedWrite[]>;
}>> => {
  const page = await mintPageKeypairPageSide();
  const browserMessages = new PassThrough({ objectMode: true });
  const browserIterator = browserMessages[Symbol.asyncIterator]() as AsyncIterator<ServiceMessage>;
  const writes = new PassThrough({ objectMode: true });
  const writeIterator = writes[Symbol.asyncIterator]() as AsyncIterator<ObservedWrite>;
  const creations = new PassThrough({ objectMode: true });
  const creationIterator = creations[Symbol.asyncIterator]() as AsyncIterator<Json>;
  const creation = creationIterator.next().then(next => next.value);
  const client = creation.then(value => value.client_pubkey as string);
  const answerValues = Readable.from(answers)[Symbol.asyncIterator]();
  const goalSignals = new PassThrough({ objectMode: true });
  const goalStarted = goalSignals[Symbol.asyncIterator]().next().then(() => undefined);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Json : {};
    if (method === 'POST' && url.pathname === '/flows/conversation') {
      const clientPubkey = body.client_pubkey;
      if (typeof clientPubkey !== 'string') return Response.json({ code: 'INVALID_CLIENT_KEY' }, { status: 400 });
      creations.write(body);
      return responseJson({ flow_id: FLOW_ID, client_pubkey: clientPubkey });
    }
    if (method === 'GET' && url.pathname === `/flows/${FLOW_ID}/messages`) {
      if (!header(init, 'x-capy-cli-attached-at')) return responseJson({
        flow_id: FLOW_ID, owner: USER_ID, runtime_id: (await creation).runtime_id, repo_fingerprint: REPOSITORY_FINGERPRINT,
        client_pubkey: await client, page_pubkey: page.pagePubkeyB64, state: 'active', cursor: 0, messages: [],
      });
      if (url.searchParams.get('after_page_pubkey') === 'null') return responseJson({
        flow_id: FLOW_ID, owner: USER_ID, runtime_id: (await creation).runtime_id, repo_fingerprint: REPOSITORY_FINGERPRINT,
        client_pubkey: await client, page_pubkey: page.pagePubkeyB64, state: 'active', cursor: 0, messages: [],
      });
      if (url.searchParams.get('wait_ms') === '0') return responseJson({
        flow_id: FLOW_ID, owner: USER_ID, runtime_id: (await creation).runtime_id, repo_fingerprint: REPOSITORY_FINGERPRINT,
        client_pubkey: await client, page_pubkey: page.pagePubkeyB64, state: 'active', cursor: 0, messages: [],
      });
      const next = await waitForBrowserMessage(browserIterator, init?.signal ?? null);
      return responseJson({
        flow_id: FLOW_ID, owner: USER_ID, runtime_id: (await creation).runtime_id, repo_fingerprint: REPOSITORY_FINGERPRINT,
        client_pubkey: await client, page_pubkey: page.pagePubkeyB64, state: 'active', cursor: next.done ? 0 : 1, messages: next.done ? [] : [next.value],
      });
    }
    if (method === 'POST' && url.pathname === `/flows/${FLOW_ID}/messages`) {
      const clientPubkey = await client;
      const encrypted = body.envelope;
      const id = body.id;
      if (typeof encrypted !== 'string' || typeof id !== 'string' || typeof body.correlation_id !== 'string') return Response.json({ code: 'INVALID_MESSAGE' }, { status: 400 });
      const plaintext = await openRequestEnvelopePageSide({ ciphertextB64: encrypted, connectionId: `${FLOW_ID}:${id}`, clientPubkeyB64: clientPubkey, pagePrivateKey: page.privateKey });
      const parsed = JSON.parse(plaintext) as Json;
      writes.write({ body, plaintext: parsed } satisfies ObservedWrite);
      const data = parsed.data as Json;
      if (parsed.type === 'progress' && data.kind === 'goal_start') goalSignals.write(undefined);
      if (parsed.type === 'prompt') {
        const nextAnswer = await answerValues.next();
        browserMessages.write(await answerMessage(clientPubkey, page.privateKey, body.correlation_id, nextAnswer.done ? true : nextAnswer.value));
      }
      return responseJson({ ok: true });
    }
    if (method === 'POST' && url.pathname === `/flows/${FLOW_ID}/detach`) return responseJson({ ok: true });
    return Response.json({ code: 'UNEXPECTED_FIXTURE_REQUEST' }, { status: 404 });
  };
  return { fetch, goalStarted, observed: async () => { writes.end(); return collect(writeIterator); } };
};

const invokeAgent = async (request: Json): Promise<Json> => {
  const input = Readable.from([`${JSON.stringify(request)}\n`]);
  const response = new Promise<string>(resolve => {
    const output = new Writable({ write: (chunk, _encoding, callback) => { resolve(chunk.toString()); callback(); } });
    void runFlowAgentCommand(input, output, { flowId: FLOW_ID, devMode: false });
  });
  const line = await response;
  return JSON.parse(line) as Json;
};
const handoff = async (iterator: AsyncIterator<string>): Promise<Json> => {
  const next = await iterator.next();
  if (next.done) throw new Error('flow ended before the agent handoff');
  const candidate = JSON.parse(next.value) as Json;
  return candidate.type === 'agent_handoff' ? candidate : handoff(iterator);
};

describe('Flow agent handoff integration', () => {
  test('keeps root and continuation turns encrypted while an authenticated agent completes an approved plan', async () => {
    const service = await fixtureService();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(service.fetch);
    const publicOutput = new PassThrough();
    const publicLines = publicOutput[Symbol.asyncIterator]() as AsyncIterator<string>;
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      publicOutput.write(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      const flow = runWithFlowInteraction(async () => {
        await emitInteractionGoal({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'succeeded', result: { encrypted: true } });
      }, false);
      const publicHandoff = await handoff(publicLines);
      expect(publicHandoff).toMatchObject({ ok: true, type: 'agent_handoff', flow_id: FLOW_ID, attachment: { command: 'capy', args: ['flow', '--id', FLOW_ID, '--json'] } });

      const analysis = await invokeAgent({ v: 1, id: 'analysis-1', action: 'analysis', analysis: { summary: 'Repository inspected', findings: ['package.json is present'] } });
      expect(analysis).toMatchObject({ ok: true, accepted: 'analysis' });
      const plan = await invokeAgent({ v: 1, id: 'plan-1', action: 'plan', plan: { plan_id: 'plan-1', summary: 'Configure project setup', files: [{ path: 'package.json', change: 'add setup command', reason: 'configure the project' }], checks: ['bun test'] } });
      expect(plan).toMatchObject({ ok: true, decision: 'yes', plan_id: 'plan-1' });
      const planHash = plan.plan_hash;
      expect(typeof planHash).toBe('string');
      const apply = await invokeAgent({ v: 1, id: 'apply-1', action: 'begin_apply', plan_id: 'plan-1', plan_hash: planHash });
      expect(apply).toMatchObject({ ok: true, authorization: 'granted' });
      const applicationId = apply.application_id;
      expect(typeof applicationId).toBe('string');
      const complete = await invokeAgent({ v: 1, id: 'complete-1', action: 'complete', plan_id: 'plan-1', plan_hash: planHash, application_id: applicationId, result: { summary: 'Project setup applied', checks: ['bun test'] } });
      expect(complete).toMatchObject({ ok: true, outcome: 'succeeded' });
      await flow;

      const writes = await service.observed();
      const payloads = writes.map(write => write.plaintext);
      const encryptedRoot = writes.find(write => write.plaintext.type === 'goal_completed');
      const agentStart = payloads.findIndex(payload => payload.type === 'progress' && (payload.data as Json).kind === 'goal_start');
      const terminal = payloads.findIndex(payload => payload.type === 'goal');
      expect(encryptedRoot).toMatchObject({ plaintext: { data: { type: 'turn', goal_id: 'secrets_setup', outcome: { status: 'succeeded', result: { encrypted: true } } } } });
      expect(encryptedRoot?.body.envelope).not.toContain('secrets_setup');
      expect(agentStart).toBeGreaterThan(-1);
      expect(terminal).toBeGreaterThan(agentStart);
      expect(payloads.filter(payload => payload.type === 'goal')).toHaveLength(1);
      expect(payloads.find(payload => payload.type === 'goal')).toMatchObject({ data: { type: 'turn', outcome: { goal_id: 'project_setup', status: 'succeeded' } } });
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('agent_handoff');
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('encrypts a declined continuation and leaves the project agent unattached', async () => {
    const service = await fixtureServiceWithAnswers([false]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(service.fetch);
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runWithFlowInteraction(async () => {
        await emitInteractionGoal({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'succeeded', result: { encrypted: true } });
      }, false);
      const writes = await service.observed();
      const payloads = writes.map(write => write.plaintext);
      expect(writes.find(write => write.plaintext.type === 'goal_completed')).toMatchObject({
        plaintext: { data: { type: 'turn', goal_id: 'secrets_setup', outcome: { status: 'succeeded', result: { encrypted: true } } } },
      });
      expect(payloads.some(payload => payload.type === 'progress' && (payload.data as Json).kind === 'goal_start')).toBe(false);
      expect(payloads.filter(payload => payload.type === 'goal')).toHaveLength(1);
      expect(payloads.find(payload => payload.type === 'goal')).toMatchObject({
        data: { type: 'turn', outcome: { goal_id: 'secrets_setup', status: 'succeeded', result: { continuation_declined: true } } },
      });
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('keeps a skipped root goal as the single encrypted terminal outcome', async () => {
    const service = await fixtureServiceWithAnswers([]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(service.fetch);
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    try {
      await runWithFlowInteraction(async () => {
        await emitInteractionGoal({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'skipped', code: 'SETUP_SKIPPED' });
      }, false);
      const writes = await service.observed();
      const payloads = writes.map(write => write.plaintext);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        plaintext: { type: 'goal', data: { type: 'turn', outcome: { goal: 'repository_onboarded', status: 'skipped', code: 'SETUP_SKIPPED' } } },
      });
      expect(writes[0]?.body.envelope).not.toContain('repository_onboarded');
      expect(payloads.some(payload => payload.type === 'goal_completed' || payload.type === 'prompt')).toBe(false);
      expect(payloads.some(payload => payload.type === 'progress' && (payload.data as Json).kind === 'goal_start')).toBe(false);
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
  });
  test('delivers a thrown command failure as an encrypted terminal goal before detaching', async () => {
    const service = await fixtureServiceWithAnswers([]);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(service.fetch);
    const stdout = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const failure = new Error('The repository organization is no longer accessible.');
    try {
      await expect(runWithFlowInteraction(async () => { throw failure; }, false)).rejects.toBe(failure);
      const writes = await service.observed();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        plaintext: { type: 'goal', data: { outcome: {
          status: 'failed', code: 'COMMAND_FAILED', message: failure.message,
        } } },
      });
      expect(writes[0]?.body.envelope).not.toContain(failure.message);
    } finally {
      stdout.mockRestore();
      fetchSpy.mockRestore();
    }
  });

});
