import { CapyError, ERROR_CODES, type KeepFile } from '../types/index';
import { compareSecrets, hashValue } from './statusComparison';
import { isReservedRuntimeVar } from '../core/reservedVars';

export type StatusStage = 'binding' | 'key_access' | 'local_values';

export async function withStatusStage<T>(stage: StatusStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error: unknown) {
    throw new CapyError('Status could not read the required state.', error instanceof CapyError ? error.code : ERROR_CODES.SERVICE_ERROR,
      { statusStage: stage, statusKeyStep: error instanceof CapyError ? error.details?.statusKeyStep : undefined });
  }
}

export function branchHashes(keep: KeepFile, branch: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(keep.variables).flatMap(([name, entries]) => {
    const entry = entries.find((candidate) => candidate.branch === branch);
    return entry && !isReservedRuntimeVar(name) ? [[name, entry.value_hash]] : [];
  }));
}

export function localStatusHashes(values: Readonly<Record<string, string>>, decrypt: (value: string) => string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !isReservedRuntimeVar(name))
    .map(([name, value]) => {
      try { return [name, hashValue(value.startsWith('capy:') ? decrypt(value) : value)]; }
      catch { throw new CapyError('A local value could not be read securely. Restore access before checking drift.', ERROR_CODES.PERMISSION_DENIED); }
    }));
}

export function makeStatusReport(input: {
  readonly projectName: string;
  readonly branch: string;
  readonly pinned: Readonly<Record<string, string>>;
  readonly local: Readonly<Record<string, string>>;
  readonly remote: Readonly<Record<string, string>>;
  readonly remoteFailure?: 'access_denied' | 'network_error' | 'no_data';
}) {
  const { diffs, showLocal, showRemote } = compareSecrets(input.pinned, input.local, input.remote, !input.remoteFailure);
  return { projectName: input.projectName, branch: input.branch,
    totalSecrets: new Set([...Object.keys(input.pinned), ...Object.keys(input.local), ...Object.keys(input.remote)]).size,
    inSync: !input.remoteFailure && diffs.length === 0,
    localMatchesPinned: !showLocal,
    remoteMatchesPinned: !input.remoteFailure && !showRemote,
    remoteFailure: input.remoteFailure ?? null, diffs };
}
