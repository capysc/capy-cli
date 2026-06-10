import { randomBytes, hkdfSync } from 'crypto';
import { aesEncrypt, aesDecrypt } from './inviteCrypto';

/**
 * Epoch key model (CAP-58 / docs/epoch-key-design.md).
 *
 * Data is encrypted under per-epoch keys, never under a key derived from the
 * org master key M. Each kick mints a fresh random epoch key with no
 * mathematical relationship to any previous key (forward secrecy against
 * exfiltration). The current epoch key unlocks all past epoch keys via an
 * encrypted backward chain (full-history access for invitees).
 *
 * This module is pure crypto — no I/O, no service calls. Service transport and
 * command flows live elsewhere.
 */

const EPOCH_KEY_LENGTH = 32;

/** Mints a fresh epoch key: 32 bytes of CSPRNG output, derived from nothing. */
export function generateEpochKey(): Buffer {
  return randomBytes(EPOCH_KEY_LENGTH);
}

/**
 * The migration epoch key E_0 for an org that has data encrypted under the
 * legacy M-derived scheme. Deterministically derived from M so existing
 * (untagged) ciphertext reads as epoch 0 without re-encryption.
 *
 * IMPORTANT: E_0 is the ONLY epoch key derived from M. Every E_e for e >= 1 is
 * fresh randomness from generateEpochKey().
 */
export function deriveEpoch0(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'epoch-0', 'capy:epoch-0', EPOCH_KEY_LENGTH));
}

/**
 * Derives the project-scoped data-encryption key from an epoch key.
 * Mirrors the legacy deriveProjectKey(M, ...) shape (salt=orgId, info per
 * project) so that, at epoch 0, deriveProjectKey(deriveEpoch0(M), p, org)
 * equals the legacy deriveProjectKey(M, p, org) IFF E_0 == M. It does not —
 * E_0 = HKDF(M) — so epoch-0 ciphertext is re-derived under E_0, which the
 * migration path accounts for. Returns a 32-byte key as hex (Encryptor input).
 */
export function deriveProjectKey(
  epochKey: Buffer,
  projectId: string,
  orgId: string,
): string {
  const derived = hkdfSync(
    'sha256',
    epochKey,
    orgId,
    `capy:project:${projectId}`,
    32,
  );
  return Buffer.from(derived).toString('hex');
}

/**
 * AAD binding a snapshot's ciphertext to {orgId, projectId, epoch}. Extends
 * capy-cli #233's masterKeyAAD scheme down to the data layer: re-tagging a
 * snapshot with a different epoch / project / org fails the AEAD check, so a
 * blob can't be spliced across epochs or projects.
 */
export function snapshotAAD(orgId: string, projectId: string, epoch: number): Buffer {
  return Buffer.from(`capy:snapshot:v1:${orgId}:${projectId}:${epoch}`, 'utf8');
}

// ---------------------------------------------------------------------------
// History chain (backward) — org-wide and per-project
// ---------------------------------------------------------------------------

/**
 * Writes the history blob for the transition e-1 -> e:
 *   AES-GCM( prevKey, key = HKDF(newKey, "history") )
 *
 * Holding the NEW (current) key, you derive the wrapping key and recover the
 * PREVIOUS key — and recurse to the start. You cannot walk forward: newKey is
 * fresh randomness, unreachable from prevKey.
 */
export function wrapHistoryBlob(prevKey: Buffer, newKey: Buffer): string {
  const wrappingKey = Buffer.from(hkdfSync('sha256', newKey, 'history', 'capy:epoch:history', 32));
  return aesEncrypt(prevKey, wrappingKey);
}

/** Recovers the previous epoch key from a history blob, given the new key. */
export function unwrapHistoryBlob(blob: string, newKey: Buffer): Buffer {
  const wrappingKey = Buffer.from(hkdfSync('sha256', newKey, 'history', 'capy:epoch:history', 32));
  return aesDecrypt(blob, wrappingKey);
}

/**
 * Per-project history blob. The chain is over DERIVED keys so a project-scoped
 * member's walk stays confined to their project and never exposes the org-wide
 * epoch key or another project's keys:
 *   AES-GCM( deriveProjectKey(E_{e-1}, p), key = HKDF(deriveProjectKey(E_e, p), "history") )
 */
export function wrapProjectHistoryBlob(
  prevKey: Buffer,
  newKey: Buffer,
  projectId: string,
  orgId: string,
): string {
  const prevDerived = Buffer.from(deriveProjectKey(prevKey, projectId, orgId), 'hex');
  const newDerived = Buffer.from(deriveProjectKey(newKey, projectId, orgId), 'hex');
  const wrappingKey = Buffer.from(hkdfSync('sha256', newDerived, 'history', 'capy:epoch:history', 32));
  return aesEncrypt(prevDerived, wrappingKey);
}

/**
 * Recovers the previous epoch's DERIVED project key from a per-project history
 * blob, given the new epoch's derived project key. Returns the derived key as
 * hex (same shape as deriveProjectKey).
 */
export function unwrapProjectHistoryBlob(
  blob: string,
  newDerivedKeyHex: string,
): string {
  const newDerived = Buffer.from(newDerivedKeyHex, 'hex');
  const wrappingKey = Buffer.from(hkdfSync('sha256', newDerived, 'history', 'capy:epoch:history', 32));
  return aesDecrypt(blob, wrappingKey).toString('hex');
}

// ---------------------------------------------------------------------------
// Escrow (owner break-glass)
// ---------------------------------------------------------------------------

/**
 * Escrow blob for epoch e: AES-GCM( E_e, key = HKDF(M, "escrow", e) ).
 * Owner-only: seed phrase -> M -> open every escrow -> every epoch key, fully
 * offline (ADR-6 break-glass preserved). The epoch number is bound into the
 * HKDF info so blobs are not interchangeable across epochs.
 */
export function wrapEscrowBlob(masterKey: Buffer, epoch: number, epochKey: Buffer): string {
  const wrappingKey = Buffer.from(hkdfSync('sha256', masterKey, 'escrow', `capy:epoch:escrow:${epoch}`, 32));
  return aesEncrypt(epochKey, wrappingKey);
}

/** Recovers an epoch key from its escrow blob using M. Wrong M fails GCM auth. */
export function unwrapEscrowBlob(blob: string, masterKey: Buffer, epoch: number): Buffer {
  const wrappingKey = Buffer.from(hkdfSync('sha256', masterKey, 'escrow', `capy:epoch:escrow:${epoch}`, 32));
  return aesDecrypt(blob, wrappingKey);
}
