import { describe, test, expect } from 'bun:test';
import { request as httpRequestRaw, type IncomingHttpHeaders, type IncomingMessage } from 'http';
import { createConnection } from 'net';
import { randomUUID, createHmac } from 'crypto';
import {
  handoffProofMessage,
  verifyHandoffProof,
  buildHandoffUrl,
  parseHandoffRequest,
  startLocalHandoff,
  type StartLocalHandoffOptions,
} from '../../src/ui/localHandoff';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { mintPageKeypairPageSide, openRequestEnvelopePageSide } from '../helpers/sealEnvelope';

/**
 * Plain node http instead of fetch: CI runners route fetch through an egress
 * proxy that intercepts even loopback requests (see screenServe.test.ts).
 * http.request talks to 127.0.0.1 directly.
 */
/** Reads a response body by recursing over the async iterator — the same
 * shape as `localHandoff.ts`'s own `readCappedBody`, never `chunks.push`. */
async function collectBody(res: IncomingMessage): Promise<Buffer> {
  const iterator = (res as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const loop = async (chunks: readonly Buffer[]): Promise<Buffer> => {
    const next = await iterator.next();
    if (next.done) return Buffer.concat([...chunks]);
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    return loop([...chunks, chunk]);
  };
  return loop([]);
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        void collectBody(res)
          .then((buf) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf.toString('utf8') }))
          .catch(reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function parseHandoffUrl(url: string): { port: number; id: string; secret: string; f: string } {
  const [beforeHash, hash] = url.split('#');
  const params = new URLSearchParams(hash);
  return {
    port: Number(params.get('port')),
    id: params.get('id') ?? '',
    secret: params.get('secret') ?? '',
    f: new URL(beforeHash).searchParams.get('f') ?? '',
  };
}

// docs/flows/local-handoff.md §4.6 — shared across CLI and Keep.
const VECTOR = {
  secret: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  handoffId: '10000000-0000-4000-8000-000000000001',
  codeChallenge: 'vC_2LhB6HPwvyKEGRMmpy218v0HaFdXn3q5GzarIPyI',
  pagePubkey: 'BAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
  proof: 'nFgYfJTLfsLLrhyjUtr6mQHFrBDffOaA8QbL7FLwmFw',
} as const;

describe('the shared §4.6 test vector', () => {
  test('the message is the newline-joined prefix, id, challenge and page key', () => {
    expect(handoffProofMessage(VECTOR.handoffId, VECTOR.codeChallenge, VECTOR.pagePubkey)).toBe(
      `capy-local-handoff-v1\n${VECTOR.handoffId}\n${VECTOR.codeChallenge}\n${VECTOR.pagePubkey}`,
    );
  });

  test('verifies against the pinned proof bytes', () => {
    expect(verifyHandoffProof(VECTOR.secret, VECTOR.handoffId, VECTOR.codeChallenge, VECTOR.pagePubkey, VECTOR.proof)).toBe(true);
  });

  test('a wrong secret, id, challenge, page key or proof each fail verification', () => {
    const otherId = '20000000-0000-4000-8000-000000000002';
    expect(verifyHandoffProof('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyE', VECTOR.handoffId, VECTOR.codeChallenge, VECTOR.pagePubkey, VECTOR.proof)).toBe(false);
    expect(verifyHandoffProof(VECTOR.secret, otherId, VECTOR.codeChallenge, VECTOR.pagePubkey, VECTOR.proof)).toBe(false);
    expect(verifyHandoffProof(VECTOR.secret, VECTOR.handoffId, 'x'.repeat(43), VECTOR.pagePubkey, VECTOR.proof)).toBe(false);
    expect(verifyHandoffProof(VECTOR.secret, VECTOR.handoffId, VECTOR.codeChallenge, VECTOR.pagePubkey.replace('BA', 'CA'), VECTOR.proof)).toBe(false);
    expect(verifyHandoffProof(VECTOR.secret, VECTOR.handoffId, VECTOR.codeChallenge, VECTOR.pagePubkey, 'x'.repeat(43))).toBe(false);
  });
});

describe('buildHandoffUrl', () => {
  test('the exact fragment shape from docs §4.4', () => {
    expect(buildHandoffUrl('https://keep.capy.sc', 'FLOW-1', 54321, 'HAND-1', 'SECRETXYZ')).toBe(
      'https://keep.capy.sc/auth/local?f=FLOW-1#v=1&port=54321&id=HAND-1&secret=SECRETXYZ',
    );
  });
});

describe('parseHandoffRequest', () => {
  const valid = { v: 1 as const, handoff_id: VECTOR.handoffId, code_challenge: VECTOR.codeChallenge, page_pubkey: VECTOR.pagePubkey, proof: VECTOR.proof };

  test('accepts the exact shape', () => {
    expect(parseHandoffRequest(valid)).toEqual(valid);
  });

  test('rejects a missing key', () => {
    const { proof: _proof, ...rest } = valid;
    expect(parseHandoffRequest(rest)).toBeNull();
  });

  test('rejects an extra key', () => {
    expect(parseHandoffRequest({ ...valid, extra: 'nope' })).toBeNull();
  });

  test('rejects a version other than the number 1', () => {
    expect(parseHandoffRequest({ ...valid, v: 2 })).toBeNull();
    expect(parseHandoffRequest({ ...valid, v: '1' })).toBeNull();
  });

  test('rejects a malformed handoff_id', () => {
    expect(parseHandoffRequest({ ...valid, handoff_id: 'not-a-uuid' })).toBeNull();
  });

  test('rejects a malformed code_challenge', () => {
    expect(parseHandoffRequest({ ...valid, code_challenge: 'too-short' })).toBeNull();
  });

  test('rejects a page_pubkey that is not a 65-byte 0x04 point', () => {
    expect(parseHandoffRequest({ ...valid, page_pubkey: Buffer.from([0x02, 1, 2, 3]).toString('base64') })).toBeNull();
    expect(parseHandoffRequest({ ...valid, page_pubkey: 'not base64!!' })).toBeNull();
  });

  test('rejects a malformed proof', () => {
    expect(parseHandoffRequest({ ...valid, proof: 'short' })).toBeNull();
  });

  test('rejects non-objects', () => {
    expect(parseHandoffRequest('nope')).toBeNull();
    expect(parseHandoffRequest(null)).toBeNull();
    expect(parseHandoffRequest([1, 2, 3])).toBeNull();
    expect(parseHandoffRequest(42)).toBeNull();
  });
});

const KEEP_ORIGIN = 'https://keep.local.test';
const SERVICE_ORIGIN = 'https://service.local.test';
const K_LOCAL = Buffer.alloc(32, 7);
const FIXTURE_SECRET = VECTOR.secret;
const GRANT = 'test-grant-value';

interface Recorded { readonly url: string; readonly body: string }

/** A same-shape, deterministic stand-in for the service's two calls — no
 * network, so these tests observe only the listener's own behaviour. */
function fakeServiceFetch(calls: Recorded[], opts: { handoffId: string; expiresAt: string; authorizeStatus?: number; authorizeBody?: unknown }): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body: bodyText });
    if (url.endsWith('/flows/local-handoff')) {
      return new Response(JSON.stringify({ handoff_id: opts.handoffId, handoff_secret: FIXTURE_SECRET, expires_at: opts.expiresAt }), { status: 201 });
    }
    if (url.includes(`/flows/local-handoff/${opts.handoffId}/authorize`)) {
      const status = opts.authorizeStatus ?? 200;
      const body = opts.authorizeBody ?? { grant: GRANT };
      return new Response(JSON.stringify(body), { status });
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
  }) as unknown as typeof fetch;
}

function baseDeps(overrides: Partial<StartLocalHandoffOptions> & { calls: Recorded[]; handoffId?: string; expiresAt?: string; authorizeStatus?: number; authorizeBody?: unknown }): StartLocalHandoffOptions {
  const handoffId = overrides.handoffId ?? randomUUID();
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 300_000).toISOString();
  const keys = mintConnectionKeypair();
  return {
    origin: SERVICE_ORIGIN,
    keepOrigin: KEEP_ORIGIN,
    conversationFlowId: randomUUID(),
    clientPubkeyB64: keys.publicKeyB64,
    userId: 'user-1',
    orgId: 'org-1',
    bearer: async () => 'bearer-token',
    sign: (_method, _flowId, _id, body) => ({ ...body, proof: 'test-signature' }),
    readLocalRoot: () => K_LOCAL,
    fetchImpl: fakeServiceFetch(overrides.calls, { handoffId, expiresAt, authorizeStatus: overrides.authorizeStatus, authorizeBody: overrides.authorizeBody }),
    ...overrides,
  };
}

/** A real page-side HMAC proof over the given fields, keyed by the fixture
 * secret — computed independently of `verifyHandoffProof`'s own helper. */
function pageProof(handoffId: string, codeChallenge: string, pagePubkeyB64: string): string {
  const key = Buffer.from(FIXTURE_SECRET, 'base64url');
  return createHmac('sha256', key)
    .update(`capy-local-handoff-v1\n${handoffId}\n${codeChallenge}\n${pagePubkeyB64}`)
    .digest('base64url');
}

const CODE_CHALLENGE = 'vC_2LhB6HPwvyKEGRMmpy218v0HaFdXn3q5GzarIPyI';

describe('startLocalHandoff — live loopback listener', () => {
  test('binds only 127.0.0.1 — reachable there, not on the IPv6 loopback', async () => {
    const calls: Recorded[] = [];
    const handle = await startLocalHandoff(baseDeps({ calls }));
    expect(handle).not.toBeNull();
    const { port } = parseHandoffUrl(handle!.url);

    const ok = await httpRequest({ port, method: 'OPTIONS', path: '/v1/local-handoff', headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN } });
    expect(ok.status).toBe(204);

    await expect(new Promise((resolve, reject) => {
      const socket = createConnection({ host: '::1', port });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', reject);
    })).rejects.toBeDefined();

    await handle!.close();
  });

  test('OPTIONS preflight: exact CORS headers for the right Origin, 403 for a wrong or missing Host/Origin', async () => {
    const calls: Recorded[] = [];
    const handle = await startLocalHandoff(baseDeps({ calls }));
    const { port } = parseHandoffUrl(handle!.url);

    const good = await httpRequest({ port, method: 'OPTIONS', path: '/v1/local-handoff', headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN } });
    expect(good.status).toBe(204);
    expect(good.headers['access-control-allow-origin']).toBe(KEEP_ORIGIN);
    expect(good.headers['access-control-allow-methods']).toBe('POST');
    expect(good.headers['access-control-allow-headers']).toBe('content-type');
    expect(good.headers['access-control-allow-private-network']).toBe('true');
    expect(good.headers.vary).toBe('Origin');

    const wrongOrigin = await httpRequest({ port, method: 'OPTIONS', path: '/v1/local-handoff', headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.test' } });
    expect(wrongOrigin.status).toBe(403);

    const missingOrigin = await httpRequest({ port, method: 'OPTIONS', path: '/v1/local-handoff', headers: { host: `127.0.0.1:${port}` } });
    expect(missingOrigin.status).toBe(403);

    const wrongHost = await httpRequest({ port, method: 'OPTIONS', path: '/v1/local-handoff', headers: { host: '127.0.0.1:1', origin: KEEP_ORIGIN } });
    expect(wrongHost.status).toBe(403);

    await handle!.close();
  });

  test('POST rejects a wrong Host and a wrong/missing Origin with 403', async () => {
    const calls: Recorded[] = [];
    const handle = await startLocalHandoff(baseDeps({ calls }));
    const { port } = parseHandoffUrl(handle!.url);
    const goodHeaders = { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' };

    const wrongHost = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers: { ...goodHeaders, host: '127.0.0.1:1' }, body: '{}' });
    expect(wrongHost.status).toBe(403);

    const wrongOrigin = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers: { ...goodHeaders, origin: 'https://evil.test' }, body: '{}' });
    expect(wrongOrigin.status).toBe(403);

    const missingOrigin = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}' });
    expect(missingOrigin.status).toBe(403);

    await handle!.close();
  });

  test('POST rejects non-JSON content types', async () => {
    const calls: Recorded[] = [];
    const handle = await startLocalHandoff(baseDeps({ calls }));
    const { port } = parseHandoffUrl(handle!.url);

    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'text/plain' },
      body: 'not json',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    await handle!.close();
  });

  test('POST rejects a body over 8 KiB with 413', async () => {
    const calls: Recorded[] = [];
    const handle = await startLocalHandoff(baseDeps({ calls }));
    const { port } = parseHandoffUrl(handle!.url);

    const oversized = 'x'.repeat(9 * 1024);
    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(oversized)) },
      body: oversized,
    });
    expect(res.status).toBe(413);

    await handle!.close();
  });

  test('POST with the wrong handoff_id is refused without spending the latch', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const handle = await startLocalHandoff(baseDeps({ calls, handoffId }));
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();

    const wrongId = randomUUID();
    const body = JSON.stringify({ v: 1, handoff_id: wrongId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64, proof: pageProof(wrongId, CODE_CHALLENGE, page.pagePubkeyB64) });
    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.parse(res.body).code).not.toBe('LOCAL_HANDOFF_USED');

    await handle!.close();
  });

  test('POST with a bad HMAC proof is refused with 403', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const handle = await startLocalHandoff(baseDeps({ calls, handoffId }));
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();

    const body = JSON.stringify({
      v: 1, handoff_id: handoffId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64,
      proof: pageProof(handoffId, CODE_CHALLENGE, page.pagePubkeyB64).replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    });
    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('LOCAL_HANDOFF_PROOF_INVALID');

    await handle!.close();
  });

  test('a valid POST succeeds, opens to k_local, and the service never received the handoff secret', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const deps = baseDeps({ calls, handoffId });
    const handle = await startLocalHandoff(deps);
    expect(handle).not.toBeNull();
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();

    const body = JSON.stringify({
      v: 1, handoff_id: handoffId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64,
      proof: pageProof(handoffId, CODE_CHALLENGE, page.pagePubkeyB64),
    });
    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(KEEP_ORIGIN);
    expect(res.headers['cache-control']).toBe('no-store');
    const parsed = JSON.parse(res.body);
    expect(parsed.grant).toBe(GRANT);
    expect(parsed.client_pubkey).toBe(deps.clientPubkeyB64);
    expect(typeof parsed.custody).toBe('string');

    const opened = await openRequestEnvelopePageSide({
      ciphertextB64: parsed.custody,
      connectionId: `local-handoff:${handoffId}`,
      clientPubkeyB64: deps.clientPubkeyB64,
      pagePrivateKey: page.privateKey,
    });
    const custody = JSON.parse(opened);
    expect(custody).toEqual({
      v: 1,
      handoff_id: handoffId,
      conversation_flow_id: deps.conversationFlowId,
      user_id: deps.userId,
      org_id: deps.orgId,
      k_local: K_LOCAL.toString('base64'),
    });

    // The service (both create and authorize calls) never sees H.
    for (const call of calls) expect(call.body.includes(FIXTURE_SECRET)).toBe(false);

    await handle!.close();
  });

  test('a second request after success is refused as single-use', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const handle = await startLocalHandoff(baseDeps({ calls, handoffId }));
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();
    const body = JSON.stringify({
      v: 1, handoff_id: handoffId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64,
      proof: pageProof(handoffId, CODE_CHALLENGE, page.pagePubkeyB64),
    });
    const headers = { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' };

    const first = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers, body });
    expect(first.status).toBe(200);

    const second = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers, body });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).code).toBe('LOCAL_HANDOFF_USED');

    await handle!.close();
  });

  test('a request after the TTL has passed is refused, using the injected clock', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + 300_000).toISOString();
    const deps = baseDeps({ calls, handoffId, expiresAt, now: () => nowMs + 301_000 });
    const handle = await startLocalHandoff(deps);
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();
    const body = JSON.stringify({
      v: 1, handoff_id: handoffId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64,
      proof: pageProof(handoffId, CODE_CHALLENGE, page.pagePubkeyB64),
    });

    const res = await httpRequest({
      port, method: 'POST', path: '/v1/local-handoff',
      headers: { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body).code).toBe('LOCAL_HANDOFF_EXPIRED');

    await handle!.close();
  });

  test('an authorize failure is refused and the handoff stays single-use', async () => {
    const calls: Recorded[] = [];
    const handoffId = randomUUID();
    const deps = baseDeps({ calls, handoffId, authorizeStatus: 409, authorizeBody: { code: 'LOCAL_HANDOFF_STATE_CONFLICT' } });
    const handle = await startLocalHandoff(deps);
    const { port } = parseHandoffUrl(handle!.url);
    const page = await mintPageKeypairPageSide();
    const body = JSON.stringify({
      v: 1, handoff_id: handoffId, code_challenge: CODE_CHALLENGE, page_pubkey: page.pagePubkeyB64,
      proof: pageProof(handoffId, CODE_CHALLENGE, page.pagePubkeyB64),
    });
    const headers = { host: `127.0.0.1:${port}`, origin: KEEP_ORIGIN, 'content-type': 'application/json' };

    const first = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers, body });
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(first.body).code).toBe('LOCAL_HANDOFF_STATE_CONFLICT');

    const second = await httpRequest({ port, method: 'POST', path: '/v1/local-handoff', headers, body });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).code).toBe('LOCAL_HANDOFF_USED');

    await handle!.close();
  });

  test('a create-call failure returns null rather than throwing', async () => {
    const calls: Recorded[] = [];
    const deps = baseDeps({ calls });
    const failingFetch = (async () => new Response(JSON.stringify({ code: 'LOCAL_HANDOFF_UNAVAILABLE' }), { status: 403 })) as unknown as typeof fetch;
    const handle = await startLocalHandoff({ ...deps, fetchImpl: failingFetch });
    expect(handle).toBeNull();
  });
});
