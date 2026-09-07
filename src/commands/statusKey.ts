import { readLocalRoot, readMasterKey, getLocalRootMode } from '../config/globalConfig';
import { configuredGrantSocketPath } from '../auth/deviceKey/ephemeral';
import { readRuntimePairing } from '../auth/pairing/runtimePairing';
import { fetchGrantedKLocal } from '../auth/deviceKey/grantHolder';
import { createGrantResolutionOps, resolveProjectKeyFromGrant, type GrantResolutionOps } from '../auth/deviceKey/grantResolver';
import type { AuthService } from '../auth/authService';
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES } from '../types/index';

/** Existing-key-only status path. It has no key writer, migration, or ceremony operation. */
export async function resolveExistingStatusKey(input: {
  readonly orgId: string; readonly projectId: string; readonly userId: string;
  readonly root: Buffer | null; readonly keyBlob: string | null;
  readonly coDecrypt: GrantResolutionOps['coDecrypt'];
}): Promise<string> {
  if (!input.root || !input.keyBlob) {
    throw new CapyError('Existing device access is required to check encrypted files. Reconnect this device through Capy setup.', ERROR_CODES.PERMISSION_DENIED, { statusKeyStep: 'existing_custody' });
  }
  const keyBlob = input.keyBlob;
  return resolveProjectKeyFromGrant(input.root, input.orgId, input.projectId, input.userId, {
    fetchKeyEnc: async () => keyBlob, coDecrypt: input.coDecrypt,
  });
}

export async function resolveStatusProjectKey(orgId: string, projectId: string, userId: string, service: ServiceClient, auth: AuthService): Promise<string> {
  const socket = configuredGrantSocketPath();
  if (socket) {
    const grant = await fetchGrantedKLocal(socket, userId);
    const pairing = readRuntimePairing();
    if (grant.userId !== userId || (pairing?.socketPath === socket
      && (pairing.userId !== userId || pairing.credentialId !== grant.credentialId))) {
      throw new CapyError('The existing device grant belongs to a different session.', ERROR_CODES.PERMISSION_DENIED, { statusKeyStep: 'grant_identity' });
    }
    return resolveProjectKeyFromGrant(grant.kLocal, orgId, projectId, userId, createGrantResolutionOps(service, auth))
      .catch((error: unknown) => { throw new CapyError('The existing grant could not unlock the project.',
        error instanceof CapyError ? error.code : ERROR_CODES.SERVICE_ERROR, { statusKeyStep: 'grant_unwrap' }); });
  }
  if (getLocalRootMode(orgId, userId) === 'keychain') {
    throw new CapyError('This device needs its existing key storage restored before status can read encrypted files.', ERROR_CODES.LOCAL_KEY_BACKEND_ERROR);
  }
  return resolveExistingStatusKey({ orgId, projectId, userId,
    root: readLocalRoot(orgId, userId), keyBlob: readMasterKey(orgId, userId),
    coDecrypt: (id, ciphertext) => service.coDecrypt(id, ciphertext).then((result) => result.plaintext),
  });
}
