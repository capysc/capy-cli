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
import { getGlobalCapyDir, readAuthSession } from '../../config/globalConfig';
import { CapyError, ERROR_CODES, type SessionStore } from '../../types/index';

export interface RuntimePairingRecord {
  readonly version: 1;
  readonly userId: string;
  readonly credentialId: string;
  readonly socketPath: string;
  /** 0 means process-bound; positive values are legacy finite pair records. */
  readonly expiresAt: number;
  readonly pairedAt: string;
}

export interface RuntimePairingHandle {
  readonly socketPath: string;
  readonly expiresAt: number;
}

export interface ActiveRuntimePairing {
  readonly userId: string;
  readonly userEmail: string;
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

function readMatchingPairingSession(userId: string): SessionStore | null {
  try {
    const session = readAuthSession(userId) as SessionStore | null;
    return session?.version === 2 && session.user_id === userId ? session : null;
  } catch {
    return null;
  }
}

/**
 * Return the already-usable runtime pair, if one exists. All three facts are
 * required before `capy pair` may skip a new human ceremony:
 *
 *  - metadata binds this environment home to a user;
 *  - that user's own persisted session agrees with the binding; and
 *  - the in-memory daemon is live and any legacy finite grant has not expired.
 *
 * Stale metadata deliberately remains an account binding (see
 * assertRuntimePairingUser), but is not an active pair. The command therefore
 * starts a fresh device flow for the same user; a different user is still
 * refused before their session can be written.
 */
export async function readActiveRuntimePairing(): Promise<ActiveRuntimePairing | null> {
  const record = readRuntimePairing();
  if (!record || (record.expiresAt !== 0 && record.expiresAt <= Date.now())) return null;
  const session = readMatchingPairingSession(record.userId);
  if (!session) return null;
  const live = await import('../deviceKey/grantHolder')
    .then(({ isGrantActive }) => isGrantActive(record.socketPath))
    .catch(() => false);
  return live
    ? {
        userId: record.userId,
        userEmail: typeof session.user_email === 'string' && session.user_email.length > 0
          ? session.user_email
          : record.userId,
        socketPath: record.socketPath,
        expiresAt: record.expiresAt,
      }
    : null;
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

const REJECTED_HANDLE_CLEANUP_TIMEOUT_MS = 2_000;

function requestAcknowledgedDaemonShutdown(
  socketPath: string,
  userId: string,
  credentialId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const finish = (outcome: { readonly ok: true } | { readonly ok: false; readonly error: Error }): void => {
      clearTimeout(timer);
      socket.destroy();
      if (outcome.ok) resolve();
      else reject(outcome.error);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: new Error(`Runtime key holder did not acknowledge shutdown: ${socketPath}`) }),
      REJECTED_HANDLE_CLEANUP_TIMEOUT_MS,
    );
    timer.unref?.();
    const readFrom = (buffer: string): void => {
      socket.once('data', (chunk) => {
        const next = buffer + chunk.toString('utf8');
        const newline = next.indexOf('\n');
        if (newline === -1) {
          readFrom(next);
          return;
        }
        const response = (() => {
          try {
            return JSON.parse(next.slice(0, newline)) as Readonly<{ ok?: unknown }>;
          } catch {
            return null;
          }
        })();
        finish(response?.ok === true
          ? { ok: true }
          : {
              ok: false,
              error: new Error(response
                ? `Runtime key holder did not confirm cleanup ownership: ${socketPath}`
                : `Runtime key holder returned an invalid shutdown response: ${socketPath}`),
            });
      });
    };
    socket.once('connect', () => socket.write(`${JSON.stringify({
      op: 'verify_shutdown',
      userId,
      credentialId,
    })}\n`));
    socket.once('error', (error) => finish({ ok: false, error }));
    socket.once('end', () => finish({
      ok: false,
      error: new Error(`Runtime key holder closed without acknowledging shutdown: ${socketPath}`),
    }));
    readFrom('');
  });
}

async function waitForExactSocketDisappearance(
  socketPath: string,
  deadline = Date.now() + REJECTED_HANDLE_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (Date.now() >= deadline) throw new Error(`Runtime key holder socket remained after shutdown: ${socketPath}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return waitForExactSocketDisappearance(socketPath, deadline);
}

async function cleanupRejectedRuntimeHandle(
  socketPath: string,
  userId: string,
  credentialId: string,
): Promise<void> {
  const shutdown = await (async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: Error & { readonly code?: string } }
  > => {
    try {
      await requestAcknowledgedDaemonShutdown(socketPath, userId, credentialId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error : new Error(String(error))) as Error & { readonly code?: string },
      };
    }
  })();
  if (!shutdown.ok && shutdown.error.code !== 'ENOENT') throw shutdown.error;
  await waitForExactSocketDisappearance(socketPath);
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
  const existingBeforeCheck = readRuntimePairing();
  const registration = await (async (): Promise<
    { readonly ok: true; readonly record: RuntimePairingRecord }
    | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      const existing = assertRuntimePairingUser(userId);
      // Never trade a valid pair for an expired, dead, or foreign holder. The
      // probe checks user + credential without asking the daemon to release
      // K_local. This runs before the atomic metadata rename and before the old
      // daemon receives shutdown, so every rejected replacement leaves the
      // existing account binding and key holder untouched.
      const replacement = existing !== null;
      const candidateIsCurrent = handle.expiresAt === 0 || handle.expiresAt > Date.now();
      const candidateMatches = !replacement || (candidateIsCurrent && await import('../deviceKey/grantHolder')
        .then(({ isGrantActiveFor }) => isGrantActiveFor(handle.socketPath, userId, credentialId))
        .catch(() => false));
      if (!candidateMatches) {
        throw new CapyError(
          candidateIsCurrent
            ? 'The replacement runtime key holder was unavailable or belonged to another pairing.'
            : 'The replacement runtime key holder had already expired.',
          candidateIsCurrent
            ? ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND
            : ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED,
        );
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

      const previousSocket = existing?.socketPath;
      if (previousSocket && previousSocket !== handle.socketPath) {
        await requestDaemonShutdown(previousSocket);
      }
      return { ok: true, record };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  if (registration.ok) return registration.record;

  // The existing record is protected state, never evidence that this caller
  // owns its socket. Only a distinct candidate may be cleaned up after a
  // failed commit.
  if (handle.socketPath === existingBeforeCheck?.socketPath) throw registration.error;
  const cleanup = await (async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      await cleanupRejectedRuntimeHandle(handle.socketPath, userId, credentialId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  if (!cleanup.ok) {
    throw new AggregateError(
      [registration.error, cleanup.error],
      'Runtime pairing registration failed and its candidate key holder could not be cleaned up.',
    );
  }
  throw registration.error;
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
