import { describe, it, expect } from 'bun:test';
import {
  generateDeviceKeyPair,
  sealToDevice,
  openSealed,
} from '../../src/crypto/deviceKey';
import { generateEpochKey } from '../../src/crypto/epochCrypto';
import { randomBytes } from 'crypto';

describe('device keypair', () => {
  it('generates a 32-byte raw public key (44-char base64) and a private blob', () => {
    const kp = generateDeviceKeyPair();
    expect(Buffer.from(kp.publicKeyB64, 'base64')).toHaveLength(32);
    expect(kp.publicKeyB64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(kp.privateKeyPkcs8B64.length).toBeGreaterThan(0);
  });

  it('generates distinct keypairs', () => {
    expect(generateDeviceKeyPair().publicKeyB64).not.toBe(generateDeviceKeyPair().publicKeyB64);
  });
});

describe('seal / open', () => {
  it('round-trips an epoch key to the holder of the device private key', () => {
    const kp = generateDeviceKeyPair();
    const epochKey = generateEpochKey();
    const sealed = sealToDevice(kp.publicKeyB64, epochKey);
    const opened = openSealed(kp.privateKeyPkcs8B64, sealed);
    expect(opened.equals(epochKey)).toBe(true);
  });

  it('a different device cannot open the sealed blob', () => {
    const alice = generateDeviceKeyPair();
    const bob = generateDeviceKeyPair();
    const sealed = sealToDevice(alice.publicKeyB64, generateEpochKey());
    expect(() => openSealed(bob.privateKeyPkcs8B64, sealed)).toThrow();
  });

  it('tampering with the sealed blob fails AEAD auth', () => {
    const kp = generateDeviceKeyPair();
    const sealed = sealToDevice(kp.publicKeyB64, generateEpochKey());
    const buf = Buffer.from(sealed, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a tag bit
    const tampered = buf.toString('base64');
    expect(() => openSealed(kp.privateKeyPkcs8B64, tampered)).toThrow();
  });

  it('each seal uses a fresh ephemeral key (ciphertexts differ)', () => {
    const kp = generateDeviceKeyPair();
    const key = generateEpochKey();
    expect(sealToDevice(kp.publicKeyB64, key)).not.toBe(sealToDevice(kp.publicKeyB64, key));
  });

  it('seals arbitrary payloads, not just 32-byte keys', () => {
    const kp = generateDeviceKeyPair();
    const payload = randomBytes(100);
    expect(openSealed(kp.privateKeyPkcs8B64, sealToDevice(kp.publicKeyB64, payload)).equals(payload)).toBe(true);
  });
});
