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
import { generateLocalRoot, deriveLocalInnerKey } from './localKeyRoot';
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
}

/**
 * Unwraps the org master key M from its double-wrapped on-disk form.
 *
 * M is stored double-wrapped: KMS_ENCRYPT(AES-GCM(M, HKDF(K_local))).
 * To unwrap:
 * 1. Send the blob to the server's co-decrypt endpoint (strips KMS outer layer)
 * 2. Decrypt the inner layer locally with HKDF(K_local) — a per-machine secret
 *    the service never sees, so the co-decrypt output is opaque to it
 *
 * Without the server, the blob on disk is KMS-encrypted garbage — no M, no
 * decrypt. Without K_local, the co-decrypt output is AES-GCM garbage — the
 * service cannot recover M from anything it handles.
 *
 * Migration (transparent, no prompts):
 * - A blob whose inner layer is still keyed by the legacy SHA256(userId:orgId)
 *   unwraps via the legacy key, then is re-wrapped onto K_local.
 * - A blob with no KMS outer layer at all (oldest format) unwraps locally,
 *   then is re-wrapped with both layers.
 * Both re-wraps are best-effort: if the server is unavailable mid-migration,
 * this run proceeds with M and the next run retries.
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

  const legacyInnerKey = deriveWrappingKey(userId, orgId);
  const innerAAD = masterKeyAAD(userId, orgId);

  // Try double-wrapped path: co-decrypt strips KMS outer, then inner unwrap
  try {
    const innerBlob = await service.coDecrypt(orgId, encryptedBlob);

    // K_local first — the steady state.
    const kLocal = readLocalRoot(orgId, userId);
    if (kLocal) {
      try {
        return decryptMasterKey(innerBlob, deriveLocalInnerKey(kLocal), innerAAD);
      } catch {
        // K_local exists but the blob isn't keyed by it — a crash landed
        // between minting local.key and re-wrapping key.enc. Fall through to
        // the legacy key; the re-wrap below self-heals onto the existing root.
      }
    }

    // Legacy inner key — unwrap, then migrate the blob onto K_local.
    const masterKey = decryptMasterKey(innerBlob, legacyInnerKey, innerAAD);
    await wrapAndSaveMasterKey(masterKey, orgId, userId, service).catch(() => {
      // Best-effort: next run retries the migration.
    });
    return masterKey;
  } catch (err) {
    // 403 = membership revoked — do NOT fall through to legacy path.
    // Re-throw so the caller can clean up appropriately.
    if (isPermissionDenied(err)) throw err;

    // Network / connectivity failure — re-throw so a transient outage
    // doesn't get misclassified as PERMISSION_DENIED and nuke local keys.
    if (isNetworkError(err)) throw err;

    // Other errors (e.g. blob isn't KMS-wrapped) → fall through to legacy
  }

  // Migration: try legacy single-wrapped (no KMS outer layer). Its inner key
  // is the legacy hash by definition — single-wrap predates K_local.
  let masterKey: Buffer;
  try {
    masterKey = decryptMasterKey(encryptedBlob, legacyInnerKey, innerAAD);
  } catch {
    throw new CapyError(
      'You do not have access to this project\'s secrets.\n\n' +
      'The server rejected the co-decrypt request, or the local key is invalid.\n' +
      'Ask the project owner to invite you, or run capy in a different directory.',
      ERROR_CODES.PERMISSION_DENIED,
      { orgId },
    );
  }

  // Legacy blob unwrapped — re-wrap (K_local inner + KMS outer) for future runs
  await wrapAndSaveMasterKey(masterKey, orgId, userId, service).catch(() => {
    // Re-wrap failed (server unavailable?) — proceed with the unwrapped M this
    // time. Next run will retry migration.
  });

  return masterKey;
}

/**
 * Resolves the encryption key for a project: unwrap M (see unwrapMasterKey),
 * then derive the project key via HKDF(M, projectId, orgId).
 */
export async function resolveProjectKey(
  orgId: string,
  projectId: string,
  userId: string,
  service: KeyServiceOps,
): Promise<string> {
  const masterKey = await unwrapMasterKey(orgId, userId, service);
  return deriveProjectKey(masterKey, projectId, orgId);
}

/**
 * Double-wraps M for local storage.
 * Inner layer: AES-GCM with HKDF(K_local) — a per-machine secret the service
 * never sees (NOT the legacy SHA256(userId:orgId), which it could recompute)
 * Outer layer: KMS via service wrap endpoint
 *
 * Reuses this machine's K_local if one exists; mints one otherwise. local.key
 * is persisted BEFORE the re-wrapped blob: a crash between the two writes
 * leaves key.enc on its old key and the next run self-heals, whereas the
 * reverse order could write a key.enc whose root was never saved.
 */
export async function wrapAndSaveMasterKey(
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
  const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(userId, orgId));
  // innerWrapped is already base64 — pass directly to wrapOuterLayer
  const outerWrapped = await service.wrapOuterLayer(orgId, innerWrapped);
  saveMasterKey(orgId, outerWrapped, userId);
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
