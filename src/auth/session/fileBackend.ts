import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { lockSync } from 'proper-lockfile';
import { SessionStore } from '../../types/index';
import {
  saveAuthSession,
  readAuthSession,
  getAuthSessionPath,
  getGlobalCapyDir,
} from '../../config/globalConfig';
import { DiscoveredSession, SessionStorageBackend } from './backend';

/**
 * The ~/.capy file backend — the storage half of the pre-extraction
 * AuthService, moved here verbatim. Paths, file shape, permissions (0600
 * files / 0700 dirs via globalConfig.writeSecureFile), and the
 * proper-lockfile semantics are byte-for-byte what AuthService did before the
 * extraction; tests/auth/sessionIsolation.test.ts pins the on-disk contract.
 *
 * All I/O flows through src/config/globalConfig.ts's auth-session helpers —
 * this module never touches key material (see backend.ts's bright line).
 */
export class FileSessionStorageBackend implements SessionStorageBackend {
  load(userId: string | undefined): SessionStore | null {
    return readAuthSession(userId) as SessionStore | null;
  }

  save(session: SessionStore, userId: string | undefined): void {
    saveAuthSession(session, userId);
  }

  clear(userId: string | undefined): void {
    const sessionPath = getAuthSessionPath(userId);
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
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
        const data = readAuthSession(userId) as SessionStore | null;
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
    fn: (fresh: SessionStore | null) => Promise<T>,
  ): Promise<T> {
    const sessionPath = getAuthSessionPath(userId);
    let release: (() => void) | null = null;

    // Acquire file lock to prevent concurrent refresh races.
    //
    // KNOWN BUG, PRESERVED VERBATIM: proper-lockfile's sync API rejects the
    // `retries` option ("Cannot use retries with the sync api"), so this call
    // has always thrown and the catch has always swallowed it — the lock is
    // never held and `fn` gets no exclusive re-read. The CAP-377 extraction
    // must not change CLI behavior, so the call is kept exactly as it was;
    // fixing it (async lock(), or dropping retries) is now a backend-local
    // one-liner behind a stable interface. tests/auth/sessionFileBackend.test.ts
    // pins today's actual semantics.
    try {
      release = lockSync(sessionPath, { retries: { retries: 3, minTimeout: 100 } });
    } catch {
      // If locking fails (file doesn't exist yet, etc.), proceed without lock
    }

    try {
      // Re-read session from disk in case another process updated it. Only
      // meaningful under the lock — without it there is no exclusive view.
      const fresh = release ? (readAuthSession(userId) as SessionStore | null) : null;
      return await fn(fresh);
    } finally {
      if (release) {
        try { release(); } catch { /* ignore */ }
      }
    }
  }
}
