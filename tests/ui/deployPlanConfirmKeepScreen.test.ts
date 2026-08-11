/**
 * `capy deploy <target>` gate over the broker reverse channel (W2-C).
 * Mirrors branchListKeepScreen.test.ts: the CLI sends a sealed
 * DeployPlanConfirmData request once the page publishes page_pubkey, opens
 * the page's sealed `{decision, force?, target?}` answer, and resolves it
 * against `allow` and (for `delete`) the target's own name — never trusted
 * blind, same as the loopback reducer's `str(payload.target) !==
 * p.target.name` check.
 *
 * Tests the `confirmDeployInBrowser` mechanism directly — no command call
 * site supplies `authService` yet (see `WebDeployConfirmParams`'s own
 * comment: `capy deploy` authenticates only after the plan is approved).
 *
 * Flag unset is pinned separately: zero broker traffic, unchanged loopback.
 *
 * ISOLATED (global.fetch swap): registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { confirmDeployInBrowser } from '../../src/ui/deployScreens';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-deploy-plan-confirm-1';
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
  answerCiphertext: null as null | string,
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
    if (wire.answerCiphertext) {
      const ciphertext = wire.answerCiphertext;
      wire.answerCiphertext = null;
      return Response.json({ status: 'answered', ciphertext, page_pubkey: wire.page?.pagePubkeyB64 });
    }
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

beforeEach(() => {
  wire.createBody = null;
  wire.requestCiphertext = null;
  wire.page = null;
  wire.answerCiphertext = null;
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

const TARGET = {
  name: 'prod',
  adapterId: 'vercel',
  adapterLabel: 'Vercel',
  branch: 'main',
  mode: 'direct' as const,
  options: [],
  vars: [],
  saved: true,
};

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sends the sealed DeployPlanConfirmData request, opens the sealed answer, resolves the decision', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let requestData: unknown = null;
    let result: unknown;

    const promise = confirmDeployInBrowser({
      target: TARGET,
      action: 'direct',
      dryRun: false,
      preflight: [{ id: 'preflight', label: 'Vercel preflight', state: 'ok' }],
      signedIn: true,
      open: false,
      authService: fakeAuthService(),
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!wire.requestCiphertext && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      if (wire.requestCiphertext) {
        const opened = await openRequestEnvelopePageSide({
          ciphertextB64: wire.requestCiphertext,
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
          pagePrivateKey: wire.page.privateKey,
        });
        requestData = JSON.parse(opened);

        wire.answerCiphertext = await sealEnvelopePageSide({
          plaintext: JSON.stringify({ decision: 'deploy', force: false }),
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
        });
      }
    } finally {
      result = await promise;
    }

    expect(wire.requestCiphertext).not.toBeNull();
    expect(requestData).toMatchObject({ nonce: '', target: { name: 'prod' }, action: 'direct' });
    expect(wire.createBody?.purpose).toBe('deploy-plan-confirm');
    expect(result).toEqual({ decision: 'deploy', force: false, cancelled: false });
  });

  test('a delete answer naming a DIFFERENT target than this page is about is declined, not trusted', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    const promise = confirmDeployInBrowser({
      target: TARGET,
      action: 'direct',
      dryRun: false,
      preflight: [{ id: 'preflight', label: 'Vercel preflight', state: 'ok' }],
      signedIn: true,
      open: false,
      timeoutMs: 3_000,
      authService: fakeAuthService(),
    });

    const deadline = Date.now() + 5_000;
    while (!wire.requestCiphertext && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    wire.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ decision: 'delete', target: 'some-other-target' }),
      connectionId: CONN_ID,
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
    });

    // Declined (typed validation fails the name match) degrades to the
    // loopback fallback, which then waits for a browser that never comes —
    // bounded by the short timeoutMs above.
    await expect(promise).rejects.toBeDefined();
  });
});

describe('flag unset (default)', () => {
  test('confirmDeployInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = confirmDeployInBrowser({
      target: TARGET,
      action: 'direct',
      dryRun: false,
      preflight: [{ id: 'preflight', label: 'Vercel preflight', state: 'ok' }],
      signedIn: true,
      open: false,
      onListen: (u) => (url = u),
      timeoutMs: 8_000,
      authService: fakeAuthService(),
    });

    const deadline = Date.now() + 5_000;
    while (!url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const u = new URL(url);
    expect(u.hostname).toBe('127.0.0.1');
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, payload: { decision: 'deploy', force: false } }),
    });
    expect(res.status).toBe(200);
    const result = await done;

    expect(result).toEqual({ decision: 'deploy', force: false, cancelled: false });
    expect(brokerHit).toBe(false);
  });
});
