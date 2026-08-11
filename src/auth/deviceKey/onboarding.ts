/**
 * Device-key onboarding engine (CAP-380): the case implementations behind
 * the detection fork in ./detect.ts.
 *
 * Everything here is written against two seams so CAP-381 (the browser
 * ceremony) and CAP-382 (the command surface) can land independently:
 * - CeremonyTransport (./ceremonyTransport.ts) supplies PRF results;
 * - UserWrapperOps / OrgKeyEncOps supply the CAP-379 wrapper endpoints and
 *   the KMS wrap/co-decrypt pair, org-scoped where the contract demands it.
 *
 * FILE PERSISTENCE LAW (invariant 4): local.key and key.enc are written
 * ONLY through the existing helpers — saveLocalRootExclusive /
 * loadOrMintLocalRoot / saveLocalRoot / saveMasterKey / wrapAndSaveMasterKey
 * — in the established local.key-before-key.enc order. Steady state on disk
 * is byte-identical to a transport-provisioned machine; the only transient
 * extra is the key.enc.sync-pending marker, deleted when the owed upload
 * lands.
 *
 * ONE K_LOCAL PER USER (recorded decision): the server schema stores
 * wrapped_k_local per credential with no org column, so a door can wrap only
 * one root — but today's CLI mints one root per org×user. Enrollment
 * therefore UNIFIES: it picks a canonical root (active org's, else first
 * found), wraps that in the door, and re-keys every other org's key.enc onto
 * it (unwrap M via the existing keyResolver path, re-wrap inner under the
 * canonical root, KMS re-wrap outer). Per org, the re-keyed blob is uploaded
 * BEFORE local files move: a crash at any point leaves the local org either
 * fully on its old root (still working, marker persists, next run retries)
 * or fully migrated — never keyed by a root that no longer exists anywhere.
 *
 * Case B′ intentionally has no implementation here: it is a ROUTE (to seed
 * recovery or capy transport/redeem, both untouched — invariant 8), and the
 * fork's 'recovery_or_transport' verdict is the whole deliverable.
 */
import {
  Organization,
  CapyError,
  ERROR_CODES,
} from '../../types/index';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../../service/serviceClient';
import {
  KeyServiceOps,
  unwrapMasterKey,
  wrapAndSaveMasterKey,
  loadOrMintLocalRoot,
} from '../../crypto/keyResolver';
import { encryptMasterKey, masterKeyAAD } from '../../crypto/keyManager';
import { deriveLocalInnerKey } from '../../crypto/localKeyRoot';
import {
  readLocalRoot,
  saveLocalRoot,
  saveLocalRootExclusive,
  readMasterKey,
  saveMasterKey,
  listOrgsWithLocalRoot,
  markKeyEncSyncPending,
  clearKeyEncSyncPending,
  listOrgsWithKeyEncSyncPending,
  readKeyEncSyncPendingMarker,
  rootFingerprint,
  deleteLocalKeyMaterial,
} from '../../config/globalConfig';
import type { CeremonyTransport, CeremonyFailureCode } from './ceremonyTransport';
import {
  DEVICE_KEY_KDF_VERSION,
  generatePrfSalt,
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  wrapKLocal,
  unwrapKLocal,
} from './crypto';
import { decideOnboardingCase, OnboardingCaseKind } from './detect';
import { isEphemeralEnvironment } from './ephemeral';

// --- Service seams -----------------------------------------------------------

/** Wrapper endpoints that are user-scoped (any org token of the user works). */
export interface UserWrapperOps {
  listWrappers(): Promise<KeyWrapperMetadata[]>;
  /**
   * MUST implement the FRESH_AUTH_REQUIRED refresh-and-retry dance
   * (serviceOps.withFreshAuthRetry). GET /wrappers/:id fresh-auth gates
   * BOTH wrapper types (door reads, not just key_enc) as of the service
   * fix in audit-browser-direct-api.md.
   */
  fetchWrapper(wrapperId: string): Promise<KeyWrapperPayload>;
  uploadDoorWrapper(body: {
    wrapped_k_local: string;
    iv: string;
    prf_salt: string;
    credential_id: string;
    kdf_version: number;
  }): Promise<KeyWrapperMetadata>;
  /** MUST implement the FRESH_AUTH_REQUIRED refresh-and-retry dance (serviceOps.withFreshAuthRetry). */
  verifyWrapper(wrapperId: string): Promise<KeyWrapperMetadata>;
  deleteWrapper(wrapperId: string): Promise<KeyWrapperMetadata>;
}

/**
 * Org-scoped operations: the service takes the org for key_enc rows from the
 * JWT, and co-decrypt/wrap are org routes — every method here must run under
 * a token scoped to the org this ops object was built for.
 */
export interface OrgKeyEncOps extends KeyServiceOps {
  uploadKeyEnc(keyEnc: string): Promise<KeyWrapperMetadata>;
  /** MUST implement the FRESH_AUTH_REQUIRED refresh-and-retry dance. */
  fetchKeyEnc(wrapperId: string): Promise<string>;
}

export interface OnboardingDeps {
  userId: string;
  userEmail?: string;
  /** From the authenticated session (AuthResult.organizations). */
  organizations: Organization[];
  /** Preferred org for canonical-root selection; usually the current org context. */
  activeOrgId?: string | null;
  ceremony: CeremonyTransport;
  ops: UserWrapperOps;
  /** Resolve org-scoped ops, or null when no token for that org can be minted. */
  opsForOrg(orgId: string): Promise<OrgKeyEncOps | null>;
}

// --- Results -----------------------------------------------------------------

export type OrgSyncStatus =
  /** Existing blob uploaded unchanged. */
  | 'uploaded'
  /** Blob re-keyed onto the canonical root, uploaded, files rewritten. */
  | 'rekeyed_and_uploaded'
  /** Case C: root + downloaded key.enc written. */
  | 'installed'
  /** Case C: this org already has this root and a key.enc — nothing touched. */
  | 'already_provisioned'
  /** No key.enc on disk for this org — nothing to sync from this machine. */
  | 'skipped_no_key_enc'
  /** No org-scoped token could be minted; marker left for a later run. */
  | 'skipped_no_org_token'
  /** A DIFFERENT root is already on disk — refused to overwrite (coded). */
  | 'local_root_conflict'
  /** A typed service/crypto error; `code` carries it, marker left for retry. */
  | 'failed';

export interface OrgOutcome {
  orgId: string;
  status: OrgSyncStatus;
  /** Machine-readable error code for 'failed' / 'local_root_conflict'. */
  code?: string;
}

export interface EnrollmentSummary {
  ok: true;
  credentialId: string;
  wrapperId: string;
  /**
   * Whether POST /wrappers/:id/verify succeeded. Best-effort: a false here
   * leaves enrollment key-complete (the server anchors the account via the
   * is_seed marker it assigns the first door) and the next enrollment-aware
   * run can re-verify.
   */
  verified: boolean;
  /** false = device-locked credential: warn and push seed-phrase recording. */
  backupEligible: boolean;
  backupState: boolean;
  orgs: OrgOutcome[];
}

/** The ceremony declined to produce a PRF result — branch on `ceremonyCode`. */
export interface CeremonyAborted {
  ok: false;
  code: typeof ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED;
  ceremonyCode: CeremonyFailureCode;
}

/**
 * CAP-402, ephemeral environments only: Case A's mint→ceremony→upload
 * sequence did not finish, so `runNewUserEnrollment` rolled back everything
 * it had minted on this disk (see `deleteLocalKeyMaterial`) rather than
 * leave local.key/key.enc stranded on infrastructure that will not outlive
 * this process. Never returned when `isEphemeralEnvironment()` is false —
 * that path keeps returning `CeremonyAborted` exactly as before (CAP-383's
 * byte-identical-refusal test pins it).
 */
export interface EphemeralEnrollmentIncomplete {
  ok: false;
  code: typeof ERROR_CODES.DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE;
  /** Which half of the sequence failed to complete. */
  reason: 'ceremony_declined' | 'upload_incomplete';
  /** The ceremony's own refusal code, only when reason is 'ceremony_declined'. */
  ceremonyCode?: CeremonyFailureCode;
}

export interface UnlockSummary {
  ok: true;
  credentialId: string;
  orgs: OrgOutcome[];
}

/**
 * Detection said Case B (some org dir has a local.key), but no candidate's
 * file actually parses as a usable 32-byte root (corrupt/truncated write) —
 * there is nothing left on this machine to enroll onto. Degrades to the B′
 * routing verdict rather than dead-ending in a throw, matching the fork's
 * own graceful-degradation philosophy (gate-2 MAJOR-4).
 */
export interface RoutingVerdict {
  ok: false;
  kind: 'recovery_or_transport';
  code: typeof ERROR_CODES.INVALID_FORMAT;
}

export interface DetectionResult {
  kind: OnboardingCaseKind;
  /** The inventory the verdict was computed from — reuse it, don't re-list. */
  inventory: KeyWrapperMetadata[];
  /** Orgs on this machine holding a user-scoped local.key. */
  orgsWithLocalRoot: string[];
}

// --- Detection (effectful wrapper over the pure fork) ------------------------

const isLiveDoor = (w: KeyWrapperMetadata) => w.type === 'wrapped_k_local' && !w.deleted_at;
const isLiveKeyEnc = (w: KeyWrapperMetadata) => w.type === 'key_enc' && !w.deleted_at;

export async function detectOnboardingCase(deps: OnboardingDeps): Promise<DetectionResult> {
  const inventory = await deps.ops.listWrappers();
  const orgsWithLocalRoot = listOrgsWithLocalRoot(deps.userId);
  const kind = decideOnboardingCase({
    liveDoorCount: inventory.filter(isLiveDoor).length,
    liveKeyEncCount: inventory.filter(isLiveKeyEnc).length,
    hasLocalRoot: orgsWithLocalRoot.length > 0,
    organizationCount: deps.organizations.length,
  });
  return { kind, inventory, orgsWithLocalRoot };
}

// --- Shared enrollment plumbing ----------------------------------------------

interface DoorEnrollment {
  ok: true;
  credentialId: string;
  wrapperId: string;
  verified: boolean;
  backupEligible: boolean;
  backupState: boolean;
}

/**
 * Run the create ceremony and upload the door wrapping `root`.
 * Returns the ceremony's typed refusal untouched when it declines.
 */
async function enrollDoor(
  deps: OnboardingDeps,
  root: Buffer,
): Promise<DoorEnrollment | CeremonyAborted> {
  const prfSalt = generatePrfSalt();
  const ceremony = await deps.ceremony.requestEnrollment({
    userId: deps.userId,
    userEmail: deps.userEmail,
    prfSalt: prfSalt.toString('base64'),
  });
  if (!ceremony.ok) {
    return { ok: false, code: ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED, ceremonyCode: ceremony.code };
  }

  const kek = deriveDeviceKeyKek(Buffer.from(ceremony.prfOutput, 'base64'), prfSalt);
  const aad = deviceKeyWrapAAD(deps.userId, ceremony.credentialId);
  const wrapped = wrapKLocal(root, kek, aad);

  const row = await deps.ops.uploadDoorWrapper({
    wrapped_k_local: wrapped.wrappedKLocal,
    iv: wrapped.iv,
    prf_salt: prfSalt.toString('base64'),
    credential_id: ceremony.credentialId,
    kdf_version: DEVICE_KEY_KDF_VERSION,
  });

  // Best-effort: records ceremony completion. Key-completeness does not
  // depend on it (server-side is_seed anchors the invariant meanwhile).
  let verified = false;
  try {
    await deps.ops.verifyWrapper(row.id);
    verified = true;
  } catch (err) {
    if (!(err instanceof CapyError)) throw err;
  }

  return {
    ok: true,
    credentialId: ceremony.credentialId,
    wrapperId: row.id,
    verified,
    backupEligible: ceremony.backupEligible,
    backupState: ceremony.backupState,
  };
}

/**
 * Upload one org's key.enc, rotating on WRAPPER_CONFLICT: the service keeps
 * one live key_enc row per user×org, so a conflict means a previous upload
 * exists — soft-delete it (safe: the door row anchors the invariant) and
 * re-upload once. Branches on the coded error only.
 */
async function uploadKeyEncRotating(
  deps: OnboardingDeps,
  orgOps: OrgKeyEncOps,
  orgId: string,
  keyEnc: string,
): Promise<void> {
  try {
    await orgOps.uploadKeyEnc(keyEnc);
    return;
  } catch (err) {
    if (!(err instanceof CapyError) || err.code !== ERROR_CODES.WRAPPER_CONFLICT) throw err;
  }
  const inventory = await deps.ops.listWrappers();
  const existing = inventory.find(w => isLiveKeyEnc(w) && w.organization_id === orgId);
  if (existing) {
    await deps.ops.deleteWrapper(existing.id);
  }
  await orgOps.uploadKeyEnc(keyEnc);
}

/**
 * Bring one org's server copy of key.enc in line with the canonical root and
 * this machine's blob. The pending marker brackets the whole operation:
 * it is set before the first side effect and cleared only after the server
 * holds the current blob AND local files are settled, so any crash leaves a
 * persisted instruction to retry (the legacy-migration retry pattern). The
 * marker records `canonicalOrgId` + a fingerprint of `canonicalRoot` (gate-2
 * MAJOR-1) so a later `runPendingSync` retry never has to guess which root
 * this org's crash-interrupted sync was targeting.
 */
async function syncOrgKeyEnc(
  deps: OnboardingDeps,
  orgId: string,
  canonicalRoot: Buffer,
  canonicalOrgId: string,
): Promise<OrgOutcome> {
  const blob = readMasterKey(orgId, deps.userId);
  if (!blob) {
    // Nothing this machine can offer for this org; a machine that has the
    // org's key.enc must do it. An orphaned marker (if any) is cleared.
    clearKeyEncSyncPending(orgId, deps.userId);
    return { orgId, status: 'skipped_no_key_enc' };
  }

  markKeyEncSyncPending(orgId, deps.userId, canonicalOrgId, canonicalRoot);

  const orgOps = await deps.opsForOrg(orgId);
  if (!orgOps) {
    return { orgId, status: 'skipped_no_org_token' };
  }

  try {
    const root = readLocalRoot(orgId, deps.userId);
    if (root && root.equals(canonicalRoot)) {
      // Already on the canonical root — upload the blob unchanged (it is
      // already self-armored: KMS outer + AES-GCM inner).
      await uploadKeyEncRotating(deps, orgOps, orgId, blob);
      clearKeyEncSyncPending(orgId, deps.userId);
      return { orgId, status: 'uploaded' };
    }

    // Divergent (or legacy-keyed) org: unwrap M through the existing
    // resolver path — it alone knows every historical wrapping — then
    // re-key onto the canonical root. Server first, then files, in the
    // established local.key-before-key.enc order.
    const masterKey = await unwrapMasterKey(orgId, deps.userId, orgOps);
    const inner = encryptMasterKey(
      masterKey,
      deriveLocalInnerKey(canonicalRoot),
      masterKeyAAD(deps.userId, orgId),
    );
    const outer = await orgOps.wrapOuterLayer(orgId, inner);
    await uploadKeyEncRotating(deps, orgOps, orgId, outer);
    saveLocalRoot(orgId, canonicalRoot, deps.userId);
    saveMasterKey(orgId, outer, deps.userId);
    clearKeyEncSyncPending(orgId, deps.userId);
    return { orgId, status: 'rekeyed_and_uploaded' };
  } catch (err) {
    if (err instanceof CapyError) {
      // Marker stays: the next enrollment-aware run retries.
      return { orgId, status: 'failed', code: err.code };
    }
    throw err;
  }
}

/** The orgs worth syncing: session orgs plus any org dir holding local state. */
function candidateOrgIds(deps: OnboardingDeps): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  if (deps.activeOrgId) push(deps.activeOrgId);
  for (const org of deps.organizations) push(org.id);
  for (const id of listOrgsWithLocalRoot(deps.userId)) push(id);
  return ids;
}

// --- Case A — brand-new user -------------------------------------------------

/**
 * Case A, invoked AFTER the existing org-creation flow has minted the seed
 * phrase and derived M (that flow — name, phrase display, create-org — is
 * untouched; this replaces only its final wrap-and-save step and adds the
 * enrollment).
 *
 * Recorded ordering decision: files are settled FIRST via the unchanged
 * wrapAndSaveMasterKey (which mints K_local under O_EXCL arbitration exactly
 * as today), and the ceremony wraps the root that actually won the disk.
 * The ticket sketches ceremony-before-writes, but these writes happen in
 * every org-creation regardless of passkey outcome, and wrapping the settled
 * root closes the race where an uploaded door wraps a root that lost the
 * O_EXCL mint — a divergence nothing could later detect. A ceremony refusal
 * therefore leaves the machine byte-identical to today's non-passkey flow:
 * the pre-ceremony wrapAndSaveMasterKey hook marks the org's key.enc
 * sync-pending (an upload is owed the moment a door exists to wrap the
 * root), and a refusal means no door ever will, so the refusal path clears
 * that marker explicitly rather than leaving a permanent, unpayable retry
 * debt for a user who never opted in (gate-2 MAJOR-3).
 *
 * CAP-402 EPHEMERAL-ENVIRONMENT ADDENDUM: the ordering decision above is a
 * deliberate trade FOR A DURABLE DISK — a declined ceremony leaves
 * local.key/key.enc sitting on the SAME machine that is about to read them
 * again tomorrow, so "byte-identical to the non-passkey flow" is exactly
 * right there. `isEphemeralEnvironment()` (CAPY_DEVICE_KEY_GRANT_SOCKET —
 * see ephemeral.ts) means the opposite is true: this disk will not exist
 * tomorrow, so the same "leave it byte-identical" behavior would stage M
 * (via key.enc, inner-keyed by HKDF(K_local)) somewhere that vanishes with
 * nothing else able to decrypt it — the seed phrase becomes the ONLY way
 * back in, silently. So in an ephemeral environment the mint→ceremony→
 * upload sequence is made atomic instead: if the ceremony declines, or the
 * key.enc upload never lands, everything this call minted is deleted
 * (`deleteLocalKeyMaterial`) and a coded `EphemeralEnrollmentIncomplete` is
 * returned — the machine ends the call exactly as it started, never holding
 * a half-finished mint. The door, if one was already uploaded before the
 * key.enc upload failed, is best-effort deleted too (inert otherwise, but
 * tidy). This branch is a straight no-op when `isEphemeralEnvironment()` is
 * false — the durable-machine path above, and CAP-383's byte-identical-
 * refusal test, are unchanged.
 */
export async function runNewUserEnrollment(
  deps: OnboardingDeps,
  args: { orgId: string; masterKey: Buffer },
): Promise<EnrollmentSummary | CeremonyAborted | EphemeralEnrollmentIncomplete> {
  const orgOps = await deps.opsForOrg(args.orgId);
  if (!orgOps) {
    throw new CapyError(
      'No credentials for the new organization — sign in and retry.',
      ERROR_CODES.AUTH_FAILED,
      { orgId: args.orgId },
    );
  }

  const ephemeral = isEphemeralEnvironment();

  // Today's exact persistence path (helper reused wholesale): mints/adopts
  // K_local, writes local.key before key.enc, self-heals mint races. The
  // ops hook marks key.enc.sync-pending so the upload below is owed.
  await wrapAndSaveMasterKey(args.masterKey, args.orgId, deps.userId, orgOps);
  const root = loadOrMintLocalRoot(args.orgId, deps.userId);

  let door: DoorEnrollment | CeremonyAborted;
  try {
    door = await enrollDoor(deps, root);
  } catch (err) {
    if (ephemeral) {
      // The ceremony threw instead of declining gracefully (e.g. a network
      // failure mid-upload) — same "no half-created org" obligation as a
      // graceful decline below.
      clearKeyEncSyncPending(args.orgId, deps.userId);
      deleteLocalKeyMaterial(args.orgId, deps.userId);
    }
    throw err;
  }

  if (!door.ok) {
    // Refusal costs nothing on a durable machine: clear the marker the
    // pre-ceremony wrapAndSaveMasterKey hook set, so the tree is
    // byte-identical to today's non-passkey org creation (gate-2 MAJOR-3) —
    // nothing to retry for an org that was never enrolled.
    clearKeyEncSyncPending(args.orgId, deps.userId);
    if (ephemeral) {
      deleteLocalKeyMaterial(args.orgId, deps.userId);
      return {
        ok: false,
        code: ERROR_CODES.DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE,
        reason: 'ceremony_declined',
        ceremonyCode: door.ceremonyCode,
      };
    }
    return door;
  }

  let orgOutcome: OrgOutcome;
  try {
    orgOutcome = await syncOrgKeyEnc(deps, args.orgId, root, args.orgId);
  } catch (err) {
    if (ephemeral) {
      deleteLocalKeyMaterial(args.orgId, deps.userId);
      await bestEffortDeleteWrapper(deps, door.wrapperId);
    }
    throw err;
  }

  const landedOnServer = orgOutcome.status === 'uploaded' || orgOutcome.status === 'rekeyed_and_uploaded';
  if (ephemeral && !landedOnServer) {
    // The door made it to the server, but this org's key.enc — the other
    // half of what makes M recoverable off this disk — did not. Roll back
    // for the same reason as the ceremony-declined branch above.
    deleteLocalKeyMaterial(args.orgId, deps.userId);
    await bestEffortDeleteWrapper(deps, door.wrapperId);
    return {
      ok: false,
      code: ERROR_CODES.DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE,
      reason: 'upload_incomplete',
    };
  }

  return {
    ok: true,
    credentialId: door.credentialId,
    wrapperId: door.wrapperId,
    verified: door.verified,
    backupEligible: door.backupEligible,
    backupState: door.backupState,
    orgs: [orgOutcome],
  };
}

/** Best-effort cleanup of an orphaned door on ephemeral rollback — inert if
 *  it stays (nothing decrypts through it without a matching key.enc), but
 *  tidy to remove. Never lets a delete failure mask the real outcome. */
async function bestEffortDeleteWrapper(deps: OnboardingDeps, wrapperId: string): Promise<void> {
  try {
    await deps.ops.deleteWrapper(wrapperId);
  } catch {
    // Best-effort by contract — see docblock above.
  }
}

// --- Case B — existing user, existing machine, first device key --------------

export async function runFirstEnrollment(
  deps: OnboardingDeps,
): Promise<EnrollmentSummary | CeremonyAborted | RoutingVerdict> {
  const rootOrgs = listOrgsWithLocalRoot(deps.userId);
  const ordered =
    deps.activeOrgId && rootOrgs.includes(deps.activeOrgId)
      ? [deps.activeOrgId, ...rootOrgs.filter(id => id !== deps.activeOrgId)]
      : rootOrgs;

  // Iterate every candidate for the first PARSEABLE root (active org
  // preferred): one corrupt/truncated local.key must not dead-end
  // enrollment when another org holds a working root (gate-2 MAJOR-4).
  let canonicalOrgId: string | null = null;
  let canonicalRoot: Buffer | null = null;
  for (const candidate of ordered) {
    const root = readLocalRoot(candidate, deps.userId);
    if (root) {
      canonicalOrgId = candidate;
      canonicalRoot = root;
      break;
    }
  }
  if (!canonicalOrgId || !canonicalRoot) {
    // Detection said Case B, but nothing on this machine parses as a usable
    // 32-byte root — degrade to the B′ routing verdict instead of
    // dead-ending in a throw (gate-2 MAJOR-4).
    return { ok: false, kind: 'recovery_or_transport', code: ERROR_CODES.INVALID_FORMAT };
  }

  const door = await enrollDoor(deps, canonicalRoot);
  if (!door.ok) return door;

  // The canonical org first: it needs no re-key (its root IS the canonical),
  // so it settles earliest — and a crash mid-loop then leaves at least one
  // marker-free org from which runPendingSync can re-derive the canonical.
  const orgIds = candidateOrgIds(deps);
  orgIds.sort((a, b) => (a === canonicalOrgId ? -1 : b === canonicalOrgId ? 1 : 0));

  const orgs: OrgOutcome[] = [];
  for (const orgId of orgIds) {
    orgs.push(await syncOrgKeyEnc(deps, orgId, canonicalRoot, canonicalOrgId));
  }

  return {
    ok: true,
    credentialId: door.credentialId,
    wrapperId: door.wrapperId,
    verified: door.verified,
    backupEligible: door.backupEligible,
    backupState: door.backupState,
    orgs,
  };
}

// --- Case C / C′ — enrolled user, fresh machine ------------------------------

export async function runUnlock(
  deps: OnboardingDeps,
  inventory?: KeyWrapperMetadata[],
): Promise<UnlockSummary | CeremonyAborted> {
  const rows = inventory ?? (await deps.ops.listWrappers());
  const doors = rows.filter(isLiveDoor);
  if (doors.length === 0) {
    throw new CapyError(
      'No device key is enrolled for this account.',
      ERROR_CODES.WRAPPER_NOT_FOUND,
      { reason: 'no_live_doors' },
    );
  }

  // The list is metadata-only; each door's prf_salt/iv/ciphertext requires a
  // full fetch, which is fresh-auth gated the same as key_enc rows are (see
  // ops.fetchWrapper's docblock) — deps.ops.fetchWrapper handles the
  // refresh-and-retry dance transparently.
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

  const ceremony = await deps.ceremony.requestUnlock({
    userId: deps.userId,
    candidates: [...doorPayloads.values()].map(p => ({
      credentialId: p.credential_id!,
      prfSalt: p.prf_salt!,
    })),
  });
  if (!ceremony.ok) {
    return { ok: false, code: ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED, ceremonyCode: ceremony.code };
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

  const orgs: OrgOutcome[] = [];
  for (const row of rows.filter(isLiveKeyEnc)) {
    const orgId = row.organization_id;
    if (!orgId) {
      orgs.push({ orgId: '', status: 'failed', code: ERROR_CODES.INVALID_FORMAT });
      continue;
    }
    orgs.push(await installOrgFromServer(deps, orgId, row.id, kLocal));
  }

  return { ok: true, credentialId: ceremony.credentialId, orgs };
}

/**
 * Case C per-org install: download key.enc, write local.key then key.enc via
 * the existing helpers. Never overwrites live local state: an org already
 * provisioned on this root is untouched (the server copy may legitimately
 * lag a local re-wrap — the sync marker owns that direction), and an org on
 * a DIFFERENT root is refused with a coded outcome rather than orphaned.
 */
async function installOrgFromServer(
  deps: OnboardingDeps,
  orgId: string,
  wrapperId: string,
  kLocal: Buffer,
): Promise<OrgOutcome> {
  const existingRoot = readLocalRoot(orgId, deps.userId);
  const hasBlob = readMasterKey(orgId, deps.userId) !== null;

  if (existingRoot && !existingRoot.equals(kLocal)) {
    return { orgId, status: 'local_root_conflict', code: ERROR_CODES.LOCAL_ROOT_CONFLICT };
  }
  if (existingRoot && hasBlob) {
    return { orgId, status: 'already_provisioned' };
  }

  const orgOps = await deps.opsForOrg(orgId);
  if (!orgOps) {
    return { orgId, status: 'skipped_no_org_token' };
  }

  try {
    const blob = await orgOps.fetchKeyEnc(wrapperId);

    if (!existingRoot) {
      if (!saveLocalRootExclusive(orgId, kLocal, deps.userId)) {
        const winner = readLocalRoot(orgId, deps.userId);
        if (!winner || !winner.equals(kLocal)) {
          return { orgId, status: 'local_root_conflict', code: ERROR_CODES.LOCAL_ROOT_CONFLICT };
        }
      }
    }
    saveMasterKey(orgId, blob, deps.userId);
    return { orgId, status: 'installed' };
  } catch (err) {
    if (err instanceof CapyError) {
      return { orgId, status: 'failed', code: err.code };
    }
    throw err;
  }
}

// --- Sync sweep — the "retry on next run" half of the invariant --------------

/**
 * LEGACY FALLBACK ONLY (gate-2 MAJOR-1): a sync-pending marker written before
 * the canonical-identity format (empty/unparseable content) carries no
 * recorded canonical org of its own. For those markers only, guess a
 * canonical root the same way the original sweep did, but fixed: a
 * "settled" org must have BOTH a parseable local.key AND a key.enc blob —
 * excluding an org a crash left with a root but no blob, or one
 * syncOrgKeyEnc's skipped_no_key_enc branch cleared without ever comparing
 * roots — and the pick is deterministic (active org preferred, else
 * lexicographic), never filesystem readdir order.
 */
function legacyCanonicalIdentity(
  deps: OnboardingDeps,
  pending: string[],
): { orgId: string; root: Buffer } | null {
  const pendingSet = new Set(pending);
  const settled = listOrgsWithLocalRoot(deps.userId)
    .filter(id => !pendingSet.has(id))
    .filter(id => readLocalRoot(id, deps.userId) !== null && readMasterKey(id, deps.userId) !== null)
    .sort((a, b) => {
      if (a === deps.activeOrgId) return -1;
      if (b === deps.activeOrgId) return 1;
      return a.localeCompare(b);
    });
  if (settled.length === 0) return null;
  const root = readLocalRoot(settled[0], deps.userId);
  return root ? { orgId: settled[0], root } : null;
}

/**
 * Resolve the canonical (orgId, root) a pending org's retry should target.
 * Trusts ONLY the identity the org's OWN marker recorded at mark-time — a
 * marker-free divergent org (e.g. one joined via `capy redeem` after
 * enrollment) can therefore never be mistaken for canonical, which is the
 * exact MAJOR-1 orphaning path this replaces. A marker whose recorded
 * canonical org's root has since moved or vanished fails closed (coded)
 * rather than silently substituting something else. Only a marker that
 * predates the format falls back to the deterministic legacy guess, and
 * finally to the org's own root (nothing to unify onto, so it re-uploads
 * itself unchanged — the historical single-org-pending behavior).
 */
function resolveCanonicalForPendingOrg(
  deps: OnboardingDeps,
  orgId: string,
  legacyFallback: { orgId: string; root: Buffer } | null,
): { canonicalOrgId: string; canonicalRoot: Buffer } | { code: string } {
  const marker = readKeyEncSyncPendingMarker(orgId, deps.userId);
  if (marker) {
    const canonicalRoot = readLocalRoot(marker.canonicalOrgId, deps.userId);
    if (!canonicalRoot || rootFingerprint(canonicalRoot) !== marker.canonicalRootSha256) {
      return { code: ERROR_CODES.INVALID_FORMAT };
    }
    return { canonicalOrgId: marker.canonicalOrgId, canonicalRoot };
  }
  if (legacyFallback) {
    return { canonicalOrgId: legacyFallback.orgId, canonicalRoot: legacyFallback.root };
  }
  const ownRoot = readLocalRoot(orgId, deps.userId);
  if (!ownRoot) return { code: ERROR_CODES.INVALID_FORMAT };
  return { canonicalOrgId: orgId, canonicalRoot: ownRoot };
}

/**
 * Retry every owed key.enc upload (key.enc.sync-pending markers). Runs from
 * enrollment-aware contexts only; does nothing without markers. When the
 * account has no live door (never enrolled / fully un-enrolled) the markers
 * are left in place and reported — there is no enrolled root to sync onto.
 */
export async function runPendingSync(deps: OnboardingDeps): Promise<OrgOutcome[]> {
  const pending = listOrgsWithKeyEncSyncPending(deps.userId);
  if (pending.length === 0) return [];

  const inventory = await deps.ops.listWrappers();
  if (inventory.filter(isLiveDoor).length === 0) {
    return pending.map(orgId => ({
      orgId,
      status: 'failed' as const,
      code: ERROR_CODES.WRAPPER_NOT_FOUND,
    }));
  }

  const legacyFallback = legacyCanonicalIdentity(deps, pending);

  const outcomes: OrgOutcome[] = [];
  for (const orgId of pending) {
    const resolved = resolveCanonicalForPendingOrg(deps, orgId, legacyFallback);
    if ('code' in resolved) {
      outcomes.push({ orgId, status: 'failed', code: resolved.code });
      continue;
    }
    outcomes.push(await syncOrgKeyEnc(deps, orgId, resolved.canonicalRoot, resolved.canonicalOrgId));
  }
  return outcomes;
}
