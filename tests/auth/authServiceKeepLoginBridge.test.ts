/**
 * CAP-374 step 1: the keep-login-bridge decision inside AuthService's OAuth
 * flow, end to end. `CAPY_KEEP_LOGIN_BRIDGE=1` (a SEPARATE flag from
 * CAPY_KEEP_SCREENS — see keepScreens.ts's keepLoginBridgeEnabled doc) makes
 * `capy login` open keep's `/auth/start` instead of calling `/auth/initiate`
 * directly, so the browser's FIRST hop goes through keep — but only for the
 * plain fresh-sign-in case, and only when keep actually answers.
 *
 * Captures the URL handed to `openScreen` (mocked) as the ground truth for
 * "what got opened" — CAPY_WEB_NO_OPEN alone doesn't reveal that, it just
 * suppresses the real launch.
 *
 * ISOLATED (mock.module + global.fetch swap): registered in run-tests.sh,
 * same convention as authServiceKeepScreens.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const store: { session: unknown } = { session: null };
const forceLoginState = { pending: false };
mock.module('../../src/config/globalConfig', () => ({
  readAuthSession: mock(() => store.session),
  saveAuthSession: mock((session: unknown) => {
    store.session = session;
  }),
  getAuthSessionPath: mock(() => '/tmp/capy-keepbridge-test/session.json'),
  getGlobalCapyDir: mock(() => '/tmp/capy-keepbridge-test-nonexistent'),
  consumeForceLoginMarker: mock(() => forceLoginState.pending),
  isForceLoginMarkerPending: mock(() => forceLoginState.pending),
}));

const opened: { urls: string[] } = { urls: [] };
mock.module('../../src/ui/openScreen', () => ({
  openScreen: mock(async (url: string) => {
    opened.urls.push(url);
    return { via: 'suppressed' };
  }),
}));

afterAll(() => {
  mock.restore();
});

import { AuthService } from '../../src/auth/authService';

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

const wire = {
  initiateCalls: [] as Array<{ state: string; redirect_uri: string; organization_id?: string }>,
};

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const path = url.slice(SVC.length);

  if (path === '/auth/initiate') {
    wire.initiateCalls.push({
      state: body.state,
      redirect_uri: body.redirect_uri,
      organization_id: body.organization_id,
    });
    return Response.json({ auth_url: 'https://authkit.example.test/authorize' });
  }
  if (path === '/auth/exchange') {
    return Response.json({
      token: { access_token: ACCESS_TOKEN, refresh_token: 'refresh-1', expires_in: 600 },
      user: USER,
      organizations: [ORG],
    });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv.CAPY_WEB_NO_OPEN = process.env.CAPY_WEB_NO_OPEN;
  savedEnv.CAPY_KEEP_LOGIN_BRIDGE = process.env.CAPY_KEEP_LOGIN_BRIDGE;
  savedEnv.CAPY_KEEP_ORIGIN = process.env.CAPY_KEEP_ORIGIN;
  process.env.CAPY_WEB_NO_OPEN = '1';
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  store.session = null;
  forceLoginState.pending = false;
  wire.initiateCalls = [];
  opened.urls = [];
  delete process.env.CAPY_KEEP_LOGIN_BRIDGE;
  delete process.env.CAPY_KEEP_ORIGIN;
  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(SVC)) return serviceFetch(u, init);
    return realFetch(url, init);
  }) as typeof fetch;
});

/** Simulate the browser eventually landing back on the CLI's own loopback —
 * exactly what happens after keep's silent second /auth/initiate round trip
 * in the real flow, or what WorkOS does directly in the fallback path. */
async function landOnLoopback(redirectUri: string, state: string, code: string): Promise<Response> {
  const url = `${redirectUri.replace('localhost', '127.0.0.1')}?code=${code}&state=${state}`;
  return realFetch(url, { redirect: 'manual' });
}

describe('CAPY_KEEP_LOGIN_BRIDGE=1, keep reachable, plain sign-in', () => {
  test('opens the keep bridge URL instead of calling /auth/initiate directly', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;

      const auth = new AuthService(SVC, false);
      const authP = auth.authenticate();

      const deadline = Date.now() + 2_000;
      while (opened.urls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(opened.urls.length).toBe(1);
      const bridgeUrl = new URL(opened.urls[0]);
      expect(bridgeUrl.origin).toBe(`http://127.0.0.1:${keepStub.port}`);
      expect(bridgeUrl.pathname).toBe('/auth/start');
      const cliRedirect = bridgeUrl.searchParams.get('cli_redirect')!;
      const cliChallenge = bridgeUrl.searchParams.get('cli_challenge')!;
      const cliState = bridgeUrl.searchParams.get('cli_state')!;
      expect(cliRedirect).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(cliChallenge.length).toBeGreaterThan(0);
      expect(cliState.length).toBeGreaterThan(0);

      // The direct /auth/initiate call never happened — keep is the one
      // fronting the FIRST hop, not this process.
      expect(wire.initiateCalls.length).toBe(0);

      // Simulate keep's silent second round trip landing back here with a
      // code bound to THIS server's own state (the only one it will accept).
      const cbRes = await landOnLoopback(cliRedirect, cliState, 'fake-code-1');
      expect(cbRes.status).toBe(200);

      const result = await authP;
      expect(result.success).toBe(true);
      expect(result.organization_id).toBe(ORG.id);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1, keep unreachable: loopback fallback', () => {
  test('falls back to calling /auth/initiate directly, exactly like the flag being off', async () => {
    process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
    process.env.CAPY_KEEP_ORIGIN = 'http://127.0.0.1:9'; // discard port, refuses connections

    const auth = new AuthService(SVC, false);
    const authP = auth.authenticate();

    const deadline = Date.now() + 2_000;
    while (wire.initiateCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(wire.initiateCalls.length).toBe(1);
    // The opened URL is the AuthKit URL the service returned, NOT a keep URL.
    expect(opened.urls[0]).toBe('https://authkit.example.test/authorize');

    const init = wire.initiateCalls[0];
    const cbRes = await landOnLoopback(init.redirect_uri, init.state, 'fake-code-2');
    expect(cbRes.status).toBe(200);

    const result = await authP;
    expect(result.success).toBe(true);
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1 with an organization_id: falls back to direct', () => {
  test('keep bridge does not (yet) forward organization_id, so this skips it', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;

      const auth = new AuthService(SVC, false);
      const authP = auth.authenticate(ORG.id);

      const deadline = Date.now() + 2_000;
      while (wire.initiateCalls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(wire.initiateCalls.length).toBe(1);
      expect(wire.initiateCalls[0].organization_id).toBe(ORG.id);

      const init = wire.initiateCalls[0];
      await landOnLoopback(init.redirect_uri, init.state, 'fake-code-3');
      const result = await authP;
      expect(result.success).toBe(true);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1 with a pending force-login marker: falls back to direct', () => {
  test('a pending marker steers back to the path that actually honors it', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;
      forceLoginState.pending = true;

      const auth = new AuthService(SVC, false);
      const authP = auth.authenticate();

      const deadline = Date.now() + 2_000;
      while (wire.initiateCalls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(wire.initiateCalls.length).toBe(1);

      const init = wire.initiateCalls[0];
      await landOnLoopback(init.redirect_uri, init.state, 'fake-code-4');
      const result = await authP;
      expect(result.success).toBe(true);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE unset (default): unchanged direct behavior', () => {
  test('never probes keep, calls /auth/initiate directly', async () => {
    const auth = new AuthService(SVC, false);
    const authP = auth.authenticate();

    const deadline = Date.now() + 2_000;
    while (wire.initiateCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(wire.initiateCalls.length).toBe(1);

    const init = wire.initiateCalls[0];
    await landOnLoopback(init.redirect_uri, init.state, 'fake-code-5');
    const result = await authP;
    expect(result.success).toBe(true);
  });
});
