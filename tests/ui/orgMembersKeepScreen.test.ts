/**
 * `capy kick --web` over the broker reverse channel (W2-D) — org-members
 * (payload-in tier: the page answers with a selection/click, no free-typed
 * value). Pins the round trip end to end against a stub broker, plus the
 * flag-off byte-identical guarantee. Also includes the transport-discipline
 * stdout check even though this tier does not strictly require it (the
 * recipe only mandates it for payload-out/secret-bearing screens) — cheap to
 * add, and the member's email is still PII worth keeping off stdout.
 *
 * Mirrors `secretIntakeKeepScreen.test.ts`'s structure and its documented
 * trap: every `expect()` is deferred until after `promise` is fully awaited.
 *
 * ISOLATED (global.fetch swap + process.stdout.write interception):
 * registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { confirmKickInBrowser } from '../../src/ui/memberScreens';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-org-members-1';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;
const headers = { 'content-type': 'application/json' };
const MEMBER_EMAIL = 'ex-member+capyfake@example.test';
const MEMBERSHIP_ID = 'mem_CAPYFAKE_should_never_print_or_log';

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
  orgName: 'Acme',
  callerRole: 'admin',
  currentUserId: 'user_caller',
  member: {
    membershipId: MEMBERSHIP_ID,
    userId: 'user_target',
    email: MEMBER_EMAIL,
    role: 'member',
    status: 'active',
    projects: [],
  },
  open: false,
};

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sends the sealed request, opens the sealed answer, resolves true — and never prints the member email', async () => {
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
    const promise = confirmKickInBrowser({ ...baseParams, authService: fakeAuthService() });

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
          plaintext: JSON.stringify({ v: 1, action: 'remove', membershipId: MEMBERSHIP_ID }),
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
        });
      }
    } finally {
      result = await promise;
      process.stdout.write = originalWrite;
    }

    expect(wire.requestCiphertext).not.toBeNull();
    expect(requestData).toMatchObject({
      orgName: 'Acme',
      view: 'confirm-remove',
      subjectUserId: 'user_target',
      nonce: '',
    });
    expect(result).toBe(true);
    expect(wire.createBody?.purpose).toBe('org-members');

    const allStdout = stdoutChunks.join('');
    expect(allStdout).not.toContain(MEMBER_EMAIL);
  });

  test('an answer for the wrong membership is declined CLI-side and falls back to the loopback form', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let url = '';
    const promise = confirmKickInBrowser({
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
      // A different membershipId than the one this command is about — the
      // reducer refuses this, never trusting the id in the payload.
      plaintext: JSON.stringify({ v: 1, action: 'remove', membershipId: 'mem_someone_else' }),
      connectionId: CONN_ID,
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
    });

    const u = new URL(await waitForUrl(() => url));
    expect(u.hostname).toBe('127.0.0.1');
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { action: 'remove', membershipId: MEMBERSHIP_ID } }),
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
    const done = confirmKickInBrowser({
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
      body: JSON.stringify({ nonce, payload: { action: 'remove', membershipId: MEMBERSHIP_ID } }),
    });
    expect(res.status).toBe(200);
    expect(await done).toBe(true);
  });
});

describe('flag unset (default)', () => {
  test('confirmKickInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = confirmKickInBrowser({
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
      body: JSON.stringify({ nonce, payload: { action: 'remove', membershipId: MEMBERSHIP_ID } }),
    });
    expect(res.status).toBe(200);

    expect(await done).toBe(true);
    expect(brokerHit).toBe(false);
  });
});
