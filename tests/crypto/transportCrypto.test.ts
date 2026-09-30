/**
 * `capy transport` "v2" (CAP-684, docs/basic-pair.md — updated 2026-09-30) —
 * seal/open round trip, tampering (ciphertext, IV, and the `id` the AAD is
 * bound to) and wrong-key rejection, a known-answer check that a
 * WebCrypto-style AES-GCM decrypt (standing in for Keep's browser-side
 * open) can open what `sealTransportPayload` produces, a fragment-parse
 * round trip, and a QR-capacity check for a realistic ~1KB link.
 */
import { describe, test, expect } from 'bun:test';
import { webcrypto } from 'crypto';
import {
  generateTransportKey,
  sealTransportPayload,
  openTransportFragment,
  parseTransportFragment,
  transportAad,
  type TransportFragment,
} from '../../src/crypto/transportCrypto';
import { buildTerminalQr } from '../../src/ui/terminalQr';
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

const ID = 'transport_abc123';

describe('sealTransportPayload / openTransportFragment', () => {
  test('round-trips the payload under the key and id that sealed it', () => {
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);
    const opened = openTransportFragment(fragment, key, ID);
    expect(opened).toEqual(PAYLOAD);
  });

  test('produces a fresh IV (and ciphertext) on every seal', () => {
    const key = generateTransportKey();
    const a = sealTransportPayload(PAYLOAD, key, ID);
    const b = sealTransportPayload(PAYLOAD, key, ID);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test('rejects the wrong key', () => {
    const key = generateTransportKey();
    const wrongKey = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);
    try {
      openTransportFragment(fragment, wrongKey, ID);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('DECRYPT_KEY_MISMATCH');
    }
  });

  test('rejects a tampered id — the AAD binds the fragment to the exact transport row', () => {
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);
    try {
      openTransportFragment(fragment, key, 'transport_someone_elses_row');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('DECRYPT_KEY_MISMATCH');
    }
  });

  test('rejects a tampered ciphertext', () => {
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);
    const tamperedCtBytes = Buffer.from(fragment.ct, 'base64url');
    tamperedCtBytes[0] = tamperedCtBytes[0] ^ 0xff;
    const tampered: TransportFragment = { ...fragment, ct: tamperedCtBytes.toString('base64url') };
    expect(() => openTransportFragment(tampered, key, ID)).toThrow();
  });

  test('rejects a tampered IV', () => {
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);
    const tamperedIvBytes = Buffer.from(fragment.iv, 'base64url');
    tamperedIvBytes[0] = tamperedIvBytes[0] ^ 0xff;
    const tampered: TransportFragment = { ...fragment, iv: tamperedIvBytes.toString('base64url') };
    expect(() => openTransportFragment(tampered, key, ID)).toThrow();
  });

  test('known-answer: a WebCrypto AES-GCM decrypt (simulating Keep) opens what sealTransportPayload produces', async () => {
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, ID);

    const cryptoKey = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = Buffer.from(fragment.iv, 'base64url');
    const ct = Buffer.from(fragment.ct, 'base64url');
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: transportAad(ID), tagLength: 128 },
      cryptoKey,
      ct,
    );
    const decoded = JSON.parse(Buffer.from(plaintext).toString('utf8'));
    expect(decoded).toEqual(PAYLOAD);
  });

  test('known-answer: a WebCrypto AES-GCM seal (simulating Keep re-sealing) is opened by openTransportFragment', async () => {
    const key = generateTransportKey();
    const cryptoKey = await webcrypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(PAYLOAD));
    const ctBuf = Buffer.from(await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: transportAad(ID), tagLength: 128 },
      cryptoKey,
      plaintextBytes,
    ));
    const fragment: TransportFragment = {
      iv: Buffer.from(iv).toString('base64url'),
      ct: ctBuf.toString('base64url'),
    };
    const opened = openTransportFragment(fragment, key, ID);
    expect(opened).toEqual(PAYLOAD);
  });
});

describe('parseTransportFragment', () => {
  test('a link built from a server-mock id/S round-trips through parsing and opening', () => {
    // Simulate `POST /transports` returning {id, expires_at} and the CLI
    // sealing under the S it generated — then simulate Keep parsing the
    // printed link's fragment and recovering S via `activate` (here: the
    // same key, since this test's job is the fragment shape, not the
    // network call).
    const serverMockId = 'transport_srv_mock_42';
    const key = generateTransportKey();
    const fragment = sealTransportPayload(PAYLOAD, key, serverMockId);
    const url = `https://keep.capy.sc/transport#${serverMockId}.${fragment.iv}.${fragment.ct}`;

    const [, builtFragment] = url.split('#');
    const parsed = parseTransportFragment(builtFragment);
    expect(parsed.id).toBe(serverMockId);
    expect(parsed.iv).toBe(fragment.iv);
    expect(parsed.ct).toBe(fragment.ct);

    const opened = openTransportFragment({ iv: parsed.iv, ct: parsed.ct }, key, parsed.id);
    expect(opened).toEqual(PAYLOAD);
  });

  test('refuses a fragment with the wrong number of parts', () => {
    try {
      parseTransportFragment('only.two');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });

  test('refuses a fragment with an empty part', () => {
    try {
      parseTransportFragment('id..ct');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_FORMAT');
    }
  });
});

describe('QR capacity for a realistic transport link', () => {
  test('renders a ~1KB transport URL without throwing', () => {
    // The real key.enc file (globalConfig.ts#saveMasterKey's pretty-printed
    // JSON) is roughly 471 bytes; embedded as an escaped JSON string value
    // inside the payload, plus org_id/user_id/k_local, the sealed payload
    // and its base64url ciphertext land the whole link around 800-1000
    // bytes in practice. This builds a same-order-of-magnitude link
    // directly (not by re-deriving the exact byte count) and asserts
    // qrcode-terminal renders it — see terminalQr.ts and check-screens.mjs
    // for the library choice; there is no compression here because there
    // doesn't need to be (this passes with room to spare).
    const id = Buffer.alloc(16, 3).toString('base64url');
    const iv = Buffer.alloc(12, 5).toString('base64url');
    // ~700 raw bytes of ciphertext (plaintext + GCM tag), base64url-encoded.
    const ct = Buffer.alloc(716).fill(9).toString('base64url');
    const url = `https://keep.capy.sc/transport#${id}.${iv}.${ct}`;
    expect(Buffer.byteLength(url)).toBeGreaterThan(900);
    expect(Buffer.byteLength(url)).toBeLessThan(1100);

    const qr = buildTerminalQr(url);
    expect(qr.text.length).toBeGreaterThan(0);
    expect(qr.width).toBeGreaterThan(0);
    expect(qr.height).toBeGreaterThan(0);
  });
});
