/**
 * Test-side implementation of the PAGE half of the broker envelope (v1) —
 * built on `crypto.subtle` only, exactly as a browser page does it. Covers
 * both directions: sealing an answer (page -> CLI, `ans`), and minting the
 * page's own reverse-channel keypair plus opening a request the CLI sealed
 * to it (CLI -> page, `req`). Mirrors keep-app's `src/lib/broker/envelope.ts`.
 */
import { envelopeHkdfInfo, requestHkdfInfo, ENVELOPE_VERSION } from '../../src/service/brokerEnvelope';

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

/**
 * Mint the page's own reverse-channel keypair — what a real page generates
 * client-side and registers as `page_pubkey` on attach. The private key stays
 * in this non-extractable `CryptoKey`, exactly as it would in a browser tab.
 */
export async function mintPageKeypairPageSide(): Promise<{
  pagePubkeyB64: string;
  privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { pagePubkeyB64: Buffer.from(raw).toString('base64'), privateKey: pair.privateKey };
}

/**
 * Open a CLI->page request envelope (`req` direction) as the page would:
 * ECDH(page's own private key, the envelope's `epk`), HKDF tagged `req`,
 * AES-256-GCM decrypt. The mirror of `sealRequestEnvelope` in
 * `brokerEnvelope.ts`, proving the CLI's node:crypto seal opens under a real
 * WebCrypto implementation.
 */
export async function openRequestEnvelopePageSide(opts: {
  ciphertextB64: string;
  connectionId: string;
  clientPubkeyB64: string;
  pagePrivateKey: CryptoKey;
}): Promise<string> {
  const envelope = JSON.parse(Buffer.from(opts.ciphertextB64, 'base64').toString('utf8')) as {
    v: number;
    epk: string;
    iv: string;
    ct: string;
  };

  const epkPub = await crypto.subtle.importKey(
    'raw',
    Buffer.from(envelope.epk, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: epkPub },
    opts.pagePrivateKey,
    256,
  );
  const info = new TextEncoder().encode(
    requestHkdfInfo(opts.connectionId, opts.clientPubkeyB64, envelope.epk),
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const ivBytes = Buffer.from(envelope.iv, 'base64');
  const ctBytes = Buffer.from(envelope.ct, 'base64');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    aesKey,
    ctBytes,
  );
  return new TextDecoder().decode(plaintext);
}
