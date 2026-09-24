import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Writable } from 'node:stream';

type Json = Readonly<Record<string, unknown>>;
export type FlowGoal = Readonly<{ readonly goal_id: string; readonly goal_name: string }>;
export type FlowAgentAnalysis = Readonly<{ readonly summary: string; readonly findings: readonly string[] }>;
export type FlowAgentPlan = Readonly<{
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly summary: string;
  readonly files: readonly Readonly<{ readonly path: string; readonly change: string; readonly reason: string }>[];
  readonly checks: readonly string[];
}>;
export type FlowAgentResult = Readonly<{ readonly summary: string; readonly checks: readonly string[] }>;
export type FlowNextOffer = FlowGoal & Readonly<{ readonly prompt: string }>;

export type FlowAgentRequest = Readonly<{
  readonly v: 1;
  readonly id: string;
  readonly action: 'status' | 'read' | 'analysis' | 'plan' | 'begin_apply' | 'complete' | 'terminal';
  readonly token: string;
  readonly analysis?: FlowAgentAnalysis;
  readonly plan?: FlowAgentPlan;
  readonly plan_id?: string;
  readonly plan_hash?: string;
  readonly application_id?: string;
  readonly result?: FlowAgentResult;
  readonly next_offer?: FlowNextOffer;
  readonly outcome?: 'failed' | 'cancelled';
  readonly code?: string;
}>;
type AgentResponse = Json;
type Replay = Readonly<{ readonly id: string; readonly body: string; readonly response: AgentResponse }>;
export type FlowAgentState = Readonly<{ readonly goal: FlowGoal; readonly completedGoalIds: readonly string[]; readonly plan: FlowAgentPlan | null; readonly approved: boolean; readonly application_id: string | null; readonly terminal: boolean; readonly replays: readonly Replay[] }>;
type State = FlowAgentState;

export type FlowAgentRuntimeInput = Readonly<{
  readonly flowId: string;
  readonly ownerId: string;
  readonly socketPath?: string;
  readonly signal?: AbortSignal;
  /** Uses the connecting caller's bearer token with the live runtime proof. */
  readonly authenticate: (token: string) => Promise<boolean>;
  /** Decrypts persisted records only when the local caller explicitly asks. */
  readonly readHistory: () => Promise<readonly Json[]>;
  readonly emitOutput: (data: Json) => Promise<void>;
  readonly emitProgress: (data: Json) => Promise<void>;
  readonly emitCompleted: (goal: FlowGoal, result?: Json) => Promise<void>;
  readonly askPlanApproval: (goal: FlowGoal, plan: FlowAgentPlan) => Promise<boolean>;
  readonly askContinuation: (offer: FlowNextOffer) => Promise<boolean>;
  readonly emitTerminal: (data: Json) => Promise<void>;
  readonly signChallenge: (nonce: string) => string;
}>;

export type FlowAgentRuntime = Readonly<{ readonly socketPath: string; readonly finished: Promise<void>; readonly close: () => Promise<void> }>;

const record = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
const strings = (value: unknown): readonly string[] | null => Array.isArray(value) && value.every(item => string(item) !== null) ? value as readonly string[] : null;
const goal = (value: unknown): FlowGoal | null => {
  const candidate = record(value);
  const goalId = string(candidate?.goal_id);
  const goalName = string(candidate?.goal_name);
  return goalId && goalName ? { goal_id: goalId, goal_name: goalName } : null;
};
const analysis = (value: unknown): FlowAgentAnalysis | null => {
  const candidate = record(value);
  const summary = string(candidate?.summary);
  const findings = strings(candidate?.findings);
  return summary && findings ? { summary, findings } : null;
};
const plan = (value: unknown): FlowAgentPlan | null => {
  const candidate = record(value);
  const planId = string(candidate?.plan_id);
  const planHash = candidate?.plan_hash === undefined ? null : string(candidate.plan_hash);
  const summary = string(candidate?.summary);
  const checks = strings(candidate?.checks);
  const files = Array.isArray(candidate?.files) ? candidate.files.map(file => {
    const entry = record(file);
    const path = string(entry?.path);
    const change = string(entry?.change);
    const reason = string(entry?.reason);
    return path && change && reason ? { path, change, reason } : null;
  }) : null;
  return planId && summary && checks && files && files.every(file => file !== null)
    ? { plan_id: planId, plan_hash: planHash ?? flowAgentPlanHash({ plan_id: planId, plan_hash: '', summary, files: files as readonly Readonly<{ readonly path: string; readonly change: string; readonly reason: string }>[], checks }), summary, files: files as readonly Readonly<{ readonly path: string; readonly change: string; readonly reason: string }>[], checks }
    : null;
};
const result = (value: unknown): FlowAgentResult | null => {
  const candidate = record(value);
  const summary = string(candidate?.summary);
  const checks = strings(candidate?.checks);
  return summary && checks ? { summary, checks } : null;
};
const offer = (value: unknown): FlowNextOffer | null => {
  const candidateGoal = goal(value);
  const prompt = string(record(value)?.prompt);
  return candidateGoal && prompt ? { ...candidateGoal, prompt } : null;
};
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(',')}}`
  : JSON.stringify(value);
const reply = (socket: Writable, body: AgentResponse): Promise<void> => new Promise(resolve => {
  if (socket.destroyed) { resolve(); return; }
  socket.write(`${JSON.stringify(body)}\n`, () => resolve());
});
const currentUid = (): number => process.getuid?.() ?? -1;
const socketDirectory = (): string => join('/tmp', `capy-flow-agent-${currentUid()}`);
const socketPathFor = (flowId: string): string => join(socketDirectory(), `${flowId.replace(/[^A-Za-z0-9_-]/gu, '')}.sock`);
const requestError = (id: string | null, code: string): AgentResponse => ({ v: 1, ...(id ? { id } : {}), ok: false, code });
const success = (id: string, body: Json = {}): AgentResponse => ({ v: 1, id, ok: true, ...body });

const parseRequest = (value: unknown): FlowAgentRequest | null => {
  const candidate = record(value);
  const id = string(candidate?.id);
  const token = string(candidate?.token);
  const action = candidate?.action;
  const parsedAnalysis = analysis(candidate?.analysis);
  const parsedPlan = plan(candidate?.plan);
  const parsedResult = result(candidate?.result);
  const parsedOffer = offer(candidate?.next_offer);
  return candidate?.v === 1 && id && token && (action === 'status' || action === 'read' || action === 'analysis' || action === 'plan' || action === 'begin_apply' || action === 'complete' || action === 'terminal')
    && (action !== 'analysis' || parsedAnalysis !== null)
    && (action !== 'plan' || parsedPlan !== null)
    && (action !== 'complete' || parsedResult !== null)
    && (action !== 'terminal' || candidate?.outcome === 'failed' || candidate?.outcome === 'cancelled')
    && (candidate?.next_offer === undefined || parsedOffer !== null)
    ? { v: 1, id, token, action,
      ...(parsedAnalysis ? { analysis: parsedAnalysis } : {}),
      ...(parsedPlan ? { plan: parsedPlan } : {}),
      ...(string(candidate?.plan_id) ? { plan_id: string(candidate?.plan_id)! } : {}),
      ...(string(candidate?.plan_hash) ? { plan_hash: string(candidate?.plan_hash)! } : {}),
      ...(string(candidate?.application_id) ? { application_id: string(candidate?.application_id)! } : {}),
      ...(parsedResult ? { result: parsedResult } : {}),
      ...(parsedOffer ? { next_offer: parsedOffer } : {}),
      ...(candidate?.outcome === 'failed' || candidate?.outcome === 'cancelled' ? { outcome: candidate.outcome } : {}),
      ...(string(candidate?.code) ? { code: string(candidate?.code)! } : {}),
    } : null;
};

const replay = (state: State, request: FlowAgentRequest, body: string): Readonly<{ readonly state: State; readonly response: AgentResponse }> | null => {
  const prior = state.replays.find(item => item.id === request.id);
  return prior === undefined ? null : prior.body === body
    ? { state, response: prior.response }
    : { state, response: requestError(request.id, 'DUPLICATE_ID_BODY_MISMATCH') };
};
const remembered = (state: State, request: FlowAgentRequest, body: string, response: AgentResponse, patch: Partial<Omit<State, 'replays'>> = {}): State => ({
  ...state,
  ...patch,
  replays: [...state.replays, { id: request.id, body, response }],
});
export const flowAgentPlanHash = (value: FlowAgentPlan): string => createHash('sha256').update(canonical({ summary: value.summary, files: value.files, checks: value.checks })).digest('hex');

export const processFlowAgentRequest = async (state: State, request: FlowAgentRequest, body: string, input: FlowAgentRuntimeInput): Promise<Readonly<{ readonly state: State; readonly response: AgentResponse }>> => {
  if (!(await input.authenticate(request.token).catch(() => false))) return { state, response: requestError(request.id, 'FLOW_ATTACHMENT_FORBIDDEN') };
  const duplicate = replay(state, request, body);
  if (duplicate) return duplicate;
  if (request.action === 'status') {
    const response = success(request.id, { flow_id: input.flowId, goal: state.goal, state: state.terminal ? 'terminal' : state.application_id ? 'applying' : state.approved ? 'approved' : 'awaiting_approval', approved_plan: state.approved && state.plan ? { plan_id: state.plan.plan_id, plan_hash: state.plan.plan_hash } : null, ...(state.application_id ? { application_id: state.application_id } : {}) });
    return { state: remembered(state, request, body, response), response };
  }
  if (request.action === 'read') {
    const history = await input.readHistory();
    const response = success(request.id, { flow_id: input.flowId, history });
    return { state: remembered(state, request, body, response), response };
  }
  if (state.terminal) return { state, response: requestError(request.id, 'FLOW_TERMINAL') };
  if (request.action === 'analysis') {
    await input.emitOutput({ kind: 'analysis', ...state.goal, analysis: request.analysis! });
    const response = success(request.id, { accepted: 'analysis' });
    return { state: remembered(state, request, body, response), response };
  }
  if (request.action === 'terminal') {
    await input.emitTerminal({ ...state.goal, status: request.outcome!, ...(request.code ? { code: request.code } : {}) });
    const response = success(request.id, { outcome: request.outcome });
    return { state: remembered(state, request, body, response, { terminal: true }), response };
  }
  if (request.action === 'plan') {
    if (state.application_id) return { state, response: requestError(request.id, 'APPLY_ALREADY_STARTED') };
    const submitted = request.plan!;
    if (submitted.plan_hash !== flowAgentPlanHash(submitted)) return { state, response: requestError(request.id, 'PLAN_HASH_MISMATCH') };
    await input.emitProgress({ kind: 'plan', ...state.goal, plan: submitted, plan_id: submitted.plan_id, plan_hash: submitted.plan_hash });
    const approved = await input.askPlanApproval(state.goal, submitted);
    const response = success(request.id, { type: 'plan-decision', decision: approved ? 'yes' : 'no', plan_id: submitted.plan_id, plan_hash: submitted.plan_hash });
    if (!approved) {
      await input.emitTerminal({ ...state.goal, status: 'cancelled', code: 'PLAN_DECLINED', result: { plan_id: submitted.plan_id, plan_hash: submitted.plan_hash } });
      return { state: remembered(state, request, body, response, { plan: submitted, approved: false, application_id: null, terminal: true }), response };
    }
    return { state: remembered(state, request, body, response, { plan: submitted, approved: true, application_id: null }), response };
  }
  if (request.action === 'begin_apply') {
    const matches = state.approved && state.plan !== null && request.plan_id === state.plan.plan_id && request.plan_hash === state.plan.plan_hash;
    if (!matches) return { state, response: requestError(request.id, 'PLAN_NOT_APPROVED') };
    if (state.application_id) return { state, response: requestError(request.id, 'APPLY_ALREADY_STARTED') };
    const applicationId = randomUUID();
    await input.emitProgress({ kind: 'apply_started', ...state.goal, plan_id: state.plan.plan_id, plan_hash: state.plan.plan_hash, application_id: applicationId });
    const response = success(request.id, { application_id: applicationId, authorization: 'granted' });
    return { state: remembered(state, request, body, response, { application_id: applicationId }), response };
  }
  const approved = state.approved && state.plan !== null && request.plan_id === state.plan.plan_id && request.plan_hash === state.plan.plan_hash;
  if (!approved || !state.application_id || request.application_id !== state.application_id) return { state, response: requestError(request.id, 'APPLICATION_NOT_AUTHORIZED') };
  if (request.next_offer && (request.next_offer.goal_id === state.goal.goal_id || state.completedGoalIds.includes(request.next_offer.goal_id))) return { state, response: requestError(request.id, 'GOAL_ID_REUSED') };
  const completedResult = { ...request.result!, plan_id: state.plan.plan_id, plan_hash: state.plan.plan_hash, application_id: state.application_id };
  await input.emitProgress({ kind: 'apply_result', ...state.goal, result: completedResult });
  await input.emitCompleted(state.goal, completedResult);
  if (!request.next_offer) {
    await input.emitTerminal({ ...state.goal, status: 'succeeded', result: completedResult });
    const response = success(request.id, { outcome: 'succeeded' });
    return { state: remembered(state, request, body, response, { terminal: true }), response };
  }
  const accepted = await input.askContinuation(request.next_offer);
  if (!accepted) {
    await input.emitTerminal({ ...state.goal, status: 'succeeded', result: { continuation_declined: true } });
    const response = success(request.id, { outcome: 'succeeded', continuation: 'declined' });
    return { state: remembered(state, request, body, response, { terminal: true }), response };
  }
  await input.emitProgress({ kind: 'goal_start', ...request.next_offer });
  const response = success(request.id, { continuation: 'accepted', goal: request.next_offer });
  return { state: remembered(state, request, body, response, { goal: request.next_offer, completedGoalIds: [...state.completedGoalIds, state.goal.goal_id], plan: null, approved: false, application_id: null }), response };
};

const readJson = async (line: string): Promise<unknown> => {
  try { return JSON.parse(line) as unknown; }
  catch { return null; }
};
const bodyWithoutToken = (value: unknown): string => {
  const candidate = record(value);
  return canonical(candidate === null ? value : Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'token')));
};
const challenge = (value: unknown, flowId: string): Readonly<{ readonly nonce: string }> | null => {
  const candidate = record(value);
  const nonce = string(candidate?.nonce);
  return candidate?.v === 1 && candidate.action === 'challenge' && candidate.flow_id === flowId && nonce !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce)
    ? { nonce }
    : null;
};
const serveLines = async (socket: Socket, iterator: AsyncIterator<string>, state: State, input: FlowAgentRuntimeInput): Promise<State> => {
  const next = await iterator.next().catch(() => null);
  if (!next || next.done) return state;
  const raw = await readJson(next.value);
  const requestedChallenge = challenge(raw, input.flowId);
  if (requestedChallenge) {
    await reply(socket, { v: 1, ok: true, flow_id: input.flowId, nonce: requestedChallenge.nonce, signature: input.signChallenge(requestedChallenge.nonce) });
    return serveLines(socket, iterator, state, input);
  }
  const request = parseRequest(raw);
  const body = bodyWithoutToken(raw);
  if (!request) {
    await reply(socket, requestError(null, 'FLOW_AGENT_REQUEST_INVALID'));
    return serveLines(socket, iterator, state, input);
  }
  const processed = await processFlowAgentRequest(state, request, body, input);
  await reply(socket, processed.response);
  return processed.state.terminal ? processed.state : serveLines(socket, iterator, processed.state, input);
};
const serve = (socket: Socket, state: State, input: FlowAgentRuntimeInput): Promise<State> =>
  serveLines(socket, createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator](), state, input);
const privateDirectory = (): string => {
  const directory = socketDirectory();
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.uid !== currentUid() || (stats.mode & 0o077) !== 0) throw new Error('FLOW_ATTACHMENT_DIRECTORY_UNSAFE');
  return directory;
};

/** A same-user local attachment. The socket has no authority without a valid bearer token. */
export const attachFlowAgentRuntime = async (input: FlowAgentRuntimeInput): Promise<FlowAgentRuntime> => {
  privateDirectory();
  const socketPath = input.socketPath ?? socketPathFor(input.flowId);
  if (existsSync(socketPath)) throw new Error('FLOW_ATTACHMENT_ALREADY_RUNNING');
  const server = createServer();
  const connections = new PassThrough({ objectMode: true });
  const iterator = connections[Symbol.asyncIterator]();
  const stopping = new AbortController();
  const close = async (): Promise<void> => {
    stopping.abort();
    connections.end();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    if (existsSync(socketPath)) unlinkSync(socketPath);
  };
  const consume = async (state: State): Promise<void> => {
    const next = await iterator.next();
    if (next.done || stopping.signal.aborted) return;
    const socket = next.value as Socket;
    if (socket.destroyed) return consume(state);
    const nextState = await serve(socket, state, input).catch(async error => {
      if (!stopping.signal.aborted) await input.emitTerminal({ ...state.goal, status: 'failed', code: 'FLOW_AGENT_ERROR' });
      if (stopping.signal.aborted) return { ...state, terminal: true };
      throw error;
    });
    socket.end();
    if (nextState.terminal) return;
    return consume(nextState);
  };
  server.on('connection', socket => {
    const disconnect = (): void => { socket.destroy(); };
    stopping.signal.addEventListener('abort', disconnect, { once: true });
    socket.once('close', () => stopping.signal.removeEventListener('abort', disconnect));
    socket.on('error', disconnect);
    if (stopping.signal.aborted) disconnect();
    else connections.write(socket);
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, () => resolve()).once('error', reject));
  chmodSync(socketPath, 0o600);
  const abort = (): void => { void close(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const finished = consume(initialFlowAgentState()).finally(async () => {
    input.signal?.removeEventListener('abort', abort);
    await close();
  });
  return { socketPath, finished, close };
};

export const flowAgentSocketPath = socketPathFor;
export const initialFlowAgentState = (): FlowAgentState => ({ goal: { goal_id: 'project_setup', goal_name: 'Project Setup' }, completedGoalIds: [], plan: null, approved: false, application_id: null, terminal: false, replays: [] });
