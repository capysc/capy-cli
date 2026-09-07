import { createHash } from 'crypto';

export interface DiffResult {
  readonly variable: string;
  readonly type: 'new' | 'changed' | 'deleted';
  readonly pinned?: string;
  readonly local?: string;
  readonly remote?: string;
}

/** Inputs are hashes. Explicit remote availability distinguishes empty from unknown. */
export function compareSecrets(
  pinned: Readonly<Record<string, string>>,
  local: Readonly<Record<string, string>>,
  remote: Readonly<Record<string, string>>,
  remoteAvailable = Object.keys(remote).length > 0,
): { readonly diffs: DiffResult[]; readonly showLocal: boolean; readonly showRemote: boolean } {
  const rows = [...new Set([...Object.keys(pinned), ...Object.keys(local), ...(remoteAvailable ? Object.keys(remote) : [])])]
    .map((variable) => ({ variable, pinned: pinned[variable], local: local[variable], remote: remoteAvailable ? remote[variable] : pinned[variable] }))
    .filter((row) => !(!row.pinned && row.local !== undefined && row.local === row.remote));
  const diffs = rows.filter((row) => !(row.pinned === row.local && row.pinned === row.remote)
    && !!(row.pinned || row.local || row.remote)).map((row): DiffResult => ({
      variable: row.variable,
      type: !row.pinned && (row.local || row.remote) ? 'new'
        : row.pinned && (!row.local || !row.remote) ? 'deleted' : 'changed',
      pinned: row.pinned || undefined, local: row.local || undefined, remote: row.remote || undefined,
    }));
  return { diffs, showLocal: rows.some((row) => row.local !== row.pinned), showRemote: rows.some((row) => row.remote !== row.pinned) };
}

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
