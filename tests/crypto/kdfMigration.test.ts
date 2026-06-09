/**
 * KDF versioning + transparent migration.
 *
 * Capy upgraded the seed-phrase KDF from PBKDF2-2048/SHA-512 (v1, BIP-39
 * default) to PBKDF2-600k/SHA-256 (v2, OWASP). M's value is bound to the
 * version that created the org and must never change, so legacy (v1) orgs are
 * detected at the phrase→M boundaries by trial decryption rather than migrated.
 *
 * These tests prove:
 *  - v1 and v2 produce stable, distinct master keys (golden vectors guard
 *    against silent parameter drift that would lock owners out).
 *  - New derivations default to the current (v2) version.
 *  - An org created under v1 still decrypts under the new code (migration).
 *  - A new org under v2 decrypts.
 *  - The trial resolver picks the correct version and refuses a wrong phrase.
 */
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  deriveProjectKey,
  CURRENT_KDF_VERSION,
  KDF_VERSIONS,
} from '../../src/crypto/keyManager';
import {
  resolveProjectKeyByTrial,
  resolveFromSeedPhrase,
} from '../../src/crypto/keyResolver';
import { Encryptor } from '../../src/crypto/encryptor';

const orgId = 'org_migration';
const projectId = 'proj_migration';

describe('KDF versioning', () => {
  it('defaults to the current (strongest) version', () => {
    const phrase = generateSeedPhrase();
    expect(CURRENT_KDF_VERSION).toBe(2);
    expect(
      seedPhraseToMasterKey(phrase).equals(seedPhraseToMasterKey(phrase, 2)),
    ).toBe(true);
  });

  it('lists known versions newest-first for trial order', () => {
    expect([...KDF_VERSIONS]).toEqual([2, 1]);
  });

  it('produces distinct master keys per version for the same phrase', () => {
    const phrase = generateSeedPhrase();
    const v1 = seedPhraseToMasterKey(phrase, 1);
    const v2 = seedPhraseToMasterKey(phrase, 2);
    expect(v1.equals(v2)).toBe(false);
  });

  it('rejects an unknown version', () => {
    // @ts-expect-error — exercising the runtime guard with an invalid version
    expect(() => seedPhraseToMasterKey('whatever', 99)).toThrow(/Unknown KDF version/);
  });

  // Golden vectors: if PBKDF2 params drift, every existing owner's M changes and
  // they are locked out. A fixed input phrase pins the exact derivation. (The
  // phrase need not be checksum-valid — the KDF is just a string → bytes map.)
  describe('golden vectors (immutability)', () => {
    const phrase = Array(23).fill('abandon').join(' ') + ' about';

    it('v1 (PBKDF2-2048/SHA-512) is unchanged', () => {
      expect(seedPhraseToMasterKey(phrase, 1).toString('hex')).toBe(
        '8d00a0732c1596800933630041bc8fc90499b7ff6894ef4b71ba590c7a8053f3',
      );
    });

    it('v2 (PBKDF2-600k/SHA-256) is unchanged', () => {
      expect(seedPhraseToMasterKey(phrase, 2).toString('hex')).toBe(
        '9125acc57b0d256dbfc57efd8a23b07968e24a4210d8a472e65801dd45c34911',
      );
    });
  });
});

describe('transparent migration via trial resolution', () => {
  // Build a decryption oracle the way the live code does: a known ciphertext
  // encrypted under the org's real project key.
  function oracleFor(version: 1 | 2, phrase: string): {
    projectKey: string;
    verify: (pk: string) => boolean;
  } {
    const masterKey = seedPhraseToMasterKey(phrase, version);
    const projectKey = deriveProjectKey(masterKey, projectId, orgId);
    const ciphertext = Encryptor.encrypt('super-secret-value', projectKey);
    return { projectKey, verify: (pk: string) => Encryptor.canDecrypt(ciphertext, pk) };
  }

  it('legacy v1 org: new code detects v1 and decrypts (the migration case)', () => {
    const phrase = generateSeedPhrase();
    const { projectKey, verify } = oracleFor(1, phrase);

    const trial = resolveProjectKeyByTrial(phrase, orgId, projectId, verify);
    expect(trial).not.toBeNull();
    expect(trial!.version).toBe(1);
    expect(trial!.projectKey).toBe(projectKey);
  });

  it('new v2 org: trial detects v2 and decrypts', () => {
    const phrase = generateSeedPhrase();
    const { projectKey, verify } = oracleFor(2, phrase);

    const trial = resolveProjectKeyByTrial(phrase, orgId, projectId, verify);
    expect(trial).not.toBeNull();
    expect(trial!.version).toBe(2);
    expect(trial!.projectKey).toBe(projectKey);
  });

  it('a wrong phrase resolves to null (recover must not write a key)', () => {
    const realPhrase = generateSeedPhrase();
    let wrongPhrase = generateSeedPhrase();
    while (wrongPhrase === realPhrase) wrongPhrase = generateSeedPhrase();

    const { verify } = oracleFor(2, realPhrase);
    expect(resolveProjectKeyByTrial(wrongPhrase, orgId, projectId, verify)).toBeNull();
  });

  it('cross-version keys do not decrypt each other (versions are isolated)', () => {
    const phrase = generateSeedPhrase();
    const v1Key = deriveProjectKey(seedPhraseToMasterKey(phrase, 1), projectId, orgId);
    const v2Key = deriveProjectKey(seedPhraseToMasterKey(phrase, 2), projectId, orgId);

    const v1Ciphertext = Encryptor.encrypt('value', v1Key);
    const v2Ciphertext = Encryptor.encrypt('value', v2Key);

    expect(Encryptor.canDecrypt(v1Ciphertext, v2Key)).toBe(false);
    expect(Encryptor.canDecrypt(v2Ciphertext, v1Key)).toBe(false);
  });

  it('resolveFromSeedPhrase reproduces the per-version key explicitly', () => {
    const phrase = generateSeedPhrase();
    for (const version of KDF_VERSIONS) {
      const expected = deriveProjectKey(
        seedPhraseToMasterKey(phrase, version),
        projectId,
        orgId,
      );
      expect(resolveFromSeedPhrase(phrase, orgId, projectId, version)).toBe(expected);
    }
  });
});
