import { randomUUID, sign } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ProjectManager } from '../core/projectManager';
import { AuthService, silentAuthFailureMessage } from '../auth/authService';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { resolveActiveUrl } from '../config/profileConfig';
import { readLocalRoot } from '../config/globalConfig';
import { keepOrigin } from './screens/keepScreens';
import { mintConnectionKeypair, openEnvelope, sealRequestEnvelope } from '../service/brokerEnvelope';
import { runWithInteraction, currentInteractionInvocation, type Interaction, type InteractionPresentation, type InteractionQuestion } from './interaction';
import { attachFlowAgentRuntime, initialFlowAgentState, type FlowAgentState, type FlowGoal, type FlowNextOffer } from './flowAgentBridge';
import { loadFlowRecoveryBootstrap, openFlowRecoveryCheckpoint, saveFlowRecoveryBootstrap, sealFlowRecoveryCheckpoint, type FlowRecoveryBinding } from './flowRecoveryStore';

type Data = Readonly<Record<string, unknown>>;
type MessageType = 'output' | 'progress' | 'prompt' | 'answer' | 'goal' | 'goal_completed' | 'ping' | 'pong';
interface Message { readonly v: 1; readonly id: string; readonly correlation_id: string; readonly direction: string; readonly type: MessageType; readonly envelope: string; readonly sequence: number }
interface History { readonly flow_id: string; readonly owner: string; readonly runtime_id: string; readonly repo_fingerprint: string; readonly client_pubkey: string; readonly page_pubkey: string | null; readonly state: string; readonly cursor: number; readonly messages: readonly Message[] }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Data)[key])}`).join(',')}}`
  : JSON.stringify(value);

type TurnItem = Readonly<{ readonly type: 'output' | 'progress'; readonly data: Data }>;
type FlowQueueItem = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string }>;
type FlowQueueWrite = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string }>;
export const flowWelcome = (input: Readonly<{
  readonly command: 'capy' | 'rotate';
  readonly initialized: boolean;
  readonly username: string | null | undefined;
  readonly project: string | undefined;
  readonly organization: string | undefined;
  readonly branch: string | null;
}>): Readonly<{ readonly username: string | null; readonly project: string | null; readonly organization: string | null; readonly branch: string | null; readonly flowName: string }> => ({
  username: input.username ?? null,
  project: input.project ?? null,
  organization: input.organization ?? null,
  branch: input.branch,
  flowName: input.command === 'rotate' ? 'Rotate' : input.initialized ? 'Sync' : 'Secrets Setup',
});
export const shouldOfferProjectSetup = (command: 'capy' | 'rotate', outcome: Data): boolean => command === 'capy'
  && outcome.flow === 'init-wizard' && outcome.goal === 'repository_onboarded' && outcome.status === 'succeeded';
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
  boundary: Readonly<{ readonly type: 'prompt' | 'goal' | 'goal_completed'; readonly data: Data }>,
): Data => {
  const presentation = turnPresentation(boundary.data);
  return {
    type: 'turn',
    messages,
    ...(boundary.data.invocation === undefined ? {} : { invocation: boundary.data.invocation }),
    ...(boundary.type === 'prompt' ? { question: boundary.data.question } : { outcome: turnOutcome(boundary.data) }),
    ...(typeof boundary.data.goal_id === 'string' ? { goal_id: boundary.data.goal_id } : {}),
    ...(typeof boundary.data.goal_name === 'string' ? { goal_name: boundary.data.goal_name } : {}),
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
  const immediate = item.type === 'progress' && (item.data.provider_auth || item.data.kind === 'goal_start' || item.data.kind === 'plan' || item.data.kind === 'apply_started' || item.data.kind === 'apply_result');
  if (immediate || (item.type === 'output' && (item.data.kind === 'analysis' || item.data.welcome !== undefined))) {
    return { nextItems: [], writes: [...items, { type: item.type, data: item.data }] };
  }
  if (item.type === 'output' || item.type === 'progress') {
    return { nextItems: [...items, { type: item.type, data: item.data }], writes: [] };
  }
  const boundary = item.type === 'prompt' || item.type === 'goal' || item.type === 'goal_completed';
  return {
    nextItems: boundary ? [] : items,
    writes: [{ type: item.type, data: boundary
      ? flowTurnPayload(items, { type: item.type, data: item.data })
      : item.data, ...(item.correlation === undefined ? {} : { correlation: item.correlation }) }],
  };
};

/** Adapter only: executes the ordinary command under the encrypted Flow I/O boundary. */
export async function runWithFlowInteraction(operation: () => Promise<void>, devMode: boolean, descriptor: Readonly<{ command: 'capy' | 'rotate'; continuationTool: 'capy_onboard_continue' | 'capy_rotate_continue'; expectedUserId?: string; organizationId?: string }> = { command: 'capy', continuationTool: 'capy_onboard_continue' }): Promise<void> {
  const project = await new ProjectManager().detectProjectState();
  const rootGoalMetadata: Data = descriptor.command === 'capy' && !project.initialized
    ? { goal_id: 'secrets_setup', goal_name: 'Secrets Setup' }
    : {};
  const auth = (() => {
    try { return new AuthService(undefined, devMode, project.userId); }
    catch (error) {
      if (error instanceof Error && error.message === 'AUTH_REFRESH_AUTHORITY_INDETERMINATE') throw new Error('PAIR_REQUIRED');
      throw error;
    }
  })();
  const identity = await auth.authenticateSilent(descriptor.organizationId);
  const localRoot = identity.success && identity.user_id && identity.organization_id
    ? readLocalRoot(identity.organization_id, identity.user_id) : null;
  if (!identity.success || !identity.user_id || !identity.organization_id || !localRoot) {
    console.error(`flow: ${silentAuthFailureMessage(identity)}`);
    throw new Error('PAIR_REQUIRED');
  }
  if (descriptor.expectedUserId && identity.user_id !== descriptor.expectedUserId) throw new Error('AUTH_ACCOUNT_MISMATCH');
  const transportToken = await auth.getValidToken();
  if (!transportToken?.access_token) throw new Error('PAIR_REQUIRED');
  const accessToken = async (): Promise<string> => {
    try { return (await auth.getValidToken())?.access_token ?? transportToken.access_token; }
    catch { return transportToken.access_token; }
  };
  const binding = resolveInitRunIdentity();
  const runtimeId = randomUUID();
  const keys = mintConnectionKeypair();
  const controller = new AbortController();
  const origin = resolveActiveUrl(devMode);
  const signed = (method: string, flowId: string, id: string, body: Data): Data => ({ ...body,
    proof: sign('sha256', Buffer.from(`capy.conversation.v1\n${method}\n${flowId}\n${id}\n${canonical(body)}`), keys.privateKey).toString('base64') });
  const request = async <T>(path: string, body?: Data, extraHeaders?: () => Readonly<Record<string, string>>, tokenOverride?: string): Promise<T> => {
    const perform = async (): Promise<Response> => {
      try { const response = await fetch(`${origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokenOverride ?? await accessToken()}`, 'Content-Type': 'application/json', ...extraHeaders?.() },
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
  const created = await request<{ readonly flow_id: string; readonly client_pubkey: string }>('/flows/conversation', signed('create', runtimeId, 'create', {
    command: descriptor.command, runtime_id: runtimeId, repo_fingerprint: binding.repositoryFingerprint, client_pubkey: keys.publicKeyB64, machine_name: binding.machineName,
  }));
  if (created.client_pubkey !== keys.publicKeyB64) throw new Error('CONVERSATION_BINDING_MISMATCH');
  const flowId = created.flow_id;
  const flowBinding: FlowRecoveryBinding = {
    flow_id: flowId, runtime_id: runtimeId, origin, owner_id: identity.user_id,
    organization_id: identity.organization_id, repo_fingerprint: binding.repositoryFingerprint, client_pubkey: keys.publicKeyB64,
  };
  saveFlowRecoveryBootstrap(localRoot, flowBinding, keys);
  const url = `${keepOrigin()}/flow/conversation?f=${encodeURIComponent(flowId)}`;
  // Only the public handoff goes to stdout. Workflow content always uses the encrypted adapter.
  process.stdout.write(`${JSON.stringify({ ok: true, command: descriptor.command, flow_id: flowId, url, instructions: ['Show this URL immediately in visible chat, then keep this process alive and read its output with bounded waits. Do not wait for another user chat message.', 'An empty read or wait timeout is not completion. Handle type=agent_handoff immediately using its attachment instructions; a URL in that event is not a reason to stop.', 'Only a terminal outcome completes the flow. If your client cannot keep waiting, tell the user to ask you to resume this same process, not restart onboarding.'], continuation: {tool: descriptor.continuationTool, args: {command: descriptor.command, flow_id: flowId, wait: true}} })}\n`);
  const detach = async (): Promise<void> => {
    try {
      const token = await accessToken();
      await fetch(`${origin}/flows/${flowId}/detach`, {method: 'POST', signal: AbortSignal.timeout(5000),
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(signed('detach', flowId, 'detach', {}))});
    } catch { /* The service's attachment lease expires after abrupt disconnects. */ }
  };
  const interrupted = (): void => { void detach().finally(() => {controller.abort(); process.exit(130);}); };
  const terminated = (): void => { void detach().finally(() => {controller.abort(); process.exit(143);}); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
  const history = async (after: number, pageKey: string | null, accessToken?: string, waitMs = 25_000): Promise<History> => {
    const result = await request<History>(`/flows/${flowId}/messages?after=${after}&after_page_pubkey=${encodeURIComponent(pageKey ?? 'null')}&wait_ms=${waitMs}`, undefined, () => {
      const attachedAt = String(Date.now());
      const proof = signed('read', flowId, attachedAt, {after, page_key: pageKey ?? 'null', attached_at: attachedAt}).proof as string;
      return {'x-capy-cli-attached-at': attachedAt, 'x-capy-cli-proof': proof};
    }, accessToken);
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
  type CheckpointResponse = Readonly<{
    readonly flow_id: string;
    readonly runtime_id: string;
    readonly repo_fingerprint: string;
    readonly client_pubkey: string;
    readonly revision: string | null;
    readonly envelope: string | null;
  }>;
  const checkpoint = async (): Promise<CheckpointResponse> => {
    const proof = signed('checkpoint-read', flowId, 'checkpoint', {}).proof as string;
    const result = await request<CheckpointResponse>(`/flows/${flowId}/checkpoint`, undefined, () => ({ 'x-capy-cli-proof': proof }));
    if (result.flow_id !== flowId || result.runtime_id !== runtimeId || result.repo_fingerprint !== binding.repositoryFingerprint || result.client_pubkey !== keys.publicKeyB64) {
      throw new Error('CONVERSATION_BINDING_MISMATCH');
    }
    return result;
  };
  const incoming = new EventEmitter();
  // The runtime's plaintext journal is never persisted. It lets an explicit,
  // authenticated local read join acknowledged service records to their local
  // structured payloads; the page decrypts the corresponding envelopes.
  type JournalEntry = Readonly<{ readonly id: string; readonly type: MessageType; readonly data: Data; readonly envelope: string }>;
  type Journal = ReadonlyMap<string, JournalEntry>;
  const append = async (type: MessageType, data: Data, journal: Journal, correlationId?: string): Promise<JournalEntry> => {
    const id = randomUUID();
    const correlation = correlationId ?? id;
    const content = { v: 1, flow_id: flowId, id, correlation_id: correlation, type, data };
    const sealed = sealRequestEnvelope({ connectionId: `${flowId}:${id}`, clientPubkeyB64: keys.publicKeyB64, pagePubkeyB64: pageKey, payload: JSON.stringify(content) });
    if (!sealed.ok) throw new Error('CONVERSATION_ENCRYPTION_FAILED');
    const body = signed('append', flowId, id, { v: 1, id, correlation_id: correlation, direction: 'cli_to_browser', type, envelope: sealed.ciphertextB64,
      ...((type === 'goal' || type === 'goal_completed') ? {outcome: (data.outcome as Data | undefined)?.status ?? data.status} : {}) });
    const entry = { id, type, data, envelope: sealed.ciphertextB64 };
    await enqueueCheckpoint(undefined, new Map([...journal, [entry.id, entry]]));
    await request(`/flows/${flowId}/messages`, body);
    return entry;
  };
  type QueuedMessage = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string; readonly resolve: () => void; readonly reject: (reason: unknown) => void }>;
  type QueuedSnapshot = Readonly<{ readonly type: 'snapshot'; readonly resolve: (journal: Journal) => void; readonly reject: (reason: unknown) => void }>;
  type Queued = QueuedMessage | QueuedSnapshot;
  const queue = new PassThrough({ objectMode: true });
  const iterator = queue[Symbol.asyncIterator]();
  // Output stays local until the CLI reaches a question or a terminal goal.
  // The outer prompt/goal tag preserves the service's answer and completion checks.
  const appendWrites = async (writes: readonly FlowQueueWrite[], journal: Journal): Promise<Journal> => {
    const write = writes[0];
    if (!write) return journal;
    const entry = await append(write.type, write.data, journal, write.correlation);
    return appendWrites(writes.slice(1), new Map([...journal, [entry.id, entry]]));
  };
  const consume = async (items: readonly TurnItem[], journal: Journal): Promise<void> => {
    const next = await iterator.next();
    if (next.done) return;
    const item = next.value as Queued;
    try {
      if (item.type === 'snapshot') {
        item.resolve(journal);
        return consume(items, journal);
      }
      const step = flowQueueStep(items, item);
      const nextJournal = await appendWrites(step.writes, journal);
      if (item.type === 'goal') process.stdout.write(`${JSON.stringify({ok: true, command: descriptor.command, flow_id: flowId, outcome: item.data.status, continuation: {tool: descriptor.continuationTool, args: {command: descriptor.command, flow_id: flowId, wait: false}}})}\n`);
      item.resolve();
      return consume(step.nextItems, nextJournal);
    } catch (error) {
      item.reject(error);
      incoming.emit('failure', error);
      controller.abort(error);
      throw error;
    }
  };
  const writer = consume([], new Map());
  void writer.catch(() => undefined);
  const emit = (type: MessageType, data: Data, correlation?: string): Promise<void> => new Promise((resolve, reject) => {
    if (queue.destroyed || controller.signal.aborted) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    queue.write({ type, data, correlation, resolve, reject } satisfies Queued);
  });
  const snapshotJournal = (): Promise<Journal> => new Promise((resolve, reject) => {
    if (queue.destroyed || controller.signal.aborted) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    queue.write({ type: 'snapshot', resolve, reject } satisfies Queued);
  });
  type CheckpointTask = Readonly<{ readonly state?: Data; readonly journal: Journal; readonly resolve: () => void; readonly reject: (reason: unknown) => void }>;
  const checkpointQueue = new PassThrough({ objectMode: true });
  const checkpointIterator = checkpointQueue[Symbol.asyncIterator]();
  const checkpointWrite = async (revision: string | null, envelope: string): Promise<CheckpointResponse> => {
    const unsigned = { revision, envelope } as const;
    const body = signed('checkpoint-write', flowId, revision ?? 'null', unsigned);
    const saved = await request<CheckpointResponse>(`/flows/${flowId}/checkpoint`, body);
    if (saved.flow_id !== flowId || saved.runtime_id !== runtimeId || saved.repo_fingerprint !== binding.repositoryFingerprint || saved.client_pubkey !== keys.publicKeyB64 || typeof saved.revision !== 'string') {
      throw new Error('CONVERSATION_BINDING_MISMATCH');
    }
    return saved;
  };
  const persistCheckpoint = async (revision: string | null, phase: Data | null): Promise<void> => {
    const next = await checkpointIterator.next();
    if (next.done) return;
    const task = next.value as CheckpointTask;
    const nextPhase = task.state ?? phase;
    // Before the handoff starts there is no replayable command checkpoint.
    if (nextPhase === null) {
      task.resolve();
      return persistCheckpoint(revision, phase);
    }
    try {
      const expectedRevision = phase === null ? (await checkpoint()).revision : revision;
      const envelope = sealFlowRecoveryCheckpoint(localRoot, flowBinding, {
        v: 1, page_pubkey: pageKey, journal: [...task.journal.values()], ...nextPhase,
      });
      const saved = await checkpointWrite(expectedRevision, envelope).catch(error => error instanceof Error && error.message === 'CONVERSATION_CHECKPOINT_CONFLICT'
        ? Promise.reject(error) : checkpointWrite(expectedRevision, envelope));
      task.resolve();
      return persistCheckpoint(saved.revision, nextPhase);
    } catch (error) {
      task.reject(error);
      incoming.emit('failure', error);
      controller.abort(error);
      throw error;
    }
  };
  const checkpointWriter = persistCheckpoint(null, null);
  void checkpointWriter.catch(() => undefined);
  const enqueueCheckpoint = (state: Data | undefined, journal: Journal): Promise<void> => new Promise((resolve, reject) => {
    if (controller.signal.aborted || checkpointQueue.destroyed) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    checkpointQueue.write({ ...(state === undefined ? {} : { state }), journal, resolve, reject } satisfies CheckpointTask);
  });
  const saveCheckpoint = async (state: Data): Promise<void> => enqueueCheckpoint(state, await snapshotJournal());
  const saveAgentCheckpoint = (state: FlowAgentState): Promise<void> => saveCheckpoint({ phase: 'agent', agent_state: state as unknown as Data });
  await emit('output', { kind: 'welcome', welcome: flowWelcome({
    command: descriptor.command,
    initialized: project.initialized,
    username: identity.user_first_name,
    project: project.projectName,
    organization: identity.organization_name,
    branch: project.activeBranch,
  }), ...rootGoalMetadata });
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
    if (result.state !== 'active') {
      const error = new Error('CONVERSATION_ENDED');
      incoming.emit('failure', error);
      controller.abort(error);
      return;
    }
    return receive(result.cursor);
  };
  const reader = receive(0).catch(error => { if (!controller.signal.aborted) { incoming.emit('failure', error); controller.abort(error); } });
  const ask = async <T>(question: InteractionQuestion<T>, goalMetadata: Data = {}, onPromptEmitted?: () => Promise<void>): Promise<T | null> => {
    const id = randomUUID();
    const answer = new Promise<Data>((resolve, reject) => {
      const failed = (error: unknown): void => { incoming.removeListener(id, answered); reject(error); };
      const answered = (value: Data): void => { incoming.removeListener('failure', failed); resolve(value); };
      incoming.once(id, answered); incoming.once('failure', failed);
      if (controller.signal.aborted) failed(controller.signal.reason);
    });
    await emit('prompt', { question: question.view,
      ...(currentInteractionInvocation() ? { invocation: currentInteractionInvocation() } : {}),
      ...goalMetadata,
      ...(question.presentation === undefined ? {} : { presentation: question.presentation }) }, id);
    await onPromptEmitted?.();
    const payload = await answer;
    const decision = question.decide(payload);
    if ('error' in decision) { await emit('output', { message: decision.error, level: 'error', ...goalMetadata }); return ask(question, goalMetadata); }
    const view = question.view as Readonly<{ input?: Readonly<{ choices?: readonly Readonly<{value: unknown; label: string}>[] }> }>;
    const submitted = payload.value;
    const selectedLabel = Array.isArray(submitted)
      ? view.input?.choices?.filter(choice => submitted.includes(choice.value)).map(choice => choice.label).join(', ')
      : view.input?.choices?.find(choice => Object.is(choice.value, submitted))?.label;
    await emit('output', { message: selectedLabel ?? String(payload.value ?? ''), answer_to: id, value: payload.value, ...goalMetadata });
    return decision.value;
  };
  const rootGoal = new Promise<Data | null>(resolve => incoming.once('root-goal', resolve));
  const rootCompletion = (outcome: Data): boolean => shouldOfferProjectSetup(descriptor.command, outcome);
  const askConfirmation = async (title: string, text: string, goalMetadata: Data = {}, defaultValue = false, onPromptEmitted?: () => Promise<void>): Promise<boolean> => (await ask<boolean>({
    view: { text, input: { kind: 'confirm', default: defaultValue } },
    presentation: { title, component: 'agent-plan' },
    decide: payload => typeof payload.value === 'boolean' ? { value: payload.value } : { error: 'Choose yes or no.' },
  }, goalMetadata, onPromptEmitted)) === true;
  const interaction: Interaction = {
    output: event => emit('output', { ...event, ...rootGoalMetadata, ...(currentInteractionInvocation() ? { invocation: currentInteractionInvocation() } : {}) }),
    progress: event => emit('progress', { ...event, ...rootGoalMetadata, ...(currentInteractionInvocation() ? { invocation: currentInteractionInvocation() } : {}) }),
    prompt: question => ask(question, rootGoalMetadata),
    goal: outcome => rootCompletion(outcome)
      ? (() => { incoming.emit('root-goal', outcome); return Promise.resolve(); })()
      : emit('goal', { ...outcome }),
  };
  try {
    try {
      await runWithInteraction(interaction, operation);
    } catch (error) {
      // Flush buffered CLI output and the command failure through the same
      // encrypted terminal boundary before transport cleanup detaches the CLI.
      if (!controller.signal.aborted) {
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'COMMAND_FAILED';
        const message = error instanceof Error ? error.message : 'The CLI command failed.';
        try {
          await emit('goal', { status: 'failed', code, message, ...rootGoalMetadata });
        } catch {
          // Preserve the original command failure if delivery is unavailable.
        }
      }
      throw error;
    }
    const initial = await Promise.race([rootGoal, Promise.resolve(null)]);
    if (initial) {
      const completedGoal: FlowGoal = { goal_id: 'secrets_setup', goal_name: 'Secrets Setup' };
      const firstOffer: FlowNextOffer = { goal_id: 'project_setup', goal_name: 'Project Setup', prompt: 'Would you like your agent to analyze and configure this project?' };
      await emit('goal_completed', { ...completedGoal, status: 'succeeded', result: initial.result ?? {} });
      await saveCheckpoint({ phase: 'continuation_offer', offer: firstOffer, completed_goal: completedGoal, agent_state: null });
      const accepted = await askConfirmation('Continue with project setup', firstOffer.prompt, completedGoal, true);
      if (!accepted) {
        await emit('goal', { flow: 'init-wizard', goal: 'repository_onboarded', ...completedGoal, status: 'succeeded', result: { continuation_declined: true } });
      } else {
        await emit('progress', { kind: 'goal_start', ...firstOffer });
        const initialAgentState = initialFlowAgentState();
        await saveAgentCheckpoint(initialAgentState);
        const runtime = await attachFlowAgentRuntime({
          flowId,
          ownerId: identity.user_id,
          signal: controller.signal,
          initialState: initialAgentState,
          saveState: saveAgentCheckpoint,
          authenticate: async token => {
            // Authentication is a local attachment preflight, not a browser
            // turn: it must not consume the conversation's long-poll budget.
            const verified = await history(0, pageKey, token, 0);
            return verified.owner === identity.user_id && verified.runtime_id === runtimeId && verified.repo_fingerprint === binding.repositoryFingerprint;
          },
          readHistory: async () => {
            const collect = async (after: number, messages: readonly Message[]): Promise<readonly Message[]> => {
              const page = await history(after, pageKey, undefined, 0);
              const combined = [...messages, ...page.messages];
              return page.messages.length === 100 && page.cursor > after ? collect(page.cursor, combined) : combined;
            };
            const persisted = await collect(0, []);
            const journal = await snapshotJournal();
            return persisted.map(message => {
              if (message.direction === 'cli_to_browser') {
                const entry = journal.get(message.id);
                if (!entry || entry.type !== message.type || entry.envelope !== message.envelope) throw new Error('CONVERSATION_BINDING_MISMATCH');
                return { id: message.id, type: message.type, data: entry.data };
              }
              const opened = openEnvelope({ ciphertextB64: message.envelope, connectionId: `${flowId}:${message.id}`, keypair: keys });
              if (!opened.ok) throw new Error('CONVERSATION_DECRYPTION_FAILED');
              const content = JSON.parse(opened.plaintext) as { readonly v: number; readonly flow_id: string; readonly id: string; readonly correlation_id: string; readonly type: string; readonly data: Data };
              if (content.v !== 1 || content.flow_id !== flowId || content.id !== message.id || content.correlation_id !== message.correlation_id || content.type !== message.type) throw new Error('CONVERSATION_BINDING_MISMATCH');
              return { id: message.id, type: message.type, data: content.data };
            });
          },
          emitOutput: async data => emit('output', data),
          emitProgress: async data => emit('progress', data),
          emitCompleted: async (goal, result) => emit('goal_completed', { ...goal, status: 'succeeded', ...(result === undefined ? {} : { result }) }),
          askPlanApproval: async (goal, plan, onPromptEmitted?: () => Promise<void>) => askConfirmation('Review plan', `Approve this plan for ${goal.goal_name}?`, goal, true, onPromptEmitted),
          askContinuation: async (offer, precedingGoal?: FlowGoal) => askConfirmation('Continue', offer.prompt, precedingGoal ?? {}),
          emitTerminal: async data => emit('goal', data),
          signChallenge: nonce => sign('sha256', Buffer.from(`capy.flow.agent.v1\n${flowId}\n${nonce}`), keys.privateKey).toString('base64'),
        });
        const executable = process.env.CAPY_BIN_NAME ?? (devMode ? 'capy-dev' : 'capy');
        process.stdout.write(`${JSON.stringify({
          ok: true, type: 'agent_handoff', command: descriptor.command, flow_id: flowId, url,
          goal: { id: firstOffer.goal_id, name: firstOffer.goal_name },
          attachment: { command: executable, args: ['flow', '--id', flowId, '--json'], protocol: 'capy.flow.agent.v1' },
          instructions: [
            'Keep this original CLI process running. Attach from the same repository and authenticated account.',
            'If your host supports subagents, delegate this entire Project Setup handoff to one dedicated worker. Give it the repository path, flow_id, attachment command/protocol, requests, approval requirements and these instructions. The worker owns analysis, plan submission, waiting for approval, authorized application, verification and completion in this same flow.',
            'The parent retains ownership: keep the original process alive, track the worker and use bounded waits until a terminal result or an explicit blocker. Continue monitoring during unrelated user discussion. Do not start a second worker or duplicate attachment for the same work; resume the existing worker after an interruption and inspect status/history before continuing.',
            'If subagents are unavailable or cannot remain active, perform the same work directly with bounded reads. A URL, empty read, timeout, submitted plan or dispatched worker is not completion. Do not claim background monitoring unless a worker is actually running.',
            'Send the status and read requests below to inspect current state/history. Analyze repository boundaries and submodules, stack and package managers, run commands, environment loading, services and deployment configuration. Never disclose secret values.',
            'Post structured analysis, then a concrete plan with files, changes, reasons and checks. Wait for its plan-decision in Keep.',
            'After yes, request begin_apply with the returned plan_id and plan_hash. Apply only after receiving application_id; never repeat an application already started.',
            'Keep approval does not override host permission requirements. If the host requires direct user confirmation or rejects an action, surface the exact blocker to the parent/user and retain this flow and approved plan. Do not bypass the restriction or restart onboarding.',
            'Report complete with plan_id, plan_hash, application_id and actual results. Completing Project Setup closes onboarding; if intentionally leaving it unaccomplished, send an explicit terminal skipped outcome with a reason.',
          ],
          requests: {
            status: { id: 'unique-status-request-id', action: 'status' },
            read: { id: 'unique-read-request-id', action: 'read' },
            analysis: { id: 'unique-request-id', action: 'analysis', analysis: { summary: 'Findings', findings: ['Evidence and paths'] } },
            plan: { id: 'unique-plan-request-id', action: 'plan', plan: { plan_id: 'unique-plan-id', summary: 'Proposed setup', files: [{ path: 'relative/path', change: 'Exact change', reason: 'Why' }], checks: ['Planned verification'] } },
            begin_apply: { id: 'unique-apply-request-id', action: 'begin_apply', plan_id: 'returned-plan-id', plan_hash: 'returned-plan-hash' },
            complete: { id: 'unique-completion-id', action: 'complete', plan_id: 'returned-plan-id', plan_hash: 'returned-plan-hash', application_id: 'returned-application-id', result: { summary: 'Actual result', checks: ['Actual check result'] } },
          },
        })}\n`);
        try { await runtime.finished; }
        finally { await runtime.close(); }
      }
    }
    queue.end();
    await writer;
  } finally { checkpointQueue.end(); queue.end(); controller.abort(); await reader; await checkpointWriter; }
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    await detach();
  }
}

type RecoveryCheckpoint = Readonly<{ readonly phase: 'continuation_offer' | 'agent'; readonly offer?: FlowNextOffer; readonly completed_goal?: FlowGoal; readonly agent_state: FlowAgentState | null; readonly journal: readonly JournalEntry[] }>;
type JournalEntry = Readonly<{ readonly id: string; readonly type: MessageType; readonly data: Data; readonly envelope: string }>;
const recoveryCheckpoint = (value: Data): RecoveryCheckpoint | null => {
  const phase = value.phase;
  const agentState = value.agent_state;
  const journal = value.journal;
  const parsedOffer = value.offer !== null && typeof value.offer === 'object' ? value.offer as FlowNextOffer : undefined;
  const completedGoal = value.completed_goal !== null && typeof value.completed_goal === 'object'
    && typeof (value.completed_goal as Data).goal_id === 'string' && typeof (value.completed_goal as Data).goal_name === 'string'
    ? value.completed_goal as FlowGoal : undefined;
  const validJournal = Array.isArray(journal) && journal.every(entry => entry !== null && typeof entry === 'object'
    && typeof (entry as Data).id === 'string' && typeof (entry as Data).type === 'string'
    && typeof (entry as Data).envelope === 'string' && (entry as Data).data !== null && typeof (entry as Data).data === 'object');
  const validState = agentState === null || (typeof agentState === 'object' && !Array.isArray(agentState)
    && typeof (agentState as Data).goal === 'object' && typeof (agentState as Data).approved === 'boolean'
    && typeof (agentState as Data).terminal === 'boolean');
  return (phase === 'continuation_offer' || phase === 'agent') && validJournal && validState
    ? { phase, ...(parsedOffer ? { offer: parsedOffer } : {}), ...(completedGoal ? { completed_goal: completedGoal } : {}), agent_state: agentState as FlowAgentState | null, journal: journal as readonly JournalEntry[] }
    : null;
};

/** Reconnects the encrypted project-setup handoff without replaying the root command. */
export const runResumedFlowInteraction = async (flowId: string, devMode: boolean, abandon = false): Promise<void> => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(flowId)) throw new Error('FLOW_RESUME_INVALID');
  const project = await new ProjectManager().detectProjectState();
  const auth = new AuthService(undefined, devMode, project.userId);
  const identity = await auth.authenticateSilent();
  const root = identity.success && identity.user_id && identity.organization_id ? readLocalRoot(identity.organization_id, identity.user_id) : null;
  if (!identity.success || !identity.user_id || !identity.organization_id || !root) throw new Error('PAIR_REQUIRED');
  const origin = resolveActiveUrl(devMode);
  const runIdentity = resolveInitRunIdentity();
  const bootstrap = loadFlowRecoveryBootstrap(root, {
    flow_id: flowId, origin, owner_id: identity.user_id, organization_id: identity.organization_id, repo_fingerprint: runIdentity.repositoryFingerprint,
  });
  if (!bootstrap) throw new Error('FLOW_RECOVERY_NOT_FOUND');
  const binding = bootstrap.binding;
  const keys = bootstrap.keys;
  const controller = new AbortController();
  const token = async (): Promise<string> => {
    const current = await auth.getValidToken();
    if (!current?.access_token || current.user_id !== identity.user_id) throw new Error('PAIR_REQUIRED');
    return current.access_token;
  };
  const signed = (method: string, id: string, body: Data): Data => ({ ...body,
    proof: sign('sha256', Buffer.from(`capy.conversation.v1\n${method}\n${flowId}\n${id}\n${canonical(body)}`), keys.privateKey).toString('base64') });
  const request = async <T>(path: string, body?: Data, headers: Readonly<Record<string, string>> = {}, tokenOverride?: string): Promise<T> => {
    const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokenOverride ?? await token()}`, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]) });
    const result = await response.json() as T & { readonly code?: string };
    if (!response.ok) throw new Error(result.code ?? 'CONVERSATION_SERVICE_ERROR');
    return result;
  };
  const resumed = await request<Readonly<{ readonly flow_id: string; readonly state: string; readonly cli_attached: boolean; readonly page_pubkey: string | null; readonly cursor: number; readonly expires_at: string; readonly lease_id: string }>>(
    `/flows/${flowId}/resume`, signed('resume', 'resume', { runtime_id: binding.runtime_id, repo_fingerprint: binding.repo_fingerprint }),
  );
  if (resumed.flow_id !== flowId || resumed.state !== 'active' || !resumed.cli_attached || typeof resumed.lease_id !== 'string') throw new Error('FLOW_RESUME_UNAVAILABLE');
  const leaseId = resumed.lease_id;
  if (abandon) {
    await request(`/flows/${flowId}/abandon`, signed('abandon', 'abandon', { lease_id: leaseId }));
    process.stdout.write(`${JSON.stringify({ ok: true, flow_id: flowId, outcome: 'cancelled' })}\n`);
    return;
  }
  type ResumeHistory = History & Readonly<{ readonly cli_attached?: boolean }>;
  const history = async (after: number, pageKey: string | null, waitMs: number, tokenOverride?: string): Promise<ResumeHistory> => {
    const attachedAt = String(Date.now());
    const proof = signed('read', attachedAt, { after, page_key: pageKey ?? 'null', attached_at: attachedAt, lease_id: leaseId }).proof as string;
    const result = await request<ResumeHistory>(`/flows/${flowId}/messages?after=${after}&after_page_pubkey=${encodeURIComponent(pageKey ?? 'null')}&wait_ms=${waitMs}`, undefined, {
      'x-capy-cli-attached-at': attachedAt, 'x-capy-cli-proof': proof, 'x-capy-cli-lease-id': leaseId,
    }, tokenOverride);
    if (result.flow_id !== flowId || result.owner !== identity.user_id || result.runtime_id !== binding.runtime_id || result.repo_fingerprint !== binding.repo_fingerprint || result.client_pubkey !== binding.client_pubkey) throw new Error('CONVERSATION_BINDING_MISMATCH');
    return result;
  };
  const attached = resumed.page_pubkey ? await history(0, resumed.page_pubkey, 0) : await history(0, null, 25_000);
  if (attached.state !== 'active' || !attached.page_pubkey) throw new Error('CONVERSATION_ENDED');
  const checkpointProof = signed('checkpoint-read', 'checkpoint', { lease_id: leaseId }).proof as string;
  const stored = await request<Readonly<{ readonly flow_id: string; readonly runtime_id: string; readonly repo_fingerprint: string; readonly client_pubkey: string; readonly revision: string | null; readonly envelope: string | null }>>(
    `/flows/${flowId}/checkpoint`, undefined, { 'x-capy-cli-proof': checkpointProof, 'x-capy-cli-lease-id': leaseId },
  );
  if (stored.flow_id !== flowId || stored.runtime_id !== binding.runtime_id || stored.repo_fingerprint !== binding.repo_fingerprint || stored.client_pubkey !== binding.client_pubkey || !stored.envelope) throw new Error('FLOW_RECOVERY_CHECKPOINT_UNAVAILABLE');
  const recovered = recoveryCheckpoint(openFlowRecoveryCheckpoint(root, binding, stored.envelope) ?? {});
  if (!recovered || recovered.agent_state?.terminal) throw new Error('FLOW_RECOVERY_CHECKPOINT_INVALID');
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'flow', flow_id: flowId, resumed: true, state: recovered.phase })}\n`);
  // The resumed runtime deliberately does not rerun ordinary CLI work. The persisted
  // agent state blocks a second application grant and lets the agent inspect status.
  const currentState = recovered.agent_state;
  if (recovered.phase === 'agent' && !currentState) throw new Error('FLOW_RECOVERY_CHECKPOINT_INVALID');
  const incoming = new EventEmitter();
  type Delivery = Readonly<{ readonly type: MessageType; readonly data: Data; readonly correlation?: string; readonly resolve: () => void; readonly reject: (reason: unknown) => void }>;
  type DeliverySnapshot = Readonly<{ readonly type: 'snapshot'; readonly resolve: (journal: ReadonlyMap<string, JournalEntry>) => void; readonly reject: (reason: unknown) => void }>;
  const deliveries = new PassThrough({ objectMode: true });
  const deliveryIterator = deliveries[Symbol.asyncIterator]();
  type PreparedAppend = Readonly<{ readonly entry: JournalEntry; readonly body: Data }>;
  const prepareAppend = (type: MessageType, data: Data, correlation?: string): PreparedAppend => {
    const id = randomUUID();
    const correlationId = correlation ?? id;
    const payload = type === 'prompt' || type === 'goal' || type === 'goal_completed'
      ? flowTurnPayload([], { type, data }) : data;
    const content = { v: 1, flow_id: flowId, id, correlation_id: correlationId, type, data: payload };
    const sealed = sealRequestEnvelope({ connectionId: `${flowId}:${id}`, clientPubkeyB64: binding.client_pubkey, pagePubkeyB64: attached.page_pubkey!, payload: JSON.stringify(content) });
    if (!sealed.ok) throw new Error('CONVERSATION_ENCRYPTION_FAILED');
    const unsigned = { v: 1, id, correlation_id: correlationId, direction: 'cli_to_browser', type, envelope: sealed.ciphertextB64, lease_id: leaseId,
      ...((type === 'goal' || type === 'goal_completed') ? { outcome: (payload.outcome as Data | undefined)?.status ?? payload.status } : {}) } as const;
    return { entry: { id, type, data: payload, envelope: sealed.ciphertextB64 }, body: signed('append', id, unsigned) };
  };
  const append = async (prepared: PreparedAppend): Promise<void> => { await request(`/flows/${flowId}/messages`, prepared.body); };
  const consumeDeliveries = async (journal: ReadonlyMap<string, JournalEntry>): Promise<void> => {
    const next = await deliveryIterator.next();
    if (next.done) return;
    const delivery = next.value as Delivery | DeliverySnapshot;
    if (delivery.type === 'snapshot') { delivery.resolve(journal); return consumeDeliveries(journal); }
    try {
      const prepared = prepareAppend(delivery.type, delivery.data, delivery.correlation);
      const nextJournal = new Map([...journal, [prepared.entry.id, prepared.entry]]);
      await saveJournal(nextJournal);
      await append(prepared);
      delivery.resolve();
      return consumeDeliveries(nextJournal);
    } catch (error) { delivery.reject(error); incoming.emit('failure', error); controller.abort(error); throw error; }
  };
  const deliveryWriter = consumeDeliveries(new Map(recovered.journal.map(entry => [entry.id, entry])));
  void deliveryWriter.catch(() => undefined);
  const emit = (type: MessageType, data: Data, correlation?: string): Promise<void> => new Promise((resolve, reject) => {
    if (controller.signal.aborted || deliveries.destroyed) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    deliveries.write({ type, data, correlation, resolve, reject } satisfies Delivery);
  });
  const snapshot = (): Promise<ReadonlyMap<string, JournalEntry>> => new Promise((resolve, reject) => {
    if (controller.signal.aborted || deliveries.destroyed) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    deliveries.write({ type: 'snapshot', resolve, reject } satisfies DeliverySnapshot);
  });
  type SavedState = Readonly<{ readonly phase?: Data; readonly journal: ReadonlyMap<string, JournalEntry>; readonly resolve: () => void; readonly reject: (error: unknown) => void }>;
  const saves = new PassThrough({ objectMode: true });
  const saveIterator = saves[Symbol.asyncIterator]();
  const rawRecoveredPhase: Data = { v: 1, phase: recovered.phase, ...(recovered.offer === undefined ? {} : { offer: recovered.offer }), ...(recovered.completed_goal ? { completed_goal: recovered.completed_goal } : {}), agent_state: recovered.agent_state as unknown as Data };
  const writeSave = async (revision: string | null, phase: Data): Promise<void> => {
    const next = await saveIterator.next();
    if (next.done) return;
    const save = next.value as SavedState;
    try {
      const nextPhase = save.phase ?? phase;
      const envelope = sealFlowRecoveryCheckpoint(root, binding, { ...nextPhase, journal: [...save.journal.values()] });
      const unsigned = { revision, envelope, lease_id: leaseId } as const;
      const saved = await request<Readonly<{ readonly revision: string; readonly flow_id: string; readonly runtime_id: string; readonly repo_fingerprint: string; readonly client_pubkey: string }>>(`/flows/${flowId}/checkpoint`, signed('checkpoint-write', revision ?? 'null', unsigned));
      if (saved.flow_id !== flowId || saved.runtime_id !== binding.runtime_id || saved.repo_fingerprint !== binding.repo_fingerprint || saved.client_pubkey !== binding.client_pubkey) throw new Error('CONVERSATION_BINDING_MISMATCH');
      save.resolve();
      return writeSave(saved.revision, nextPhase);
    } catch (error) { save.reject(error); incoming.emit('failure', error); controller.abort(error); throw error; }
  };
  const saveWriter = writeSave(stored.revision, rawRecoveredPhase);
  void saveWriter.catch(() => undefined);
  const save = async (phase: Data | undefined, journal: ReadonlyMap<string, JournalEntry>): Promise<void> => new Promise((resolve, reject) => {
    if (controller.signal.aborted || saves.destroyed) { reject(new Error('CONVERSATION_TRANSPORT_CLOSED')); return; }
    saves.write({ ...(phase === undefined ? {} : { phase }), journal, resolve, reject } satisfies SavedState);
  });
  const saveState = async (state: FlowAgentState): Promise<void> => {
    const journal = await snapshot();
    return save({ v: 1, phase: 'agent', agent_state: state as unknown as Data }, journal);
  };
  const saveJournal = (journal: ReadonlyMap<string, JournalEntry>): Promise<void> => save(undefined, journal);
  const receive = async (cursor: number): Promise<void> => {
    const result = await history(cursor, attached.page_pubkey, 25_000);
    for (const message of result.messages) {
      if (message.direction !== 'browser_to_cli') continue;
      const opened = openEnvelope({ ciphertextB64: message.envelope, connectionId: `${flowId}:${message.id}`, keypair: keys });
      if (!opened.ok) throw new Error('CONVERSATION_DECRYPTION_FAILED');
      const content = JSON.parse(opened.plaintext) as Readonly<{ readonly v: number; readonly flow_id: string; readonly id: string; readonly correlation_id: string; readonly type: MessageType; readonly data: Data }>;
      if (content.v !== 1 || content.flow_id !== flowId || content.id !== message.id || content.correlation_id !== message.correlation_id || content.type !== message.type) throw new Error('CONVERSATION_BINDING_MISMATCH');
      if (content.type === 'answer') incoming.emit(content.correlation_id, content.data);
      if (content.type === 'ping' && cursor !== 0) await emit('pong', { message: 'CLI is running.' }, content.correlation_id);
    }
    if (result.state !== 'active') { const error = new Error('CONVERSATION_ENDED'); incoming.emit('failure', error); controller.abort(error); return; }
    return receive(result.cursor);
  };
  // Prompts are reissued on recovery, so replaying encrypted answers from zero
  // is safe and prevents a service cursor from hiding an answer after a drop.
  const reader = receive(0).catch(error => { incoming.emit('failure', error); controller.abort(error); });
  const askApproval = async (goal: FlowGoal, plan: Readonly<{ readonly summary: string }>, onPromptEmitted?: () => Promise<void>): Promise<boolean> => {
    const id = randomUUID();
    const answer = new Promise<Data>((resolve, reject) => {
      const failed = (error: unknown): void => { incoming.removeListener(id, answered); reject(error); };
      const answered = (data: Data): void => { incoming.removeListener('failure', failed); resolve(data); };
      incoming.once(id, answered); incoming.once('failure', failed);
    });
    await emit('prompt', { question: { text: `Approve this plan for ${goal.goal_name}?`, input: { kind: 'confirm', default: true } }, presentation: { title: 'Review plan', component: 'agent-plan' }, ...goal }, id);
    await onPromptEmitted?.();
    const value = (await answer).value;
    await emit('output', { message: value === true ? 'Yes' : 'No', answer_to: id, value, ...goal });
    return value === true;
  };
  const askContinuation = async (offer: FlowNextOffer, precedingGoal: Data = {}): Promise<boolean> => {
    const id = randomUUID();
    const answer = new Promise<Data>((resolve, reject) => {
      const failed = (error: unknown): void => { incoming.removeListener(id, answered); reject(error); };
      const answered = (data: Data): void => { incoming.removeListener('failure', failed); resolve(data); };
      incoming.once(id, answered); incoming.once('failure', failed);
    });
    await emit('prompt', { question: { text: offer.prompt, input: { kind: 'confirm', default: true } }, presentation: { title: 'Continue with project setup', component: 'agent-plan' }, ...precedingGoal }, id);
    const value = (await answer).value;
    await emit('output', { message: value === true ? 'Yes' : 'No', answer_to: id, value, ...precedingGoal });
    return value === true;
  };
  const stateForRuntime = async (): Promise<FlowAgentState | null> => {
    if (recovered.phase === 'continuation_offer') {
      if (!recovered.offer) throw new Error('FLOW_RECOVERY_CHECKPOINT_INVALID');
      const accepted = await askContinuation(recovered.offer, recovered.completed_goal ?? {});
      if (!accepted) {
        await emit('goal', { ...(recovered.completed_goal ?? {}), status: recovered.completed_goal ? 'succeeded' : 'skipped', result: { continuation_declined: true } });
        return null;
      }
      await emit('progress', { kind: 'goal_start', ...recovered.offer });
      const state = { ...initialFlowAgentState(), goal: recovered.offer };
      await saveState(state);
      return state;
    }
    const restored = currentState!;
    if (!restored.plan || restored.approved || restored.application_id) return restored;
    const approved = await askApproval(restored.goal, restored.plan, () => saveState(restored));
    if (!approved) {
      await emit('goal', { ...restored.goal, status: 'cancelled', code: 'PLAN_DECLINED', result: { plan_id: restored.plan.plan_id, plan_hash: restored.plan.plan_hash } });
      return null;
    }
    const state = { ...restored, approved: true };
    await saveState(state);
    return state;
  };
  try {
  const resumedState = await stateForRuntime();
  if (!resumedState) return;
  const runtime = await attachFlowAgentRuntime({
    flowId,
    ownerId: identity.user_id,
    signal: controller.signal,
    initialState: resumedState,
    saveState,
    authenticate: async supplied => (await history(0, attached.page_pubkey, 0, supplied)).owner === identity.user_id,
    readHistory: async () => {
      const collect = async (after: number, messages: readonly Message[]): Promise<readonly Message[]> => {
        const page = await history(after, attached.page_pubkey, 0);
        const combined = [...messages, ...page.messages];
        return page.messages.length === 100 && page.cursor > after ? collect(page.cursor, combined) : combined;
      };
      const persisted = await collect(0, []);
      const journal = await snapshot();
      return persisted.flatMap(message => {
        if (message.direction === 'cli_to_browser') {
          const entry = journal.get(message.id);
          // Every delivered record must have its encrypted journal entry saved
          // first. Never silently hide history if that durability invariant fails.
          if (!entry) throw new Error('FLOW_RECOVERY_HISTORY_UNAVAILABLE');
          if (entry.type !== message.type || entry.envelope !== message.envelope) throw new Error('CONVERSATION_BINDING_MISMATCH');
          return [{ id: message.id, type: message.type, data: entry.data }];
        }
        const opened = openEnvelope({ ciphertextB64: message.envelope, connectionId: `${flowId}:${message.id}`, keypair: keys });
        if (!opened.ok) throw new Error('CONVERSATION_DECRYPTION_FAILED');
        const content = JSON.parse(opened.plaintext) as Readonly<{ readonly v: number; readonly flow_id: string; readonly id: string; readonly correlation_id: string; readonly type: MessageType; readonly data: Data }>;
        if (content.v !== 1 || content.flow_id !== flowId || content.id !== message.id || content.correlation_id !== message.correlation_id || content.type !== message.type) throw new Error('CONVERSATION_BINDING_MISMATCH');
        return [{ id: message.id, type: message.type, data: content.data }];
      });
    },
    emitOutput: async data => emit('output', data),
    emitProgress: async data => emit('progress', data),
    emitCompleted: async (goal, result) => emit('goal_completed', { ...goal, status: 'succeeded', ...(result === undefined ? {} : { result }) }),
    askPlanApproval: askApproval,
    askContinuation,
    emitTerminal: async data => emit('goal', data),
    signChallenge: nonce => sign('sha256', Buffer.from(`capy.flow.agent.v1\n${flowId}\n${nonce}`), keys.privateKey).toString('base64'),
  });
  const executable = process.env.CAPY_BIN_NAME ?? (devMode ? 'capy-dev' : 'capy');
  process.stdout.write(`${JSON.stringify({
    ok: true, type: 'agent_handoff', command: 'flow', flow_id: flowId,
    url: `${keepOrigin()}/flow/conversation?f=${encodeURIComponent(flowId)}`,
    attachment: { command: executable, args: ['flow', '--id', flowId, '--json'], protocol: 'capy.flow.agent.v1' },
    instructions: [
      'Keep this resumed CLI process running and attach a single dedicated agent from the same repository and authenticated account.',
      'Inspect status and history before acting. If applying is already recorded, inspect the repository and report its outcome; never request another application grant.',
      'Submit analysis and a plan, wait for approval, then request begin_apply before making changes. Completing Project Setup closes onboarding; if intentionally leaving it unaccomplished, send an explicit terminal skipped outcome with a reason.',
    ],
  })}\n`);
  try { await runtime.finished; }
  finally { await runtime.close(); }
  } finally { saves.end(); deliveries.end(); controller.abort(); await reader; await saveWriter; }
};
