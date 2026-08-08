/**
 * BrokerClient against a real (loopback) HTTP stub of the service's
 * /connections surface — create wire shape, long-poll delivery, coded
 * terminal states, deadline + best-effort cancel. No mock.module, no global
 * mutation: the stub is a per-suite Bun server on an ephemeral port.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { BrokerClient } from '../../src/service/brokerClient';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';

const CONNECTION_ID = '0b4e2c62-6f6e-4a11-9d3a-1c2f4b5a6d7e';
const TOKEN = 'org-scoped-test-token';

interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  waitSeconds: string | null;
}

/** Scripted stub: each result poll shifts the next canned response. */
const state = {
  requests: [] as Recorded[],
  createStatus: 201,
  resultQueue: [] as Array<{ status: number; body: unknown }>,
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
    state.requests.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.get('authorization'),
      body,
      waitSeconds: url.searchParams.get('wait_seconds'),
    });

    if (req.method === 'POST' && url.pathname === '/connections') {
      if (state.createStatus !== 201) {
        return Response.json(
          { error: 'refused', code: 'SOME_CODE' },
          { status: state.createStatus },
        );
      }
      return Response.json(
        {
          connection_id: CONNECTION_ID,
          status: 'pending',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (req.method === 'GET' && url.pathname === `/connections/${CONNECTION_ID}/result`) {
      const next = state.resultQueue.shift() ?? {
        status: 200,
        body: { status: 'pending' },
      };
      return Response.json(next.body as any, { status: next.status });
    }
    if (req.method === 'DELETE' && url.pathname === `/connections/${CONNECTION_ID}`) {
      return Response.json({ status: 'cancelled' });
    }
    return Response.json({ error: 'no', code: 'NOT_FOUND' }, { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  state.requests.length = 0;
  state.createStatus = 201;
  state.resultQueue.length = 0;
});

function client(token: string | null = TOKEN): BrokerClient {
  return new BrokerClient(BASE, () => token);
}

describe('createConnection', () => {
  test('registers the ephemeral pubkey with the documented wire shape', async () => {
    const connection = await client().createConnection({
      purpose: 'auth-success',
      machineName: 'test-machine',
    });

    expect(connection.connectionId).toBe(CONNECTION_ID);
    expect(connection.keypair.publicKeyB64.length).toBeGreaterThan(0);

    const create = state.requests[0];
    expect(create.method).toBe('POST');
    expect(create.path).toBe('/connections');
    expect(create.auth).toBe(`Bearer ${TOKEN}`);
    const body = create.body as Record<string, unknown>;
    expect(body.purpose).toBe('auth-success');
    expect(body.machine_name).toBe('test-machine');
    expect(body.ttl_seconds).toBe(600);
    expect(Buffer.from(body.client_pubkey as string, 'base64').length).toBe(65);
    expect(body.client_pubkey).toBe(connection.keypair.publicKeyB64);
  });

  test('throws coded AUTH_FAILED on 401 and SERVICE_ERROR on 5xx', async () => {
    state.createStatus = 401;
    await expect(client().createConnection({ purpose: 'auth-success' })).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
    });

    state.createStatus = 500;
    await expect(client().createConnection({ purpose: 'auth-success' })).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_ERROR,
    });
  });

  test('throws coded AUTH_FAILED when no token is available', async () => {
    await expect(client(null).createConnection({ purpose: 'auth-success' })).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
    });
    expect(state.requests.length).toBe(0);
  });

  test('throws coded NETWORK_ERROR when the service is unreachable', async () => {
    const dead = new BrokerClient('http://127.0.0.1:1', () => TOKEN);
    let thrown: unknown;
    try {
      await dead.createConnection({ purpose: 'auth-success' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CapyError);
    expect((thrown as CapyError).code).toBe(ERROR_CODES.NETWORK_ERROR);
  });

  // CAP-376 Gate-2 MINOR-5: a payload-bearing ceremony overrides the
  // no-submit auth screens' 600s default (ceremony guidance: 900). The knob
  // was always plumbed (`opts.ttlSeconds`); this pins that it actually rides
  // the wire rather than silently falling back to the default.
  test('a caller-supplied ttlSeconds rides the wire, overriding the auth-screen default', async () => {
    await client().createConnection({ purpose: 'device-key', ttlSeconds: 900 });

    const create = state.requests[0];
    const body = create.body as Record<string, unknown>;
    expect(body.ttl_seconds).toBe(900);
  });
});

describe('awaitAnswer', () => {
  test('polls through pending and opens the sealed answer on delivery', async () => {
    const connection = await client().createConnection({ purpose: 'auth-success' });
    const sealed = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ v: 1, flow: 'auth-success', signal: 'acknowledged' }),
      connectionId: CONNECTION_ID,
      clientPubkeyB64: connection.keypair.publicKeyB64,
    });
    state.resultQueue.push(
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'answered', ciphertext: sealed } },
    );

    const result = await client().awaitAnswer(connection, {
      deadlineMs: 5_000,
      pollGapMs: 5,
    });
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') {
      expect(JSON.parse(result.plaintext).signal).toBe('acknowledged');
    }

    const polls = state.requests.filter((r) => r.path.endsWith('/result'));
    expect(polls.length).toBe(2);
    // wait_seconds always rides the query and never exceeds the openapi cap.
    for (const poll of polls) {
      expect(Number(poll.waitSeconds)).toBeGreaterThanOrEqual(0);
      expect(Number(poll.waitSeconds)).toBeLessThanOrEqual(25);
    }
  });

  test('maps 410 to expired and 409 to consumed', async () => {
    const connection = await client().createConnection({ purpose: 'auth-success' });

    state.resultQueue.push({
      status: 410,
      body: { error: 'gone', code: 'CONNECTION_EXPIRED' },
    });
    expect(await client().awaitAnswer(connection, { deadlineMs: 2_000 })).toEqual({ kind: 'expired' });

    state.resultQueue.push({
      status: 409,
      body: { error: 'used', code: 'CONNECTION_CONSUMED' },
    });
    expect(await client().awaitAnswer(connection, { deadlineMs: 2_000 })).toEqual({ kind: 'consumed' });
  });

  test('undecryptable delivery is a coded bad_envelope, never a throw', async () => {
    const connection = await client().createConnection({ purpose: 'auth-success' });
    state.resultQueue.push({
      status: 200,
      body: { status: 'answered', ciphertext: Buffer.from('garbage').toString('base64') },
    });

    const result = await client().awaitAnswer(connection, { deadlineMs: 2_000 });
    expect(result).toEqual({ kind: 'bad_envelope', code: 'MALFORMED' });
  });

  test('cancels best-effort when the deadline passes unanswered', async () => {
    const connection = await client().createConnection({ purpose: 'auth-success' });
    // Queue stays empty: every poll reports pending.
    const result = await client().awaitAnswer(connection, {
      deadlineMs: 150,
      pollGapMs: 10,
      waitSeconds: 0,
    });
    expect(result).toEqual({ kind: 'timeout' });

    const cancel = state.requests.find((r) => r.method === 'DELETE');
    expect(cancel?.path).toBe(`/connections/${CONNECTION_ID}`);
  });

  test('network failure mid-poll is a coded variant', async () => {
    const connection = await client().createConnection({ purpose: 'auth-success' });
    const dead = new BrokerClient('http://127.0.0.1:1', () => TOKEN);
    const result = await dead.awaitAnswer(connection, { deadlineMs: 2_000 });
    expect(result.kind).toBe('network');
  });
});
