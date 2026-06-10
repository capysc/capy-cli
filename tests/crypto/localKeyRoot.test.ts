import { describe, it, expect } from 'bun:test';
import { createHash } from 'crypto';
import {
  generateLocalRoot,
  deriveEpochInnerKey,
  deriveDeviceInnerKey,
} from '../../src/crypto/localKeyRoot';
import { encryptMasterKey, decryptMasterKey } from '../../src/crypto/keyManager';
import { generateEpochKey } from '../../src/crypto/epochCrypto';

describe('K_local generation', () => {
  it('is 32 random bytes', () => {
    expect(generateLocalRoot()).toHaveLength(32);
    expect(generateLocalRoot().equals(generateLocalRoot())).toBe(false);
  });
});

describe('inner key derivation', () => {
  it('epoch and device inner keys are distinct and 32 bytes', () => {
    const k = generateLocalRoot();
    const epochKey = deriveEpochInnerKey(k);
    const deviceKey = deriveDeviceInnerKey(k);
    expect(epochKey).toHaveLength(32);
    expect(deviceKey).toHaveLength(32);
    expect(epochKey.equals(deviceKey)).toBe(false);
  });

  it('derivation is deterministic for a given K_local', () => {
    const k = generateLocalRoot();
    expect(deriveEpochInnerKey(k).equals(deriveEpochInnerKey(k))).toBe(true);
  });

  it('different K_local yields different inner keys', () => {
    expect(deriveEpochInnerKey(generateLocalRoot()).equals(deriveEpochInnerKey(generateLocalRoot()))).toBe(false);
  });
});

describe('regression guard: inner key NOT derivable from public identifiers', () => {
  // The whole point of K_local: SHA256(userId:orgId) — what the legacy wrap
  // used — must NOT unwrap a K_local-wrapped blob. This is the canonical guard
  // for the flaw that motivated CAP-58's amendment.
  it('a K_local-wrapped epoch key does not open with SHA256(userId:orgId)', () => {
    const userId = 'user_1';
    const orgId = 'org_1';
    const kLocal = generateLocalRoot();
    const epochKey = generateEpochKey();

    const innerKey = deriveEpochInnerKey(kLocal);
    const wrapped = encryptMasterKey(epochKey, innerKey);

    // The publicly-computable legacy key must fail.
    const legacyKey = createHash('sha256').update(`${userId}:${orgId}`).digest();
    expect(() => decryptMasterKey(wrapped, legacyKey)).toThrow();

    // The genuine K_local-derived key works.
    expect(decryptMasterKey(wrapped, innerKey).equals(epochKey)).toBe(true);
  });
});

describe('service-view blindness', () => {
  // Everything the service ever sees on the inner-wrap path: the KMS-stripped
  // inner blob, the userId, and the orgId. None of it, alone or combined,
  // recovers the wrapped key — because the inner key is HKDF(K_local) and
  // K_local never leaves the machine.
  it('inner blob + userId + orgId cannot recover the wrapped key', () => {
    const userId = 'user_42';
    const orgId = 'org_42';
    const kLocal = generateLocalRoot(); // the service NEVER sees this
    const epochKey = generateEpochKey();
    const wrapped = encryptMasterKey(epochKey, deriveEpochInnerKey(kLocal));

    // Candidate keys the service could try from public material:
    const candidates = [
      createHash('sha256').update(`${userId}:${orgId}`).digest(),
      createHash('sha256').update(`${orgId}:${userId}`).digest(),
      createHash('sha256').update(orgId).digest(),
      createHash('sha256').update(userId).digest(),
      Buffer.alloc(32),
    ];
    for (const key of candidates) {
      expect(() => decryptMasterKey(wrapped, key)).toThrow();
    }
  });
});
