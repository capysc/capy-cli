/**
 * CAP-383 — builds a valid on-disk `SessionStore` (v2) and matching unsigned
 * "JWT" access tokens for tests that need a real, silently-authenticatable
 * session — no OAuth round trip, no network. `AuthService.authenticateSilent`
 * only ever base64-decodes the access token's payload client-side
 * (`decodeJwtPayload`, `src/auth/session/lifecycle.ts`) — it never verifies a
 * signature — so an unsigned three-part token with the right `org_id` claim
 * is indistinguishable from a real one to every code path these tests drive.
 *
 * `capy_org_id` is a claim these tests mint (never a real WorkOS claim); only
 * `tests/helpers/fakeWrapperService.ts`'s KMS/wrapper stub reads it, to
 * resolve which org a key_enc upload belongs to (the real service reads that
 * from ITS OWN verified JWT — this is this fixture's substitute for that).
 */
import { getAuthSessionPath, saveAuthSession } from '../../src/config/globalConfig';

export interface FakeOrg {
  id: string;
  workos_org_id: string;
  name: string;
}

export function fakeAccessToken(org: FakeOrg, extraClaims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ org_id: org.workos_org_id, capy_org_id: org.id, ...extraClaims }),
  ).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

/**
 * Writes `auth/sessions/<userId>.json` under the CURRENT (test-controlled)
 * home directory via the real `globalConfig` helpers — same file, same
 * format, same 0600 mode a genuine OAuth exchange would produce. Returns the
 * session object written, so a test can also compute a matching access token
 * for a second org, etc.
 */
export function writeFakeSession(opts: {
  userId: string;
  userEmail?: string;
  organizations: FakeOrg[];
  /** Override the access token minted for a specific org id. */
  accessTokenOverrides?: Record<string, string>;
  expiresInMs?: number;
  refreshToken?: string;
}): { sessionPath: string } {
  const expiresAt = Date.now() + (opts.expiresInMs ?? 3_600_000);
  const sessions: Record<string, { access_token: string; expires_at: number }> = {};
  for (const org of opts.organizations) {
    sessions[org.id] = {
      access_token: opts.accessTokenOverrides?.[org.id] ?? fakeAccessToken(org),
      expires_at: expiresAt,
    };
  }
  const session = {
    version: 2 as const,
    user_id: opts.userId,
    user_email: opts.userEmail,
    refresh_token: opts.refreshToken ?? 'test-refresh-token',
    organizations: opts.organizations,
    sessions,
  };
  saveAuthSession(session, opts.userId);
  return { sessionPath: getAuthSessionPath(opts.userId) };
}
