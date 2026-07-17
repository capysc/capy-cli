/**
 * AAD binding on the master-key AEAD wrapping (CAP-57).
 *
 * encryptMasterKey/decryptMasterKey now bind Additional Authenticated Data so a
 * wrapped blob can't be verified under a different (user, org) or moved between
 * the org and local-only keystores. Existing blobs written before AAD existed
 * must keep working (transparent grandfather).
 *
 * Proves: round-trip under AAD; altered AAD fails; cross-context substitution
 * fails; org⇄local domain separation; legacy no-AAD blobs still decrypt; and a
 * new AAD-bound blob does NOT decrypt when the reader forgets the AAD (the
 * contract that obliges every reader to pass it).
 */
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  encryptMasterKey,
  decryptMasterKey,
  deriveWrappingKey,
  masterKeyAAD,
  LOCAL_MASTER_KEY_AAD,
} from '../../src/crypto/keyManager';

const orgId = 'org_aad';
const userId = 'user_aad';

function freshMasterKey(): Buffer {
  return seedPhraseToMasterKey(generateSeedPhrase());
}

describe('masterKeyAAD', () => {
  it('is deterministic and distinct per (user, org)', () => {
    expect(masterKeyAAD(userId, orgId).equals(masterKeyAAD(userId, orgId))).toBe(true);
    expect(masterKeyAAD('a', orgId).equals(masterKeyAAD('b', orgId))).toBe(false);
    expect(masterKeyAAD(userId, 'x').equals(masterKeyAAD(userId, 'y'))).toBe(false);
  });
});

describe('encryptMasterKey / decryptMasterKey — AAD binding', () => {
  it('round-trips when the same AAD is supplied', () => {
    const m = freshMasterKey();
    const key = deriveWrappingKey(userId, orgId);
    const aad = masterKeyAAD(userId, orgId);

    const blob = encryptMasterKey(m, key, aad);
    expect(decryptMasterKey(blob, key, aad).equals(m)).toBe(true);
  });

  it('fails when the AAD is altered between encrypt and decrypt', () => {
    const m = freshMasterKey();
    const key = deriveWrappingKey(userId, orgId);

    const blob = encryptMasterKey(m, key, masterKeyAAD(userId, orgId));
    // Same key, different context AAD → tag mismatch, no legacy fallback succeeds.
    expect(() => decryptMasterKey(blob, key, masterKeyAAD('attacker', orgId))).toThrow();
  });

  it('rejects cross-context substitution (different user in same org)', () => {
    const m = freshMasterKey();
    const keyA = deriveWrappingKey('userA', orgId);
    const blob = encryptMasterKey(m, keyA, masterKeyAAD('userA', orgId));

    const keyB = deriveWrappingKey('userB', orgId);
    expect(() => decryptMasterKey(blob, keyB, masterKeyAAD('userB', orgId))).toThrow();
  });

  it('separates org and local keystores by domain (same key, different AAD)', () => {
    const m = freshMasterKey();
    const key = deriveWrappingKey(userId, orgId);

    const orgBlob = encryptMasterKey(m, key, masterKeyAAD(userId, orgId));
    expect(() => decryptMasterKey(orgBlob, key, LOCAL_MASTER_KEY_AAD)).toThrow();

    const localBlob = encryptMasterKey(m, key, LOCAL_MASTER_KEY_AAD);
    expect(() => decryptMasterKey(localBlob, key, masterKeyAAD(userId, orgId))).toThrow();
  });

  it('grandfathers legacy blobs written without AAD', () => {
    const m = freshMasterKey();
    const key = deriveWrappingKey(userId, orgId);

    // Legacy write: no AAD (how every existing key.enc was produced).
    const legacyBlob = encryptMasterKey(m, key);

    // New reader passes AAD; the with-AAD attempt fails, the no-AAD fallback wins.
    expect(decryptMasterKey(legacyBlob, key, masterKeyAAD(userId, orgId)).equals(m)).toBe(true);
    // And a reader that passes no AAD still works too.
    expect(decryptMasterKey(legacyBlob, key).equals(m)).toBe(true);
  });

  it('an AAD-bound blob does NOT decrypt when the reader omits the AAD', () => {
    const m = freshMasterKey();
    const key = deriveWrappingKey(userId, orgId);

    const blob = encryptMasterKey(m, key, masterKeyAAD(userId, orgId));
    // No fallback can rescue this — the contract is that readers must pass AAD.
    expect(() => decryptMasterKey(blob, key)).toThrow();
  });

  it('still fails on a wrong wrapping key regardless of AAD', () => {
    const m = freshMasterKey();
    const blob = encryptMasterKey(m, deriveWrappingKey(userId, orgId), masterKeyAAD(userId, orgId));
    const wrongKey = deriveWrappingKey('someone-else', orgId);
    expect(() => decryptMasterKey(blob, wrongKey, masterKeyAAD(userId, orgId))).toThrow();
  });
});
