/**
 * `capy deploy` (platform/mode questions) over the broker reverse channel
 * (W2-C). Same ceremony-per-question design as connect-setup's — see
 * connectSetupKeepScreen.test.ts's header and
 * `chooseDeployDestinationInBrowserViaKeep`'s own comment in
 * deployScreens.ts — but simpler: at most two questions (`platform`, then
 * `mode`), neither with an external side effect.
 *
 * ISOLATED (global.fetch swap): registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { chooseDeployDestinationInBrowser } from '../../src/ui/deployScreens';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;

function fakeAuthService(): AuthService {
  return {
    getServiceApiUrl: () => SVC,
    getValidToken: async () => ({ access_token: TOKEN }) as any,
  } as unknown as AuthService;
}

const connections = new Map<
  string,
  { createBody: Record<string, unknown>; requestCiphertext: string | null; answerCiphertext: string | null; page: Awaited<ReturnType<typeof mintPageKeypairPageSide>> }
>();
let nextConnId = 0;
const createdOrder: string[] = [];

async function serviceFetch(url: string, init?: RequestInit): Promise<Response> {
  const path = url.slice(SVC.length);
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  if (path === '/connections' && init?.method === 'POST') {
    const id = `conn-${++nextConnId}`;
    const page = await mintPageKeypairPageSide();
    connections.set(id, { createBody: body, requestCiphertext: null, answerCiphertext: null, page });
    createdOrder.push(id);
    return Response.json(
      { connection_id: id, status: 'pending', expires_at: new Date(Date.now() + 900_000).toISOString() },
      { status: 201 },
    );
  }

  const resultMatch = path.match(/^\/connections\/([^/]+)\/result/);
  if (resultMatch) {
    const c = connections.get(resultMatch[1]);
    if (!c) return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
    if (c.answerCiphertext) {
      const ciphertext = c.answerCiphertext;
      c.answerCiphertext = null;
      return Response.json({ status: 'answered', ciphertext, page_pubkey: c.page.pagePubkeyB64 });
    }
    return Response.json({ status: 'attached', page_pubkey: c.page.pagePubkeyB64 });
  }

  const requestMatch = path.match(/^\/connections\/([^/]+)\/request$/);
  if (requestMatch && init?.method === 'POST') {
    const c = connections.get(requestMatch[1]);
    if (!c) return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
    c.requestCiphertext = body.ciphertext;
    return Response.json({ status: 'sent' });
  }

  const deleteMatch = path.match(/^\/connections\/([^/]+)$/);
  if (deleteMatch && init?.method === 'DELETE') {
    return Response.json({ status: 'cancelled' });
  }

  return Response.json({ error: 'unexpected', code: 'NOT_FOUND' }, { status: 404 });
}

beforeEach(() => {
  connections.clear();
  createdOrder.length = 0;
  nextConnId = 0;
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

async function answerQuestion(index: number, plaintext: string): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  while (createdOrder.length < index && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const id = createdOrder[index - 1];
  const c = connections.get(id)!;
  while (!c.requestCiphertext && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const opened = await openRequestEnvelopePageSide({
    ciphertextB64: c.requestCiphertext!,
    connectionId: id,
    clientPubkeyB64: c.createBody.client_pubkey as string,
    pagePrivateKey: c.page.privateKey,
  });
  const requestData = JSON.parse(opened);
  c.answerCiphertext = await sealEnvelopePageSide({
    plaintext,
    connectionId: id,
    clientPubkeyB64: c.createBody.client_pubkey as string,
  });
  return requestData;
}

const PLATFORMS = [
  { id: 'vercel', name: 'Vercel', hasConnector: true },
  { id: 'heroku', name: 'Heroku', hasConnector: false },
];

describe('CAPY_KEEP_SCREENS=1', () => {
  test('platform (with a connector) then mode — two questions, two connections', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';

    const promise = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      open: false,
      authService: fakeAuthService(),
    });

    const q1 = await answerQuestion(1, JSON.stringify({ platform: 'vercel' }));
    expect(q1).toMatchObject({ nonce: '', step: 'platform' });

    const q2 = await answerQuestion(2, JSON.stringify({ mode: 'connector' }));
    expect(q2).toMatchObject({ nonce: '', step: 'mode' });

    const result = await promise;
    expect(result).toEqual({ platform: 'vercel', mode: 'connector', cancelled: false });
    expect(createdOrder.length).toBe(2);
  });

  test('a platform with no connector skips the mode question entirely — one connection only', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';

    const promise = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      open: false,
      authService: fakeAuthService(),
    });

    await answerQuestion(1, JSON.stringify({ platform: 'heroku' }));

    const result = await promise;
    expect(result).toEqual({ platform: 'heroku', mode: null, cancelled: false });
    expect(createdOrder.length).toBe(1);
  });
});

describe('flag unset (default)', () => {
  test('chooseDeployDestinationInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = chooseDeployDestinationInBrowser({
      platforms: PLATFORMS,
      open: false,
      onListen: (u) => (url = u),
      timeoutMs: 8_000,
      authService: fakeAuthService(),
    });

    const deadline = Date.now() + 5_000;
    while (!url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const u = new URL(url);
    expect(u.hostname).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: u.searchParams.get('n') ?? '',
        payload: { __action: 'submit', platform: 'heroku' },
      }),
    });
    expect(res.status).toBe(200);
    const result = await done;

    expect(result).toEqual({ platform: 'heroku', mode: null, cancelled: false });
    expect(brokerHit).toBe(false);
  });
});
