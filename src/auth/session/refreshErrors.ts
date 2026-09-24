/**
 * Typed refresh-authority refusals. Callers branch on the class (never the
 * message); each message is kept equal to its code so existing callers and
 * results that surface `error.message` read exactly as before.
 */

/**
 * A durable refresh fence already existed for this user before any provider
 * request could start. The stored refresh token may have been consumed by an
 * earlier process, so it must never be sent again.
 */
export class RefreshFencedError extends Error {
  readonly code = 'AUTH_REFRESH_AUTHORITY_INDETERMINATE';

  constructor() {
    super('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  }
}

/**
 * The session lock could not be acquired. Another process may be mid-rotation,
 * so this is never permission to clear a session or its fence.
 */
export class RefreshLockUnavailableError extends Error {
  readonly code = 'AUTH_REFRESH_LOCK_UNAVAILABLE';

  constructor() {
    super('AUTH_REFRESH_LOCK_UNAVAILABLE');
  }
}
