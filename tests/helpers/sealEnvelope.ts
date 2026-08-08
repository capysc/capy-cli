/**
 * Test-side implementation of the PAGE half of the broker answer envelope
 * (v1) — built on `crypto.subtle` only, exactly as a browser page does it,
 * so these tests prove WebCrypto-sealed answers open under the CLI's
 * node:crypto implementation. Mirrors keep-app's `src/lib/broker/envelope.ts`.
 */
import { envelopeHkdfInfo, ENVELOPE_VERSION } from '../../src/service/brokerEnvelope';

export async function sealEnvelopePageSide(opts: {
  plaintext: string;
  connectionId: string;
  clientPubkeyB64: string;
}): Promise<string> {
  const clientPub = await crypto.subtle.importKey(
    'raw',
    Buffer.from(opts.clientPubkeyB64, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const epkB64 = Buffer.from(epkRaw).toString('base64');

  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPub },
    eph.privateKey,
    256,
  );
  const info = new TextEncoder().encode(
    envelopeHkdfInfo(opts.connectionId, opts.clientPubkeyB64, epkB64),
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, [
    'deriveKey',
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(opts.plaintext),
    ),
  );

  const envelope = {
    v: ENVELOPE_VERSION,
    epk: epkB64,
    iv: Buffer.from(iv).toString('base64'),
    ct: Buffer.from(ct).toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}
