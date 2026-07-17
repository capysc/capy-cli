/**
 * Zero Trust regression guard (CI-required).
 *
 * The assertion this file defends:
 *
 *   Given everything the service ever sees or stores — the KMS-stripped inner
 *   blob, userId, orgId, SHA256(userId:orgId), and any other public
 *   identifier — it CANNOT recover M or any data key.
 *
 * The inner wrap of key.enc is keyed by HKDF(K_local), where K_local is a
 * per-machine CSPRNG secret that never leaves the machine. During co-decrypt
 * the service momentarily holds the KMS-stripped inner blob; these tests prove
 * that blob is opaque to it. If a change ever re-keys the inner wrap with
 * service-computable material (the legacy SHA256(userId:orgId) bug), this
 * file fails.
 */
import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash, hkdfSync, randomBytes } from 'crypto';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-zerotrust-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => { mock.restore(); });

// Use dynamic imports so modules see the mocked os.homedir()
let decryptMasterKey: typeof import('../../src/crypto/keyManager').decryptMasterKey;
let deriveWrappingKey: typeof import('../../src/crypto/keyManager').deriveWrappingKey;
let masterKeyAAD: typeof import('../../src/crypto/keyManager').masterKeyAAD;
let deriveLocalInnerKey: typeof import('../../src/crypto/localKeyRoot').deriveLocalInnerKey;
let readLocalRoot: typeof import('../../src/config/globalConfig').readLocalRoot;
let readMasterKey: typeof import('../../src/config/globalConfig').readMasterKey;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  decryptMasterKey = km.decryptMasterKey;
  deriveWrappingKey = km.deriveWrappingKey;
  masterKeyAAD = km.masterKeyAAD;

  const lkr = await import('../../src/crypto/localKeyRoot');
  deriveLocalInnerKey = lkr.deriveLocalInnerKey;

  const gc = await import('../../src/config/globalConfig');
  readLocalRoot = gc.readLocalRoot;
  readMasterKey = gc.readMasterKey;

  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

/**
 * Fake KMS that mirrors the real contract: wrapOuterLayer adds an outer
 * layer, coDecrypt strips it. What sits between the two — the inner blob —
 * is exactly what the service holds mid-co-decrypt.
 */
const KMS_PREFIX = 'KMS1.';
function fakeKms() {
  return {
    coDecrypt: async (_orgId: string, ct: string) => {
      if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
      return ct.slice(KMS_PREFIX.length);
    },
    wrapOuterLayer: async (_orgId: string, pt: string) => KMS_PREFIX + pt,
  };
}

describe('Zero Trust guard', () => {
  const userId = 'user_zt';
  const orgId = 'org_zt';
  let masterKey: Buffer;
  /** The KMS-stripped inner blob — what the service holds during co-decrypt. */
  let innerBlob: string;
  let kLocal: Buffer;

  beforeAll(async () => {
    masterKey = randomBytes(32);
    await wrapAndSaveMasterKey(masterKey, orgId, userId, fakeKms());
    const stored = readMasterKey(orgId, userId)!;
    expect(stored.startsWith(KMS_PREFIX)).toBe(true);
    innerBlob = stored.slice(KMS_PREFIX.length);
    kLocal = readLocalRoot(orgId, userId)!;
  });

  describe('service-view blindness', () => {
    it('inner blob + userId + orgId + SHA256(userId:orgId) cannot recover M', () => {
      const aad = masterKeyAAD(userId, orgId);

      // Every key the service could derive from what it sees or stores.
      // decryptMasterKey itself grandfathers a no-AAD attempt, so each entry
      // is tried both with and without AAD.
      const serviceComputableKeys: Buffer[] = [
        deriveWrappingKey(userId, orgId), // the legacy inner key — the audit finding
        createHash('sha256').update(`${orgId}:${userId}`).digest(),
        createHash('sha256').update(userId).digest(),
        createHash('sha256').update(orgId).digest(),
        Buffer.from(hkdfSync('sha256', Buffer.from(`${userId}:${orgId}`), 'capy:inner', 'capy:inner:master', 32)),
        Buffer.from(hkdfSync('sha256', Buffer.from(userId), orgId, 'capy:inner:master', 32)),
        Buffer.alloc(32), // degenerate key
      ];

      for (const key of serviceComputableKeys) {
        expect(() => decryptMasterKey(innerBlob, key, aad)).toThrow();
        expect(() => decryptMasterKey(innerBlob, key)).toThrow();
      }
    });

    it('no K_local-derived material appears in any service-visible artifact', () => {
      // The only artifacts the client ever hands the service are the
      // outer-wrap input and the co-decrypt input — both contain the inner
      // blob and nothing else. Neither K_local, the derived inner key, nor
      // plaintext M may appear in it.
      const raw = Buffer.from(innerBlob, 'base64');
      expect(raw.includes(kLocal)).toBe(false);
      expect(raw.includes(deriveLocalInnerKey(kLocal))).toBe(false);
      expect(raw.includes(masterKey)).toBe(false);
    });

    it('positive control: the inner blob opens under HKDF(K_local)', () => {
      // Guards against this suite passing vacuously (e.g. a corrupted blob
      // that no key opens).
      const recovered = decryptMasterKey(innerBlob, deriveLocalInnerKey(kLocal), masterKeyAAD(userId, orgId));
      expect(recovered.equals(masterKey)).toBe(true);
    });
  });

  describe('K_local isolation', () => {
    it('two org/user pairs on one machine get independent roots', async () => {
      const otherOrg = 'org_zt_other';
      const otherUser = 'user_zt_other';
      const otherM = randomBytes(32);
      await wrapAndSaveMasterKey(otherM, otherOrg, otherUser, fakeKms());

      const otherRoot = readLocalRoot(otherOrg, otherUser)!;
      expect(otherRoot.equals(kLocal)).toBe(false);

      // One root cannot unwrap the other's blob.
      expect(() =>
        decryptMasterKey(innerBlob, deriveLocalInnerKey(otherRoot), masterKeyAAD(userId, orgId)),
      ).toThrow();

      const otherInner = readMasterKey(otherOrg, otherUser)!.slice(KMS_PREFIX.length);
      expect(() =>
        decryptMasterKey(otherInner, deriveLocalInnerKey(kLocal), masterKeyAAD(otherUser, otherOrg)),
      ).toThrow();
    });
  });
});
