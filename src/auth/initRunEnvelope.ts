import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
} from 'crypto';
import {
  INIT_RUN_AUTH_ENVELOPE_DOMAIN,
  type InitRunBinding,
} from './initRunContract';

export const INIT_RUN_AUTH_ENVELOPE_VERSION = 1 as const;
export const INIT_RUN_AUTH_HKDF_PREFIX = INIT_RUN_AUTH_ENVELOPE_DOMAIN;

const P256_POINT_BYTES = 65;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface InitRunDeliveryKeypair {
  readonly publicKeyB64: string;
  readonly privateKey: KeyObject;
}

export type InitRunCryptoBinding = InitRunBinding;

interface AuthEnvelope {
  readonly v: number;
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
}

function exactBase64Bytes(value: string): Buffer | null {
  if (!BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);
}

export function mintInitRunDeliveryKeypair(): InitRunDeliveryKeypair {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKeyB64: rawPublicKey(pair.publicKey).toString('base64'), privateKey: pair.privateKey };
}

export function importInitRunDeliveryKeypair(input: Readonly<{
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
}>): InitRunDeliveryKeypair | null {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(input.privateKeyPkcs8B64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKeyB64 = rawPublicKey(createPublicKey(privateKey)).toString('base64');
    return publicKeyB64 === input.publicKeyB64 ? { publicKeyB64, privateKey } : null;
  } catch {
    return null;
  }
}

export function initRunCliKeyFingerprint(publicKeyB64: string): string | null {
  const raw = exactBase64Bytes(publicKeyB64);
  if (!raw || raw.length !== P256_POINT_BYTES || raw[0] !== 0x04) return null;
  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  } catch {
    return null;
  }
}

export function initRunAuthHkdfInfo(binding: InitRunCryptoBinding, epkB64: string): string {
  return `${INIT_RUN_AUTH_HKDF_PREFIX}|${JSON.stringify([
    binding.run_id,
    binding.subject_user_id,
    binding.service_origin,
    binding.runtime_id,
    binding.repository_fingerprint,
    binding.cli_key_fingerprint,
    epkB64,
  ])}`;
}

function parseEnvelope(value: string): AuthEnvelope | null {
  const raw = exactBase64Bytes(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    return typeof parsed === 'object'
      && parsed !== null
      && typeof parsed.v === 'number'
      && typeof parsed.epk === 'string'
      && typeof parsed.iv === 'string'
      && typeof parsed.ct === 'string'
      ? { v: parsed.v, epk: parsed.epk, iv: parsed.iv, ct: parsed.ct }
      : null;
  } catch {
    return null;
  }
}

export type OpenInitRunAuthResult =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly code: 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'BINDING_MISMATCH' | 'DECRYPT_FAILED' };

export function openInitRunAuthResult(input: Readonly<{
  sealedAuthResult: string;
  binding: InitRunCryptoBinding;
  keypair: InitRunDeliveryKeypair;
}>): OpenInitRunAuthResult {
  const envelope = parseEnvelope(input.sealedAuthResult);
  if (!envelope) return { ok: false, code: 'MALFORMED' };
  if (envelope.v !== INIT_RUN_AUTH_ENVELOPE_VERSION) return { ok: false, code: 'UNSUPPORTED_VERSION' };
  const ownFingerprint = initRunCliKeyFingerprint(input.keypair.publicKeyB64);
  if (!ownFingerprint || ownFingerprint !== input.binding.cli_key_fingerprint) {
    return { ok: false, code: 'BINDING_MISMATCH' };
  }
  const ephemeralRaw = exactBase64Bytes(envelope.epk);
  const iv = exactBase64Bytes(envelope.iv);
  const ct = exactBase64Bytes(envelope.ct);
  if (
    !ephemeralRaw
    || ephemeralRaw.length !== P256_POINT_BYTES
    || ephemeralRaw[0] !== 0x04
    || !iv
    || iv.length !== GCM_IV_BYTES
    || !ct
    || ct.length <= GCM_TAG_BYTES
  ) {
    return { ok: false, code: 'MALFORMED' };
  }

  try {
    const ephemeralPublicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: ephemeralRaw.subarray(1, 33).toString('base64url'),
        y: ephemeralRaw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const shared = diffieHellman({ privateKey: input.keypair.privateKey, publicKey: ephemeralPublicKey });
    const key = Buffer.from(hkdfSync(
      'sha256',
      shared,
      Buffer.alloc(0),
      Buffer.from(initRunAuthHkdfInfo(input.binding, envelope.epk), 'utf8'),
      32,
    ));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)),
      decipher.final(),
    ]);
    return { ok: true, plaintext: plaintext.toString('utf8') };
  } catch {
    return { ok: false, code: 'DECRYPT_FAILED' };
  }
}
