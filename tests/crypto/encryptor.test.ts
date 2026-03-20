import { Encryptor } from '../../src/crypto/encryptor';

const TEST_KEY = 'test-key-for-encryptor-tests';

describe('Encryptor', () => {
  describe('encrypt', () => {
    it('produces a value in capy:{resourceId}:{base64} format', () => {
      const result = Encryptor.encrypt('hello', TEST_KEY);
      expect(result).toMatch(/^capy:[a-z0-9]{5}:.+$/);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
      const a = Encryptor.encrypt('hello', TEST_KEY);
      const b = Encryptor.encrypt('hello', TEST_KEY);
      expect(a).not.toBe(b);
    });

    it('uses provided resourceId when given', () => {
      const result = Encryptor.encrypt('hello', TEST_KEY, 'abcde');
      expect(result.startsWith('capy:abcde:')).toBe(true);
    });

    it('generates a resourceId when not provided', () => {
      const result = Encryptor.encrypt('hello', TEST_KEY);
      const id = Encryptor.extractResourceId(result);
      expect(id).toHaveLength(5);
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
      // Flip a byte in the base64 payload
      const parts = encrypted.split(':');
      const buf = Buffer.from(parts[2], 'base64');
      buf[buf.length - 5] ^= 0xff;
      const tampered = `capy:${parts[1]}:${buf.toString('base64')}`;

      expect(() => Encryptor.decrypt(tampered, TEST_KEY)).toThrow(
        /Failed to decrypt/
      );
    });

    it('throws when value lacks capy: prefix', () => {
      expect(() => Encryptor.decrypt('not-encrypted', TEST_KEY)).toThrow(
        /Invalid encrypted value format/
      );
    });

    it('throws when missing resource ID', () => {
      expect(() => Encryptor.decrypt('capy:AAAA', TEST_KEY)).toThrow(
        /missing resource ID/
      );
    });

    it('throws when payload is too short', () => {
      expect(() => Encryptor.decrypt('capy:abcde:AAAA', TEST_KEY)).toThrow(
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

    it('returns false for capy: prefix without resource ID', () => {
      expect(Encryptor.isEncrypted('capy:onlybase64data')).toBe(false);
    });

    it('returns false for capy:{id}: with invalid base64', () => {
      expect(Encryptor.isEncrypted('capy:abcde:not!valid!base64')).toBe(false);
    });

    it('returns false for capy:{id}: with too-short payload', () => {
      expect(Encryptor.isEncrypted('capy:abcde:AAAA')).toBe(false);
    });
  });

  describe('generateResourceId', () => {
    it('returns a 5-character string', () => {
      const id = Encryptor.generateResourceId();
      expect(id).toHaveLength(5);
    });

    it('uses only readable characters (no ambiguous 0/O/1/l/I)', () => {
      for (let i = 0; i < 50; i++) {
        const id = Encryptor.generateResourceId();
        expect(id).toMatch(/^[a-hjkmnp-z2-9]{5}$/);
      }
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => Encryptor.generateResourceId()));
      expect(ids.size).toBeGreaterThan(90);
    });
  });

  describe('extractResourceId', () => {
    it('extracts resource ID from encrypted value', () => {
      const encrypted = Encryptor.encrypt('test', TEST_KEY, 'xyz42');
      expect(Encryptor.extractResourceId(encrypted)).toBe('xyz42');
    });

    it('returns null for non-encrypted values', () => {
      expect(Encryptor.extractResourceId('plaintext')).toBeNull();
    });

    it('returns null for capy: without resource ID separator', () => {
      expect(Encryptor.extractResourceId('capy:nocolon')).toBeNull();
    });
  });

  describe('generateKey', () => {
    it('returns a 64-char hex string (32 bytes)', () => {
      const key = Encryptor.generateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
