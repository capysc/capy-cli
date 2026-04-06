import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-stability-test-'));
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
let saveMasterKey: typeof import('../../src/config/globalConfig').saveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;
let resolveFromSeedPhrase: typeof import('../../src/crypto/keyResolver').resolveFromSeedPhrase;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  deriveProjectKey = km.deriveProjectKey;
  encryptMasterKey = km.encryptMasterKey;
  decryptMasterKey = km.decryptMasterKey;
  deriveWrappingKey = km.deriveWrappingKey;

  const gc = await import('../../src/config/globalConfig');
  saveMasterKey = gc.saveMasterKey;

  const kr = await import('../../src/crypto/keyResolver');
  resolveProjectKey = kr.resolveProjectKey;
  resolveFromSeedPhrase = kr.resolveFromSeedPhrase;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('Key stability across sessions', () => {
  let seedPhrase: string;
  let masterKey: Buffer;
  const orgId = 'org_stability';
  const projectId = 'proj_stability';
  const userId = 'user_123';

  // Setup: generate keys and wrap M with stable identity and save to disk
  beforeAll(() => {
    seedPhrase = generateSeedPhrase();
    masterKey = seedPhraseToMasterKey(seedPhrase);
    const wrappingKey = deriveWrappingKey(userId, orgId);
    const encryptedM = encryptMasterKey(masterKey, wrappingKey);
    saveMasterKey(orgId, encryptedM, userId);
  });

  it('Session 1: seed → M → project key', () => {
    // First session with token A
    const key = resolveProjectKey(orgId, projectId, userId);

    // Should match direct derivation
    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('Session 2: different token, same user → same project key', () => {
    // Clear the project key cache to force re-derivation from M
    const cachePath = join(tempHome, '.capy', 'orgs', orgId, 'projects', projectId, 'key.cache');
    try { rmSync(cachePath); } catch {}

    // Second session — same userId, wrapping key is stable
    const key = resolveProjectKey(orgId, projectId, userId);

    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('Sessionless: seed phrase alone → same project key', () => {
    // Offline recovery — no auth, no service, just the seed phrase
    const key = resolveFromSeedPhrase(seedPhrase, orgId, projectId);

    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('All three paths produce the same key', () => {
    // Clear cache again
    const cachePath = join(tempHome, '.capy', 'orgs', orgId, 'projects', projectId, 'key.cache');
    try { rmSync(cachePath); } catch {}

    const fromSession = resolveProjectKey(orgId, projectId, userId);
    const fromSeedPhrase = resolveFromSeedPhrase(seedPhrase, orgId, projectId);
    const fromDirect = deriveProjectKey(masterKey, projectId, orgId);

    expect(fromSession).toBe(fromSeedPhrase);
    expect(fromSeedPhrase).toBe(fromDirect);
  });

  it('Wrapping key is stable: same userId+orgId always unwraps M', () => {
    // Simulate multiple sessions with different access tokens but same identity
    const wrappingKey1 = deriveWrappingKey(userId, orgId);
    const wrappingKey2 = deriveWrappingKey(userId, orgId);

    expect(wrappingKey1.equals(wrappingKey2)).toBe(true);

    // Wrap and unwrap with same identity
    const encrypted = encryptMasterKey(masterKey, wrappingKey1);
    const decrypted = decryptMasterKey(encrypted, wrappingKey2);
    expect(decrypted.equals(masterKey)).toBe(true);
  });

  it('Different users cannot unwrap each other\'s master key', () => {
    const wrappingKeyA = deriveWrappingKey('user_A', orgId);
    const wrappingKeyB = deriveWrappingKey('user_B', orgId);

    const encrypted = encryptMasterKey(masterKey, wrappingKeyA);
    expect(() => decryptMasterKey(encrypted, wrappingKeyB)).toThrow();
  });
});
