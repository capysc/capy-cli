import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync,
  readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { lock, lockSync } from 'proper-lockfile';
import { SessionStore } from '../../types/index';
import {
  getAuthSessionPath,
  getGlobalCapyDir,
} from '../../config/globalConfig';
import { DiscoveredSession, FencedSessionIdentityProof, SessionStorageBackend } from './backend';
import {
  currentRefreshRotationContext,
  runWithRefreshRotationContext,
} from './refreshContext';
import {
  currentVerifiedAuthInstallationContext,
  runWithVerifiedAuthInstallation,
} from './authInstallationContext';

const FENCE_LIMIT = 16 * 1024;
type RefreshFence = Readonly<{
  v: 1;
  id: string;
  user_id: string;
  authority_sha256: string;
  started_at: string;
  phase: 'in_flight' | 'persisting';
}>;
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const fencePath = (userId: string | undefined): string => `${getAuthSessionPath(userId)}.refresh-in-flight`;

const readProtectedSession = (userId: string | undefined): SessionStore | null => {
  const path = getAuthSessionPath(userId);
  const descriptor = (() => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? (error as Readonly<{ code?: unknown }>).code
        : null;
      if (code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (descriptor === null) return null;
  try {
    const metadata = fstatSync(descriptor);
    const expectedUser = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.uid !== expectedUser || (metadata.mode & 0o777) !== 0o600
      || !Number.isSafeInteger(metadata.size) || metadata.size <= 0) {
      throw new Error('AUTH_SESSION_FILE_INVALID');
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== metadata.size) throw new Error('AUTH_SESSION_FILE_INVALID');
    const parsed = (() => {
      try { return JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown; } catch { return null; }
    })();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AUTH_SESSION_FILE_INVALID');
    }
    return parsed as SessionStore;
  } finally {
    closeSync(descriptor);
  }
};

const validFence = (value: unknown): value is RefreshFence => {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
  return record !== null && record.v === 1
    && typeof record.id === 'string' && /^[0-9a-f-]{36}$/iu.test(record.id)
    && typeof record.user_id === 'string' && record.user_id.length > 0
    && typeof record.authority_sha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.authority_sha256)
    && typeof record.started_at === 'string'
    && (record.phase === 'in_flight' || record.phase === 'persisting');
};

const readFence = (userId: string | undefined): RefreshFence | null => {
  const path = fencePath(userId);
  const descriptor = (() => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? (error as Readonly<{ code?: unknown }>).code
        : null;
      if (code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (descriptor === null) return null;
  try {
    const metadata = fstatSync(descriptor);
    const expectedUser = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.uid !== expectedUser || (metadata.mode & 0o777) !== 0o600
      || metadata.size <= 0 || metadata.size > FENCE_LIMIT) throw new Error('AUTH_REFRESH_FENCE_INVALID');
    const bytes = Buffer.alloc(metadata.size + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== metadata.size) throw new Error('AUTH_REFRESH_FENCE_INVALID');
    const parsed = (() => {
      try { return JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown; } catch { return null; }
    })();
    if (!validFence(parsed)) throw new Error('AUTH_REFRESH_FENCE_INVALID');
    return parsed;
  } finally {
    closeSync(descriptor);
  }
};

const writeFence = (userId: string | undefined, value: RefreshFence): void => {
  const path = fencePath(userId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve original */ }
    throw error;
  }
};

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};

const removeFenceDurably = (userId: string | undefined): void => {
  const path = fencePath(userId);
  if (!existsSync(path)) return;
  unlinkSync(path);
  syncDirectory(dirname(path));
};

const ensureSessionParent = (userId: string | undefined): string => {
  const sessionPath = getAuthSessionPath(userId);
  mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 });
  return sessionPath;
};

const withStableSessionLockSync = <T>(
  userId: string | undefined,
  run: (sessionPath: string) => T,
): T => {
  const sessionPath = ensureSessionParent(userId);
  const release = (() => {
    try {
      return lockSync(sessionPath, { realpath: false });
    } catch {
      throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    }
  })();
  try {
    return run(sessionPath);
  } finally {
    release();
  }
};

const sessionMatches = (left: SessionStore | null, right: SessionStore): boolean =>
  left !== null && JSON.stringify(left) === JSON.stringify(right);

const saveSessionDurably = (session: SessionStore, userId: string | undefined): void => {
  const path = getAuthSessionPath(userId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(session, null, 2));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve original */ }
    throw error;
  }
};

/**
 * The ~/.capy file backend. It preserves the historical session path and JSON
 * shape while adding durable refresh fencing and authority-aware writes.
 *
 * Paths and legacy reads use src/config/globalConfig.ts's auth-session
 * helpers; this module owns protected, durable session/fence writes and their
 * lock. It never touches key material (see backend.ts's bright line).
 */
export class FileSessionStorageBackend implements SessionStorageBackend {
  assertRefreshAuthorityAvailable(userId: string | undefined): void {
    withStableSessionLockSync(userId, () => {
      if (readFence(userId)) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });
  }

  getFencedIdentityProof(userId: string): FencedSessionIdentityProof | null {
    return withStableSessionLockSync(userId, () => {
      const fence = readFence(userId);
      const session = readProtectedSession(userId);
      const priorAccessToken = session?.identity_session?.access_token
        ?? Object.values(session?.sessions ?? {}).map((entry) => entry.access_token).find(Boolean);
      const currentDigest = session?.refresh_token ? digest(session.refresh_token) : null;
      if (!fence || fence.user_id !== userId || session?.user_id !== userId
        || currentDigest !== fence.authority_sha256 || !priorAccessToken) return null;
      return {
        userId,
        refreshAuthoritySha256: fence.authority_sha256,
        fenceId: fence.id,
        priorAccessToken,
      };
    });
  }

  load(userId: string | undefined): SessionStore | null {
    return withStableSessionLockSync(userId, () => {
      if (readFence(userId)) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      return readProtectedSession(userId);
    });
  }

  save(session: SessionStore, userId: string | undefined): void {
    const fence = readFence(userId);
    const verifiedInstallation = currentVerifiedAuthInstallationContext();
    if (fence) {
      const context = currentRefreshRotationContext();
      // WorkOS may return the same refresh token. The held refresh context,
      // durable write and readback establish completion, not token inequality.
      if (!context || context.fenceId !== fence.id || !session.refresh_token) {
        verifiedInstallation?.settle({ ok: false });
        throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      }
      writeFence(userId, { ...fence, phase: 'persisting' });
      saveSessionDurably(session, userId);
      const readback = readProtectedSession(userId);
      if (!sessionMatches(readback, session)) {
        throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      }
      removeFenceDurably(userId);
      return;
    }
    const attempted = (() => {
      try {
        if (currentRefreshRotationContext()) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
        withStableSessionLockSync(userId, () => {
          if (readFence(userId)) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
          const current = readProtectedSession(userId);
          const currentDigest = current?.refresh_token ? digest(current.refresh_token) : null;
          if (verifiedInstallation) {
            if (userId !== verifiedInstallation.userId || session.user_id !== verifiedInstallation.userId
              || currentDigest !== verifiedInstallation.expectedRefreshAuthoritySha256) {
              throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
            }
          } else if (current && currentDigest !== digest(session.refresh_token)) {
            throw new Error('AUTH_REFRESH_AUTHORITY_CHANGED');
          }
          saveSessionDurably(session, userId);
          if (!sessionMatches(readProtectedSession(userId), session)) {
            throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
          }
        });
        return { ok: true as const };
      } catch (cause) {
        return { ok: false as const, cause };
      }
    })();
    verifiedInstallation?.settle(attempted.ok ? { ok: true } : { ok: false });
    if (!attempted.ok) throw attempted.cause;
  }

  async withVerifiedAuthInstallation<T>(
    userId: string,
    expectedRefreshAuthoritySha256: string | null,
    run: () => Promise<T>,
  ): Promise<T> {
    if (currentRefreshRotationContext() || currentVerifiedAuthInstallationContext()) {
      throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    }
    const result = await runWithVerifiedAuthInstallation({ userId, expectedRefreshAuthoritySha256, run });
    this.assertRefreshAuthorityAvailable(userId);
    return result;
  }

  saveIfRefreshAuthorityMatches(
    session: SessionStore,
    userId: string | undefined,
    expectedRefreshAuthoritySha256: string | null,
  ): boolean {
    return withStableSessionLockSync(userId, () => {
      if (readFence(userId)) return false;
      const current = readProtectedSession(userId);
      const currentDigest = current?.refresh_token ? digest(current.refresh_token) : null;
      if (currentDigest !== expectedRefreshAuthoritySha256) return false;
      saveSessionDurably(session, userId);
      const readback = readProtectedSession(userId);
      return sessionMatches(readback, session);
    });
  }

  clear(userId: string | undefined): void {
    withStableSessionLockSync(userId, (sessionPath) => {
      if (existsSync(sessionPath)) {
        unlinkSync(sessionPath);
        syncDirectory(dirname(sessionPath));
      }
      removeFenceDurably(userId);
    });
  }

  retireDeletedUserIfRefreshAuthorityMatches(
    userId: string,
    expectedRefreshAuthoritySha256: string,
  ): boolean {
    return withStableSessionLockSync(userId, (sessionPath) => {
      const current = readProtectedSession(userId);
      const currentDigest = current?.refresh_token ? digest(current.refresh_token) : null;
      if (current?.user_id !== userId || currentDigest !== expectedRefreshAuthoritySha256) return false;
      if (existsSync(sessionPath)) {
        unlinkSync(sessionPath);
        syncDirectory(dirname(sessionPath));
      }
      removeFenceDurably(userId);
      return true;
    });
  }

  retireFencedDeletedUserIfMatches(
    userId: string,
    expectedRefreshAuthoritySha256: string,
    expectedFenceId: string,
  ): boolean {
    return withStableSessionLockSync(userId, (sessionPath) => {
      const fence = readFence(userId);
      const current = readProtectedSession(userId);
      const currentDigest = current?.refresh_token ? digest(current.refresh_token) : null;
      if (!fence || fence.id !== expectedFenceId || fence.user_id !== userId
        || fence.authority_sha256 !== expectedRefreshAuthoritySha256
        || current?.user_id !== userId || currentDigest !== expectedRefreshAuthoritySha256) return false;
      if (existsSync(sessionPath)) {
        unlinkSync(sessionPath);
        syncDirectory(dirname(sessionPath));
      }
      removeFenceDurably(userId);
      return true;
    });
  }

  discover(): DiscoveredSession | null {
    // Scan ~/.capy/auth/sessions/ for any existing session file. This handles
    // the post-redeem flow where the invitee runs `capy` in a new project
    // directory that has no sync-state (and thus no userId hint).
    const sessionsDir = join(getGlobalCapyDir(), 'auth', 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const userId = file.replace('.json', '');
        const data = this.load(userId);
        // Skip stale files where the filename user_id disagrees with the
        // content user_id — a prior refresh wrote new user data to the
        // old path, leaving a snapshot that disagrees with the
        // authoritative per-user file.
        if (data && data.version === 2 && data.user_id === userId) {
          return { userId, session: data };
        }
      } catch {
        // Skip invalid files
      }
    }
    return null;
  }

  async withRefreshLock<T>(
    userId: string | undefined,
    fn: (fresh: SessionStore | null, beginRotation: () => void) => Promise<T>,
  ): Promise<T> {
    const sessionPath = ensureSessionParent(userId);
    const release = await lock(sessionPath, {
      realpath: false,
      retries: { retries: 3, minTimeout: 100 },
    }).catch(() => {
      throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
    });
    try {
      if (readFence(userId)) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      const fresh = readProtectedSession(userId);
      if (!fresh?.refresh_token) throw new Error('AUTH_REFRESH_AUTHORITY_MISSING');
      const fence: RefreshFence = {
        v: 1,
        id: randomUUID(),
        user_id: fresh.user_id,
        authority_sha256: digest(fresh.refresh_token),
        started_at: new Date().toISOString(),
        phase: 'in_flight',
      };
      const beginRotation = (): void => {
        const existing = readFence(userId);
        if (existing?.id === fence.id) return;
        if (existing) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
        writeFence(userId, fence);
      };
      const result = await runWithRefreshRotationContext(
        { fenceId: fence.id, beginRotation },
        () => fn(fresh, beginRotation),
      ).catch((error) => {
        const code = error !== null && typeof error === 'object' && 'code' in error
          ? (error as Readonly<{ code?: unknown }>).code
          : null;
        if (code === 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH' || code === 'AUTH_USER_DELETED') removeFenceDurably(userId);
        throw error;
      });
      if (readFence(userId)) throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
      return result;
    } finally {
      await release();
    }
  }
}
