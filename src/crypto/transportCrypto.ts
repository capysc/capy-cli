/**
 * `capy transport` envelope (CAP-684, docs/basic-pair.md).
 *
 * The CLI mints a random 32-byte T and AES-256-GCM-encrypts the transport
 * payload under it directly — T *is* the key, there is no HKDF step (unlike
 * the pair envelope, which derives its key from an ECDH shared secret). The
 * envelope travels to the service as ciphertext; T never does — it only ever
 * appears in the URL fragment (`#<id>.<T>`), which browsers never send to a
 * server.
 *
 * `sealTransportPayload` is the only function of this pair the CLI's own
 * production code calls (it is the sender). `openTransportEnvelope` is the
 * Keep `/transport` page's job in production (WebCrypto, not this module) —
 * it exists here so the round trip can be tested from this side too, and so
 * a corrupted or wrong-key envelope has one place that says so.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { TransportPayload } from './pairingPayload';

export interface TransportEnvelope {
  v: 1;
  /** 12-byte random IV, base64url. */
  iv: string;
  /** ciphertext with the 16-byte GCM tag appended, base64url. */
  ct: string;
}

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const T_LENGTH = 32;

export const TRANSPORT_AAD = Buffer.from('capy:transport:v1', 'utf8');

/** Mints a fresh random 32-byte T. */
export function generateTransportToken(): Buffer {
  return randomBytes(T_LENGTH);
}

/** Seals `payload` under `token` (T). Returns the envelope; `token` is the caller's to place in the URL fragment. */
export function sealTransportPayload(payload: TransportPayload, token: Buffer): TransportEnvelope {
  if (token.length !== T_LENGTH) {
    throw new CapyError('Transport token must be 32 bytes', ERROR_CODES.ENCRYPTION_ERROR);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, token, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(TRANSPORT_AAD);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64url'),
    ct: Buffer.concat([encrypted, authTag]).toString('base64url'),
  };
}

/**
 * Opens a transport envelope with `token` (T). Throws `DECRYPT_KEY_MISMATCH`
 * on a wrong token or a tampered envelope — GCM does not distinguish the two.
 * Not used by CLI production code (Keep opens transport envelopes); kept here
 * so the round trip is testable and the shape has one authoritative reader.
 */
export function openTransportEnvelope(envelope: TransportEnvelope, token: Buffer): TransportPayload {
  if (envelope.v !== 1) {
    throw new CapyError('Unsupported transport envelope version', ERROR_CODES.INVALID_FORMAT, { v: envelope.v });
  }
  if (token.length !== T_LENGTH) {
    throw new CapyError('Transport token must be 32 bytes', ERROR_CODES.ENCRYPTION_ERROR);
  }
  const iv = Buffer.from(envelope.iv, 'base64url');
  const combined = Buffer.from(envelope.ct, 'base64url');
  if (combined.length < AUTH_TAG_LENGTH) {
    throw new CapyError('Transport envelope ciphertext too short', ERROR_CODES.INVALID_FORMAT);
  }
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, token, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(TRANSPORT_AAD);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as TransportPayload;
  } catch {
    throw new CapyError(
      'Could not open transport envelope — wrong token or tampered ciphertext',
      ERROR_CODES.DECRYPT_KEY_MISMATCH,
    );
  }
}
