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
  const accessToken = 'test-access-token-123';
  const orgId = 'org_resolve_test';
  const projectId = 'proj_resolve_test';

  describe('resolveProjectKey', () => {
    it('should throw when no org key exists', () => {
      expect(() => resolveProjectKey('org_missing', 'proj_1', accessToken))
        .toThrow('No master key found');
    });

    it('should derive and cache project key from M', () => {
      // Setup: encrypt M and save
      const wrappingKey = deriveWrappingKey(accessToken);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(orgId, encryptedM);

      // Resolve
      const key = resolveProjectKey(orgId, projectId, accessToken);

      // Should match direct derivation
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should return cached project key on second call', () => {
      // Second call should hit cache (already saved by previous test)
      const key = resolveProjectKey(orgId, projectId, accessToken);
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should fail with wrong access token', () => {
      expect(() => resolveProjectKey(orgId, 'proj_new', 'wrong-token'))
        .toThrow('Failed to unwrap master key');
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
