import { CapyError, ERROR_CODES } from '../types/index';

/** Never apply a partially decrypted snapshot. */
export function decryptSyncSnapshot(
  values: Readonly<Record<string, string>>,
  decrypt: (value: string) => string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    try { return [name, decrypt(value)] as const; }
    catch {
      throw new CapyError('The remote snapshot could not be fully decrypted. No local files were changed; restore device access before retrying.', ERROR_CODES.DECRYPT_KEY_MISMATCH);
    }
  }));
}
