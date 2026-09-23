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

describe('Flow command failure delivery', () => {
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
