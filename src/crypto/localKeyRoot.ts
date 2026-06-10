import { randomBytes, hkdfSync } from 'crypto';

/**
 * K_local — the device-local inner-wrap root (CAP-58 / docs/epoch-key-design.md
 * §4, ADR-12 amended 2026-06-09).
 *
 * Background: the legacy inner-wrap key was SHA256(userId:orgId) — both inputs
 * are public identifiers the service knows, so during co-decrypt (where the
 * service strips the KMS outer layer) the service could recompute the inner key
 * and recover M. The inner layer provided no confidentiality against the
 * service. Re-keying it with the device private key would be circular, since
 * that key is itself wrapped the same way.
 *
 * Fix: K_local is 32 bytes of CSPRNG output, generated per machine, stored
 * 0600 alongside key.enc, NEVER transmitted and NEVER derivable from any
 * identifier. Both local inner wraps are HKDF'd from it. The service can strip
 * KMS all day and recover nothing — the inner key never leaves the machine.
 *
 * This module is pure derivation; storage lives in config/globalConfig.ts.
 */

const K_LOCAL_LENGTH = 32;

/** Mints a fresh K_local. */
export function generateLocalRoot(): Buffer {
  return randomBytes(K_LOCAL_LENGTH);
}

/** Inner wrapping key for key.enc (the epoch-key blob). */
export function deriveEpochInnerKey(kLocal: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kLocal, 'capy:inner', 'capy:inner:epoch', 32));
}

/** Inner wrapping key for the device private-key blob. */
export function deriveDeviceInnerKey(kLocal: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kLocal, 'capy:inner', 'capy:inner:device', 32));
}
