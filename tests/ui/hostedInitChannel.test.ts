import { expect, mock, test } from 'bun:test';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { BrokerConnection } from '../../src/service/brokerClient';
import { askHostedInitChannel, openHostedInitChannel, type HostedInitChannel } from '../../src/ui/hostedInitChannel';
import { type InitRunBinding, type InitWizardFrame } from '../../src/auth/initRunContract';

const binding: InitRunBinding = {
  run_id: '11111111-1111-4111-8111-111111111111', subject_user_id: 'user_demo',
  service_origin: 'https://api.dev.example', runtime_id: '77777777-7777-4777-8777-777777777777',
  repository_fingerprint: `sha256:${'a'.repeat(64)}`, cli_key_fingerprint: `sha256:${'b'.repeat(64)}`,
};
const now = Date.parse('2026-09-10T05:00:00.000Z');
const connection = (id: number): BrokerConnection => ({
  connectionId: `${String(id).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900000).toISOString(), keypair: mintConnectionKeypair(),
});
const reply = (input: Readonly<{ sequence?: number; subject?: string; cancel?: boolean }> = {}) => ({
  kind: 'answered' as const, plaintext: JSON.stringify({
    v: 1, flow: 'init-wizard', binding: { ...binding, subject_user_id: input.subject ?? binding.subject_user_id },
    sequence: input.sequence ?? 0, attempt_id: 'attempt_1',
    ...(input.cancel ? { kind: 'cancel' } : { kind: 'answer', answer: { organizationId: 'org_beta' } }),
  }),
});
const harness = () => {
  const connections = [connection(1), connection(2), connection(3), connection(4)] as const;
  const createConnection = mock(async () => connections[0])
    .mockImplementationOnce(async () => connections[0])
    .mockImplementationOnce(async () => connections[1])
    .mockImplementationOnce(async () => connections[2])
    .mockImplementationOnce(async () => connections[3]);
  const pollExchange = mock(async () => ({ kind: 'pending' as const, pagePubkeyB64: 'synthetic-page-key' }));
  const pollAnswer = mock(async () => reply());
  const sendRequest = mock(async (_connection: BrokerConnection, _key: string, _plaintext: string) => ({ kind: 'sent' as const }));
  const cancel = mock(async (_id: string) => undefined);
  const publish = mock(async (_id: string) => undefined);
  const broker = { createConnection, pollExchange, pollAnswer, sendRequest, cancel };
  return { broker, connections, publish, open: () => openHostedInitChannel({ broker, binding, deadline: now + 7200000, now: () => now, attemptId: () => 'attempt_1', pause: async () => undefined, publish }) };
};
const data = { nonce: '', step: 'organization', orgs: [{ id: 'org_beta', name: 'Beta' }], stops: [{ id: 'organization', state: 'current' }] } as const;
const decoded = <T = typeof data>(call: readonly unknown[]): InitWizardFrame<T> => JSON.parse(call[2] as string);

test('publishes C0 once; progress is confirmed before an accepted answer releases work', async () => {
  const h = harness();
  const channel = await h.open();
  const result = await askHostedInitChannel({ channel, screen: 'init-wizard', data, decide: payload => ({ value: payload.organizationId }) });
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.publish).toHaveBeenCalledWith(h.connections[0].connectionId);
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(2);
  expect(decoded(h.broker.sendRequest.mock.calls[0])).toMatchObject({ kind: 'view', sequence: 0, next_connection_id: h.connections[1].connectionId });
  expect(decoded(h.broker.sendRequest.mock.calls[1])).toMatchObject({ kind: 'progress', sequence: 1, next_connection_id: h.connections[2].connectionId });
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error('Expected accepted answer');
  expect(result.value).toBe('org_beta');
  expect(result.channel.current.connectionId).toBe(h.connections[2].connectionId);
  expect(result.channel.sequence).toBe(2);
  // No destructive progress-ack collection can gate the accepted operation.
  expect(h.broker.pollAnswer).toHaveBeenCalledTimes(1);
  expect(channel.current.connectionId).toBe(h.connections[0].connectionId);
});

test('a CLI-rejected answer retains all choices and consumes a fresh successor', async () => {
  const h = harness();
  h.broker.pollAnswer.mockImplementationOnce(async () => reply()).mockImplementationOnce(async () => reply({ sequence: 1 }));
  const decide = mock((_payload: Readonly<Record<string, unknown>>): Readonly<{ error: string }> | Readonly<{ value: string }> => ({ value: 'org_beta' }))
    .mockImplementationOnce(() => ({ error: 'That organization is not one this session can reach.' }));
  const result = await askHostedInitChannel({ channel: await h.open(), screen: 'init-wizard', data, decide });
  expect(result.kind).toBe('accepted');
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(3);
  expect(decoded(h.broker.sendRequest.mock.calls[1])).toMatchObject({ kind: 'view', sequence: 1, data: { ...data, rejected: 'That organization is not one this session can reach.' } });
  expect(decoded(h.broker.sendRequest.mock.calls[2]).kind).toBe('progress');
});

test('lost progress-send response never releases the accepted value or retries it', async () => {
  const h = harness();
  const sendRequest = mock(async (): Promise<Readonly<{ kind: 'network' | 'sent' }>> => ({ kind: 'network' }))
    .mockImplementationOnce(async () => ({ kind: 'sent' as const }));
  const channel: HostedInitChannel = { ...await h.open(), broker: { ...h.broker, sendRequest } };
  const operation = mock(async () => undefined);
  const run = async () => {
    const result = await askHostedInitChannel({ channel, screen: 'init-wizard', data, decide: () => ({ value: true }) });
    if (result.kind === 'accepted') await operation();
  };
  await expect(run()).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
  expect(sendRequest).toHaveBeenCalledTimes(2);
  expect(operation).not.toHaveBeenCalled();
});

test('lost destructive answer result fails without retrying or invoking its validator', async () => {
  const h = harness();
  const pollAnswer = mock(async () => ({ kind: 'network' as const }));
  const channel: HostedInitChannel = { ...await h.open(), broker: { ...h.broker, pollAnswer } };
  const decide = mock(() => ({ value: true }));
  await expect(askHostedInitChannel({ channel, screen: 'init-wizard', data, decide })).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
  expect(pollAnswer).toHaveBeenCalledTimes(1);
  expect(decide).not.toHaveBeenCalled();
});

test('wrong subject and stale sequence are refused before validation', async () => {
  for (const bad of [reply({ subject: 'user_other' }), reply({ sequence: 99 })]) {
    const h = harness();
    h.broker.pollAnswer.mockImplementationOnce(async () => bad);
    const decide = mock(() => ({ value: true }));
    await expect(askHostedInitChannel({ channel: await h.open(), screen: 'init-wizard', data, decide })).rejects.toMatchObject({ code: 'INIT_BINDING_MISMATCH' });
    expect(decide).not.toHaveBeenCalled();
  }
});

test('typed cancellation never reaches the validator or becomes consent', async () => {
  const h = harness();
  h.broker.pollAnswer.mockImplementationOnce(async () => reply({ cancel: true }));
  const decide = mock(() => ({ value: true }));
  const result = await askHostedInitChannel({ channel: await h.open(), screen: 'init-wizard', data, decide });
  expect(result.kind).toBe('cancelled');
  expect(decide).not.toHaveBeenCalled();
  expect(h.broker.cancel).toHaveBeenCalledWith(h.connections[1].connectionId);
});

test('expired authorized deadline prevents a new connection or view', async () => {
  const h = harness();
  const channel = { ...await h.open(), now: () => now + 7200001 };
  await expect(askHostedInitChannel({ channel, screen: 'init-wizard', data, decide: () => ({ value: true }) })).rejects.toMatchObject({ code: 'INIT_RUN_EXPIRED' });
  expect(h.broker.createConnection).toHaveBeenCalledTimes(2);
  expect(h.broker.sendRequest).not.toHaveBeenCalled();
});

test('a rejected answer followed by successor-create failure cleans up the attached connection', async () => {
  const h = harness();
  const initial = await h.open();
  const createConnection = mock(async (): Promise<BrokerConnection> => { throw new Error('synthetic-create-failed'); });
  const channel = { ...initial, broker: { ...h.broker, createConnection } };
  await expect(askHostedInitChannel({ channel, screen: 'init-wizard', data, decide: () => ({ error: 'Try another organization.' }) })).rejects.toThrow('synthetic-create-failed');
  expect(createConnection).toHaveBeenCalledTimes(1);
  expect(h.broker.cancel).toHaveBeenCalledWith(h.connections[0].connectionId);
  expect(h.broker.cancel).toHaveBeenCalledWith(h.connections[1].connectionId);
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(1);
});

test('hanging or rejecting cleanup attempts both connections and preserves the original failure', async () => {
  const h = harness();
  const cancel = mock((_id: string): Promise<void> => new Promise(() => undefined))
    .mockImplementationOnce(async () => { throw new Error('synthetic-cleanup-failure'); });
  const pollAnswer = mock(async () => ({ kind: 'network' as const }));
  const channel: HostedInitChannel = { ...await h.open(), cleanupTimeoutMs: 10, broker: { ...h.broker, pollAnswer, cancel } };
  await expect(askHostedInitChannel({ channel, screen: 'init-wizard', data, decide: () => ({ value: true }) })).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });
  expect(cancel).toHaveBeenCalledWith(h.connections[0].connectionId);
  expect(cancel).toHaveBeenCalledWith(h.connections[1].connectionId);
});


test('a screen-specific rejected projection replaces data exactly on the fresh question', async () => {
  const h = harness();
  h.broker.pollAnswer.mockImplementationOnce(async () => reply()).mockImplementationOnce(async () => reply({ sequence: 1 }));
  type NameData = Readonly<{ nonce: ''; view: 'name'; name: string; maxNameLength: number; nameError?: 'TOO_LONG' }>;
  const nameData: NameData = { nonce: '', view: 'name', name: 'Beta', maxNameLength: 100 };
  const rejectedData: NameData = { ...nameData, name: 'Corrected', nameError: 'TOO_LONG' };
  const decide = mock((): Readonly<{ value: string }> | Readonly<{ error: string; rejectedData: NameData }> => ({ value: 'Corrected' }))
    .mockImplementationOnce(() => ({ error: 'The name is too long.', rejectedData }));
  const result = await askHostedInitChannel({ channel: await h.open(), screen: 'create-organization', data: nameData, decide });
  expect(result.kind).toBe('accepted');
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(3);
  const retry = decoded<NameData>(h.broker.sendRequest.mock.calls[1]);
  expect(retry).toMatchObject({ kind: 'view', screen: 'create-organization', sequence: 1,
    next_connection_id: h.connections[2].connectionId });
  expect(retry.data).toEqual(rejectedData);
  expect(retry.data).not.toHaveProperty('rejected');
  expect(decoded(h.broker.sendRequest.mock.calls[2])).toMatchObject({ kind: 'progress', sequence: 2, data: rejectedData });
  expect(nameData).toEqual({ nonce: '', view: 'name', name: 'Beta', maxNameLength: 100 });
});

test('a secret-bearing question can send a sanitized progress projection exactly once', async () => {
  const h = harness();
  const phraseData = {
    nonce: '', view: 'phrase' as const, name: 'Beta', maxNameLength: 100,
    phraseWords: ['secret', 'words'],
  };
  const progressData = {
    nonce: '', view: 'creating' as const, name: 'Beta', maxNameLength: 100,
  };
  const result = await askHostedInitChannel({
    channel: await h.open(),
    screen: 'create-organization',
    data: phraseData,
    progressData,
    decide: () => ({ value: true }),
  });
  expect(result.kind).toBe('accepted');
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(2);
  const frames = h.broker.sendRequest.mock.calls.map((call) => decoded(call));
  expect(frames[0]).toMatchObject({ kind: 'view', data: phraseData });
  expect(frames[1]).toMatchObject({ kind: 'progress', data: progressData });
  expect(frames.filter((frame) => JSON.stringify(frame).includes('secret'))).toHaveLength(1);
});
