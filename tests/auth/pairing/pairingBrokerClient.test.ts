/**
 * CAP-409 — `PairingBrokerClient`: the anonymous CAP-403 bootstrap
 * transport. Real (loopback) HTTP stub via Bun.serve, no mock.module — same
 * convention as grantHijack.test.ts / brokerCeremonyTransport.test.ts. Not
 * registered in ISOLATED_FILES.
 */
import { describe, test, expect } from 'bun:test';
import { PairingBrokerClient } from '../../../src/auth/pairing/pairingBrokerClient';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';

describe('PairingBrokerClient.bootstrap', () => {
  test('posts to /connections/bootstrap with NO Authorization header and the right purpose', async () => {
    let recordedAuth: string | null | undefined;
    let recordedBody: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/connections/bootstrap') {
          recordedAuth = req.headers.get('authorization');
          recordedBody = await req.json();
          return Response.json(
            {
              connection_id: 'conn-1',
              status: 'pending',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              poll_secret: 'secret-abc',
              user_code: 'ABCD-1234',
            },
            { status: 201 },
          );
        }
        return Response.json({ error: 'no route' }, { status: 404 });
      },
    });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      const bootstrap = await client.bootstrap({ purpose: 'machine-pair', machineName: 'sandbox:test', ttlSeconds: 900 });

      expect(recordedAuth).toBeNull();
      expect(recordedBody.purpose).toBe('machine-pair');
      expect(recordedBody.machine_name).toBe('sandbox:test');
      expect(recordedBody.ttl_seconds).toBe(900);
      expect(typeof recordedBody.client_pubkey).toBe('string');
      expect(bootstrap.connectionId).toBe('conn-1');
      expect(bootstrap.pollSecret).toBe('secret-abc');
      expect(bootstrap.userCode).toBe('ABCD-1234');
      expect(bootstrap.expiresAtMs).toBeGreaterThan(Date.now());
    } finally {
      server.stop(true);
    }
  });

  test('throws a coded CapyError on a network failure', async () => {
    const client = new PairingBrokerClient('http://127.0.0.1:1'); // nothing listening
    await expect(client.bootstrap({ purpose: 'machine-pair' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  test('throws a coded CapyError on a non-2xx response', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: 'nope' }, { status: 400 }) });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      await expect(client.bootstrap({ purpose: 'machine-pair' })).rejects.toMatchObject({ code: 'SERVICE_ERROR' });
    } finally {
      server.stop(true);
    }
  });

  test('throws on a malformed 2xx response missing required fields', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ connection_id: 'x' }, { status: 201 }) });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      await expect(client.bootstrap({ purpose: 'machine-pair' })).rejects.toMatchObject({ code: 'SERVICE_ERROR' });
    } finally {
      server.stop(true);
    }
  });
});

describe('PairingBrokerClient.pollOnce', () => {
  test('sends X-Connection-Secret, never Authorization, on every poll', async () => {
    let recordedSecret: string | null | undefined;
    let recordedAuth: string | null | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/connections/conn-1/result') {
          recordedSecret = req.headers.get('x-connection-secret');
          recordedAuth = req.headers.get('authorization');
          return Response.json({ status: 'pending' });
        }
        return Response.json({ error: 'no' }, { status: 404 });
      },
    });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      const bootstrap = {
        connectionId: 'conn-1',
        expiresAtMs: Date.now() + 60_000,
        pollSecret: 'secret-xyz',
        userCode: 'AAAA-BBBB',
        keypair: { publicKeyB64: 'unused', privateKey: null as any },
      };
      const result = await client.pollOnce(bootstrap, 1);
      expect(result).toEqual({ kind: 'pending' });
      expect(recordedSecret).toBe('secret-xyz');
      expect(recordedAuth).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('opens a real sealed answer and returns its plaintext', async () => {
    let sealed = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/connections/conn-1/result') {
          return Response.json({ status: 'answered', ciphertext: sealed });
        }
        return Response.json({ error: 'no' }, { status: 404 });
      },
    });

    const { mintConnectionKeypair } = await import('../../../src/service/brokerEnvelope');
    const keypair = mintConnectionKeypair();
    sealed = await sealEnvelopePageSide({
      plaintext: JSON.stringify({ hello: 'world' }),
      connectionId: 'conn-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      const bootstrap = {
        connectionId: 'conn-1',
        expiresAtMs: Date.now() + 60_000,
        pollSecret: 'secret-xyz',
        userCode: 'AAAA-BBBB',
        keypair,
      };
      const result = await client.pollOnce(bootstrap, 1);
      expect(result).toEqual({ kind: 'answered', plaintext: JSON.stringify({ hello: 'world' }) });
    } finally {
      server.stop(true);
    }
  });

  test('a wrong-key sealed answer fails the AEAD open closed (bad_envelope), never accepted', async () => {
    let sealed = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/connections/conn-1/result') {
          return Response.json({ status: 'answered', ciphertext: sealed });
        }
        return Response.json({ error: 'no' }, { status: 404 });
      },
    });
    try {
      const { mintConnectionKeypair } = await import('../../../src/service/brokerEnvelope');
      const realKeypair = mintConnectionKeypair();
      const attackerKeypair = mintConnectionKeypair();
      sealed = await sealEnvelopePageSide({
        plaintext: JSON.stringify({ hello: 'attacker' }),
        connectionId: 'conn-1',
        clientPubkeyB64: attackerKeypair.publicKeyB64, // sealed to the WRONG pubkey
      });

      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      const bootstrap = {
        connectionId: 'conn-1',
        expiresAtMs: Date.now() + 60_000,
        pollSecret: 'secret-xyz',
        userCode: 'AAAA-BBBB',
        keypair: realKeypair,
      };
      const result = await client.pollOnce(bootstrap, 1);
      expect(result.kind).toBe('bad_envelope');
    } finally {
      server.stop(true);
    }
  });

  test('410 -> expired, 409 -> consumed, other non-2xx -> service', async () => {
    let status = 410;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/connections/conn-1/result') {
          return Response.json({ error: 'x', code: 'X' }, { status });
        }
        return Response.json({ error: 'no' }, { status: 404 });
      },
    });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      const bootstrap = {
        connectionId: 'conn-1',
        expiresAtMs: Date.now() + 60_000,
        pollSecret: 'secret-xyz',
        userCode: 'AAAA-BBBB',
        keypair: { publicKeyB64: 'unused', privateKey: null as any },
      };

      status = 410;
      expect(await client.pollOnce(bootstrap, 1)).toEqual({ kind: 'expired' });
      status = 409;
      expect(await client.pollOnce(bootstrap, 1)).toEqual({ kind: 'consumed' });
      status = 500;
      const svc = await client.pollOnce(bootstrap, 1);
      expect(svc.kind).toBe('service');
    } finally {
      server.stop(true);
    }
  });

  test('a network failure maps to kind:network, never throws', async () => {
    const client = new PairingBrokerClient('http://127.0.0.1:1');
    const bootstrap = {
      connectionId: 'conn-1',
      expiresAtMs: Date.now() + 60_000,
      pollSecret: 'secret-xyz',
      userCode: 'AAAA-BBBB',
      keypair: { publicKeyB64: 'unused', privateKey: null as any },
    };
    const result = await client.pollOnce(bootstrap, 1);
    expect(result.kind).toBe('network');
  });
});

describe('PairingBrokerClient.cancel', () => {
  test('sends DELETE with X-Connection-Secret and never throws even on failure', async () => {
    let recordedSecret: string | null | undefined;
    let recordedMethod = '';
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        recordedMethod = req.method;
        recordedSecret = req.headers.get('x-connection-secret');
        return Response.json({ status: 'cancelled' });
      },
    });
    try {
      const client = new PairingBrokerClient(`http://127.0.0.1:${server.port}`);
      await client.cancel({ connectionId: 'conn-1', pollSecret: 'secret-xyz' });
      expect(recordedMethod).toBe('DELETE');
      expect(recordedSecret).toBe('secret-xyz');
    } finally {
      server.stop(true);
    }

    // Best-effort: unreachable server must not throw.
    const deadClient = new PairingBrokerClient('http://127.0.0.1:1');
    await expect(deadClient.cancel({ connectionId: 'conn-1', pollSecret: 'x' })).resolves.toBeUndefined();
  });
});
