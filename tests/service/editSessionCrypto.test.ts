/**
 * CAP-540 session-envelope value layer, CLI side. Pins the round trip and
 * that the derivation is connection-bound (a key derived for one
 * connection id cannot open an envelope sealed for another) — the same
 * property keep-app's editSession/crypto.ts tests pin on the WebCrypto
 * side. Cross-repo agreement between the two implementations was verified
 * manually (both derive the identical 32-byte key for the same
 * prfOutput/connectionId) rather than re-asserted here, since this repo
 * cannot import keep-app's TypeScript.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';

import { deriveEditSessionKey, openEditValue, sealEditValue } from '../../src/service/editSessionCrypto';

describe('deriveEditSessionKey / sealEditValue / openEditValue', () => {
  test('round-trips a value, and the ciphertext never contains the plaintext', () => {
    const prfOutput = randomBytes(32);
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const key = deriveEditSessionKey(prfOutput, connectionId);

    const sentinel = 'sk_test_CAP540_never_leak';
    const sealed = sealEditValue(key, sentinel);

    expect(sealed.ct).not.toContain(sentinel);
    expect(Buffer.from(sealed.ct, 'base64').toString('latin1')).not.toContain(sentinel);

    expect(openEditValue(key, sealed)).toBe(sentinel);
  });

  test('is connection-bound: a key derived for a different connection id cannot open the envelope', () => {
    const prfOutput = randomBytes(32);
    const keyA = deriveEditSessionKey(prfOutput, '22222222-2222-4222-8222-222222222222');
    const keyB = deriveEditSessionKey(prfOutput, '33333333-3333-4333-8333-333333333333');

    const sealed = sealEditValue(keyA, 'value');
    expect(openEditValue(keyB, sealed)).toBeNull();
  });

  test('is deterministic for identical inputs and distinct for different PRF outputs', () => {
    const connectionId = '44444444-4444-4444-8444-444444444444';
    const prfA = randomBytes(32);
    const prfB = randomBytes(32);

    const keyA1 = deriveEditSessionKey(prfA, connectionId);
    const keyA2 = deriveEditSessionKey(prfA, connectionId);
    expect(keyA1.equals(keyA2)).toBe(true);

    const keyB = deriveEditSessionKey(prfB, connectionId);
    expect(keyA1.equals(keyB)).toBe(false);
  });

  test('tampered ciphertext fails closed rather than returning garbage plaintext', () => {
    const key = deriveEditSessionKey(randomBytes(32), 'conn-1');
    const sealed = sealEditValue(key, 'value');
    const tampered = { iv: sealed.iv, ct: Buffer.from('not the real ciphertext').toString('base64') };
    expect(openEditValue(key, tampered)).toBeNull();
  });
});
