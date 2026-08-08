/**
 * Production adapters wiring the onboarding engine's seams (UserWrapperOps /
 * OrgKeyEncOps) to the real ServiceClient + AuthService — origin/main public
 * API only (the CAP-377 refactor lands elsewhere; nothing here depends on it).
 *
 * Also home of the FRESH_AUTH_REQUIRED retry dance from the CAP-379
 * contract: on a 403 whose CODED body says {code: FRESH_AUTH_REQUIRED,
 * remediation: refresh_and_retry}, force a token refresh (do NOT wait for
 * expiry) and retry the original request exactly once. Every predicate is a
 * structured field — status, details.code, details.data.remediation — never
 * message text.
 */
import { CapyError, ERROR_CODES } from '../../types/index';
import type { ServiceClient } from '../../service/serviceClient';
import type { AuthService } from '../../auth/authService';
import { markKeyEncSyncPending } from '../../config/globalConfig';
import type { OnboardingDeps, UserWrapperOps, OrgKeyEncOps } from './onboarding';

/**
 * True for the coded fresh-auth 403 (FreshAuthRequiredError). Requires BOTH
 * the dedicated code and the remediation enum — a server that stops sending
 * the remediation gets no blind retries.
 */
export function isFreshAuthRequired(err: unknown): boolean {
  return (
    err instanceof CapyError &&
    err.code === ERROR_CODES.PERMISSION_DENIED &&
    err.details?.status === 403 &&
    err.details?.code === ERROR_CODES.FRESH_AUTH_REQUIRED &&
    err.details?.data?.remediation === 'refresh_and_retry'
  );
}

/**
 * Run `fn`; on the coded fresh-auth refusal, force one refresh via
 * `forceRefresh` and retry once. A second refusal propagates — the dance is
 * one round by contract, never a loop.
 */
export async function withFreshAuthRetry<T>(
  forceRefresh: () => Promise<boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isFreshAuthRequired(err)) throw err;
    await forceRefresh();
    return fn();
  }
}

/**
 * Build the engine's service seams from the session-holding singletons.
 *
 * Org pinning: AuthService is stateful (currentOrgId feeds the token
 * provider ServiceClient pulls on every request), so EVERY org-scoped call
 * re-pins via authenticateSilent(orgId) immediately before it runs. The
 * engine processes orgs sequentially; the re-pin makes a kept-around ops
 * object safe even if calls interleave with another org's.
 */
export function createDeviceKeyServiceOps(
  serviceClient: ServiceClient,
  authService: AuthService,
): Pick<OnboardingDeps, 'ops' | 'opsForOrg'> {
  const forceRefresh = () => authService.refreshToken();

  const ops: UserWrapperOps = {
    listWrappers: () => serviceClient.listWrappers(),
    fetchWrapper: id => serviceClient.fetchWrapper(id),
    uploadDoorWrapper: body => serviceClient.uploadDoorWrapper(body),
    verifyWrapper: id => withFreshAuthRetry(forceRefresh, () => serviceClient.verifyWrapper(id)),
    deleteWrapper: id => serviceClient.deleteWrapper(id),
  };

  const opsForOrg = async (orgId: string): Promise<OrgKeyEncOps | null> => {
    const pinned = await authService.authenticateSilent(orgId);
    if (!pinned.success) return null;

    const ensureOrg = async (): Promise<void> => {
      const repinned = await authService.authenticateSilent(orgId);
      if (!repinned.success) {
        throw new CapyError(
          'Could not renew credentials for this organization.',
          ERROR_CODES.AUTH_FAILED,
          { orgId, silent_code: repinned.error_code },
        );
      }
    };

    return {
      coDecrypt: async (oid, ciphertext) => {
        await ensureOrg();
        return serviceClient.coDecrypt(oid, ciphertext).then(r => r.plaintext);
      },
      wrapOuterLayer: async (oid, plaintext) => {
        await ensureOrg();
        return serviceClient.wrapOuterLayer(oid, plaintext).then(r => r.ciphertext);
      },
      // The sync-invariant hook (see KeyServiceOps): any key.enc rewrite
      // through this ops object leaves a persisted marker until the server
      // copy catches up. Self-referential canonical (oid, root) — this
      // generic hook fires outside any cross-org enrollment unification, so
      // the org is always canonical against its own just-written root.
      onKeyEncRewrapped: (oid, userId, root) => markKeyEncSyncPending(oid, userId, oid, root),
      uploadKeyEnc: async keyEnc => {
        await ensureOrg();
        return serviceClient.uploadKeyEncWrapper(keyEnc);
      },
      fetchKeyEnc: async wrapperId => {
        await ensureOrg();
        const wrapper = await withFreshAuthRetry(forceRefresh, () =>
          serviceClient.fetchWrapper(wrapperId),
        );
        if (wrapper.type !== 'key_enc' || !wrapper.key_enc) {
          throw new CapyError(
            'The server answered with a non-key.enc wrapper.',
            ERROR_CODES.INVALID_FORMAT,
            { wrapperId, type: wrapper.type },
          );
        }
        return wrapper.key_enc;
      },
    };
  };

  return { ops, opsForOrg };
}
