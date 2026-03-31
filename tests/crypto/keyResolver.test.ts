import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock homedir to use a temp directory
const tempHome = mkdtempSync(join(tmpdir(), 'capy-resolver-test-'));
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tempHome,
}));

import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  deriveProjectKey,
  encryptMasterKey,
  deriveWrappingKey,
} from '../../src/crypto/keyManager';
import { saveMasterKey, saveProjectKeyCache } from '../../src/config/globalConfig';
import { resolveProjectKey, resolveFromSeedPhrase, hasOrgKey } from '../../src/crypto/keyResolver';

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('KeyResolver', () => {
  const seedPhrase = generateSeedPhrase();
  const masterKey = seedPhraseToMasterKey(seedPhrase);
  const userId = 'user_resolve_test';
  const orgId = 'org_resolve_test';
  const projectId = 'proj_resolve_test';

  describe('resolveProjectKey', () => {
    it('should throw when no org key exists', () => {
      expect(() => resolveProjectKey('org_missing', 'proj_1', userId))
        .toThrow('You do not have access');
    });

    it('should derive and cache project key from M', () => {
      // Setup: encrypt M and save
      const wrappingKey = deriveWrappingKey(userId, orgId);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(orgId, encryptedM);

      // Resolve
      const key = resolveProjectKey(orgId, projectId, userId);

      // Should match direct derivation
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should return cached project key on second call', () => {
      // Second call should hit cache (already saved by previous test)
      const key = resolveProjectKey(orgId, projectId, userId);
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should fail with wrong userId', () => {
      expect(() => resolveProjectKey(orgId, 'proj_new', 'wrong-user'))
        .toThrow('You do not have access');
    });
  });

  describe('resolveFromSeedPhrase', () => {
    it('should derive same key as resolveProjectKey', () => {
      const fromSeed = resolveFromSeedPhrase(seedPhrase, orgId, projectId);
      const fromResolver = deriveProjectKey(masterKey, projectId, orgId);
      expect(fromSeed).toBe(fromResolver);
    });
  });

  describe('hasOrgKey', () => {
    it('should return true for existing org', () => {
      expect(hasOrgKey(orgId)).toBe(true);
    });

    it('should return false for missing org', () => {
      expect(hasOrgKey('org_nope')).toBe(false);
    });
  });
});
