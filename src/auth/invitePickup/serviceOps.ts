/**
 * Production adapter wiring `InvitePickupOps` (the seam `consumeInvitePickup`
 * is written against, see ./consume.ts) to the real ServiceClient +
 * AuthService — the same shape as `auth/deviceKey/serviceOps.ts`'s
 * `createDeviceKeyServiceOps`, and reused by both call sites: the explicit
 * `capy redeem` (no code) entry point (commands/redeemCommand.ts) and the
 * automatic first-attach trigger (auth/deviceKey/wiring.ts's
 * `attemptPickupConsumption`).
 *
 * Org pinning: `GET /invites/pending` is deliberately NOT org-scoped (the
 * pending row itself names its organization_id — the caller doesn't know it
 * ahead of time), so it runs under whatever token AuthService currently
 * holds. Every call that IS org-scoped (fetchInviteBlob, coDecrypt,
 * wrapOuterLayer) re-pins first via `authenticateSilent(orgId)`, mirroring
 * `createDeviceKeyServiceOps`'s `opsForOrg` — AuthService is stateful and
 * ServiceClient's token provider reads its current org on every request.
 */
import type { ServiceClient } from '../../service/serviceClient';
import { silentAuthFailureMessage, type AuthService } from '../authService';
import { CapyError, ERROR_CODES } from '../../types/index';
import type { InvitePickupOps } from './consume';

export function createInvitePickupOps(
  serviceClient: ServiceClient,
  authService: AuthService,
): InvitePickupOps {
  const ensureOrg = async (orgId: string): Promise<void> => {
    // This is a TERMINAL silent-auth attempt (no interactive fallback follows
    // — the pickup flow is already mid-consumption), so its failure must
    // report WHY, keyed off the result's error_code, not a bare sentence.
    // silentAuthFailureMessage picks the remedy from the code (cardinal
    // Rule 5: never branch on the prose).
    const pinned = await authService.authenticateSilent(orgId);
    if (!pinned.success) {
      throw new CapyError(
        `Could not obtain credentials for the invited organization. ${silentAuthFailureMessage(pinned)}`,
        ERROR_CODES.AUTH_FAILED,
        { orgId, silentAuthErrorCode: pinned.error_code },
      );
    }
  };

  return {
    getPendingPickup: () => serviceClient.getPendingInvitePickup(),
    fetchInviteBlob: async (orgId, inviteId) => {
      await ensureOrg(orgId);
      return serviceClient.fetchInviteBlob(orgId, inviteId);
    },
    coDecrypt: async (orgId, ciphertext) => {
      await ensureOrg(orgId);
      return serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext);
    },
    wrapOuterLayer: async (orgId, plaintext) => {
      await ensureOrg(orgId);
      return serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext);
    },
    uploadDoorWrapper: body => serviceClient.uploadDoorWrapper(body),
    listWrappers: () => serviceClient.listWrappers(),
    deletePickup: inviteId => serviceClient.deleteInvitePickup(inviteId),
  };
}
