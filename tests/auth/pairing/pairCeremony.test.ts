/**
 * CAP-409 — `runPairCeremony`: the full ceremony against a real (loopback)
 * broker stub. Covers the happy path, every documented CeremonyFailure code,
 * expiry (both server-signalled and client-clock), and the hijack-style
 * proofs `grantHijack.test.ts` established for the sibling CAP-384 ceremony:
 * a connection that never resolves, an answer sealed to the wrong pubkey,
 * and an answer replayed from a different connection id. Real envelope
 * crypto via tests/helpers/sealEnvelope.ts. No mock.module — not registered
 * in ISOLATED_FILES.
 */
import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { runPairCeremony } from '../../../src/auth/pairing/pairCeremony';
import { PAIR_FLOW, PAIR_CEREMONY } from '../../../src/auth/pairing/pairContract';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';

function validAnswerBody() {
  return {
    v: 1,
    flow: PAIR_FLOW,
    ceremony: PAIR_CEREMONY,
    session: {
      user: { id: 'user_ceremony_1', email: 'u@example.com' },
      refresh_token: 'rt_1',
      organizations: [{ id: 'org_1', name: 'Org One' }],
    },
    keyMaterial: {
      orgId: 'org_1',
      kLocal: randomBytes(32).toString('base64'),
      kdfVersion: '1',
      credentialId: 'cred_1',
    },
  };
}

/** A minimal fake broker: bootstrap mints a real connection id + captures
 *  the client_pubkey, /result serves a queued response, DELETE just records. */
function makeFakeBroker(opts: { connectionId?: string; ttlMs?: number } = {}) {
  const connectionId = opts.connectionId ?? 'pair-conn-1';
  const queue: Array<{ status: number; body: unknown }> = [];
  let clientPubkeyB64 = '';
  let cancelled = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/connections/bootstrap') {
        const body = (await req.json()) as any;
        clientPubkeyB64 = body.client_pubkey;
        return Response.json(
          {
            connection_id: connectionId,
            status: 'pending',
            expires_at: new Date(Date.now() + (opts.ttlMs ?? 60_000)).toISOString(),
            poll_secret: 'poll-secret-1',
            user_code: 'ABCD-1234',
          },
          { status: 201 },
        );
      }
      if (req.method === 'GET' && url.pathname === `/connections/${connectionId}/result`) {
        const next = queue.shift() ?? { status: 200, body: { status: 'pending' } };
        return Response.json(next.body as any, { status: next.status });
      }
      if (req.method === 'DELETE' && url.pathname === `/connections/${connectionId}`) {
        cancelled = true;
        return Response.json({ status: 'cancelled' });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    queue,
    getClientPubkeyB64: () => clientPubkeyB64,
    isCancelled: () => cancelled,
    stop: () => server.stop(true),
  };
}

describe('runPairCeremony — happy path', () => {
  test('prints the code exactly once, opens the real sealed answer', async () => {
    const broker = makeFakeBroker();
    try {
      const codes: string[] = [];
      const answerBody = validAnswerBody();
      const resultPromise = runPairCeremony({
        serviceUrl: broker.url,
        machineName: 'sandbox:test',
        onCodeReady: (c) => codes.push(c),
      });

      // Wait for bootstrap to register, then push a real sealed answer.
      const deadline = Date.now() + 2000;
      while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);
      const sealed = await sealEnvelopePageSide({
        plaintext: JSON.stringify(answerBody),
        connectionId: 'pair-conn-1',
        clientPubkeyB64: broker.getClientPubkeyB64(),
      });
      broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

      const outcome = await resultPromise;
      expect(codes).toEqual(['ABCD-1234']);
      expect(outcome.kind).toBe('answered');
      if (outcome.kind === 'answered') {
        expect(outcome.answer.session.user.id).toBe('user_ceremony_1');
        expect(outcome.answer.keyMaterial.credentialId).toBe('cred_1');
      }
    } finally {
      broker.stop();
    }
  });

  test('a pending poll is retried until answered', async () => {
    const broker = makeFakeBroker();
    try {
      broker.queue.push({ status: 200, body: { status: 'pending' } });
      broker.queue.push({ status: 200, body: { status: 'attached' } });
      const answerBody = validAnswerBody();
      const resultPromise = runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });

      const deadline = Date.now() + 2000;
      while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);
      const sealed = await sealEnvelopePageSide({
        plaintext: JSON.stringify(answerBody),
        connectionId: 'pair-conn-1',
        clientPubkeyB64: broker.getClientPubkeyB64(),
      });
      broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

      const outcome = await resultPromise;
      expect(outcome.kind).toBe('answered');
    } finally {
      broker.stop();
    }
  }, 10_000);
});

describe('runPairCeremony — declined/cancelled/error', () => {
  for (const code of ['cancelled', 'no_credential', 'prf_unsupported', 'webauthn_unavailable']) {
    test(`ceremony code '${code}' surfaces as a failure outcome, not a crash`, async () => {
      const broker = makeFakeBroker();
      try {
        const resultPromise = runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
        const deadline = Date.now() + 2000;
        while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);
        const sealed = await sealEnvelopePageSide({
          plaintext: JSON.stringify({ v: 1, flow: PAIR_FLOW, ceremony: PAIR_CEREMONY, ok: false, code }),
          connectionId: 'pair-conn-1',
          clientPubkeyB64: broker.getClientPubkeyB64(),
        });
        broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

        const outcome = await resultPromise;
        expect(outcome).toEqual({ kind: 'failure', code: code as any, userCode: 'ABCD-1234' });
      } finally {
        broker.stop();
      }
    });
  }
});

describe('runPairCeremony — expiry', () => {
  test('the broker reporting 410 ends the ceremony as expired', async () => {
    const broker = makeFakeBroker();
    try {
      broker.queue.push({ status: 410, body: { error: 'expired', code: 'CONNECTION_EXPIRED' } });
      const outcome = await runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
      expect(outcome).toEqual({ kind: 'expired', userCode: 'ABCD-1234' });
    } finally {
      broker.stop();
    }
  });

  test("the client's own clock passing expires_at ends the ceremony as expired and cancels", async () => {
    const broker = makeFakeBroker({ ttlMs: 50 });
    try {
      // Every poll just stays pending — the real signal here is the client
      // clock outrunning the connection's own expires_at.
      for (let i = 0; i < 50; i++) broker.queue.push({ status: 200, body: { status: 'pending' } });
      const outcome = await runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
      expect(outcome).toEqual({ kind: 'expired', userCode: 'ABCD-1234' });
      expect(broker.isCancelled()).toBe(true);
    } finally {
      broker.stop();
    }
  }, 10_000);
});

describe('runPairCeremony — hijack resistance (client-side fail-closed)', () => {
  test('a connection that 404s on every poll never resolves as success — ends failed, not a crash', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/connections/bootstrap') {
          return Response.json(
            {
              connection_id: 'attacker-cannot-see-this-id',
              status: 'pending',
              expires_at: new Date(Date.now() + 300).toISOString(),
              poll_secret: 'secret',
              user_code: 'ZZZZ-9999',
            },
            { status: 201 },
          );
        }
        return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
      },
    });
    try {
      const outcome = await runPairCeremony({ serviceUrl: `http://127.0.0.1:${server.port}`, onCodeReady: () => {} });
      expect(outcome).toEqual({ kind: 'failure', code: 'transport_error', userCode: 'ZZZZ-9999' });
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test('an answer sealed to the WRONG client pubkey fails the AEAD open — never accepted as real session/key material', async () => {
    const broker = makeFakeBroker();
    try {
      const resultPromise = runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
      const deadline = Date.now() + 2000;
      while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);

      // Attacker seals a plausible success payload to a RANDOM pubkey — not
      // the real client_pubkey this ceremony minted (which an attacker,
      // lacking the identity gate on a legitimate row, never learns).
      const { mintConnectionKeypair } = await import('../../../src/service/brokerEnvelope');
      const attackerKeypair = mintConnectionKeypair();
      const forged = await sealEnvelopePageSide({
        plaintext: JSON.stringify(validAnswerBody()),
        connectionId: 'pair-conn-1',
        clientPubkeyB64: attackerKeypair.publicKeyB64,
      });
      broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: forged } });

      const outcome = await resultPromise;
      expect(outcome).toEqual({ kind: 'failure', code: 'transport_error', userCode: 'ABCD-1234' });
    } finally {
      broker.stop();
    }
  });

  test('an answer sealed under a DIFFERENT connection id cannot be replayed onto this one', async () => {
    const broker = makeFakeBroker({ connectionId: 'real-conn-id' });
    try {
      const resultPromise = runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
      const deadline = Date.now() + 2000;
      while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);

      // Legitimate-looking envelope, sealed to the REAL client pubkey, but
      // HKDF-bound to a DIFFERENT connection id — e.g. replayed from a
      // hijacker's own ceremony elsewhere.
      const replayed = await sealEnvelopePageSide({
        plaintext: JSON.stringify(validAnswerBody()),
        connectionId: 'some-other-connection-id',
        clientPubkeyB64: broker.getClientPubkeyB64(),
      });
      broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: replayed } });

      const outcome = await resultPromise;
      expect(outcome).toEqual({ kind: 'failure', code: 'transport_error', userCode: 'ABCD-1234' });
    } finally {
      broker.stop();
    }
  });

  test('a malformed-but-decrypting-fine plaintext (wrong flow) is rejected, never adopted as a session', async () => {
    const broker = makeFakeBroker();
    try {
      const resultPromise = runPairCeremony({ serviceUrl: broker.url, onCodeReady: () => {} });
      const deadline = Date.now() + 2000;
      while (!broker.getClientPubkeyB64() && Date.now() < deadline) await Bun.sleep(5);

      const sealed = await sealEnvelopePageSide({
        // Correctly sealed, correct connection — but framed as a DIFFERENT
        // ceremony (e.g. a device-key envelope landing on a pair poll).
        plaintext: JSON.stringify({ v: 1, flow: 'device-key', ceremony: 'unlock', ok: true, credentialId: 'x', prfOutput: 'y' }),
        connectionId: 'pair-conn-1',
        clientPubkeyB64: broker.getClientPubkeyB64(),
      });
      broker.queue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

      const outcome = await resultPromise;
      expect(outcome).toEqual({ kind: 'failure', code: 'transport_error', userCode: 'ABCD-1234' });
    } finally {
      broker.stop();
    }
  });
});
