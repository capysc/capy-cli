import { describe, it, expect } from 'bun:test';
import { generateLocalRoot, deriveLocalInnerKey } from '../../src/crypto/localKeyRoot';

describe('localKeyRoot', () => {
  describe('generateLocalRoot', () => {
    it('mints 32 random bytes', () => {
      const root = generateLocalRoot();
      expect(root.length).toBe(32);
    });

    it('mints a different root every time', () => {
      const a = generateLocalRoot();
      const b = generateLocalRoot();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('deriveLocalInnerKey', () => {
    it('is deterministic for a given K_local', () => {
      const root = generateLocalRoot();
      expect(deriveLocalInnerKey(root).equals(deriveLocalInnerKey(root))).toBe(true);
    });

    it('returns a 32-byte key distinct from the root itself', () => {
      const root = generateLocalRoot();
      const innerKey = deriveLocalInnerKey(root);
      expect(innerKey.length).toBe(32);
      expect(innerKey.equals(root)).toBe(false);
    });

    it('different roots yield different inner keys', () => {
      const a = deriveLocalInnerKey(generateLocalRoot());
      const b = deriveLocalInnerKey(generateLocalRoot());
      expect(a.equals(b)).toBe(false);
    });
  });
});
