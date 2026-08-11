/**
 * CAP-384 (CLI-sealed half) — the sandbox grant ceremony.
 *
 * A grant is CAP-372's invariant 2 finally built: "sandboxes obtain keys
 * exclusively through the per-chat ceremony grant." Before this file, the
 * only path a sandbox had was `runUnlock` (onboarding.ts) — which is Case
 * C/C′, and Case C/C′ ends by writing local.key + key.enc to disk for every
 * org the user belongs to (`installOrgFromServer`). On ephemeral infra that
 * is exactly backwards: it leaves durable key material sitting in a
 * container that may be snapshotted, cached, or reused. See
 * `.context/reports/audit-browser-direct-api.md` §4.2/§9 (CAP-384 fate) and
 * `final-gate.md` §1.4 item 5 for the failing-journey trace this closes.
 *
 * This module is deliberately a NARROW SLICE of onboarding.ts's Case C: it
 * runs the identical WebAuthn/PRF ceremony (list live doors → fetch each
 * door's payload → ceremony.requestGrant → derive KEK → unwrap K_local) and
 * stops there. It never calls installOrgFromServer, never calls
 * saveLocalRoot/saveMasterKey, never touches globalConfig's disk helpers at
 * all. The caller (grantHolder.ts) is responsible for what happens to the
 * resulting K_local — by construction, that's "hold it in RAM behind a
 * Unix-domain-socket daemon," never a file.
 *
 * Deliberately NOT reusing onboarding.ts's `runUnlock` with a "skip the
 * install step" flag: that function is CAP-383's regression-suite surface
 * (the equivalence test, invariant 4) and duplicating its ~20-line ceremony
 * prelude here — rather than threading a new branch through a well-tested,
 * security-load-bearing function — keeps `runUnlock` provably unchanged.
 */
import { CapyError, ERROR_CODES } from '../../types/index';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../service/serviceClient';
import type { CeremonyTransport } from './ceremonyTransport';
import {
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  unwrapKLocal,
} from './crypto';

const isLiveDoor = (w: KeyWrapperMetadata): boolean => w.type === 'wrapped_k_local' && !w.deleted_at;

/** The subset of UserWrapperOps a grant ceremony needs — no org-scoped ops, no disk. */
export interface GrantOps {
  listWrappers(): Promise<KeyWrapperMetadata[]>;
  fetchWrapper(wrapperId: string): Promise<KeyWrapperPayload>;
}

export interface GrantCeremonyDeps {
  userId: string;
  ceremony: CeremonyTransport;
  ops: GrantOps;
}

/** K_local plus the identity it was unwrapped under — everything grantHolder.ts needs to hold. */
export interface GrantedKeyMaterial {
  userId: string;
  credentialId: string;
  kLocal: Buffer;
}

export type GrantCeremonyOutcome =
  | { ok: true; material: GrantedKeyMaterial }
  | { ok: false; code: string };

/**
 * Run the grant ceremony: identical door discovery + PRF ceremony to Case
 * C's `runUnlock`, but the result is returned to the caller instead of
 * written anywhere. Never throws for an ordinary ceremony decline/failure —
 * those come back as `{ok:false, code}`; only a genuine precondition
 * violation (no live doors at all — nothing to grant against) throws, same
 * as `runUnlock`'s own contract for that case.
 */
export async function runGrantCeremony(deps: GrantCeremonyDeps): Promise<GrantCeremonyOutcome> {
  const rows = await deps.ops.listWrappers();
  const doors = rows.filter(isLiveDoor);
  if (doors.length === 0) {
    throw new CapyError(
      'No device key is enrolled for this account. Enroll one from an unlocked machine first (capy device-key enroll).',
      ERROR_CODES.WRAPPER_NOT_FOUND,
      { reason: 'no_live_doors' },
    );
  }

  const doorPayloads = new Map<string, KeyWrapperPayload>();
  for (const door of doors) {
    const payload = await deps.ops.fetchWrapper(door.id);
    if (payload.credential_id && payload.wrapped_k_local && payload.iv && payload.prf_salt) {
      doorPayloads.set(payload.credential_id, payload);
    }
  }
  if (doorPayloads.size === 0) {
    throw new CapyError(
      'Every enrolled device-key record is malformed.',
      ERROR_CODES.INVALID_FORMAT,
      { reason: 'no_complete_door_payload' },
    );
  }

  if (!deps.ceremony.requestGrant) {
    // Every production transport (BrokerCeremonyTransport) implements this;
    // only hand-rolled test fakes omit it. Fails closed rather than silently
    // falling back to an unlock-shaped ceremony a caller never asked for.
    return { ok: false, code: 'transport_error' };
  }

  const ceremony = await deps.ceremony.requestGrant({
    userId: deps.userId,
    candidates: [...doorPayloads.values()].map((p) => ({
      credentialId: p.credential_id!,
      prfSalt: p.prf_salt!,
    })),
  });
  if (!ceremony.ok) {
    return { ok: false, code: ceremony.code };
  }

  const used = doorPayloads.get(ceremony.credentialId);
  if (!used) {
    throw new CapyError(
      'The ceremony answered with a credential that is not enrolled.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'unknown_credential' },
    );
  }

  const kek = deriveDeviceKeyKek(
    Buffer.from(ceremony.prfOutput, 'base64'),
    Buffer.from(used.prf_salt!, 'base64'),
    used.kdf_version,
  );
  const kLocal = unwrapKLocal(
    used.wrapped_k_local!,
    used.iv!,
    kek,
    deviceKeyWrapAAD(deps.userId, ceremony.credentialId),
  );

  return {
    ok: true,
    material: { userId: deps.userId, credentialId: ceremony.credentialId, kLocal },
  };
}
