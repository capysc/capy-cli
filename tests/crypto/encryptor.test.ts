import { Encryptor } from '../../src/crypto/encryptor';

const TEST_KEY = 'test-key-for-encryptor-tests';

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

    it('throws on wrong key', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      expect(() => Encryptor.decrypt(encrypted, 'wrong-key')).toThrow(
        /Failed to decrypt/
      );
    });

    it('throws on tampered ciphertext (GCM auth tag rejects)', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      const buf = Buffer.from(encrypted, 'base64');
      buf[buf.length - 5] ^= 0xff;
      const tampered = buf.toString('base64');

      expect(() => Encryptor.decrypt(tampered, TEST_KEY)).toThrow(
        /Failed to decrypt/
      );
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
