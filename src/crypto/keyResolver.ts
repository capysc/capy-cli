import {
  deriveProjectKey,
  deriveWrappingKey,
  decryptMasterKey,
  seedPhraseToMasterKey,
} from './keyManager';
import {
  readMasterKey,
  readProjectKeyCache,
  saveProjectKeyCache,
  hasOrgKey as globalHasOrgKey,
} from '../config/globalConfig';
import { CapyError, ERROR_CODES } from '../types/index';

/**
 * Resolves the encryption key for a project.
 *
 * Resolution order:
 * 1. Cached project key on disk
 * 2. Unwrap master key M → derive project key → cache
 *
 * Throws if no org key exists (user needs to create org or be invited).
 */
export function resolveProjectKey(
  orgId: string,
  projectId: string,
  accessToken: string,
): string {
  // 1. Check project key cache
  const cached = readProjectKeyCache(orgId, projectId);
  if (cached) return cached;

  // 2. Unwrap M and derive
  const encryptedM = readMasterKey(orgId);
  if (!encryptedM) {
    throw new CapyError(
      'No master key found for this organization. Create an org or accept an invite first.',
      ERROR_CODES.AUTH_FAILED,
      { orgId },
    );
  }

  const wrappingKey = deriveWrappingKey(accessToken);
  let masterKey: Buffer;
  try {
    masterKey = decryptMasterKey(encryptedM, wrappingKey);
  } catch {
    throw new CapyError(
      'Failed to unwrap master key. Your auth session may have changed. Please re-authenticate.',
      ERROR_CODES.AUTH_FAILED,
      { orgId },
    );
  }

  const projectKey = deriveProjectKey(masterKey, projectId, orgId);

  // Cache for next time
  saveProjectKeyCache(orgId, projectId, projectKey);

  return projectKey;
}

/**
 * Resolves a project key offline using a seed phrase (owner self-custody).
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
export function hasOrgKey(orgId: string): boolean {
  return globalHasOrgKey(orgId);
}
