/**
 * `capy pair` device-grant client (CAP-684, docs/basic-pair.md).
 *
 * Mirrors how `authService.ts` already talks to `/auth/initiate` and
 * `/auth/exchange`: a plain `fetch`, not `ServiceClient` — these endpoints
 * are unauthenticated (there is no session yet; that's the point of device
 * grant), and `/auth/device/token` in particular is polled repeatedly and
 * expects a non-2xx response on every "not yet" tick. Routing that through
 * `ServiceClient.request` (which throws a `CapyError` on any non-2xx) would
 * force a try/catch around every poll instead of a plain discriminated
 * result — so this stays a sibling of `postJson`, not a `ServiceClient`
 * method.
 *
 * Server side: `service/src/routes/auth.ts` (`/device/authorize`,
 * `/device/token`) and `service/src/middleware/rateLimit.ts`
 * (`deviceGrantLimiter`), a proxy to WorkOS's own RFC 8628 device
 * authorization grant. `/auth/device/token`'s response is NOT distinguished
 * by HTTP status alone — a still-polling outcome (`authorization_pending`,
 * and `slow_down` from either WorkOS or the rate limiter tripping) is HTTP
 * 200 with `{status:'pending', code}`, matching the route's own convention
 * that polling is not an HTTP error; only a terminal outcome
 * (`expired_token`/`access_denied`) is HTTP 400 with `{status:'denied',
 * code}`. Success carries no `status` field at all — it is exactly
 * `/auth/exchange`'s response shape, structurally distinguishable from
 * "pending" by that field's absence. Every branch below keys off `status`
 * plus `code`, never off HTTP status or message text (cardinal Rule 5) —
 * `authorization_pending`/`slow_down`/`expired_token`/`access_denied` are
 * RFC 8628's own wire vocabulary, a fixed versioned protocol enum, the same
 * way an HTTP status code is.
 */
import type { Organization } from '../types/index';
import { CapyError, ERROR_CODES } from '../types/index';

export interface DeviceAuthorizeResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { ok: res.ok, status: res.status, data };
}

/**
 * Codes this module will surface as-is on a thrown `CapyError`, rather than
 * collapsing to the generic `AUTH_FAILED` — the real set `/device/authorize`
 * and the non-polling branch of `/device/token` can send (`sendError`'s
 * `{error, code}` shape): a malformed request is `INVALID_FORMAT`, anything
 * else server-side is `AUTH_FAILED` itself. Anything outside this set is
 * either the RFC 8628 polling vocabulary (handled separately, never thrown)
 * or unrecognized, and falls back to `AUTH_FAILED` rather than trusting an
 * arbitrary server-supplied string as one of ours.
 */
const KNOWN_DEVICE_GRANT_CODES = new Set<string>([ERROR_CODES.INVALID_FORMAT, ERROR_CODES.AUTH_FAILED]);

function codeOrFallback(data: { code?: unknown }, fallback: string): string {
  return typeof data.code === 'string' && KNOWN_DEVICE_GRANT_CODES.has(data.code) ? data.code : fallback;
}

/** `POST /auth/device/authorize {public_key}` — step 1 of `capy pair`. */
export async function authorizeDevice(apiUrl: string, publicKey: string): Promise<DeviceAuthorizeResult> {
  const { ok, status, data } = await postJson<DeviceAuthorizeResult>(`${apiUrl}/auth/device/authorize`, { public_key: publicKey });
  if (!ok) {
    throw new CapyError(
      typeof data.error === 'string' ? data.error : 'Failed to start device pairing',
      codeOrFallback(data, ERROR_CODES.AUTH_FAILED),
      { status, code: data.code },
    );
  }
  return data;
}

export interface DeviceTokenExchange {
  token: { access_token: string | null; refresh_token: string; expires_in: number };
  user: { id: string; email: string; first_name: string | null; last_name: string | null };
  organizations: Organization[];
}

export type DeviceTokenPoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | ({ status: 'success' } & DeviceTokenExchange);

/** The RFC 8628 wire codes this module branches on — see file header. */
const RFC8628_ERROR = {
  PENDING: 'authorization_pending',
  SLOW_DOWN: 'slow_down',
  EXPIRED: 'expired_token',
  DENIED: 'access_denied',
} as const;

/**
 * The shapes `/auth/device/token` actually answers with — see file header.
 * `status`/`code` cover the pending/denied polling shapes; `token`/`user`/
 * `organizations` cover the success shape (which carries no `status`).
 * Loosely typed on purpose: this is raw, unvalidated JSON off the wire.
 */
interface DeviceTokenResponseBody {
  status?: 'pending' | 'denied';
  code?: string;
  error?: string;
  token?: DeviceTokenExchange['token'];
  user?: DeviceTokenExchange['user'];
  organizations?: Organization[];
}

/** One `POST /auth/device/token` attempt. Never throws for the four expected polling states. */
export async function pollDeviceTokenOnce(apiUrl: string, deviceCode: string): Promise<DeviceTokenPoll> {
  const { status: httpStatus, data } = await postJson<DeviceTokenResponseBody>(`${apiUrl}/auth/device/token`, { device_code: deviceCode });

  // Success is a STRUCTURAL fact, never inferred from the HTTP status alone
  // (pending is ALSO 200): no `status` field, and a token actually arrived.
  if (data.status === undefined && data.token && data.user) {
    return { status: 'success', token: data.token, user: data.user, organizations: data.organizations ?? [] };
  }

  if (data.status === 'pending' && data.code === RFC8628_ERROR.PENDING) return { status: 'pending' };
  if (data.status === 'pending' && data.code === RFC8628_ERROR.SLOW_DOWN) return { status: 'slow_down' };
  if (data.status === 'denied' && data.code === RFC8628_ERROR.EXPIRED) return { status: 'expired' };
  if (data.status === 'denied' && data.code === RFC8628_ERROR.DENIED) return { status: 'denied' };

  throw new CapyError(
    typeof data.error === 'string' ? data.error : 'Device token exchange failed',
    codeOrFallback(data, ERROR_CODES.AUTH_FAILED),
    { status: httpStatus, code: data.code },
  );
}

export interface DevicePollOptions {
  /** ms between polls; bumped by +5s on every `slow_down`, per RFC 8628. */
  intervalMs: number;
  /** Wall-clock budget in ms (from `expires_in`) before giving up as expired. */
  timeoutMs: number;
  /** Injectable for tests — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — defaults to `Date.now`. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `/auth/device/token` until success, expiry, or denial. Recursive
 * rather than a mutated loop counter — each tick is a fresh call with the
 * (possibly slow-down-bumped) interval, never a reassigned variable.
 */
export async function pollDeviceToken(apiUrl: string, deviceCode: string, opts: DevicePollOptions): Promise<DeviceTokenExchange> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;

  const tick = async (intervalMs: number): Promise<DeviceTokenExchange> => {
    if (now() >= deadline) {
      throw new CapyError('Device pairing expired before it was approved', ERROR_CODES.AUTH_FAILED, { reason: RFC8628_ERROR.EXPIRED });
    }
    await sleep(intervalMs);
    const result = await pollDeviceTokenOnce(apiUrl, deviceCode);
    switch (result.status) {
      case 'success':
        return result;
      case 'pending':
        return tick(intervalMs);
      case 'slow_down':
        return tick(intervalMs + 5000);
      case 'expired':
        throw new CapyError('Device pairing expired before it was approved', ERROR_CODES.AUTH_FAILED, { reason: RFC8628_ERROR.EXPIRED });
      case 'denied':
        throw new CapyError('Device pairing was denied', ERROR_CODES.AUTH_FAILED, { reason: RFC8628_ERROR.DENIED });
    }
  };

  return tick(opts.intervalMs);
}
