import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import {
  generateEpochKey,
  deriveEpoch0,
  deriveProjectKey,
  wrapHistoryBlob,
  unwrapHistoryBlob,
  wrapEscrowBlob,
  unwrapEscrowBlob,
} from '../../src/crypto/epochCrypto';
import { generateDeviceKeyPair, sealToDevice, openSealed } from '../../src/crypto/deviceKey';
import { Encryptor } from '../../src/crypto/encryptor';

/**
 * Crypto-layer proxy for e2e scenarios 2 (kick-blocks-future) and 5 (owner
 * break-glass). Composes the modules into the full kick lifecycle without any
 * service or I/O, so the cryptographic guarantee is asserted directly.
 */
describe('epoch lifecycle: migration -> kick -> revocation -> break-glass', () => {
  const ORG = 'org_life';
  const PROJ = 'proj_life';

  it('remaining member decrypts across the kick; exfiltrated old key cannot', () => {
    const M = randomBytes(32);

    // --- Epoch 0 (migration): data encrypted under E_0 = HKDF(M) ---
    const e0 = deriveEpoch0(M);
    const k0 = deriveProjectKey(e0, PROJ, ORG);
    const v1 = JSON.stringify({ API_KEY: 'v1-secret' });
    const blobV1 = Encryptor.encrypt(v1, k0);

    // Member B is on the org at epoch 0 and (in scenario 2) exfiltrates e0.
    const exfiltratedByB = Buffer.from(e0); // everything B ever held
    const cRemaining = generateDeviceKeyPair(); // member C stays

    // --- Kick B: mint fresh E_1, chain, escrow, seal to remaining member C ---
    const e1 = generateEpochKey();
    const historyBlob1 = wrapHistoryBlob(e0, e1);       // 0 -> 1
    const escrow1 = wrapEscrowBlob(M, 1, e1);
    const sealedToC = sealToDevice(cRemaining.publicKeyB64, e1);

    // --- A pushes v4 under E_1 ---
    const k1 = deriveProjectKey(e1, PROJ, ORG);
    const v4 = JSON.stringify({ API_KEY: 'v4-secret-post-kick' });
    const blobV4 = Encryptor.encrypt(v4, k1);

    // === Guarantee (scenario 2): B's exfiltrated key material cannot decrypt
    //     v4, by ANY path. E_1 is fresh randomness unreachable from e0. ===
    const everyKeyBHeld = [
      exfiltratedByB.toString('hex'),                       // e0 raw
      deriveProjectKey(exfiltratedByB, PROJ, ORG),          // derived k0
    ];
    for (const stolen of everyKeyBHeld) {
      expect(Encryptor.canDecrypt(blobV4, stolen)).toBe(false);
    }
    // And there is no function from e0 to e1.
    expect(() => unwrapHistoryBlob(historyBlob1, e0)).toThrow();

    // === Remaining member C: unseal E_1, decrypt v4, walk back to read v1 ===
    const cE1 = openSealed(cRemaining.privateKeyPkcs8B64, sealedToC);
    expect(cE1.equals(e1)).toBe(true);
    expect(Encryptor.decrypt(blobV4, deriveProjectKey(cE1, PROJ, ORG))).toBe(v4);

    const cE0 = unwrapHistoryBlob(historyBlob1, cE1);   // walk 1 -> 0
    expect(Encryptor.decrypt(blobV1, deriveProjectKey(cE0, PROJ, ORG))).toBe(v1);

    // === Owner break-glass (scenario 5): seed -> M -> escrow -> every epoch,
    //     fully offline. ===
    const ownerE1 = unwrapEscrowBlob(escrow1, M, 1);
    expect(Encryptor.decrypt(blobV4, deriveProjectKey(ownerE1, PROJ, ORG))).toBe(v4);
    const ownerE0 = deriveEpoch0(M); // epoch 0 recoverable directly from M
    expect(Encryptor.decrypt(blobV1, deriveProjectKey(ownerE0, PROJ, ORG))).toBe(v1);
  });
});
