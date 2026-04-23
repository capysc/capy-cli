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
 * Inner layer: AES-256-GCM with HKDF(T, salt=orgId:email, info="capy:invite")
 * Outer layer: provided by the service via KMS (caller handles this)
 *
 * The recipient email is bound into the HKDF salt so that only the
 * intended recipient can derive the correct inner key to unwrap M.
 *
 * Returns the inner-wrapped blob (base64). Caller must then request
 * the service to wrap the outer layer.
 */
export function innerWrap(masterKey: Buffer, token: Buffer, orgId: string, email: string): string {
  const salt = `${orgId}:${email.toLowerCase()}`;
  const innerKey = deriveInnerKey(token, salt, 'capy:invite');
  return aesEncrypt(masterKey, innerKey);
}

/**
 * Strips the inner layer using token T.
 * Input is the inner-wrapped blob (after service stripped outer layer).
 * Returns the master key M.
 */
export function innerUnwrap(innerBlob: string, token: Buffer, orgId: string, email: string): Buffer {
  const salt = `${orgId}:${email.toLowerCase()}`;
  const innerKey = deriveInnerKey(token, salt, 'capy:invite');
  return aesDecrypt(innerBlob, innerKey);
}

/**
 * Redeem code format v2 (current):
 *   version(1=0x02) + T(32) + notAfter(8 bytes BE uint64 ms) +
 *   orgIdLen(2 BE) + orgId(utf8) + outerWrappedBlob
 *
 * `notAfter` is the unix-ms timestamp after which the code must be rejected.
 * The same value is bound into the KMS EncryptionContext at wrap time, so a
 * client tampering with notAfter in the redeem code causes the server-side
 * unwrap to fail at the AEAD layer (defence in depth on top of the explicit
 * server-side timestamp check).
 *
 * No v1 (no-expiry) format is accepted any more — old codes simply fail to
 * parse, which is the desired security property: pre-expiry-feature codes
 * predate the wrapping with notAfter context, so they could not unwrap on
 * the new server anyway.
 */
const REDEEM_CODE_VERSION = 0x02;

const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Resolve the invite TTL in milliseconds from CAPY_INVITE_TTL_SECONDS, falling
 * back to the 7-day default. Used by the inviter to compute `notAfter` at
 * wrap time. Tests override the env to exercise expired-code paths quickly.
 * Server caps the value at 30 days regardless of what the client requests.
 */
export function resolveInviteTtlMs(): number {
  const raw = process.env.CAPY_INVITE_TTL_SECONDS;
  if (raw === undefined) return DEFAULT_INVITE_TTL_SECONDS * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INVITE_TTL_SECONDS * 1000;
  }
  return Math.floor(parsed * 1000);
}

export function buildRedeemCode(
  token: Buffer,
  outerWrappedBlob: string,
  orgId: string,
  notAfter: number,
): string {
  const outerBuf = Buffer.from(outerWrappedBlob, 'base64');
  const orgIdBuf = Buffer.from(orgId, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(orgIdBuf.length, 0);
  const versionBuf = Buffer.from([REDEEM_CODE_VERSION]);
  const notAfterBuf = Buffer.alloc(8);
  notAfterBuf.writeBigUInt64BE(BigInt(notAfter), 0);
  return Buffer.concat([versionBuf, token, notAfterBuf, lenBuf, orgIdBuf, outerBuf]).toString('base64');
}

export function parseRedeemCode(redeemCode: string): {
  token: Buffer;
  orgId: string;
  ciphertext: string;
  notAfter: number;
} {
  const buf = Buffer.from(redeemCode, 'base64');
  // version(1) + token(32) + notAfter(8) + orgIdLen(2) = 43 bytes minimum
  if (buf.length <= 1 + TOKEN_LENGTH + 8 + 2) {
    throw new Error('Invalid redeem code: too short');
  }
  const version = buf.readUInt8(0);
  if (version !== REDEEM_CODE_VERSION) {
    throw new Error(
      `Unsupported redeem code version (got 0x${version.toString(16).padStart(2, '0')}, expected 0x${REDEEM_CODE_VERSION
        .toString(16)
        .padStart(2, '0')}). Issue a fresh invite.`,
    );
  }
  const token = buf.subarray(1, 1 + TOKEN_LENGTH);
  const notAfter = Number(buf.readBigUInt64BE(1 + TOKEN_LENGTH));
  const orgIdLenOffset = 1 + TOKEN_LENGTH + 8;
  const orgIdLen = buf.readUInt16BE(orgIdLenOffset);
  const orgIdOffset = orgIdLenOffset + 2;
  if (buf.length < orgIdOffset + orgIdLen) {
    throw new Error('Invalid redeem code: truncated org ID');
  }
  const orgId = buf.subarray(orgIdOffset, orgIdOffset + orgIdLen).toString('utf8');
  const ciphertext = buf.subarray(orgIdOffset + orgIdLen).toString('base64');
  return { token, orgId, ciphertext, notAfter };
}
