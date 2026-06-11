import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { CapyError, ERROR_CODES } from '../../src/types/index';

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
let decryptMasterKey: typeof import('../../src/crypto/keyManager').decryptMasterKey;
let deriveWrappingKey: typeof import('../../src/crypto/keyManager').deriveWrappingKey;
let masterKeyAAD: typeof import('../../src/crypto/keyManager').masterKeyAAD;
let generateLocalRoot: typeof import('../../src/crypto/localKeyRoot').generateLocalRoot;
let deriveLocalInnerKey: typeof import('../../src/crypto/localKeyRoot').deriveLocalInnerKey;
let saveMasterKey: typeof import('../../src/config/globalConfig').saveMasterKey;
let readMasterKey: typeof import('../../src/config/globalConfig').readMasterKey;
let saveLocalRoot: typeof import('../../src/config/globalConfig').saveLocalRoot;
let readLocalRoot: typeof import('../../src/config/globalConfig').readLocalRoot;
let hasLocalRoot: typeof import('../../src/config/globalConfig').hasLocalRoot;
let getLocalRootPath: typeof import('../../src/config/globalConfig').getLocalRootPath;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;
let resolveFromSeedPhrase: typeof import('../../src/crypto/keyResolver').resolveFromSeedPhrase;
let hasOrgKey: typeof import('../../src/crypto/keyResolver').hasOrgKey;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  deriveProjectKey = km.deriveProjectKey;
  encryptMasterKey = km.encryptMasterKey;
  decryptMasterKey = km.decryptMasterKey;
  deriveWrappingKey = km.deriveWrappingKey;
  masterKeyAAD = km.masterKeyAAD;

  const lkr = await import('../../src/crypto/localKeyRoot');
  generateLocalRoot = lkr.generateLocalRoot;
  deriveLocalInnerKey = lkr.deriveLocalInnerKey;

  const gc = await import('../../src/config/globalConfig');
  saveMasterKey = gc.saveMasterKey;
  readMasterKey = gc.readMasterKey;
  saveLocalRoot = gc.saveLocalRoot;
  readLocalRoot = gc.readLocalRoot;
  hasLocalRoot = gc.hasLocalRoot;
  getLocalRootPath = gc.getLocalRootPath;

  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
  resolveProjectKey = kr.resolveProjectKey;
  resolveFromSeedPhrase = kr.resolveFromSeedPhrase;
  hasOrgKey = kr.hasOrgKey;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

/**
 * Fake KMS for tests, mirroring the real contract: wrapOuterLayer adds an
 * outer layer, coDecrypt strips it (and rejects blobs that don't have one,
 * exactly like KMS rejecting a non-KMS ciphertext).
 */
const KMS_PREFIX = 'KMS1.';
function mockKeyServiceOps() {
  return {
    coDecrypt: async (_orgId: string, ct: string) => {
      if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
      return ct.slice(KMS_PREFIX.length);
    },
    wrapOuterLayer: async (_orgId: string, plaintext: string) => KMS_PREFIX + plaintext,
  };
}

/** Strip the fake KMS layer off a stored blob, asserting it has one. */
function innerOf(storedBlob: string): string {
  if (!storedBlob.startsWith(KMS_PREFIX)) throw new Error('expected KMS-wrapped blob');
  return storedBlob.slice(KMS_PREFIX.length);
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
      // The previous test migrated the blob onto K_local with a KMS outer
      // layer — this exercises the steady state: co-decrypt + K_local unwrap.
      const key = await resolveProjectKey(orgId, projectId, userId, mockKeyServiceOps());
      const expected = deriveProjectKey(masterKey, projectId, orgId);
      expect(key).toBe(expected);
    });

    it('should fail with wrong userId', async () => {
      await expect(resolveProjectKey(orgId, 'proj_new', 'wrong-user', mockKeyServiceOps()))
        .rejects.toThrow('You do not have access');
    });

    it('should re-throw 403 instead of falling through to legacy', async () => {
      // Setup: save a valid single-wrapped key that legacy WOULD decrypt
      const wrappingKey = deriveWrappingKey(userId, orgId);
      const encryptedM = encryptMasterKey(masterKey, wrappingKey);
      saveMasterKey(orgId, encryptedM, userId);

      const kickedOps = {
        coDecrypt: async () => {
          throw new CapyError('Not a member of this organization', ERROR_CODES.PERMISSION_DENIED, { status: 403 });
        },
        wrapOuterLayer: async (_orgId: string, pt: string) => pt,
      };

      // Should throw the 403 error, NOT fall through to legacy and succeed
      await expect(resolveProjectKey(orgId, projectId, userId, kickedOps))
        .rejects.toThrow('Not a member of this organization');
    });

    it('should re-throw network errors instead of falling through to legacy', async () => {
      const networkOps = {
        coDecrypt: async () => {
          throw new CapyError('Failed to connect', ERROR_CODES.NETWORK_ERROR, { code: 'ECONNREFUSED' });
        },
        wrapOuterLayer: async (_orgId: string, pt: string) => pt,
      };

      await expect(resolveProjectKey(orgId, projectId, userId, networkOps))
        .rejects.toThrow('Failed to connect');
    });
  });

  describe('K_local migration', () => {
    it('migrates a legacy double-wrapped blob onto K_local on first resolve', async () => {
      const org = 'org_mig1';
      const user = 'user_mig1';
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);
      expect(hasLocalRoot(org, user)).toBe(false);

      const key = await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      expect(key).toBe(deriveProjectKey(masterKey, projectId, org));

      // K_local was minted and the blob re-keyed under it
      expect(hasLocalRoot(org, user)).toBe(true);
      const root = readLocalRoot(org, user)!;
      const inner = innerOf(readMasterKey(org, user)!);
      const recovered = decryptMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(user, org));
      expect(recovered.equals(masterKey)).toBe(true);
    });

    it('the migrated blob no longer opens with the legacy key', async () => {
      const org = 'org_mig2';
      const user = 'user_mig2';
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);

      await resolveProjectKey(org, projectId, user, mockKeyServiceOps());

      const inner = innerOf(readMasterKey(org, user)!);
      expect(() => decryptMasterKey(inner, deriveWrappingKey(user, org), masterKeyAAD(user, org))).toThrow();
    });

    it('resolves via K_local on the second run without rewriting the blob', async () => {
      const org = 'org_mig3';
      const user = 'user_mig3';
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);

      await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      const blobAfterMigration = readMasterKey(org, user)!;

      const key = await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      expect(key).toBe(deriveProjectKey(masterKey, projectId, org));
      // Steady state is read-only — no re-migration write
      expect(readMasterKey(org, user)!).toBe(blobAfterMigration);
    });

    it('crash self-heal: reuses an existing local.key instead of minting a second root', async () => {
      const org = 'org_mig4';
      const user = 'user_mig4';
      // Simulate a crash that landed between minting local.key and re-wrapping
      // key.enc: the root exists but the blob is still legacy-keyed.
      const preRoot = generateLocalRoot();
      saveLocalRoot(org, preRoot, user);
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);

      const key = await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      expect(key).toBe(deriveProjectKey(masterKey, projectId, org));

      // The pre-existing root was reused, not replaced, and now keys the blob
      expect(readLocalRoot(org, user)!.equals(preRoot)).toBe(true);
      const inner = innerOf(readMasterKey(org, user)!);
      const recovered = decryptMasterKey(inner, deriveLocalInnerKey(preRoot), masterKeyAAD(user, org));
      expect(recovered.equals(masterKey)).toBe(true);
    });

    it('proceeds when the re-wrap fails mid-migration, then self-heals next run', async () => {
      const org = 'org_mig5';
      const user = 'user_mig5';
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);

      // Server can co-decrypt but the wrap endpoint is down
      const brokenWrap = {
        coDecrypt: mockKeyServiceOps().coDecrypt,
        wrapOuterLayer: async () => { throw new Error('kms down'); },
      };
      const key = await resolveProjectKey(org, projectId, user, brokenWrap);
      expect(key).toBe(deriveProjectKey(masterKey, projectId, org));

      // Blob is still legacy-keyed (re-wrap failed)…
      const inner = innerOf(readMasterKey(org, user)!);
      const stillLegacy = decryptMasterKey(inner, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      expect(stillLegacy.equals(masterKey)).toBe(true);
      // …but the root minted before the failure is on disk (split-brain)
      const rootAfterFailure = readLocalRoot(org, user)!;

      // Next run with a healthy service completes the migration onto that root
      await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      expect(readLocalRoot(org, user)!.equals(rootAfterFailure)).toBe(true);
      const inner2 = innerOf(readMasterKey(org, user)!);
      const recovered = decryptMasterKey(inner2, deriveLocalInnerKey(rootAfterFailure), masterKeyAAD(user, org));
      expect(recovered.equals(masterKey)).toBe(true);
      expect(() => decryptMasterKey(inner2, deriveWrappingKey(user, org), masterKeyAAD(user, org))).toThrow();
    });

    it('concurrent wraps converge on a single root (no orphaned blob)', async () => {
      const org = 'org_race';
      const user = 'user_race';
      // Two concurrent wraps on a machine with no root yet, with skewed
      // network latency so the local.key writes and key.enc writes can
      // interleave across the wrapOuterLayer await. Whatever the
      // interleaving, the invariant is: the blob on disk opens under the
      // root on disk.
      const svc = (delayMs: number) => ({
        coDecrypt: mockKeyServiceOps().coDecrypt,
        wrapOuterLayer: async (_o: string, pt: string) => {
          await new Promise((r) => setTimeout(r, delayMs));
          return KMS_PREFIX + pt;
        },
      });
      await Promise.all([
        wrapAndSaveMasterKey(masterKey, org, user, svc(30)),
        wrapAndSaveMasterKey(masterKey, org, user, svc(0)),
      ]);

      const root = readLocalRoot(org, user)!;
      const inner = innerOf(readMasterKey(org, user)!);
      const recovered = decryptMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(user, org));
      expect(recovered.equals(masterKey)).toBe(true);
    });

    it('recovers from a corrupt local.key by minting a fresh root', async () => {
      const org = 'org_corrupt_root';
      const user = 'user_corrupt_root';
      // Plant a corrupt (truncated) local.key and a legacy blob
      const rootPath = getLocalRootPath(org, user);
      mkdirSync(dirname(rootPath), { recursive: true, mode: 0o700 });
      writeFileSync(rootPath, 'AAAA\n', { mode: 0o600 }); // 3 bytes — invalid
      const legacyInner = encryptMasterKey(masterKey, deriveWrappingKey(user, org), masterKeyAAD(user, org));
      saveMasterKey(org, KMS_PREFIX + legacyInner, user);

      const key = await resolveProjectKey(org, projectId, user, mockKeyServiceOps());
      expect(key).toBe(deriveProjectKey(masterKey, projectId, org));

      // A real 32-byte root replaced the corrupt file and keys the new blob —
      // never a zero-length/weak root
      const root = readLocalRoot(org, user)!;
      expect(root.length).toBe(32);
      const inner = innerOf(readMasterKey(org, user)!);
      const recovered = decryptMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(user, org));
      expect(recovered.equals(masterKey)).toBe(true);
    });

    it('seed-phrase resolution never touches K_local', () => {
      const org = 'org_seed_nr';
      const fromSeed = resolveFromSeedPhrase(seedPhrase, org, projectId);
      expect(fromSeed).toBe(deriveProjectKey(masterKey, projectId, org));
      expect(hasLocalRoot(org, userId)).toBe(false);
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
