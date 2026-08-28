/**
 * CAP-566 — the device-authorization poll loop.
 *
 * The loop is where this quietly goes wrong: a `slow_down` ignored means the
 * server starts rejecting us, and a missing deadline means a headless box
 * polls forever on a code that expired five minutes ago. Both are invisible
 * in a happy-path test, so they are asserted directly here.
 *
 * Time and network are injected, so this is deterministic and instant — no
 * real waiting, no real WorkOS.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { awaitDeviceApproval, toAnswerSession, type DeviceAuthorization } from '../../src/auth/pairing/deviceAuth';

const AUTHORIZATION: DeviceAuthorization = {
  device_code: 'dc_abc',
  user_code: 'RJXN-HMFW',
  verification_uri: 'https://polite-balcony-88-staging.authkit.app/device',
  expires_in: 300,
  interval: 5,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replies with each queued body in turn; the last repeats. */
function stubFetch(bodies: ReadonlyArray<Record<string, unknown>>): { calls: () => number } {
  const state = { n: 0 };
  globalThis.fetch = mock(async () => {
    const body = bodies[Math.min(state.n, bodies.length - 1)];
    state.n += 1;
    return new Response(JSON.stringify(body), {
      status: body.error ? 200 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls: () => state.n };
}

const COMPLETE = {
  status: 'complete',
  token: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
  user: { id: 'u1', email: 'dev@capy.sc', first_name: null, last_name: null },
  organizations: [{ id: 'org1', workos_org_id: 'org_workos', name: 'Org' }],
};

describe('awaitDeviceApproval', () => {
  it('polls at the interval the SERVER returned, not a hardcoded one', async () => {
    stubFetch([{ error: 'authorization_pending' }, COMPLETE]);
    const waits: number[] = [];

    const result = await awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => 0,
      wait: async (ms) => { waits.push(ms); },
    });

    expect(result.status).toBe('complete');
    // 5s from the authorize response, in milliseconds — never a literal.
    expect(waits).toEqual([5000, 5000]);
  });

  it('BACKS OFF on slow_down and keeps the wider interval', async () => {
    // Ignoring slow_down is why the server starts rejecting you; continuing
    // at the old rate makes it worse rather than merely no better.
    stubFetch([{ error: 'slow_down' }, { error: 'authorization_pending' }, COMPLETE]);
    const waits: number[] = [];

    await awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => 0,
      wait: async (ms) => { waits.push(ms); },
    });

    // 5s, then +5 for the whole rest of the run — not just the next poll.
    expect(waits).toEqual([5000, 10000, 10000]);
  });

  it('gives up once expires_in has elapsed instead of polling a dead code', async () => {
    stubFetch([{ error: 'authorization_pending' }]);
    const clock = { t: 0 };

    const result = await awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => clock.t,
      wait: async () => { clock.t += 120_000; },
    });

    expect(result).toEqual({ status: 'denied', error: 'expired_token' });
  });

  it('surfaces a denial as a coded value, never as prose', async () => {
    stubFetch([{ error: 'access_denied', error_description: 'The user denied the request.' }]);

    const result = await awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => 0,
      wait: async () => {},
    });

    expect(result).toEqual({ status: 'denied', error: 'access_denied' });
  });
});

describe('a 200 that carries no tokens is never success (CAP-566)', () => {
  // The poll endpoint answers 200 while WAITING, so the status code cannot
  // distinguish "pending" from "signed in". A caller that trusts the status
  // installs nothing and reports OK — the same false-green shape as a driver
  // reporting success on a sign-in-failed page. Asserted, not just commented.

  it('refuses a complete-looking body with no credentials', async () => {
    stubFetch([{ status: 'complete', user: { id: 'u1', email: 'e' }, organizations: [] }]);

    const attempt = awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => 0,
      wait: async () => {},
    });

    await expect(attempt).rejects.toThrow();
  });

  it('a pending 200 yields NO session — it stays pending', async () => {
    stubFetch([{ status: 'pending', error: 'authorization_pending' }, COMPLETE]);
    const seen: string[] = [];

    const result = await awaitDeviceApproval('http://svc', AUTHORIZATION, {
      now: () => 0,
      wait: async () => { seen.push('poll'); },
    });

    // It polled again rather than treating the first 200 as a sign-in...
    expect(seen.length).toBe(2);
    // ...and only the body that actually carried tokens completed it.
    expect(result.status).toBe('complete');
    expect(result.status === 'complete' && result.session.refresh_token).toBe('rt');
  });
});

describe('toAnswerSession', () => {
  it('maps the service response onto the existing session writer shape', () => {
    const session = toAnswerSession(COMPLETE);

    expect(session.user.email).toBe('dev@capy.sc');
    expect(session.refresh_token).toBe('rt');
    // The org-scoped access token is cached under the org id, which is what
    // installPairedSession reads.
    expect(session.sessions?.org1?.access_token).toBe('at');
  });
});
