import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  hkdfSync,
} from 'crypto';
import { BIP39_WORDLIST } from './bip39Words';

// --- Seed-phrase KDF versions -------------------------------------------
//
// M is derived deterministically from the seed phrase with a FIXED salt: there
// is nowhere durable to keep a per-user salt that survives the recovery
// scenario (a full machine wipe, where only the 24 words remain — see
// recoverCommand). The KDF *version* selects the parameter set instead.
//
// New seed phrases derive M under CURRENT_KDF_VERSION. An existing org's M is
// bound to whatever version created it and must never change — that would
// re-key the whole org and lock everyone out — so legacy versions are detected
// at the phrase→M boundaries by trial decryption (see resolveProjectKeyByTrial),
// not migrated.
export type KdfVersion = 1 | 2;

// v1 — BIP-39 default. LEGACY: do not change these. Existing owners' M is
// PBKDF2(phrase, 'capy-mnemonic', 2048, sha512); altering any value re-keys
// their org. 2048 is low, but the input is a 24-word mnemonic (256-bit
// entropy), so this was never brute-forceable; v2 is defense-in-depth (OWASP
// compliance, and protection for partially-leaked / non-uniform phrases).
const PBKDF2_SALT = 'capy-mnemonic';
const PBKDF2_ITERATIONS = 2048;
const PBKDF2_DIGEST = 'sha512';

// v2 — OWASP 2023 guidance for PBKDF2-SHA256 (>=600k). Distinct salt so v2's M
// is cleanly separated from v1 for the same phrase. PBKDF2 (not Argon2id) keeps
// the standalone pkg binary free of native addons; a v3 = Argon2id is a
// one-case addition to seedPhraseToMasterKey when wanted.
const PBKDF2_V2_SALT = 'capy-mnemonic-v2';
const PBKDF2_V2_ITERATIONS = 600_000;
const PBKDF2_V2_DIGEST = 'sha256';

const PBKDF2_KEY_LENGTH = 32;

/** Strongest available KDF version. New seed phrases derive M under this. */
export const CURRENT_KDF_VERSION: KdfVersion = 2;

/** All known KDF versions, in trial order (newest first). */
export const KDF_VERSIONS: readonly KdfVersion[] = [2, 1];

// Local-only mode: the passphrase that locks M at rest is low-entropy
// (human-chosen), so it gets a much higher work factor + per-keystore random
// salt — distinct from the seed-phrase derivation above, which has a fixed
// salt because its input (a 24-word mnemonic) is already 256-bit entropy.
const LOCAL_PBKDF2_ITERATIONS = 200_000;
const LOCAL_PBKDF2_DIGEST = 'sha256';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Generates a 24-word BIP-39 mnemonic seed phrase from 256 bits of entropy.
 *
 * Algorithm:
 * 1. Generate 256 bits (32 bytes) of cryptographically secure random data
 * 2. Compute SHA-256 checksum of the entropy
 * 3. Append first 8 bits of checksum to entropy (264 bits total)
 * 4. Split into 24 groups of 11 bits each
 * 5. Map each 11-bit value (0-2047) to a word in the BIP-39 wordlist
 */
export function generateSeedPhrase(): string {
  const entropy = randomBytes(32); // 256 bits
  const checksum = createHash('sha256').update(entropy).digest();

  // Combine entropy + first byte of checksum into a bit string
  const bits: number[] = [];
  for (const byte of entropy) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }
  // Append 8 checksum bits (256 bits entropy / 32 = 8 checksum bits)
  for (let i = 7; i >= 0; i--) {
    bits.push((checksum[0] >> i) & 1);
  }

  // Split into 24 groups of 11 bits
  const words: string[] = [];
  for (let i = 0; i < 24; i++) {
    let index = 0;
    for (let j = 0; j < 11; j++) {
      index = (index << 1) | bits[i * 11 + j];
    }
    words.push(BIP39_WORDLIST[index]);
  }

  return words.join(' ');
}

/**
 * Validates that a seed phrase is a valid 24-word BIP-39 mnemonic.
 */
export function validateSeedPhrase(phrase: string): boolean {
  const words = phrase.trim().split(/\s+/);
  if (words.length !== 24) return false;

  // Check all words are in wordlist
  const indices: number[] = [];
  for (const word of words) {
    const idx = BIP39_WORDLIST.indexOf(word);
    if (idx === -1) return false;
    indices.push(idx);
  }

  // Reconstruct bits and verify checksum
  const bits: number[] = [];
  for (const idx of indices) {
    for (let i = 10; i >= 0; i--) {
      bits.push((idx >> i) & 1);
    }
  }

  // First 256 bits are entropy, last 8 are checksum
  const entropyBytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i * 8 + j];
    }
    entropyBytes[i] = byte;
  }

  const checksum = createHash('sha256').update(entropyBytes).digest();
  let checksumByte = 0;
  for (let j = 0; j < 8; j++) {
    checksumByte = (checksumByte << 1) | bits[256 + j];
  }

  return checksumByte === checksum[0];
}

/**
 * Derives a 256-bit master key M from a BIP-39 seed phrase using PBKDF2.
 *
 * `version` selects the parameter set. Defaults to CURRENT_KDF_VERSION so fresh
 * derivations (new orgs / local setups) use the strongest KDF. Pass an explicit
 * version to reproduce a legacy org's M (e.g. during trial resolution).
 */
export function seedPhraseToMasterKey(
  phrase: string,
  version: KdfVersion = CURRENT_KDF_VERSION,
): Buffer {
  const [salt, iterations, digest] =
    version === 1 ? [PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_DIGEST] :
    version === 2 ? [PBKDF2_V2_SALT, PBKDF2_V2_ITERATIONS, PBKDF2_V2_DIGEST] :
    [null, null, null];
  if (salt === null) throw new Error(`Unknown KDF version: ${version}`);
  return pbkdf2Sync(phrase, salt, iterations, PBKDF2_KEY_LENGTH, digest);
}

/**
 * Derives a project-scoped encryption key from the master key using HKDF.
 * Returns a 32-byte key as a hex string (compatible with Encryptor).
 */
export function deriveProjectKey(
  masterKey: Buffer,
  projectId: string,
  orgId: string,
): string {
  const derived = hkdfSync(
    'sha256',
    masterKey,
    orgId,                          // salt: org-scoped
    `capy:project:${projectId}`,    // info: project-scoped
    32,                              // 256-bit key
  );
  return Buffer.from(derived).toString('hex');
}

/**
 * AAD binding the org master-key wrapping to its (user, org) context, so a
 * wrapped blob cannot be verified/substituted under a different user or org.
 * Mirrors the context already in deriveWrappingKey; the version tag leaves room
 * to rotate the binding later.
 */
export function masterKeyAAD(userId: string, orgId: string): Buffer {
  return Buffer.from(`capy:masterkey:v1:${userId}:${orgId}`, 'utf8');
}

/**
 * AAD for the passphrase-wrapped local-mode keystore. A fixed domain tag (the
 * local keystore has no user/org) that separates local blobs from org-wrapped
 * ones: an org blob won't verify under the local AAD, and vice versa.
 */
export const LOCAL_MASTER_KEY_AAD = Buffer.from('capy:local-masterkey:v1', 'utf8');

/**
 * Encrypts the master key M for storage on disk using AES-256-GCM.
 *
 * `aad` binds the ciphertext to its operational context (see masterKeyAAD /
 * LOCAL_MASTER_KEY_AAD). It is optional so older call sites keep compiling, but
 * every new write should pass it.
 *
 * Returns a base64 string: base64(iv || ciphertext || authTag)
 */
export function encryptMasterKey(
  masterKey: Buffer,
  wrappingKey: Buffer,
  aad?: Buffer,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, wrappingKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(masterKey),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

function gcmDecryptMasterKey(combined: Buffer, wrappingKey: Buffer, aad?: Buffer): Buffer {
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, wrappingKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
}

/**
 * Decrypts the master key M from its on-disk wrapped form.
 *
 * When `aad` is supplied, we verify against it first, then fall back to a
 * no-AAD decrypt for blobs written before AAD binding existed — a transparent
 * grandfather (those legacy blobs just aren't context-bound). A blob written
 * WITH one AAD never verifies under a different AAD: the wrong-AAD attempt fails
 * the GCM tag and the no-AAD fallback fails too, so cross-context substitution
 * is rejected. Only genuinely AAD-less blobs reach the fallback.
 */
export function decryptMasterKey(
  encryptedBlob: string,
  wrappingKey: Buffer,
  aad?: Buffer,
): Buffer {
  const combined = Buffer.from(encryptedBlob, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted master key blob too short');
  }

  if (aad) {
    try {
      return gcmDecryptMasterKey(combined, wrappingKey, aad);
    } catch {
      // Legacy blob written without AAD — grandfather it (not context-bound).
    }
  }
  return gcmDecryptMasterKey(combined, wrappingKey, undefined);
}

/**
 * LEGACY inner wrapping key for the master key M — kept ONLY so existing
 * blobs can be unwrapped once and migrated. Do not key new writes with this.
 *
 * Both inputs are public identifiers the service knows, so the service could
 * recompute this key and recover M from the co-decrypt output it handles.
 * New writes use HKDF(K_local) instead (crypto/localKeyRoot.ts) — a
 * per-machine secret the service never sees. keyResolver.unwrapMasterKey
 * transparently re-wraps any blob still keyed by this onto K_local.
 */
export function deriveWrappingKey(userId: string, orgId: string): Buffer {
  return createHash('sha256').update(`${userId}:${orgId}`).digest();
}

/**
 * Derives the wrapping key that encrypts M at rest in local-only mode, from a
 * user-chosen passphrase + a per-keystore random salt. Unlike the seed-phrase
 * derivation, the input is low-entropy so this uses a high iteration count.
 */
export function deriveLocalWrappingKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(
    passphrase,
    salt,
    LOCAL_PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    LOCAL_PBKDF2_DIGEST,
  );
}

/** Iteration count baked into local keystore records (for forward-compat). */
export const LOCAL_KEY_ITERATIONS = LOCAL_PBKDF2_ITERATIONS;
