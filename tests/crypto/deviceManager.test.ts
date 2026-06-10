import { mock, describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-devmgr-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => { mock.restore(); rmSync(tempHome, { recursive: true, force: true }); });

let dm: typeof import('../../src/crypto/deviceManager');
let openSealed: typeof import('../../src/crypto/deviceKey').openSealed;
let sealToDevice: typeof import('../../src/crypto/deviceKey').sealToDevice;
let gc: typeof import('../../src/config/globalConfig');

beforeAll(async () => {
  dm = await import('../../src/crypto/deviceManager');
  const dk = await import('../../src/crypto/deviceKey');
  openSealed = dk.openSealed;
  sealToDevice = dk.sealToDevice;
  gc = await import('../../src/config/globalConfig');
});

const ORG = 'org_dev';
const USER = 'user_dev';

/**
 * Mock service: KMS outer layer is passthrough (wrapOuterLayer returns plaintext,
 * coDecrypt returns it back). Device registration returns a stable id.
 */
function mockService() {
  let counter = 0;
  const registered: string[] = [];
  return {
    coDecrypt: async (_o: string, ct: string) => ct,
    wrapOuterLayer: async (_o: string, pt: string) => pt,
    registerDevice: async (_o: string, pk: string) => {
      registered.push(pk);
      return { device_id: `dev_${++counter}` };
    },
    registered,
  };
}

beforeEach(() => {
  rmSync(join(tempHome, '.capy'), { recursive: true, force: true });
});

describe('deviceManager', () => {
  it('mints, double-wraps, and registers a device keypair', async () => {
    const svc = mockService();
    const deviceId = await dm.ensureDeviceKey(ORG, USER, svc);
    expect(deviceId).toBe('dev_1');
    expect(svc.registered.length).toBe(1);

    const record = gc.readDeviceKeyRecord(ORG, USER);
    expect(record).not.toBeNull();
    expect(record!.public_key).toBe(svc.registered[0]);
    // Private key is stored wrapped, never in plaintext.
    expect(record!.encrypted_private_key).not.toContain(record!.public_key);
    // K_local was minted alongside.
    expect(gc.hasLocalRoot(ORG, USER)).toBe(true);
  });

  it('is idempotent — second call does not mint a new keypair', async () => {
    const svc = mockService();
    await dm.ensureDeviceKey(ORG, USER, svc);
    const firstPub = gc.readDeviceKeyRecord(ORG, USER)!.public_key;
    await dm.ensureDeviceKey(ORG, USER, svc);
    expect(gc.readDeviceKeyRecord(ORG, USER)!.public_key).toBe(firstPub);
  });

  it('loadDevicePrivateKey recovers a key that opens blobs sealed to the public key', async () => {
    const svc = mockService();
    await dm.ensureDeviceKey(ORG, USER, svc);
    const pub = gc.readDeviceKeyRecord(ORG, USER)!.public_key;

    const priv = await dm.loadDevicePrivateKey(ORG, USER, svc);
    expect(priv).not.toBeNull();

    // A blob sealed to the registered public key opens with the recovered key.
    const secret = Buffer.from('an-epoch-key-32-bytes-padding...');
    const sealed = sealToDevice(pub, secret);
    expect(openSealed(priv!, sealed).equals(secret)).toBe(true);
  });

  it('loadDevicePrivateKey returns null when no device exists', async () => {
    const svc = mockService();
    expect(await dm.loadDevicePrivateKey(ORG, USER, svc)).toBeNull();
  });
});
