import { describe, expect, mock, test } from 'bun:test';
import { BrokerClient, type BrokerConnection } from '../../src/service/brokerClient';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';

const connection = (): BrokerConnection => ({
  connectionId: '0b4e2c62-6f6e-4a11-9d3a-1c2f4b5a6d7e',
  expiresAt: '2099-01-01T00:00:00.000Z', keypair: mintConnectionKeypair(),
});

interface RequestSnapshot {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}
type Capture = (request: RequestSnapshot) => void;

async function withServer(
  respond: (request: Request) => Response | Promise<Response>,
  check: (client: BrokerClient, calls: ReturnType<typeof mock<Capture>>) => Promise<void>,
): Promise<void> {
  const handler = mock<Capture>(() => undefined);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    // Bun may release native Request fields after the response is sent.
    handler({ url: request.url, method: request.method, authorization: request.headers.get('Authorization') });
    return respond(request);
  } });
  try { await check(new BrokerClient(`http://127.0.0.1:${server.port}`, () => 'fixture-token'), handler); }
  finally { server.stop(true); }
}

describe('bounded broker answer polling', () => {
  test('exchange preserves the attached page key for the resumable request leg', async () => {
    await withServer(() => Response.json({ status: 'attached', page_pubkey: 'fixture-page-key' }), async (client) => {
      expect(await client.pollExchange(connection())).toEqual({ kind: 'pending', pagePubkeyB64: 'fixture-page-key' });
    });
  });
  test('exchange returns raw sealed answer for durable checkpointing before opening', async () => {
    const handle = connection();
    const ciphertext = await sealEnvelopePageSide({ plaintext: 'private-fixture', connectionId: handle.connectionId,
      clientPubkeyB64: handle.keypair.publicKeyB64 });
    await withServer(() => Response.json({ status: 'answered', ciphertext, page_pubkey: 'fixture-page-key' }), async (client, calls) => {
      const result = await client.pollExchange(handle, 0);
      expect(result).toEqual({ kind: 'answered', ciphertextB64: ciphertext, pagePubkeyB64: 'fixture-page-key' });
      expect(JSON.stringify(result)).not.toContain('private-fixture');
      expect(calls).toHaveBeenCalledTimes(1);
    });
  });
  test.each(['pending', 'attached'])('%s returns after one read without cancelling', async (status) => {
    await withServer(() => Response.json({ status }), async (client, calls) => {
      const handle = connection();
      expect(await client.pollAnswer(handle)).toEqual({ kind: 'pending' });
      expect(calls).toHaveBeenCalledTimes(1);
      const request = calls.mock.calls[0]![0];
      expect(request.method).toBe('GET');
      expect(new URL(request.url).searchParams.get('wait_seconds')).toBe('20');
      expect(request.authorization).toBe('Bearer fixture-token');
      // A second invocation uses the same handle; no replacement/cancel request.
      expect(await client.pollAnswer(handle)).toEqual({ kind: 'pending' });
      expect(calls.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    });
  });

  test('opens a delivered answer with the same private connection handle', async () => {
    const handle = connection();
    const ciphertext = await sealEnvelopePageSide({
      plaintext: 'fixture answer', connectionId: handle.connectionId, clientPubkeyB64: handle.keypair.publicKeyB64,
    });
    await withServer(() => Response.json({ status: 'answered', ciphertext }), async (client, calls) => {
      expect(await client.pollAnswer(handle, 0)).toEqual({ kind: 'answered', plaintext: 'fixture answer' });
      expect(calls).toHaveBeenCalledTimes(1);
    });
  });

  test.each([[410, 'expired'], [409, 'consumed']] as const)('%i remains terminal, not successful', async (status, kind) => {
    await withServer(() => Response.json({}, { status }), async (client, calls) => {
      expect(await client.pollAnswer(connection())).toEqual({ kind });
      expect(calls).toHaveBeenCalledTimes(1);
    });
  });

  test('rejects malformed success instead of polling it forever', async () => {
    await withServer(() => Response.json({ status: 'answered' }), async (client) => {
      expect(await client.pollAnswer(connection())).toEqual({ kind: 'service', status: 200, code: 'INVALID_FORMAT' });
    });
  });

  test.each([[-10, '0'], [1.5, '1'], [999, '25'], [Number.NaN, '20']] as const)('bounds wait_seconds %s', async (input, expected) => {
    await withServer(() => Response.json({ status: 'pending' }), async (client, calls) => {
      await client.pollAnswer(connection(), input);
      expect(new URL(calls.mock.calls[0]![0].url).searchParams.get('wait_seconds')).toBe(expected);
    });
  });

  test('missing authentication cannot start a request', async () => {
    const client = new BrokerClient('http://127.0.0.1:1', () => null);
    expect(await client.pollAnswer(connection())).toEqual({ kind: 'network', detail: 'no session token' });
  });
});
