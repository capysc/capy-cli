import { SessionStore } from '../../types/index';

/**
 * A session found by `SessionStorageBackend.discover()` — the stored session
 * plus the user scope it was found under.
 */
export interface DiscoveredSession {
  userId: string;
  session: SessionStore;
}

/**
 * Where auth sessions live. `SessionLifecycle` owns every decision about a
 * session (refresh, expiry, org resolution, validation); a backend owns only
 * where the bytes are and how concurrent writers are kept from trampling each
 * other. The first implementation is `FileSessionStorageBackend`
 * (~/.capy/auth/sessions/<userId>.json). Phase 2 adds an MCP-supplied
 * backend that holds the session in memory — injected via the `AuthService`
 * constructor, no file system involved.
 *
 * BRIGHT LINE: this interface carries AUTH MATERIAL ONLY — sessions, tokens,
 * org context. No implementation may read or write key material (local.key,
 * key.enc, project keys). Key storage lives in src/crypto/ and
 * src/config/globalConfig.ts's key helpers, deliberately out of reach of this
 * module.
 */
export interface SessionStorageBackend {
  /**
   * Read the persisted session for `userId` (or the backend's unscoped
   * default when undefined). Returns null when no session exists. May throw
   * on corrupt data — the lifecycle treats a throw the same as "no session".
   */
  load(userId: string | undefined): SessionStore | null;

  /** Persist the session under `userId`'s scope. */
  save(session: SessionStore, userId: string | undefined): void;

  /** Atomically refuse a hosted install when the persisted refresh authority changed. */
  saveIfRefreshAuthorityMatches?(
    session: SessionStore,
    userId: string | undefined,
    expectedRefreshAuthoritySha256: string | null,
  ): boolean;

  /** Refuse cached authority while a prior refresh outcome remains fenced. */
  assertRefreshAuthorityAvailable?(userId: string | undefined): void;

  /** Verify a provider-authenticated authority replacement was durably installed. */
  withVerifiedAuthInstallation?<T>(
    userId: string,
    expectedRefreshAuthoritySha256: string | null,
    run: () => Promise<T>,
  ): Promise<T>;

  /** Remove the persisted session for `userId`. A missing session is a no-op. */
  clear(userId: string | undefined): void;

  /**
   * Retire only the precise session authority WorkOS confirmed deleted.
   * A changed session (including a concurrent sign-in) remains untouched.
   */
  retireDeletedUserIfRefreshAuthorityMatches?(
    userId: string,
    expectedRefreshAuthoritySha256: string,
  ): boolean;

  /**
   * Locate a session when the caller has no userId hint (e.g. the post-redeem
   * flow where a fresh checkout has no sync-state). Only sessions whose
   * storage scope agrees with the content's `user_id` may be returned — a
   * stale snapshot under the wrong name is not an identity. Returns null when
   * nothing valid exists.
   */
  discover(): DiscoveredSession | null;

  /**
   * Serialize a token refresh against concurrent writers, then run `fn`.
   *
   * `fn` receives the freshest persisted session re-read under mutual
   * exclusion and an idempotent callback that must run immediately before a
   * provider request can rotate its refresh authority. Missing persistence or
   * an unavailable lock is a refusal. The lifecycle uses the fresh copy for
   * the adopt-don't-race dance: if another process already refreshed the org,
   * its work is adopted instead of burning the rotated refresh token.
   *
   * The file backend implements this with proper-lockfile on a stable session
   * path even before the session file exists. An in-memory backend may pass
   * its current session directly. The lock must be released whether `fn`
   * resolves or throws.
   */
  withRefreshLock<T>(
    userId: string | undefined,
    fn: (fresh: SessionStore | null, beginRotation: () => void) => Promise<T>,
  ): Promise<T>;
}
