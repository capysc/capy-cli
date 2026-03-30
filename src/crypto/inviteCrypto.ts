import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from 'crypto';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const TOKEN_LENGTH = 32;

/**
 * Generates a random 32-byte invite token T.
 */
export function generateInviteToken(): Buffer {
  return randomBytes(TOKEN_LENGTH);
}

/**
 * Derives the inner wrapping key from token T and orgId.
 * Uses HKDF-SHA256 with orgId as salt and "capy:invite" as info.
 */
export function deriveInnerKey(token: Buffer, orgId: string): Buffer {
  const derived = hkdfSync('sha256', token, orgId, 'capy:invite', 32);
  return Buffer.from(derived);
}

/**
 * Encrypts data with AES-256-GCM. Returns base64(iv + ciphertext + authTag).
 */
function aesEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypts AES-256-GCM data. Input is base64(iv + ciphertext + authTag).
 */
function aesDecrypt(blob: string, key: Buffer): Buffer {
  const combined = Buffer.from(blob, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted blob too short');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Double-wraps the master key M.
 * Inner layer: AES-256-GCM with HKDF(T, salt=orgId, info="capy:invite")
 * Outer layer: provided by the service via KMS (caller handles this)
 *
 * Returns the inner-wrapped blob (base64). Caller must then request
 * the service to wrap the outer layer.
 */
export function innerWrap(masterKey: Buffer, token: Buffer, orgId: string): string {
  const innerKey = deriveInnerKey(token, orgId);
  return aesEncrypt(masterKey, innerKey);
}

/**
 * Strips the inner layer using token T.
 * Input is the inner-wrapped blob (after service stripped outer layer).
 * Returns the master key M.
 */
export function innerUnwrap(innerBlob: string, token: Buffer, orgId: string): Buffer {
  const innerKey = deriveInnerKey(token, orgId);
  return aesDecrypt(innerBlob, innerKey);
}

/**
 * Constructs the redeem code: base64(T + outerWrappedBlob)
 * T is 32 bytes, the rest is the double-wrapped ciphertext.
 */
export function buildRedeemCode(token: Buffer, outerWrappedBlob: string): string {
  const outerBuf = Buffer.from(outerWrappedBlob, 'base64');
  return Buffer.concat([token, outerBuf]).toString('base64');
}

/**
 * Parses a redeem code back into T and the outer-wrapped ciphertext.
 */
export function parseRedeemCode(redeemCode: string): { token: Buffer; ciphertext: string } {
  const buf = Buffer.from(redeemCode, 'base64');
  if (buf.length <= TOKEN_LENGTH) {
    throw new Error('Invalid redeem code: too short');
  }
  const token = buf.subarray(0, TOKEN_LENGTH);
  const ciphertext = buf.subarray(TOKEN_LENGTH).toString('base64');
  return { token, ciphertext };
}
