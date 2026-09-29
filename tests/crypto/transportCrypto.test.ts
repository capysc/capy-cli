/**
 * `capy transport` envelope (CAP-684) — seal/open round trip, tamper and
 * wrong-key rejection, and a known-answer check that a WebCrypto-style
 * AES-GCM decrypt (standing in for Keep's browser-side open) can open what
 * `sealTransportPayload` produces.
 */
import { describe, test, expect } from 'bun:test';
import { webcrypto } from 'crypto';
import {
  generateTransportToken,
  sealTransportPayload,
  openTransportEnvelope,
  TRANSPORT_AAD,
  type TransportEnvelope,
} from '../../src/crypto/transportCrypto';
import type { TransportPayload } from '../../src/crypto/pairingPayload';

const PAYLOAD: TransportPayload = {
  v: 1,
  entries: [{
    org_id: 'org_123',
    user_id: 'user_456',
    k_local: Buffer.alloc(32, 7).toString('base64url'),
    key_enc: JSON.stringify({ version: '2.0', org_id: 'org_123', encrypted_master_key: 'deadbeef', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' }),
  }],
};

describe('sealTransportPayload / openTransportEnvelope', () => {
  test('round-trips the payload under the token that sealed it', () => {
    const token = generateTransportToken();
    const envelope = sealTransportPayload(PAYLOAD, token);
    expect(envelope.v).toBe(1);
    const opened = openTransportEnvelope(envelope, token);
    expect(opened).toEqual(PAYLOAD);
  });

  test('produces a fresh IV (and ciphertext) on every seal', () => {
    const token = generateTransportToken();
    const a = sealTransportPayload(PAYLOAD, token);
    const b = sealTransportPayload(PAYLOAD, token);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test('rejects the wrong token', () => {
    const token = generateTransportToken();
    const wrongToken = generateTransportToken();
    const envelope = sealTransportPayload(PAYLOAD, token);
    expect(() => openTransportEnvelope(envelope, wrongToken)).toThrow();
    try {
      openTransportEnvelope(envelope, wrongToken);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('DECRYPT_KEY_MISMATCH');
    }
  });

  test('rejects a tampered ciphertext', () => {
    const token = generateTransportToken();
    const envelope = sealTransportPayload(PAYLOAD, token);
    const tamperedCtBytes = Buffer.from(envelope.ct, 'base64url');
    tamperedCtBytes[0] = tamperedCtBytes[0] ^ 0xff;
    const tampered: TransportEnvelope = { ...envelope, ct: tamperedCtBytes.toString('base64url') };
    expect(() => openTransportEnvelope(tampered, token)).toThrow();
  });

  test('rejects a tampered IV', () => {
    const token = generateTransportToken();
    const envelope = sealTransportPayload(PAYLOAD, token);
    const tamperedIvBytes = Buffer.from(envelope.iv, 'base64url');
    tamperedIvBytes[0] = tamperedIvBytes[0] ^ 0xff;
    const tampered: TransportEnvelope = { ...envelope, iv: tamperedIvBytes.toString('base64url') };
    expect(() => openTransportEnvelope(tampered, token)).toThrow();
  });

  test('known-answer: a WebCrypto AES-GCM decrypt (simulating Keep) opens what sealTransportPayload produces', async () => {
    const token = generateTransportToken();
    const envelope = sealTransportPayload(PAYLOAD, token);

    const key = await webcrypto.subtle.importKey('raw', token, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = Buffer.from(envelope.iv, 'base64url');
    const ct = Buffer.from(envelope.ct, 'base64url');
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: TRANSPORT_AAD, tagLength: 128 },
      key,
      ct,
    );
    const decoded = JSON.parse(Buffer.from(plaintext).toString('utf8'));
    expect(decoded).toEqual(PAYLOAD);
  });

  test('known-answer: a WebCrypto AES-GCM seal (simulating Keep re-sealing) is opened by openTransportEnvelope', async () => {
    const token = generateTransportToken();
    const key = await webcrypto.subtle.importKey('raw', token, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(PAYLOAD));
    const ctBuf = Buffer.from(await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: TRANSPORT_AAD, tagLength: 128 },
      key,
      plaintextBytes,
    ));
    const envelope: TransportEnvelope = {
      v: 1,
      iv: Buffer.from(iv).toString('base64url'),
      ct: ctBuf.toString('base64url'),
    };
    const opened = openTransportEnvelope(envelope, token);
    expect(opened).toEqual(PAYLOAD);
  });
});
