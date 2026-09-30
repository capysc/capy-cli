/**
 * `capy transport` "v2" (CAP-684, docs/basic-pair.md — updated 2026-09-30).
 *
 * v1 (T only ever in the URL fragment, the service held only ciphertext) is
 * gone — nothing shipped, so there is no compatibility to keep. v2 flips
 * which side holds what:
 *
 *   - The CLI mints a random 32-byte S and sends it to the service AS the
 *     `ciphertext` field of `POST /transports` (base64url) — the service is
 *     unchanged, it still just stores whatever string it's given and hands
 *     it back unmodified from `activate`. S is a one-time decryption key,
 *     not "the key material" (K_local / key.enc) itself.
 *   - The payload is encrypted under S, AES-256-GCM, with AAD
 *     `capy:transport:v2:<id>` — bound to the specific transport row, so a
 *     ciphertext minted for one `id` can never be opened against another.
 *   - The link carries `<id>.<iv>.<ct>` in the fragment — S is NOT there.
 *     A leaked link alone is useless without also being able to activate
 *     the row as the right authenticated user; a leaked S alone (the
 *     service's own row) is useless without the fragment.
 *
 * `sealTransportPayload` is the only function of this pair the CLI's own
 * production code calls (it is the sender, and `id` isn't known until after
 * `POST /transports` returns — so sealing happens AFTER that call, not
 * before, unlike v1). `openTransportFragment` is the Keep `/transport`
 * page's job in production (WebCrypto, not this module) — it exists here so
 * the round trip is testable and a corrupted/wrong-key fragment has one
 * place that says so.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { TransportPayload } from './pairingPayload';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const S_LENGTH = 32;
const AAD_PREFIX = 'capy:transport:v2:';

/** Mints a fresh random 32-byte S — the one-time key the service stores (never the fragment). */
export function generateTransportKey(): Buffer {
  return randomBytes(S_LENGTH);
}

/** `capy:transport:v2:<id>` — binds a sealed fragment to the specific transport row it was minted for. */
export function transportAad(id: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${id}`, 'utf8');
}

/** What the URL fragment carries alongside `id`: `#<id>.<iv>.<ct>`. */
export interface TransportFragment {
  /** 12-byte random IV, base64url. */
  iv: string;
  /** ciphertext with the 16-byte GCM tag appended, base64url. */
  ct: string;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== S_LENGTH) {
    throw new CapyError('Transport key must be 32 bytes', ERROR_CODES.ENCRYPTION_ERROR);
  }
}

/** Seals `payload` under `key` (S), bound to `id` via AAD. `id` is the service's own id for this transport row — known only after `POST /transports` returns, so this always runs after that call. */
export function sealTransportPayload(payload: TransportPayload, key: Buffer, id: string): TransportFragment {
  assertKeyLength(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(transportAad(id));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64url'),
    ct: Buffer.concat([encrypted, authTag]).toString('base64url'),
  };
}

/**
 * Opens a transport fragment with `key` (S), bound to `id` via AAD. Throws
 * `DECRYPT_KEY_MISMATCH` on a wrong key, a wrong/tampered `id`, or a
 * tampered fragment — GCM does not distinguish any of those. Not used by
 * CLI production code (Keep opens transport fragments); kept here so the
 * round trip is testable and the shape has one authoritative reader.
 */
export function openTransportFragment(fragment: TransportFragment, key: Buffer, id: string): TransportPayload {
  assertKeyLength(key);
  const iv = Buffer.from(fragment.iv, 'base64url');
  const combined = Buffer.from(fragment.ct, 'base64url');
  if (combined.length < AUTH_TAG_LENGTH) {
    throw new CapyError('Transport fragment ciphertext too short', ERROR_CODES.INVALID_FORMAT);
  }
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(transportAad(id));
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as TransportPayload;
  } catch {
    throw new CapyError(
      'Could not open transport fragment — wrong key, wrong transport id, or tampered ciphertext',
      ERROR_CODES.DECRYPT_KEY_MISMATCH,
    );
  }
}

/**
 * Parses a `capy transport` URL's fragment (`<id>.<iv>.<ct>`, the part
 * after `#`) into its three parts. The CLI itself never needs to parse a
 * fragment it just built — this exists for tests to prove the link they
 * asserted on round-trips into what `openTransportFragment` expects, the
 * same way Keep's `/transport` page will parse it.
 */
export function parseTransportFragment(fragment: string): { id: string; iv: string; ct: string } {
  const parts = fragment.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new CapyError('Malformed transport link fragment', ERROR_CODES.INVALID_FORMAT);
  }
  const [id, iv, ct] = parts;
  return { id, iv, ct };
}
