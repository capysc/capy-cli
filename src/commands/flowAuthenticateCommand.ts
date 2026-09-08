/** A typed local executor, not a flow owner. No browser, prompt, PRF, or setup. */
import { createHash, randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getGlobalCapyDir } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { buildSessionStoreFromAnswer } from '../auth/pairing/installPairedSession';
import { assertRuntimePairingUser } from '../auth/pairing/runtimePairing';
import { acquirePairAttemptLease, releasePairAttemptLease } from '../auth/pairing/pairAttemptLease';
import { startDeviceAuthorization, deviceVerificationHandoff, toAnswerSession } from '../auth/pairing/deviceAuth';
import type { PairMachineAnswerSession } from '../auth/pairing/pairContract';

export interface FlowAuthenticationOptions {
  readonly expectedUserId: string;
  readonly serviceOrigin: string;
  readonly onboardFlowId?: string;
  readonly json?: boolean;
}
interface PublicHandoff {
  readonly attemptId: string;
  readonly deviceCodeHash: string;
  readonly url: string;
  readonly userCode: string;
  readonly expiresAt: string;
}
export interface AuthenticationCheckpoint {
  readonly version: 1;
  readonly flowId: string;
  readonly userId: string;
  readonly apiUrl: string;
  readonly handoff: PublicHandoff;
  readonly deviceCode: string;
  readonly intervalMs: number;
  readonly pollAfter: number;
  readonly issued?: { readonly session: PairMachineAnswerSession; readonly bearer: string };
  readonly installed?: true;
  readonly completed?: true;
}
export interface AuthenticationExecutorDependencies {
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly request: typeof fetch;
  readonly start: typeof startDeviceAuthorization;
  readonly read: () => AuthenticationCheckpoint | null;
  readonly save: (state: AuthenticationCheckpoint) => void;
  readonly remove: () => void;
  readonly assertUser: (userId: string) => void;
  readonly install: (session: PairMachineAnswerSession) => void;
  readonly hasInstalledSession?: (userId: string) => boolean;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class AuthenticationExecutorError extends Error {
  constructor(readonly code: string) { super(code); }
}
const reject = (code: string): never => { throw new AuthenticationExecutorError(code); };

/** Deliberate projection: never serialize a checkpoint, device code, or token. */
function awaiting(state: AuthenticationCheckpoint) {
  return { ok: true, flow_id: state.flowId, stage: 'approval_pending', handoff: state.handoff,
    continuation: { tool: 'capy_authenticate', args: { flow_id: state.flowId, handoff: state.handoff } },
  } as const;
}

async function finish(state: AuthenticationCheckpoint, deps: AuthenticationExecutorDependencies) {
  const issued = state.issued;
  if (!issued || issued.session.user.id !== state.userId) return reject('AUTH_ACCOUNT_MISMATCH');
  deps.assertUser(state.userId);
  if (!state.installed) {
    deps.install(issued.session);
    deps.save({ ...state, installed: true });
  }
  const response = await deps.request(`${state.apiUrl}/flows/authentication/${state.flowId}/complete`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.bearer}` },
    body: JSON.stringify({ attemptId: state.handoff.attemptId }),
  });
  if (!response.ok) return reject('AUTH_COMPLETION_NOT_ACKNOWLEDGED');
  const body = await response.json() as { stage?: unknown; user_id?: unknown };
  if (body.stage !== 'authenticated' || body.user_id !== state.userId) return reject('AUTH_COMPLETION_INVALID');
  // Retain only a retry receipt. No reusable credential survives beside the session file.
  deps.save({ ...state, deviceCode: '', issued: undefined, installed: undefined, completed: true });
  return { ok: true, flow_id: state.flowId, stage: 'authenticated', user_id: state.userId,
    continuation: { tool: 'capy_authenticate', args: { flow_id: state.flowId } },
  } as const;
}

async function poll(state: AuthenticationCheckpoint, deps: AuthenticationExecutorDependencies, deadline: number): Promise<ReturnType<typeof awaiting> | Awaited<ReturnType<typeof finish>>> {
  if (state.issued) return finish(state, deps);
  if (deps.now() >= Date.parse(state.handoff.expiresAt)) return reject('AUTH_FLOW_EXPIRED');
  if (state.pollAfter >= deadline) return awaiting(state);
  await deps.wait(Math.max(0, state.pollAfter - deps.now()));
  // Checkpoint the next legal poll BEFORE the request, including across process exit.
  const next = { ...state, pollAfter: deps.now() + state.intervalMs };
  deps.save(next);
  const response = await deps.request(`${state.apiUrl}/auth/device/token`, {
    redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - deps.now()))),
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: state.deviceCode, flow_id: state.flowId }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (body.error === 'authorization_pending' || body.error === 'slow_down') {
    const pending = body.error === 'slow_down'
      ? { ...next, intervalMs: next.intervalMs + 5000, pollAfter: next.pollAfter + 5000 } : next;
    deps.save(pending);
    return poll(pending, deps, deadline);
  }
  if (!response.ok) {
    const code = body.code === 'AUTH_ACCOUNT_MISMATCH' ? 'AUTH_ACCOUNT_MISMATCH'
      : body.error === 'access_denied' ? 'AUTH_ACCESS_DENIED'
      : body.error === 'expired_token' ? 'AUTH_FLOW_EXPIRED' : 'AUTH_DEVICE_EXCHANGE_FAILED';
    return reject(code);
  }
  // Identity-only sign-in does not select an org or guess which membership owns
  // an access token. Existing session refresh obtains org-scoped tokens later.
  const session = { ...toAnswerSession(body), sessions: undefined };
  if (body.status !== 'complete' || typeof body.identity_access_token !== 'string'
    || !body.identity_access_token || !session.refresh_token || !session.user.email) return reject('AUTH_CREDENTIALS_MISSING');
  if (session.user.id !== state.userId) return reject('AUTH_ACCOUNT_MISMATCH');
  const issued = { ...next, issued: { session, bearer: body.identity_access_token } };
  // Crash recovery after issuance retries installation/ack, not a consumed device grant.
  deps.save(issued);
  return finish(issued, deps);
}

export async function executeFlowAuthentication(flowId: string, options: FlowAuthenticationOptions, deps: AuthenticationExecutorDependencies) {
  if (!UUID.test(flowId) || !/^user_[A-Za-z0-9]+$/.test(options.expectedUserId)
    || (options.onboardFlowId !== undefined && !UUID.test(options.onboardFlowId))) return reject('AUTH_ARGUMENT_INVALID');
  const apiUrl = new URL(options.serviceOrigin).origin;
  const parsedOrigin = new URL(apiUrl);
  // The existing Development rig uses HTTP inside its encrypted tailnet.
  const localHttp = parsedOrigin.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)
    || parsedOrigin.hostname.endsWith('.ts.net'));
  if (apiUrl !== options.serviceOrigin || (parsedOrigin.protocol !== 'https:' && !localHttp)) return reject('AUTH_ENVIRONMENT_MISMATCH');
  deps.assertUser(options.expectedUserId);
  const existing = deps.read();
  if (existing) {
    if (existing.version !== 1 || existing.flowId !== flowId || existing.userId !== options.expectedUserId
      || existing.apiUrl !== apiUrl || !existing.handoff) return reject('AUTH_LOCAL_STATE_INVALID');
    if (existing.completed) {
      if (!deps.hasInstalledSession?.(existing.userId)) return reject('AUTH_LOCAL_SESSION_MISSING');
      return { ok: true, flow_id: flowId, stage: 'authenticated' as const, user_id: existing.userId,
        continuation: { tool: 'capy_authenticate' as const, args: { flow_id: flowId } } };
    }
    if (!Number.isFinite(existing.pollAfter)
      || !Number.isFinite(existing.intervalMs) || existing.intervalMs < 1000
      || existing.handoff.deviceCodeHash !== hash(existing.deviceCode)) return reject('AUTH_LOCAL_STATE_INVALID');
    return poll(existing, deps, deps.now() + 20_000);
  }
  const authorization = await deps.start(apiUrl);
  if (!authorization.device_code || !Number.isFinite(authorization.expires_in) || authorization.expires_in <= 0
    || authorization.expires_in > 900 || !Number.isFinite(authorization.interval) || authorization.interval < 1) {
    return reject('AUTH_DEVICE_RESPONSE_INVALID');
  }
  const handoff = deviceVerificationHandoff(authorization);
  const state: AuthenticationCheckpoint = {
    version: 1, flowId, userId: options.expectedUserId, apiUrl,
    handoff: { attemptId: randomUUID(), deviceCodeHash: hash(authorization.device_code),
      url: handoff.url, userCode: handoff.userCode, expiresAt: new Date(deps.now() + authorization.expires_in * 1000).toISOString() },
    deviceCode: authorization.device_code, intervalMs: authorization.interval * 1000,
    pollAfter: deps.now() + authorization.interval * 1000,
  };
  deps.save(state);
  return awaiting(state);
}

function assertLocalUser(userId: string): void {
  assertRuntimePairingUser(userId);
  const backend = new FileSessionStorageBackend();
  const existing = backend.discover();
  const legacy = backend.load(undefined);
  if ((existing && existing.userId !== userId) || (legacy && legacy.user_id !== userId)) reject('AUTH_LOCAL_ACCOUNT_MISMATCH');
}

/** Local protected-state adapter reused by the single instrumented readiness command. */
export async function executeLocalFlowAuthentication(flowId: string, options: FlowAuthenticationOptions) {
  if (!UUID.test(flowId) || (options.onboardFlowId !== undefined && !UUID.test(options.onboardFlowId))) {
    return reject('AUTH_ARGUMENT_INVALID');
  }
  const apiUrl = new URL(resolveActiveUrl()).origin;
  if (apiUrl !== options.serviceOrigin) return reject('AUTH_ENVIRONMENT_MISMATCH');
  const path = join(getGlobalCapyDir(), 'auth', 'authentication-flows', `${flowId}.json`);
  const lease = acquirePairAttemptLease();
  try {
    const result = await executeFlowAuthentication(flowId, options, {
      now: Date.now, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), request: fetch,
      start: startDeviceAuthorization, assertUser: assertLocalUser,
      hasInstalledSession: (userId) => {
        const session = new FileSessionStorageBackend().load(userId);
        return session?.user_id === userId && Boolean(session.refresh_token);
      },
      install: (session) => new FileSessionStorageBackend().save(buildSessionStoreFromAnswer(session), session.user.id),
      read: () => {
        if (!existsSync(path)) return null;
        const stat = lstatSync(path);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) return reject('AUTH_LOCAL_STATE_PERMISSIONS');
        return JSON.parse(readFileSync(path, 'utf8')) as AuthenticationCheckpoint;
      },
      save: (state) => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      },
      remove: () => { if (existsSync(path)) unlinkSync(path); },
    });
    return result;
  } finally { releasePairAttemptLease(lease); }
}

export async function runFlowAuthenticateCommand(flowId: string, options: FlowAuthenticationOptions): Promise<number> {
  try {
    const result = await executeLocalFlowAuthentication(flowId, options);
    console.log(JSON.stringify(projectAuthenticationResult(result, options.onboardFlowId)));
    return 0;
  } catch (error) {
    // Provider bodies, exceptions, and file contents can contain secrets. Coded errors only.
    console.log(JSON.stringify({ ok: false, flow_id: flowId,
      code: error instanceof AuthenticationExecutorError ? error.code : 'AUTH_EXECUTOR_FAILED' }));
    return 1;
  }
}

export function projectAuthenticationResult(
  result: Awaited<ReturnType<typeof executeFlowAuthentication>>,
  onboardFlowId?: string,
) {
  if (onboardFlowId === undefined) return result;
  if (!UUID.test(onboardFlowId)) return reject('AUTH_ARGUMENT_INVALID');
  return { ...result, continuation: { tool: 'capy_onboard', args: {
    flow_id: onboardFlowId,
    ...(result.stage === 'approval_pending' ? { authentication_handoff: result.handoff } : {}),
  } } } as const;
}
