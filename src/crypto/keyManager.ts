import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  hkdfSync,
} from 'crypto';
import { BIP39_WORDLIST } from './bip39Words';

const PBKDF2_SALT = 'capy-mnemonic';
const PBKDF2_ITERATIONS = 2048;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha512';

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
 */
export function seedPhraseToMasterKey(phrase: string): Buffer {
  return pbkdf2Sync(
    phrase,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
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
 * Encrypts the master key M for storage on disk using AES-256-GCM.
 * The wrapping key is derived from the auth token (stepping stone until
 * service co-sign is implemented).
 *
 * Returns a base64 string: base64(iv || ciphertext || authTag)
 */
export function encryptMasterKey(
  masterKey: Buffer,
  wrappingKey: Buffer,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, wrappingKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(masterKey),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypts the master key M from its on-disk wrapped form.
 */
export function decryptMasterKey(
  encryptedBlob: string,
  wrappingKey: Buffer,
): Buffer {
  const combined = Buffer.from(encryptedBlob, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted master key blob too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, wrappingKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
}

/**
 * Derives a 32-byte wrapping key from stable user identity.
 * Uses userId + orgId so the wrapping key survives token rotation.
 * This is a stepping stone — will be replaced by service co-sign.
 */
export function deriveWrappingKey(userId: string, orgId: string): Buffer {
  return createHash('sha256').update(`${userId}:${orgId}`).digest();
}
