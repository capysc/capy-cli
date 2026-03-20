import { Encryptor } from '../../src/crypto/encryptor';

const TEST_KEY = 'test-key-for-encryptor-tests';
const OTHER_KEY = 'a-completely-different-key';

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

    it('always uses the same resource ID for the same key', () => {
      const a = Encryptor.encrypt('hello', TEST_KEY);
      const b = Encryptor.encrypt('world', TEST_KEY);
      expect(Encryptor.extractResourceId(a)).toBe(Encryptor.extractResourceId(b));
    });

    it('uses different resource IDs for different keys', () => {
      const a = Encryptor.encrypt('hello', TEST_KEY);
      const b = Encryptor.encrypt('hello', OTHER_KEY);
      expect(Encryptor.extractResourceId(a)).not.toBe(Encryptor.extractResourceId(b));
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

    it('throws key mismatch error on wrong key before attempting decryption', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      expect(() => Encryptor.decrypt(encrypted, OTHER_KEY)).toThrow(
        /Key mismatch/
      );
    });

    it('includes both resource IDs in the mismatch error', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
      const expectedId = Encryptor.deriveResourceId(TEST_KEY);
      const wrongId = Encryptor.deriveResourceId(OTHER_KEY);
      expect(() => Encryptor.decrypt(encrypted, OTHER_KEY)).toThrow(
        `Key mismatch: encrypted with key "${expectedId}" but decrypting with key "${wrongId}"`
      );
    });

    it('throws on tampered ciphertext (GCM auth tag rejects)', () => {
      const encrypted = Encryptor.encrypt('secret', TEST_KEY);
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
      // Use the correct resource ID so we get past the key check
      const id = Encryptor.deriveResourceId(TEST_KEY);
      expect(() => Encryptor.decrypt(`capy:${id}:AAAA`, TEST_KEY)).toThrow(
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

  describe('deriveResourceId', () => {
    it('returns a 5-character string', () => {
      const id = Encryptor.deriveResourceId(TEST_KEY);
      expect(id).toHaveLength(5);
    });

    it('uses only readable characters (no ambiguous 0/O/1/l/I)', () => {
      // Test with many different keys to exercise the alphabet
      const keys = Array.from({ length: 50 }, (_, i) => `test-key-${i}`);
      for (const key of keys) {
        const id = Encryptor.deriveResourceId(key);
        expect(id).toMatch(/^[a-hjkmnp-z2-9]{5}$/);
      }
    });

    it('is deterministic — same key always produces the same ID', () => {
      const a = Encryptor.deriveResourceId(TEST_KEY);
      const b = Encryptor.deriveResourceId(TEST_KEY);
      expect(a).toBe(b);
    });

    it('produces different IDs for different keys', () => {
      const a = Encryptor.deriveResourceId(TEST_KEY);
      const b = Encryptor.deriveResourceId(OTHER_KEY);
      expect(a).not.toBe(b);
    });
  });

  describe('extractResourceId', () => {
    it('extracts resource ID from encrypted value', () => {
      const encrypted = Encryptor.encrypt('test', TEST_KEY);
      const expectedId = Encryptor.deriveResourceId(TEST_KEY);
      expect(Encryptor.extractResourceId(encrypted)).toBe(expectedId);
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
