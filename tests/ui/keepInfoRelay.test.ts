/**
 * `runKeepInfoScreen` (W2-B) — the generic CLI-side relay for `payload-in`
 * keep screens: create -> print/open the keep URL -> wait for the page to
 * attach and publish `page_pubkey` -> seal and send the request payload ->
 * DONE. Unlike `runKeepPayloadScreen` (secret-intake's `payload-both`
 * exemplar, see `secretIntakeKeepScreen.test.ts`) there is no answer to wait
 * for, so this pins the shorter sequence directly against a stub broker
 * rather than through any one screen's dispatcher.
 *
 * NOT ISOLATED: globalThis.fetch swap only, restored in `afterEach`, no
 * `mock.module()`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runKeepInfoScreen } from '../../src/service/keepPayloadRelay';
import {
  mintPageKeypairPageSide,
  openRequestEnvelopePageSide,
} from '../helpers/sealEnvelope';

const SVC = 'http://capy-svc.test';
const CONN_ID = 'conn-info-1';
const TOKEN = 'org-scoped-test-token';
const realFetch = globalThis.fetch;

const wire = {
  createBody: null as null | Record<string, unknown>,
  requestCiphertext: null as null | string,
  page: null as null | Awaited<ReturnType<typeof mintPageKeypairPageSide>>,
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
  wire.deletes = 0;
  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(SVC)) return serviceFetch(u, init);
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('runKeepInfoScreen', () => {
  test('seals and sends the request once the page attaches, returns {kind:"sent", url}, never waits for an answer', async () => {
    wire.page = await mintPageKeypairPageSide();

    const outcome = await runKeepInfoScreen({
      screen: 'sync-status',
      handoffFlow: 'sync',
      label: 'test',
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      requestPayload: { projectName: 'demo', totalSecrets: 3 },
      deadlineMs: 5_000,
    });

    expect(outcome.kind).toBe('sent');
    if (outcome.kind !== 'sent') throw new Error('unreachable');
    expect(outcome.url).toContain(CONN_ID);
    expect(wire.createBody?.purpose).toBe('sync-status');
    expect(wire.requestCiphertext).not.toBeNull();

    const opened = await openRequestEnvelopePageSide({
      ciphertextB64: wire.requestCiphertext!,
      connectionId: CONN_ID,
      clientPubkeyB64: wire.createBody!.client_pubkey as string,
      pagePrivateKey: wire.page.privateKey,
    });
    expect(JSON.parse(opened)).toEqual({ projectName: 'demo', totalSecrets: 3 });

    // No answer was ever polled for — the whole point of `payload-in`.
    expect(wire.deletes).toBe(0);
  });

  test('broker unavailable at create -> {kind:"unavailable"}, no connection made', async () => {
    globalThis.fetch = ((url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith(`${SVC}/connections`) && init?.method === 'POST') {
        return Promise.resolve(Response.json({ error: 'down', code: 'SERVICE_ERROR' }, { status: 503 }));
      }
      if (u.startsWith(SVC)) return serviceFetch(u, init);
      return realFetch(url, init);
    }) as typeof fetch;

    const outcome = await runKeepInfoScreen({
      screen: 'sync-status',
      handoffFlow: 'sync',
      label: 'test',
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      requestPayload: {},
      deadlineMs: 200,
    });

    expect(outcome.kind).toBe('unavailable');
  });

  test('page never attaches -> {kind:"declined"}, connection cancelled', async () => {
    // wire.page stays null: /result always reports 'pending', never a
    // page_pubkey, so awaitPagePubkey's poll runs out its deadline.
    const outcome = await runKeepInfoScreen({
      screen: 'sync-status',
      handoffFlow: 'sync',
      label: 'test',
      serviceApiUrl: SVC,
      getToken: async () => TOKEN,
      requestPayload: {},
      deadlineMs: 150,
    });

    expect(outcome.kind).toBe('declined');
    // Best-effort cleanup happens at least once — `awaitPagePubkey` itself
    // cancels on its own `timeout` before `runKeepInfoScreen`'s
    // `cancelQuietly` runs too (the same double-call shape
    // `runKeepPayloadScreen` already has; cancel is idempotent).
    expect(wire.deletes).toBeGreaterThanOrEqual(1);
  });
});
