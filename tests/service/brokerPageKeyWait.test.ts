import { expect, spyOn, test } from 'bun:test';
import { BrokerClient } from '../../src/service/brokerClient';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';

test('page-key wait ends on attachment rather than waiting for an answer', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.searchParams.get('wait_for')).toBe('page_key');
    expect(Number(url.searchParams.get('wait_seconds'))).toBeGreaterThan(0);
    return Response.json({ status: 'attached', page_pubkey: 'browser-key' });
  });
  try {
    const result = await new BrokerClient('https://service.test', () => 'test-token').awaitPagePubkey({
      connectionId: 'test', expiresAt: new Date(Date.now() + 60000).toISOString(), keypair: mintConnectionKeypair(),
    });
    expect(result).toEqual({ kind: 'ready', pagePubkeyB64: 'browser-key' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally { fetchSpy.mockRestore(); }
});
