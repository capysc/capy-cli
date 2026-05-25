/**
 * Destructive local cleanup on confirmed membership revocation.
 *
 * Called only when the gate in `../errors/membershipRevoked.ts` returns
 * true. The two production call sites:
 *
 *   - `capyCommand.ts` — sync path catches a `MEMBERSHIP_REVOKED` 403 from
 *     `resolveProjectKey` or the remote fetch and cleans up before
 *     re-throwing.
 *   - `redeemCommand.ts` — redeem path catches a `MEMBERSHIP_REVOKED` 403
 *     during co-decrypt and cleans up before exiting.
 *
 * Both surfaces have the same contract: a kick is confirmed by the server's
 * explicit code; downstream cleanup wipes recovery-equivalent state for the
 * affected (orgId, userId) tuple and nothing else.
 */
import { existsSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getGlobalCapyDir } from '../config/globalConfig';

/**
 * Remove local state for the kicked (orgId, userId) tuple. Strict invariants:
 *
 *   - Deletes `~/.capy/orgs/<orgId>/users/<userId>/` (wrapped master key +
 *     anything else under that user's per-org dir).
 *   - Deletes `~/.capy/orgs/<orgId>/projects/` (project key caches — derived
 *     artifact, recomputable on next sync if the user is re-invited).
 *   - Deletes `process.cwd()/keep.lock` (project pointer for an org the
 *     user is no longer in). No-op when not present.
 *   - PRESERVES sibling users in the same org. Multi-user-on-one-machine:
 *     kicking user A from org X must not touch user B's state in org X.
 *   - PRESERVES the org dir if any sibling state remains; removes it only
 *     when emptied.
 *   - Defensive: a missing `userId` short-circuits the whole function. The
 *     production call sites always supply userId; if a future caller
 *     forgets, we fail closed rather than nuking everything in the org.
 */
export function cleanupOrgData(orgId: string, userId?: string): void {
  if (!userId) return;

  // 1. Wrapped master key + per-user dir.
  const userDir = join(getGlobalCapyDir(), 'orgs', orgId, 'users', userId);
  if (existsSync(userDir)) {
    try {
      rmSync(userDir, { recursive: true, force: true });
      console.log('  Removed local encryption key for this organization.');
    } catch {}
  }

  // 2. Project key cache parent for this org. All per-project caches live
  //    here; they're derived from the wrapped M which is now gone.
  const projectsDir = join(getGlobalCapyDir(), 'orgs', orgId, 'projects');
  if (existsSync(projectsDir)) {
    try {
      rmSync(projectsDir, { recursive: true, force: true });
    } catch {}
  }

  // 3. Empty-org cleanup. rmdirSync only succeeds when the dir is empty,
  //    so a sibling user (or any other content) leaves the dir intact.
  const orgDir = join(getGlobalCapyDir(), 'orgs', orgId);
  const usersDir = join(orgDir, 'users');
  try {
    if (existsSync(usersDir) && readdirSync(usersDir).length === 0) {
      rmdirSync(usersDir);
    }
    if (existsSync(orgDir) && readdirSync(orgDir).length === 0) {
      rmdirSync(orgDir);
    }
  } catch {
    // sibling state present — leave the dir alone.
  }

  // 4. Local keep.lock — pointer to an org the user is no longer in.
  const keepPath = join(process.cwd(), 'keep.lock');
  if (existsSync(keepPath)) {
    try {
      unlinkSync(keepPath);
      console.log('  Removed keep.lock (no longer a member).');
    } catch {}
  }
}
