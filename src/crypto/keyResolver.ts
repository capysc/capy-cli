import { randomBytes } from 'crypto';
import {
  deriveProjectKey,
  deriveWrappingKey,
  deriveLocalWrappingKey,
  decryptMasterKey,
  encryptMasterKey,
  seedPhraseToMasterKey,
  LOCAL_KEY_ITERATIONS,
  CURRENT_KDF_VERSION,
  KDF_VERSIONS,
  KdfVersion,
  masterKeyAAD,
  LOCAL_MASTER_KEY_AAD,
} from './keyManager';
import {
  readMasterKey,
  saveMasterKey,
  readProjectKeyCache,
  saveProjectKeyCache,
  hasOrgKey as globalHasOrgKey,
  saveLocalKeyRecord,
  readLocalKeyRecord,
  readLocalRoot,
  saveLocalRoot,
  LOCAL_ORG_ID,
} from '../config/globalConfig';
import { generateLocalRoot, deriveEpochInnerKey } from './localKeyRoot';
import { CapyError, ERROR_CODES } from '../types/index';

/** Check whether an error is a server 403 (membership revoked). */
function isPermissionDenied(err: unknown): boolean {
  return err instanceof CapyError
    && err.code === ERROR_CODES.PERMISSION_DENIED
    && err.details?.status === 403;
}

/** Check whether an error is a network / connectivity failure. */
function isNetworkError(err: unknown): boolean {
  return err instanceof CapyError && err.code === ERROR_CODES.NETWORK_ERROR;
}

/**
 * Interface for the co-decrypt + wrap operations needed by key resolution.
 * Callers provide this so keyResolver doesn't depend on ServiceClient directly.
 */
export interface KeyServiceOps {
  /** Strip the KMS outer layer via POST /orgs/:orgId/co-decrypt */
  coDecrypt(orgId: string, ciphertext: string): Promise<string>;
  /** Add the KMS outer layer via POST /orgs/:orgId/wrap */
  wrapOuterLayer(orgId: string, plaintext: string): Promise<string>;
  // --- Epoch awareness (CAP-58, optional) ---
  // When present, resolveProjectKey transparently catches this machine up to the
  // org's current epoch before deriving the data key (recovering the current
  // epoch key from M + escrow). Absent → epoch 0 / legacy behavior. Old service
  // builds that lack the endpoints simply make these reject, which is swallowed.
  /** Current org epoch via GET /orgs/:orgId/epoch */
  getEpoch?(orgId: string): Promise<number>;
  /** All escrow blobs (epoch → blob) via GET /orgs/:orgId/epoch/escrow */
  getEpochEscrows?(orgId: string): Promise<Record<string, string>>;
}

/**
 * Unwraps the inner blob (KMS already stripped) to recover M, trying the
 * current K_local inner key first and falling back to the legacy
 * SHA256(userId:orgId) key. Returns whether the legacy key was used, so the
 * caller can trigger a transparent re-wrap under K_local.
 *
 * Trying K_local-then-legacy (rather than assuming one) also self-heals a
 * split-brain: if K_local was minted but key.enc wasn't yet re-wrapped (crash
 * mid-migration), the legacy key still opens it and we re-wrap.
 */
function unwrapInner(
  innerBlob: string,
  orgId: string,
  userId: string,
  innerAAD: Buffer,
): { masterKey: Buffer; usedLegacy: boolean } {
  const kLocal = readLocalRoot(orgId, userId);
  if (kLocal) {
    try {
      return { masterKey: decryptMasterKey(innerBlob, deriveEpochInnerKey(kLocal), innerAAD), usedLegacy: false };
    } catch {
      // K_local didn't open it — fall through to the legacy key (split-brain
      // or a blob from before this machine minted K_local).
    }
  }
  // Legacy path: the publicly-computable SHA256(userId:orgId). Throws if this
  // key doesn't open the blob either — the caller maps that to PERMISSION_DENIED.
  const masterKey = decryptMasterKey(innerBlob, deriveWrappingKey(userId, orgId), innerAAD);
  return { masterKey, usedLegacy: true };
}

/**
 * Re-wraps M under K_local (minting one if this machine has none) and persists
 * the double-wrapped blob. This is the inner-wrap migration: it moves a blob
 * off the legacy SHA256(userId:orgId) key — which the service can recompute —
 * onto a device-local secret the service never sees (CAP-58 / K_local).
 *
 * Best-effort: a failure here (e.g. server unavailable) leaves the existing
 * blob in place; the next run retries.
 */
async function rewrapUnderLocalRoot(
  masterKey: Buffer,
  orgId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<void> {
  let kLocal = readLocalRoot(orgId, userId);
  if (!kLocal) {
    kLocal = generateLocalRoot();
    saveLocalRoot(orgId, kLocal, userId);
  }
  const innerWrapped = encryptMasterKey(masterKey, deriveEpochInnerKey(kLocal), masterKeyAAD(userId, orgId));
  const outerWrapped = await service.wrapOuterLayer(orgId, innerWrapped);
  saveMasterKey(orgId, outerWrapped, userId);
}

/**
 * Recovers M from the on-disk double-wrapped blob via the service co-decrypt
 * round trip, transparently migrating the inner wrap onto K_local on first
 * sight of a legacy blob. Shared by resolveProjectKey and transport.
 *
 * M is stored double-wrapped: KMS_ENCRYPT(AES-GCM(M, HKDF(K_local))).
 * 1. co-decrypt strips the KMS outer layer
 * 2. unwrap the inner layer (K_local, falling back to legacy SHA256)
 * 3. if legacy was used, re-wrap under K_local for future runs
 */
export async function unwrapMasterKey(
  orgId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<Buffer> {
  const encryptedBlob = readMasterKey(orgId, userId);
  if (!encryptedBlob) {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'Ask the project owner to invite you, or run capy in a different directory to create your own project.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }

  const innerAAD = masterKeyAAD(userId, orgId);

  // Try double-wrapped path: co-decrypt strips KMS outer, then inner unwrap.
  try {
    const innerBlob = await service.coDecrypt(orgId, encryptedBlob);
    const { masterKey, usedLegacy } = unwrapInner(innerBlob, orgId, userId, innerAAD);
    if (usedLegacy) {
      // Transparent inner-wrap migration onto K_local. Never block resolution
      // on it succeeding.
      await rewrapUnderLocalRoot(masterKey, orgId, userId, service).catch(() => {});
    }
    return masterKey;
  } catch (err) {
    // 403 = membership revoked — do NOT fall through to legacy path.
    if (isPermissionDenied(err)) throw err;
    // Network / connectivity failure — re-throw so a transient outage isn't
    // misclassified as PERMISSION_DENIED and used to nuke local keys.
    if (isNetworkError(err)) throw err;
    // Other errors (e.g. blob isn't KMS-wrapped) → fall through to legacy.
  }

  // Migration: legacy single-wrapped (no KMS outer layer).
  let masterKey: Buffer;
  try {
    ({ masterKey } = unwrapInner(encryptedBlob, orgId, userId, innerAAD));
  } catch {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'The server rejected the co-decrypt request, or the local key is invalid.\n' +
      'Ask the project owner to invite you, or run capy in a different directory.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }
  // Legacy blob unwrapped — re-wrap (KMS outer + K_local inner) for future runs.
  await rewrapUnderLocalRoot(masterKey, orgId, userId, service).catch(() => {});
  return masterKey;
}

/**
 * Resolves the data-encryption key for a project at the org's CURRENT epoch
 * (CAP-58). At epoch 0 the epoch key is M, so this is identical to the legacy
 * deriveProjectKey(M, …); at epoch ≥1 it derives from the stored epoch key E_e.
 * All sync/encrypt/decrypt sites route through here, so they transparently
 * follow epoch bumps.
 *
 * Reading a snapshot pinned to an OLDER epoch (cross-epoch pinned checkout)
 * needs the history walk — see resolveProjectKeyForEpoch (follow-up).
 */
export async function resolveProjectKey(
  orgId: string,
  projectId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<string> {
  // Lazy import avoids a cycle (epochManager imports keyResolver.unwrapMasterKey).
  const { getCurrentEpochKey } = await import('./epochManager');
  const { key } = await getCurrentEpochKey(orgId, userId, service);
  return deriveProjectKey(key, projectId, orgId);
}

/**
 * Double-wraps M for local storage.
 * Inner layer: AES-GCM with HKDF(K_local, "capy:inner:epoch") — NOT the legacy
 * SHA256(userId:orgId), which the service could recompute. A fresh K_local is
 * minted for this machine if none exists.
 * Outer layer: KMS via service wrap endpoint.
 */
export async function wrapAndSaveMasterKey(
  masterKey: Buffer,
  orgId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<void> {
  await rewrapUnderLocalRoot(masterKey, orgId, userId, service);
}

/**
 * Resolves a project key offline using a seed phrase (owner self-custody).
 * No server needed — the seed phrase replaces both shares.
 *
 * `version` selects the KDF used to derive M. Defaults to CURRENT_KDF_VERSION;
 * callers that don't know the org's version should use resolveProjectKeyByTrial
 * instead (it detects the version against a known ciphertext).
 */
export function resolveFromSeedPhrase(
  seedPhrase: string,
  orgId: string,
  projectId: string,
  version: KdfVersion = CURRENT_KDF_VERSION,
): string {
  const masterKey = seedPhraseToMasterKey(seedPhrase, version);
  return deriveProjectKey(masterKey, projectId, orgId);
}

/** Outcome of a successful trial resolution. */
export interface TrialResolution {
  projectKey: string;
  masterKey: Buffer;
  version: KdfVersion;
}

/**
 * Resolves a project key from a seed phrase when the org's KDF version is
 * unknown.
 *
 * M's value is bound to the KDF version that created the org, and that version
 * isn't recorded anywhere (it can't be: recovery is offline-from-phrase-only).
 * So we derive M under each known version (newest first) and return the first
 * whose project key satisfies `verify` — a decryption oracle over a piece of
 * known ciphertext for this project.
 *
 * Returns null if no version verifies, which means either the phrase is wrong
 * or the ciphertext belongs to a different project/org. Callers MUST treat null
 * as "do not write a key" — guessing a version would corrupt the org for every
 * other member.
 */
export function resolveProjectKeyByTrial(
  seedPhrase: string,
  orgId: string,
  projectId: string,
  verify: (projectKey: string) => boolean,
): TrialResolution | null {
  for (const version of KDF_VERSIONS) {
    const masterKey = seedPhraseToMasterKey(seedPhrase, version);
    const projectKey = deriveProjectKey(masterKey, projectId, orgId);
    if (verify(projectKey)) {
      return { projectKey, masterKey, version };
    }
  }
  return null;
}

/**
 * Checks whether an org's master key exists on disk.
 */
export function hasOrgKey(orgId: string, userId?: string): boolean {
  return globalHasOrgKey(orgId, userId);
}

// --- Local-only mode -------------------------------------------------------
//
// Local-only mode is persistent recover-mode protected by a passphrase. M is
// derived locally from a seed phrase, then wrapped at rest with a PBKDF2
// (passphrase) key — no server KMS layer. Everything below M (project key
// derivation, value crypto) is identical to the server-backed path.

/**
 * Derives a project key from a locally-held master key (hex), with the org
 * pinned to LOCAL_ORG_ID. Pure-local analog of resolveFromSeedPhrase.
 */
export function resolveFromLocalKey(masterKeyHex: string, projectId: string): string {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  return deriveProjectKey(masterKey, projectId, LOCAL_ORG_ID);
}

/**
 * Wraps M with a passphrase-derived key and writes the local keystore record
 * to ~/.capy/local/key.local. Used by the `capy byoc` local-setup flow.
 */
export function saveLocalKey(masterKey: Buffer, passphrase: string): void {
  const salt = randomBytes(16);
  const wrappingKey = deriveLocalWrappingKey(passphrase, salt);
  const encrypted = encryptMasterKey(masterKey, wrappingKey, LOCAL_MASTER_KEY_AAD);
  saveLocalKeyRecord({
    version: '1.0',
    wrapping_method: 'passphrase',
    salt: salt.toString('base64'),
    iterations: LOCAL_KEY_ITERATIONS,
    encrypted_master_key: encrypted,
    created_at: new Date().toISOString(),
  });
}

/**
 * Unwraps M from the local keystore using the passphrase, returning M as hex.
 * Throws a clean CapyError on a wrong passphrase (GCM auth-tag failure) or a
 * missing keystore — never leaks a raw crypto stack trace.
 */
export function decryptLocalMasterKeyHex(passphrase: string): string {
  const record = readLocalKeyRecord();
  if (!record) {
    throw new CapyError(
      'No local key found. Run `capy byoc` and choose local mode to set one up.',
      ERROR_CODES.PERMISSION_DENIED,
    );
  }
  const salt = Buffer.from(record.salt, 'base64');
  const wrappingKey = deriveLocalWrappingKey(passphrase, salt);
  try {
    const masterKey = decryptMasterKey(record.encrypted_master_key, wrappingKey, LOCAL_MASTER_KEY_AAD);
    return masterKey.toString('hex');
  } catch {
    throw new CapyError('Incorrect passphrase.', ERROR_CODES.PERMISSION_DENIED);
  }
}
