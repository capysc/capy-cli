// The one place `capy secrets`' interactive screen touches real crypto or
// the network — everything else in the feature (the reducer, the render,
// the value-resolution loop in `ui/secretsScreen.ts`) is pure and takes this
// as an injected function. Deliberately reuses the SAME project-key
// derivation and decrypt path `capy edit`/`capy run`/`capy` (pull) already
// use — see `EditCommand.execute`'s `resolveProjectKey` + `getDecryptData` +
// `FileManager.decryptValue` sequence — rather than writing new crypto.

import { FileManager } from '../files/fileManager';
import { CapyError } from '../types/index';
import type { ServiceClient, SecretIndexLocation } from '../service/serviceClient';
import type { LocationDecryptor, LocationDecryptResult } from '../ui/secretsScreen';

/**
 * Builds the decryptor the interactive screen calls (via
 * `resolveSecretValue`) once per details-open, for exactly one location at a
 * time, to get one row's plaintext. Every failure — a protected branch this
 * caller can't read, a project with no secrets pushed yet, a variable that
 * isn't actually in that location's blob, a service error — comes back as a
 * `{ ok: false, code }` using the SAME `CapyError.code` the rest of the CLI
 * branches on (never `.message`), so the screen can try the next location
 * without ever needing to parse prose.
 */
export function createLocationDecryptor(orgId: string, userId: string, serviceClient: ServiceClient): LocationDecryptor {
  const fileManager = new FileManager();

  return async (location: SecretIndexLocation, name: string): Promise<LocationDecryptResult> => {
    try {
      const { resolveProjectKey } = await import('../crypto/keyResolver');
      const keyOps = {
        coDecrypt: (oid: string, ct: string, transportId?: string) => serviceClient.coDecrypt(oid, ct, undefined, transportId).then((r) => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
      };
      const projectKey = await resolveProjectKey(orgId, location.project_id, userId, keyOps);

      const decryptData = await serviceClient.getDecryptData(location.project_id, location.branch, undefined, false);
      if (!decryptData.env_content) return { ok: false, code: 'NO_ENV' };

      const encrypted = fileManager.parseEnvContent(decryptData.env_content);
      const raw = encrypted[name];
      if (raw === undefined) return { ok: false, code: 'VARIABLE_NOT_FOUND' };

      const plaintext = fileManager.decryptValue(raw, projectKey);
      return { ok: true, plaintext };
    } catch (err) {
      if (err instanceof CapyError) return { ok: false, code: err.code };
      return { ok: false, code: 'UNKNOWN' };
    }
  };
}
