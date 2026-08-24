/**
 * Device-key crypto (CAP-380, per the CAP-372 design):
 *
 *   PRF output --HKDF(versioned info string)--> KEK --AES-256-GCM--> wrapped K_local
 *
 * Runs exclusively CLI-side (see ceremonyTransport.ts for why the page never
 * derives the KEK). The uploaded record is {wrapped_k_local, iv, prf_salt,
 * credential_id, kdf_version}: iv rides separately per the wrapper contract,
 * so the ciphertext field is ct||tag (unlike keyManager's iv||ct||tag disk
 * format). The AAD binds a wrap to its user AND credential — a blob swapped
 * between rows fails the GCM tag instead of silently unwrapping.
 *
 * kdf_version stamps the whole recipe (HKDF info string + wrap layout). A
 * row stamped with a version this binary doesn't know fails CLOSED with
 * DEVICE_KEY_KDF_UNSUPPORTED — guessing would garbage-decrypt K_local.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { CapyError, ERROR_CODES } from '../../types/index';

export const DEVICE_KEY_KDF_VERSION = 1;

/**
 * HKDF info strings, one per kdf_version. Append-only — never rewrite an
 * entry. A Map (not a plain object) so a server-supplied kdf_version cannot
 * reach Object.prototype via a key like "constructor"/"toString" — the
 * lookup below is `undefined` for anything that isn't a key literally
 * inserted here, never a prototype member (gate-2 MINOR-2, hardening).
 */
const KEK_INFO_BY_VERSION: ReadonlyMap<number, string> = new Map([
  [1, 'capy:device-key:kek:v1'],
]);

export const PRF_SALT_LENGTH = 32;
export const PRF_OUTPUT_LENGTH = 32;
const KEK_LENGTH = 32;
const K_LOCAL_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Mint the per-enrollment PRF salt (stored server-side as prf_salt, base64). */
export function generatePrfSalt(): Buffer {
  return randomBytes(PRF_SALT_LENGTH);
}

/**
 * Is this base64 string a usable PRF evaluation?
 *
 * A ceremony answer only counts as a success if it carries one. `typeof ===
 * 'string'` admits `''`, which a page that mistook a zero-length PRF buffer
 * for a real one will happily send — and an empty output then travels all the
 * way to `deriveDeviceKeyKek` below, which throws an opaque "malformed PRF
 * result" from three layers away, where the Case-C wrapper discards it and
 * every distinct failure collapses into a generic `key_not_on_device`.
 *
 * Lives here, beside the length it enforces, because BOTH transports must
 * apply it: the relayed browser answer (`brokerCeremonyTransport`) and the
 * pre-obtained one bundled into a sealed sandbox_session
 * (`cannedCeremony`) — the `--broker-ceremony` rail, which is the only path
 * some callers ever take.
 */
export function isWellFormedPrfOutput(prfOutput: string): boolean {
  if (prfOutput.length === 0) return false;
  return Buffer.from(prfOutput, 'base64').length === PRF_OUTPUT_LENGTH;
}

/**
 * KEK = HKDF-SHA256(ikm = PRF output, salt = prf_salt, info = versioned).
 * Reusing the enrollment salt as the HKDF salt binds the KEK to that
 * enrollment; the info string versions the whole derivation.
 */
export function deriveDeviceKeyKek(
  prfOutput: Buffer,
  prfSalt: Buffer,
  kdfVersion: number = DEVICE_KEY_KDF_VERSION,
): Buffer {
  const info = KEK_INFO_BY_VERSION.get(kdfVersion);
  if (!info) {
    throw new CapyError(
      `This device key was enrolled by a newer capy (kdf_version ${kdfVersion}). Update capy and try again.`,
      ERROR_CODES.DEVICE_KEY_KDF_UNSUPPORTED,
      { kdfVersion },
    );
  }
  if (prfOutput.length !== PRF_OUTPUT_LENGTH) {
    throw new CapyError(
      'The device-key ceremony returned a malformed PRF result.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'bad_prf_length' },
    );
  }
  return Buffer.from(hkdfSync('sha256', prfOutput, prfSalt, info, KEK_LENGTH));
}

/** AAD binding a wrapped K_local to its user and credential. */
export function deviceKeyWrapAAD(userId: string, credentialId: string): Buffer {
  return Buffer.from(`capy:device-key:wrap:v1:${userId}:${credentialId}`, 'utf8');
}

export interface WrappedKLocal {
  /** base64(ciphertext || authTag) */
  wrappedKLocal: string;
  /** base64, 12 bytes */
  iv: string;
}

/** Wrap K_local under the KEK for upload. */
export function wrapKLocal(kLocal: Buffer, kek: Buffer, aad: Buffer): WrappedKLocal {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(kLocal), cipher.final(), cipher.getAuthTag()]);
  return { wrappedKLocal: ciphertext.toString('base64'), iv: iv.toString('base64') };
}

/**
 * Unwrap a downloaded wrapped_k_local blob. Fails CLOSED with a typed error
 * on any GCM auth failure (wrong PRF output, wrong credential's blob,
 * tampered AAD context) or a malformed root — callers must treat that as
 * "this ceremony did not unlock this door", never fall through to minting.
 */
export function unwrapKLocal(
  wrappedKLocal: string,
  iv: string,
  kek: Buffer,
  aad: Buffer,
): Buffer {
  const ivBuf = Buffer.from(iv, 'base64');
  const combined = Buffer.from(wrappedKLocal, 'base64');
  if (ivBuf.length !== IV_LENGTH || combined.length < AUTH_TAG_LENGTH) {
    throw new CapyError(
      'This device-key record is malformed.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'malformed_record' },
    );
  }
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  let kLocal: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    kLocal = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CapyError(
      'The device key could not unlock this machine key.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'gcm_auth_failed' },
    );
  }
  if (kLocal.length !== K_LOCAL_LENGTH) {
    throw new CapyError(
      'This device-key record is malformed.',
      ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
      { reason: 'bad_root_length' },
    );
  }
  return kLocal;
}
