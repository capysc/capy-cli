import { mock, describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { CapyError, ERROR_CODES } from '../../src/types/index';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-resolver-keychain-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

/**
 * Deterministic, environment-independent fake for the keychain backend.
 * The REAL backend is exercised separately in keychainBackend.test.ts
 * (skipped on machines/CI without a usable OS keychain — headless Linux CI
 * runners commonly lack a Secret Service session). This file tests
 * keyResolver's mode-aware BRANCHING logic, which must be testable
 * everywhere regardless of real keychain availability, so it fakes the
 * backend rather than depending on one being present.
 */
let fakeAvailable = true;
let forceReadNull = false; // simulates "mode says keychain but the entry vanished"
const fakeStore = new Map<string, Buffer>();

mock.module('../../src/crypto/keychainBackend', () => ({
  isKeychainAvailable: () => fakeAvailable,
  readKeychainRoot: (orgId: string, userId?: string) => {
    if (forceReadNull) return null;
    return fakeStore.get(`${orgId}:${userId}`) ?? null;
  },
  saveKeychainRootExclusive: (orgId: string, kLocal: Buffer, userId?: string) => {
    const key = `${orgId}:${userId}`;
    if (fakeStore.has(key)) return false;
    fakeStore.set(key, kLocal);
    return true;
  },
  saveKeychainRoot: (orgId: string, kLocal: Buffer, userId?: string) => {
    fakeStore.set(`${orgId}:${userId}`, kLocal);
  },
  wantsKeychainBackend: () => process.env.CAPY_LOCAL_KEY_BACKEND === 'keychain',
}));

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let generateSeedPhrase: typeof import('../../src/crypto/keyManager').generateSeedPhrase;
let seedPhraseToMasterKey: typeof import('../../src/crypto/keyManager').seedPhraseToMasterKey;
let deriveProjectKey: typeof import('../../src/crypto/keyManager').deriveProjectKey;
let getLocalRootMode: typeof import('../../src/config/globalConfig').getLocalRootMode;
let hasLocalRoot: typeof import('../../src/config/globalConfig').hasLocalRoot;
let setLocalRootMode: typeof import('../../src/config/globalConfig').setLocalRootMode;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  deriveProjectKey = km.deriveProjectKey;

  const gc = await import('../../src/config/globalConfig');
  getLocalRootMode = gc.getLocalRootMode;
  hasLocalRoot = gc.hasLocalRoot;
  setLocalRootMode = gc.setLocalRootMode;

  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
  resolveProjectKey = kr.resolveProjectKey;
});

beforeEach(() => {
  fakeAvailable = true;
  forceReadNull = false;
  fakeStore.clear();
  delete process.env.CAPY_LOCAL_KEY_BACKEND;
});

const KMS_PREFIX = 'KMS1.';
function mockKeyServiceOps() {
  return {
    coDecrypt: async (_orgId: string, ct: string) => {
      if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
      return ct.slice(KMS_PREFIX.length);
    },
    wrapOuterLayer: async (_orgId: string, plaintext: string) => KMS_PREFIX + plaintext,
  };
}

describe('keyResolver — keychain mode branching', () => {
  it('stays on the file backend by default, even with a working keychain available', async () => {
    const orgId = 'org_default_no_optin';
    const userId = 'user_default_no_optin';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());

    expect(getLocalRootMode(orgId, userId)).toBe('file');
    expect(hasLocalRoot(orgId, userId)).toBe(true);
    expect(fakeStore.size).toBe(0); // keychain never touched
  });

  it('mints via keychain and writes the mode marker when opted in and available', async () => {
    process.env.CAPY_LOCAL_KEY_BACKEND = 'keychain';
    const orgId = 'org_optin_available';
    const userId = 'user_optin_available';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());

    expect(getLocalRootMode(orgId, userId)).toBe('keychain');
    expect(hasLocalRoot(orgId, userId)).toBe(false); // no plaintext local.key written
    expect(fakeStore.has(`${orgId}:${userId}`)).toBe(true);

    // Steady state: resolves correctly on a second call via the keychain path.
    const key = await resolveProjectKey(orgId, 'proj_1', userId, mockKeyServiceOps());
    expect(key).toBe(deriveProjectKey(masterKey, 'proj_1', orgId));
  });

  it('falls back cleanly to the file backend when opted in but the keychain is unavailable', async () => {
    process.env.CAPY_LOCAL_KEY_BACKEND = 'keychain';
    fakeAvailable = false;
    const orgId = 'org_optin_unavailable';
    const userId = 'user_optin_unavailable';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());

    expect(getLocalRootMode(orgId, userId)).toBe('file');
    expect(hasLocalRoot(orgId, userId)).toBe(true);
    expect(fakeStore.size).toBe(0);
  });

  it('fails closed — throws rather than silently re-minting a file root — when mode says keychain but the entry is gone', async () => {
    process.env.CAPY_LOCAL_KEY_BACKEND = 'keychain';
    const orgId = 'org_fail_closed';
    const userId = 'user_fail_closed';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    // Establish real access first — a genuine keychain-mode install with a
    // working key.enc — before simulating the entry vanishing out from
    // under it.
    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());
    expect(getLocalRootMode(orgId, userId)).toBe('keychain');

    forceReadNull = true;

    let caught: unknown;
    try {
      await resolveProjectKey(orgId, 'proj_1', userId, mockKeyServiceOps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapyError);
    expect((caught as CapyError).code).toBe(ERROR_CODES.LOCAL_KEY_BACKEND_ERROR);

    // Must not have silently minted a plaintext fallback root.
    expect(hasLocalRoot(orgId, userId)).toBe(false);
  });
});
