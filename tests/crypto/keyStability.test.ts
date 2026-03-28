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
  deriveWrappingKey,
} from '../../src/crypto/keyManager';
import { saveMasterKey } from '../../src/config/globalConfig';
import { resolveProjectKey, resolveFromSeedPhrase } from '../../src/crypto/keyResolver';

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

/**
 * These tests validate the three key derivation scenarios:
 *
 * Session 1: seed phrase → master key + session key → decryption key
 * Session 2: seed phrase → master key + session 2 key → SAME decryption key
 * Sessionless: seed phrase → master key + seed phrase key → SAME decryption key
 */
describe('Key stability across sessions', () => {
  const seedPhrase = generateSeedPhrase();
  const masterKey = seedPhraseToMasterKey(seedPhrase);
  const userId = 'user_01KMGM4ZRTEG87WDHRB207GC8M';
  const orgId = 'org_01KMR6JZKDTRAZ6X6QNBT97SDH';
  const projectId = 'proj_01KMRDWDFV5W5ZP63T08E61430';

  // Setup: wrap M with the user's stable identity and save it
  beforeAll(() => {
    const wrappingKey = deriveWrappingKey(userId, orgId);
    const encryptedM = encryptMasterKey(masterKey, wrappingKey);
    saveMasterKey(orgId, encryptedM);
  });

  it('Session 1: resolves the correct project key', () => {
    const key = resolveProjectKey(orgId, projectId, userId);
    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('Session 2: same user gets the same project key (token changed)', () => {
    // The access token changed (new session), but userId + orgId are the same.
    // This must produce the exact same project key.
    const key = resolveProjectKey(orgId, projectId, userId);
    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('Sessionless (seed phrase recovery): same project key without auth', () => {
    // Owner recovers using seed phrase alone — no auth, no service.
    const key = resolveFromSeedPhrase(seedPhrase, orgId, projectId);
    const expected = deriveProjectKey(masterKey, projectId, orgId);
    expect(key).toBe(expected);
  });

  it('All three paths produce identical keys', () => {
    const fromSession = resolveProjectKey(orgId, projectId, userId);
    const fromSeedPhrase = resolveFromSeedPhrase(seedPhrase, orgId, projectId);
    const fromDirect = deriveProjectKey(masterKey, projectId, orgId);

    expect(fromSession).toBe(fromDirect);
    expect(fromSeedPhrase).toBe(fromDirect);
    expect(fromSession).toBe(fromSeedPhrase);
  });

  it('Different project gets a different key (same org, same user)', () => {
    const keyA = resolveProjectKey(orgId, projectId, userId);
    const keyB = resolveProjectKey(orgId, 'proj_other', userId);
    expect(keyA).not.toBe(keyB);
  });

  it('Different org gets a different key (same project name, same user)', () => {
    // Setup a second org
    const org2 = 'org_different';
    const wrappingKey2 = deriveWrappingKey(userId, org2);
    const encryptedM2 = encryptMasterKey(masterKey, wrappingKey2);
    saveMasterKey(org2, encryptedM2);

    const keyOrg1 = resolveProjectKey(orgId, projectId, userId);
    const keyOrg2 = resolveProjectKey(org2, projectId, userId);
    expect(keyOrg1).not.toBe(keyOrg2);
  });
});
