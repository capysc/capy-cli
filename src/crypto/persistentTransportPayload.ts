import { randomBytes } from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';

const TRANSPORT_ROOT_BYTES = 32;

export interface PersistentTransportPayload {
  readonly v: 1;
  readonly k_local: string;
  readonly key_enc: string;
  readonly transport_id: string;
  readonly org_id: string;
  readonly user_id: string;
}

/** A fresh root for the transported credential, independent of both source K_local and link key S. */
export function generateTransportLocalRoot(): Buffer {
  return randomBytes(TRANSPORT_ROOT_BYTES);
}

/** Serializes exactly the JSON package Keep validates, PRF-wraps, and later returns to pairing. */
export function serializePersistentTransportPayload(payload: PersistentTransportPayload): Buffer {
  const transportRoot = Buffer.from(payload.k_local, 'base64url');
  if (transportRoot.length !== TRANSPORT_ROOT_BYTES) {
    throw new CapyError('Transport local key must be 32 bytes', ERROR_CODES.ENCRYPTION_ERROR);
  }
  return Buffer.from(JSON.stringify(payload), 'utf8');
}
