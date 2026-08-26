import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
} from 'crypto';
import { CapyError, ERROR_CODES } from '../types/index';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const TOKEN_LENGTH = 32;

/**
 * Generates a random 32-byte invite token T.
 */
export function generateInviteToken(): Buffer {
  return randomBytes(TOKEN_LENGTH);
}

/**
 * Derives a 32-byte inner wrapping key via HKDF-SHA256.
 * Parameterized so both invite and deploy flows can reuse it.
 */
export function deriveInnerKey(token: Buffer, salt: string, info: string): Buffer {
  const derived = hkdfSync('sha256', token, salt, info, 32);
  return Buffer.from(derived);
}

/**
 * Encrypts data with AES-256-GCM. Returns base64(iv + ciphertext + authTag).
 */
export function aesEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  // No setAAD: callers derive `key` via deriveInnerKey(token, salt, info), where
  // salt/info already bind the context (e.g. "orgId:email" + "capy:invite", or
  // deployId + "capy:deploy:decrypt"). The context lives in the key, so AAD here
  // would be redundant.
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypts AES-256-GCM data. Input is base64(iv + ciphertext + authTag).
 */
export function aesDecrypt(blob: string, key: Buffer): Buffer {
  const combined = Buffer.from(blob, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted blob too short');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Double-wraps the master key M.
 * Inner layer: AES-256-GCM with HKDF(T, salt=orgId:email, info="capy:invite")
 * Outer layer: provided by the service via KMS (caller handles this)
 *
 * The recipient email is bound into the HKDF salt so that only the
 * intended recipient can derive the correct inner key to unwrap M.
 *
 * Returns the inner-wrapped blob (base64). Caller must then request
 * the service to wrap the outer layer.
 */
export function innerWrap(masterKey: Buffer, token: Buffer, orgId: string, email: string): string {
  const salt = `${orgId}:${email.toLowerCase()}`;
  const innerKey = deriveInnerKey(token, salt, 'capy:invite');
  return aesEncrypt(masterKey, innerKey);
}

/**
 * Strips the inner layer using token T.
 * Input is the inner-wrapped blob (after service stripped outer layer).
 * Returns the master key M.
 */
export function innerUnwrap(innerBlob: string, token: Buffer, orgId: string, email: string): Buffer {
  const salt = `${orgId}:${email.toLowerCase()}`;
  const innerKey = deriveInnerKey(token, salt, 'capy:invite');
  return aesDecrypt(innerBlob, innerKey);
}

/**
 * Redeem code format v2 (current):
 *   version(1=0x02) + T(32) + notAfter(8 bytes BE uint64 ms) +
 *   orgIdLen(2 BE) + orgId(utf8) + outerWrappedBlob
 *
 * `notAfter` is the unix-ms timestamp after which the code must be rejected.
 * The same value is bound into the KMS EncryptionContext at wrap time, so a
 * client tampering with notAfter in the redeem code causes the server-side
 * unwrap to fail at the AEAD layer (defence in depth on top of the explicit
 * server-side timestamp check).
 *
 * No v1 (no-expiry) format is accepted any more — old codes simply fail to
 * parse, which is the desired security property: pre-expiry-feature codes
 * predate the wrapping with notAfter context, so they could not unwrap on
 * the new server anyway.
 */
const REDEEM_CODE_VERSION = 0x02;

const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Resolve the invite TTL in milliseconds from CAPY_INVITE_TTL_SECONDS, falling
 * back to the 7-day default. Used by the inviter to compute `notAfter` at
 * wrap time. Tests override the env to exercise expired-code paths quickly.
 * Server caps the value at 30 days regardless of what the client requests.
 */
export function resolveInviteTtlMs(): number {
  const raw = process.env.CAPY_INVITE_TTL_SECONDS;
  if (raw === undefined) return DEFAULT_INVITE_TTL_SECONDS * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INVITE_TTL_SECONDS * 1000;
  }
  return Math.floor(parsed * 1000);
}

export function buildRedeemCode(
  token: Buffer,
  outerWrappedBlob: string,
  orgId: string,
  notAfter: number,
): string {
  const outerBuf = Buffer.from(outerWrappedBlob, 'base64');
  const orgIdBuf = Buffer.from(orgId, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(orgIdBuf.length, 0);
  const versionBuf = Buffer.from([REDEEM_CODE_VERSION]);
  const notAfterBuf = Buffer.alloc(8);
  notAfterBuf.writeBigUInt64BE(BigInt(notAfter), 0);
  return Buffer.concat([versionBuf, token, notAfterBuf, lenBuf, orgIdBuf, outerBuf]).toString('base64');
}

export function parseRedeemCode(redeemCode: string): {
  token: Buffer;
  orgId: string;
  ciphertext: string;
  notAfter: number;
} {
  const buf = Buffer.from(redeemCode, 'base64');
  // version(1) + token(32) + notAfter(8) + orgIdLen(2) = 43 bytes minimum
  if (buf.length <= 1 + TOKEN_LENGTH + 8 + 2) {
    throw new Error('Invalid redeem code: too short');
  }
  const version = buf.readUInt8(0);
  if (version !== REDEEM_CODE_VERSION) {
    throw new Error(
      `Unsupported redeem code version (got 0x${version.toString(16).padStart(2, '0')}, expected 0x${REDEEM_CODE_VERSION
        .toString(16)
        .padStart(2, '0')}). Issue a fresh invite.`,
    );
  }
  const token = buf.subarray(1, 1 + TOKEN_LENGTH);
  const notAfter = Number(buf.readBigUInt64BE(1 + TOKEN_LENGTH));
  const orgIdLenOffset = 1 + TOKEN_LENGTH + 8;
  const orgIdLen = buf.readUInt16BE(orgIdLenOffset);
  const orgIdOffset = orgIdLenOffset + 2;
  if (buf.length < orgIdOffset + orgIdLen) {
    throw new Error('Invalid redeem code: truncated org ID');
  }
  const orgId = buf.subarray(orgIdOffset, orgIdOffset + orgIdLen).toString('utf8');
  const ciphertext = buf.subarray(orgIdOffset + orgIdLen).toString('base64');
  return { token, orgId, ciphertext, notAfter };
}

// ---------------------------------------------------------------------------
// v3 code format (additive — the v2 path above is untouched).
//
// T shrinks to 12 bytes (96 bits) and travels as the code itself: no version
// byte, no id, no blob. See docs/invite-pickup-flow.md §3.1-§3.3.
// ---------------------------------------------------------------------------

/** T length for the v3 (stored-blob) invite format. See §3.1. */
export const TOKEN_LENGTH_V3 = 12;

/** Generates a random 12-byte v3 invite token T. */
export function generateInviteTokenV3(): Buffer {
  return randomBytes(TOKEN_LENGTH_V3);
}

/** Crockford base32 — `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. I/L/O/U absent. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_VALUE_BY_CHAR: ReadonlyMap<string, number> = new Map(
  [...CROCKFORD_ALPHABET].map((c, i) => [c, i] as const),
);

/** v3 codes are exactly 20 Crockford characters (100 padded bits for 96-bit T). */
const V3_CODE_CHAR_LENGTH = 20;

/**
 * Upper-cases, strips dashes, and folds I/L → 1, O → 0 (§3.2). Does not fold
 * or reject U — Crockford's alphabet omits it without a fold rule, so a
 * post-fold string containing U simply fails the alphabet membership check
 * downstream and the code is treated as not-v3-shaped.
 */
function normalizeCrockfordInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

function isCrockfordAlphabet(s: string): boolean {
  return [...s].every((c) => CROCKFORD_VALUE_BY_CHAR.has(c));
}

/** Big-endian bit packing, zero-padded on the right to 100 bits (§3.2). */
function crockfordEncode(token: Buffer): string {
  const padded = BigInt(`0x${token.toString('hex')}`) << 4n; // 96 -> 100 bits
  return Array.from({ length: V3_CODE_CHAR_LENGTH }, (_, idx) => {
    const shift = BigInt((V3_CODE_CHAR_LENGTH - 1 - idx) * 5);
    const value = Number((padded >> shift) & 0x1fn);
    return CROCKFORD_ALPHABET[value];
  }).join('');
}

interface CrockfordDecodeResult {
  bytes: Buffer;
  paddingNonZero: boolean;
}

/**
 * Decodes exactly 20 already-normalized Crockford characters into the 12-byte
 * T plus whether the trailing 4 padding bits were non-zero (a conforming
 * decoder MUST reject that — §3.2). Returns null if the input isn't 20
 * characters of the Crockford alphabet at all (not v3-shaped).
 */
function crockfordDecodeRaw(chars: string): CrockfordDecodeResult | null {
  if (chars.length !== V3_CODE_CHAR_LENGTH || !isCrockfordAlphabet(chars)) return null;
  const values = [...chars].map((c) => CROCKFORD_VALUE_BY_CHAR.get(c) as number);
  const bits = values.reduce((acc, v) => (acc << 5n) | BigInt(v), 0n);
  const paddingNonZero = (bits & 0xfn) !== 0n;
  const hex = (bits >> 4n).toString(16).padStart(TOKEN_LENGTH_V3 * 2, '0');
  return { bytes: Buffer.from(hex, 'hex'), paddingNonZero };
}

/** Renders T as the presentation code `XXXXX-XXXXX-XXXXX-XXXXX` (§3.2). Dashes are cosmetic only. */
export function buildInviteCodeV3(token: Buffer): string {
  if (token.length !== TOKEN_LENGTH_V3) {
    throw new Error(`v3 invite token must be ${TOKEN_LENGTH_V3} bytes, got ${token.length}`);
  }
  const raw = crockfordEncode(token);
  return [raw.slice(0, 5), raw.slice(5, 10), raw.slice(10, 15), raw.slice(15, 20)].join('-');
}

/**
 * `invite_id = hex(SHA-256("capy:invite-id:v1" || T)[0..15])` — 32 lower-case
 * hex chars (§3.3). Derived by both the minter and the redeemer; the server
 * never receives T.
 */
export function deriveInviteId(token: Buffer): string {
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from('capy:invite-id:v1', 'utf8'), token]))
    .digest();
  return digest.subarray(0, 16).toString('hex');
}

export type ParsedInviteCode =
  | { version: 3; token: Buffer }
  | { version: 2; token: Buffer; orgId: string; ciphertext: string; notAfter: number };

/**
 * Reads the version byte of a base64 blob without validating the rest of its
 * shape — used only to decide which parser to hand the code to. Never throws;
 * an unparseable input reads as "no version byte available".
 */
function peekBase64VersionByte(code: string): number | null {
  const buf = Buffer.from(code, 'base64');
  if (buf.length < 1) return null;
  return buf.readUInt8(0);
}

/**
 * Version dispatch on decoded SHAPE, never on message text (§3.2, cardinal
 * Rule 5):
 *
 * 1. Dash-stripped, upper-cased, I/L/O-folded input of exactly 20 Crockford
 *    characters decoding to 12 bytes with all-zero padding bits → v3.
 * 2. Otherwise, a base64 blob whose first byte is the existing v2 version
 *    byte (0x02) → delegated to the untouched `parseRedeemCode` (byte-for-byte
 *    the same behaviour, including its own error shapes for a malformed v2
 *    code — those are NOT reclassified as UPGRADE_REQUIRED).
 * 3. Anything else → `UPGRADE_REQUIRED`: a format this build's decoder does
 *    not recognise, structurally, not textually.
 */
export function parseInviteCode(code: string): ParsedInviteCode {
  const normalized = normalizeCrockfordInput(code);
  if (normalized.length === V3_CODE_CHAR_LENGTH) {
    const decoded = crockfordDecodeRaw(normalized);
    if (decoded) {
      if (decoded.paddingNonZero) {
        throw new CapyError(
          'Invalid invite code.',
          ERROR_CODES.INVALID_FORMAT,
          { reason: 'v3_padding_nonzero' },
        );
      }
      return { version: 3, token: decoded.bytes };
    }
  }

  if (peekBase64VersionByte(code) === REDEEM_CODE_VERSION) {
    const parsed = parseRedeemCode(code);
    return { version: 2, ...parsed };
  }

  throw new CapyError(
    'This invite code was minted by a newer version of capy. Update capy and try again.',
    ERROR_CODES.UPGRADE_REQUIRED,
    {},
  );
}
