import { randomUUID, sign } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ProjectManager } from '../core/projectManager';
import { AuthService } from '../auth/authService';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { resolveActiveUrl } from '../config/profileConfig';
import { readLocalRoot } from '../config/globalConfig';
import { keepOrigin } from './screens/keepScreens';
import { mintConnectionKeypair, openEnvelope, sealRequestEnvelope } from '../service/brokerEnvelope';
import { runWithInteraction, type Interaction, type InteractionPresentation, type InteractionQuestion } from './interaction';
import { planOpen, openScreen } from './openScreen';
import { startLocalHandoff, type LocalHandoffHandle } from './localHandoff';

type Data = Readonly<Record<string, unknown>>;
type MessageType = 'output' | 'progress' | 'prompt' | 'answer' | 'goal' | 'ping' | 'pong';
interface Message { readonly v: 1; readonly id: string; readonly correlation_id: string; readonly direction: string; readonly type: MessageType; readonly envelope: string; readonly sequence: number }
interface History { readonly flow_id: string; readonly owner: string; readonly runtime_id: string; readonly repo_fingerprint: string; readonly client_pubkey: string; readonly page_pubkey: string | null; readonly state: string; readonly cursor: number; readonly messages: readonly Message[] }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Data)[key])}`).join(',')}}`
  : JSON.stringify(value);

type TurnItem = Readonly<{ readonly type: 'output' | 'progress'; readonly data: Data }>;
type FlowQueueItem = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string }>;
type FlowQueueWrite = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string }>;
const turnPresentation = (data: Data): InteractionPresentation | undefined => {
  const value = data.presentation;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const component = typeof candidate.component === 'string' ? candidate.component : undefined;
  return title === undefined && component === undefined
    ? undefined
    : { ...(title === undefined ? {} : { title }), ...(component === undefined ? {} : { component }) };
};
const turnOutcome = (data: Data): Data => Object.fromEntries(
  Object.entries(data).filter(([key]) => key !== 'presentation'),
);

/** The encrypted Flow payload for one CLI-owned question or terminal outcome. */
export const flowTurnPayload = (
  messages: readonly TurnItem[],
  boundary: Readonly<{ readonly type: 'prompt' | 'goal'; readonly data: Data }>,
): Data => {
  const presentation = turnPresentation(boundary.data);
  return {
    type: 'turn',
    messages,
    ...(boundary.type === 'prompt' ? { question: boundary.data.question } : { outcome: turnOutcome(boundary.data) }),
    ...(presentation === undefined ? {} : { presentation }),
  };
};

/**
 * Decide the encrypted writes for one CLI interaction event. Keeping this
 * pure makes the provider-auth handoff's immediate flush and request
 * correlation part of the transport contract rather than a UI convention.
 */
export const flowQueueStep = (
  items: readonly TurnItem[],
  item: FlowQueueItem,
): Readonly<{ readonly nextItems: readonly TurnItem[]; readonly writes: readonly FlowQueueWrite[] }> => {
  if (item.type === 'progress' && item.data.provider_auth) {
    return { nextItems: [], writes: [...items, { type: 'progress', data: item.data }] };
  }
  if (item.type === 'output' || item.type === 'progress') {
    return { nextItems: [...items, { type: item.type, data: item.data }], writes: [] };
  }
  const boundary = item.type === 'prompt' || item.type === 'goal';
  return {
    nextItems: boundary ? [] : items,
    writes: [{ type: item.type, data: boundary
      ? flowTurnPayload(items, { type: item.type, data: item.data })
      : item.data, ...(item.correlation === undefined ? {} : { correlation: item.correlation }) }],
  };
};

/**
 * The one condition that turns on the human path: a person watching a real
 * terminal, on a run that is allowed to open a browser itself. Every other
 * run — an agent's piped stdout, `CAPY_WEB_NO_OPEN`, a test, or any command
 * that did not ask for the handoff — keeps the byte-identical JSON contract.
 * The browser-open plan is a thunk so a run that never wanted the handoff
 * does not consult it at all.
 */
export const isHumanFlowRun = (
  localHandoff: boolean | undefined,
  stdoutIsTty: boolean | undefined,
  plannedOpen: () => string,
): boolean => localHandoff === true && stdoutIsTty === true && plannedOpen() !== 'suppressed';

/** Adapter only: executes the ordinary command under the encrypted Flow I/O boundary. */
export async function runWithFlowInteraction(operation: () => Promise<void>, devMode: boolean, descriptor: Readonly<{ command: 'capy' | 'rotate'; continuationTool: 'capy_onboard_continue' | 'capy_rotate_continue'; expectedUserId?: string; localHandoff?: boolean }> = { command: 'capy', continuationTool: 'capy_onboard_continue' }): Promise<void> {
  const project = await new ProjectManager().detectProjectState();
  const auth = (() => {
    try { return new AuthService(undefined, devMode, project.userId); }
    catch (error) {
      if (error instanceof Error && error.message === 'AUTH_REFRESH_AUTHORITY_INDETERMINATE') throw new Error('PAIR_REQUIRED');
      throw error;
    }
  })();
  const identity = await auth.authenticateSilent();
  if (!identity.success || !identity.user_id || !identity.organization_id
    || !readLocalRoot(identity.organization_id, identity.user_id)) throw new Error('PAIR_REQUIRED');
  if (descriptor.expectedUserId && identity.user_id !== descriptor.expectedUserId) throw new Error('AUTH_ACCOUNT_MISMATCH');
  const binding = resolveInitRunIdentity();
  const runtimeId = randomUUID();
  const keys = mintConnectionKeypair();
  const controller = new AbortController();
  const origin = resolveActiveUrl(devMode);
  const signed = (method: string, flowId: string, id: string, body: Data): Data => ({ ...body,
    proof: sign('sha256', Buffer.from(`capy.conversation.v1\n${method}\n${flowId}\n${id}\n${canonical(body)}`), keys.privateKey).toString('base64') });
  const request = async <T>(path: string, body?: Data, extraHeaders?: () => Readonly<Record<string, string>>): Promise<T> => {
    const perform = async (): Promise<Response> => {
      try { const response = await fetch(`${origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${(await auth.getValidToken())?.access_token ?? ''}`, 'Content-Type': 'application/json', ...extraHeaders?.() },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      });
      if (response.status >= 500 || response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return perform();
      }
      return response; } catch (error) {
        if (controller.signal.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
        return perform();
      }
    };
    const response = await perform();
    const result = await response.json() as T & { readonly code?: string };
    if (!response.ok) throw new Error(result.code ?? 'CONVERSATION_SERVICE_ERROR');
    return result;
  };
  const created = await request<{ readonly flow_id: string; readonly client_pubkey: string; readonly page_pubkey?: string | null }>('/flows/conversation', signed('create', runtimeId, 'create', {
    command: descriptor.command, runtime_id: runtimeId, repo_fingerprint: binding.repositoryFingerprint, client_pubkey: keys.publicKeyB64, machine_name: binding.machineName,
  }));
  if (created.client_pubkey !== keys.publicKeyB64) throw new Error('CONVERSATION_BINDING_MISMATCH');
  const flowId = created.flow_id;
  const url = `${keepOrigin()}/flow/conversation?f=${encodeURIComponent(flowId)}`;
  // Local auth + custody handoff (docs/flows/local-handoff.md): only when this
  // exact invocation is allowed to open a browser itself, and only when no
  // page has attached to the conversation yet. Everything else — MCP runs,
  // non-TTY output, CAPY_WEB_NO_OPEN — stays on the byte-identical JSON path
  // below, unchanged.
  const isHuman = isHumanFlowRun(
    descriptor.localHandoff,
    process.stdout.isTTY,
    () => planOpen(url, { kind: 'handoff' }).via,
  );
  const handoff: LocalHandoffHandle | null = isHuman && !created.page_pubkey
    ? await startLocalHandoff({
        origin,
        keepOrigin: keepOrigin(),
        conversationFlowId: flowId,
        clientPubkeyB64: keys.publicKeyB64,
        userId: identity.user_id,
        orgId: identity.organization_id,
        bearer: async () => (await auth.getValidToken())?.access_token ?? '',
        sign: signed,
        readLocalRoot,
      })
    : null;
  // Only the public handoff goes to stdout. Workflow content always uses the encrypted adapter.
  if (isHuman) {
    process.stdout.write(`\nOpening Capy…\n${url}\n`);
    void openScreen(handoff?.url ?? url, { kind: 'handoff' });
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, command: descriptor.command, flow_id: flowId, url, continuation: {tool: descriptor.continuationTool, args: {command: descriptor.command, flow_id: flowId, wait: true}} })}\n`);
  }
  const detach = async (): Promise<void> => {
    try {
      const token = await auth.getValidToken();
      await fetch(`${origin}/flows/${flowId}/detach`, {method: 'POST', signal: AbortSignal.timeout(5000),
        headers: {Authorization: `Bearer ${token?.access_token ?? ''}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(signed('detach', flowId, 'detach', {}))});
    } catch { /* The service's attachment lease expires after abrupt disconnects. */ }
  };
  const interrupted = (): void => { void detach().finally(() => {controller.abort(); process.exit(130);}); };
  const terminated = (): void => { void detach().finally(() => {controller.abort(); process.exit(143);}); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
  const history = async (after: number, pageKey: string | null): Promise<History> => {
    const result = await request<History>(`/flows/${flowId}/messages?after=${after}&after_page_pubkey=${encodeURIComponent(pageKey ?? 'null')}&wait_ms=25000`, undefined, () => {
      const attachedAt = String(Date.now());
      const proof = signed('read', flowId, attachedAt, {after, page_key: pageKey ?? 'null', attached_at: attachedAt}).proof as string;
      return {'x-capy-cli-attached-at': attachedAt, 'x-capy-cli-proof': proof};
    });
    if (result.flow_id !== flowId || result.owner !== identity.user_id || result.runtime_id !== runtimeId
      || result.client_pubkey !== keys.publicKeyB64 || result.repo_fingerprint !== binding.repositoryFingerprint) throw new Error('CONVERSATION_BINDING_MISMATCH');
    return result;
  };
  const waitForPage = async (): Promise<History> => {
    const result = await history(0, null);
    if (result.state !== 'active') throw new Error('CONVERSATION_ENDED');
    return result.page_pubkey ? result : waitForPage();
  };
  const attached = await waitForPage();
  const pageKey = attached.page_pubkey!;
  // The page has what it needs (or has already fallen back on its own); the
  // loopback listener has nothing left to answer.
  if (handoff) await handoff.close();
  const incoming = new EventEmitter();
  const append = async (type: MessageType, data: Data, correlationId?: string): Promise<void> => {
    const id = randomUUID();
    const correlation = correlationId ?? id;
    const content = { v: 1, flow_id: flowId, id, correlation_id: correlation, type, data };
    const sealed = sealRequestEnvelope({ connectionId: `${flowId}:${id}`, clientPubkeyB64: keys.publicKeyB64, pagePubkeyB64: pageKey, payload: JSON.stringify(content) });
    if (!sealed.ok) throw new Error('CONVERSATION_ENCRYPTION_FAILED');
    const body = signed('append', flowId, id, { v: 1, id, correlation_id: correlation, direction: 'cli_to_browser', type, envelope: sealed.ciphertextB64,
      ...(type === 'goal' ? {outcome: (data.outcome as Data | undefined)?.status ?? data.status} : {}) });
    await request(`/flows/${flowId}/messages`, body);
  };
  type Queued = { readonly type: MessageType; readonly data: Data; readonly correlation?: string; readonly resolve: () => void; readonly reject: (reason: unknown) => void };
  const queue = new PassThrough({ objectMode: true });
  const iterator = queue[Symbol.asyncIterator]();
  // Output stays local until the CLI reaches a question or a terminal goal.
  // The outer prompt/goal tag preserves the service's answer and completion checks.
  const consume = async (items: readonly TurnItem[]): Promise<void> => {
    const next = await iterator.next();
    if (next.done) return;
    const item = next.value as Queued;
    try {
      const step = flowQueueStep(items, item);
      for (const write of step.writes) await append(write.type, write.data, write.correlation);
      if (item.type === 'goal' && !isHuman) process.stdout.write(`${JSON.stringify({ok: true, command: descriptor.command, flow_id: flowId, outcome: item.data.status, continuation: {tool: descriptor.continuationTool, args: {command: descriptor.command, flow_id: flowId, wait: false}}})}\n`);
      item.resolve();
      return consume(step.nextItems);
    } catch (error) {
      item.reject(error);
      incoming.emit('failure', error);
      controller.abort(error);
      throw error;
    }
  };
  const writer = consume([]);
  void writer.catch(() => undefined);
  const emit = (type: MessageType, data: Data, correlation?: string): Promise<void> => new Promise((resolve, reject) => {
    if (queue.destroyed || controller.signal.aborted) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    queue.write({ type, data, correlation, resolve, reject } satisfies Queued);
  });
  const receive = async (cursor: number): Promise<void> => {
    if (controller.signal.aborted) return;
    const result = await history(cursor, pageKey);
    for (const message of result.messages) {
      if (message.direction !== 'browser_to_cli') continue;
      const opened = openEnvelope({ ciphertextB64: message.envelope, connectionId: `${flowId}:${message.id}`, keypair: keys });
      if (!opened.ok) throw new Error('CONVERSATION_DECRYPTION_FAILED');
      const content = JSON.parse(opened.plaintext) as { readonly v: number; readonly flow_id: string; readonly id: string; readonly correlation_id: string; readonly type: string; readonly data: Data };
      if (content.v !== 1 || content.flow_id !== flowId || content.id !== message.id || content.correlation_id !== message.correlation_id || content.type !== message.type) throw new Error('CONVERSATION_BINDING_MISMATCH');
      if (message.type === 'ping') await emit('pong', { message: 'CLI is running.' }, message.correlation_id);
      else if (message.type === 'answer') incoming.emit(message.correlation_id, content.data);
    }
    if (result.state !== 'active') return;
    return receive(result.cursor);
  };
  const reader = receive(0).catch(error => { if (!controller.signal.aborted) { incoming.emit('failure', error); controller.abort(error); } });
  const ask = async <T>(question: InteractionQuestion<T>): Promise<T | null> => {
    const id = randomUUID();
    const answer = new Promise<Data>((resolve, reject) => {
      const failed = (error: unknown): void => { incoming.removeListener(id, answered); reject(error); };
      const answered = (value: Data): void => { incoming.removeListener('failure', failed); resolve(value); };
      incoming.once(id, answered); incoming.once('failure', failed);
      if (controller.signal.aborted) failed(controller.signal.reason);
    });
    await emit('prompt', { question: question.view,
      ...(question.presentation === undefined ? {} : { presentation: question.presentation }) }, id);
    const payload = await answer;
    const decision = question.decide(payload);
    if ('error' in decision) { await emit('output', { message: decision.error, level: 'error' }); return ask(question); }
    const view = question.view as Readonly<{ input?: Readonly<{ choices?: readonly Readonly<{value: unknown; label: string}>[] }> }>;
    const submitted = payload.value;
    const selectedLabel = Array.isArray(submitted)
      ? view.input?.choices?.filter(choice => submitted.includes(choice.value)).map(choice => choice.label).join(', ')
      : view.input?.choices?.find(choice => Object.is(choice.value, submitted))?.label;
    await emit('output', { message: selectedLabel ?? String(payload.value ?? ''), answer_to: id, value: payload.value });
    return decision.value;
  };
  const interaction: Interaction = {
    output: event => emit('output', { ...event }),
    progress: event => emit('progress', { ...event }),
    prompt: ask,
    goal: outcome => emit('goal', { ...outcome }),
  };
  try {
    await runWithInteraction(interaction, operation);
    queue.end();
    await writer;
  } finally { controller.abort(); await reader; }
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    if (handoff) await handoff.close();
    await detach();
  }
}
