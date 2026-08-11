/**
 * E2E answer envelope for the connection broker — CLI side (v1).
 *
 * The broker (service `/connections`) relays opaque base64 and can never
 * read an answer. The envelope below is the client-side contract that makes
 * that true: the CLI mints an ephemeral P-256 keypair per connection and
 * registers the public key as `client_pubkey`; the answering page seals its
 * payload to that key; only this process, holding the private half in
 * memory, can open it. Nothing here is ever written to disk.
 *
 * ## Wire format (v1) — keep-app implements the sealing half of exactly this
 *
 *  - `client_pubkey` (registered at create): base64 of the uncompressed
 *    SEC1 P-256 point, 65 bytes (`0x04 || X || Y`).
 *  - broker `ciphertext` field: base64(UTF-8 JSON) of
 *    `{ v: 1, epk, iv, ct }` where
 *      - `epk`: base64 uncompressed P-256 point (65 bytes) — the page's own
 *        ephemeral public key, minted per answer;
 *      - `iv`: base64 12-byte AES-GCM nonce;
 *      - `ct`: base64 AES-256-GCM ciphertext with the 16-byte tag appended.
 *  - key derivation: ECDH(P-256) shared secret (the 32-byte X coordinate),
 *    then HKDF-SHA256(salt = empty, info = `capy-broker-envelope-v1` + "|" +
 *    connection_id + "|" + client_pubkey_b64 + "|" + epk_b64, length = 32).
 *    Binding the info string to the connection and both public keys means a
 *    sealed answer cannot be replayed onto a different connection or key.
 *
 * WHY P-256 and not X25519: the sealing side runs in a browser on
 * `crypto.subtle`, and WebCrypto's P-256 ECDH is the one suite implemented
 * everywhere the page and the tests run (Bun's subtle has no X25519). The
 * version field exists so a later suite can be added without breaking v1.
 *
 * ## Completion payload
 *
 * The no-submit screens (auth-success / auth-error) answer with a typed
 * acknowledgement rather than key material — the SAME envelope machinery a
 * payload-bearing screen (device-key ceremony, CAP-381) will reuse.
 */
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
} from 'crypto';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_HKDF_INFO_PREFIX = 'capy-broker-envelope-v1';

/** Broker cap on the base64 ciphertext (openapi `ciphertext.maxLength`). */
export const MAX_CIPHERTEXT_B64_CHARS = 16_384;

const UNCOMPRESSED_POINT_BYTES = 65;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** The per-connection ephemeral keypair. Private half lives in memory only. */
export interface ConnectionKeypair {
  /** Base64 uncompressed SEC1 point — what `POST /connections` registers. */
  publicKeyB64: string;
  privateKey: KeyObject;
}

export function mintConnectionKeypair(): ConnectionKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);
  return { publicKeyB64: raw.toString('base64'), privateKey };
}

/**
 * The HKDF info string. One producer, imported by tests on both sides.
 *
 * The `ans` segment is a DIRECTION TAG. The broker gained a reverse channel
 * (CLI→page sealed requests) alongside this original page→CLI answer channel,
 * and both ride the same envelope shape over the same connection with the same
 * two public keys. Without a direction tag an envelope captured in one
 * direction would derive an identical key in the other, so a request could be
 * replayed as an answer. Tagging the info string makes the two derivations
 * disjoint by construction. Requests use `req`; this producer only ever seals
 * and opens answers.
 *
 * MIGRATION: keep-app and capy-mcp carry byte-identical producers and moved to
 * the tagged form in the same change as this one — all three must agree or
 * envelopes stop opening. Each repo pins the literal in its own interop test as
 * a cross-repo tripwire.
 */
export function envelopeHkdfInfo(
  connectionId: string,
  clientPubkeyB64: string,
  epkB64: string,
): string {
  return `${ENVELOPE_HKDF_INFO_PREFIX}|ans|${connectionId}|${clientPubkeyB64}|${epkB64}`;
}

/** Why an envelope could not be opened. Codes, never sentences. */
export type EnvelopeFailureCode =
  /** Not base64 JSON of the documented shape. */
  | 'MALFORMED'
  /** A version this build does not implement. */
  | 'UNSUPPORTED_VERSION'
  /** Shape was right but AES-GCM authentication failed — wrong key,
   * wrong connection binding, or tampered bytes. Indistinguishable by design. */
  | 'DECRYPT_FAILED';

export type OpenEnvelopeResult =
  | { ok: true; plaintext: string }
  | { ok: false; code: EnvelopeFailureCode };

interface EnvelopeShape {
  v: number;
  epk: string;
  iv: string;
  ct: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseEnvelope(ciphertextB64: string): EnvelopeShape | null {
  if (
    typeof ciphertextB64 !== 'string' ||
    ciphertextB64.length === 0 ||
    ciphertextB64.length > MAX_CIPHERTEXT_B64_CHARS ||
    !BASE64_RE.test(ciphertextB64)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(ciphertextB64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, epk, iv, ct } = parsed as Record<string, unknown>;
  if (typeof v !== 'number') return null;
  if (typeof epk !== 'string' || !BASE64_RE.test(epk)) return null;
  if (typeof iv !== 'string' || !BASE64_RE.test(iv)) return null;
  if (typeof ct !== 'string' || !BASE64_RE.test(ct)) return null;
  return { v, epk, iv, ct };
}

/**
 * Open a sealed answer for `connectionId`. Never throws — every failure is
 * a code the caller branches on.
 */
export function openEnvelope(opts: {
  ciphertextB64: string;
  connectionId: string;
  keypair: ConnectionKeypair;
}): OpenEnvelopeResult {
  const envelope = parseEnvelope(opts.ciphertextB64);
  if (!envelope) return { ok: false, code: 'MALFORMED' };
  if (envelope.v !== ENVELOPE_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' };
  }

  const epkRaw = Buffer.from(envelope.epk, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  if (
    epkRaw.length !== UNCOMPRESSED_POINT_BYTES ||
    epkRaw[0] !== 0x04 ||
    iv.length !== GCM_IV_BYTES ||
    ct.length <= GCM_TAG_BYTES
  ) {
    return { ok: false, code: 'MALFORMED' };
  }

  try {
    const epk = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: epkRaw.subarray(1, 33).toString('base64url'),
        y: epkRaw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const shared = diffieHellman({
      privateKey: opts.keypair.privateKey,
      publicKey: epk,
    });
    const info = envelopeHkdfInfo(
      opts.connectionId,
      opts.keypair.publicKeyB64,
      envelope.epk,
    );
    const key = Buffer.from(
      hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(info), 32),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      iv,
    );
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

/**
 * The typed inner payload the no-submit screens answer with. `flow` and
 * `signal` are machine fields; there is nothing display-side in here.
 */
export interface CompletionPayload {
  v: number;
  flow: string;
  signal: 'acknowledged';
  /** ISO timestamp the page produced the acknowledgement. Display only. */
  at?: string;
}

/** Parse + validate a completion payload for the expected flow. */
export function parseCompletionPayload(
  plaintext: string,
  expectedFlow: string,
): CompletionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, flow, signal, at } = parsed as Record<string, unknown>;
  if (v !== ENVELOPE_VERSION) return null;
  if (flow !== expectedFlow) return null;
  if (signal !== 'acknowledged') return null;
  if (at !== undefined && typeof at !== 'string') return null;
  return { v, flow, signal, at } as CompletionPayload;
}
