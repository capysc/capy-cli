import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock homedir to use a temp directory
const tempHome = mkdtempSync(join(tmpdir(), 'capy-stability-test-'));
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tempHome,
}));

import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  deriveProjectKey,
  encryptMasterKey,
  decryptMasterKey,
  deriveWrappingKey,
} from '../../src/crypto/keyManager';
import { saveMasterKey } from '../../src/config/globalConfig';
import { resolveProjectKey, resolveFromSeedPhrase } from '../../src/crypto/keyResolver';

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('Key stability across sessions', () => {
  const seedPhrase = generateSeedPhrase();
  const masterKey = seedPhraseToMasterKey(seedPhrase);
  const orgId = 'org_stability';
  const projectId = 'proj_stability';
  const userId = 'user_123';

  // Setup: wrap M with stable identity and save to disk
  beforeAll(() => {
    const wrappingKey = deriveWrappingKey(userId, orgId);
    const encryptedM = encryptMasterKey(masterKey, wrappingKey);
    saveMasterKey(orgId, encryptedM);
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
