import { FlowRuntimeError } from '../../errors/flowRuntimeError';

export interface FilesystemCustodyFile {
  readonly ciphertext: string;
  readonly transportId?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recognized Transport metadata must validate; it cannot downgrade to a legacy file. */
export function parseFilesystemCustodyFile(raw: string, orgId: string): FilesystemCustodyFile | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const file = value as Readonly<Record<string, unknown>>;
    if (file.version !== '2.0' || file.org_id !== orgId || file.wrapping_method !== 'local_root'
      || typeof file.encrypted_master_key !== 'string' || !file.encrypted_master_key) return null;
    if (!Object.hasOwn(file, 'transport_id')) return { ciphertext: file.encrypted_master_key };
    return typeof file.transport_id === 'string' && UUID.test(file.transport_id)
      ? { ciphertext: file.encrypted_master_key, transportId: file.transport_id } : null;
  } catch { return null; }
}

/** Infer row context only for the exact encrypted file being opened, never an unrelated ciphertext. */
export function storedTransportId(raw: string | null, orgId: string, ciphertext: string): string | undefined {
  if (!raw) return undefined;
  const value: unknown = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.encrypted_master_key !== ciphertext || !Object.hasOwn(record, 'transport_id')) return undefined;
  const parsed = parseFilesystemCustodyFile(raw, orgId);
  if (!parsed?.transportId) throw new FlowRuntimeError('CUSTODY_FILE_INVALID');
  return parsed.transportId;
}
