import { expect, mock, test } from 'bun:test';
import type { InitRunBinding, InitRunTerminalReceipt, InitWizardFrame } from '../../src/auth/initRunContract';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { BrokerConnection } from '../../src/service/brokerClient';
import {
  abortHostedInitWizard,
  askHostedInitQuestion,
  blockHostedInitWizard,
  createHostedInitWizardSession,
  finishHostedInitWizard,
  recordHostedInitWizard,
  reportHostedEncryptFailure,
} from '../../src/ui/hostedInitWizardSession';
import { encryptQuestion, organizationQuestion } from '../../src/ui/initWizardQuestions';
import { ERROR_CODES } from '../../src/types';
import { openHostedInitChannel, type HostedInitChannel } from '../../src/ui/hostedInitChannel';

const binding: InitRunBinding = {
  run_id: '11111111-1111-4111-8111-111111111111',
  subject_user_id: 'user_demo',
  service_origin: 'https://api.dev.example',
  runtime_id: '77777777-7777-4777-8777-777777777777',
  repository_fingerprint: `sha256:${'a'.repeat(64)}`,
  cli_key_fingerprint: `sha256:${'b'.repeat(64)}`,
};
const now = Date.parse('2026-09-10T05:00:00.000Z');
const receipt = (status: InitRunTerminalReceipt['status'], code: string | null = null): InitRunTerminalReceipt => ({
  v: 1,
  run_id: binding.run_id,
  receipt_id: '22222222-2222-4222-8222-222222222222',
  status,
  code,
  repository_verified: status === 'succeeded',
  custody_verified: status === 'succeeded',
  effects: status === 'succeeded' ? 'complete' : 'none',
  completed_at: '2026-09-10T05:00:00.000Z',
});
const connection = (id: number): BrokerConnection => ({
  connectionId: `${String(id).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900000).toISOString(),
  keypair: mintConnectionKeypair(),
});
const answer = (input: Readonly<{
  sequence?: number;
  organizationId?: string;
  payload?: Readonly<Record<string, unknown>>;
  cancel?: boolean;
}> = {}) => ({
  kind: 'answered' as const,
  plaintext: JSON.stringify({
    v: 1,
    flow: 'init-wizard',
    binding,
    sequence: input.sequence ?? 0,
    attempt_id: 'attempt_1',
    ...(input.cancel
      ? { kind: 'cancel' }
      : { kind: 'answer', answer: input.payload ?? { organizationId: input.organizationId ?? 'org-1' } }),
  }),
});
const harness = () => {
  const connections = [connection(1), connection(2), connection(3), connection(4), connection(5), connection(6)] as const;
  const createConnection = mock(async () => connections[0])
    .mockImplementationOnce(async () => connections[0])
    .mockImplementationOnce(async () => connections[1])
    .mockImplementationOnce(async () => connections[2])
    .mockImplementationOnce(async () => connections[3])
    .mockImplementationOnce(async () => connections[4])
    .mockImplementationOnce(async () => connections[5]);
  const pollExchange = mock(async () => ({ kind: 'pending' as const, pagePubkeyB64: 'synthetic-page-key' }));
  const pollAnswer = mock(async () => answer());
  const sendRequest = mock(async () => ({ kind: 'sent' as const }));
  const cancel = mock(async () => undefined);
  const publish = mock(async () => undefined);
  const broker = { createConnection, pollExchange, pollAnswer, sendRequest, cancel };
  return {
    broker,
    connections,
    publish,
    open: (): Promise<HostedInitChannel> => openHostedInitChannel({
      broker,
      binding,
      deadline: now + 7200000,
      now: () => now,
      attemptId: () => 'attempt_1',
      pause: async () => undefined,
      publish,
    }),
  };
};
const decoded = (call: readonly unknown[]): InitWizardFrame<Record<string, unknown>> =>
  JSON.parse(call[2] as string) as InitWizardFrame<Record<string, unknown>>;

test('shared question rejection redraws the same choice set, then returns a new recorded session after progress delivery', async () => {
  const h = harness();
  h.broker.pollAnswer
    .mockImplementationOnce(async () => answer({ organizationId: 'org-nope' }))
    .mockImplementationOnce(async () => answer({ sequence: 1, organizationId: 'org-1' }));
  const initial = recordHostedInitWizard(createHostedInitWizardSession(await h.open()), { orgCount: 1 });
  const result = await askHostedInitQuestion(initial, organizationQuestion([{ id: 'org-1', name: 'One', isCurrent: true }]));

  expect(result.value).toBe('org-1');
  expect(initial.input.organization).toBeUndefined();
  expect(result.session.input.organization).toEqual({ kind: 'existing', name: 'One' });
  expect(result.session).not.toBe(initial);
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(3);
  expect(decoded(h.broker.sendRequest.mock.calls[1])).toMatchObject({
    kind: 'view',
    sequence: 1,
    data: { rejected: 'That organization is not one this session can reach.' },
  });
  expect(decoded(h.broker.sendRequest.mock.calls[2])).toMatchObject({ kind: 'progress', sequence: 2 });
});

test('typed cancellation latches terminal state without invoking the shared validator or delivering a success final', async () => {
  const h = harness();
  h.broker.pollAnswer.mockImplementationOnce(async () => answer({ cancel: true }));
  const question = {
    view: { step: 'organization' as const, orgs: [{ id: 'org-1', name: 'One', isCurrent: true }] },
    decide: mock(() => ({ value: 'org-1', record: { organization: { kind: 'existing' as const, name: 'One' } } })),
  };
  const result = await askHostedInitQuestion(createHostedInitWizardSession(await h.open()), question);
  const finished = await finishHostedInitWizard(result.session, receipt('succeeded'));

  expect(result.value).toBeNull();
  expect(question.decide).not.toHaveBeenCalled();
  expect(finished.ended).toBe(true);
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(1);
});

test('declared blocks and post-encryption failure retain their coded final data and suppress a later success final', async () => {
  const h = harness();
  const blocked = blockHostedInitWizard(
    recordHostedInitWizard(createHostedInitWizardSession(await h.open()), { orgCount: 1 }),
    'redeem',
    {
      code: ERROR_CODES.AUTH_FAILED,
      title: 'This device does not hold this organization\'s key',
      detail: 'The shared key has never been transferred here.',
      remedy: 'capy redeem <code>',
    },
    { facts: [{ label: 'Organization', value: 'One' }] },
  );
  const aborted = await abortHostedInitWizard(blocked, receipt('failed', ERROR_CODES.AUTH_FAILED), new Error('no key'));
  h.broker.pollAnswer.mockImplementationOnce(async () => answer({ payload: { encrypt: true } }));
  const encryptSession = recordHostedInitWizard(createHostedInitWizardSession(await h.open()), { localEnvCount: 1, encrypt: true });
  const answered = await askHostedInitQuestion(
    encryptSession,
    encryptQuestion(
      { count: 1, names: ['DATABASE_URL'] },
      { projectName: 'one', orgName: 'One', branch: 'development' },
    ),
  );
  const failed = await reportHostedEncryptFailure(answered.session, receipt('failed', ERROR_CODES.SERVICE_ERROR), {
    code: ERROR_CODES.SERVICE_ERROR,
    reason: 'Keep did not answer (503).',
    envRewritten: false,
    backupWritten: false,
    pushed: false,
  });
  await finishHostedInitWizard(failed, receipt('succeeded'));

  const abortFinal = decoded(h.broker.sendRequest.mock.calls[0]);
  const encryptFinal = decoded(h.broker.sendRequest.mock.calls[3]);
  expect(aborted.ended).toBe(true);
  expect(abortFinal).toMatchObject({ kind: 'final', screen: 'init-wizard', data: { step: 'redeem', blocked: { code: ERROR_CODES.AUTH_FAILED } } });
  expect(failed.input.encrypt).toBeUndefined();
  expect(encryptFinal).toMatchObject({ kind: 'final', data: { step: 'encrypt', encryptFailure: { code: ERROR_CODES.SERVICE_ERROR } } });
  expect(h.broker.sendRequest).toHaveBeenCalledTimes(4);
});

test('an indeterminate channel result and deadline fail before returning a session or accepting an answer', async () => {
  const ambiguous = harness();
  const ambiguousChannel: HostedInitChannel = {
    ...await ambiguous.open(),
    broker: { ...ambiguous.broker, pollAnswer: mock(async () => ({ kind: 'network' as const })) },
  };
  await expect(askHostedInitQuestion(
    createHostedInitWizardSession(ambiguousChannel),
    organizationQuestion([{ id: 'org-1', name: 'One', isCurrent: true }]),
  )).rejects.toMatchObject({ code: 'INIT_DELIVERY_INDETERMINATE' });

  const expired = harness();
  const expiredChannel: HostedInitChannel = { ...await expired.open(), now: () => now + 7200001 };
  await expect(askHostedInitQuestion(
    createHostedInitWizardSession(expiredChannel),
    organizationQuestion([{ id: 'org-1', name: 'One', isCurrent: true }]),
  )).rejects.toMatchObject({ code: 'INIT_RUN_EXPIRED' });
  expect(expired.broker.sendRequest).not.toHaveBeenCalled();
});
