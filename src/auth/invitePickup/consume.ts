/**
 * Pickup consumption at first attach (CAP-529, docs/invite-pickup-flow.md
 * §4 step 3, §9 guards 5-7).
 *
 * Reuses the existing redeem internals — `innerUnwrap`, `loadOrMintLocalRoot`,
 * `wrapAndSaveMasterKey`, `hasOrgKey`, `deriveDeviceKeyKek`, `wrapKLocal` —
 * fed from a pickup row instead of argv. No crypto primitive here is new
 * except the pickup-specific KEK/AAD in `./crypto.ts`; every step below is a
 * thin orchestration over functions that already exist and are unmodified.
 *
 * ONE WebAuthn ceremony produces ONE prfOutput, from which TWO KEKs are
 * derived (§3.6, §4 step 3): `KEK_pickup` unwraps T, `KEK_door` (the
 * existing, unmodified `deriveDeviceKeyKek`) wraps the freshly-minted
 * K_local. The ceremony itself is `CeremonyTransport.requestUnlock` with a
 * single candidate — the pickup's own `{credential_id, prf_salt}` — because
 * Bob's passkey was already registered when Keep produced the pickup row;
 * this is a `get()` against a known credential, not a fresh enrollment.
 */
import { CapyError, ERROR_CODES } from '../../types/index';
import { innerUnwrap } from '../../crypto/inviteCrypto';
import { loadOrMintLocalRoot, wrapAndSaveMasterKey, hasOrgKey, KeyServiceOps } from '../../crypto/keyResolver';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal, DEVICE_KEY_KDF_VERSION } from '../deviceKey/crypto';
import type { CeremonyTransport } from '../deviceKey/ceremonyTransport';
import { deriveKekPickup, pickupWrapAAD, unwrapPickupT } from './crypto';

/** The pending-pickup row shape this module needs — a structural subset of ServiceClient's PendingInvitePickup. */
export interface PendingPickupRow {
  invite_id: string;
  organization_id: string;
  user_id: string;
  wrapped_t: string;
  iv: string;
  prf_salt: string;
  credential_id: string;
  kdf_version: number;
}

/** A live wrapper row as reported by GET /wrappers — the structural subset this module needs. */
export interface LiveWrapperRow {
  type: 'wrapped_k_local' | 'key_enc';
  credential_id?: string | null;
  deleted_at?: string | null;
}

export interface InvitePickupOps extends KeyServiceOps {
  /** GET /invites/pending — this caller's own pending pickup, or null. */
  getPendingPickup(): Promise<PendingPickupRow | null>;
  /** GET /orgs/:orgId/invites/:inviteId/blob — CLI-scope gated. */
  fetchInviteBlob(orgId: string, inviteId: string): Promise<{ blob: string; email: string }>;
  /**
   * POST /wrappers { type: 'wrapped_k_local', ... } — the anchor door.
   * MUST throw a `CapyError` coded `WRAPPER_CONFLICT` on a 409, never swallow
   * it — guard 7's idempotency check depends on catching this specific code.
   */
  uploadDoorWrapper(body: {
    wrapped_k_local: string;
    iv: string;
    prf_salt: string;
    credential_id: string;
    kdf_version: number;
  }): Promise<{ id: string; credential_id?: string | null }>;
  /** GET /wrappers — used only to resolve a WRAPPER_CONFLICT's credential (guard 7). */
  listWrappers(): Promise<LiveWrapperRow[]>;
  /** DELETE /invites/:inviteId/pickup — retires T (§4 step 9). */
  deletePickup(inviteId: string): Promise<void>;
}

export interface ConsumePickupSuccess {
  ok: true;
  /** False when guard 5's short-circuit fired — key.enc already existed and was left untouched. */
  keyAlreadyPresent: boolean;
  orgId: string;
  inviteId: string;
  credentialId: string;
}

export type ConsumePickupNoOp = { ok: true; noPendingPickup: true };

/**
 * Runs steps 1-9 of §4's first-use flow for one user. Returns
 * `{ ok: true, noPendingPickup: true }` when there is nothing to do — that is
 * the expected steady state for every `capy` invocation after the first.
 *
 * Throws a `CapyError` on any ceremony or server failure; nothing here
 * retries — the pickup row is only deleted on full success (step 9), so any
 * thrown failure leaves it retryable by design (the escape table in §7.3).
 */
export async function consumeInvitePickup(
  userId: string,
  ceremony: CeremonyTransport,
  ops: InvitePickupOps,
): Promise<ConsumePickupSuccess | ConsumePickupNoOp> {
  // Step 1
  const pickup = await ops.getPendingPickup();
  if (!pickup) return { ok: true, noPendingPickup: true };

  const orgId = pickup.organization_id;
  const inviteId = pickup.invite_id;

  // Step 2 — one WebAuthn get() against the pickup's own known credential.
  const unlock = await ceremony.requestUnlock({
    userId,
    candidates: [{ credentialId: pickup.credential_id, prfSalt: pickup.prf_salt }],
  });
  if (!unlock.ok) {
    throw new CapyError(
      'Could not complete the passkey ceremony for this invite.',
      ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED,
      { ceremonyCode: unlock.code },
    );
  }
  const prfOutput = Buffer.from(unlock.prfOutput, 'base64');
  const prfSalt = Buffer.from(pickup.prf_salt, 'base64');

  // Two derivations from the one PRF evaluation (§3.6, §4 step 3).
  const kekPickup = deriveKekPickup(prfOutput, prfSalt);
  const kekDoor = deriveDeviceKeyKek(prfOutput, prfSalt, pickup.kdf_version || DEVICE_KEY_KDF_VERSION);

  // Unwrap T.
  const pickupAad = pickupWrapAAD(userId, inviteId, unlock.credentialId);
  const token = unwrapPickupT(pickup.wrapped_t, pickup.iv, kekPickup, pickupAad);

  // Step 3 — the stored blob.
  const { blob, email: inviteEmail } = await ops.fetchInviteBlob(orgId, inviteId);

  // Step 4 — co-decrypt (no notAfter: shed at enrollment, §3.5).
  const innerBlob = await ops.coDecrypt(orgId, blob);

  // Step 5 — M, in CLI memory only. `inviteEmail` is the invite row's own
  // bound address (§7.3) — using the session email here would fail silently
  // if the invitee's WorkOS email changed after mint.
  const masterKey = innerUnwrap(innerBlob, token, orgId, inviteEmail);

  // Step 6 — K_local (existing, unmodified).
  const kLocal = loadOrMintLocalRoot(orgId, userId);

  // Step 7 — the anchor door, wrapped under KEK_door. Idempotent under the
  // pickup's own credential (guard 7): a 409 here on retry, under the SAME
  // credential this ceremony just used, means a previous attempt already
  // landed the door — continue. A 409 under a DIFFERENT credential is a real
  // conflict and is not ours to paper over.
  const doorAad = deviceKeyWrapAAD(userId, unlock.credentialId);
  const wrapped = wrapKLocal(kLocal, kekDoor, doorAad);
  await uploadDoorIdempotently(ops, unlock.credentialId, {
    wrapped_k_local: wrapped.wrappedKLocal,
    iv: wrapped.iv,
    prf_salt: pickup.prf_salt,
    credential_id: unlock.credentialId,
    kdf_version: pickup.kdf_version || DEVICE_KEY_KDF_VERSION,
  });

  // Step 8 — guard 5: never overwrite an existing key.enc. This property
  // lives HERE (CLI layer), not server-side — the server's uploadKeyEnc
  // intentionally rotates on conflict, which is correct for every OTHER
  // caller of it.
  const keyAlreadyPresent = hasOrgKey(orgId, userId);
  if (!keyAlreadyPresent) {
    await wrapAndSaveMasterKey(masterKey, orgId, userId, ops);
  }

  // Step 9 — retire T.
  await ops.deletePickup(inviteId);

  return { ok: true, keyAlreadyPresent, orgId, inviteId, credentialId: unlock.credentialId };
}

async function uploadDoorIdempotently(
  ops: InvitePickupOps,
  credentialId: string,
  body: {
    wrapped_k_local: string;
    iv: string;
    prf_salt: string;
    credential_id: string;
    kdf_version: number;
  },
): Promise<void> {
  try {
    await ops.uploadDoorWrapper(body);
    return;
  } catch (err) {
    if (!(err instanceof CapyError) || err.code !== ERROR_CODES.WRAPPER_CONFLICT) throw err;
  }
  const inventory = await ops.listWrappers();
  const conflictingDoor = inventory.find(
    (w) => w.type === 'wrapped_k_local' && !w.deleted_at && w.credential_id === credentialId,
  );
  if (!conflictingDoor) {
    // The conflict is under a DIFFERENT credential than this ceremony's own
    // — not ours to treat as success. Re-raise the original coded error.
    throw new CapyError(
      'A device key already exists under a different credential.',
      ERROR_CODES.WRAPPER_CONFLICT,
      { credentialId },
    );
  }
  // Same credential: a previous attempt already landed this door. Continue.
}
