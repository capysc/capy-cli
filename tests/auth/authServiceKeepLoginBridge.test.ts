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
const forceLoginPending = mock(() => false);
mock.module('../../src/config/globalConfig', () => ({
  getAuthSessionPath: mock(() => '/tmp/capy-keepbridge-test/session.json'),
  getGlobalCapyDir: mock(() => '/tmp/capy-keepbridge-test-nonexistent'),
  consumeForceLoginMarker: mock(() => forceLoginPending()),
  isForceLoginMarkerPending: mock(() => forceLoginPending()),
}));

const captureOpenedUrl = mock((url: string) => url);
mock.module('../../src/ui/openScreen', () => ({
  openScreen: mock(async (url: string) => {
    captureOpenedUrl(url);
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

const captureInitiate = mock((value: Readonly<{
  state: string;
  redirect_uri: string;
  organization_id?: string;
}>) => value);

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const path = url.slice(SVC.length);

  if (path === '/auth/loopback/initiate') {
    captureInitiate({
      state: body.state,
      redirect_uri: body.redirect_uri,
      organization_id: body.organization_id,
    });
    return Response.json({
      auth_url: 'https://authkit.example.test/authorize',
      loopback_binding: 'service-signed-loopback-binding',
    });
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

const savedEnv = {
  CAPY_WEB_NO_OPEN: process.env.CAPY_WEB_NO_OPEN,
  CAPY_KEEP_LOGIN_BRIDGE: process.env.CAPY_KEEP_LOGIN_BRIDGE,
  CAPY_KEEP_ORIGIN: process.env.CAPY_KEEP_ORIGIN,
} as const;

beforeAll(() => {
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
  [saveSession, forceLoginPending, captureInitiate, captureOpenedUrl]
    .forEach((candidate) => candidate.mockClear());
  forceLoginPending.mockReturnValue(false);
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
  test('opens Keep with the signed local callback transport', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;

      const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
      const authP = auth.authenticate();

      const deadline = Date.now() + 2_000;
      while (captureOpenedUrl.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(captureOpenedUrl).toHaveBeenCalledTimes(1);
      const bridgeUrl = new URL(captureOpenedUrl.mock.calls[0]![0]);
      expect(bridgeUrl.origin).toBe(`http://127.0.0.1:${keepStub.port}`);
      expect(bridgeUrl.pathname).toBe('/auth/start');
      expect(bridgeUrl.searchParams.get('cli_transport')).toBe('loopback-direct');
      expect(bridgeUrl.searchParams.get('cli_binding')).toBe('service-signed-loopback-binding');
      expect(bridgeUrl.searchParams.get('cli_redirect')).toBeNull();

      expect(captureInitiate).toHaveBeenCalledTimes(1);

      const initiate = captureInitiate.mock.calls[0]![0];
      const cbRes = await landOnLoopback(initiate.redirect_uri, initiate.state, 'fake-code-1');
      expect(cbRes.status).toBe(200);

      const result = await authP;
      expect(result.success).toBe(true);
      expect(result.organization_id).toBe(ORG.id);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1, fresh sign-in', () => {
  test('opens Keep even when it was not probed first', async () => {
    process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
    process.env.CAPY_KEEP_ORIGIN = 'http://127.0.0.1:9';

    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const deadline = Date.now() + 2_000;
    while (captureInitiate.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(captureInitiate).toHaveBeenCalledTimes(1);
    const bridgeUrl = new URL(captureOpenedUrl.mock.calls[0]?.[0]);
    expect(bridgeUrl.origin).toBe('http://127.0.0.1:9');
    expect(bridgeUrl.pathname).toBe('/auth/start');
    expect(bridgeUrl.searchParams.get('cli_transport')).toBe('loopback-direct');
    expect(bridgeUrl.searchParams.get('cli_binding')).toBe('service-signed-loopback-binding');

    const init = captureInitiate.mock.calls[0]![0];
    const cbRes = await landOnLoopback(init.redirect_uri, init.state, 'fake-code-2');
    expect(cbRes.status).toBe(200);

    const result = await authP;
    expect(result.success).toBe(true);
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1 with an organization_id: direct local transport', () => {
  test('forwards organization_id to the Service-owned local transport', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;

      const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
      const authP = auth.authenticate(ORG.id);

      const deadline = Date.now() + 2_000;
      while (captureInitiate.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(captureInitiate).toHaveBeenCalledTimes(1);
      expect(captureInitiate.mock.calls[0]?.[0].organization_id).toBe(ORG.id);

      const init = captureInitiate.mock.calls[0]![0];
      await landOnLoopback(init.redirect_uri, init.state, 'fake-code-3');
      const result = await authP;
      expect(result.success).toBe(true);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE=1 with a pending force-login marker: direct local transport', () => {
  test('a pending marker uses the Service-owned local transport', async () => {
    const keepStub = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      process.env.CAPY_KEEP_LOGIN_BRIDGE = '1';
      process.env.CAPY_KEEP_ORIGIN = `http://127.0.0.1:${keepStub.port}`;
      forceLoginPending.mockReturnValue(true);

      const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
      const authP = auth.authenticate();

      const deadline = Date.now() + 2_000;
      while (captureInitiate.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(captureInitiate).toHaveBeenCalledTimes(1);

      const init = captureInitiate.mock.calls[0]![0];
      await landOnLoopback(init.redirect_uri, init.state, 'fake-code-4');
      const result = await authP;
      expect(result.success).toBe(true);
    } finally {
      keepStub.stop(true);
    }
  });
});

describe('CAPY_KEEP_LOGIN_BRIDGE unset (default): direct local transport', () => {
  test('never probes Keep and calls the Service local transport', async () => {
    const auth = new AuthService(SVC, false, undefined, memorySessionBackend);
    const authP = auth.authenticate();

    const deadline = Date.now() + 2_000;
    while (captureInitiate.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(captureInitiate).toHaveBeenCalledTimes(1);

    const init = captureInitiate.mock.calls[0]![0];
    await landOnLoopback(init.redirect_uri, init.state, 'fake-code-5');
    const result = await authP;
    expect(result.success).toBe(true);
  });
});
