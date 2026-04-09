import { randomBytes, createCipheriv, hkdfSync } from 'crypto';
import { deriveInnerKey, aesEncrypt, aesDecrypt } from './inviteCrypto';

const DEPLOY_ID_LENGTH = 32;
const DT_LENGTH = 32;
const DEPLOY_HKDF_INFO = 'capy:deploy';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Generates a random 32-byte deploy ID.
 */
export function generateDeployId(): Buffer {
  return randomBytes(DEPLOY_ID_LENGTH);
}

/**
 * Generates a random 32-byte derivation token (DT).
 */
export function generateDerivationToken(): Buffer {
  return randomBytes(DT_LENGTH);
}

/**
 * Inner-wraps the project key PK.
 * IK = HKDF(DT, salt=projectId, info="capy:deploy")
 * Returns base64(iv + ciphertext + authTag).
 */
export function deployInnerWrap(projectKey: Buffer, dt: Buffer, projectId: string): string {
  const innerKey = deriveInnerKey(dt, projectId, DEPLOY_HKDF_INFO);
  return aesEncrypt(projectKey, innerKey);
}

/**
 * Strips the inner layer using DT. Returns the project key PK.
 */
export function deployInnerUnwrap(innerBlob: string, dt: Buffer, projectId: string): Buffer {
  const innerKey = deriveInnerKey(dt, projectId, DEPLOY_HKDF_INFO);
  return aesDecrypt(innerBlob, innerKey);
}

/**
 * Builds a deploy code: base64(deployId[32] + DT[32] + outerBlob[rest])
 * Fixed-offset binary encoding, same technique as invite redeemCode.
 */
export function buildDeployCode(deployId: Buffer, dt: Buffer, outerBlob: string): string {
  const outerBuf = Buffer.from(outerBlob, 'base64');
  return Buffer.concat([deployId, dt, outerBuf]).toString('base64');
}

/**
 * Parses a deploy code into its components by byte offset.
 */
export function parseDeployCode(deployCode: string): {
  deployId: Buffer;
  dt: Buffer;
  outerBlob: string;
} {
  const buf = Buffer.from(deployCode, 'base64');
  if (buf.length <= DEPLOY_ID_LENGTH + DT_LENGTH) {
    throw new Error('Invalid deploy code: too short');
  }
  const deployId = buf.subarray(0, DEPLOY_ID_LENGTH);
  const dt = buf.subarray(DEPLOY_ID_LENGTH, DEPLOY_ID_LENGTH + DT_LENGTH);
  const outerBlob = buf.subarray(DEPLOY_ID_LENGTH + DT_LENGTH).toString('base64');
  return { deployId, dt, outerBlob };
}

/**
 * Encrypts all env vars into a single blob using the project key.
 * Format: AES-256-GCM(envBlob, PK) where envBlob is KEY=value\n lines.
 */
export function encryptEnvBlob(envVars: Record<string, string>, projectKey: Buffer): Buffer {
  const envBlob = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const plaintext = Buffer.from(envBlob, 'utf-8');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', projectKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Builds a SECRETS_BLOB: base64(deploy_id[32] || outer_blob_len[4, big-endian] || outer_blob || encrypted_vars)
 */
export function buildSecretsBlob(
  deployId: Buffer,
  outerBlob: string,
  encryptedVars: Buffer,
): string {
  const outerBuf = Buffer.from(outerBlob, 'base64');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(outerBuf.length, 0);
  return Buffer.concat([deployId, lenBuf, outerBuf, encryptedVars]).toString('base64');
}
