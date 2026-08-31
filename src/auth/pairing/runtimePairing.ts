/**
 * Runtime-scoped pairing registry.
 *
 * The registry is deliberately metadata-only. K_local remains inside the
 * detached grant daemon; the file written here contains only the account
 * binding and the Unix-socket address needed by later capy processes. This
 * removes the requirement to export CAPY_DEVICE_KEY_GRANT_SOCKET without
 * weakening the existing custody model by writing K_local (or a decrypt-
 * equivalent wrapping key) to disk.
 *
 * The file lives below getGlobalCapyDir(), so production, development, and
 * staging remain isolated at ~/.capy, ~/.capy-dev, and ~/.capy-staging.
 * Deleting that environment home is the definition of wiping the runtime.
 *
 * This is process-durable, not reboot-durable: if the daemon dies, the
 * metadata remains as the one-user binding and the same user may pair again.
 * A different user must explicitly log out first. Reboot-durable custody
 * needs a packageable secure-at-rest backend or a new service/Keep sealing
 * contract; persisting plaintext K_local here is not an acceptable fallback.
 */
import { createConnection } from 'net';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getGlobalCapyDir } from '../../config/globalConfig';
import { CapyError, ERROR_CODES } from '../../types/index';

export interface RuntimePairingRecord {
  readonly version: 1;
  readonly userId: string;
  readonly credentialId: string;
  readonly socketPath: string;
  readonly expiresAt: number;
  readonly pairedAt: string;
}

export interface RuntimePairingHandle {
  readonly socketPath: string;
  readonly expiresAt: number;
}

export function getRuntimePairingPath(): string {
  return join(getGlobalCapyDir(), 'auth', 'runtime-pair.json');
}

function isRuntimePairingRecord(value: unknown): value is RuntimePairingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.version === 1
    && typeof candidate.userId === 'string'
    && candidate.userId.length > 0
    && typeof candidate.credentialId === 'string'
    && candidate.credentialId.length > 0
    && typeof candidate.socketPath === 'string'
    && candidate.socketPath.length > 0
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt)
    && typeof candidate.pairedAt === 'string';
}

export function readRuntimePairing(): RuntimePairingRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getRuntimePairingPath(), 'utf8'));
    return isRuntimePairingRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Enforce the runtime's single-account binding before any new session is
 * written. A stale/dead daemon does not erase identity: the same user can
 * repair it by pairing again, while a different user must explicitly logout.
 */
export function assertRuntimePairingUser(userId: string): RuntimePairingRecord | null {
  const existing = readRuntimePairing();
  if (!existing || existing.userId === userId) return existing;
  throw new CapyError(
    'This runtime is paired to another Capy account. Run `capy logout` before pairing a different account.',
    ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
  );
}

function writeRuntimePairing(record: RuntimePairingRecord): void {
  const destination = getRuntimePairingPath();
  const directory = dirname(destination);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, destination);
}

function requestDaemonShutdown(socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'shutdown' }) + '\n'));
    socket.once('data', finish);
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', finish);
  });
}

/**
 * Commit a newly started daemon as this runtime's active pairing. Re-pairing
 * the same user replaces the old daemon; a different user is refused and the
 * just-created daemon is shut down so no orphaned key holder remains.
 */
export async function registerRuntimePairing(
  userId: string,
  credentialId: string,
  handle: RuntimePairingHandle,
): Promise<RuntimePairingRecord> {
  const existingOutcome = (() => {
    try {
      return { ok: true as const, existing: assertRuntimePairingUser(userId) };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  if (!existingOutcome.ok) {
    await requestDaemonShutdown(handle.socketPath);
    throw existingOutcome.error;
  }

  const record: RuntimePairingRecord = {
    version: 1,
    userId,
    credentialId,
    socketPath: handle.socketPath,
    expiresAt: handle.expiresAt,
    pairedAt: new Date().toISOString(),
  };
  writeRuntimePairing(record);

  const previousSocket = existingOutcome.existing?.socketPath;
  if (previousSocket && previousSocket !== handle.socketPath) {
    await requestDaemonShutdown(previousSocket);
  }
  return record;
}

/** Clear the metadata binding and stop its daemon best-effort. */
export async function clearRuntimePairing(): Promise<boolean> {
  const existing = readRuntimePairing();
  const path = getRuntimePairingPath();
  const existed = existsSync(path);
  if (existing) await requestDaemonShutdown(existing.socketPath);
  try {
    rmSync(path, { force: true });
  } catch {
    return false;
  }
  return existed;
}
