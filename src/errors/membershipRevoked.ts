/**
 * Gate for destructive local-state cleanup on membership revocation.
 *
 * `cleanupOrgData` wipes `key.enc`, the per-user dir, and the project key
 * cache for an org. That wrapped master key is recovery-equivalent state —
 * deleting it on the wrong signal is irrecoverable without a 24-word seed.
 *
 * The server emits `code: 'MEMBERSHIP_REVOKED'` in the 403 body ONLY when a
 * membership row has `reason === 'revoked'`. Every other 403 path in the
 * service (route-level token-scope mismatch, redundant in-handler member
 * rechecks, branch-level RBAC denials, transient WorkOS lookup failures
 * that fail closed) intentionally omits this code. This predicate is the
 * single gate; both call sites in `capyCommand.ts` use it so the rule
 * lives in exactly one place.
 *
 * Defense-in-depth: the predicate checks `instanceof CapyError`, the
 * top-level `code === PERMISSION_DENIED`, AND the literal string match on
 * `details.code`. A non-string `details.code` (object, true, number) fails
 * the strict `===` — that's the spoofed-wipe guard the v0.3.2 spec called
 * out.
 */
import { CapyError, ERROR_CODES } from '../types/index';

export function isMembershipRevokedError(err: unknown): boolean {
  if (!(err instanceof CapyError)) return false;
  if (err.code !== ERROR_CODES.PERMISSION_DENIED) return false;
  return err.details?.code === 'MEMBERSHIP_REVOKED';
}
