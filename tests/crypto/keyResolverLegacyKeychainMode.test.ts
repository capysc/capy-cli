import { mock, describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CapyError, ERROR_CODES } from '../../src/types/index';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-resolver-legacy-keychain-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

/**
 * The OS-keychain K_local backend was removed. Two things have to stay true
 * afterwards, and neither is visible from the file backend's own tests:
 *
 *  1. CAPY_LOCAL_KEY_BACKEND is inert — setting it can't change where a
 *     fresh mint lands, or an old muscle-memory export would send a user
 *     down a code path that no longer exists.
 *  2. An install that opted in while the backend existed still has its
 *     K_local in the OS keychain and a '.mode' marker on disk. Those must
 *     fail closed, not fall through and mint a second root that orphans the
 *     existing key.enc.
 */

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let generateSeedPhrase: typeof import('../../src/crypto/keyManager').generateSeedPhrase;
let seedPhraseToMasterKey: typeof import('../../src/crypto/keyManager').seedPhraseToMasterKey;
let getLocalRootMode: typeof import('../../src/config/globalConfig').getLocalRootMode;
let getLocalRootModePath: typeof import('../../src/config/globalConfig').getLocalRootModePath;
let getLocalRootPath: typeof import('../../src/config/globalConfig').getLocalRootPath;
let hasLocalRoot: typeof import('../../src/config/globalConfig').hasLocalRoot;
let wrapAndSaveMasterKey: typeof import('../../src/crypto/keyResolver').wrapAndSaveMasterKey;
let resolveProjectKey: typeof import('../../src/crypto/keyResolver').resolveProjectKey;

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;

  const gc = await import('../../src/config/globalConfig');
  getLocalRootMode = gc.getLocalRootMode;
  getLocalRootModePath = gc.getLocalRootModePath;
  getLocalRootPath = gc.getLocalRootPath;
  hasLocalRoot = gc.hasLocalRoot;

  const kr = await import('../../src/crypto/keyResolver');
  wrapAndSaveMasterKey = kr.wrapAndSaveMasterKey;
  resolveProjectKey = kr.resolveProjectKey;
});

beforeEach(() => {
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

/** Writes the legacy marker a pre-removal keychain-mode install would have left behind. */
function writeLegacyKeychainMarker(orgId: string, userId: string): void {
  const path = getLocalRootModePath(orgId, userId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, 'keychain', { mode: 0o600 });
}

describe('keyResolver — removed keychain backend', () => {
  it('mints the file backend and writes no mode marker, even with CAPY_LOCAL_KEY_BACKEND=keychain', async () => {
    process.env.CAPY_LOCAL_KEY_BACKEND = 'keychain';
    const orgId = 'org_optin_inert';
    const userId = 'user_optin_inert';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());

    expect(getLocalRootMode(orgId, userId)).toBe('file');
    expect(hasLocalRoot(orgId, userId)).toBe(true);
  });

  it('fails closed on a stranded keychain marker rather than minting a second root', async () => {
    const orgId = 'org_stranded';
    const userId = 'user_stranded';
    const masterKey = seedPhraseToMasterKey(generateSeedPhrase());

    // Establish a real, working install first so there's a key.enc to orphan,
    // then reshape it into what a pre-removal keychain-mode install looks
    // like on disk: marker says keychain, no plaintext local.key, and the
    // K_local itself unreachable in the OS keychain.
    await wrapAndSaveMasterKey(masterKey, orgId, userId, mockKeyServiceOps());
    rmSync(getLocalRootPath(orgId, userId));
    writeLegacyKeychainMarker(orgId, userId);
    expect(getLocalRootMode(orgId, userId)).toBe('keychain');

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
