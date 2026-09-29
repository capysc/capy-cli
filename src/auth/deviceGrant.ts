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
 * Server side: `service/src/auth/deviceGrant.ts`, a proxy to WorkOS's own
 * RFC 8628 device authorization grant. The codes branched on below —
 * `authorization_pending`, `slow_down`, `expired_token`, `access_denied` —
 * are that RFC's own wire vocabulary, not prose: cardinal Rule 5 (never
 * branch on human-readable strings) is satisfied by them being a fixed,
 * versioned protocol enum, the same way an HTTP status code is.
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

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

/** `POST /auth/device/authorize {public_key}` — step 1 of `capy pair`. */
export async function authorizeDevice(apiUrl: string, publicKey: string): Promise<DeviceAuthorizeResult> {
  const { ok, status, data } = await postJson<DeviceAuthorizeResult>(`${apiUrl}/auth/device/authorize`, { public_key: publicKey });
  if (!ok) {
    throw new CapyError(
      typeof data.error === 'string' ? data.error : 'Failed to start device pairing',
      ERROR_CODES.AUTH_FAILED,
      { status },
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

/** One `POST /auth/device/token` attempt. Never throws for the four expected polling states. */
export async function pollDeviceTokenOnce(apiUrl: string, deviceCode: string): Promise<DeviceTokenPoll> {
  const { ok, status, data } = await postJson<DeviceTokenExchange>(`${apiUrl}/auth/device/token`, { device_code: deviceCode });
  if (ok) {
    return { status: 'success', token: data.token, user: data.user, organizations: data.organizations || [] };
  }
  switch (data.error) {
    case RFC8628_ERROR.PENDING:
      return { status: 'pending' };
    case RFC8628_ERROR.SLOW_DOWN:
      return { status: 'slow_down' };
    case RFC8628_ERROR.EXPIRED:
      return { status: 'expired' };
    case RFC8628_ERROR.DENIED:
      return { status: 'denied' };
    default:
      throw new CapyError(
        typeof data.error === 'string' ? data.error : 'Device token exchange failed',
        ERROR_CODES.AUTH_FAILED,
        { status },
      );
  }
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
