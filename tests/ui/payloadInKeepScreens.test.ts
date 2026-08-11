/**
 * The five `payload-in` keep screens (W2-B) that got real CLI dispatch
 * wiring this round — ConnectResult, DeployRunResult, RotateProgress,
 * SyncResult, SyncStatus — each pinned the same two ways secret-intake's
 * `payload-both` exemplar was: (1) `CAPY_KEEP_SCREENS=1` + `authService`
 * takes the keep path, sealing the exact `build<Name>Data(...)` payload the
 * loopback body would have served, to the right broker `purpose`; (2) the
 * flag unset (default) takes the unchanged loopback path with ZERO broker
 * traffic, even when `authService` is supplied — the byte-identical-when-off
 * guarantee.
 *
 * CommandError and SessionInfo are NOT covered here: neither has a CLI
 * dispatcher this round (see the W2-B report for why) — they are
 * `packages/ui`/fixtures/keep-app only.
 *
 * NOT ISOLATED: globalThis.fetch swap only, restored in `afterEach`, no
 * `mock.module()`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { showSyncStatusInBrowser, showSyncResultInBrowser } from '../../src/ui/syncScreens';
import { showConnectResultInBrowser } from '../../src/ui/connectScreens';
import { showRotateProgressInBrowser } from '../../src/ui/rotateScreens';
import { showDeployRunResultInBrowser } from '../../src/ui/deployScreens';
import type { AuthService } from '../../src/auth/authService';
import { mintPageKeypairPageSide, openRequestEnvelopePageSide } from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-payload-in-1';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;

function fakeAuthService(): AuthService {
  return {
    getServiceApiUrl: () => SVC,
    getValidToken: async () => ({ access_token: TOKEN }) as any,
  } as unknown as AuthService;
}

const wire = {
  createBody: null as null | Record<string, unknown>,
  requestCiphertext: null as null | string,
  page: null as null | Awaited<ReturnType<typeof mintPageKeypairPageSide>>,
};

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const path = url.slice(SVC.length);
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  if (path === '/connections' && init?.method === 'POST') {
    wire.createBody = body;
    return Response.json(
      { connection_id: CONN_ID, status: 'pending', expires_at: new Date(Date.now() + 900_000).toISOString() },
      { status: 201 },
    );
  }
  if (path.startsWith(`/connections/${CONN_ID}/result`)) {
    return Response.json({ status: wire.page ? 'attached' : 'pending', page_pubkey: wire.page?.pagePubkeyB64 });
  }
  if (path === `/connections/${CONN_ID}/request` && init?.method === 'POST') {
    wire.requestCiphertext = body.ciphertext;
    return Response.json({ status: 'sent' });
  }
  if (path === `/connections/${CONN_ID}` && init?.method === 'DELETE') {
    return Response.json({ status: 'cancelled' });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

beforeEach(async () => {
  wire.createBody = null;
  wire.requestCiphertext = null;
  wire.page = await mintPageKeypairPageSide();
  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(SVC)) return serviceFetch(u, init);
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CAPY_KEEP_SCREENS;
});

/** Opens the sealed request as the page would, returns the parsed JSON. */
async function openSent(): Promise<unknown> {
  expect(wire.requestCiphertext).not.toBeNull();
  const opened = await openRequestEnvelopePageSide({
    ciphertextB64: wire.requestCiphertext!,
    connectionId: CONN_ID,
    clientPubkeyB64: wire.createBody!.client_pubkey as string,
    pagePrivateKey: wire.page!.privateKey,
  });
  return JSON.parse(opened);
}

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sync-status: seals the status report over the broker, returns the keep URL', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const url = await showSyncStatusInBrowser({
      projectName: 'demo',
      branch: 'main',
      totalSecrets: 2,
      localMatchesPinned: true,
      remoteMatchesPinned: true,
      hasRemote: true,
      diffs: [],
      expiring: [],
      json: '{}',
      open: false,
      authService: fakeAuthService(),
    });
    expect(url).toContain(CONN_ID);
    expect(wire.createBody?.purpose).toBe('sync-status');
    expect(await openSent()).toMatchObject({ projectName: 'demo', branch: 'main', totalSecrets: 2 });
  });

  test('sync-result: seals the run report over the broker', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const url = await showSyncResultInBrowser({
      projectName: 'demo',
      branch: 'main',
      outcome: 'synced',
      pulled: [],
      pushed: [{ variable: 'API_KEY', type: 'new' }],
      envRewritten: true,
      open: false,
      authService: fakeAuthService(),
    });
    expect(url).toContain(CONN_ID);
    expect(wire.createBody?.purpose).toBe('sync-result');
    expect(await openSent()).toMatchObject({ outcome: 'synced', envRewritten: true });
  });

  test('connect-result: seals the connect outcome over the broker', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const url = await showConnectResultInBrowser({
      outcome: 'pushed',
      provider: 'stripe',
      projectName: 'demo',
      branch: 'main',
      varName: 'STRIPE_SECRET_KEY',
      stops: [],
      open: false,
      authService: fakeAuthService(),
    });
    expect(url).toContain(CONN_ID);
    expect(wire.createBody?.purpose).toBe('connect-result');
    expect(await openSent()).toMatchObject({ outcome: 'pushed', provider: 'stripe' });
  });

  test('rotate-progress: seals the rotation outcome over the broker', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    const url = await showRotateProgressInBrowser({
      outcome: 'rotated',
      projectName: 'demo',
      branch: 'main',
      all: false,
      noPush: false,
      devMode: false,
      stops: [],
      steps: [],
      keys: [],
      open: false,
      authService: fakeAuthService(),
    });
    expect(url).toContain(CONN_ID);
    expect(wire.createBody?.purpose).toBe('rotate-progress');
    expect(await openSent()).toMatchObject({ outcome: 'rotated' });
  });

  test('deploy-run-result: seals the deploy outcome over the broker (void return, no URL)', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    await showDeployRunResultInBrowser(
      {
        outcome: 'deployed',
        projectName: 'demo',
        target: { name: 'prod', adapterLabel: 'Vercel', branch: 'main', mode: 'direct' },
        steps: [],
      },
      { open: false, authService: fakeAuthService() },
    );
    expect(wire.createBody?.purpose).toBe('deploy-run-result');
    expect(await openSent()).toMatchObject({ outcome: 'deployed', projectName: 'demo' });
  });
});

describe('flag unset (default) — authService supplied, still loopback, zero broker traffic', () => {
  async function assertNoBrokerTraffic(run: () => Promise<unknown>): Promise<void> {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    await run();
    expect(brokerHit).toBe(false);
  }

  test('sync-status', () =>
    assertNoBrokerTraffic(() =>
      showSyncStatusInBrowser({
        projectName: 'demo',
        branch: 'main',
        totalSecrets: 0,
        localMatchesPinned: true,
        remoteMatchesPinned: true,
        hasRemote: false,
        diffs: [],
        expiring: [],
        json: '{}',
        open: false,
        timeoutMs: 500,
        authService: fakeAuthService(),
      }),
    ));

  test('sync-result', () =>
    assertNoBrokerTraffic(() =>
      showSyncResultInBrowser({
        projectName: 'demo',
        branch: 'main',
        outcome: 'nothing-to-do',
        pulled: [],
        pushed: [],
        envRewritten: false,
        open: false,
        timeoutMs: 500,
        authService: fakeAuthService(),
      }),
    ));

  test('connect-result', () =>
    assertNoBrokerTraffic(() =>
      showConnectResultInBrowser({
        outcome: 'cancelled',
        provider: 'stripe',
        projectName: 'demo',
        branch: 'main',
        varName: 'STRIPE_SECRET_KEY',
        stops: [],
        open: false,
        timeoutMs: 500,
        authService: fakeAuthService(),
      }),
    ));

  test('rotate-progress', () =>
    assertNoBrokerTraffic(() =>
      showRotateProgressInBrowser({
        outcome: 'failed',
        projectName: 'demo',
        branch: 'main',
        all: false,
        noPush: false,
        devMode: false,
        stops: [],
        steps: [],
        keys: [],
        open: false,
        timeoutMs: 500,
        authService: fakeAuthService(),
      }),
    ));

  test('deploy-run-result', () =>
    assertNoBrokerTraffic(() =>
      showDeployRunResultInBrowser(
        {
          outcome: 'failed',
          projectName: 'demo',
          target: { name: 'prod', adapterLabel: 'Vercel', branch: 'main', mode: 'direct' },
          steps: [],
        },
        { open: false, timeoutMs: 500, authService: fakeAuthService() },
      ),
    ));
});
