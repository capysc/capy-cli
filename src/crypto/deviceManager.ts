import {
  readLocalRoot,
  saveLocalRoot,
  readDeviceKeyRecord,
  saveDeviceKeyRecord,
  DeviceKeyRecord,
} from '../config/globalConfig';
import { generateLocalRoot, deriveDeviceInnerKey } from './localKeyRoot';
import { encryptMasterKey, decryptMasterKey } from './keyManager';
import { generateDeviceKeyPair } from './deviceKey';

/**
 * Device keypair lifecycle (CAP-58 / docs/epoch-key-design.md §4).
 *
 * Each machine has one X25519 device keypair per org. The private key is stored
 * double-wrapped exactly like key.enc — KMS outer (stripped via co-decrypt) +
 * local inner keyed by HKDF(K_local, "capy:inner:device"). The public key is
 * registered with the service (append-only) so kick-time re-key can HPKE-seal
 * new epoch keys to it.
 *
 * The device private key never leaves the machine in plaintext, and K_local
 * never leaves at all — so the service is a blind mailbox for sealed blobs.
 */

const DEVICE_AAD = Buffer.from('capy:devicekey:v1', 'utf8');

/** Operations deviceManager needs from the service (subset of ServiceClient). */
export interface DeviceServiceOps {
  coDecrypt(orgId: string, ciphertext: string): Promise<string>;
  wrapOuterLayer(orgId: string, plaintext: string): Promise<string>;
  registerDevice(orgId: string, publicKey: string): Promise<{ device_id: string }>;
}

/** Reads K_local, minting + persisting one if this machine has none. */
function ensureLocalRoot(orgId: string, userId: string): Buffer {
  let kLocal = readLocalRoot(orgId, userId);
  if (!kLocal) {
    kLocal = generateLocalRoot();
    saveLocalRoot(orgId, kLocal, userId);
  }
  return kLocal;
}

/**
 * Ensures this machine has a registered device keypair for the org. Idempotent:
 * if device.enc already exists, returns its device_id (re-registering the same
 * public key is a service-side no-op). Otherwise mints a keypair, double-wraps
 * the private key under K_local, registers the public key, and persists.
 *
 * Best-effort by design: callers wrap this so a registration failure (e.g.
 * server briefly unavailable) never blocks the surrounding flow — the device is
 * registered on the next run.
 */
export async function ensureDeviceKey(
  orgId: string,
  userId: string,
  service: DeviceServiceOps,
): Promise<string> {
  const existing = readDeviceKeyRecord(orgId, userId);
  if (existing) {
    // Re-assert registration (append-only / idempotent) so a device minted
    // while the server was down still lands. Cheap and self-healing.
    try {
      const { device_id } = await service.registerDevice(orgId, existing.public_key);
      if (device_id && device_id !== existing.device_id) {
        saveDeviceKeyRecord(orgId, { ...existing, device_id }, userId);
      }
      return device_id || existing.device_id || '';
    } catch {
      return existing.device_id || '';
    }
  }

  const kLocal = ensureLocalRoot(orgId, userId);
  const keyPair = generateDeviceKeyPair();

  // Double-wrap the private key: inner = HKDF(K_local), outer = KMS.
  const privBuf = Buffer.from(keyPair.privateKeyPkcs8B64, 'base64');
  const innerWrapped = encryptMasterKey(privBuf, deriveDeviceInnerKey(kLocal), DEVICE_AAD);
  const encryptedPrivateKey = await service.wrapOuterLayer(orgId, innerWrapped);

  const { device_id } = await service.registerDevice(orgId, keyPair.publicKeyB64);

  const record: DeviceKeyRecord = {
    version: '1.0',
    device_id,
    public_key: keyPair.publicKeyB64,
    encrypted_private_key: encryptedPrivateKey,
    created_at: new Date().toISOString(),
  };
  saveDeviceKeyRecord(orgId, record, userId);
  return device_id;
}

/**
 * Recovers this machine's device private key (PKCS#8 base64): strip KMS outer
 * via co-decrypt, then unwrap the inner layer with HKDF(K_local). Returns null
 * if no device keypair exists locally.
 */
export async function loadDevicePrivateKey(
  orgId: string,
  userId: string,
  service: DeviceServiceOps,
): Promise<string | null> {
  const record = readDeviceKeyRecord(orgId, userId);
  if (!record) return null;
  const kLocal = readLocalRoot(orgId, userId);
  if (!kLocal) return null;

  const innerBlob = await service.coDecrypt(orgId, record.encrypted_private_key);
  const priv = decryptMasterKey(innerBlob, deriveDeviceInnerKey(kLocal), DEVICE_AAD);
  return priv.toString('base64');
}

/** The locally-stored device public key, or null. */
export function getDevicePublicKey(orgId: string, userId: string): string | null {
  return readDeviceKeyRecord(orgId, userId)?.public_key ?? null;
}
