/**
 * `capy pair` envelope (CAP-684, docs/basic-pair.md).
 *
 * Direction is the opposite of transportCrypto.ts: Keep (a browser, WebCrypto)
 * is the SENDER here, sealing every entry it holds for the logged-in user to
 * the CLI's one-time P-256 public key. The CLI is the RECEIVER — it is the
 * one that generated that key pair in step 1 of `capy pair`, and this module
 * is how it opens what comes back from `/device-pairings/pickup`.
 *
 * Key agreement: ephemeral P-256 ECDH (Keep generates a fresh ephemeral pair
 * per seal; `epk` is its raw uncompressed public key) → HKDF-SHA256(shared
 * secret, salt = empty, info = "capy:pair:v1") → AES-256-GCM key. AAD is the
 * same info string. This has to interop byte-for-byte with a real browser's
 * `crypto.subtle` (ECDH deriveBits + HKDF deriveKey + AES-GCM encrypt) — see
 * tests/crypto/pairCrypto.test.ts, which seals with node:crypto's own
 * `webcrypto` (a WebCrypto implementation, standing in for the browser) and
 * opens with the functions below.
 *
 * Node's ECDH `computeSecret()` and WebCrypto's ECDH `deriveBits()` both
 * return the raw X-coordinate of the shared point (no further hashing) —
 * that's what makes them interchangeable inputs to the same HKDF step.
 */
import { createECDH, createDecipheriv, hkdfSync, type ECDH } from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { PairingPayload } from './pairingPayload';

export interface PairEnvelope {
  v: 1;
  /** Sender's ephemeral P-256 public key, raw uncompressed point, base64url. */
  epk: string;
  /** 12-byte random IV, base64url. */
  iv: string;
  /** ciphertext with the 16-byte GCM tag appended, base64url. */
  ct: string;
}

const CURVE = 'prime256v1'; // P-256
const AES_ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;
const HKDF_INFO = 'capy:pair:v1';
const HKDF_SALT = Buffer.alloc(0);

export const PAIR_AAD = Buffer.from('capy:pair:v1', 'utf8');

export interface PairKeyPair {
  /** Keep this for the lifetime of one `capy pair` attempt — never persisted. */
  ecdh: ECDH;
  /** Raw uncompressed public key, base64url — what goes over `POST /auth/device/authorize`. */
  publicKey: string;
}

/** Mints the CLI's one-time P-256 key pair for a single `capy pair` attempt. */
export function generatePairKeyPair(): PairKeyPair {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { ecdh, publicKey: ecdh.getPublicKey().toString('base64url') };
}

/** HKDF-SHA256(sharedSecret, salt="", info="capy:pair:v1") → 32-byte AES key. Exported for the known-answer test. */
export function deriveHkdfKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, 32));
}

/**
 * Opens a pair envelope with the CLI's own key pair (from
 * {@link generatePairKeyPair}). Throws `DECRYPT_KEY_MISMATCH` on a wrong
 * peer key or a tampered envelope.
 */
export function openPairEnvelope(envelope: PairEnvelope, keyPair: PairKeyPair): PairingPayload {
  if (envelope.v !== 1) {
    throw new CapyError('Unsupported pair envelope version', ERROR_CODES.INVALID_FORMAT, { v: envelope.v });
  }
  const epk = Buffer.from(envelope.epk, 'base64url');
  const iv = Buffer.from(envelope.iv, 'base64url');
  const combined = Buffer.from(envelope.ct, 'base64url');
  if (combined.length < AUTH_TAG_LENGTH) {
    throw new CapyError('Pair envelope ciphertext too short', ERROR_CODES.INVALID_FORMAT);
  }
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  try {
    const sharedSecret = keyPair.ecdh.computeSecret(epk);
    const aesKey = deriveHkdfKey(sharedSecret);
    const decipher = createDecipheriv(AES_ALGORITHM, aesKey, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(PAIR_AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as PairingPayload;
  } catch {
    throw new CapyError(
      'Could not open pair envelope — wrong device key or tampered ciphertext',
      ERROR_CODES.DECRYPT_KEY_MISMATCH,
    );
  }
}
