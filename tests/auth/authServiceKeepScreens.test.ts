/**
 * The CAP-376 serving fork, end to end through AuthService.authenticate():
 *
 *  - CAPY_KEEP_SCREENS=1 → the OAuth callback answers with a 303 to a
 *    keep.capy.sc flow URL bound to a freshly created broker connection, and
 *    the CLI collects the page's sealed acknowledgement;
 *  - flag unset → today's loopback auth-success screen, byte-path identical,
 *    zero broker traffic;
 *  - broker unavailable → loopback fallback, sign-in still succeeds;
 *  - exchange failure → held response gets the loopback error screen.
 *
 * ISOLATED (mock.module + global.fetch swap): registered in run-tests.sh.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionStorageBackend } from '../../src/auth/session/backend';
import type { SessionStore } from '../../src/types/index';

const saveSession = mock((session: SessionStore, _userId: string | undefined) =>
  structuredClone(session));
const latestSession = (): SessionStore | null => {
  const saved = saveSession.mock.results.at(-1)?.value as SessionStore | undefined;
  return saved ? structuredClone(saved) : null;
};
const memorySessionBackend: SessionStorageBackend = {
  load: mock(() => latestSession()),
  save: saveSession,
  clear: mock(() => undefined),
  discover: mock(() => null),
  withRefreshLock: async (_userId, run) => run(latestSession(), () => undefined),
};
mock.module('../../src/config/globalConfig', () => ({
  getAuthSessionPath: mock(() => '/tmp/capy-keepscreens-test/session.json'),
  getGlobalCapyDir: mock(() => '/tmp/capy-keepscreens-test-nonexistent'),
  consumeForceLoginMarker: mock(() => false),
}));

afterAll(() => {
  mock.restore();
});

import { AuthService } from '../../src/auth/authService';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const realFetch = globalThis.fetch;

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

const ORG = { id: 'org1', workos_org_id: 'wos1', name: 'Acme' };
const USER = { id: 'user_1', email: 'v@example.test', first_name: 'V', last_name: 'C' };
const ACCESS_TOKEN = fakeJwt({ sub: USER.id, org_id: ORG.workos_org_id });

/** Per-test wire behavior + capture. */
const exchangeStatus = mock(() => 200);
const createStatus = mock(() => 201);
const captureInitiate = mock((value: Readonly<{ state: string; redirect_uri: string }>) => value);
const captureCreateBody = mock((value: Readonly<Record<string, unknown>>) => value);
const captureResultPoll = mock(() => undefined);
const captureDelete = mock(() => undefined);

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const path = url.slice(SVC.length);

  if (path === '/auth/initiate') {
    captureInitiate({ state: body.state, redirect_uri: body.redirect_uri });
    return Response.json({ auth_url: 'https://authkit.example.test/authorize' });
  }
  if (path === '/auth/exchange') {
    const status = exchangeStatus();
    if (status !== 200) {
      return Response.json({ error: 'refused', code: 'AUTH_EXCHANGE_FAILED' }, { status });
    }
    return Response.json({
      token: { access_token: ACCESS_TOKEN, refresh_token: 'refresh-1', expires_in: 600 },
      user: USER,
      organizations: [ORG],
    });
  }
  if (path === '/connections' && init?.method === 'POST') {
    const status = createStatus();
    if (status !== 201) {
      return Response.json({ error: 'down', code: 'SERVICE_ERROR' }, { status });
    }
    captureCreateBody(body);
    return Response.json(
      { connection_id: 'conn-1', status: 'pending', expires_at: new Date(Date.now() + 600_000).toISOString() },
      { status: 201 },
    );
  }
  if (path.startsWith('/connections/conn-1/result')) {
    captureResultPoll();
    const createBody = captureCreateBody.mock.calls.at(-1)?.[0];
    if (!createBody) throw new Error('connection body was not captured');
    const sealed = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ v: 1, flow: 'auth-success', signal: 'acknowledged' }),
      connectionId: 'conn-1',
      clientPubkeyB64: createBody.client_pubkey as string,
    });
    return Response.json({ status: 'answered', ciphertext: sealed });
  }
  if (path === '/connections/conn-1' && init?.method === 'DELETE') {
    captureDelete();
    return Response.json({ status: 'cancelled' });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

const savedEnv = {
  CAPY_WEB_NO_OPEN: process.env.CAPY_WEB_NO_OPEN,
  CAPY_KEEP_SCREENS: process.env.CAPY_KEEP_SCREENS,
  CAPY_KEEP_ORIGIN: process.env.CAPY_KEEP_ORIGIN,
} as const;

beforeAll(() => {
  process.env.CAPY_WEB_NO_OPEN = '1';
  delete process.env.CAPY_KEEP_ORIGIN;

  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(SVC)) return serviceFetch(u, init);
    return realFetch(url, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  [
    saveSession,
    exchangeStatus,
    createStatus,
    captureInitiate,
    captureCreateBody,
    captureResultPoll,
    captureDelete,
  ].forEach((candidate) => candidate.mockClear());
  exchangeStatus.mockReturnValue(200);
  createStatus.mockReturnValue(201);
});

/** Wait for the flow to reach the point where the provider would redirect. */
async function initiateCaptured(): Promise<{ state: string; redirect_uri: string }> {
  const deadline = Date.now() + 2_000;
  while (captureInitiate.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const captured = captureInitiate.mock.calls.at(-1)?.[0];
  if (!captured) throw new Error('initiate never captured');
  return captured;
}

function callbackUrl(init: { state: string; redirect_uri: string }, params: string): string {
  return `${init.redirect_uri.replace('localhost', '127.0.0.1')}?${params}&state=${init.state}`;
}

describe('CAPY_KEEP_SCREENS=1', () => {
  test('callback 303s to a keep URL bound to a fresh broker connection; ack is collected', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbResP = realFetch(callbackUrl(init, 'code=c-1'), { redirect: 'manual' });

    const result = await authP;
    expect(result.success).toBe(true);
    expect(result.organization_id).toBe(ORG.id);

    const cbRes = await cbResP;
    expect(cbRes.status).toBe(303);
    expect(cbRes.headers.get('location')).toBe('https://keep.capy.sc/flow/auth-success?c=conn-1');

    // The connection was created with the documented shape…
    const createBody = captureCreateBody.mock.calls.at(-1)?.[0];
    expect(createBody?.purpose).toBe('auth-success');
    expect(typeof createBody?.machine_name).toBe('string');
    expect(Buffer.from(createBody?.client_pubkey as string, 'base64').length).toBe(65);
    // …and the sealed acknowledgement round-tripped.
    expect(captureResultPoll).toHaveBeenCalled();
  });

  test('broker unavailable → loopback auth-success fallback; sign-in still succeeds', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    createStatus.mockReturnValue(503);
    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbResP = realFetch(callbackUrl(init, 'code=c-2'), { redirect: 'manual' });

    const result = await authP;
    expect(result.success).toBe(true);

    const cbRes = await cbResP;
    expect(cbRes.status).toBe(200);
    expect(await cbRes.text()).toContain('"autoCloseSeconds":3');
    expect(captureResultPoll).not.toHaveBeenCalled();
  });

  test('exchange failure → held response gets the loopback error screen', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    exchangeStatus.mockReturnValue(500);
    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbResP = realFetch(callbackUrl(init, 'code=c-3'), { redirect: 'manual' });

    const result = await authP;
    expect(result.success).toBe(false);

    const cbRes = await cbResP;
    expect(cbRes.status).toBe(400);
    expect(captureCreateBody).not.toHaveBeenCalled();
  });
});

describe('flag unset (default)', () => {
  test('callback serves the loopback auth-success screen; zero broker traffic', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbRes = await realFetch(callbackUrl(init, 'code=c-4'), { redirect: 'manual' });

    expect(cbRes.status).toBe(200);
    expect(await cbRes.text()).toContain('"autoCloseSeconds":3');

    const result = await authP;
    expect(result.success).toBe(true);
    expect(result.organization_id).toBe(ORG.id);

    expect(captureCreateBody).not.toHaveBeenCalled();
    expect(captureResultPoll).not.toHaveBeenCalled();
    expect(captureDelete).not.toHaveBeenCalled();
  });
});
