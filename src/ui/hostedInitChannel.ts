import { randomUUID } from 'node:crypto';
import type { BrokerClient, BrokerConnection } from '../service/brokerClient';
import {
  parseInitWizardAnswer, sameInitRunBinding,
  type InitRunBinding, type InitRunErrorCode, type InitRunTerminalReceipt,
  type InitWizardAnswer, type InitWizardFrame, type InitWizardScreen,
} from '../auth/initRunContract';

type Broker = Pick<BrokerClient, 'createConnection' | 'pollExchange' | 'pollAnswer' | 'sendRequest' | 'cancel'>;
export type HostedInitChannel = Readonly<{
  broker: Broker; binding: InitRunBinding; current: BrokerConnection;
  successor: BrokerConnection | null; sequence: number; deadline: number;
  now: () => number; attemptId: () => string; pause: () => Promise<void>;
  cleanupTimeoutMs: number;
}>;
export class HostedInitChannelError extends Error {
  constructor(readonly code: InitRunErrorCode) { super(code); }
}
const refuse = (code: InitRunErrorCode): never => { throw new HostedInitChannelError(code); };
const checkDeadline = (channel: HostedInitChannel, connection: BrokerConnection): void => {
  if (channel.now() >= channel.deadline) refuse('INIT_RUN_EXPIRED');
  const expiry = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiry) || channel.now() >= expiry) refuse('INIT_CONNECTION_EXPIRED');
};
const createConnection = (broker: Broker): Promise<BrokerConnection> => broker.createConnection({ purpose: 'init-wizard', ttlSeconds: 900 });

/** Cleanup cannot hide an operation's original outcome, even with injected clients. */
const cancelBounded = (broker: Broker, connectionId: string, timeoutMs: number): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, timeoutMs);
  void Promise.resolve().then(() => broker.cancel(connectionId)).catch(() => undefined).then(() => {
    clearTimeout(timer);
    resolve();
  });
});

/** Create C0/C1 before publishing C0; no connection-specific browser handoff. */
export async function openHostedInitChannel(input: Readonly<{
  broker: Broker; binding: InitRunBinding; deadline: number;
  publish: (connectionId: string) => Promise<void>;
  now?: () => number; attemptId?: () => string; pause?: () => Promise<void>;
}>): Promise<HostedInitChannel> {
  const now = input.now ?? Date.now;
  if (now() >= input.deadline) refuse('INIT_RUN_EXPIRED');
  const current = await createConnection(input.broker);
  const successor = await createConnection(input.broker).catch(async () => {
    await cancelBounded(input.broker, current.connectionId, 2000);
    return refuse('INIT_DELIVERY_INDETERMINATE');
  });
  const channel: HostedInitChannel = {
    broker: input.broker, binding: input.binding, current, successor, sequence: 0,
    deadline: input.deadline, now, attemptId: input.attemptId ?? randomUUID,
    pause: input.pause ?? (() => new Promise(resolve => setTimeout(resolve, 250))),
    cleanupTimeoutMs: 2000,
  };
  try {
    checkDeadline(channel, current);
    await input.publish(current.connectionId);
    return channel;
  } catch (error) {
    await closeHostedInitChannel(channel);
    throw error;
  }
}

async function pageKey(channel: HostedInitChannel, connection: BrokerConnection): Promise<string> {
  checkDeadline(channel, connection);
  const result = await channel.broker.pollExchange(connection, 20);
  if (result.kind === 'expired') return refuse('INIT_CONNECTION_EXPIRED');
  if (result.kind !== 'pending') return refuse('INIT_DELIVERY_INDETERMINATE');
  if (result.pagePubkeyB64) return result.pagePubkeyB64;
  await channel.pause();
  return pageKey(channel, connection);
}

async function send<T>(channel: HostedInitChannel, connection: BrokerConnection, frame: InitWizardFrame<T>): Promise<void> {
  const key = await pageKey(channel, connection);
  checkDeadline(channel, connection);
  const sent = await channel.broker.sendRequest(connection, key, JSON.stringify(frame));
  if (sent.kind === 'expired') refuse('INIT_CONNECTION_EXPIRED');
  // Includes already_sent: a lost send response is indeterminate. Never resend.
  if (sent.kind !== 'sent') refuse('INIT_DELIVERY_INDETERMINATE');
}

const decodeAnswer = (plaintext: string): InitWizardAnswer | null => {
  try { return parseInitWizardAnswer(JSON.parse(plaintext)); } catch { return null; }
};
async function answer<T>(channel: HostedInitChannel, frame: InitWizardFrame<T>): Promise<InitWizardAnswer> {
  checkDeadline(channel, channel.current);
  const result = await channel.broker.pollAnswer(channel.current, 20);
  if (result.kind === 'pending') {
    await channel.pause();
    return answer(channel, frame);
  }
  if (result.kind === 'expired') return refuse('INIT_CONNECTION_EXPIRED');
  // Result collection is destructive; a lost HTTP response is never retried.
  if (result.kind !== 'answered') return refuse('INIT_DELIVERY_INDETERMINATE');
  const parsed = decodeAnswer(result.plaintext);
  if (!parsed || !sameInitRunBinding(parsed.binding, channel.binding) || parsed.sequence !== frame.sequence || parsed.attempt_id !== frame.attempt_id) return refuse('INIT_BINDING_MISMATCH');
  if (parsed.kind === 'progress-ack') return refuse('INIT_BINDING_MISMATCH');
  return parsed;
}

type Verdict<T, D> = Readonly<{ value: T }> | Readonly<{ error: string; rejectedData?: D }>;
type QuestionResult<T> =
  | Readonly<{ kind: 'accepted'; value: T; channel: HostedInitChannel }>
  | Readonly<{ kind: 'cancelled'; channel: HostedInitChannel }>;

/**
 * Every transition returns a new channel. The caller must use that successor.
 * The existing CLI validator is the sole authority over the answer's meaning.
 * A valid answer is released only after progress is durably sent on Cn+1.
 */
export async function askHostedInitChannel<T, D extends object>(input: Readonly<{
  channel: HostedInitChannel; screen: InitWizardScreen; data: D;
  decide: (payload: Readonly<Record<string, unknown>>) => Verdict<T, D>;
}>): Promise<QuestionResult<T>> {
  const channel = input.channel;
  const successor = await (async () => {
    try {
      checkDeadline(channel, channel.current);
      return channel.successor ?? await createConnection(channel.broker);
    } catch (error) {
      await closeHostedInitChannel(channel);
      throw error;
    }
  })();
  const active = { ...channel, successor };
  const frame: InitWizardFrame<D> = {
    v: 1, flow: 'init-wizard', kind: input.screen === 'device-key' ? 'ceremony' : 'view',
    binding: channel.binding, sequence: channel.sequence, attempt_id: channel.attemptId(),
    screen: input.screen, data: input.data, next_connection_id: successor.connectionId,
  };
  try {
    await send(active, channel.current, frame);
    const received = await answer(active, frame);
    if (received.kind === 'cancel') {
      await closeHostedInitChannel(active);
      return { kind: 'cancelled', channel: active };
    }
    if (received.kind !== 'answer') return refuse('INIT_BINDING_MISMATCH');
    const verdict = input.decide(received.answer);
    const next: HostedInitChannel = { ...channel, current: successor, successor: null, sequence: channel.sequence + 1 };
    if ('error' in verdict) {
      return await askHostedInitChannel({ ...input, channel: next, data: verdict.rejectedData ?? { ...input.data, rejected: verdict.error } });
    }
    const afterProgress = await createConnection(channel.broker);
    const progressChannel = { ...next, successor: afterProgress };
    const progress: InitWizardFrame<D> = {
      ...frame, kind: 'progress', sequence: next.sequence, attempt_id: channel.attemptId(),
      next_connection_id: afterProgress.connectionId,
    };
    try {
      await send(progressChannel, successor, progress);
      checkDeadline(progressChannel, afterProgress);
    } catch (error) {
      await closeHostedInitChannel(progressChannel);
      throw error;
    }
    // The browser's progress acknowledgement is cleanup only. Waiting for it
    // would make a lost acknowledgement decide whether an operation may run.
    return { kind: 'accepted', value: verdict.value, channel: { ...next, current: afterProgress, sequence: next.sequence + 1 } };
  } catch (error) {
    await closeHostedInitChannel(active);
    throw error;
  }
}

/** The receipt is persisted by the CLI's authorized init-run continuation first. */
export async function finishHostedInitChannel<D>(channel: HostedInitChannel, input: Readonly<{
  screen: InitWizardScreen; data: D; receipt: InitRunTerminalReceipt;
}>): Promise<void> {
  if (input.receipt.run_id !== channel.binding.run_id) refuse('INIT_BINDING_MISMATCH');
  const frame: InitWizardFrame<D> = {
    v: 1, flow: 'init-wizard', kind: 'final', binding: channel.binding,
    sequence: channel.sequence, attempt_id: channel.attemptId(), screen: input.screen,
    data: input.data, terminal_receipt: input.receipt,
  };
  await send(channel, channel.current, frame);
  if (channel.successor) await cancelBounded(channel.broker, channel.successor.connectionId, channel.cleanupTimeoutMs);
}

export async function closeHostedInitChannel(channel: HostedInitChannel): Promise<void> {
  await Promise.all([
    cancelBounded(channel.broker, channel.current.connectionId, channel.cleanupTimeoutMs),
    ...(channel.successor ? [cancelBounded(channel.broker, channel.successor.connectionId, channel.cleanupTimeoutMs)] : []),
  ]);
}
