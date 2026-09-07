import { readRuntimePairing, recoverFilesystemRuntimePairing } from './runtimePairing';
import { runtimePairingEnvironment } from './runtimePairingEnvironment';

export interface RuntimePairingSocketDependencies {
  readonly read: typeof readRuntimePairing;
  readonly recover: typeof recoverFilesystemRuntimePairing;
  readonly environment: typeof runtimePairingEnvironment;
}

/** Only the explicitly bound socket can restore custody; unrelated grants remain ephemeral. */
export async function resolveRuntimePairingSocket(
  socketPath: string,
  userId: string,
  deps: RuntimePairingSocketDependencies = {
    read: readRuntimePairing,
    recover: recoverFilesystemRuntimePairing,
    environment: runtimePairingEnvironment,
  },
): Promise<string> {
  const record = deps.read();
  if (record?.version !== 1 || !record.filesystemCustody || record.socketPath !== socketPath) return socketPath;
  const restored = await deps.recover({ expectedUserId: userId, environment: deps.environment() });
  return restored?.socketPath ?? socketPath;
}
