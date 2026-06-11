/**
 * Session cleanup for `capy logout`.
 *
 * Scope is session/cache state ONLY. ~/.capy/orgs/<orgId>/users/<userId>/ is
 * the recovery-equivalent area and is NEVER touched here:
 * - key.enc — the double-wrapped master key (recovering it needs the seed phrase)
 * - local.key — this machine's inner-wrap root (K_local); deleting it would
 *   orphan key.enc and force the user to re-redeem an invite
 *
 * Returns true if anything was cleared.
 */
export async function performLogoutCleanup(): Promise<boolean> {
  const { existsSync, unlinkSync, rmSync, readdirSync } = await import('fs');
  const { join } = await import('path');
  const { getGlobalCapyDir } = await import('../config/globalConfig');

  const capyDir = join(process.cwd(), '.capy');
  const sessionFiles = ['token'];

  let cleared = false;
  for (const file of sessionFiles) {
    const filePath = join(capyDir, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      cleared = true;
    }
  }

  // Drop user_id from .capy/sync-state so the next `capy` run doesn't pin
  // the previous user's session — syncProject reads this and calls
  // setSessionUserId before authenticating, which on shared eval machines
  // silently re-auths the previous user.
  try {
    const { ProjectManager } = await import('../core/projectManager');
    if (new ProjectManager().clearSyncStateUserId()) cleared = true;
  } catch {
    // best-effort
  }

  // Clear global auth session and project key caches
  const globalCapyDir = getGlobalCapyDir();
  const authSession = join(globalCapyDir, 'auth', 'session.json');
  if (existsSync(authSession)) {
    unlinkSync(authSession);
    cleared = true;
  }

  // Clear per-user session files
  const sessionsDir = join(globalCapyDir, 'auth', 'sessions');
  if (existsSync(sessionsDir)) {
    rmSync(sessionsDir, { recursive: true, force: true });
    cleared = true;
  }

  // Clear project key caches (orgs/<orgId>/users/<userId>/ survives — see above)
  const orgsDir = join(globalCapyDir, 'orgs');
  if (existsSync(orgsDir)) {
    for (const orgId of readdirSync(orgsDir)) {
      const projectsDir = join(orgsDir, orgId, 'projects');
      if (existsSync(projectsDir)) {
        rmSync(projectsDir, { recursive: true, force: true });
        cleared = true;
      }
    }
  }

  // Drop a marker so the next interactive OAuth flow forces WorkOS to
  // re-prompt instead of reusing the AuthKit SSO cookie. Without this,
  // shared eval machines silently re-auth the previous user in the browser.
  try {
    const { setForceLoginMarker } = await import('../config/globalConfig');
    setForceLoginMarker();
  } catch {
    // best-effort
  }

  return cleared;
}
