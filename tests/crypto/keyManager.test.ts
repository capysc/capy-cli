import {
  generateSeedPhrase,
  validateSeedPhrase,
  seedPhraseToMasterKey,
  deriveProjectKey,
  encryptMasterKey,
  decryptMasterKey,
  deriveWrappingKey,
} from '../../src/crypto/keyManager';
import { BIP39_WORDLIST } from '../../src/crypto/bip39Words';

describe('KeyManager', () => {
  describe('generateSeedPhrase', () => {
    it('should generate a 24-word phrase', () => {
      const phrase = generateSeedPhrase();
      const words = phrase.split(' ');
      expect(words).toHaveLength(24);
    });

    it('should use only BIP-39 words', () => {
      const phrase = generateSeedPhrase();
      const words = phrase.split(' ');
      for (const word of words) {
        expect(BIP39_WORDLIST).toContain(word);
      }
    });

    it('should generate different phrases each time', () => {
      const a = generateSeedPhrase();
      const b = generateSeedPhrase();
      expect(a).not.toBe(b);
    });

    it('should generate a valid checksum', () => {
      const phrase = generateSeedPhrase();
      expect(validateSeedPhrase(phrase)).toBe(true);
    });
  });

  describe('validateSeedPhrase', () => {
    it('should reject phrases with wrong word count', () => {
      expect(validateSeedPhrase('abandon abandon abandon')).toBe(false);
    });

    it('should reject phrases with invalid words', () => {
      const bad = 'notaword ' + Array(23).fill('abandon').join(' ');
      expect(validateSeedPhrase(bad)).toBe(false);
    });

    it('should reject phrases with bad checksum', () => {
      // All "abandon" x24 has an incorrect checksum (last word should be "about" for all-zero entropy)
      const bad = Array(24).fill('abandon').join(' ');
      expect(validateSeedPhrase(bad)).toBe(false);
    });
  });

  describe('seedPhraseToMasterKey', () => {
    it('should produce a 32-byte key', () => {
      const phrase = generateSeedPhrase();
      const key = seedPhraseToMasterKey(phrase);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should be deterministic', () => {
      const phrase = generateSeedPhrase();
      const a = seedPhraseToMasterKey(phrase);
      const b = seedPhraseToMasterKey(phrase);
      expect(a.equals(b)).toBe(true);
    });

    it('should produce different keys for different phrases', () => {
      const a = seedPhraseToMasterKey(generateSeedPhrase());
      const b = seedPhraseToMasterKey(generateSeedPhrase());
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('deriveProjectKey', () => {
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    it('should return a 64-char hex string (32 bytes)', () => {
      const key = deriveProjectKey(masterKey, 'proj_123', 'org_456');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic', () => {
      const a = deriveProjectKey(masterKey, 'proj_123', 'org_456');
      const b = deriveProjectKey(masterKey, 'proj_123', 'org_456');
      expect(a).toBe(b);
    });

    it('should produce different keys for different projects', () => {
      const a = deriveProjectKey(masterKey, 'proj_A', 'org_1');
      const b = deriveProjectKey(masterKey, 'proj_B', 'org_1');
      expect(a).not.toBe(b);
    });

    it('should produce different keys for different orgs', () => {
      const a = deriveProjectKey(masterKey, 'proj_A', 'org_1');
      const b = deriveProjectKey(masterKey, 'proj_A', 'org_2');
      expect(a).not.toBe(b);
    });
  });

  describe('encryptMasterKey / decryptMasterKey', () => {
    it('should round-trip correctly', () => {
      const masterKey = seedPhraseToMasterKey(generateSeedPhrase());
      const wrappingKey = deriveWrappingKey('user_1', 'org_1');

      const encrypted = encryptMasterKey(masterKey, wrappingKey);
      const decrypted = decryptMasterKey(encrypted, wrappingKey);

      expect(decrypted.equals(masterKey)).toBe(true);
    });

    it('should fail with wrong wrapping key', () => {
      const masterKey = seedPhraseToMasterKey(generateSeedPhrase());
      const correctKey = deriveWrappingKey('user_1', 'org_1');
      const wrongKey = deriveWrappingKey('user_2', 'org_1');

      const encrypted = encryptMasterKey(masterKey, correctKey);
      expect(() => decryptMasterKey(encrypted, wrongKey)).toThrow();
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const masterKey = seedPhraseToMasterKey(generateSeedPhrase());
      const wrappingKey = deriveWrappingKey('user_1', 'org_1');

      const a = encryptMasterKey(masterKey, wrappingKey);
      const b = encryptMasterKey(masterKey, wrappingKey);
      expect(a).not.toBe(b);
    });
  });

  describe('deriveWrappingKey', () => {
    it('should produce a 32-byte buffer', () => {
      const key = deriveWrappingKey('user_1', 'org_1');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should be deterministic for same userId+orgId', () => {
      const a = deriveWrappingKey('user_1', 'org_1');
      const b = deriveWrappingKey('user_1', 'org_1');
      expect(a.equals(b)).toBe(true);
    });
  });
});
