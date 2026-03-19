import { Encryptor } from '../../src/crypto/encryptor';

const TEST_KEY = 'test-key-for-encryptor-tests';

describe('Encryptor', () => {
  describe('encrypt', () => {
    it('produces a value starting with capy: prefix', () => {
      const result = Encryptor.encrypt('hello', TEST_KEY);
      expect(result.startsWith('capy:')).toBe(true);
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

    it('throws on wrong key', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      expect(() => Encryptor.decrypt(encrypted, 'wrong-key')).toThrow(
        /Failed to decrypt/
      );
    });

    it('throws on tampered ciphertext (GCM auth tag rejects)', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      // Flip a byte in the base64 payload
      const parts = encrypted.split(':');
      const buf = Buffer.from(parts[1], 'base64');
      buf[buf.length - 5] ^= 0xff;
      const tampered = 'capy:' + buf.toString('base64');

      expect(() => Encryptor.decrypt(tampered, TEST_KEY)).toThrow(
        /Failed to decrypt/
      );
    });

    it('throws when value lacks capy: prefix', () => {
      expect(() => Encryptor.decrypt('not-encrypted', TEST_KEY)).toThrow(
        /Invalid encrypted value format/
      );
    });

    it('throws when payload is too short', () => {
      expect(() => Encryptor.decrypt('capy:AAAA', TEST_KEY)).toThrow(
        /Invalid encrypted value format/
      );
    });
  });

  describe('isEncrypted', () => {
    it('returns true for encrypted values', () => {
      const encrypted = Encryptor.encrypt('test', TEST_KEY);
      expect(Encryptor.isEncrypted(encrypted)).toBe(true);
    });

    it('returns false for plaintext', () => {
      expect(Encryptor.isEncrypted('just-a-string')).toBe(false);
    });

    it('returns false for capy: prefix with invalid base64', () => {
      expect(Encryptor.isEncrypted('capy:not!valid!base64')).toBe(false);
    });

    it('returns false for capy: prefix with too-short payload', () => {
      expect(Encryptor.isEncrypted('capy:AAAA')).toBe(false);
    });
  });

  describe('generateKey', () => {
    it('returns a 64-char hex string (32 bytes)', () => {
      const key = Encryptor.generateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
