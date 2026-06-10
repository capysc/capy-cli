import {
  readEpochKeyRecord,
  saveEpochKeyRecord,
  readLocalEpoch,
  readLocalRoot,
  EpochKeyRecord,
} from '../config/globalConfig';
import { deriveEpochInnerKey } from './localKeyRoot';
import { encryptMasterKey, decryptMasterKey, masterKeyAAD } from './keyManager';
import { unwrapMasterKey } from './keyResolver';
import {
  generateEpochKey,
  wrapHistoryBlob,
  wrapProjectHistoryBlob,
  wrapEscrowBlob,
  unwrapEscrowBlob,
} from './epochCrypto';
import { openSealed, sealToDevice } from './deviceKey';
import { loadDevicePrivateKey } from './deviceManager';
import { isMembershipRevokedError } from '../errors/membershipRevoked';

/**
 * Epoch key lifecycle orchestration (CAP-58 / docs/epoch-key-design.md).
 *
 * Epoch 0 is the legacy M-derived scheme: key.enc (wrapped M) IS the epoch-0
 * key, so getCurrentEpochKey returns M and resolveProjectKey derives from it,
 * exactly as before. From epoch 1 onward the current epoch key E_e is fresh
 * randomness, stored double-wrapped in epoch.enc and refreshed transparently on
 * each run from the service's per-device sealed blobs.
 */

const EPOCH_AAD = Buffer.from('capy:epochkey:v1', 'utf8');

export interface EpochServiceOps {
  coDecrypt(orgId: string, ciphertext: string): Promise<string>;
  wrapOuterLayer(orgId: string, plaintext: string): Promise<string>;
  /** Current org epoch (optional — absent means treat as epoch 0). */
  getEpoch?(orgId: string): Promise<number>;
  /** Escrow blobs epoch→blob (optional). */
  getEpochEscrows?(orgId: string): Promise<Record<string, string>>;
}

/**
 * Catches this machine up to the org's current epoch by recovering the current
 * epoch key from M + the escrow blob (the owner break-glass channel, available
 * to any M-holder — which all members are during migration). Best-effort: an
 * old service without epoch endpoints, a missing escrow (owner-backfill
 * pending), or any error leaves the local epoch unchanged.
 *
 * This is the transitional recovery path. The device-sealed-blob channel
 * (refreshEpoch) is the end-state path for members who no longer hold M.
 */
export async function ensureCurrentEpoch(
  orgId: string,
  userId: string,
  service: EpochServiceOps,
  masterKey: Buffer,
): Promise<void> {
  if (!service.getEpoch || !service.getEpochEscrows) return;
  try {
    const currentEpoch = await service.getEpoch(orgId);
    if (currentEpoch <= readLocalEpoch(orgId, userId)) return;

    const escrows = await service.getEpochEscrows(orgId);
    const blob = escrows[String(currentEpoch)];
    if (!blob) return; // escrow not yet written (admin kick awaiting owner backfill)

    const epochKey = unwrapEscrowBlob(blob, masterKey, currentEpoch);
    await storeEpochKey(orgId, userId, currentEpoch, epochKey, service);
  } catch (err) {
    // The membership gate already ran (unwrapMasterKey in getCurrentEpochKey),
    // so a kick is detected there with a clean MEMBERSHIP_REVOKED. Anything
    // that surfaces here (old service without epoch endpoints, missing escrow,
    // transient blip) is benign — stay on the local epoch. A late-propagating
    // revocation is still re-thrown so cleanup can run.
    if (isMembershipRevokedError(err)) throw err;
  }
}

export interface FullEpochServiceOps extends EpochServiceOps {
  getEpoch(orgId: string): Promise<number>;
  registerDevice(orgId: string, publicKey: string): Promise<{ device_id: string }>;
  getSealedBlobs(orgId: string): Promise<{ epoch: number; sealed_blobs: Array<{ device_id: string; blob: string }> }>;
  listMembers(orgId: string): Promise<{ members: any[]; device_keys?: Record<string, Array<{ device_id: string; public_key: string }>> }>;
  stageEpoch(orgId: string, payload: any): Promise<{ staged: boolean; epoch: number; uncovered_members: string[] }>;
  commitEpoch(orgId: string, epoch: number): Promise<{ epoch: number }>;
}

/** Unwraps the current epoch key E_e from epoch.enc (KMS outer + K_local inner). */
async function unwrapEpochKey(orgId: string, userId: string, record: EpochKeyRecord, service: EpochServiceOps): Promise<Buffer> {
  const kLocal = readLocalRoot(orgId, userId);
  if (!kLocal) throw new Error('Missing K_local — cannot unwrap epoch key');
  const innerBlob = await service.coDecrypt(orgId, record.encrypted_epoch_key);
  return decryptMasterKey(innerBlob, deriveEpochInnerKey(kLocal), EPOCH_AAD);
}

/** Persists E_e double-wrapped (KMS outer + K_local inner) at the given epoch. */
async function storeEpochKey(orgId: string, userId: string, epoch: number, epochKey: Buffer, service: EpochServiceOps): Promise<void> {
  const kLocal = readLocalRoot(orgId, userId);
  if (!kLocal) throw new Error('Missing K_local — cannot store epoch key');
  const innerWrapped = encryptMasterKey(epochKey, deriveEpochInnerKey(kLocal), EPOCH_AAD);
  const outerWrapped = await service.wrapOuterLayer(orgId, innerWrapped);
  const record: EpochKeyRecord = {
    version: '1.0',
    epoch,
    encrypted_epoch_key: outerWrapped,
    updated_at: new Date().toISOString(),
  };
  saveEpochKeyRecord(orgId, record, userId);
}

/**
 * Returns the org's current epoch key as known to this machine: M at epoch 0
 * (legacy), or the stored E_e at epoch ≥1. This is the key resolveProjectKey
 * derives the per-project data key from.
 */
export async function getCurrentEpochKey(
  orgId: string,
  userId: string,
  service: EpochServiceOps,
): Promise<{ epoch: number; key: Buffer }> {
  // Membership gate FIRST: unwrapMasterKey co-decrypts key.enc, so a kicked
  // user gets a clean MEMBERSHIP_REVOKED here (before any epoch call), and the
  // caller's normal cleanup runs. M also seeds the escrow-based catch-up.
  // (Transitional: every member still holds M. In the end state this gate
  // moves to the epoch.enc co-decrypt.)
  const masterKey = await unwrapMasterKey(orgId, userId, service);

  // Catch up to the org's current epoch (no-op at epoch 0 / old service).
  await ensureCurrentEpoch(orgId, userId, service, masterKey);

  const record = readEpochKeyRecord(orgId, userId);
  if (!record || record.epoch === 0) {
    // Epoch 0: the epoch key IS M (legacy M-derived scheme).
    return { epoch: 0, key: masterKey };
  }
  return { epoch: record.epoch, key: await unwrapEpochKey(orgId, userId, record, service) };
}

/**
 * Transparent re-key (per-run). Given the service's current epoch and the
 * caller's pending sealed blobs (from the co-decrypt response or a dedicated
 * fetch), unseal the new epoch key with this machine's device private key and
 * store it. No-op when already current. Best-effort — a failure leaves the
 * member on their old epoch; the next run retries.
 */
export async function refreshEpoch(
  orgId: string,
  userId: string,
  currentEpoch: number,
  sealedBlobs: Array<{ device_id: string; blob: string }>,
  service: FullEpochServiceOps,
): Promise<boolean> {
  if (currentEpoch <= readLocalEpoch(orgId, userId)) return false;
  if (!sealedBlobs.length) return false;

  const privKey = await loadDevicePrivateKey(orgId, userId, service);
  if (!privKey) return false;

  for (const sealed of sealedBlobs) {
    try {
      const epochKey = openSealed(privKey, sealed.blob);
      await storeEpochKey(orgId, userId, currentEpoch, epochKey, service);
      return true;
    } catch {
      // Try the next sealed blob (e.g. sealed to a different device of ours).
    }
  }
  return false;
}

/**
 * Kick-time epoch bump (owner/admin). Mints E_{e+1}, writes the history and
 * (owner-only) escrow blobs, HPKE-seals E_{e+1} to every device of every
 * remaining member, stages, then commits — the two-phase transaction the
 * service guards with an optimistic lock. Updates the kicker's own local epoch.
 *
 * `masterKey` is required to write the escrow blob and, at epoch 0, as the
 * previous epoch key (E_0 = M). An admin kicker without M passes null: escrow
 * is skipped (the owner backfills) — but at epoch 0 the admin still needs M to
 * derive the previous key, so admin-kick-at-epoch-0 is owner-only for now.
 *
 * `remainingUserId` is the kicker (and any other remaining members are read
 * from the members list). Returns the new epoch and any uncovered members.
 */
export async function bumpEpoch(
  orgId: string,
  userId: string,
  service: FullEpochServiceOps,
  opts: {
    projectIds: string[];
    masterKey: Buffer | null;
    excludeUserId?: string; // the kicked user — never seal to them
  },
): Promise<{ epoch: number; uncoveredMembers: string[] }> {
  const currentEpoch = await service.getEpoch(orgId);
  const nextEpoch = currentEpoch + 1;

  // Previous epoch key: M at epoch 0, else this machine's stored E_cur.
  let prevKey: Buffer;
  if (currentEpoch === 0) {
    if (!opts.masterKey) throw new Error('Owner master key required to bump from epoch 0');
    prevKey = opts.masterKey;
  } else {
    prevKey = (await getCurrentEpochKey(orgId, userId, service)).key;
  }

  const newKey = generateEpochKey();

  // Org-wide history blob (owner/admin full-access walk).
  const historyBlob = wrapHistoryBlob(prevKey, newKey);

  // Per-project history blobs (project-scoped members walk these — they bottom
  // out at deriveProjectKey(prev, p), never exposing M).
  const projectHistoryBlobs: Record<string, string> = {};
  for (const pid of opts.projectIds) {
    projectHistoryBlobs[pid] = wrapProjectHistoryBlob(prevKey, newKey, pid, orgId);
  }

  // Escrow blob (owner only — needs M).
  const escrowBlob = opts.masterKey ? wrapEscrowBlob(opts.masterKey, nextEpoch, newKey) : undefined;

  // Seal E_{e+1} to every device of every remaining member.
  const { device_keys } = await service.listMembers(orgId);
  const sealedBlobs: Array<{ user_id: string; device_id: string; blob: string }> = [];
  for (const [memberId, devices] of Object.entries(device_keys ?? {})) {
    if (memberId === opts.excludeUserId) continue; // never seal to the kicked user
    for (const d of devices) {
      sealedBlobs.push({ user_id: memberId, device_id: d.device_id, blob: sealToDevice(d.public_key, newKey) });
    }
  }

  // Stage → commit (two-phase, service-guarded).
  const stageRes = await service.stageEpoch(orgId, {
    epoch: nextEpoch,
    history_blob: historyBlob,
    project_history_blobs: projectHistoryBlobs,
    ...(escrowBlob ? { escrow_blob: escrowBlob } : {}),
    sealed_blobs: sealedBlobs,
  });
  await service.commitEpoch(orgId, nextEpoch);

  // Advance the kicker's own local epoch immediately.
  await storeEpochKey(orgId, userId, nextEpoch, newKey, service);

  return { epoch: nextEpoch, uncoveredMembers: stageRes.uncovered_members };
}
