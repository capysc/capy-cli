/**
 * `capy connect --live --web` / `capy rotate --web` (live mode) over the
 * broker reverse channel (W2-D) — connect-live-gate is a payload-out screen:
 * the typed account-ID confirmation is a real value the user types into the
 * page, even though (unlike secret-intake) it is not itself a secret — it
 * was already IN the CLI's own request payload. The transport discipline is
 * pinned exactly the same way secret-intake's is: the typed confirmation
 * never appears in anything the CLI prints, and the account-id comparison
 * still happens CLI-side (`validateAnswer`), never trusted from the page.
 *
 * Mirrors `secretIntakeKeepScreen.test.ts`'s structure and its documented
 * trap: every `expect()` is deferred until after `promise` is fully awaited.
 *
 * ISOLATED (global.fetch swap + process.stdout.write interception):
 * registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { confirmLiveActionInBrowser } from '../../src/ui/connectScreens';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-live-gate-1';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;
const headers = { 'content-type': 'application/json' };
const ACCOUNT_ID = 'acct_CAPYFAKE_should_never_print_or_log';

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
  deletes: 0,
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
    wire.deletes += 1;
    return Response.json({ status: 'cancelled' });
  }
  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

beforeEach(() => {
  wire.createBody = null;
  wire.requestCiphertext = null;
  wire.page = null;
  wire.answerCiphertext = null;
  wire.deletes = 0;
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

const baseParams = {
  action: 'connect' as const,
  provider: 'stripe',
  projectName: 'acme',
  branch: 'main',
  varName: 'STRIPE_SECRET_KEY',
  accountId: ACCOUNT_ID,
  push: true,
  stops: [],
  open: false,
};

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sends the sealed request, opens the sealed answer, resolves true — and never prints the typed confirmation', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      stdoutChunks.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };

    let requestData: unknown = null;

    // Deferred assertions — see file header and secretIntakeKeepScreen's own
    // note on the orphaned-promise trap.
    const promise = confirmLiveActionInBrowser({ ...baseParams, authService: fakeAuthService() });

    let result: boolean | undefined;
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
          plaintext: JSON.stringify({
            v: 1,
            __action: 'submit',
            step: 'live-gate',
            confirmed: ACCOUNT_ID,
          }),
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
        });
      }
    } finally {
      result = await promise;
      process.stdout.write = originalWrite;
    }

    expect(wire.requestCiphertext).not.toBeNull();
    expect(requestData).toMatchObject({ accountId: ACCOUNT_ID, action: 'connect', nonce: '' });
    expect(result).toBe(true);
    expect(wire.createBody?.purpose).toBe('connect-live-gate');

    // THE TRANSPORT DISCIPLINE: the typed confirmation — even though it is
    // not itself secret, it is a real value that only ever existed in the
    // browser and the sealed channel — must not appear in anything printed.
    const allStdout = stdoutChunks.join('');
    expect(allStdout).not.toContain(ACCOUNT_ID);
  });

  test('a wrong confirmation is declined CLI-side (never trusted from the page) and falls back to the loopback form', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let url = '';
    const promise = confirmLiveActionInBrowser({
      ...baseParams,
      onListen: (u) => (url = u),
      timeoutMs: 8_000,
      authService: fakeAuthService(),
    });

    const deadline = Date.now() + 5_000;
    while (!wire.requestCiphertext && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(wire.requestCiphertext).not.toBeNull();

    wire.answerCiphertext = await sealEnvelopePageSide({
      // A mismatch — this is exactly what a compromised or buggy page could
      // send, and the CLI must not take its word for it.
      plaintext: JSON.stringify({ v: 1, __action: 'submit', step: 'live-gate', confirmed: 'not-the-account-id' }),
      connectionId: CONN_ID,
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
    });

    // Declined over the broker falls through to the SECOND (loopback) form —
    // the documented UX difference from the inline retry the loopback path
    // alone gives. Answer that one to let the promise resolve.
    const u = new URL(await waitForUrl(() => url));
    expect(u.hostname).toBe('127.0.0.1');
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { confirmed: ACCOUNT_ID } }),
    });
    expect(res.status).toBe(200);

    expect(await promise).toBe(true);
  });

  test('broker unavailable falls back to the loopback form', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    globalThis.fetch = ((url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith(`${SVC}/connections`) && init?.method === 'POST' && !u.includes('/request')) {
        return Promise.resolve(Response.json({ error: 'down', code: 'SERVICE_ERROR' }, { status: 503 }));
      }
      if (u.startsWith(SVC)) return serviceFetch(u, init);
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = confirmLiveActionInBrowser({
      ...baseParams,
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
      body: JSON.stringify({ nonce, payload: { confirmed: ACCOUNT_ID } }),
    });
    expect(res.status).toBe(200);
    expect(await done).toBe(true);
  });
});

describe('flag unset (default)', () => {
  test('confirmLiveActionInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = confirmLiveActionInBrowser({
      ...baseParams,
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
      body: JSON.stringify({ nonce, payload: { confirmed: ACCOUNT_ID } }),
    });
    expect(res.status).toBe(200);

    expect(await done).toBe(true);
    expect(brokerHit).toBe(false);
  });
});
