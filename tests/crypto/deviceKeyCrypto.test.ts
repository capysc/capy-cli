import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import {
  DEVICE_KEY_KDF_VERSION,
  PRF_OUTPUT_LENGTH,
  PRF_SALT_LENGTH,
  generatePrfSalt,
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  wrapKLocal,
  unwrapKLocal,
} from '../../src/auth/deviceKey/crypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';

describe('device-key crypto (PRF → HKDF KEK → AES-256-GCM wrap of K_local)', () => {
  const prfOutput = randomBytes(PRF_OUTPUT_LENGTH);
  const prfSalt = generatePrfSalt();
  const kLocal = randomBytes(32);
  const aad = deviceKeyWrapAAD('user_1', 'cred_A');

  it('mints 32-byte PRF salts', () => {
    expect(prfSalt.length).toBe(PRF_SALT_LENGTH);
  });

  it('round-trips K_local through wrap/unwrap', () => {
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt);
    const wrapped = wrapKLocal(kLocal, kek, aad);
    expect(Buffer.from(wrapped.iv, 'base64').length).toBe(12);
    const unwrapped = unwrapKLocal(wrapped.wrappedKLocal, wrapped.iv, kek, aad);
    expect(unwrapped.equals(kLocal)).toBe(true);
  });

  it('KEK derivation is deterministic and versioned', () => {
    const a = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
    const b = deriveDeviceKeyKek(prfOutput, prfSalt);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('a different PRF output cannot unwrap (typed DEVICE_KEY_UNWRAP_FAILED)', () => {
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt);
    const wrapped = wrapKLocal(kLocal, kek, aad);
    const wrongKek = deriveDeviceKeyKek(randomBytes(PRF_OUTPUT_LENGTH), prfSalt);
    try {
      unwrapKLocal(wrapped.wrappedKLocal, wrapped.iv, wrongKek, aad);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED);
    }
  });

  it('a different salt derives a different KEK (per-enrollment binding)', () => {
    const kekA = deriveDeviceKeyKek(prfOutput, prfSalt);
    const kekB = deriveDeviceKeyKek(prfOutput, generatePrfSalt());
    expect(kekA.equals(kekB)).toBe(false);
  });

  it('AAD binds the wrap to user AND credential — a swapped context fails the tag', () => {
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt);
    const wrapped = wrapKLocal(kLocal, kek, aad);
    for (const foreign of [deviceKeyWrapAAD('user_2', 'cred_A'), deviceKeyWrapAAD('user_1', 'cred_B')]) {
      try {
        unwrapKLocal(wrapped.wrappedKLocal, wrapped.iv, kek, foreign);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED);
      }
    }
  });

  it('an unknown kdf_version fails CLOSED with DEVICE_KEY_KDF_UNSUPPORTED', () => {
    try {
      deriveDeviceKeyKek(prfOutput, prfSalt, 999);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_KDF_UNSUPPORTED);
    }
  });

  it('a malformed PRF output is refused before any derivation', () => {
    try {
      deriveDeviceKeyKek(randomBytes(16), prfSalt);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED);
    }
  });

  it('malformed records are refused with a typed error, not a crypto stack trace', () => {
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt);
    try {
      unwrapKLocal('AAAA', 'AAAA', kek, aad); // short iv + short blob
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED);
    }
  });
});
