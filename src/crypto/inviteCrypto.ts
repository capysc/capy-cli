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
 * Derives a 32-byte inner wrapping key via HKDF-SHA256.
 * Parameterized so both invite and deploy flows can reuse it.
 */
export function deriveInnerKey(token: Buffer, salt: string, info: string): Buffer {
  const derived = hkdfSync('sha256', token, salt, info, 32);
  return Buffer.from(derived);
}

/**
 * Encrypts data with AES-256-GCM. Returns base64(iv + ciphertext + authTag).
 */
export function aesEncrypt(plaintext: Buffer, key: Buffer): string {
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
export function aesDecrypt(blob: string, key: Buffer): Buffer {
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
  const innerKey = deriveInnerKey(token, orgId, 'capy:invite');
  return aesEncrypt(masterKey, innerKey);
}

/**
 * Strips the inner layer using token T.
 * Input is the inner-wrapped blob (after service stripped outer layer).
 * Returns the master key M.
 */
export function innerUnwrap(innerBlob: string, token: Buffer, orgId: string): Buffer {
  const innerKey = deriveInnerKey(token, orgId, 'capy:invite');
  return aesDecrypt(innerBlob, innerKey);
}

/**
 * Constructs the redeem code: base64(T + orgIdLen(2 bytes BE) + orgId(utf8) + outerWrappedBlob)
 * T is 32 bytes, orgIdLen is a uint16 BE length prefix, then the org ID, then the ciphertext.
 */
export function buildRedeemCode(token: Buffer, outerWrappedBlob: string, orgId: string): string {
  const outerBuf = Buffer.from(outerWrappedBlob, 'base64');
  const orgIdBuf = Buffer.from(orgId, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(orgIdBuf.length, 0);
  return Buffer.concat([token, lenBuf, orgIdBuf, outerBuf]).toString('base64');
}

/**
 * Parses a redeem code back into T, orgId, and the outer-wrapped ciphertext.
 */
export function parseRedeemCode(redeemCode: string): { token: Buffer; orgId: string; ciphertext: string } {
  const buf = Buffer.from(redeemCode, 'base64');
  if (buf.length <= TOKEN_LENGTH + 2) {
    throw new Error('Invalid redeem code: too short');
  }
  const token = buf.subarray(0, TOKEN_LENGTH);
  const orgIdLen = buf.readUInt16BE(TOKEN_LENGTH);
  if (buf.length < TOKEN_LENGTH + 2 + orgIdLen) {
    throw new Error('Invalid redeem code: truncated org ID');
  }
  const orgId = buf.subarray(TOKEN_LENGTH + 2, TOKEN_LENGTH + 2 + orgIdLen).toString('utf8');
  const ciphertext = buf.subarray(TOKEN_LENGTH + 2 + orgIdLen).toString('base64');
  return { token, orgId, ciphertext };
}
