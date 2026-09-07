/**
 * Session cleanup for `capy logout`.
 *
 * Scope is session/cache state plus the metadata-only runtime pairing. The
 * pairing daemon is stopped because logout is the explicit account-switch
 * boundary. ~/.capy/orgs/<orgId>/users/<userId>/ is the recovery-equivalent
 * area and is NEVER touched here:
 * - key.enc — the double-wrapped master key (recovering it needs the seed phrase)
 * - local.key — this machine's inner-wrap root (K_local); deleting it would
 *   orphan key.enc and force the user to re-redeem an invite
 *
 * Returns true if anything was cleared.
 */
import type {
  RuntimeCustodyEnvironment,
  RuntimeCustodyProviderResolver,
} from '../auth/pairing/runtimeCustodyProvider';

export interface LogoutCleanupDependencies {
  readonly resolveRuntimeCustodyProvider?: RuntimeCustodyProviderResolver;
  readonly runtimeCustodyEnvironment?: RuntimeCustodyEnvironment;
  readonly removeRuntimePairingMetadata?: (path: string) => void;
}

export async function performLogoutCleanup(
  dependencies: LogoutCleanupDependencies = {},
): Promise<boolean> {
  const { existsSync, unlinkSync, rmSync, readdirSync } = await import('fs');
  const { join } = await import('path');
  const { getGlobalCapyDir } = await import('../config/globalConfig');
  const { clearRuntimePairing } = await import('../auth/pairing/runtimePairing');

  // A v2 pairing record is the sole ordinary-file handle for an external
  // custody entry. Delete that provider entry first; if it fails, preserve
  // every session/cache artifact so logout is retryable and never orphans the
  // sealed key. Existing v1 records retain their daemon-stop/remove behavior.
  const runtimePairingCleared = await clearRuntimePairing({
    resolveCustodyProvider: dependencies.resolveRuntimeCustodyProvider,
    expectedEnvironment: dependencies.runtimeCustodyEnvironment,
    removeMetadata: dependencies.removeRuntimePairingMetadata,
  });

  const deleteFile = (path: string): boolean => {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  };

  const deleteDirectory = (path: string): boolean => {
    if (!existsSync(path)) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  };

  const capyDir = join(process.cwd(), '.capy');
  const sessionFiles = ['token'];
  const localSessionCleared = sessionFiles
    .map((file) => deleteFile(join(capyDir, file)))
    .some(Boolean);

  // Drop user_id from .capy/sync-state so the next `capy` run doesn't pin
  // the previous user's session — syncProject reads this and calls
  // setSessionUserId before authenticating, which on shared eval machines
  // silently re-auths the previous user.
  const syncStateCleared = await import('../core/projectManager')
    .then(({ ProjectManager }) => new ProjectManager().clearSyncStateUserId())
    .catch(() => false);

  // Clear global auth session and project key caches
  const globalCapyDir = getGlobalCapyDir();
  const authSession = join(globalCapyDir, 'auth', 'session.json');
  const globalSessionCleared = deleteFile(authSession);

  // Clear per-user session files
  const sessionsDir = join(globalCapyDir, 'auth', 'sessions');
  const userSessionsCleared = deleteDirectory(sessionsDir);
  // Pending device grants and retry receipts are auth state, never pairing custody.
  const authenticationFlowsCleared = deleteDirectory(join(globalCapyDir, 'auth', 'authentication-flows'));

  // Clear project key caches (orgs/<orgId>/users/<userId>/ survives — see above)
  const orgsDir = join(globalCapyDir, 'orgs');
  const projectCachesCleared = existsSync(orgsDir)
    ? readdirSync(orgsDir)
      .map((orgId) => deleteDirectory(join(orgsDir, orgId, 'projects')))
      .some(Boolean)
    : false;

  // Drop a marker so the next interactive OAuth flow forces WorkOS to
  // re-prompt instead of reusing the AuthKit SSO cookie. Without this,
  // shared eval machines silently re-auth the previous user in the browser.
  await import('../config/globalConfig')
    .then(({ setForceLoginMarker }) => setForceLoginMarker())
    .catch(() => undefined);

  return [
    localSessionCleared,
    syncStateCleared,
    globalSessionCleared,
    userSessionsCleared,
    authenticationFlowsCleared,
    projectCachesCleared,
    runtimePairingCleared,
  ].some(Boolean);
}
