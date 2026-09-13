/**
 * CAP-652 Section 5 — deliver the composed Keep caller's existing K_local to
 * the exact CLI which completed its device grant.
 *
 * The broker is only an opaque, single-use relay. Its private connection key
 * stays in this process and the plaintext result is accepted only when its
 * flow, account, and repository-bound target agree with the authenticated
 * grant. `local.key` is then written through the established exclusive
 * filesystem custody primitive and read back before the CLI acknowledges.
 */
import { timingSafeEqual } from 'crypto';
import { hostname } from 'os';
import { readLocalRoot, saveLocalRootExclusive } from '../../config/globalConfig';
import { BrokerClient, type AwaitAnswerResult } from '../../service/brokerClient';
import { AuthService } from '../authService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID = /^user_[A-Za-z0-9_-]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ContinueComposedCustodyInput {
  readonly flowId: string;
  readonly serviceOrigin: string;
  readonly userId: string;
  readonly identityAccessToken: string;
}

export type ComposedCustodyResult =
  | { readonly kind: 'complete'; readonly flowId: string; readonly orgId: string }
  | { readonly kind: 'retryable'; readonly code: 'BROKER_UNAVAILABLE' | 'DELIVERY_TIMEOUT' }
  | { readonly kind: 'denied'; readonly code: 'AUTH_FLOW_EXPIRED' | 'AUTH_FLOW_CONFLICT' | 'CUSTODY_REJECTED' }
  | { readonly kind: 'indeterminate'; readonly code: 'CUSTODY_ACKNOWLEDGEMENT_UNCONFIRMED' | 'CUSTODY_FILESYSTEM_UNVERIFIED' };

interface DeliveredCustodyPayload {
  readonly v: 1;
  readonly flowId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly kLocal: string;
}

function validOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.protocol === 'https:' ? parsed.origin : null;
  } catch { return null; }
}

function validInput(input: ContinueComposedCustodyInput): boolean {
  return UUID.test(input.flowId) && USER_ID.test(input.userId) && input.identityAccessToken.length > 0
    && validOrigin(input.serviceOrigin) !== null;
}

function parseDeliveredPayload(value: string, input: ContinueComposedCustodyInput): DeliveredCustodyPayload | null {
  const payload = (() => {
    try { return JSON.parse(value) as unknown; }
    catch { return null; }
  })();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Readonly<Record<string, unknown>>;
  if (Object.keys(candidate).length !== 5 || candidate.v !== 1 || candidate.flowId !== input.flowId
    || candidate.userId !== input.userId || typeof candidate.orgId !== 'string' || !UUID.test(candidate.orgId)
    || typeof candidate.kLocal !== 'string' || !B64.test(candidate.kLocal)) return null;
  const kLocal = Buffer.from(candidate.kLocal, 'base64');
  return kLocal.byteLength === 32 && kLocal.toString('base64') === candidate.kLocal
    ? { v: 1, flowId: candidate.flowId, userId: candidate.userId, orgId: candidate.orgId, kLocal: candidate.kLocal }
    : null;
}

async function request(
  origin: string,
  path: string,
  token: string,
  body: Readonly<Record<string, string>>,
): Promise<Response | null> {
  try {
    return await fetch(`${origin}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { return null; }
}

async function bindDelivery(
  input: ContinueComposedCustodyInput,
  connectionId: string,
): Promise<'bound' | 'expired' | 'conflict' | 'unavailable'> {
  const response = await request(input.serviceOrigin, `/flows/authentication/${input.flowId}/custody`, await custodyToken(input),
    { connection_id: connectionId });
  if (response === null) return 'unavailable';
  if (response.status === 410) return 'expired';
  if (response.status === 409 || response.status === 404 || response.status === 401) return 'conflict';
  return response.ok ? 'bound' : 'unavailable';
}

async function acknowledgeDelivery(
  input: ContinueComposedCustodyInput,
  connectionId: string,
  deadline = Date.now() + 900_000,
): Promise<'acknowledged' | 'expired' | 'conflict' | 'unavailable'> {
  const response = await request(input.serviceOrigin, `/flows/authentication/${input.flowId}/custody/ack`, await custodyToken(input),
    { connection_id: connectionId });
  if (response === null || response.status === 429 || response.status >= 500) {
    const retryAfter = response?.headers.get('retry-after');
    const delay = retryAfter && /^\d+$/.test(retryAfter)
      ? Math.max(1000, Number(retryAfter) * 1000) : 5000;
    if (Date.now() + delay >= deadline) return 'unavailable';
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return acknowledgeDelivery(input, connectionId, deadline);
  }
  if (response.status === 410) return 'expired';
  if (response.status === 409 || response.status === 404 || response.status === 401) return 'conflict';
  return response.ok ? 'acknowledged' : 'unavailable';
}

function brokerOutcome(result: AwaitAnswerResult): ComposedCustodyResult | null {
  if (result.kind === 'timeout') return { kind: 'retryable', code: 'DELIVERY_TIMEOUT' };
  if (result.kind === 'network' || result.kind === 'service') return { kind: 'retryable', code: 'BROKER_UNAVAILABLE' };
  if (result.kind === 'expired') return { kind: 'denied', code: 'AUTH_FLOW_EXPIRED' };
  if (result.kind === 'consumed' || result.kind === 'bad_envelope') return { kind: 'denied', code: 'CUSTODY_REJECTED' };
  return null;
}

function persistAndVerify(payload: DeliveredCustodyPayload): boolean {
  const kLocal = Buffer.from(payload.kLocal, 'base64');
  saveLocalRootExclusive(payload.orgId, kLocal, payload.userId);
  const stored = readLocalRoot(payload.orgId, payload.userId);
  return stored !== null && stored.byteLength === kLocal.byteLength && timingSafeEqual(stored, kLocal);
}

/**
 * Runs only after the CLI's own WorkOS device credentials are installed and
 * `/complete` has recorded their session id. No caller may acknowledge a
 * send; only a verified read of the protected filesystem custody path does.
 */
export async function continueComposedCustody(input: ContinueComposedCustodyInput): Promise<ComposedCustodyResult> {
  if (!validInput(input)) return { kind: 'denied', code: 'CUSTODY_REJECTED' };
  const broker = new BrokerClient(input.serviceOrigin, () => custodyToken(input));
  const previousResponse = await fetch(`${input.serviceOrigin}/flows/authentication/${input.flowId}`, {
    headers: { Authorization: `Bearer ${await custodyToken(input)}` }, redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!previousResponse.ok) return { kind: 'denied', code: 'AUTH_FLOW_CONFLICT' };
  const previous = await previousResponse.json() as {
    readonly flow_id?: string;
    readonly user_id?: string;
    readonly custody?: { readonly connection_id?: string; readonly acknowledged_at?: string };
  };
  if (previous.flow_id !== input.flowId || previous.user_id !== input.userId || previous.custody?.acknowledged_at) {
    return { kind: 'denied', code: 'AUTH_FLOW_CONFLICT' };
  }
  if (previous.custody?.connection_id && UUID.test(previous.custody.connection_id)) {
    await broker.cancel(previous.custody.connection_id);
  }
  const connection = await (async () => {
    try {
      return await broker.createConnection({ purpose: 'signup.k_local', machineName: hostname(), ttlSeconds: 900 });
    } catch { return null; }
  })();
  if (!connection) return { kind: 'retryable', code: 'BROKER_UNAVAILABLE' };
  const binding = await bindDelivery(input, connection.connectionId);
  if (binding !== 'bound') {
    await broker.cancel(connection.connectionId);
    return binding === 'expired'
      ? { kind: 'denied', code: 'AUTH_FLOW_EXPIRED' }
      : binding === 'conflict'
        ? { kind: 'denied', code: 'AUTH_FLOW_CONFLICT' }
        : { kind: 'retryable', code: 'BROKER_UNAVAILABLE' };
  }
  const answer = await broker.awaitAnswer(connection, { deadlineMs: 900_000, waitSeconds: 25 });
  const terminal = brokerOutcome(answer);
  if (terminal) return terminal;
  if (answer.kind !== 'answered') return { kind: 'indeterminate', code: 'CUSTODY_FILESYSTEM_UNVERIFIED' };
  const payload = parseDeliveredPayload(answer.plaintext, input);
  if (!payload || !persistAndVerify(payload)) return { kind: 'indeterminate', code: 'CUSTODY_FILESYSTEM_UNVERIFIED' };
  const acknowledgement = await acknowledgeDelivery(input, connection.connectionId);
  return acknowledgement === 'acknowledged'
    ? { kind: 'complete', flowId: input.flowId, orgId: payload.orgId }
    : acknowledgement === 'expired'
      ? { kind: 'denied', code: 'AUTH_FLOW_EXPIRED' }
      : acknowledgement === 'conflict'
        ? { kind: 'denied', code: 'AUTH_FLOW_CONFLICT' }
        : { kind: 'indeterminate', code: 'CUSTODY_ACKNOWLEDGEMENT_UNCONFIRMED' };
}

async function custodyToken(input: ContinueComposedCustodyInput): Promise<string> {
  const current = (() => {
    try {
      const claims = JSON.parse(Buffer.from(input.identityAccessToken.split('.')[1], 'base64url').toString()) as {
        readonly sub?: string; readonly exp?: number;
      };
      return claims.sub === input.userId && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 30_000;
    } catch { return false; }
  })();
  if (current) return input.identityAccessToken;
  const auth = new AuthService(input.serviceOrigin, false, input.userId);
  const renewed = await auth.renewInitRunIdentity({ userId: input.userId, deadline: Date.now() + 30_000 });
  return renewed.accessToken;
}
