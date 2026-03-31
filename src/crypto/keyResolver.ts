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
  userId: string,
): string {
  // 1. Check project key cache
  const cached = readProjectKeyCache(orgId, projectId);
  if (cached) return cached;

  // 2. Unwrap M and derive
  const encryptedM = readMasterKey(orgId);
  if (!encryptedM) {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }

  const wrappingKey = deriveWrappingKey(userId, orgId);
  let masterKey: Buffer;
  try {
    masterKey = decryptMasterKey(encryptedM, wrappingKey);
  } catch {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
      ERROR_CODES.PERMISSION_DENIED,
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
