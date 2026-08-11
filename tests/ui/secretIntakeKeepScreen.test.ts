/**
 * `capy add --web` over the broker reverse channel (W2-A) — secret-intake as
 * the migration harness's payload-bearing exemplar.
 *
 * Pins the whole ceremony end to end against a stub broker: the CLI sends a
 * sealed SecretIntakeData request once the page publishes page_pubkey, opens
 * the page's sealed answer, and calls `onSubmit` with the plaintext pairs.
 * The load-bearing assertion is the security property from the task brief:
 * the raw secret value must never appear on stdout, however the CLI's own
 * progress/URL lines are written.
 *
 * Flag unset is pinned separately, with `authService` still supplied: zero
 * broker traffic, the ordinary loopback round trip, unchanged from before
 * this file existed.
 *
 * ISOLATED (global.fetch swap + process.stdout.write interception):
 * registered in run-tests.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runWebIntake } from '../../src/ui/secretIntakeScreen';
import type { AuthService } from '../../src/auth/authService';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
  sealEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-secret-intake-1';
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
      // Single-delivery, matching the real service: the ciphertext is
      // consumed by the transactional claim on first read.
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

describe('CAPY_KEEP_SCREENS=1', () => {
  test('sends the sealed SecretIntakeData request, opens the sealed answer, calls onSubmit — and never prints the value', async () => {
    process.env.CAPY_KEEP_SCREENS = '1';
    wire.page = await mintPageKeypairPageSide();

    let captured: Array<{ name: string; value: string }> | null = null;
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      stdoutChunks.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };

    // A name with NO vendor-logo match (unlike e.g. STRIPE_SECRET_KEY) keeps
    // the request payload's shape simple to assert on below.
    const secretValue = 'sk_test_CAPYFAKE_should_never_print_or_log';
    let requestData: unknown = null;

    // Every `expect()` in this test is deliberately deferred to AFTER
    // `promise` is fully awaited (down at the bottom): an assertion that
    // throws WHILE `promise` is still in flight would leave its internal
    // awaitAnswer poll loop orphaned — still calling `globalThis.fetch` on
    // its own timer well after this test function has returned, potentially
    // reading whatever fetch spy a LATER test installs. Capture data into
    // locals here; assert on them only once nothing is still running.
    const promise = runWebIntake(
      { vars: [{ name: 'MY_SERVICE_TOKEN' }], open: false, authService: fakeAuthService() },
      async (pairs) => {
        captured = pairs;
      },
    );

    try {
      // Wait for the CLI to seal and send its reverse-channel request.
      const deadline = Date.now() + 5_000;
      while (!wire.requestCiphertext && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      if (wire.requestCiphertext) {
        // Open it as the page would: this same SecretIntakeData, minus a
        // meaningful nonce.
        const opened = await openRequestEnvelopePageSide({
          ciphertextB64: wire.requestCiphertext,
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
          pagePrivateKey: wire.page.privateKey,
        });
        requestData = JSON.parse(opened);

        // Answer as the page would, sealing the value the "user typed".
        wire.answerCiphertext = await sealEnvelopePageSide({
          plaintext: JSON.stringify({
            v: 1,
            vars: [{ name: 'MY_SERVICE_TOKEN', value: secretValue }],
          }),
          connectionId: CONN_ID,
          clientPubkeyB64: wire.createBody!.client_pubkey as string,
        });
      }
    } finally {
      await promise;
      process.stdout.write = originalWrite;
    }

    expect(wire.requestCiphertext).not.toBeNull();
    expect(requestData).toMatchObject({ vars: [{ name: 'MY_SERVICE_TOKEN' }], nonce: '' });
    expect(captured).toEqual([{ name: 'MY_SERVICE_TOKEN', value: secretValue }]);
    expect(wire.createBody?.purpose).toBe('secret-intake');

    // THE SECURITY PROPERTY: whatever the CLI printed while relaying (the
    // keep URL, progress), the raw secret value is not among it.
    const allStdout = stdoutChunks.join('');
    expect(allStdout).not.toContain(secretValue);
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
    const done = runWebIntake(
      { vars: [{ name: 'A' }], open: false, onListen: (u) => (url = u), timeoutMs: 8_000, authService: fakeAuthService() },
      async () => {},
    );

    const u = new URL(await waitForUrl(() => url));
    expect(u.hostname).toBe('127.0.0.1'); // the loopback fallback, not keep.capy.sc
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { vars: [{ name: 'A', value: 'x' }] } }),
    });
    expect(res.status).toBe(200);
    await done;
  });
});

describe('flag unset (default)', () => {
  test('runWebIntake with authService supplied still takes the loopback path — zero broker traffic, unchanged', async () => {
    delete process.env.CAPY_KEEP_SCREENS;
    let brokerHit = false;
    globalThis.fetch = ((url: any, init?: any) => {
      if (String(url).startsWith(SVC)) brokerHit = true;
      return realFetch(url, init);
    }) as typeof fetch;

    let url = '';
    let received: Array<{ name: string; value: string }> | null = null;
    const done = runWebIntake(
      { vars: [{ name: 'A' }], open: false, onListen: (u) => (url = u), timeoutMs: 8_000, authService: fakeAuthService() },
      async (pairs) => {
        received = pairs;
      },
    );

    const u = new URL(await waitForUrl(() => url));
    expect(u.hostname).toBe('127.0.0.1');
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: { vars: [{ name: 'A', value: 'va' }] } }),
    });
    expect(res.status).toBe(200);
    await done;

    expect(received).toEqual([{ name: 'A', value: 'va' }]);
    expect(brokerHit).toBe(false);
  });
});
