import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';

import { deriveEditSessionKey, openEditValue, sealEditValue } from '../../src/service/editSessionCrypto';

const AAD = JSON.stringify([
  'capy/secret-edit',
  'flow-1',
  'user-1',
  'org-1',
  'cli-to-browser',
  'API_KEY',
  'keep-hash-1',
]);

describe('secret-edit session crypto', () => {
  test('derives a stable 32-byte key from K_local and a 32-byte flow secret', () => {
    const kLocal = Buffer.alloc(32, 7);
    const flowSecret = Buffer.alloc(32, 9).toString('base64');
    const first = deriveEditSessionKey(kLocal, flowSecret);
    const second = deriveEditSessionKey(kLocal, flowSecret);

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(first.equals(deriveEditSessionKey(Buffer.alloc(32, 8), flowSecret))).toBe(false);
  });

  test('requires canonical base64 for an exactly 32-byte flow secret', () => {
    expect(() => deriveEditSessionKey(Buffer.alloc(32), Buffer.alloc(31).toString('base64'))).toThrow();
    expect(() => deriveEditSessionKey(Buffer.alloc(32), 'not valid base64')).toThrow();
  });

  test('round-trips only under the exact directional AAD', () => {
    const key = deriveEditSessionKey(randomBytes(32), randomBytes(32).toString('base64'));
    const secret = 'sk_test_CAP540_never_leak';
    const sealed = sealEditValue(key, secret, AAD);

    expect(Buffer.from(sealed.ct, 'base64').toString('latin1')).not.toContain(secret);
    expect(openEditValue(key, sealed, AAD)).toBe(secret);
    expect(openEditValue(key, sealed, AAD.replace('cli-to-browser', 'browser-to-cli'))).toBeNull();
  });
});
