/**
 * Keep conversation wire crypto, scheme `capy.conv.c.v1` (CAP-921, spec 3m
 * "R2 as confirmed (Variant C)", Security doc "Design after the opposing
 * reviews"). The browser half is keep-app `src/lib/conversation/wire.ts`; both
 * are checked against `tests/fixtures/conversationWireVectors.json`, which is
 * copied byte for byte into keep-app.
 *
 * What it guarantees, given both ends hold K_local for this user and org:
 *  - the link pins the CLI's key (`k`), and `helloKey`/`sessionKeys` refuse a
 *    CLI key that doesn't hash to it, so the service can't swap it;
 *  - each end can prove custody of K_local with an HMAC tag, so the service
 *    can't invent a conversation or an answer (the caller checks the tag
 *    before showing or accepting anything);
 *  - session keys come from a fresh P-256 ECDH, salted from K_auth, so a later
 *    K_local leak opens no recorded conversation, provided both private keys
 *    (and any recovery file or stored page key holding them) are erased when
 *    the conversation ends;
 *  - every record binds conversation id, direction, number, the last peer
 *    number its sender had accepted (`ack`), kind and name, so an answer is
 *    tied to the questions its sender had seen.
 *
 * What the protocol layer must still do is listed in the Security doc
 * ("capy.conv.c.v1 MUSTs"): verify tags first, persist counters, end record,
 * deadlines, one hello per conversation, erase keys at end.
 *
 * Encoding rules (security doc "To pin down before implementation"):
 *  - `lp(...)`: every field is a 4-byte big-endian length, then its bytes.
 *    Strings are well-formed UTF-16 sent as UTF-8. UUIDs are lowercase
 *    canonical. An absent project id is the empty string. Numbers are decimal.
 *  - Public keys are raw uncompressed SEC1 points (65 bytes). Every key, pin
 *    and tag is 32 bytes.
 *  - On the wire every binary value is base64url without padding, canonical.
 *  - MACs and AEAD inputs are the exact bytes received; nothing is
 *    re-serialised before it is checked.
 */
import { ECDH, createECDH, createHash, createHmac, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCHEME = 'capy.conv.c.v1';
const L = {
  k: `${SCHEME}/k`,
  salt: `${SCHEME}/salt`,
  auth: `${SCHEME}/auth`,
  hello: `${SCHEME}/hello`,
  helloKey: `${SCHEME}/hello-key`,
  cli: `${SCHEME}/cli`,
  sessionSalt: `${SCHEME}/session-salt`,
  c2p: `${SCHEME}/session/c2p`,
  p2c: `${SCHEME}/session/p2c`,
  msg: `${SCHEME}/msg`,
} as const;

export type Direction = 'c2p' | 'p2c';
export type Role = 'cli' | 'page';
export type Unlock = 'fresh' | 'remembered';
export type Protection = 'passkey' | 'passphrase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const LONE_SURROGATE = /\p{Cs}/u;

export class ConversationWireError extends Error {
  readonly code = 'CONVERSATION_WIRE_INVALID';
  constructor() { super('The conversation could not be verified.'); }
}
const invalid = (): never => { throw new ConversationWireError(); };
/** Every failure, whatever threw it, surfaces as the one error. */
const guard = <T>(run: () => T): T => {
  try { return run(); } catch { return invalid(); }
};

const bytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : invalid());
const key32 = (value: unknown): Uint8Array => { const b = bytes(value); return b.length === 32 ? b : invalid(); };
const text = (value: unknown): string => (typeof value === 'string' && !LONE_SURROGATE.test(value) ? value : invalid());
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => (allowed.includes(value as T) ? value as T : invalid());
const uuid = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value : invalid());
const point = (value: unknown): Buffer => { const b = bytes(value); return b.length === 65 && b[0] === 4 ? Buffer.from(b) : invalid(); };
const count = (value: unknown, min: number): number => (Number.isSafeInteger(value) && (value as number) >= min ? value as number : invalid());

export const b64u = (value: Uint8Array): string => Buffer.from(bytes(value)).toString('base64url');
export const unb64u = (value: string): Buffer => {
  if (typeof value !== 'string' || !B64URL.test(value)) return invalid();
  const out = Buffer.from(value, 'base64url');
  return out.toString('base64url') === value ? out : invalid();
};

/** Length-prefixed concatenation: the one injective encoding every hash, MAC, HKDF and AAD input uses. */
export function lp(...fields: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(fields.flatMap((field) => {
    const part = typeof field === 'string' ? Buffer.from(text(field), 'utf8') : Buffer.from(bytes(field));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    return [length, part];
  }));
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key32(key)).update(data).digest();
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

/** Who and what both ends must agree on. The CLI fills it from its own state; the page from the link and its unlocked Transport. */
export interface ConversationContext {
  readonly id: string;
  readonly k: Uint8Array;
  readonly userId: string;
  readonly orgId: string;
  /** Empty string when the conversation has no project. */
  readonly projectId: string;
  readonly purpose: string;
  readonly transportId: string;
}

export const ctxBytes = (c: ConversationContext): Buffer =>
  lp(uuid(c.id), key32(c.k), text(c.userId), text(c.orgId), text(c.projectId), text(c.purpose), uuid(c.transportId));

/** The pin carried in the link as `#k=`: it names the CLI's conversation key. */
export const pinFor = (id: string, cliPub: Uint8Array): Buffer => sha256(lp(L.k, uuid(id), point(cliPub)));
/** Refuses a CLI key the link didn't pin. */
const pinned = (c: ConversationContext, cliPub: Uint8Array): void => { if (!tagsEqual(pinFor(c.id, cliPub), key32(c.k))) invalid(); };

/** K_auth: proves custody of K_local for this conversation and nothing else. HMAC use only. */
export const authKey = (kLocal: Uint8Array, id: string, k: Uint8Array): Buffer =>
  hkdf(key32(kLocal), sha256(lp(L.salt, uuid(id), key32(k))), Buffer.from(L.auth, 'utf8'));

export const helloTag = (kAuth: Uint8Array, c: ConversationContext, pagePub: Uint8Array, unlock: Unlock, protection: Protection): Buffer =>
  hmac(kAuth, lp(L.hello, ctxBytes(c), point(pagePub), oneOf(unlock, ['fresh', 'remembered']), oneOf(protection, ['passkey', 'passphrase'])));

export const cliTag = (kAuth: Uint8Array, c: ConversationContext, cliPub: Uint8Array, pagePub: Uint8Array): Buffer =>
  hmac(kAuth, lp(L.cli, ctxBytes(c), point(cliPub), point(pagePub)));

export const tagsEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a instanceof Uint8Array && b instanceof Uint8Array && a.length === 32 && b.length === 32 && timingSafeEqual(a, b);

/** A P-256 key pair for one conversation. The private key never leaves the CLI and is erased when the conversation ends. */
export interface ConversationKeyPair { readonly privateKey: Buffer; readonly publicKey: Buffer }
export function newKeyPair(privateKey?: Uint8Array): ConversationKeyPair {
  return guard(() => {
    const ecdh = createECDH('prime256v1');
    if (privateKey) ecdh.setPrivateKey(Buffer.from(key32(privateKey)));
    else ecdh.generateKeys();
    // getPrivateKey drops leading zero bytes; keep the scalar 32 bytes wide.
    const scalar = Buffer.alloc(32);
    ecdh.getPrivateKey().copy(scalar, 32 - ecdh.getPrivateKey().length);
    return { privateKey: scalar, publicKey: ecdh.getPublicKey(undefined, 'uncompressed') };
  });
}
/** Both points are checked whichever side is asking; the peer is the other one. */
const onCurve = (value: Uint8Array): Buffer => {
  const raw = point(value);
  guard(() => ECDH.convertKey(raw, 'prime256v1', undefined, undefined, 'uncompressed'));
  return raw;
};
const peerOf = (role: Role, cliPub: Uint8Array, pagePub: Uint8Array): Uint8Array => {
  const cli = onCurve(cliPub);
  const page = onCurve(pagePub);
  return oneOf(role, ['cli', 'page']) === 'cli' ? page : cli;
};
const sharedSecret = (own: ConversationKeyPair, peerPub: Uint8Array): Buffer => {
  const peer = point(peerPub);
  return guard(() => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(key32(own.privateKey));
    return ecdh.computeSecret(peer);
  });
};

/**
 * The hello travels before K_auth is agreed, so it is sealed under ECDH alone.
 * Anyone can seal a hello: the CLI must check its `helloTag` before using any field.
 */
export function helloKey(own: ConversationKeyPair, role: Role, c: ConversationContext, cliPub: Uint8Array, pagePub: Uint8Array): Buffer {
  pinned(c, cliPub);
  return hkdf(sharedSecret(own, peerOf(role, cliPub, pagePub)), sha256(lp(L.helloKey, uuid(c.id), key32(c.k))), Buffer.from(L.helloKey, 'utf8'));
}

export interface SessionKeys { readonly c2p: Buffer; readonly p2c: Buffer }
/** One key per direction from ECDH(Ce, Pe), salted from K_auth. Never keyed from K_local alone. */
export function sessionKeys(own: ConversationKeyPair, role: Role, kAuth: Uint8Array, c: ConversationContext, cliPub: Uint8Array, pagePub: Uint8Array): SessionKeys {
  pinned(c, cliPub);
  const secret = sharedSecret(own, peerOf(role, cliPub, pagePub));
  const ctx = ctxBytes(c);
  const salt = hmac(kAuth, lp(L.sessionSalt, ctx));
  const info = (label: string): Buffer => lp(label, ctx, point(cliPub), point(pagePub));
  return { c2p: hkdf(secret, salt, info(L.c2p)), p2c: hkdf(secret, salt, info(L.p2c)) };
}

/**
 * What every record binds: a record can't move to another conversation,
 * direction, turn, kind or name. `ack` is the last number the sender had
 * accepted from the other direction (0 before any), so the receiver knows
 * which of its own records the sender had seen.
 */
export interface RecordHeader {
  readonly id: string;
  readonly direction: Direction;
  readonly n: number;
  readonly ack: number;
  readonly kind: string;
  readonly name: string;
}
const aad = (h: RecordHeader): Buffer => {
  const kind = text(h.kind);
  const name = text(h.name);
  if (kind.length === 0 || kind.length > 64 || name.length > 256) return invalid();
  return lp(L.msg, uuid(h.id), oneOf(h.direction, ['c2p', 'p2c']), String(count(h.n, 1)), String(count(h.ack, 0)), kind, name);
};

const seal = (key: Uint8Array, header: RecordHeader, plaintext: Uint8Array, nonce: Uint8Array): string => {
  const additional = aad(header);
  if (bytes(nonce).length !== 12) return invalid();
  return guard(() => {
    const cipher = createCipheriv('aes-256-gcm', key32(key), nonce);
    cipher.setAAD(additional);
    const body = Buffer.concat([cipher.update(bytes(plaintext)), cipher.final()]);
    return b64u(Buffer.concat([nonce, body, cipher.getAuthTag()]));
  });
};

/** AES-256-GCM with a fresh random nonce. Wire form: base64url(nonce 12 ‖ ciphertext ‖ tag 16). */
export const sealRecord = (key: Uint8Array, header: RecordHeader, plaintext: Uint8Array): string => seal(key, header, plaintext, randomBytes(12));

/** Test vectors only: a fixed nonce. Never call this outside tests. */
export const sealRecordWithNonceForVectors = seal;

export function openRecord(key: Uint8Array, header: RecordHeader, record: string): Buffer {
  const additional = aad(header);
  const raw = unb64u(record);
  if (raw.length < 12 + 16) return invalid();
  return guard(() => {
    const decipher = createDecipheriv('aes-256-gcm', key32(key), raw.subarray(0, 12));
    decipher.setAAD(additional);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  });
}

/**
 * Numbers in one direction start at 1 and go up by exactly one. Anything else
 * (a replay, a gap, a reordering) is dropped. The page's hello is p2c 1 and the
 * CLI's first message, which carries `cliTag`, is c2p 1.
 */
export function acceptNumber(lastAccepted: number, n: number): boolean {
  return Number.isSafeInteger(lastAccepted) && Number.isSafeInteger(n) && n === lastAccepted + 1;
}

/**
 * A record's `ack` never goes backwards and never names a record its receiver
 * hasn't sent. The protocol layer adds the turn rule: an answer is refused when
 * its `ack` is below the number of the latest question or cancel the CLI sent.
 */
export function acceptAck(previousAck: number, ack: number, lastSent: number): boolean {
  return [previousAck, ack, lastSent].every(Number.isSafeInteger) && ack >= previousAck && ack <= lastSent;
}
