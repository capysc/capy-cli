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
 * Encrypts all env vars into a single blob.
 *
 * Zero-trust derivation:
 *   service_key = HKDF-SHA256(innerBlob, salt=projectId+hex(deployId), info="capy:deploy:service-key", 32)
 *   DECRYPT_KEY = HKDF-SHA256(projectKey || service_key, salt=deployId, info="capy:deploy:decrypt", 32)
 *
 * Encrypted with AES-256-GCM(envBlob, DECRYPT_KEY) where envBlob is KEY=value\n lines.
 *
 * IMPORTANT: innerBlob MUST be the exact base64 string that was sent to the
 * service for KMS-wrapping. Do not recompute innerBlob here — deployInnerWrap
 * uses a random IV, so a fresh call would produce different bytes, yielding a
 * different service_key and breaking decryption round-trip.
 *
 * At decrypt time the consumer fetches service_key from the server (which
 * recovers the same innerBlob via KMS-unwrap) and reconstructs DECRYPT_KEY.
 * Zero-trust holds: projectKey alone is insufficient; revocation gates the
 * server's willingness to return service_key.
 */
export function encryptEnvBlob(
  envVars: Record<string, string>,
  projectKey: Buffer,
  innerBlob: string,
  projectId: string,
  deployId: Buffer,
): Buffer {
  // service_key derivation matches service/src/routes/deploy.ts:250-253
  const innerBlobBytes = Buffer.from(innerBlob, 'base64');
  const saltService = projectId + deployId.toString('hex');
  const serviceKey = Buffer.from(
    hkdfSync('sha256', innerBlobBytes, saltService, 'capy:deploy:service-key', 32),
  );

  // DECRYPT_KEY derivation matches deployRuntime.decryptSecretsBlob
  const combined = Buffer.concat([projectKey, serviceKey]);
  const decryptKey = Buffer.from(
    hkdfSync('sha256', combined, deployId, 'capy:deploy:decrypt', 32),
  );

  const envBlob = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const plaintext = Buffer.from(envBlob, 'utf-8');

  const iv = randomBytes(IV_LENGTH);
  // No setAAD: decryptKey = HKDF(projectKey||serviceKey, salt=deployId,
  // info="capy:deploy:decrypt") already binds the deploy/project context, so the
  // blob can't be replayed under a different deploy. AAD would be redundant.
  const cipher = createCipheriv('aes-256-gcm', decryptKey, iv, {
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
