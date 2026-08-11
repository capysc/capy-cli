/**
 * `capy connect stripe` (the var/mode/overwrite/account/refresh questions)
 * over the broker reverse channel (W2-C).
 *
 * UNLIKE every other payload-both screen in this wave, `askConnectInBrowser`
 * can ask UP TO SIX questions in sequence over one loopback server (a page
 * RELOAD per question). The broker has no reload equivalent
 * (single-send-per-connection, CAP-376/W1-A), so `askConnectInBrowserViaKeep`
 * mints ONE connection PER QUESTION instead — see that function's own
 * comment in connectScreens.ts for the full design note and its UX
 * trade-off (a run with N outstanding questions opens N tabs in sequence).
 * This test pins that ceremony-per-question shape end to end across a real
 * two-question sequence (`var` then `mode`), each answered over ITS OWN
 * connection, and confirms the CLI never mixes transports mid-sequence: a
 * failure on question 2 falls the WHOLE run back to loopback rather than
 * reusing question 1's already-collected answer.
 *
 * `connect-overwrite` is exercised separately below: it renders through the
 * exact same `askConnectInBrowserViaKeep` loop (picked by `q.kind ===
 * 'overwrite'`), just as one question in a one-question array.
 *
 * ISOLATED (global.fetch swap): registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { askConnectInBrowser } from '../../src/ui/connectScreens';
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

/** One stub connection per broker `createConnection` call — mints a fresh
 *  id each time, which is exactly what mints once per QUESTION under the
 *  ceremony-per-question design this test pins. */
const connections = new Map<
  string,
  { createBody: Record<string, unknown>; requestCiphertext: string | null; answerCiphertext: string | null; page: Awaited<ReturnType<typeof mintPageKeypairPageSide>> }
>();
let nextConnId = 0;
/** Populated by the test as each connection is created, so it can drive
 *  the page side of whichever connection just opened. */
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

/** Wait for the Nth connection (1-indexed) to exist and have a sealed
 *  request on it, then answer it as the page would. */
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

const PLAN = { standing: 'var' } as any;

describe('CAPY_KEEP_SCREENS=1 — var then mode, two questions, two connections', () => {
  test('each question gets its OWN connection; answers fold forward into one result', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';

    const promise = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'demo',
      branch: 'main',
      plan: PLAN,
      questions: [
        { kind: 'var', vars: [{ name: 'STRIPE_SECRET_KEY', looksRelated: true, hasValue: false }], defaultVarName: 'STRIPE_SECRET_KEY' },
        { kind: 'mode', modes: [{ id: 'test', available: true }, { id: 'live', available: true }] },
      ],
      open: false,
      authService: fakeAuthService(),
    });

    const q1 = await answerQuestion(1, JSON.stringify({ step: 'var', var: 'STRIPE_SECRET_KEY' }));
    expect(q1).toMatchObject({ nonce: '', step: 'var' });

    const q2 = await answerQuestion(2, JSON.stringify({ step: 'mode', mode: 'test' }));
    expect(q2).toMatchObject({ nonce: '', step: 'mode' });

    const result = await promise;
    expect(result).toEqual({ answers: { var: 'STRIPE_SECRET_KEY', mode: 'test' }, cancelled: false });
    expect(createdOrder.length).toBe(2);
  });

  test('a failure on the SECOND question falls the whole run back to loopback, not a mid-sequence transport switch', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';

    let url = '';
    const promise = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'demo',
      branch: 'main',
      plan: PLAN,
      questions: [
        { kind: 'var', vars: [{ name: 'STRIPE_SECRET_KEY', looksRelated: true, hasValue: false }], defaultVarName: 'STRIPE_SECRET_KEY' },
        { kind: 'mode', modes: [{ id: 'test', available: true }, { id: 'live', available: true }] },
      ],
      open: false,
      onListen: (u) => (url = u),
      timeoutMs: 3_000,
      authService: fakeAuthService(),
    });

    await answerQuestion(1, JSON.stringify({ step: 'var', var: 'STRIPE_SECRET_KEY' }));
    // Question 2 is answered with something the mode step cannot produce —
    // declined, folding the whole sequence back to loopback FROM QUESTION 1,
    // not a resume with question 1's keep answer reused.
    await answerQuestion(2, JSON.stringify({ step: 'mode', mode: 'not-a-real-mode' }));

    const deadline = Date.now() + 5_000;
    while (!url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const u = new URL(url);
    expect(u.hostname).toBe('127.0.0.1'); // the loopback fallback, not keep.capy.sc

    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: u.searchParams.get('n') ?? '',
        payload: { __action: 'cancel' },
      }),
    });
    expect(res.status).toBe(200);
    const result = await promise;
    expect(result).toEqual({ answers: {}, cancelled: true });
  });
});

describe('connect-overwrite — one question, same loop, own connection', () => {
  test('sends ConnectOverwriteData, resolves { overwrite: true } from the sealed answer', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';

    const promise = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'demo',
      branch: 'main',
      plan: PLAN,
      questions: [
        {
          kind: 'overwrite',
          varName: 'STRIPE_SECRET_KEY',
          current: { pushed: true },
          incoming: { keyPrefix: 'rk_test_', mode: 'test', fingerprint: 'abc…xyz' },
        },
      ],
      open: false,
      authService: fakeAuthService(),
    });

    const requestData = await answerQuestion(
      1,
      JSON.stringify({ step: 'overwrite', overwrite: true }),
    );
    expect(requestData).toMatchObject({ nonce: '', varName: 'STRIPE_SECRET_KEY' });

    const result = await promise;
    expect(result).toEqual({ answers: { overwrite: true }, cancelled: false });
  });
});

describe('flag unset (default)', () => {
  test('askConnectInBrowser with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    const done = askConnectInBrowser({
      provider: 'stripe',
      projectName: 'demo',
      branch: 'main',
      plan: PLAN,
      questions: [{ kind: 'var', vars: [], defaultVarName: 'STRIPE_SECRET_KEY' }],
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
        payload: { __action: 'submit', var: 'STRIPE_SECRET_KEY' },
      }),
    });
    expect(res.status).toBe(200);
    const result = await done;

    expect(result).toEqual({ answers: { var: 'STRIPE_SECRET_KEY' }, cancelled: false });
    expect(brokerHit).toBe(false);
  });
});
