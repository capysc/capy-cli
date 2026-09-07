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
 * Legacy records are process-durable. A filesystemCustody binding permits
 * restoration from the existing protected local.key after holder loss.
 * The binding is required: preserved recovery files alone never restore a
 * pairing after logout. No external storage provider is needed for this path.
 */
import { Socket } from 'net';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, sep } from 'path';
import { getGlobalCapyDir, getLocalRootPath, readAuthSession, saveLocalRootExclusive } from '../../config/globalConfig';
import { CapyError, ERROR_CODES, type SessionStore } from '../../types/index';
import {
  deleteRuntimeCustody,
  sealRuntimeCustody,
  unsealRuntimeCustody,
  type RuntimeCustodyBinding,
  type RuntimeCustodyEnvironment,
  type RuntimeCustodyProvider,
  type RuntimeCustodyProviderResolver,
} from './runtimeCustodyProvider';
import {
  acquirePairAttemptLease,
  ownsPairAttemptLease,
  releasePairAttemptLease,
  type PairAttemptLease,
} from './pairAttemptLease';

interface RuntimePairingRecordFields {
  readonly userId: string;
  readonly credentialId: string;
  readonly socketPath: string;
  /** 0 means process-bound; positive values are legacy finite pair records. */
  readonly expiresAt: number;
  readonly pairedAt: string;
}

export interface RuntimePairingRecordV1 extends RuntimePairingRecordFields {
  readonly version: 1;
  readonly filesystemCustody?: FilesystemPairingCustody;
}

export interface FilesystemPairingCustody {
  readonly environment: RuntimeCustodyEnvironment;
  /** Storage location only; this does not attribute a repository. */
  readonly orgId: string;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimePairingRecordV2 extends RuntimePairingRecordFields {
  readonly version: 2;
  readonly custody: RuntimeCustodyBinding;
}

export type RuntimePairingRecord = RuntimePairingRecordV1 | RuntimePairingRecordV2;

type RuntimePairingRecordState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly record: RuntimePairingRecord };

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

export interface RuntimePairingRecoveryRequest {
  readonly environment: RuntimeCustodyEnvironment;
  readonly expectedUserId: string;
  readonly resolveProvider: RuntimeCustodyProviderResolver;
}

export interface RecoveryGrantMaterial {
  readonly userId: string;
  readonly credentialId: string;
  readonly kLocal: Uint8Array;
}

export type RuntimePairingRecoveryOutcome =
  | { readonly kind: 'not_v2' }
  | { readonly kind: 'active'; readonly record: RuntimePairingRecordV2 }
  | { readonly kind: 'recovered'; readonly record: RuntimePairingRecordV2 }
  | { readonly kind: 'reused'; readonly record: RuntimePairingRecordV2 };

export interface RuntimePairingRecoveryDependencies {
  readonly acquireLease?: () => PairAttemptLease;
  readonly ownsLease?: (lease: PairAttemptLease) => boolean;
  readonly releaseLease?: (lease: PairAttemptLease) => boolean;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly waitTimeoutMs?: number;
  readonly probeHolder?: (
    socketPath: string,
    userId: string,
    credentialId: string,
  ) => Promise<boolean>;
  readonly spawnHolder?: (material: RecoveryGrantMaterial) => Promise<RuntimePairingHandle>;
  readonly cleanupCandidate?: (
    socketPath: string,
    userId: string,
    credentialId: string,
  ) => Promise<void>;
  readonly compareAndSwapSocket?: (
    expected: RuntimePairingRecordV2,
    replacement: RuntimePairingRecordV2,
  ) => 'committed' | 'changed';
}

export function getRuntimePairingPath(): string {
  return join(getGlobalCapyDir(), 'auth', 'runtime-pair.json');
}

function isRuntimeCustodyBinding(value: unknown, userId: string): value is RuntimeCustodyBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  const providerKind = candidate.providerKind;
  const environment = candidate.environment;
  return (providerKind === 'os-secure-store' || providerKind === 'orchestrator-secret-store')
    && (environment === 'development' || environment === 'staging' || environment === 'production')
    && candidate.userId === userId
    && typeof candidate.opaqueHandle === 'string'
    && candidate.opaqueHandle.length > 0;
}

function hasRuntimePairingFields(candidate: Readonly<Record<string, unknown>>): boolean {
  return typeof candidate.userId === 'string'
    && candidate.userId.length > 0
    && typeof candidate.credentialId === 'string'
    && candidate.credentialId.length > 0
    && typeof candidate.socketPath === 'string'
    && candidate.socketPath.length > 0
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt)
    && typeof candidate.pairedAt === 'string';
}

function isRuntimePairingRecord(value: unknown): value is RuntimePairingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (!hasRuntimePairingFields(candidate)) return false;
  if (candidate.version === 1) return !Object.hasOwn(candidate, 'custody')
    && (!Object.hasOwn(candidate, 'filesystemCustody') || isFilesystemCustody(candidate.filesystemCustody));
  return candidate.version === 2
    && !Object.hasOwn(candidate, 'filesystemCustody')
    && typeof candidate.userId === 'string'
    && isRuntimeCustodyBinding(candidate.custody, candidate.userId);
}

function readRuntimePairingState(): RuntimePairingRecordState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getRuntimePairingPath(), 'utf8'));
    return isRuntimePairingRecord(parsed)
      ? { kind: 'valid', record: parsed }
      : { kind: 'invalid' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }
}

export function readRuntimePairing(): RuntimePairingRecord | null {
  const state = readRuntimePairingState();
  return state.kind === 'valid' ? state.record : null;
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
  const state = readRuntimePairingState();
  if (state.kind === 'invalid') {
    throw custodyCleanupRefusal(
      'The runtime pairing record is invalid; it was preserved so custody can be repaired safely.',
    );
  }
  const existing = state.kind === 'valid' ? state.record : null;
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
    const socket = new Socket();
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
    socket.connect(socketPath);
  });
}

const REJECTED_HANDLE_CLEANUP_TIMEOUT_MS = 2_000;

function requestAcknowledgedDaemonShutdown(
  socketPath: string,
  userId: string,
  credentialId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
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
    socket.connect(socketPath);
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

async function cleanupRejectedRuntimeHandleOutcome(
  socketPath: string,
  userId: string,
  credentialId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
  try {
    await cleanupRejectedRuntimeHandle(socketPath, userId, credentialId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Commit a newly started daemon as this runtime's active pairing. Re-pairing
 * the same user replaces the old daemon; a different user is refused and the
 * just-created daemon is shut down so no orphaned key holder remains.
 */
async function registerRuntimePairingRecord<TRecord extends RuntimePairingRecord>(
  userId: string,
  credentialId: string,
  handle: RuntimePairingHandle,
  requestedVersion: TRecord['version'],
  createRecord: (fields: RuntimePairingRecordFields) => TRecord,
): Promise<TRecord> {
  const existingBeforeCheck = readRuntimePairing();
  const registration = await (async (): Promise<
    { readonly ok: true; readonly record: TRecord }
    | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      const existing = assertRuntimePairingUser(userId);
      if (existing?.version === 2 && requestedVersion === 1) {
        throw custodyCleanupRefusal(
          'A provider-backed runtime pairing cannot be downgraded to process-only custody.',
        );
      }
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

      const record = createRecord({
        userId,
        credentialId,
        socketPath: handle.socketPath,
        expiresAt: handle.expiresAt,
        pairedAt: new Date().toISOString(),
      });
      if (existing?.version === 1 && existing.filesystemCustody
        && (record.version !== 1 || !record.filesystemCustody)) {
        throw custodyCleanupRefusal('Filesystem pairing custody cannot be silently downgraded.');
      }
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
  const cleanup = await cleanupRejectedRuntimeHandleOutcome(handle.socketPath, userId, credentialId);
  if (!cleanup.ok) {
    throw new AggregateError(
      [registration.error, cleanup.error],
      'Runtime pairing registration failed and its candidate key holder could not be cleaned up.',
    );
  }
  throw registration.error;
}

export async function registerRuntimePairing(
  userId: string,
  credentialId: string,
  handle: RuntimePairingHandle,
): Promise<RuntimePairingRecordV1> {
  return registerRuntimePairingRecord(
    userId,
    credentialId,
    handle,
    1,
    (fields) => ({ version: 1, ...fields }),
  );
}

function custodyBindingsEqual(
  left: RuntimeCustodyBinding,
  right: RuntimeCustodyBinding,
): boolean {
  return left.providerKind === right.providerKind
    && left.environment === right.environment
    && left.userId === right.userId
    && left.opaqueHandle === right.opaqueHandle;
}

async function deleteNewCustodyBinding(
  provider: RuntimeCustodyProvider,
  binding: RuntimeCustodyBinding,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
  try {
    await deleteRuntimeCustody(provider, binding, {
      environment: binding.environment,
      userId: binding.userId,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Publish a version-2 runtime record only after the provider has sealed
 * K_local. Existing v1 callers remain unchanged until a concrete provider is
 * selected at the CLI composition root.
 */
export async function registerRuntimePairingWithCustody(
  provider: RuntimeCustodyProvider,
  environment: RuntimeCustodyEnvironment,
  material: {
    readonly userId: string;
    readonly credentialId: string;
    readonly kLocal: Uint8Array;
  },
  handle: RuntimePairingHandle,
): Promise<RuntimePairingRecordV2> {
  const existingBeforePreparation = readRuntimePairing();
  const preparation = await (async () => {
    const existing = assertRuntimePairingUser(material.userId);
    if (
      existing?.version === 2
      && (
        existing.custody.providerKind !== provider.kind
        || existing.custody.environment !== environment
      )
    ) {
      throw custodyCleanupRefusal(
        'The existing runtime custody binding does not match the selected provider and environment.',
      );
    }
    const binding = await sealRuntimeCustody(provider, {
      environment,
      userId: material.userId,
      kLocal: material.kLocal,
    });
    const existingBinding = existing?.version === 2 ? existing.custody : null;
    const reusesExistingBinding = existingBinding !== null && custodyBindingsEqual(existingBinding, binding);

    if (existingBinding !== null && !reusesExistingBinding) {
      const cleanup = await deleteNewCustodyBinding(provider, binding);
      const refusal = custodyCleanupRefusal(
        'The runtime custody provider changed the stable handle for an existing pairing.',
      );
      if (!cleanup.ok) {
        throw new AggregateError(
          [refusal, cleanup.error],
          'Runtime custody refused a changed handle and could not delete the rejected provider entry.',
        );
      }
      throw refusal;
    }
    return { binding, reusesExistingBinding };
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  if (!preparation.ok) {
    if (handle.socketPath === existingBeforePreparation?.socketPath) throw preparation.error;
    const cleanup = await cleanupRejectedRuntimeHandleOutcome(
      handle.socketPath,
      material.userId,
      material.credentialId,
    );
    if (!cleanup.ok) {
      throw new AggregateError(
        [preparation.error, cleanup.error],
        'Runtime custody preparation failed and its candidate key holder could not be cleaned up.',
      );
    }
    throw preparation.error;
  }

  const { binding, reusesExistingBinding } = preparation.value;

  const registration = await registerRuntimePairingRecord(
    material.userId,
    material.credentialId,
    handle,
    2,
    (fields) => ({ version: 2, ...fields, custody: binding }),
  ).then(
    (record) => ({ ok: true as const, record }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (registration.ok) return registration.record;
  if (reusesExistingBinding) throw registration.error;

  const cleanup = await deleteNewCustodyBinding(provider, binding);
  if (!cleanup.ok) {
    throw new AggregateError(
      [registration.error, cleanup.error],
      'Runtime pairing registration failed and its new custody entry could not be deleted.',
    );
  }
  throw registration.error;
}

const RECOVERY_WAIT_TIMEOUT_MS = 2_000;
const RECOVERY_WAIT_INTERVAL_MS = 25;

function recoveryRefusal(message: string): CapyError {
  return new CapyError(message, ERROR_CODES.PERMISSION_DENIED);
}

function readRecoveryRecord(
  request: RuntimePairingRecoveryRequest,
  now: number,
): RuntimePairingRecordV2 | null {
  const state = readRuntimePairingState();
  if (state.kind === 'missing') return null;
  if (state.kind === 'invalid') {
    throw recoveryRefusal(
      'The runtime pairing record is invalid; it was preserved and custody recovery was refused.',
    );
  }
  const record = state.record;
  if (record.version === 1) return null;
  if (record.userId !== request.expectedUserId) {
    throw new CapyError(
      'The runtime custody record belongs to another Capy account.',
      ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
    );
  }
  if (record.custody.environment !== request.environment) {
    throw recoveryRefusal('The runtime custody record belongs to another Capy environment.');
  }
  if (record.expiresAt !== 0 && record.expiresAt <= now) {
    throw new CapyError(
      'The runtime custody record has expired.',
      ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED,
    );
  }
  return record;
}

function runtimePairingV2Equal(
  left: RuntimePairingRecordV2,
  right: RuntimePairingRecordV2,
): boolean {
  return left.version === right.version
    && left.userId === right.userId
    && left.credentialId === right.credentialId
    && left.socketPath === right.socketPath
    && left.expiresAt === right.expiresAt
    && left.pairedAt === right.pairedAt
    && custodyBindingsEqual(left.custody, right.custody);
}

function compareAndSwapRuntimePairingSocket(
  expected: RuntimePairingRecordV2,
  replacement: RuntimePairingRecordV2,
): 'committed' | 'changed' {
  const state = readRuntimePairingState();
  if (
    state.kind !== 'valid'
    || state.record.version !== 2
    || !runtimePairingV2Equal(state.record, expected)
  ) {
    return 'changed';
  }
  writeRuntimePairing(replacement);
  return 'committed';
}

function defaultRecoveryProbe(
  socketPath: string,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  return import('../deviceKey/grantHolder')
    .then(({ isGrantActiveFor }) => isGrantActiveFor(socketPath, userId, credentialId))
    .catch(() => false);
}

function defaultRecoverySpawn(material: RecoveryGrantMaterial): Promise<RuntimePairingHandle> {
  return import('../deviceKey/grantHolder').then(({ spawnGrantDaemon }) => spawnGrantDaemon(
    {
      userId: material.userId,
      credentialId: material.credentialId,
      kLocal: Buffer.from(material.kLocal),
    },
    { ttlMs: null, persistRuntimePairing: false },
  ));
}

async function cleanupRecoveryCandidateAndThrow(
  error: unknown,
  candidate: RuntimePairingHandle,
  record: RuntimePairingRecordV2,
  dependencies: RuntimePairingRecoveryDependencies,
): Promise<never> {
  const cleanup = await (async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      await (dependencies.cleanupCandidate ?? cleanupRejectedRuntimeHandle)(
        candidate.socketPath,
        record.userId,
        record.credentialId,
      );
      return { ok: true };
    } catch (cleanupError) {
      return { ok: false, error: cleanupError };
    }
  })();
  if (!cleanup.ok) {
    throw new AggregateError(
      [error, cleanup.error],
      'Runtime custody recovery failed and its candidate key holder could not be cleaned up.',
    );
  }
  throw error;
}

type RecoveryLeaseAcquisition =
  | { readonly kind: 'lease'; readonly lease: PairAttemptLease }
  | { readonly kind: 'outcome'; readonly outcome: RuntimePairingRecoveryOutcome };

async function waitForRecoveryLeaseOrWinner(
  request: RuntimePairingRecoveryRequest,
  dependencies: RuntimePairingRecoveryDependencies,
  contentionError: unknown,
  deadline: number,
): Promise<RecoveryLeaseAcquisition> {
  const now = (dependencies.now ?? Date.now)();
  const record = readRecoveryRecord(request, now);
  if (!record) return { kind: 'outcome', outcome: { kind: 'not_v2' } };
  const probe = dependencies.probeHolder ?? defaultRecoveryProbe;
  if (await probe(record.socketPath, record.userId, record.credentialId)) {
    return { kind: 'outcome', outcome: { kind: 'reused', record } };
  }
  if (now >= deadline) throw contentionError;
  await (dependencies.wait ?? ((milliseconds) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  )))(RECOVERY_WAIT_INTERVAL_MS);
  const acquired = (() => {
    try {
      return {
        ok: true as const,
        lease: (dependencies.acquireLease ?? acquirePairAttemptLease)(),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  if (acquired.ok) return { kind: 'lease', lease: acquired.lease };
  if (
    acquired.error instanceof CapyError
    && acquired.error.code === ERROR_CODES.PAIR_ALREADY_IN_PROGRESS
  ) {
    return waitForRecoveryLeaseOrWinner(request, dependencies, contentionError, deadline);
  }
  throw acquired.error;
}

async function acquireRecoveryLease(
  request: RuntimePairingRecoveryRequest,
  dependencies: RuntimePairingRecoveryDependencies,
): Promise<RecoveryLeaseAcquisition> {
  const acquired = (() => {
    try {
      return {
        ok: true as const,
        lease: (dependencies.acquireLease ?? acquirePairAttemptLease)(),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  if (acquired.ok) return { kind: 'lease', lease: acquired.lease };
  if (
    !(acquired.error instanceof CapyError)
    || acquired.error.code !== ERROR_CODES.PAIR_ALREADY_IN_PROGRESS
  ) {
    throw acquired.error;
  }
  const now = (dependencies.now ?? Date.now)();
  return waitForRecoveryLeaseOrWinner(
    request,
    dependencies,
    acquired.error,
    now + Math.max(0, dependencies.waitTimeoutMs ?? RECOVERY_WAIT_TIMEOUT_MS),
  );
}

/**
 * Reconstruct a dead process-bound grant from an explicitly selected custody
 * provider. This primitive is intentionally inactive until a CLI composition
 * root supplies both the provider and authoritative environment.
 */
export async function recoverRuntimePairingFromCustody(
  request: RuntimePairingRecoveryRequest,
  dependencies: RuntimePairingRecoveryDependencies = {},
): Promise<RuntimePairingRecoveryOutcome> {
  const now = (dependencies.now ?? Date.now)();
  const record = readRecoveryRecord(request, now);
  if (!record) return { kind: 'not_v2' };
  const probe = dependencies.probeHolder ?? defaultRecoveryProbe;
  if (await probe(record.socketPath, record.userId, record.credentialId)) {
    return { kind: 'active', record };
  }

  const acquisition = await acquireRecoveryLease(request, dependencies);
  if (acquisition.kind === 'outcome') return acquisition.outcome;
  try {
    return await recoverRuntimePairingFromCustodyWhileLeaseHeld(
      request,
      acquisition.lease,
      dependencies,
    );
  } finally {
    (dependencies.releaseLease ?? releasePairAttemptLease)(acquisition.lease);
  }
}

/** Recover while the caller owns the shared pair/recovery/logout lease. */
export async function recoverRuntimePairingFromCustodyWhileLeaseHeld(
  request: RuntimePairingRecoveryRequest,
  _lease: PairAttemptLease,
  dependencies: RuntimePairingRecoveryDependencies = {},
): Promise<RuntimePairingRecoveryOutcome> {
  const ownsLease = dependencies.ownsLease ?? ownsPairAttemptLease;
  if (!ownsLease(_lease)) {
    throw new CapyError(
      'Runtime custody recovery no longer owns the pairing lease.',
      ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    );
  }
  const current = readRecoveryRecord(request, (dependencies.now ?? Date.now)());
  if (!current) return { kind: 'not_v2' };
  const probe = dependencies.probeHolder ?? defaultRecoveryProbe;
  if (await probe(current.socketPath, current.userId, current.credentialId)) {
    return { kind: 'active', record: current };
  }

  const provider = request.resolveProvider(current.custody.providerKind);
  if (!provider || provider.kind !== current.custody.providerKind) {
    throw recoveryRefusal('The recorded runtime custody provider is unavailable.');
  }
  const kLocal = await unsealRuntimeCustody(provider, current.custody, {
    environment: request.environment,
    userId: request.expectedUserId,
  });
  const candidate = await (dependencies.spawnHolder ?? defaultRecoverySpawn)({
    userId: current.userId,
    credentialId: current.credentialId,
    kLocal,
  });
  if (candidate.expiresAt !== 0) {
    return cleanupRecoveryCandidateAndThrow(
      recoveryRefusal('A recovered runtime key holder must be process-bound.'),
      candidate,
      current,
      dependencies,
    );
  }
  const candidateProbe = await probe(candidate.socketPath, current.userId, current.credentialId).then(
    (active) => ({ ok: true as const, active }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!candidateProbe.ok || !candidateProbe.active) {
    return cleanupRecoveryCandidateAndThrow(
      candidateProbe.ok
        ? new CapyError(
            'The recovered runtime key holder was unavailable or belonged to another pairing.',
            ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
          )
        : candidateProbe.error,
      candidate,
      current,
      dependencies,
    );
  }

  if (!ownsLease(_lease)) {
    return cleanupRecoveryCandidateAndThrow(
      new CapyError(
        'Runtime custody recovery lost the pairing lease before metadata commit.',
        ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
      ),
      candidate,
      current,
      dependencies,
    );
  }

  const replacement: RuntimePairingRecordV2 = {
    ...current,
    socketPath: candidate.socketPath,
    expiresAt: candidate.expiresAt,
  };
  const committed = await (async (): Promise<
    { readonly ok: true; readonly result: 'committed' | 'changed' }
    | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      return {
        ok: true,
        result: (dependencies.compareAndSwapSocket ?? compareAndSwapRuntimePairingSocket)(
          current,
          replacement,
        ),
      };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  if (!committed.ok) {
    return cleanupRecoveryCandidateAndThrow(committed.error, candidate, current, dependencies);
  }
  if (committed.result === 'committed') return { kind: 'recovered', record: replacement };

  const cleanup = await (async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  > => {
    try {
      await (dependencies.cleanupCandidate ?? cleanupRejectedRuntimeHandle)(
        candidate.socketPath,
        current.userId,
        current.credentialId,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  if (!cleanup.ok) {
    throw new AggregateError(
      [recoveryRefusal('Runtime pairing metadata changed during recovery.'), cleanup.error],
      'Runtime pairing metadata changed and its candidate key holder could not be cleaned up.',
    );
  }
  const winner = readRecoveryRecord(request, (dependencies.now ?? Date.now)());
  if (!winner) return { kind: 'not_v2' };
  if (await probe(winner.socketPath, winner.userId, winner.credentialId)) {
    return { kind: 'reused', record: winner };
  }
  throw recoveryRefusal('Runtime pairing metadata changed during custody recovery.');
}

/** Clear the metadata binding and stop its daemon best-effort. */
export async function clearRuntimePairing(options: {
  readonly resolveCustodyProvider?: RuntimeCustodyProviderResolver;
  readonly expectedEnvironment?: RuntimeCustodyEnvironment;
  readonly removeMetadata?: (path: string) => void;
  readonly acquireLease?: () => PairAttemptLease;
  readonly ownsLease?: (lease: PairAttemptLease) => boolean;
  readonly releaseLease?: (lease: PairAttemptLease) => boolean;
} = {}): Promise<boolean> {
  const lease = (options.acquireLease ?? acquirePairAttemptLease)();
  try {
    if (!(options.ownsLease ?? ownsPairAttemptLease)(lease)) {
      throw new CapyError(
        'Runtime pairing cleanup no longer owns the pairing lease.',
        ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
      );
    }
    return await clearRuntimePairingWhileLeaseHeld(options, lease);
  } finally {
    (options.releaseLease ?? releasePairAttemptLease)(lease);
  }
}

async function clearRuntimePairingWhileLeaseHeld(options: {
  readonly resolveCustodyProvider?: RuntimeCustodyProviderResolver;
  readonly expectedEnvironment?: RuntimeCustodyEnvironment;
  readonly removeMetadata?: (path: string) => void;
  readonly ownsLease?: (lease: PairAttemptLease) => boolean;
}, lease: PairAttemptLease): Promise<boolean> {
  const state = readRuntimePairingState();
  if (state.kind === 'invalid') {
    throw custodyCleanupRefusal(
      'The runtime pairing record is invalid; it was preserved so custody can be repaired safely.',
    );
  }
  const existing = state.kind === 'valid' ? state.record : null;
  const path = getRuntimePairingPath();
  const existed = existsSync(path);
  if (existing?.version === 2) {
    if (options.expectedEnvironment !== existing.custody.environment) {
      throw custodyCleanupRefusal(
        'The runtime custody binding does not match this CLI environment; pairing metadata was preserved.',
      );
    }
    const provider = options.resolveCustodyProvider?.(existing.custody.providerKind) ?? null;
    if (!provider) {
      throw custodyCleanupRefusal('The runtime custody provider is unavailable; pairing metadata was preserved.');
    }
    await deleteRuntimeCustody(provider, existing.custody, {
      environment: existing.custody.environment,
      userId: existing.userId,
    });
  }
  if (!(options.ownsLease ?? ownsPairAttemptLease)(lease)) {
    throw new CapyError(
      'Runtime pairing cleanup lost the pairing lease before metadata removal.',
      ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    );
  }
  if (existing) await requestDaemonShutdown(existing.socketPath);
  try {
    (options.removeMetadata ?? ((metadataPath) => rmSync(metadataPath, { force: true })))(path);
  } catch (error) {
    if (existing?.version === 2) throw error;
    return false;
  }
  return existed;
}

function custodyCleanupRefusal(message: string): CapyError {
  return new CapyError(message, ERROR_CODES.PERMISSION_DENIED);
}

const custodyDigest = (key: Buffer): string => createHash('sha256').update(key).digest('hex');
const custodyId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

function isFilesystemCustody(value: unknown): value is FilesystemPairingCustody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return ['development', 'staging', 'production'].includes(String(candidate.environment))
    && custodyId(candidate.orgId) && typeof candidate.path === 'string'
    && typeof candidate.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.sha256);
}

function protectedFilesystemKey(path: string): Buffer {
  try {
    assertCustodyDirectories(path);
    const stat = lstatSync(path);
    const parent = lstatSync(dirname(path));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !parent.isDirectory()
      || (parent.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw recoveryRefusal('Runtime custody permissions are invalid.');
    }
    const text = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32 || key.toString('base64') !== text) throw recoveryRefusal('Runtime custody is invalid.');
    return key;
  } catch {
    throw recoveryRefusal('Runtime custody is missing, corrupt, or not protected. Pair this machine again.');
  }
}

function assertCustodyDirectories(path: string): void {
  const home = getGlobalCapyDir();
  const parts = relative(home, dirname(path)).split(sep);
  if (parts.includes('..')) throw recoveryRefusal('Runtime custody escaped its protected home.');
  const directories = [home, ...parts.map((_part, index) => join(home, ...parts.slice(0, index + 1)))];
  for (const directory of directories) {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw recoveryRefusal('Runtime custody directory is not protected.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export interface FilesystemPairingRequest {
  readonly environment: RuntimeCustodyEnvironment;
  readonly expectedUserId: string;
}

function readFilesystemPairing(request: FilesystemPairingRequest): RuntimePairingRecordV1 | null {
  if (!custodyId(request.expectedUserId)) throw recoveryRefusal('Runtime pairing account is invalid.');
  const record = assertRuntimePairingUser(request.expectedUserId);
  if (record?.version !== 1 || !record.filesystemCustody) return null;
  const binding = record.filesystemCustody;
  const stat = lstatSync(getRuntimePairingPath());
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !custodyId(record.userId)
    || binding.environment !== request.environment
    || binding.path !== getLocalRootPath(binding.orgId, record.userId)
    || record.expiresAt !== 0) throw recoveryRefusal('The filesystem pairing binding is invalid for this runtime.');
  return record;
}

/** The caller holds the pairing lease. Custody location is not repository attribution. */
export async function registerFilesystemRuntimePairing(
  environment: RuntimeCustodyEnvironment,
  orgId: string,
  material: { readonly userId: string; readonly credentialId: string; readonly kLocal: Buffer },
  handle: RuntimePairingHandle,
): Promise<RuntimePairingRecordV1> {
  const prepared = await (async () => {
    try {
      const existing = assertRuntimePairingUser(material.userId);
      if (!['development', 'staging', 'production'].includes(environment)
        || !custodyId(orgId) || !custodyId(material.userId) || material.kLocal.length !== 32
        || handle.expiresAt !== 0 || existing?.version === 2) throw recoveryRefusal('Filesystem pairing custody was refused.');
      const path = getLocalRootPath(orgId, material.userId);
      const binding: FilesystemPairingCustody = { environment, orgId, path, sha256: custodyDigest(material.kLocal) };
      if (existing?.filesystemCustody && JSON.stringify(existing.filesystemCustody) !== JSON.stringify(binding)) {
        throw recoveryRefusal('The existing runtime custody binding cannot be replaced implicitly.');
      }
      assertCustodyDirectories(path);
      saveLocalRootExclusive(orgId, material.kLocal, material.userId);
      if (custodyDigest(protectedFilesystemKey(path)) !== binding.sha256) {
        throw recoveryRefusal('The existing local key does not match the approved pairing.');
      }
      if (!await defaultRecoveryProbe(handle.socketPath, material.userId, material.credentialId)) {
        throw recoveryRefusal('The runtime key holder identity could not be verified.');
      }
      return { ok: true as const, binding };
    } catch (error) { return { ok: false as const, error }; }
  })();
  if (!prepared.ok) {
    if (readRuntimePairing()?.socketPath !== handle.socketPath) {
      await cleanupRejectedRuntimeHandle(handle.socketPath, material.userId, material.credentialId);
    }
    throw prepared.error;
  }
  return registerRuntimePairingRecord(material.userId, material.credentialId, handle, 1,
    (fields) => ({ version: 1, ...fields, filesystemCustody: prepared.binding }));
}

/** Restores only an explicit durable binding, never merely a surviving local.key. */
export async function recoverFilesystemRuntimePairing(
  request: FilesystemPairingRequest,
  dependencies: RuntimePairingRecoveryDependencies = {},
): Promise<RuntimePairingRecordV1 | null> {
  if (!readFilesystemPairing(request)) return null;
  const deadline = (dependencies.now ?? Date.now)() + (dependencies.waitTimeoutMs ?? RECOVERY_WAIT_TIMEOUT_MS);
  const lease = await acquireFilesystemRecoveryLease(dependencies, deadline);
  try { return await recoverFilesystemRuntimePairingWhileLeaseHeld(request, lease, dependencies); }
  finally { (dependencies.releaseLease ?? releasePairAttemptLease)(lease); }
}

async function acquireFilesystemRecoveryLease(
  dependencies: RuntimePairingRecoveryDependencies,
  deadline: number,
): Promise<PairAttemptLease> {
  const attempt = (() => {
    try { return { ok: true as const, lease: (dependencies.acquireLease ?? acquirePairAttemptLease)() }; }
    catch (error) { return { ok: false as const, error }; }
  })();
  if (attempt.ok) return attempt.lease;
  const now = (dependencies.now ?? Date.now)();
  if (!(attempt.error instanceof CapyError) || attempt.error.code !== ERROR_CODES.PAIR_ALREADY_IN_PROGRESS
    || now >= deadline) throw attempt.error;
  await (dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
    Math.min(RECOVERY_WAIT_INTERVAL_MS, deadline - now),
  );
  return acquireFilesystemRecoveryLease(dependencies, deadline);
}

export async function recoverFilesystemRuntimePairingWhileLeaseHeld(
  request: FilesystemPairingRequest,
  lease: PairAttemptLease,
  dependencies: RuntimePairingRecoveryDependencies = {},
): Promise<RuntimePairingRecordV1 | null> {
  const ownsLease = dependencies.ownsLease ?? ownsPairAttemptLease;
  if (!ownsLease(lease)) throw recoveryRefusal('Runtime pairing recovery does not own its lease.');
  const record = readFilesystemPairing(request);
  if (!record?.filesystemCustody) return null;
  const key = protectedFilesystemKey(record.filesystemCustody.path);
  if (custodyDigest(key) !== record.filesystemCustody.sha256) throw recoveryRefusal('Runtime custody no longer matches this pairing.');
  const probe = dependencies.probeHolder ?? defaultRecoveryProbe;
  if (await probe(record.socketPath, record.userId, record.credentialId)) return record;
  const candidate = await (dependencies.spawnHolder ?? defaultRecoverySpawn)({
    userId: record.userId, credentialId: record.credentialId, kLocal: key,
  });
  try {
    if (candidate.expiresAt !== 0 || !await probe(candidate.socketPath, record.userId, record.credentialId)
      || !ownsLease(lease) || JSON.stringify(readFilesystemPairing(request)) !== JSON.stringify(record)) {
      throw recoveryRefusal('Runtime pairing changed during holder restoration.');
    }
    const replacement = { ...record, socketPath: candidate.socketPath };
    writeRuntimePairing(replacement);
    return replacement;
  } catch (error) {
    // Never shut down a protected existing socket supplied by a faulty spawner.
    if (candidate.socketPath !== record.socketPath) {
      await (dependencies.cleanupCandidate ?? cleanupRejectedRuntimeHandle)(candidate.socketPath, record.userId, record.credentialId);
    }
    throw error;
  }
}
