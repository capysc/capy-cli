/**
 * CAP-540 — the secret-edit VALUE layer, CLI side (v1). The exact Node
 * mirror of keep-app's `src/lib/editSession/crypto.ts` — both sides MUST
 * derive byte-identical keys and produce/consume byte-identical ciphertext
 * or every decrypt in this flow fails closed (`bad_session`).
 *
 * This is a SEPARATE layer from the broker's own E2E envelope
 * (`brokerEnvelope.ts`), which is unchanged and still carries every message
 * in this flow. This is the INNER layer the FROZEN session-envelope
 * contract (CAP-540) adds: current/edited variable VALUES are additionally
 * sealed under a session key derived from the person's own passkey/
 * passphrase PRF evaluation, so they stay opaque even to a compromised page
 * session until the person actually unlocks.
 *
 * SECURITY NOTE: this module derives a key from a RAW PRF output the CLI has
 * already VERIFIED (via `runGrantCeremony`'s KEK-derivation + AEAD unwrap
 * against the person's own enrolled wrapper — see `secretEditScreen.ts`)
 * proves genuine device-key/passphrase possession. Deriving a session key
 * from an unverified PRF output would let anyone who can attach to the
 * `unlock` broker connection (i.e. anyone signed in to keep-app as this
 * exact user, even from a stolen session with no physical device) courier
 * arbitrary bytes and have real secret values sealed under a key only they
 * know — the CLI-side verification step is what actually gates the reveal,
 * not this derivation.
 *
 * This is a DIFFERENT derivation from the device-key KEK
 * (`auth/deviceKey/crypto.ts`'s `deriveDeviceKeyKek`, info
 * `capy:device-key:kek:v1`) — a dedicated info string
 * (`capy:edit:session:v1`) deliberately keeps the two derivations
 * incompatible even given the same PRF output and connection id.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const SESSION_KEY_INFO = 'capy:edit:session:v1';
const SESSION_KEY_LENGTH = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Derive the per-connection session key from the couriered PRF output.
 * `HKDF(ikm = prfOutput, salt = connectionId, info =
 * "capy:edit:session:v1", length = 32)` — connection-bound, mirroring
 * keep-app's `deriveEditSessionKey` exactly.
 */
export function deriveEditSessionKey(prfOutput: Buffer, connectionId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      prfOutput,
      Buffer.from(connectionId, 'utf8'),
      Buffer.from(SESSION_KEY_INFO, 'utf8'),
      SESSION_KEY_LENGTH,
    ),
  );
}

export interface SessionCiphertext {
  iv: string;
  ct: string;
}

/** Seal one plaintext value under the session key. A fresh random 12-byte
 *  IV per call. */
export function sealEditValue(key: Buffer, plaintext: string): SessionCiphertext {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

/**
 * Open one sealed value. Returns `null` on any AEAD authentication or shape
 * failure (wrong session key, tampered bytes, malformed base64) — callers
 * surface that as the coded `bad_session`. Never throws.
 */
export function openEditValue(key: Buffer, sealed: SessionCiphertext): string | null {
  try {
    const iv = Buffer.from(sealed.iv, 'base64');
    const combined = Buffer.from(sealed.ct, 'base64');
    if (iv.length !== GCM_IV_BYTES || combined.length < GCM_TAG_BYTES) return null;
    const authTag = combined.subarray(combined.length - GCM_TAG_BYTES);
    const ciphertext = combined.subarray(0, combined.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
