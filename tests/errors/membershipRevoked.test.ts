/**
 * Tests for the destructive-cleanup gate. cleanupOrgData wipes recovery-
 * equivalent state on confirmed kicks; ALL other 403 shapes must NOT
 * trigger it. Each test pins one 403 shape (or non-403 error) the codebase
 * can plausibly produce, and asserts the predicate's verdict.
 *
 * If a future change relaxes the predicate, one or more of these tests
 * should fail loudly — that's the point.
 */
import { describe, test, expect } from 'bun:test';
import { isMembershipRevokedError } from '../../src/errors/membershipRevoked';
import { CapyError, ERROR_CODES } from '../../src/types/index';

describe('isMembershipRevokedError — confirmed-kick gate', () => {
  test('TRUE for canonical revoked-membership 403 from serviceClient', () => {
    const err = new CapyError(
      'You are no longer a member of this organization',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, code: 'MEMBERSHIP_REVOKED' },
    );
    expect(isMembershipRevokedError(err)).toBe(true);
  });

  // ── Negative cases: every other 403 the codebase can produce ─────────

  test('FALSE for bare 403 with no code (token-scope mismatch path)', () => {
    // routes/orgs.ts:346 emits this shape — auth middleware says the
    // request token doesn't scope to the requested org. NOT a kick.
    const err = new CapyError(
      'Not authorized for this organization',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403 },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE for in-handler 403 redundant member rechecks', () => {
    // routes/orgs.ts redundant checks at :357 / :417 / :486 — server-side
    // belt-and-suspenders. These intentionally omit the code field.
    const err = new CapyError(
      'Insufficient permissions',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, error: 'Insufficient permissions' },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE for branch-level RBAC denial (user is in org, just not this branch)', () => {
    // Demotion scenario: user was Project Admin with protected-branch
    // access, then downgraded to Member. capyCommand.ts:1167+ already
    // handles this — but it must NOT route through cleanup either way.
    const err = new CapyError(
      'No access to branch "production" — your role does not permit reading this branch.',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, code: 'BRANCH_RBAC_DENIED' },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE for transient WorkOS lookup failure (auth middleware fails closed)', () => {
    // The auth middleware fails closed on a WorkOS API hiccup → 403.
    // No `code` is emitted because the server can't distinguish "not a
    // member" from "WorkOS unreachable." Treating this as a kick would be
    // catastrophic — the user IS a member; WorkOS is just having a moment.
    const err = new CapyError(
      'Authorization check failed',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403 },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  // ── Defense in depth: spoofed code shapes ────────────────────────────

  test('FALSE when details.code is a non-string truthy value (object)', () => {
    // The serviceClient 403-threading test asserts non-string codes are
    // discarded, but defense in depth: even if a malicious or buggy server
    // smuggles { code: { admin: true } } through, the predicate's strict
    // === must reject it.
    const err = new CapyError(
      'spoof attempt',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, code: { fake: 'MEMBERSHIP_REVOKED' } as any },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE when details.code is true (boolean coercion guard)', () => {
    const err = new CapyError(
      'spoof attempt',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, code: true as any },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE when details.code is 1 (number coercion guard)', () => {
    const err = new CapyError(
      'spoof attempt',
      ERROR_CODES.PERMISSION_DENIED,
      { status: 403, code: 1 as any },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE when details.code is a different revocation-adjacent string', () => {
    // "REVOKED" alone, "MEMBERSHIP_DENIED", etc. don't match — only the
    // exact server contract token does. Forces deliberate server changes
    // to flow through this gate's tests.
    for (const code of ['REVOKED', 'MEMBERSHIP_DENIED', 'membership_revoked', 'KICKED']) {
      const err = new CapyError('test', ERROR_CODES.PERMISSION_DENIED, { status: 403, code });
      expect(isMembershipRevokedError(err)).toBe(false);
    }
  });

  // ── Non-403 error paths ───────────────────────────────────────────────

  test('FALSE for non-PERMISSION_DENIED CapyError (network error etc.)', () => {
    // A network failure carrying status: 403 is implausible, but if a
    // future code path mis-tagged a NETWORK_ERROR with a PD-shaped detail,
    // the top-level code check is the second line of defense.
    const err = new CapyError(
      'Network unreachable',
      ERROR_CODES.NETWORK_ERROR,
      { status: 403, code: 'MEMBERSHIP_REVOKED' },
    );
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE for a generic Error (not CapyError)', () => {
    const err = new Error('something went wrong');
    expect(isMembershipRevokedError(err)).toBe(false);
  });

  test('FALSE for a plain object that quacks like a CapyError', () => {
    // Duck-typing guard: if some other code path constructs an
    // object-shaped error with the same fields but is not actually a
    // CapyError instance, do not trust it.
    const looksLikeOne = {
      message: 'kicked',
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { status: 403, code: 'MEMBERSHIP_REVOKED' },
    };
    expect(isMembershipRevokedError(looksLikeOne)).toBe(false);
  });

  test('FALSE for null/undefined', () => {
    expect(isMembershipRevokedError(null)).toBe(false);
    expect(isMembershipRevokedError(undefined)).toBe(false);
  });

  test('FALSE when CapyError has no details object at all', () => {
    const err = new CapyError('No details', ERROR_CODES.PERMISSION_DENIED);
    expect(isMembershipRevokedError(err)).toBe(false);
  });
});
