/**
 * Inner encryption for a Keep-hosted secret edit. The session key is derived
 * from this machine's existing K_local and a per-flow secret; neither key
 * material crosses the connection broker.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const SESSION_KEY_INFO = 'capy/secret-edit';
const SESSION_KEY_LENGTH = 32;
const LOCAL_ROOT_BYTES = 32;
const FLOW_SECRET_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function decodeFlowSecret(flowSecretB64: string): Buffer {
  const decoded = Buffer.from(flowSecretB64, 'base64');
  if (decoded.length !== FLOW_SECRET_BYTES || decoded.toString('base64') !== flowSecretB64) {
    throw new Error('Secret-edit flow_secret must be canonical base64 for exactly 32 bytes.');
  }
  return decoded;
}

/**
 * `HKDF-SHA256(ikm = K_local, salt = flow_secret, info =
 * "capy/secret-edit", length = 32)`. `flow_secret` is base64 so it can be
 * carried in the broker request without ever transporting K_local.
 */
export function deriveEditSessionKey(kLocal: Buffer, flowSecretB64: string): Buffer {
  if (kLocal.length !== LOCAL_ROOT_BYTES) {
    throw new Error('Secret-edit K_local must be exactly 32 bytes.');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      kLocal,
      decodeFlowSecret(flowSecretB64),
      Buffer.from(SESSION_KEY_INFO, 'utf8'),
      SESSION_KEY_LENGTH,
    ),
  );
}

export interface SessionCiphertext {
  readonly iv: string;
  readonly ct: string;
}

/** Seal one value with a fresh IV and caller-supplied, canonical AAD. */
export function sealEditValue(key: Buffer, plaintext: string, aad: string): SessionCiphertext {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

/** Open one value, returning null for malformed or unauthenticated input. */
export function openEditValue(key: Buffer, sealed: SessionCiphertext, aad: string): string | null {
  try {
    const iv = Buffer.from(sealed.iv, 'base64');
    const combined = Buffer.from(sealed.ct, 'base64');
    if (iv.length !== GCM_IV_BYTES || combined.length < GCM_TAG_BYTES) return null;
    const authTag = combined.subarray(combined.length - GCM_TAG_BYTES);
    const ciphertext = combined.subarray(0, combined.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
