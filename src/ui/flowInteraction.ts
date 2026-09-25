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
import { attachFlowAgentRuntime, type FlowGoal, type FlowNextOffer } from './flowAgentBridge';

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
  readonly project: string | undefined;
  readonly organization: string | undefined;
  readonly branch: string | null;
}>): Readonly<{ readonly username: null; readonly project: string | null; readonly organization: string | null; readonly branch: string | null; readonly flowName: string }> => ({
  username: null,
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
  if (!identity.success || !identity.user_id || !identity.organization_id
    || !readLocalRoot(identity.organization_id, identity.user_id)) {
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
  const incoming = new EventEmitter();
  // The runtime's plaintext journal is never persisted. It lets an explicit,
  // authenticated local read join acknowledged service records to their local
  // structured payloads; the page decrypts the corresponding envelopes.
  type JournalEntry = Readonly<{ readonly id: string; readonly type: MessageType; readonly data: Data; readonly envelope: string }>;
  type Journal = ReadonlyMap<string, JournalEntry>;
  const append = async (type: MessageType, data: Data, correlationId?: string): Promise<JournalEntry> => {
    const id = randomUUID();
    const correlation = correlationId ?? id;
    const content = { v: 1, flow_id: flowId, id, correlation_id: correlation, type, data };
    const sealed = sealRequestEnvelope({ connectionId: `${flowId}:${id}`, clientPubkeyB64: keys.publicKeyB64, pagePubkeyB64: pageKey, payload: JSON.stringify(content) });
    if (!sealed.ok) throw new Error('CONVERSATION_ENCRYPTION_FAILED');
    const body = signed('append', flowId, id, { v: 1, id, correlation_id: correlation, direction: 'cli_to_browser', type, envelope: sealed.ciphertextB64,
      ...((type === 'goal' || type === 'goal_completed') ? {outcome: (data.outcome as Data | undefined)?.status ?? data.status} : {}) });
    await request(`/flows/${flowId}/messages`, body);
    return { id, type, data, envelope: sealed.ciphertextB64 };
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
    const entry = await append(write.type, write.data, write.correlation);
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
  await emit('output', { kind: 'welcome', welcome: flowWelcome({
    command: descriptor.command,
    initialized: project.initialized,
    project: project.projectName,
    organization: identity.organization_name,
    branch: project.activeBranch,
  }) });
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
  const ask = async <T>(question: InteractionQuestion<T>, goalMetadata: Data = {}): Promise<T | null> => {
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
  const askConfirmation = async (title: string, text: string, goalMetadata: Data = {}, defaultValue = false): Promise<boolean> => (await ask<boolean>({
    view: { text, input: { kind: 'confirm', default: defaultValue } },
    presentation: { title, component: 'agent-plan' },
    decide: payload => typeof payload.value === 'boolean' ? { value: payload.value } : { error: 'Choose yes or no.' },
  }, goalMetadata)) === true;
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
      const accepted = await askConfirmation('Continue with project setup', firstOffer.prompt, {}, true);
      if (!accepted) {
        await emit('goal', { flow: 'init-wizard', goal: 'repository_onboarded', ...completedGoal, status: 'succeeded', result: { continuation_declined: true } });
      } else {
        await emit('progress', { kind: 'goal_start', ...firstOffer });
        const runtime = await attachFlowAgentRuntime({
          flowId,
          ownerId: identity.user_id,
          signal: controller.signal,
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
          askPlanApproval: async (goal, plan) => askConfirmation('Review plan', `Approve this plan for ${goal.goal_name}?`, goal, true),
          askContinuation: async offer => askConfirmation('Continue', offer.prompt),
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
            'Send the status and read requests below to inspect current state/history. Analyze repository boundaries and submodules, stack and package managers, run commands, environment loading, services and deployment configuration. Never disclose secret values.',
            'Post structured analysis, then a concrete plan with files, changes, reasons and checks. Wait for its plan-decision in Keep.',
            'After yes, request begin_apply with the returned plan_id and plan_hash. Apply only after receiving application_id; never repeat an application already started.',
            'Report complete with plan_id, plan_hash, application_id and actual results, or terminal failed/cancelled. A next_offer is optional and requires user acceptance before another goal is appended.',
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
  } finally { queue.end(); controller.abort(); await reader; }
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    await detach();
  }
}
