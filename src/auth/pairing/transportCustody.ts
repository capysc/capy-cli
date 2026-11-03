import { CapyError, ERROR_CODES } from '../../types/index';
import type { PairingEntry } from '../../crypto/pairingPayload';
import { decryptBoundMasterKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';

export interface TransportCustodyOperations {
  readonly unwrap: (orgId: string, ciphertext: string, transportId: string) => Promise<string>;
  readonly wrap: (orgId: string, innerCiphertext: string) => Promise<string>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new CapyError('The selected Transport custody could not be verified.', ERROR_CODES.DECRYPT_KEY_MISMATCH); };

/** Convert a current Transport's outer binding into the existing installation format.
 * The same K_local and inner ciphertext are retained; the master key never leaves the CLI.
 * Legacy file payloads are returned byte-for-byte, without a storage migration.
 */
export async function prepareTransportCustody(
  entry: Readonly<PairingEntry> & Readonly<{ transport_id?: unknown }>,
  operations: TransportCustodyOperations,
): Promise<Readonly<PairingEntry>> {
  const keyFile: unknown = (() => { try { return JSON.parse(entry.key_enc); } catch { return null; } })();
  const record = keyFile && typeof keyFile === 'object' && !Array.isArray(keyFile) ? keyFile as Readonly<Record<string, unknown>> : null;
  if (!record || !Object.hasOwn(record, 'transport_id')) {
    if (entry.transport_id !== undefined) return invalid();
    return entry;
  }
  const transportId = record.transport_id;
  if (typeof transportId !== 'string' || !UUID.test(transportId) || record.version !== '2.0'
    || record.wrapping_method !== 'local_root' || record.org_id !== entry.org_id
    || typeof record.encrypted_master_key !== 'string' || record.encrypted_master_key.length === 0
    || (entry.transport_id !== undefined && entry.transport_id !== transportId)) return invalid();
  const local = Buffer.from(entry.k_local, 'base64url');
  if (local.length !== 32 || local.toString('base64url') !== entry.k_local) return invalid();
  const inner = await operations.unwrap(entry.org_id, record.encrypted_master_key, transportId);
  const verified = (() => {
    try { return decryptBoundMasterKey(inner, deriveLocalInnerKey(local), masterKeyAAD(entry.user_id, entry.org_id)).length === 32; }
    catch { return false; }
  })();
  if (!verified) return invalid();
  const outer = await operations.wrap(entry.org_id, inner);
  if (typeof outer !== 'string' || outer.length === 0) return invalid();
  const installedFile = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'transport_id'));
  return { org_id: entry.org_id, user_id: entry.user_id, k_local: entry.k_local,
    key_enc: JSON.stringify({ ...installedFile, encrypted_master_key: outer }, null, 2) };
}
