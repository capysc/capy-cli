import { randomBytes } from 'crypto';
import { deriveInnerKey, aesEncrypt, aesDecrypt } from './inviteCrypto';

const DEPLOY_ID_LENGTH = 32;
const DT_LENGTH = 32;
const DEPLOY_HKDF_INFO = 'capy:deploy';

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
