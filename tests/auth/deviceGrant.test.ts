/**
 * `capy pair`'s RFC 8628 device-grant polling (CAP-684) — branches ONLY on
 * the RFC's own wire codes (`authorization_pending`, `slow_down`,
 * `expired_token`, `access_denied`), never on prose. `fetch` is mocked
 * directly (not via `mock.module`) since this file exercises pure request
 * logic, not a module boundary — same non-isolated pattern other pure-logic
 * test files in this repo use.
 */
import { describe, test, expect, jest, afterEach } from 'bun:test';
import { authorizeDevice, pollDeviceTokenOnce, pollDeviceToken } from '../../src/auth/deviceGrant';
import { CapyError } from '../../src/types/index';

const originalFetch = globalThis.fetch;

/**
 * Serves `responses` in order, one per call, holding on the last one for
 * any call past the end. Advances through `responses` via the array's own
 * iterator (`.next()`) rather than a `shift()`/counter this function would
 * have to mutate itself — the iterator's internal position is the one
 * piece of "external API" state this needs, per the no-mutation rule's
 * carve-out for APIs that demand it.
 */
function mockFetchSequence(responses: Array<{ status: number; body: any }>): void {
  const iterator = responses[Symbol.iterator]();
  const last = responses[responses.length - 1];
  globalThis.fetch = (async () => {
    const { value, done } = iterator.next();
    const next = done ? last : value;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('authorizeDevice', () => {
  test('returns the authorize response on success', async () => {
    mockFetchSequence([{ status: 200, body: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://x/verify', expires_in: 600, interval: 5 } }]);
    const result = await authorizeDevice('https://api.example', 'pubkey');
    expect(result.device_code).toBe('dc');
    expect(result.user_code).toBe('ABCD-EFGH');
  });

  test('throws a coded CapyError on failure', async () => {
    mockFetchSequence([{ status: 500, body: { error: 'boom' } }]);
    try {
      await authorizeDevice('https://api.example', 'pubkey');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('AUTH_FAILED');
    }
  });
});

describe('pollDeviceTokenOnce', () => {
  test('maps authorization_pending', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'authorization_pending' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('pending');
  });

  test('maps slow_down', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'slow_down' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('slow_down');
  });

  test('maps expired_token', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'expired_token' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('expired');
  });

  test('maps access_denied', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'access_denied' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('denied');
  });

  test('maps success with token/user/organizations', async () => {
    mockFetchSequence([{
      status: 200,
      body: {
        token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
        user: { id: 'user_1', email: 'a@b.com', first_name: null, last_name: null },
        organizations: [{ id: 'org_1', workos_org_id: 'wo_1', name: 'Acme' }],
      },
    }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.user.id).toBe('user_1');
      expect(result.organizations[0].name).toBe('Acme');
    }
  });

  test('an unrecognized error code throws rather than being treated as a poll state', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'some_other_error' } }]);
    try {
      await pollDeviceTokenOnce('https://api.example', 'dc');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('AUTH_FAILED');
    }
  });
});

describe('pollDeviceToken', () => {
  test('retries through pending and slow_down, then returns success', async () => {
    mockFetchSequence([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      {
        status: 200,
        body: {
          token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
          user: { id: 'user_1', email: 'a@b.com', first_name: null, last_name: null },
          organizations: [],
        },
      },
    ]);
    // `jest.fn()` does its own call-recording — reading `.mock.calls` back
    // afterward needs no accumulator of our own to mutate.
    const sleep = jest.fn(async () => {});
    const result = await pollDeviceToken('https://api.example', 'dc', {
      intervalMs: 1000,
      timeoutMs: 60000,
      sleep,
      now: () => 0,
    });
    expect(result.user.id).toBe('user_1');
    // pending keeps the interval; slow_down bumps it by 5000ms for the NEXT poll.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 6000]);
  });

  test('throws on expired_token', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'expired_token' } }]);
    try {
      await pollDeviceToken('https://api.example', 'dc', { intervalMs: 1000, timeoutMs: 60000, sleep: async () => {}, now: () => 0 });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.details?.reason).toBe('expired_token');
    }
  });

  test('throws on access_denied', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'access_denied' } }]);
    try {
      await pollDeviceToken('https://api.example', 'dc', { intervalMs: 1000, timeoutMs: 60000, sleep: async () => {}, now: () => 0 });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.details?.reason).toBe('access_denied');
    }
  });

  test('gives up as expired once the wall-clock budget is exceeded', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'authorization_pending' } }]);
    // First call establishes the deadline (small); every check after is past
    // it. `jest.fn()`'s own call count stands in for a counter this test
    // would otherwise have to mutate itself.
    const now = jest.fn(() => (now.mock.calls.length === 1 ? 0 : 1_000_000));
    try {
      await pollDeviceToken('https://api.example', 'dc', { intervalMs: 10, timeoutMs: 5, sleep: async () => {}, now });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.details?.reason).toBe('expired_token');
    }
  });
});
