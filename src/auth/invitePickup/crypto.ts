/**
 * Pickup-wrap crypto (CAP-529, docs/invite-pickup-flow.md §3.6).
 *
 *   KEK_pickup = HKDF-SHA256(prfOutput, prf_salt, "capy:invite-pickup:kek:v1")
 *   AAD_pickup = "capy:invite-pickup:v1:${userId}:${inviteId}:${credentialId}"
 *   wrapped_t  = AES-256-GCM(T, KEK_pickup, iv, AAD_pickup)
 *
 * The `info` string is deliberately distinct from the door KEK's
 * `capy:device-key:kek:v1` (src/auth/deviceKey/crypto.ts) — a pickup blob and
 * a door blob are not interchangeable even if their bytes were moved between
 * tables, because both the KEK and the AAD differ. This module wraps/unwraps
 * T only; it never touches K_local or M. `inviteCrypto.ts`'s `aesEncrypt` /
 * `aesDecrypt` are deliberately not reused here — those are AAD-less by
 * design (their own docblock explains why), and the pickup wrap needs AAD to
 * bind a blob to its user, invite and credential. This mirrors
 * `deviceKey/crypto.ts`'s `wrapKLocal`/`unwrapKLocal` shape instead.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { CapyError, ERROR_CODES } from '../../types/index';

const KEK_PICKUP_INFO = 'capy:invite-pickup:kek:v1';
const KEK_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** KEK_pickup = HKDF-SHA256(prfOutput, prf_salt, "capy:invite-pickup:kek:v1", 32). */
export function deriveKekPickup(prfOutput: Buffer, prfSalt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', prfOutput, prfSalt, KEK_PICKUP_INFO, KEK_LENGTH));
}

/** AAD binding a wrapped T to its user, invite and credential. */
export function pickupWrapAAD(userId: string, inviteId: string, credentialId: string): Buffer {
  return Buffer.from(`capy:invite-pickup:v1:${userId}:${inviteId}:${credentialId}`, 'utf8');
}

export interface WrappedT {
  /** base64(ciphertext || authTag). */
  wrappedT: string;
  /** base64, 12 bytes. */
  iv: string;
}

/** Wraps T under KEK_pickup for upload by the Keep page (§3.6). CLI-side only for tests/mint symmetry — the page performs this in JS, not this module. */
export function wrapPickupT(token: Buffer, kek: Buffer, aad: Buffer): WrappedT {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(token), cipher.final(), cipher.getAuthTag()]);
  return { wrappedT: ciphertext.toString('base64'), iv: iv.toString('base64') };
}

/**
 * Unwraps a pickup row's `wrapped_t` back to T. Fails CLOSED with a typed
 * error on any GCM auth failure (wrong PRF output, wrong credential, tampered
 * AAD) — callers must never fall through to treating a failure as "no T".
 */
export function unwrapPickupT(wrappedT: string, iv: string, kek: Buffer, aad: Buffer): Buffer {
  const ivBuf = Buffer.from(iv, 'base64');
  const combined = Buffer.from(wrappedT, 'base64');
  if (ivBuf.length !== IV_LENGTH || combined.length < AUTH_TAG_LENGTH) {
    throw new CapyError(
      'This invite pickup record is malformed.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'malformed_pickup_record' },
    );
  }
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CapyError(
      'This invite pickup could not be unlocked.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'pickup_gcm_auth_failed' },
    );
  }
}
