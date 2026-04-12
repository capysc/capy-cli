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

  const kr = await import('../../src/crypto/keyResolver');
  resolveProjectKey = kr.resolveProjectKey;
  resolveFromSeedPhrase = kr.resolveFromSeedPhrase;
  hasOrgKey = kr.hasOrgKey;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

/**
 * Mock KeyServiceOps for tests — no real KMS.
 * coDecrypt fails (blob isn't KMS-wrapped), wrapOuterLayer is passthrough.
 */
function mockKeyServiceOps() {
  return {
    coDecrypt: async () => { throw new Error('not KMS-wrapped'); },
    wrapOuterLayer: async (_orgId: string, plaintext: string) => plaintext,
  };
}

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
    it('should throw when no org key exists', async () => {
      await expect(resolveProjectKey('org_missing', 'proj_1', userId, mockKeyServiceOps()))
        .rejects.toThrow('You do not have access');
    });

    it('should derive project key from M via legacy migration', async () => {
      // Setup: encrypt M and save (single-wrapped, no KMS)
      const wrappingKey = deriveWrappingKey(userId, orgId);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(orgId, encryptedM, userId);

      // Resolve — co-decrypt fails, legacy fallback succeeds
      const key = await resolveProjectKey(orgId, projectId, userId, mockKeyServiceOps());

      // Should match direct derivation
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should resolve on second call (after migration re-wrapped)', async () => {
      // The previous test migrated the blob — now wrapOuterLayer was called
      // but since our mock is passthrough, the blob is still single-wrapped.
      // Either path should work.
      const key = await resolveProjectKey(orgId, projectId, userId, mockKeyServiceOps());
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should fail with wrong userId', async () => {
      await expect(resolveProjectKey(orgId, 'proj_new', 'wrong-user', mockKeyServiceOps()))
        .rejects.toThrow('You do not have access');
    });
  });

  describe('resolveFromSeedPhrase', () => {
    it('should derive same key as resolveProjectKey', async () => {
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
