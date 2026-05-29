/**
 * Local-only mode unlock orchestration.
 *
 * Sits between the commands and the crypto layer: it manages the passphrase
 * session (cache-or-prompt) and resolves project keys, so call sites just do
 *   const keyHex = await resolveLocalProjectKey(projectId);
 * without knowing about passphrases, sessions, or idle auto-lock.
 *
 * This is the local-only counterpart to the server-backed
 * `resolveProjectKey(orgId, projectId, userId, keyServiceOps)` path — it never
 * touches the network.
 */
import {
  readLocalSession,
  saveLocalSession,
  touchLocalSession,
} from '../config/globalConfig';
import { getLocalLockTimeoutMs } from '../config/profileConfig';
import { decryptLocalMasterKeyHex, resolveFromLocalKey } from '../crypto/keyResolver';

/**
 * Returns the master key (hex), unlocking on demand. If an unexpired session
 * exists it is reused (and its idle clock refreshed); otherwise the passphrase
 * is prompted, M is unwrapped, and a fresh session is written.
 *
 * Because this prompts when locked, lock state never hard-blocks a command —
 * `capy run` and friends "just work" by asking once when needed.
 *
 * Throws CapyError('Incorrect passphrase.') on a bad passphrase.
 */
export async function unlockLocalKey(): Promise<string> {
  const timeoutMs = getLocalLockTimeoutMs();
  const cached = readLocalSession(timeoutMs);
  if (cached) {
    touchLocalSession();
    return cached;
  }

  const inquirer = (await import('inquirer')).default;
  const { passphrase } = await inquirer.prompt([
    {
      type: 'password',
      name: 'passphrase',
      message: 'Enter your local passphrase:',
      mask: '*',
    },
  ]);

  const masterKeyHex = decryptLocalMasterKeyHex(passphrase);
  saveLocalSession(masterKeyHex);
  return masterKeyHex;
}

/** Unlock (if needed) and derive the project key for the given project. */
export async function resolveLocalProjectKey(projectId: string): Promise<string> {
  const masterKeyHex = await unlockLocalKey();
  return resolveFromLocalKey(masterKeyHex, projectId);
}
