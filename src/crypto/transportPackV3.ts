/**
 * Transport link v3 (CAP-692) — packs a `PairingEntry` into a fixed-layout
 * binary plaintext instead of JSON-inside-JSON, so the sealed `capy
 * transport` link fits a terminal-sized QR (~480 chars / 79x40 instead of
 * ~1,300 chars / 123x62).
 *
 * Fragment: `#3.<id>.<blob>`
 *   - `3` — literal version marker (v2 links keep their 3-dot-free-form
 *     `<id>.<iv>.<ct>` shape and keep working in Keep).
 *   - `<id>` — the transport id (a UUID minted by the service), 16 raw
 *     bytes, base64url, no padding (22 chars).
 *   - `<blob>` — base64url(iv[12] || ciphertext || tag[16]), AES-256-GCM
 *     under S (the one-time key from `createTransport`, unchanged), AAD =
 *     utf8 `capy:transport:v3:<canonical lowercase uuid>`.
 *
 * Plaintext (binary, big-endian, fixed order):
 *   1B format(0x01) | 1B wrapping_method(0x01=local_root) | 16B org_id
 *   (UUID bytes) | 16B user_id (`user_` + 26-char Crockford ULID, 128-bit
 *   value) | 32B k_local | 8B created_at (uint64 ms epoch) | rest:
 *   base64-decoded `encrypted_master_key`.
 *
 * `packTransportV3` packs ONLY when doing so is lossless — the gate is
 * `rebuild(pack) === raw key.enc file, byte for byte`, where `rebuild` is
 * the exact `JSON.stringify({version:'2.0', org_id, encrypted_master_key,
 * wrapping_method:'local_root', created_at}, null, 2)` shape
 * `saveMasterKey` (globalConfig.ts) writes. Any mismatch — wrong version,
 * wrapping method, a user id that isn't `user_`+ULID, non-ms-precision
 * `created_at`, non-canonical base64, or extra/reordered JSON fields —
 * returns `null` so the caller falls back to the unchanged v2 link. Nothing
 * here throws on a malformed/foreign `key.enc`; a failure to pack is always
 * a typed "no", never an exception, and nothing secret is logged.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';
import type { PairingEntry } from './pairingPayload';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const S_LENGTH = 32;
const K_LOCAL_LENGTH = 32;
const AAD_PREFIX = 'capy:transport:v3:';
const FORMAT_BYTE = 0x01;
const WRAPPING_LOCAL_ROOT_BYTE = 0x01;
const ULID_LENGTH = 26;
const USER_ID_PREFIX = 'user_';
const FIXED_HEADER_LENGTH = 1 + 1 + 16 + 16 + K_LOCAL_LENGTH + 8; // 74
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Buffer | null {
  if (!UUID_RE.test(uuid)) return null;
  const bytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  return bytes.length === 16 ? bytes : null;
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Canonicalizes a UUID to lowercase, throwing a coded error on anything that isn't one — used for the AAD/id segment, which (unlike org_id packing) must always succeed since it comes from the service's own response, not a possibly-foreign file. */
function canonicalizeUuid(id: string): string {
  const bytes = uuidToBytes(id);
  if (!bytes) {
    throw new CapyError('Transport id is not a UUID', ERROR_CODES.INVALID_FORMAT);
  }
  return id.toLowerCase();
}

/**
 * Decodes a 26-char Crockford-base32 ULID into its 16-byte (128-bit) value,
 * or `null` if it isn't a valid ULID — wrong length, a non-alphabet
 * character, or a value whose top 2 of the 130 decoded bits are set (i.e.
 * it overflows 128 bits, so it is not representable as one).
 */
function ulidToBytes(ulid: string): Buffer | null {
  if (ulid.length !== ULID_LENGTH) return null;
  const upper = ulid.toUpperCase();
  const bits = [...upper].reduce<bigint | null>((acc, ch) => {
    if (acc === null) return null;
    const v = CROCKFORD.indexOf(ch);
    return v < 0 ? null : (acc << 5n) | BigInt(v);
  }, 0n);
  if (bits === null || bits >> 128n !== 0n) return null;
  return Buffer.from(bits.toString(16).padStart(32, '0'), 'hex');
}

/** Encodes a 16-byte value back into its 26-char Crockford-base32 ULID. Total inverse of {@link ulidToBytes} for any value that came from it (the top 2 of 130 bits are always zero here, since the source is only 128 bits). */
function bytesToUlid(bytes: Buffer): string {
  const value = BigInt(`0x${bytes.toString('hex')}`);
  return Array.from({ length: ULID_LENGTH }, (_, i) => {
    const shift = BigInt(5 * (ULID_LENGTH - 1 - i));
    return CROCKFORD[Number((value >> shift) & 0x1fn)];
  }).join('');
}

function isCanonicalBase64(s: string): boolean {
  try {
    return Buffer.from(s, 'base64').toString('base64') === s;
  } catch {
    return false;
  }
}

interface ParsedKeyEnc {
  readonly version: unknown;
  readonly org_id: unknown;
  readonly encrypted_master_key: unknown;
  readonly wrapping_method: unknown;
  readonly created_at: unknown;
}

function parseKeyEncOrNull(raw: string): ParsedKeyEnc | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedKeyEnc) : null;
  } catch {
    return null;
  }
}

function rebuildKeyEnc(fields: { org_id: string; encrypted_master_key: string; created_at: string }): string {
  return JSON.stringify(
    {
      version: '2.0',
      org_id: fields.org_id,
      encrypted_master_key: fields.encrypted_master_key,
      wrapping_method: 'local_root',
      created_at: fields.created_at,
    },
    null,
    2,
  );
}

/** Mints a fresh random 32-byte S — the one-time key the service stores (never the fragment). `capy transport`'s only caller of this; nothing else needs S. */
export function generateTransportKey(): Buffer {
  return randomBytes(S_LENGTH);
}

/**
 * Packs `entry` into the fixed-layout v3 plaintext, or returns `null` when
 * packing would not be lossless (see file header for the full gate). Pure —
 * no I/O, no secrets logged either way.
 */
export function packTransportV3(entry: PairingEntry): Buffer | null {
  const parsed = parseKeyEncOrNull(entry.key_enc);
  if (!parsed) return null;
  if (parsed.version !== '2.0') return null;
  if (parsed.wrapping_method !== 'local_root') return null;
  if (typeof parsed.org_id !== 'string') return null;
  if (typeof parsed.encrypted_master_key !== 'string') return null;
  if (typeof parsed.created_at !== 'string') return null;

  const orgIdBytes = uuidToBytes(parsed.org_id);
  if (!orgIdBytes || bytesToUuid(orgIdBytes) !== parsed.org_id) return null;

  if (!entry.user_id.startsWith(USER_ID_PREFIX)) return null;
  const ulid = entry.user_id.slice(USER_ID_PREFIX.length);
  const userIdBytes = ulidToBytes(ulid);
  if (!userIdBytes || bytesToUlid(userIdBytes) !== ulid) return null;

  const kLocalBytes = Buffer.from(entry.k_local, 'base64url');
  if (kLocalBytes.length !== K_LOCAL_LENGTH) return null;

  const createdMs = Date.parse(parsed.created_at);
  if (!Number.isFinite(createdMs) || createdMs < 0) return null;
  if (new Date(createdMs).toISOString() !== parsed.created_at) return null;

  if (!isCanonicalBase64(parsed.encrypted_master_key)) return null;
  const masterKeyBytes = Buffer.from(parsed.encrypted_master_key, 'base64');

  const rebuilt = rebuildKeyEnc({
    org_id: parsed.org_id,
    encrypted_master_key: parsed.encrypted_master_key,
    created_at: parsed.created_at,
  });
  if (rebuilt !== entry.key_enc) return null;

  const createdAtBytes = Buffer.alloc(8);
  createdAtBytes.writeBigUInt64BE(BigInt(createdMs));

  return Buffer.concat([
    Buffer.from([FORMAT_BYTE]),
    Buffer.from([WRAPPING_LOCAL_ROOT_BYTE]),
    orgIdBytes,
    userIdBytes,
    kLocalBytes,
    createdAtBytes,
    masterKeyBytes,
  ]);
}

/**
 * Inverse of {@link packTransportV3} — rebuilds the full `PairingEntry`
 * (including the exact `key.enc` JSON text) from the fixed-layout
 * plaintext. Throws a coded `INVALID_FORMAT` on a buffer that is too short
 * or carries a format/wrapping byte this version doesn't understand —
 * never on the decrypted bytes' CONTENT otherwise, since GCM already
 * guarantees those came from a real `packTransportV3` call.
 */
export function unpackTransportV3(buf: Buffer): PairingEntry {
  if (buf.length < FIXED_HEADER_LENGTH) {
    throw new CapyError('Transport v3 plaintext too short', ERROR_CODES.INVALID_FORMAT);
  }
  if (buf[0] !== FORMAT_BYTE) {
    throw new CapyError('Unsupported transport v3 format byte', ERROR_CODES.INVALID_FORMAT);
  }
  if (buf[1] !== WRAPPING_LOCAL_ROOT_BYTE) {
    throw new CapyError('Unsupported transport v3 wrapping method byte', ERROR_CODES.INVALID_FORMAT);
  }

  const orgIdBytes = buf.subarray(2, 18);
  const userIdBytes = buf.subarray(18, 34);
  const kLocalBytes = buf.subarray(34, 34 + K_LOCAL_LENGTH);
  const createdAtBytes = buf.subarray(34 + K_LOCAL_LENGTH, FIXED_HEADER_LENGTH);
  const masterKeyBytes = buf.subarray(FIXED_HEADER_LENGTH);

  const org_id = bytesToUuid(orgIdBytes);
  const user_id = `${USER_ID_PREFIX}${bytesToUlid(userIdBytes)}`;
  const k_local = kLocalBytes.toString('base64url');
  const created_at = new Date(Number(createdAtBytes.readBigUInt64BE())).toISOString();
  const encrypted_master_key = masterKeyBytes.toString('base64');

  const key_enc = rebuildKeyEnc({ org_id, encrypted_master_key, created_at });

  return { org_id, user_id, k_local, key_enc };
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== S_LENGTH) {
    throw new CapyError('Transport key must be 32 bytes', ERROR_CODES.ENCRYPTION_ERROR);
  }
}

/**
 * Seals `plaintext` (from {@link packTransportV3}) under `key` (S), bound
 * to `id` (the service's transport id) via AAD, and returns the full v3
 * fragment: `3.<id as 16 bytes, base64url>.<base64url(iv||ct||tag)>`. `iv`
 * is only ever passed by tests (the shared vector) — production always
 * mints a fresh random one.
 */
export function sealTransportV3(plaintext: Buffer, key: Buffer, id: string, iv: Buffer = randomBytes(IV_LENGTH)): string {
  assertKeyLength(key);
  const canonicalId = canonicalizeUuid(id);
  const idBytes = uuidToBytes(canonicalId);
  if (!idBytes) {
    throw new CapyError('Transport id is not a UUID', ERROR_CODES.INVALID_FORMAT);
  }

  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${canonicalId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ciphertext, tag]).toString('base64url');

  return `3.${idBytes.toString('base64url')}.${blob}`;
}

/**
 * Opens a v3 fragment (the part after `#`) with `key` (S): parses the id
 * and blob, derives the AAD from the id carried IN the fragment itself
 * (there is nothing else to bind it to — same trust model as v2, where the
 * server-returned `id` is what AAD uses), and decrypts. Throws a coded
 * `INVALID_FORMAT` on a malformed fragment (wrong version marker, wrong
 * segment count, an id that isn't 16 bytes, a blob shorter than iv+tag) and
 * `DECRYPT_KEY_MISMATCH` on a wrong key or tampered ciphertext/id/iv — GCM
 * does not distinguish any of those.
 */
export function openTransportV3(fragment: string, key: Buffer): { id: string; plaintext: Buffer } {
  assertKeyLength(key);
  const parts = fragment.split('.');
  if (parts.length !== 3 || parts[0] !== '3' || parts.some((p) => p.length === 0)) {
    throw new CapyError('Malformed transport v3 link fragment', ERROR_CODES.INVALID_FORMAT);
  }
  const idBytes = Buffer.from(parts[1], 'base64url');
  if (idBytes.length !== 16) {
    throw new CapyError('Malformed transport v3 link fragment id', ERROR_CODES.INVALID_FORMAT);
  }
  const id = bytesToUuid(idBytes);

  const blob = Buffer.from(parts[2], 'base64url');
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new CapyError('Malformed transport v3 link fragment blob', ERROR_CODES.INVALID_FORMAT);
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - AUTH_TAG_LENGTH);
  const tag = blob.subarray(blob.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}${id}`, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { id, plaintext };
  } catch {
    throw new CapyError(
      'Could not open transport fragment v3 — wrong key, wrong transport id, or tampered ciphertext',
      ERROR_CODES.DECRYPT_KEY_MISMATCH,
    );
  }
}

/** True when `fragment` is a v3 link (`3.<id>.<blob>`, 3 dot-separated parts with a literal `3` first segment) rather than a v2 one (`<id>.<iv>.<ct>`, whose first segment is the service's own id string, never literally `"3"`). */
export function isTransportFragmentV3(fragment: string): boolean {
  const parts = fragment.split('.');
  return parts.length === 3 && parts[0] === '3';
}
