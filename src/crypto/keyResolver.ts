import {
  deriveProjectKey,
  deriveWrappingKey,
  decryptMasterKey,
  encryptMasterKey,
  seedPhraseToMasterKey,
} from './keyManager';
import {
  readMasterKey,
  saveMasterKey,
  readProjectKeyCache,
  saveProjectKeyCache,
  hasOrgKey as globalHasOrgKey,
} from '../config/globalConfig';
import { CapyError, ERROR_CODES } from '../types/index';

/**
 * Interface for the co-decrypt + wrap operations needed by key resolution.
 * Callers provide this so keyResolver doesn't depend on ServiceClient directly.
 */
export interface KeyServiceOps {
  /** Strip the KMS outer layer via POST /orgs/:orgId/co-decrypt */
  coDecrypt(orgId: string, ciphertext: string): Promise<string>;
  /** Add the KMS outer layer via POST /orgs/:orgId/wrap */
  wrapOuterLayer(orgId: string, plaintext: string): Promise<string>;
}

/**
 * Resolves the encryption key for a project.
 *
 * M is stored double-wrapped on disk: KMS_ENCRYPT(AES-GCM(M, innerKey)).
 * To unwrap:
 * 1. Send the blob to the server's co-decrypt endpoint (strips KMS outer layer)
 * 2. Decrypt the inner layer locally with SHA256(userId:orgId)
 * 3. Derive the project key via HKDF(M, projectId, orgId)
 *
 * Without the server, the blob on disk is KMS-encrypted garbage — no M, no decrypt.
 *
 * Migration: if the blob is not KMS-wrapped (legacy single-wrap), unwrap with
 * the local key, re-wrap with KMS outer, and save. Future runs require the server.
 */
export async function resolveProjectKey(
  orgId: string,
  projectId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<string> {
  const encryptedBlob = readMasterKey(orgId, userId);
  if (!encryptedBlob) {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }

  const innerKey = deriveWrappingKey(userId, orgId);

  // Try double-wrapped path: co-decrypt strips KMS outer, then inner unwrap
  try {
    const innerBlob = await service.coDecrypt(orgId, encryptedBlob);
    const masterKey = decryptMasterKey(innerBlob, innerKey);
    return deriveProjectKey(masterKey, projectId, orgId);
  } catch {
    // co-decrypt failed — either not KMS-wrapped (legacy) or server rejected
  }

  // Migration: try legacy single-wrapped (no KMS outer layer)
  let masterKey: Buffer;
  try {
    masterKey = decryptMasterKey(encryptedBlob, innerKey);
  } catch {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'The server rejected the co-decrypt request, or the local key is invalid.\n' +
      'Ask the project owner to invite you, or run capy in a different directory.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }

  // Legacy blob unwrapped — re-wrap with KMS outer layer for future runs
  try {
    const innerWrapped = encryptMasterKey(masterKey, innerKey);
    // innerWrapped is already base64 — pass directly to wrapOuterLayer
    const outerWrapped = await service.wrapOuterLayer(orgId, innerWrapped);
    saveMasterKey(orgId, outerWrapped, userId);
  } catch {
    // Re-wrap failed (server unavailable?) — proceed with the unwrapped M this time.
    // Next run will retry migration.
  }

  return deriveProjectKey(masterKey, projectId, orgId);
}

/**
 * Double-wraps M for local storage.
 * Inner layer: AES-GCM with SHA256(userId:orgId)
 * Outer layer: KMS via service wrap endpoint
 */
export async function wrapAndSaveMasterKey(
  masterKey: Buffer,
  orgId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<void> {
  const innerKey = deriveWrappingKey(userId, orgId);
  const innerWrapped = encryptMasterKey(masterKey, innerKey);
  // innerWrapped is already base64 — pass directly to wrapOuterLayer
  const outerWrapped = await service.wrapOuterLayer(orgId, innerWrapped);
  saveMasterKey(orgId, outerWrapped, userId);
}

/**
 * Resolves a project key offline using a seed phrase (owner self-custody).
 * No server needed — the seed phrase replaces both shares.
 */
export function resolveFromSeedPhrase(
  seedPhrase: string,
  orgId: string,
  projectId: string,
): string {
  const masterKey = seedPhraseToMasterKey(seedPhrase);
  return deriveProjectKey(masterKey, projectId, orgId);
}

/**
 * Checks whether an org's master key exists on disk.
 */
export function hasOrgKey(orgId: string, userId?: string): boolean {
  return globalHasOrgKey(orgId, userId);
}
