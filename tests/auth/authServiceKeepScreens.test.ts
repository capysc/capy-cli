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

// In-memory session store — the real one reads/writes ~/.capy.
const store: { session: unknown } = { session: null };
mock.module('../../src/config/globalConfig', () => ({
  readAuthSession: mock(() => store.session),
  saveAuthSession: mock((session: unknown) => {
    store.session = session;
  }),
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
const wire = {
  exchangeStatus: 200,
  createStatus: 201,
  initiate: null as null | { state: string; redirect_uri: string },
  createBody: null as null | Record<string, unknown>,
  resultPolls: 0,
  deletes: 0,
};

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const path = url.slice(SVC.length);

  if (path === '/auth/initiate') {
    wire.initiate = { state: body.state, redirect_uri: body.redirect_uri };
    return Response.json({ auth_url: 'https://authkit.example.test/authorize' });
  }
  if (path === '/auth/exchange') {
    if (wire.exchangeStatus !== 200) {
      return Response.json({ error: 'refused', code: 'AUTH_EXCHANGE_FAILED' }, { status: wire.exchangeStatus });
    }
    return Response.json({
      token: { access_token: ACCESS_TOKEN, refresh_token: 'refresh-1', expires_in: 600 },
      user: USER,
      organizations: [ORG],
    });
  }
  if (path === '/connections' && init?.method === 'POST') {
    if (wire.createStatus !== 201) {
      return Response.json({ error: 'down', code: 'SERVICE_ERROR' }, { status: wire.createStatus });
    }
    wire.createBody = body;
    return Response.json(
      { connection_id: 'conn-1', status: 'pending', expires_at: new Date(Date.now() + 600_000).toISOString() },
      { status: 201 },
    );
  }
  if (path.startsWith('/connections/conn-1/result')) {
    wire.resultPolls += 1;
    const sealed = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ v: 1, flow: 'auth-success', signal: 'acknowledged' }),
      connectionId: 'conn-1',
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
    });
    return Response.json({ status: 'answered', ciphertext: sealed });
  }
  if (path === '/connections/conn-1' && init?.method === 'DELETE') {
    wire.deletes += 1;
    return Response.json({ status: 'cancelled' });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv.CAPY_WEB_NO_OPEN = process.env.CAPY_WEB_NO_OPEN;
  savedEnv.CAPY_KEEP_SCREENS = process.env.CAPY_KEEP_SCREENS;
  savedEnv.CAPY_KEEP_ORIGIN = process.env.CAPY_KEEP_ORIGIN;
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
  store.session = null;
  wire.exchangeStatus = 200;
  wire.createStatus = 201;
  wire.initiate = null;
  wire.createBody = null;
  wire.resultPolls = 0;
  wire.deletes = 0;
});

/** Wait for the flow to reach the point where the provider would redirect. */
async function initiateCaptured(): Promise<{ state: string; redirect_uri: string }> {
  const deadline = Date.now() + 2_000;
  while (!wire.initiate && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!wire.initiate) throw new Error('initiate never captured');
  return wire.initiate;
}

function callbackUrl(init: { state: string; redirect_uri: string }, params: string): string {
  return `${init.redirect_uri.replace('localhost', '127.0.0.1')}?${params}&state=${init.state}`;
}

describe('CAPY_KEEP_SCREENS=1', () => {
  test('callback 303s to a keep URL bound to a fresh broker connection; ack is collected', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const auth = new AuthService(SVC, false);
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
    expect(wire.createBody?.purpose).toBe('auth-success');
    expect(typeof wire.createBody?.machine_name).toBe('string');
    expect(Buffer.from(wire.createBody?.client_pubkey as string, 'base64').length).toBe(65);
    // …and the sealed acknowledgement round-tripped.
    expect(wire.resultPolls).toBeGreaterThanOrEqual(1);
  });

  test('broker unavailable → loopback auth-success fallback; sign-in still succeeds', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.createStatus = 503;
    const auth = new AuthService(SVC, false);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbResP = realFetch(callbackUrl(init, 'code=c-2'), { redirect: 'manual' });

    const result = await authP;
    expect(result.success).toBe(true);

    const cbRes = await cbResP;
    expect(cbRes.status).toBe(200);
    expect(await cbRes.text()).toContain('"autoCloseSeconds":3');
    expect(wire.resultPolls).toBe(0);
  });

  test('exchange failure → held response gets the loopback error screen', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.exchangeStatus = 500;
    const auth = new AuthService(SVC, false);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbResP = realFetch(callbackUrl(init, 'code=c-3'), { redirect: 'manual' });

    const result = await authP;
    expect(result.success).toBe(false);

    const cbRes = await cbResP;
    expect(cbRes.status).toBe(400);
    expect(wire.createBody).toBeNull();
  });
});

describe('flag unset (default)', () => {
  test('callback serves the loopback auth-success screen; zero broker traffic', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    const auth = new AuthService(SVC, false);
    const authP = auth.authenticate();

    const init = await initiateCaptured();
    const cbRes = await realFetch(callbackUrl(init, 'code=c-4'), { redirect: 'manual' });

    expect(cbRes.status).toBe(200);
    expect(await cbRes.text()).toContain('"autoCloseSeconds":3');

    const result = await authP;
    expect(result.success).toBe(true);
    expect(result.organization_id).toBe(ORG.id);

    expect(wire.createBody).toBeNull();
    expect(wire.resultPolls).toBe(0);
    expect(wire.deletes).toBe(0);
  });
});
