/**
 * `capy checkout` (branch picker) over the broker reverse channel (W2-C),
 * following secret-intake's harness (W2-A): the CLI sends a sealed
 * BranchListData request once the page publishes page_pubkey, opens the
 * page's sealed `{__action, branch}` answer, and resolves it against the
 * branch list THIS run offered — never trusted blind.
 *
 * Flag unset is pinned separately, with `authService` still supplied: zero
 * broker traffic, the ordinary loopback round trip, unchanged.
 *
 * ISOLATED (global.fetch swap): registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { chooseBranchInBrowser } from '../../src/ui/branchScreens';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-branch-list-1';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;
const headers = { 'content-type': 'application/json' };

function fakeAuthService(): AuthService {
  return {
    getServiceApiUrl: () => SVC,
    getValidToken: async () => ({ access_token: TOKEN }) as any,
  } as unknown as AuthService;
}

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
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

const BRANCHES = [
  { id: 'b1', name: 'main', is_protected: false, created_at: '2026-08-01T00:00:00.000Z' },
  { id: 'b2', name: 'staging', is_protected: false, created_at: '2026-08-01T00:00:00.000Z' },
] as any;

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sends the sealed BranchListData request, opens the sealed answer, resolves the picked branch', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let requestData: unknown = null;
    let result: unknown;

    const promise = chooseBranchInBrowser({
      projectName: 'demo',
      activeBranch: 'main',
      branches: BRANCHES,
      canDelete: false,
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
          plaintext: JSON.stringify({ __action: 'switch', branch: 'staging' }),
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
        });
      }
    } finally {
      result = await promise;
    }

    expect(wire.requestCiphertext).not.toBeNull();
    expect(requestData).toMatchObject({ nonce: '', activeBranch: 'main' });
    expect(wire.createBody?.purpose).toBe('branch-list');
    expect(result).toEqual({ branch: 'staging', cancelled: false });
  });

  test('an answer naming a branch this run never offered is declined, not trusted', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let url = '';
    const promise = chooseBranchInBrowser({
      projectName: 'demo',
      activeBranch: 'main',
      branches: BRANCHES,
      canDelete: false,
      open: false,
      onListen: (u) => (url = u),
      timeoutMs: 3_000,
      authService: fakeAuthService(),
    });

    const deadline = Date.now() + 5_000;
    while (!wire.requestCiphertext && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    wire.answerCiphertext = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ __action: 'switch', branch: 'not-a-real-branch' }),
      connectionId: CONN_ID,
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
    });

    // Declined (typed validation fails) means the keep path degrades to the
    // loopback fallback, which then waits for a browser that never comes —
    // bounded by the short timeoutMs above rather than hanging the test.
    await expect(promise).rejects.toBeDefined();
  });
});

describe('flag unset (default)', () => {
  test('chooseBranchInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = chooseBranchInBrowser({
      projectName: 'demo',
      activeBranch: 'main',
      branches: BRANCHES,
      canDelete: false,
      open: false,
      onListen: (u) => (url = u),
      timeoutMs: 8_000,
      authService: fakeAuthService(),
    });

    const u = new URL(await waitForUrl(() => url));
    expect(u.hostname).toBe('127.0.0.1');
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { __action: 'switch', branch: 'staging' } }),
    });
    expect(res.status).toBe(200);
    const result = await done;

    expect(result).toEqual({ branch: 'staging', cancelled: false });
    expect(brokerHit).toBe(false);
  });
});
