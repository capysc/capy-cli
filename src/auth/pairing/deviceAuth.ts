/**
 * CAP-566 — RFC 8628 device authorization, driven by the CLI.
 *
 * Replaces the session half of `capy pair`. The old ceremony had an
 * already-signed-in device seal ITS OWN session and send it here, and
 * `installPairedSession` wrote those tokens verbatim — so this machine
 * inherited the approver's `client_id` and classified as `browser`, which
 * `requireCliClient()` then refused at invite blob fetch, co-decrypt and
 * pickup consume. Here the machine polls for its OWN tokens, issued to the
 * client that started the flow, so it is CLI-kind by construction.
 *
 * Both legs go through the SERVICE, never `api.workos.com` directly: the
 * service holds the client id (so this binary cannot pass the wrong one) and
 * WorkOS traffic stays server-side for IP-whitelisting (service
 * `routes/auth.ts:359`).
 */
import type { PairMachineAnswerSession } from './pairContract';

/** The authorize leg's response — `interval` and `expires_in` are AUTHORITATIVE. */
export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}

/**
 * The RFC's coded poll outcomes. Control flow keys off these values only —
 * never on `error_description`, which is prose for humans and free to change.
 */
export type DevicePollError = 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';

export interface DevicePollPending {
  readonly status: 'pending';
  readonly error: 'authorization_pending' | 'slow_down';
}
export interface DevicePollDenied {
  readonly status: 'denied';
  readonly error: DevicePollError;
}
export interface DevicePollComplete {
  readonly status: 'complete';
  readonly session: PairMachineAnswerSession;
}
export type DevicePollResult = DevicePollPending | DevicePollDenied | DevicePollComplete;

/** Starts the flow. The returned `user_code` is what the human types; `device_code` is never shown. */
export async function startDeviceAuthorization(apiUrl: string): Promise<DeviceAuthorization> {
  const response = await fetch(`${apiUrl}/auth/device/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`Could not start device authorization (HTTP ${response.status}).`);
  }
  return (await response.json()) as DeviceAuthorization;
}

/**
 * One poll. A pending answer is a NORMAL outcome, not an error, so it comes
 * back as a value rather than a throw — the loop below reads `status`.
 */
export async function pollDeviceToken(apiUrl: string, deviceCode: string): Promise<DevicePollResult> {
  const response = await fetch(`${apiUrl}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  const error = typeof body?.error === 'string' ? body.error : null;
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { status: 'pending', error };
  }
  if (error === 'expired_token' || error === 'access_denied') {
    return { status: 'denied', error };
  }
  if (!response.ok || !body) {
    throw new Error(`Device authorization failed (HTTP ${response.status}).`);
  }

  // A pending poll is ALSO HTTP 200 — the loop needs that to keep polling —
  // so a 200 proves nothing on its own. Success is asserted from the
  // TOKENS being present, never from the status code and never from the
  // `status` discriminator alone: a body that claims complete but carries no
  // credentials must not install an empty session and report success. That
  // "succeeded with nothing" shape is the exact failure this ticket exists
  // to remove, so it is refused here rather than propagated.
  const session = toAnswerSession(body);
  const hasTokens = session.refresh_token.length > 0 && Object.keys(session.sessions ?? {}).length > 0;
  if (body.status !== 'complete' || !hasTokens) {
    throw new Error('Device authorization returned no credentials.');
  }

  return { status: 'complete', session };
}

/**
 * Adapts the service's auth response into the shape the ONE existing session
 * writer already takes (`installPairedSession`), so the on-disk session is
 * written by the same code path as every other sign-in — this changes where
 * the tokens come from, never how they are stored.
 */
export function toAnswerSession(body: Record<string, unknown>): PairMachineAnswerSession {
  const token = (body.token ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number };
  const user = (body.user ?? {}) as { id: string; email: string; first_name: string | null; last_name: string | null };
  const organizations = Array.isArray(body.organizations) ? body.organizations : [];

  const firstOrg = organizations[0] as { id?: string } | undefined;
  const sessions =
    token.access_token && firstOrg?.id
      ? {
          [firstOrg.id]: {
            access_token: token.access_token,
            expires_at: Date.now() + (token.expires_in ?? 0) * 1000,
          },
        }
      : undefined;

  return {
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
    refresh_token: token.refresh_token ?? '',
    organizations: organizations as PairMachineAnswerSession['organizations'],
    sessions,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface AwaitDeviceOptions {
  /** Injected in tests; defaults to real time. */
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Polls until the human approves, denies, or the code expires.
 *
 * `interval` and `expires_in` come from the AUTHORIZE response and are
 * authoritative — never hardcoded, because the server is entitled to change
 * them. `slow_down` widens the interval permanently for the rest of the run
 * (RFC 8628 §3.5): it exists because the server will otherwise start
 * rejecting us, so continuing at the old rate would make things worse.
 *
 * Written recursively rather than as a mutable loop — no `let`, nothing
 * reassigned (codebase immutability rule).
 */
export async function awaitDeviceApproval(
  apiUrl: string,
  authorization: DeviceAuthorization,
  opts: AwaitDeviceOptions = {},
): Promise<DevicePollResult> {
  const now = opts.now ?? (() => Date.now());
  const wait = opts.wait ?? sleep;
  const deadline = now() + authorization.expires_in * 1000;

  const step = async (intervalSeconds: number): Promise<DevicePollResult> => {
    if (now() >= deadline) {
      return { status: 'denied', error: 'expired_token' };
    }
    await wait(intervalSeconds * 1000);
    const result = await pollDeviceToken(apiUrl, authorization.device_code);
    if (result.status !== 'pending') return result;
    // RFC 8628 §3.5: on slow_down, add 5s to the interval and keep it.
    return step(result.error === 'slow_down' ? intervalSeconds + 5 : intervalSeconds);
  };

  return step(authorization.interval);
}
