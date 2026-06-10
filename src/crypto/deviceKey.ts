import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  KeyObject,
} from 'crypto';
import { aesEncrypt, aesDecrypt } from './inviteCrypto';

/**
 * Per-user X25519 device keypair (CAP-58 / docs/epoch-key-design.md §4).
 *
 * Purpose: a service-blind transport channel for new epoch keys. At kick time
 * the kicker seals the new epoch key to every remaining member's device public
 * key; members unseal it on their next run. The service stores the sealed
 * blobs but cannot open them — only the device private key can.
 *
 * Construction is a box-style ECIES seal built from Node's native primitives
 * (X25519 + HKDF-SHA256 + AES-256-GCM), so the CLI ships with no native crypto
 * addons (pkg binary constraint). Each seal uses a fresh ephemeral keypair; the
 * shared secret is mixed with both public keys via HKDF before keying AES-GCM.
 *
 * NOTE: the device PRIVATE key is itself stored double-wrapped (KMS outer +
 * local inner keyed by HKDF(K_local, "capy:inner:device")) — see localKeyRoot.
 * This module deals only with the keypair and the seal/open transform.
 */

const RAW_KEY_LENGTH = 32;

export interface DeviceKeyPair {
  /** base64 of the raw 32-byte X25519 public key (what the service stores). */
  publicKeyB64: string;
  /** PKCS#8 DER of the private key, base64 — the bytes that get double-wrapped. */
  privateKeyPkcs8B64: string;
}

/** Extracts the raw 32-byte X25519 public key from a KeyObject. */
function rawPublicKey(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Not an X25519 public key');
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== RAW_KEY_LENGTH) throw new Error('Unexpected X25519 public key length');
  return raw;
}

/** Reconstructs a public-key KeyObject from raw 32 bytes (SPKI wrapping). */
function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== RAW_KEY_LENGTH) throw new Error('X25519 public key must be 32 bytes');
  const jwk = { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Generates a fresh device keypair. */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyB64: rawPublicKey(publicKey).toString('base64'),
    privateKeyPkcs8B64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Loads a private-key KeyObject from the stored PKCS#8 bytes. */
function loadPrivateKey(privateKeyPkcs8B64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(privateKeyPkcs8B64, 'base64'),
    type: 'pkcs8',
    format: 'der',
  });
}

/**
 * Derives the symmetric seal key from a DH shared secret, binding both public
 * keys so the transcript can't be repurposed across recipients.
 */
function deriveSealKey(shared: Buffer, ephemeralPubRaw: Buffer, recipientPubRaw: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralPubRaw, recipientPubRaw]);
  return Buffer.from(hkdfSync('sha256', shared, salt, 'capy:device:seal:v1', 32));
}

/**
 * Seals `plaintext` (e.g. a 32-byte epoch key) to a recipient device public
 * key. Output: base64( ephemeralPub(32) || aesEncrypt(plaintext) ).
 */
export function sealToDevice(recipientPublicKeyB64: string, plaintext: Buffer): string {
  const recipientRaw = Buffer.from(recipientPublicKeyB64, 'base64');
  const recipientPub = publicKeyFromRaw(recipientRaw);

  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublicKey(ephPub);
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipientPub });
  const sealKey = deriveSealKey(shared, ephemeralRaw, recipientRaw);

  const inner = Buffer.from(aesEncrypt(plaintext, sealKey), 'base64');
  return Buffer.concat([ephemeralRaw, inner]).toString('base64');
}

/**
 * Opens a sealed blob with the device private key. Tamper / wrong key fails the
 * AEAD auth. Returns the plaintext.
 */
export function openSealed(privateKeyPkcs8B64: string, sealedB64: string): Buffer {
  const combined = Buffer.from(sealedB64, 'base64');
  if (combined.length <= RAW_KEY_LENGTH) throw new Error('Sealed blob too short');
  const ephemeralRaw = combined.subarray(0, RAW_KEY_LENGTH);
  const inner = combined.subarray(RAW_KEY_LENGTH);

  const priv = loadPrivateKey(privateKeyPkcs8B64);
  const ephemeralPub = publicKeyFromRaw(ephemeralRaw);
  const shared = diffieHellman({ privateKey: priv, publicKey: ephemeralPub });

  // Recipient's own raw public key, recomputed from the private key, completes
  // the HKDF salt transcript used at seal time.
  const recipientRaw = rawPublicKey(createPublicKey(priv));
  const sealKey = deriveSealKey(shared, ephemeralRaw, recipientRaw);

  return aesDecrypt(inner.toString('base64'), sealKey);
}

/** Generates a random opaque device id used to namespace local key files. */
export function randomDeviceLabel(): string {
  return randomBytes(8).toString('hex');
}
