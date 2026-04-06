import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-resolver-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => { mock.restore(); });

// Use dynamic imports so modules see the mocked os.homedir()
let generateSeedPhrase: typeof import('../../src/crypto/keyManager').generateSeedPhrase;
let seedPhraseToMasterKey: typeof import('../../src/crypto/keyManager').seedPhraseToMasterKey;
let deriveProjectKey: typeof import('../../src/crypto/keyManager').deriveProjectKey;
let encryptMasterKey: typeof import('../../src/crypto/keyManager').encryptMasterKey;
let deriveWrappingKey: typeof import('../../src/crypto/keyManager').deriveWrappingKey;
let saveMasterKey: typeof import('../../src/config/globalConfig').saveMasterKey;
let saveProjectKeyCache: typeof import('../../src/config/globalConfig').saveProjectKeyCache;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;
let resolveFromSeedPhrase: typeof import('../../src/crypto/keyResolver').resolveFromSeedPhrase;
let hasOrgKey: typeof import('../../src/crypto/keyResolver').hasOrgKey;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  deriveProjectKey = km.deriveProjectKey;
  encryptMasterKey = km.encryptMasterKey;
  deriveWrappingKey = km.deriveWrappingKey;

  const gc = await import('../../src/config/globalConfig');
  saveMasterKey = gc.saveMasterKey;
  saveProjectKeyCache = gc.saveProjectKeyCache;

  const kr = await import('../../src/crypto/keyResolver');
  resolveProjectKey = kr.resolveProjectKey;
  resolveFromSeedPhrase = kr.resolveFromSeedPhrase;
  hasOrgKey = kr.hasOrgKey;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('KeyResolver', () => {
  let seedPhrase: string;
  let masterKey: Buffer;
  const userId = 'user_resolve_test';
  const orgId = 'org_resolve_test';
  const projectId = 'proj_resolve_test';

  beforeAll(() => {
    seedPhrase = generateSeedPhrase();
    masterKey = seedPhraseToMasterKey(seedPhrase);
  });

  describe('resolveProjectKey', () => {
    it('should throw when no org key exists', () => {
      expect(() => resolveProjectKey('org_missing', 'proj_1', userId))
        .toThrow('You do not have access');
    });

    it('should derive and cache project key from M', () => {
      // Setup: encrypt M and save
      const wrappingKey = deriveWrappingKey(userId, orgId);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(orgId, encryptedM, userId);

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
    it('should return true for existing org+user', () => {
      expect(hasOrgKey(orgId, userId)).toBe(true);
    });

    it('should return false for missing org', () => {
      expect(hasOrgKey('org_nope', userId)).toBe(false);
    });

    it('should return false for wrong user', () => {
      expect(hasOrgKey(orgId, 'wrong-user')).toBe(false);
    });
  });
});
