/**
 * Keep conversation wire crypto, scheme `capy.conv.c.v1` (CAP-921, spec 3m
 * "R2 as confirmed (Variant C)", Security doc "Design after the opposing
 * reviews"). The browser half is keep-app `src/lib/conversation/wire.ts`; both
 * are checked against `tests/fixtures/conversationWireVectors.json`, which is
 * copied byte for byte into keep-app.
 *
 * What it guarantees, given both ends hold K_local for this user and org:
 *  - the link pins the CLI's key (`k`), so the service can't swap it;
 *  - each end proves custody of K_local with an HMAC tag before anything is
 *    shown or accepted, so the service can't invent a conversation or answer;
 *  - one session key from a fresh P-256 ECDH, salted with K_auth, so a later
 *    K_local leak opens no recorded conversation once both private keys are gone;
 *  - every record binds conversation id, direction, number, kind and name.
 *
 * Encoding rules (security doc "To pin down before implementation"):
 *  - `lp(...)`: every field is a 4-byte big-endian length, then its bytes.
 *    Strings are UTF-8. UUIDs are lowercase canonical. An absent project id
 *    is the empty string (project ids are never empty).
 *  - Public keys are raw uncompressed SEC1 points (65 bytes).
 *  - On the wire every binary value is base64url without padding.
 *  - MACs and AEAD inputs are the exact bytes received; nothing is
 *    re-serialised before it is checked.
 */
import { createECDH, createHash, createHmac, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCHEME = 'capy.conv.c.v1';
const L = {
  k: `${SCHEME}/k`,
  salt: `${SCHEME}/salt`,
  auth: `${SCHEME}/auth`,
  hello: `${SCHEME}/hello`,
  helloKey: `${SCHEME}/hello-key`,
  cli: `${SCHEME}/cli`,
  c2p: `${SCHEME}/session/c2p`,
  p2c: `${SCHEME}/session/p2c`,
  msg: `${SCHEME}/msg`,
} as const;

export type Direction = 'c2p' | 'p2c';
export type Unlock = 'fresh' | 'remembered';
export type Protection = 'passkey' | 'passphrase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

export class ConversationWireError extends Error {
  constructor(readonly code: 'CONVERSATION_WIRE_INVALID') { super('The conversation could not be verified.'); }
}
const invalid = (): never => { throw new ConversationWireError('CONVERSATION_WIRE_INVALID'); };

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const unb64u = (text: string): Buffer => {
  if (typeof text !== 'string' || !B64URL.test(text)) return invalid();
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : invalid();
};

/** Length-prefixed concatenation: the one injective encoding every hash, MAC, HKDF and AAD input uses. */
export function lp(...fields: readonly (string | Uint8Array)[]): Buffer {
  return Buffer.concat(fields.flatMap((field) => {
    const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest();
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

const uuid = (value: string): string => (UUID.test(value) ? value : invalid());
const point = (value: Uint8Array): Buffer => (value.length === 65 && value[0] === 4 ? Buffer.from(value) : invalid());

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
  lp(uuid(c.id), c.k, c.userId, c.orgId, c.projectId, c.purpose, uuid(c.transportId));

/** The pin carried in the link as `#k=`: it names the CLI's conversation key. */
export const pinFor = (id: string, cliPub: Uint8Array): Buffer => sha256(lp(L.k, uuid(id), point(cliPub)));

/** K_auth: proves custody of K_local for this conversation and nothing else. HMAC use only. */
export const authKey = (kLocal: Uint8Array, id: string, k: Uint8Array): Buffer => {
  if (kLocal.length !== 32 || k.length !== 32) return invalid();
  return hkdf(kLocal, sha256(lp(L.salt, uuid(id), k)), Buffer.from(L.auth, 'utf8'));
};

export const helloTag = (kAuth: Uint8Array, c: ConversationContext, pagePub: Uint8Array, unlock: Unlock, protection: Protection): Buffer =>
  hmac(kAuth, lp(L.hello, ctxBytes(c), point(pagePub), unlock, protection));

export const cliTag = (kAuth: Uint8Array, c: ConversationContext, cliPub: Uint8Array, pagePub: Uint8Array): Buffer =>
  hmac(kAuth, lp(L.cli, ctxBytes(c), point(cliPub), point(pagePub)));

export const tagsEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === 32 && b.length === 32 && timingSafeEqual(a, b);

/** A P-256 key pair for one conversation. The private key never leaves the CLI. */
export interface ConversationKeyPair { readonly privateKey: Buffer; readonly publicKey: Buffer }
export function newKeyPair(privateKey?: Uint8Array): ConversationKeyPair {
  const ecdh = createECDH('prime256v1');
  if (privateKey) ecdh.setPrivateKey(Buffer.from(privateKey));
  else ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(undefined, 'uncompressed') };
}
const sharedSecret = (own: ConversationKeyPair, peerPub: Uint8Array): Buffer => {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(own.privateKey);
  try { return ecdh.computeSecret(point(peerPub)); } catch { return invalid(); }
};

/** The hello travels before K_auth is agreed, so it is sealed under ECDH alone; its tag is what authenticates it. */
export const helloKey = (own: ConversationKeyPair, peerPub: Uint8Array, id: string, k: Uint8Array): Buffer =>
  hkdf(sharedSecret(own, peerPub), sha256(lp(L.helloKey, uuid(id), k)), Buffer.from(L.helloKey, 'utf8'));

export interface SessionKeys { readonly c2p: Buffer; readonly p2c: Buffer }
/** One key per direction from ECDH(Ce, Pe) salted with K_auth. Never keyed from K_local alone. */
export function sessionKeys(own: ConversationKeyPair, peerPub: Uint8Array, kAuth: Uint8Array, c: ConversationContext, cliPub: Uint8Array, pagePub: Uint8Array): SessionKeys {
  const secret = sharedSecret(own, peerPub);
  const info = (label: string): Buffer => lp(label, ctxBytes(c), point(cliPub), point(pagePub));
  return { c2p: hkdf(secret, kAuth, info(L.c2p)), p2c: hkdf(secret, kAuth, info(L.p2c)) };
}

/** What every record binds: a record can't move to another conversation, direction, turn, kind or name. */
export interface RecordHeader { readonly id: string; readonly direction: Direction; readonly n: number; readonly kind: string; readonly name: string }
const aad = (h: RecordHeader): Buffer => {
  if (!Number.isSafeInteger(h.n) || h.n < 1 || h.kind.length === 0 || h.kind.length > 64 || h.name.length > 256) return invalid();
  return lp(L.msg, uuid(h.id), h.direction, String(h.n), h.kind, h.name);
};

/** AES-256-GCM. Wire form: base64url(nonce 12 ‖ ciphertext ‖ tag 16). */
export function sealRecord(key: Uint8Array, header: RecordHeader, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(12)): string {
  if (key.length !== 32 || nonce.length !== 12) return invalid();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(header));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return b64u(Buffer.concat([nonce, body, cipher.getAuthTag()]));
}

export function openRecord(key: Uint8Array, header: RecordHeader, record: string): Buffer {
  const bytes = unb64u(record);
  if (key.length !== 32 || bytes.length < 12 + 16) return invalid();
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(aad(header));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try { return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]); }
  catch { return invalid(); }
}

/**
 * Numbers in one direction start at 1 and go up by exactly one. Anything else
 * (a replay, a gap, a reordering) is dropped. The page's hello is p2c 1 and the
 * CLI's first message, which carries `cliTag`, is c2p 1.
 */
export function acceptNumber(lastAccepted: number, n: number): boolean {
  return Number.isSafeInteger(n) && n === lastAccepted + 1;
}
