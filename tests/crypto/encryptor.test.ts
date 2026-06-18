import { Encryptor } from '../../src/crypto/encryptor';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const TEST_KEY = 'test-key-for-encryptor-tests';

/**
 * Capture the error a failing decrypt throws so tests can assert on its typed
 * `code` (cardinal Rule 4) rather than the human-readable message, which is
 * free to change.
 */
function decryptError(value: string, key: string): CapyError {
  try {
    Encryptor.decrypt(value, key);
  } catch (e) {
    return e as CapyError;
  }
  throw new Error('expected Encryptor.decrypt to throw');
}

describe('Encryptor', () => {
  describe('encrypt', () => {
    it('produces a base64 string', () => {
      const result = Encryptor.encrypt('hello', TEST_KEY);
      expect(Buffer.from(result, 'base64').toString('base64')).toBe(result);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
      const a = Encryptor.encrypt('hello', TEST_KEY);
      const b = Encryptor.encrypt('hello', TEST_KEY);
      expect(a).not.toBe(b);
    });
  });

  describe('decrypt', () => {
    it('roundtrips a simple string', () => {
      const encrypted = Encryptor.encrypt('my-secret', TEST_KEY);
      expect(Encryptor.decrypt(encrypted, TEST_KEY)).toBe('my-secret');
    });

    it('roundtrips an empty string', () => {
      const encrypted = Encryptor.encrypt('', TEST_KEY);
      expect(Encryptor.decrypt(encrypted, TEST_KEY)).toBe('');
    });

    it('roundtrips unicode content', () => {
      const value = 'héllo wörld 🔐';
      const encrypted = Encryptor.encrypt(value, TEST_KEY);
      expect(Encryptor.decrypt(encrypted, TEST_KEY)).toBe(value);
    });

    it('roundtrips short values like "true" and "false"', () => {
      for (const val of ['true', 'false', '0', '1', 'y', 'n']) {
        const encrypted = Encryptor.encrypt(val, TEST_KEY);
        expect(Encryptor.decrypt(encrypted, TEST_KEY)).toBe(val);
      }
    });

    it('throws a typed DECRYPT_KEY_MISMATCH on wrong key', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      const err = decryptError(encrypted, 'wrong-key');
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe(ERROR_CODES.DECRYPT_KEY_MISMATCH);
    });

    it('throws a typed DECRYPT_KEY_MISMATCH on tampered ciphertext (GCM auth tag rejects)', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 5] ^= 0xff;
      const tampered = buf.toString('base64');

      const err = decryptError(tampered, TEST_KEY);
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe(ERROR_CODES.DECRYPT_KEY_MISMATCH);
    });

    it('throws when payload is too short', () => {
      expect(() => Encryptor.decrypt('AAAA', TEST_KEY)).toThrow(
        /too short/
      );
    });
  });

  describe('generateKey', () => {
    it('returns a 64-char hex string (32 bytes)', () => {
      const key = Encryptor.generateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
