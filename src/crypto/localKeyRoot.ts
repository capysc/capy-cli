import { randomBytes, hkdfSync } from 'crypto';

/**
 * K_local — the machine-local inner-wrap root.
 *
 * Background: the legacy inner-wrap key was SHA256(userId:orgId). Both inputs
 * are public identifiers the service already knows, so during co-decrypt
 * (where the service strips the KMS outer layer) the service could recompute
 * the inner key and recover M. The inner layer provided no confidentiality
 * against the service itself — only against a stolen-disk attacker.
 *
 * Fix: K_local is 32 bytes of CSPRNG output, minted per machine (per
 * org+user), stored 0600 beside key.enc, never transmitted and never
 * derivable from any identifier. The inner wrapping key is HKDF'd from it,
 * so the service can strip the KMS layer and still recover nothing — the
 * inner key never leaves the machine.
 *
 * Consequence: key.enc is machine-bound. Copying ~/.capy to a new machine
 * still works (local.key rides along); copying key.enc alone does not.
 * Losing local.key means re-redeeming an invite, same as a lost device.
 *
 * This module is pure derivation; storage lives in config/globalConfig.ts.
 */

const K_LOCAL_LENGTH = 32;

/** Mints a fresh K_local. */
export function generateLocalRoot(): Buffer {
  return randomBytes(K_LOCAL_LENGTH);
}

/** Inner wrapping key for key.enc, derived from K_local. */
export function deriveLocalInnerKey(kLocal: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kLocal, 'capy:inner', 'capy:inner:master', 32));
}
