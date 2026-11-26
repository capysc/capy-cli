/**
 * `capy pair`'s RFC 8628 device-grant polling (CAP-684) — branches ONLY on
 * `/auth/device/token`'s `status` plus `code` fields (never HTTP status
 * alone, never message text), matching the service as built
 * (service/src/routes/auth.ts + service/src/middleware/rateLimit.ts):
 *
 *   - pending      HTTP 200 `{status:'pending', code:'authorization_pending'}`
 *   - slow_down    HTTP 200 `{status:'pending', code:'slow_down'}` (the rate
 *                  limiter tripping sends this too, same shape)
 *   - expired      HTTP 400 `{status:'denied', code:'expired_token'}`
 *   - denied       HTTP 400 `{status:'denied', code:'access_denied'}`
 *   - success      HTTP 200, NO `status` field at all — exactly
 *                  `/auth/exchange`'s `{token, user, organizations}` shape
 *
 * `fetch` is mocked directly (not via `mock.module`) since this file
 * exercises pure request logic, not a module boundary — same non-isolated
 * pattern other pure-logic test files in this repo use.
 */
import { describe, test, expect, jest, afterEach } from 'bun:test';
import { authorizeDevice, pollDeviceTokenOnce, pollDeviceToken } from '../../src/auth/deviceGrant';
import { pairingDeviceInfo, requestedBy, runsIn } from '../../src/auth/pairing/deviceInfo';
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

const SUCCESS_BODY = {
  token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
  user: { id: 'user_1', email: 'a@b.com', first_name: null, last_name: null },
  organizations: [{ id: 'org_1', workos_org_id: 'wo_1', name: 'Acme' }],
};

const SESSION = { mode: 'session', orgId: null, projectId: null, signup: false } as const;

describe('authorizeDevice', () => {
  test('sends the mode, and the org/project hints and signup flag only when present', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 600, interval: 5 }) } as Response;
    }) as typeof fetch;
    await authorizeDevice('https://api.example', 'pubkey', SESSION);
    await authorizeDevice('https://api.example', 'pubkey', { mode: 'transport', orgId: 'org_1', projectId: 'proj_1', signup: false });
    await authorizeDevice('https://api.example', 'pubkey', { mode: 'transport', orgId: null, projectId: null, signup: true });
    expect(bodies).toEqual([
      { public_key: 'pubkey', mode: 'session', device: pairingDeviceInfo() },
      { public_key: 'pubkey', mode: 'transport', org_id: 'org_1', project_id: 'proj_1', device: pairingDeviceInfo() },
      { public_key: 'pubkey', mode: 'transport', is_signup: true, device: pairingDeviceInfo() },
    ]);
  });

  test('CAP-892: describes this machine for Keep\'s Unlock Device screen', () => {
    const device = pairingDeviceInfo();
    expect(device.system).toMatch(/^.+ \(.+\)$/);
    expect(device.client).toMatch(/^Capy CLI \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    if (device.name !== undefined) expect(device.name.length).toBeLessThanOrEqual(64);
  });

  test('CAP-920: a build id goes in client_build, never in client', () => {
    const input = { env: {}, interactive: false, inContainer: false };
    const dev = pairingDeviceInfo(input, '20261126175046657.04f69f67');
    expect(dev.client).not.toContain('+');
    expect(dev.client).not.toContain('20261126175046657');
    expect(dev.client_build).toBe('20261126175046657.04f69f67');
    const release = pairingDeviceInfo(input, null);
    expect(release.client).toMatch(/^Capy CLI \S+$/);
    expect('client_build' in release).toBe(false);
  });

  test('returns the authorize response on success', async () => {
    mockFetchSequence([{ status: 200, body: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://x/verify', expires_in: 600, interval: 5 } }]);
    const result = await authorizeDevice('https://api.example', 'pubkey', SESSION);
    expect(result.device_code).toBe('dc');
    expect(result.user_code).toBe('ABCD-EFGH');
  });

  test('surfaces the service INVALID_FORMAT code rather than a generic one', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'public_key must be a base64url-encoded raw uncompressed P-256 point', code: 'INVALID_FORMAT' } }]);
    try {
      await authorizeDevice('https://api.example', 'not-a-key', SESSION);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('falls back to AUTH_FAILED for a code outside the known set', async () => {
    mockFetchSequence([{ status: 502, body: { error: 'Failed to start device authorization', code: 'SOME_UNKNOWN_CODE' } }]);
    try {
      await authorizeDevice('https://api.example', 'pubkey', SESSION);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('AUTH_FAILED');
    }
  });

  test('falls back to AUTH_FAILED with no code at all', async () => {
    mockFetchSequence([{ status: 502, body: { error: 'boom' } }]);
    try {
      await authorizeDevice('https://api.example', 'pubkey', SESSION);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('AUTH_FAILED');
    }
  });
});

describe('pollDeviceTokenOnce', () => {
  test('carries the org Keep bound the pairing to (paired_org_id), null when absent', async () => {
    mockFetchSequence([{ status: 200, body: { ...SUCCESS_BODY, paired_org_id: 'org_1' } }]);
    expect(await pollDeviceTokenOnce('https://api.example', 'dc')).toMatchObject({ status: 'success', pairedOrgId: 'org_1' });
    mockFetchSequence([{ status: 200, body: SUCCESS_BODY }]);
    expect(await pollDeviceTokenOnce('https://api.example', 'dc')).toMatchObject({ status: 'success', pairedOrgId: null });
  });

  test('maps {status:"denied", code:"pairing_access_denied"} (HTTP 400) to forbidden', async () => {
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'pairing_access_denied' } }]);
    expect(await pollDeviceTokenOnce('https://api.example', 'dc')).toEqual({ status: 'forbidden' });
  });

  test('maps {status:"pending", code:"authorization_pending"} (HTTP 200)', async () => {
    mockFetchSequence([{ status: 200, body: { status: 'pending', code: 'authorization_pending' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('pending');
  });

  test('maps {status:"pending", code:"slow_down"} (HTTP 200 — WorkOS or the rate limiter tripping, same shape)', async () => {
    mockFetchSequence([{ status: 200, body: { status: 'pending', code: 'slow_down' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('slow_down');
  });

  test('maps {status:"denied", code:"expired_token"} (HTTP 400)', async () => {
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'expired_token' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('expired');
  });

  test('maps {status:"denied", code:"access_denied"} (HTTP 400)', async () => {
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'access_denied' } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('denied');
  });

  test('maps success (HTTP 200, no `status` field, a token present) to the /auth/exchange shape', async () => {
    mockFetchSequence([{ status: 200, body: SUCCESS_BODY }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.user.id).toBe('user_1');
      expect(result.organizations[0].name).toBe('Acme');
    }
  });

  test('a 200 with `status` set is NEVER treated as success even though the HTTP status is ok', async () => {
    // Regression guard for the exact bug this endpoint's shape invites: HTTP
    // 200 is not itself the success signal, `status` field absence is.
    mockFetchSequence([{ status: 200, body: { status: 'pending', code: 'authorization_pending', ...SUCCESS_BODY } }]);
    const result = await pollDeviceTokenOnce('https://api.example', 'dc');
    expect(result.status).toBe('pending');
  });

  test('surfaces the service INVALID_FORMAT code for a malformed request', async () => {
    mockFetchSequence([{ status: 400, body: { error: 'device_code is required', code: 'INVALID_FORMAT' } }]);
    try {
      await pollDeviceTokenOnce('https://api.example', '');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('an unrecognized shape throws AUTH_FAILED rather than being treated as a poll state', async () => {
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'some_other_code' } }]);
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
      { status: 200, body: { status: 'pending', code: 'authorization_pending' } },
      { status: 200, body: { status: 'pending', code: 'slow_down' } },
      { status: 200, body: SUCCESS_BODY },
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
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'expired_token' } }]);
    try {
      await pollDeviceToken('https://api.example', 'dc', { intervalMs: 1000, timeoutMs: 60000, sleep: async () => {}, now: () => 0 });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.details?.reason).toBe('expired_token');
    }
  });

  test('throws on access_denied', async () => {
    mockFetchSequence([{ status: 400, body: { status: 'denied', code: 'access_denied' } }]);
    try {
      await pollDeviceToken('https://api.example', 'dc', { intervalMs: 1000, timeoutMs: 60000, sleep: async () => {}, now: () => 0 });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.details?.reason).toBe('access_denied');
    }
  });

  test('gives up as expired once the wall-clock budget is exceeded', async () => {
    mockFetchSequence([{ status: 200, body: { status: 'pending', code: 'authorization_pending' } }]);
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

describe('the one-time code Keep shows the approver (CAP-877)', () => {
  /** Serves `responses` in order and records each request body. */
  function recordingFetch(responses: Array<{ status: number; body: any }>): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const iterator = responses[Symbol.iterator]();
    const last = responses[responses.length - 1];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      const { value, done } = iterator.next();
      const next = done ? last : value;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
    }) as typeof fetch;
    return bodies;
  }
  const REQUIRED = { status: 200, body: { status: 'confirm', code: 'confirmation_required', attempts_left: 5 } };
  const MISMATCH = { status: 200, body: { status: 'confirm', code: 'confirmation_mismatch', attempts_left: 4 } };
  const FAILED = { status: 400, body: { status: 'denied', code: 'confirmation_failed' } };
  const opts = { intervalMs: 1000, timeoutMs: 60000, sleep: async () => {}, now: () => 0 };

  test('pollDeviceTokenOnce reads confirm, mismatch and failed, and sends the code only when given', async () => {
    const bodies = recordingFetch([REQUIRED, MISMATCH, FAILED]);
    expect(await pollDeviceTokenOnce('https://api.example', 'dc')).toEqual({ status: 'confirm', mismatch: false, attemptsLeft: 5 });
    expect(await pollDeviceTokenOnce('https://api.example', 'dc', { confirmationCode: 'ABCD-EFGH' })).toEqual({ status: 'confirm', mismatch: true, attemptsLeft: 4 });
    expect(await pollDeviceTokenOnce('https://api.example', 'dc', { confirmationCode: 'ABCD-EFGH' })).toEqual({ status: 'confirmation_failed' });
    expect(bodies).toEqual([
      { device_code: 'dc' },
      { device_code: 'dc', confirmation_code: 'ABCD-EFGH' },
      { device_code: 'dc', confirmation_code: 'ABCD-EFGH' },
    ]);
  });

  test('pollDeviceToken asks for the code, asks again after a wrong one, and sends the last one until success', async () => {
    const bodies = recordingFetch([REQUIRED, MISMATCH, { status: 200, body: { status: 'pending', code: 'authorization_pending' } }, { status: 200, body: SUCCESS_BODY }]);
    const ask = jest.fn().mockResolvedValueOnce('wrong-code').mockResolvedValueOnce(' ABCD-EFGH ');
    const result = await pollDeviceToken('https://api.example', 'dc', { ...opts, askConfirmationCode: ask });
    expect(result.user.id).toBe('user_1');
    expect(ask.mock.calls).toEqual([[{ mismatch: false, attemptsLeft: 5 }], [{ mismatch: true, attemptsLeft: 4 }]]);
    expect(bodies.map((body) => body.confirmation_code)).toEqual([undefined, 'wrong-code', 'ABCD-EFGH', 'ABCD-EFGH']);
  });

  test('without a way to ask, a pairing that needs the code is refused with PAIR_CODE_REQUIRED', async () => {
    recordingFetch([REQUIRED]);
    await expect(pollDeviceToken('https://api.example', 'dc', opts)).rejects.toMatchObject({ code: 'PAIR_CODE_REQUIRED' });
  });

  test('a blank answer is refused with PAIR_CODE_REQUIRED', async () => {
    recordingFetch([REQUIRED]);
    await expect(pollDeviceToken('https://api.example', 'dc', { ...opts, askConfirmationCode: async () => '   ' })).rejects.toMatchObject({ code: 'PAIR_CODE_REQUIRED' });
  });

  test('too many wrong codes are refused with PAIR_CODE_FAILED', async () => {
    recordingFetch([REQUIRED, FAILED]);
    await expect(pollDeviceToken('https://api.example', 'dc', { ...opts, askConfirmationCode: async () => 'WRONG-ONE' })).rejects.toMatchObject({ code: 'PAIR_CODE_FAILED' });
  });
});

describe('CAP-905: who asked, and where it runs', () => {
  const input = (env: Record<string, string>, interactive = true, inContainer = false) => ({ env, interactive, inContainer });

  test('an AI agent is named, with its version, from the AI_AGENT convention', () => {
    expect(requestedBy(input({ AI_AGENT: 'claude-code_2-1-332_agent' }))).toBe('Claude Code 2.1.332 (AI agent)');
    expect(requestedBy(input({ AI_AGENT: 'some-new-tool_3-0_agent' }))).toBe('Some New Tool 3.0 (AI agent)');
    expect(requestedBy(input({ AI_AGENT: 'x$(rm)_1' }))).toBe('Xrm 1 (AI agent)');
  });

  test('agent-specific variables, then a person or a program', () => {
    expect(requestedBy(input({ CLAUDECODE: '1' }))).toBe('Claude Code (AI agent)');
    expect(requestedBy(input({ CURSOR_AGENT: '1' }))).toBe('Cursor (AI agent)');
    expect(requestedBy(input({ GEMINI_CLI: '1' }))).toBe('Gemini CLI (AI agent)');
    expect(requestedBy(input({}))).toBe('A person');
    expect(requestedBy(input({}, false))).toBe('A program (not interactive)');
    expect(requestedBy(input({ CLAUDECODE: '0' }))).toBe('A person');
  });

  test('where it runs', () => {
    expect(runsIn(input({ CLAUDE_CODE_REMOTE: 'true', CI: 'true' }))).toBe('Claude Code cloud session');
    expect(runsIn(input({ CODESPACES: 'true' }))).toBe('GitHub Codespaces');
    expect(runsIn(input({ GITHUB_ACTIONS: 'true', CI: 'true' }))).toBe('GitHub Actions');
    expect(runsIn(input({ CI: '1' }))).toBe('CI');
    expect(runsIn(input({}, true, true))).toBe('A container');
    expect(runsIn(input({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }))).toBe('Over SSH');
    expect(runsIn(input({}))).toBe('Local machine');
  });

  test('only names leave the machine: no session id, token or username', () => {
    const info = pairingDeviceInfo(input({ AI_AGENT: 'claude-code_2-1-332_agent', CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'secret-session', USER: 'mabel' }));
    expect(info.requested_by).toBe('Claude Code 2.1.332 (AI agent)');
    expect(info.environment).toBe('Claude Code cloud session');
    expect(JSON.stringify(info)).not.toMatch(/secret-session|mabel/);
  });
});
