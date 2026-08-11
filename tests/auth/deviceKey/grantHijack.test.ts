/**
 * CAP-384 — "a hostile user cannot attach/answer a grant connection,"
 * proven at the CLI boundary against a real (loopback) broker stub.
 *
 * Identity equality (invariant 3) is enforced SERVER-SIDE — the real
 * service compares the verified JWT userId of whoever calls attach/answer
 * against the connection's owner and 404s a non-owner indistinguishably
 * from a missing connection (already proven by the broker's own hijack
 * suite in the service repo, which this program does not touch for
 * CAP-384: the grant ceremony rides the exact same `purpose: 'device-key'`
 * connection type enroll/unlock already use, so that proof already covers
 * it structurally). What THIS file proves is the CLIENT half of the
 * property: that `requestGrant` cannot be tricked into treating a hostile
 * outcome as a real one, for every shape a hijack attempt can take from the
 * CLI's observable point of view —
 *
 *   1. the connection 404s (an attacker's attach against someone else's
 *      connection id, or the owner never existed) — never confused with a
 *      real answer, never a crash;
 *   2. an answer sealed to the WRONG client pubkey (an attacker without the
 *      real ephemeral private key trying to forge a plausible-looking
 *      envelope) — the AEAD open fails, mapped to `bad_envelope` ->
 *      `transport_error`, not silently accepted;
 *   3. an answer sealed under a DIFFERENT connection id (the HKDF info
 *      binds to the connection id — a hostile envelope minted for a
 *      different ceremony cannot be replayed onto this one) — same
 *      fail-closed outcome.
 *
 * No mock.module — not registered in ISOLATED_FILES.
 */
import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { BrokerCeremonyTransport } from '../../../src/auth/deviceKey/brokerCeremonyTransport';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';

const CANDIDATES = [{ credentialId: 'cred-hijack-1', prfSalt: randomBytes(32).toString('base64') }];

function transport(base: string, overrides: Record<string, unknown> = {}) {
  return new BrokerCeremonyTransport({
    serviceUrl: base,
    getToken: () => 'test-token',
    machineName: 'sandbox:hijack-test',
    ttlSeconds: 900,
    deadlineMs: 2_000,
    ...overrides,
  } as any);
}

describe('CAP-384 grant hijack resistance (client-side fail-closed)', () => {
  test('a connection that 404s on every poll never resolves as a successful grant — times out to transport_error', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/connections') {
          return Response.json(
            { connection_id: 'attacker-cannot-see-this-id', status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString() },
            { status: 201 },
          );
        }
        // Every result poll 404s — indistinguishable from "not yours".
        return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
      },
    });
    try {
      const result = await transport(`http://127.0.0.1:${server.port}`, { deadlineMs: 300 }).requestGrant({
        userId: 'victim-user',
        candidates: CANDIDATES,
      });
      expect(result).toEqual({ ok: false, code: 'transport_error' });
    } finally {
      server.stop(true);
    }
  });

  test('an envelope sealed to the WRONG client pubkey fails the AEAD open — never accepted as a real grant', async () => {
    const CONNECTION_ID = '0b4e2c62-6f6e-4a11-9d3a-1c2f4b5a6d7e';
    const queue: Array<{ status: number; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/connections') {
          return Response.json(
            { connection_id: CONNECTION_ID, status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString() },
            { status: 201 },
          );
        }
        if (req.method === 'GET' && url.pathname === `/connections/${CONNECTION_ID}/result`) {
          return Response.json((queue.shift() ?? { status: 'pending' }) as any);
        }
        return Response.json({ error: 'no', code: 'NOT_FOUND' }, { status: 404 });
      },
    });
    try {
      const resultPromise = transport(`http://127.0.0.1:${server.port}`).requestGrant({
        userId: 'victim-user',
        candidates: CANDIDATES,
      });

      // Attacker seals a plausible-looking success payload, but to a
      // RANDOM pubkey — not the real client_pubkey the connection was
      // minted with (which this attacker, lacking the identity gate, never
      // legitimately learns).
      const attackerKeypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const wrongClientPubkeyB64 = Buffer.from(
        new Uint8Array(await crypto.subtle.exportKey('raw', attackerKeypair.publicKey)),
      ).toString('base64');
      const forged = await sealEnvelopePageSide({
        plaintext: JSON.stringify({ v: 1, flow: 'device-key', ceremony: 'grant', ok: true, credentialId: 'cred-hijack-1', prfOutput: randomBytes(32).toString('base64') }),
        connectionId: CONNECTION_ID,
        clientPubkeyB64: wrongClientPubkeyB64,
      });
      queue.push({ status: 200, body: { status: 'answered', ciphertext: forged } as any });

      const result = await resultPromise;
      expect(result).toEqual({ ok: false, code: 'transport_error' });
    } finally {
      server.stop(true);
    }
  });

  test('an envelope sealed under a DIFFERENT connection id cannot be replayed onto this one', async () => {
    const CONNECTION_ID = '1c2f4b5a-6d7e-4a11-9d3a-0b4e2c626f6e';
    const OTHER_CONNECTION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const queue: Array<{ status: number; body: unknown }> = [];
    let realClientPubkeyB64 = '';
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/connections') {
          const body = await req.json();
          realClientPubkeyB64 = (body as any).client_pubkey;
          return Response.json(
            { connection_id: CONNECTION_ID, status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString() },
            { status: 201 },
          );
        }
        if (req.method === 'GET' && url.pathname === `/connections/${CONNECTION_ID}/result`) {
          return Response.json((queue.shift() ?? { status: 'pending' }) as any);
        }
        return Response.json({ error: 'no', code: 'NOT_FOUND' }, { status: 404 });
      },
    });
    try {
      const resultPromise = transport(`http://127.0.0.1:${server.port}`).requestGrant({
        userId: 'victim-user',
        candidates: CANDIDATES,
      });

      // Wait for the real client_pubkey to be captured by the fake broker.
      const deadline = Date.now() + 2000;
      while (!realClientPubkeyB64 && Date.now() < deadline) await Bun.sleep(10);
      expect(realClientPubkeyB64).not.toBe('');

      // A legitimate-looking envelope, sealed to the REAL client pubkey, but
      // bound (via HKDF info) to a DIFFERENT connection id — e.g. replayed
      // from a hijacker's own successful ceremony elsewhere.
      const replayed = await sealEnvelopePageSide({
        plaintext: JSON.stringify({ v: 1, flow: 'device-key', ceremony: 'grant', ok: true, credentialId: 'cred-hijack-1', prfOutput: randomBytes(32).toString('base64') }),
        connectionId: OTHER_CONNECTION_ID,
        clientPubkeyB64: realClientPubkeyB64,
      });
      queue.push({ status: 200, body: { status: 'answered', ciphertext: replayed } as any });

      const result = await resultPromise;
      expect(result).toEqual({ ok: false, code: 'transport_error' });
    } finally {
      server.stop(true);
    }
  });
});
