/**
 * `capy pair` envelope (CAP-684) — the direction that matters in production
 * is Keep (a browser) sealing and the CLI opening, so the main coverage
 * here seals with node:crypto's own `webcrypto` (a real WebCrypto
 * implementation, standing in for the browser) via ECDH + HKDF + AES-GCM,
 * and opens with `openPairEnvelope` — the actual CLI code path.
 */
import { describe, test, expect } from 'bun:test';
import { webcrypto } from 'crypto';
import { generatePairKeyPair, openPairEnvelope, parsePairEnvelope, PAIR_AAD, type PairEnvelope } from '../../src/crypto/pairCrypto';
import type { PairingPayload } from '../../src/crypto/pairingPayload';

const PAYLOAD: PairingPayload = {
  v: 1,
  entries: [
    {
      org_id: 'org_123',
      user_id: 'user_456',
      k_local: Buffer.alloc(32, 9).toString('base64url'),
      key_enc: JSON.stringify({ version: '2.0', org_id: 'org_123', encrypted_master_key: 'cafef00d', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' }),
    },
    {
      org_id: 'org_789',
      user_id: 'user_456',
      k_local: Buffer.alloc(32, 3).toString('base64url'),
      key_enc: JSON.stringify({ version: '2.0', org_id: 'org_789', encrypted_master_key: 'b00b1e5', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' }),
    },
  ],
};

/** Seals `payload` to `recipientPublicKeyRaw` the way Keep's browser JS does: ephemeral P-256 ECDH → HKDF-SHA256 → AES-256-GCM. */
async function sealAsBrowser(payload: PairingPayload, recipientPublicKeyRaw: Buffer): Promise<PairEnvelope> {
  const recipientKey = await webcrypto.subtle.importKey('raw', recipientPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));

  const sharedBits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256);
  const hkdfKeyMaterial = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('capy:pair:v1') },
    hkdfKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
  const ctBuf = Buffer.from(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PAIR_AAD, tagLength: 128 },
    aesKey,
    plaintextBytes,
  ));

  return {
    v: 1,
    epk: epkRaw.toString('base64url'),
    iv: Buffer.from(iv).toString('base64url'),
    ct: ctBuf.toString('base64url'),
  };
}

describe('openPairEnvelope', () => {
  test('known-answer: opens a WebCrypto-sealed envelope (browser seals, CLI opens — the real production direction)', async () => {
    const keyPair = generatePairKeyPair();
    const publicKeyRaw = Buffer.from(keyPair.publicKey, 'base64url');
    const envelope = await sealAsBrowser(PAYLOAD, publicKeyRaw);

    const opened = openPairEnvelope(envelope, keyPair);
    expect(opened).toEqual(PAYLOAD);
  });

  test('rejects an envelope sealed to a DIFFERENT CLI key pair', async () => {
    const keyPair = generatePairKeyPair();
    const otherKeyPair = generatePairKeyPair();
    const otherPublicKeyRaw = Buffer.from(otherKeyPair.publicKey, 'base64url');
    const envelope = await sealAsBrowser(PAYLOAD, otherPublicKeyRaw);

    expect(() => openPairEnvelope(envelope, keyPair)).toThrow();
    try {
      openPairEnvelope(envelope, keyPair);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('DECRYPT_KEY_MISMATCH');
    }
  });

  test('rejects a tampered ciphertext', async () => {
    const keyPair = generatePairKeyPair();
    const publicKeyRaw = Buffer.from(keyPair.publicKey, 'base64url');
    const envelope = await sealAsBrowser(PAYLOAD, publicKeyRaw);

    const tamperedCtBytes = Buffer.from(envelope.ct, 'base64url');
    tamperedCtBytes[0] = tamperedCtBytes[0] ^ 0xff;
    const tampered: PairEnvelope = { ...envelope, ct: tamperedCtBytes.toString('base64url') };
    expect(() => openPairEnvelope(tampered, keyPair)).toThrow();
  });

  test('rejects a tampered epk (a different ephemeral key substituted after the fact)', async () => {
    const keyPair = generatePairKeyPair();
    const publicKeyRaw = Buffer.from(keyPair.publicKey, 'base64url');
    const envelope = await sealAsBrowser(PAYLOAD, publicKeyRaw);

    const otherEphemeral = generatePairKeyPair();
    const tampered: PairEnvelope = { ...envelope, epk: otherEphemeral.publicKey };
    expect(() => openPairEnvelope(tampered, keyPair)).toThrow();
  });

  test('rejects an unsupported envelope version', () => {
    const keyPair = generatePairKeyPair();
    const bogus = { v: 2 as any, epk: 'x', iv: 'x', ct: 'x' } as PairEnvelope;
    try {
      openPairEnvelope(bogus, keyPair);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });
});

describe('parsePairEnvelope', () => {
  test('parses a JSON-stringified envelope and opens it — the real wire contract for /device-pairings/pickup\'s `sealed` field', async () => {
    const keyPair = generatePairKeyPair();
    const publicKeyRaw = Buffer.from(keyPair.publicKey, 'base64url');
    const envelope = await sealAsBrowser(PAYLOAD, publicKeyRaw);
    const sealed = JSON.stringify(envelope);

    const parsed = parsePairEnvelope(sealed);
    expect(parsed).toEqual(envelope);
    expect(openPairEnvelope(parsed, keyPair)).toEqual(PAYLOAD);
  });

  test('refuses non-JSON with a coded INVALID_FORMAT', () => {
    try {
      parsePairEnvelope('not json at all');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('refuses valid JSON with the wrong shape (missing fields)', () => {
    try {
      parsePairEnvelope(JSON.stringify({ v: 1, epk: 'x' }));
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('refuses valid JSON that is not an object at all', () => {
    try {
      parsePairEnvelope(JSON.stringify('just a string'));
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('refuses the wrong version number', () => {
    try {
      parsePairEnvelope(JSON.stringify({ v: 2, epk: 'x', iv: 'y', ct: 'z' }));
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });
});
