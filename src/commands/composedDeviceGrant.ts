import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { AuthService } from '../auth/authService';
import { getGlobalCapyDir, readLocalRoot } from '../config/globalConfig';
import { resolveActiveUrl } from '../config/profileConfig';
import { keepOrigin } from '../ui/screens/keepScreens';
import { acquirePairAttemptLease, releasePairAttemptLease } from '../auth/pairing/pairAttemptLease';
import { assertRuntimePairingUser } from '../auth/pairing/runtimePairing';
import {
  capturePairedSessionInstallationBaseline,
  installDeviceAuthenticatedSession,
  type PairedSessionInstallationBaseline,
} from '../auth/pairing/pairedSessionInstallation';
import { buildSessionStoreFromAnswer } from '../auth/pairing/installPairedSession';
import { toAnswerSession, type DeviceAuthorization } from '../auth/pairing/deviceAuth';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { refreshTokenAuthorityDigest } from '../auth/initRunSessionInstaller';
import type { PairMachineAnswerSession } from '../auth/pairing/pairContract';
import type { SessionStore } from '../types/index';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const USER_ID = /^user_[A-Za-z0-9_-]+$/u;
const MAX_CHECKPOINT_BYTES = 512 * 1024;

interface Grant extends DeviceAuthorization {
  readonly flow_id: string;
  readonly keep_url: string;
  readonly expires_at: string;
}

interface IssuedCredentials {
  readonly session: PairMachineAnswerSession;
  readonly identityAccessToken: string;
  readonly attemptId: string;
}

interface Checkpoint {
  readonly version: 1;
  readonly origin: string;
  readonly grant: Grant;
  readonly baseline: PairedSessionInstallationBaseline;
  readonly intervalMs: number;
  readonly pollAfter: number;
  readonly issued?: IssuedCredentials;
  readonly installed?: true;
  readonly authenticated?: true;
}

export interface ComposedAuthenticatedContinuation {
  readonly flowId: string;
  readonly serviceOrigin: string;
  readonly userId: string;
  readonly identityAccessToken: string;
}

class ComposedDeviceGrantError extends Error {
  constructor(readonly code: string) { super(code); }
}

const reject = (code: string): never => { throw new ComposedDeviceGrantError(code); };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};

const saveCheckpoint = (path: string, state: Checkpoint): void => {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(state));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  syncDirectory(directory);
};

const removeCheckpoint = (path: string): void => {
  if (!existsSync(path)) return;
  unlinkSync(path);
  syncDirectory(dirname(path));
};

const readCheckpoint = (path: string): Checkpoint | null => {
  const descriptor = (() => {
    try { return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as Readonly<{ code?: unknown }>).code : null;
      if (code === 'ENOENT') return null;
      return reject('AUTH_LOCAL_STATE_PERMISSIONS');
    }
  })();
  if (descriptor === null) return null;
  try {
    const metadata = fstatSync(descriptor);
    const expectedUser = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.uid !== expectedUser || (metadata.mode & 0o777) !== 0o600
      || metadata.size <= 0 || metadata.size > MAX_CHECKPOINT_BYTES) return reject('AUTH_LOCAL_STATE_PERMISSIONS');
    const bytes = Buffer.alloc(metadata.size + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== metadata.size) return reject('AUTH_LOCAL_STATE_INVALID');
    const parsed = (() => {
      try { return JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown; }
      catch { return null; }
    })();
    return validCheckpoint(parsed) ? parsed : reject('AUTH_LOCAL_STATE_INVALID');
  } finally {
    closeSync(descriptor);
  }
};

const validSession = (value: unknown): value is PairMachineAnswerSession => {
  const session = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  const user = session?.user && typeof session.user === 'object' && !Array.isArray(session.user)
    ? session.user as Readonly<Record<string, unknown>> : null;
  return Boolean(user && typeof user.id === 'string' && USER_ID.test(user.id)
    && typeof user.email === 'string' && user.email.length > 0
    && typeof session?.refresh_token === 'string' && session.refresh_token.length > 0
    && Array.isArray(session.organizations));
};

const validGrant = (value: unknown): value is Grant => {
  const grant = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  return Boolean(grant && typeof grant.device_code === 'string' && grant.device_code.length > 0
    && typeof grant.user_code === 'string' && grant.user_code.length > 0
    && typeof grant.verification_uri === 'string' && grant.verification_uri.length > 0
    && typeof grant.flow_id === 'string' && UUID.test(grant.flow_id)
    && typeof grant.keep_url === 'string' && grant.keep_url.length > 0
    && typeof grant.expires_at === 'string' && Number.isFinite(Date.parse(grant.expires_at))
    && typeof grant.expires_in === 'number' && Number.isFinite(grant.expires_in) && grant.expires_in > 0
    && typeof grant.interval === 'number' && Number.isFinite(grant.interval) && grant.interval >= 1);
};

const validBaseline = (value: unknown): value is PairedSessionInstallationBaseline => {
  const baseline = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  return Boolean(baseline
    && (baseline.expectedUserId === null || typeof baseline.expectedUserId === 'string' && USER_ID.test(baseline.expectedUserId))
    && Array.isArray(baseline.authorities)
    && baseline.authorities.every((authority) => {
      const record = authority && typeof authority === 'object' && !Array.isArray(authority)
        ? authority as Readonly<Record<string, unknown>> : null;
      return Boolean(record && typeof record.userId === 'string' && USER_ID.test(record.userId)
        && (record.refreshAuthoritySha256 === null
          || typeof record.refreshAuthoritySha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.refreshAuthoritySha256)));
    }));
};

function validCheckpoint(value: unknown): value is Checkpoint {
  const state = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  const issued = state?.issued === undefined ? null
    : state.issued && typeof state.issued === 'object' && !Array.isArray(state.issued)
      ? state.issued as Readonly<Record<string, unknown>> : null;
  return Boolean(state && state.version === 1 && typeof state.origin === 'string'
    && validGrant(state.grant) && validBaseline(state.baseline)
    && typeof state.intervalMs === 'number' && Number.isFinite(state.intervalMs) && state.intervalMs >= 1000
    && typeof state.pollAfter === 'number' && Number.isFinite(state.pollAfter)
    && (issued === null || validSession(issued.session)
      && typeof issued.identityAccessToken === 'string' && issued.identityAccessToken.length > 0
      && typeof issued.attemptId === 'string' && UUID.test(issued.attemptId))
    && (state.installed === undefined || state.installed === true)
    && (state.authenticated === undefined || state.authenticated === true)
    && (!state.installed || issued !== null) && (!state.authenticated || state.installed));
}

const exactSession = (left: SessionStore | null, right: SessionStore): boolean =>
  left !== null && JSON.stringify(left) === JSON.stringify(right);

const installIssuedSession = async (state: Checkpoint): Promise<Checkpoint> => {
  const issued = state.issued ?? reject('AUTH_CREDENTIALS_MISSING');
  const expected = buildSessionStoreFromAnswer(issued.session);
  assertRuntimePairingUser(expected.user_id);
  if (state.baseline.expectedUserId !== null && state.baseline.expectedUserId !== expected.user_id) {
    return reject('AUTH_ACCOUNT_MISMATCH');
  }
  const backend = new FileSessionStorageBackend();
  const current = backend.load(expected.user_id);
  if (state.installed && state.authenticated && current?.user_id === expected.user_id
    && current.identity_session?.root_authority_sha256 === refreshTokenAuthorityDigest(expected)) return state;
  const alreadyInstalled = (() => {
    try { return exactSession(backend.load(expected.user_id), expected); }
    catch { return reject('AUTH_SESSION_INSTALLATION_REFUSED'); }
  })();
  if (!alreadyInstalled) {
    try { await installDeviceAuthenticatedSession(expected, state.baseline); }
    catch { return reject('AUTH_SESSION_INSTALLATION_REFUSED'); }
  }
  try {
    if (!exactSession(backend.load(expected.user_id), expected)) return reject('AUTH_SESSION_INSTALLATION_REFUSED');
  } catch { return reject('AUTH_SESSION_INSTALLATION_REFUSED'); }
  return state.installed ? state : { ...state, installed: true };
};

const request = (origin: string, route: string, body: unknown, bearer?: string): Promise<Response> =>
  fetch(`${origin}${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

const responseRecord = async (response: Response): Promise<Readonly<Record<string, unknown>> | null> => {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Readonly<Record<string, unknown>> : null;
  } catch { return null; }
};

const validateGrantOrigins = (grant: Grant, origin: string): void => {
  try {
    const expectedKeepOrigin = new URL(keepOrigin()).origin;
    const keepUrl = new URL(grant.keep_url);
    if (new URL(origin).origin !== origin || keepUrl.protocol !== 'https:' || keepUrl.origin !== expectedKeepOrigin
      || keepUrl.pathname !== '/flow/authentication' || keepUrl.searchParams.get('f') !== grant.flow_id
      || keepUrl.searchParams.get('compose') !== 'signup') return reject('AUTH_DEVICE_RESPONSE_INVALID');
  } catch { return reject('AUTH_DEVICE_RESPONSE_INVALID'); }
};

const startGrant = async (
  origin: string,
  path: string,
  expectedUserId?: string,
): Promise<Checkpoint> => {
  const baseline = capturePairedSessionInstallationBaseline(expectedUserId ?? null);
  const response = await request(origin, '/auth/device/authorize', { compose: 'signup', machine_name: hostname() })
    .catch(() => reject('AUTH_DEVICE_START_FAILED'));
  const body = await responseRecord(response);
  if (!response.ok || !validGrant(body)) return reject(
    typeof body?.code === 'string' ? body.code : 'AUTH_DEVICE_START_FAILED',
  );
  validateGrantOrigins(body, origin);
  const expiry = Date.parse(body.expires_at);
  if (expiry <= Date.now() || expiry > Date.now() + 15 * 60_000) return reject('AUTH_DEVICE_RESPONSE_INVALID');
  const state: Checkpoint = {
    version: 1, origin, grant: body, baseline,
    intervalMs: body.interval * 1000,
    pollAfter: Date.now() + body.interval * 1000,
  };
  saveCheckpoint(path, state);
  return state;
};

const pollGrant = async (
  path: string,
  state: Checkpoint,
  expectedUserId?: string,
): Promise<Checkpoint> => {
  if (state.issued) return state;
  if (Date.now() >= Date.parse(state.grant.expires_at)) return reject('AUTH_FLOW_EXPIRED');
  await sleep(Math.max(0, state.pollAfter - Date.now()));
  const next = { ...state, pollAfter: Date.now() + state.intervalMs };
  // A restart after a request never polls sooner than the provider allows.
  saveCheckpoint(path, next);
  const outcome = await request(state.origin, '/auth/device/token', {
    device_code: state.grant.device_code,
    flow_id: state.grant.flow_id,
  }).then(async (response) => ({ response, body: await responseRecord(response) })).catch(() => null);
  if (!outcome) return pollGrant(path, next, expectedUserId);
  const { response, body } = outcome;
  if (body?.error === 'authorization_pending') return pollGrant(path, next, expectedUserId);
  if (body?.error === 'slow_down' || response.status === 429) {
    const slowed = { ...next, intervalMs: next.intervalMs + 5000, pollAfter: next.pollAfter + 5000 };
    saveCheckpoint(path, slowed);
    return pollGrant(path, slowed, expectedUserId);
  }
  if (response.status >= 500) return pollGrant(path, next, expectedUserId);
  if (!response.ok || !body) {
    const code = body?.code === 'AUTH_ACCOUNT_MISMATCH' ? 'AUTH_ACCOUNT_MISMATCH'
      : body?.error === 'access_denied' ? 'AUTH_ACCESS_DENIED'
      : body?.error === 'expired_token' || body?.code === 'AUTH_FLOW_UNAVAILABLE'
        && Date.now() >= Date.parse(state.grant.expires_at) ? 'AUTH_FLOW_EXPIRED'
      : 'AUTH_DEVICE_EXCHANGE_FAILED';
    return reject(code);
  }
  const session = { ...toAnswerSession(body as Record<string, unknown>), sessions: undefined };
  if (body.status !== 'complete' || typeof body.identity_access_token !== 'string' || !body.identity_access_token
    || typeof body.attempt_id !== 'string' || !UUID.test(body.attempt_id)
    || !validSession(session)) return reject('AUTH_CREDENTIALS_MISSING');
  const expected = expectedUserId ?? state.baseline.expectedUserId;
  if (expected !== null && expected !== undefined && session.user.id !== expected) {
    return reject('AUTH_ACCOUNT_MISMATCH');
  }
  const issued: Checkpoint = { ...next, issued: {
    session, identityAccessToken: body.identity_access_token, attemptId: body.attempt_id,
  } };
  // The provider grant is consumable. Persist its normalized result before installation.
  saveCheckpoint(path, issued);
  return issued;
};

const acknowledgeAuthentication = async (path: string, state: Checkpoint): Promise<Checkpoint> => {
  if (state.authenticated) return state;
  const issued = state.issued ?? reject('AUTH_CREDENTIALS_MISSING');
  const outcome = await request(state.origin, `/flows/authentication/${state.grant.flow_id}/complete`,
    { attemptId: issued.attemptId }, issued.identityAccessToken)
    .then(async (response) => ({ response, body: await responseRecord(response) })).catch(() => null);
  if (!outcome) return reject('AUTH_COMPLETION_PENDING');
  const { response, body } = outcome;
  if (!response.ok) {
    const code = body?.code === 'AUTH_FLOW_EXPIRED' ? 'AUTH_FLOW_EXPIRED'
      : body?.code === 'AUTH_ACCOUNT_MISMATCH' ? 'AUTH_ACCOUNT_MISMATCH'
      : response.status >= 500 ? 'AUTH_COMPLETION_PENDING' : 'AUTH_COMPLETION_NOT_ACKNOWLEDGED';
    return reject(code);
  }
  if (body?.stage !== 'authenticated' || body.user_id !== issued.session.user.id
    || body.flow_id !== state.grant.flow_id) return reject('AUTH_COMPLETION_INVALID');
  const authenticated = { ...state, authenticated: true };
  saveCheckpoint(path, authenticated);
  return authenticated;
};

const continuationOf = (state: Checkpoint): ComposedAuthenticatedContinuation => {
  const issued = state.issued ?? reject('AUTH_CREDENTIALS_MISSING');
  if (!state.installed || !state.authenticated) return reject('AUTH_COMPLETION_PENDING');
  return {
    flowId: state.grant.flow_id,
    serviceOrigin: state.origin,
    userId: issued.session.user.id,
    identityAccessToken: issued.identityAccessToken,
  };
};

/** Existing account-scoped custody is enough; a file alone is not authentication. */
async function reuseExistingCustody(origin: string, expectedUserId?: string): Promise<boolean> {
  // Do not silently pick an arbitrary account from a multi-account runtime.
  const sessionsDirectory = join(getGlobalCapyDir(), 'auth', 'sessions');
  if (!expectedUserId && !existsSync(join(getGlobalCapyDir(), 'auth', 'session.json'))
    && existsSync(sessionsDirectory)
    && readdirSync(sessionsDirectory).filter((name) => name.endsWith('.json')).length > 1) return false;
  const auth = new AuthService(origin, false, expectedUserId);
  await auth.authenticateSilent();
  const token = await auth.getValidToken();
  if (!token) {
    const failure = auth.getLastRefreshFailure();
    if (failure && failure.reason !== 'session_ended') return reject('AUTH_SESSION_CHECK_FAILED');
    return false;
  }
  if (expectedUserId && token.user_id !== expectedUserId) return reject('AUTH_ACCOUNT_MISMATCH');
  assertRuntimePairingUser(token.user_id);
  const localKey = readLocalRoot(token.organization_id, token.user_id);
  if (!localKey) return false;
  // Validate the current account and organization against the configured service.
  const response = await fetch(`${origin}/orgs/${encodeURIComponent(token.organization_id)}/signup-readiness`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) return false;
  if (!response.ok) return reject('AUTH_SESSION_CHECK_FAILED');
  console.log(JSON.stringify({ ok: true, stage: 'custody_ready', user_id: token.user_id,
    org_id: token.organization_id, custody: 'filesystem', reused: true }));
  return true;
}

/** CLI-first WorkOS grant. Browser custody stays in the composed Keep caller. */
export async function runComposedDeviceGrant(
  resumeFlowId?: string,
  expectedUserId?: string,
): Promise<number> {
  if (resumeFlowId !== undefined && !UUID.test(resumeFlowId)
    || expectedUserId !== undefined && !USER_ID.test(expectedUserId)) {
    console.log(JSON.stringify({ ok: false, code: 'AUTH_ARGUMENT_INVALID' }));
    return 1;
  }
  const origin = new URL(resolveActiveUrl()).origin;
  const path = join(getGlobalCapyDir(), 'auth', 'composed-device-grant.json');
  const lease = acquirePairAttemptLease();
  try {
    const previous = readCheckpoint(path);
    if (!previous && !resumeFlowId && await reuseExistingCustody(origin, expectedUserId)) return 0;
    if (previous && previous.origin !== origin) return reject('AUTH_ENVIRONMENT_MISMATCH');
    if (previous?.baseline.expectedUserId && expectedUserId
      && previous.baseline.expectedUserId !== expectedUserId) return reject('AUTH_ACCOUNT_MISMATCH');
    if (previous?.issued && expectedUserId && previous.issued.session.user.id !== expectedUserId) {
      return reject('AUTH_ACCOUNT_MISMATCH');
    }
    const state = previous ?? await startGrant(origin, path, expectedUserId);
    console.log(JSON.stringify({
      ok: true, stage: state.authenticated ? 'authenticated' : 'approval_pending',
      flow_id: state.grant.flow_id,
      url: `${state.grant.keep_url}${resumeFlowId ? `&resume=${resumeFlowId}` : ''}`,
      userCode: state.grant.user_code,
      expiresAt: state.grant.expires_at,
    }));
    const issued = await pollGrant(path, state, expectedUserId);
    const installed = await installIssuedSession(issued);
    if (installed !== issued) saveCheckpoint(path, installed);
    const authenticated = await acknowledgeAuthentication(path, installed);
    const continuation = continuationOf(authenticated);
    // Section 5 consumes this in process. Never serialize its bearer.
    const { continueComposedCustody } = await import('../auth/pairing/composedCustody');
    const custody = await continueComposedCustody(continuation);
    if (custody.kind !== 'complete') return reject(custody.code);
    removeCheckpoint(path);
    console.log(JSON.stringify({ ok: true, stage: 'custody_ready', flow_id: continuation.flowId,
      user_id: continuation.userId, org_id: custody.orgId, custody: 'filesystem' }));
    return 0;
  } catch (error) {
    const code = error instanceof ComposedDeviceGrantError ? error.code
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z_]{1,80}$/u.test(error.code) ? error.code
      : error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message
      : 'AUTH_DEVICE_GRANT_FAILED';
    if (['AUTH_FLOW_EXPIRED', 'AUTH_ACCESS_DENIED'].includes(code)) {
      try { removeCheckpoint(path); } catch { /* retain the primary coded outcome */ }
    }
    console.log(JSON.stringify({ ok: false, code }));
    return 1;
  } finally {
    releasePairAttemptLease(lease);
  }
}
