import { mock, describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => { mock.restore(); });

// Use dynamic import so globalConfig sees the mocked os module
let getGlobalCapyDir: typeof import('../../src/config/globalConfig').getGlobalCapyDir;
let getOrgKeyPath: typeof import('../../src/config/globalConfig').getOrgKeyPath;
let getProjectKeyCachePath: typeof import('../../src/config/globalConfig').getProjectKeyCachePath;
let saveMasterKey: typeof import('../../src/config/globalConfig').saveMasterKey;
let readMasterKey: typeof import('../../src/config/globalConfig').readMasterKey;
let hasOrgKey: typeof import('../../src/config/globalConfig').hasOrgKey;
let saveProjectKeyCache: typeof import('../../src/config/globalConfig').saveProjectKeyCache;
let readProjectKeyCache: typeof import('../../src/config/globalConfig').readProjectKeyCache;
let saveAuthSession: typeof import('../../src/config/globalConfig').saveAuthSession;
let readAuthSession: typeof import('../../src/config/globalConfig').readAuthSession;
let writeKeepCache: typeof import('../../src/config/globalConfig').writeKeepCache;
let readKeepCache: typeof import('../../src/config/globalConfig').readKeepCache;
let fetchSecretsWithCache: typeof import('../../src/config/globalConfig').fetchSecretsWithCache;
let getForceLoginMarkerPath: typeof import('../../src/config/globalConfig').getForceLoginMarkerPath;
let setForceLoginMarker: typeof import('../../src/config/globalConfig').setForceLoginMarker;
let consumeForceLoginMarker: typeof import('../../src/config/globalConfig').consumeForceLoginMarker;
let getDeviceKeyNudgeDeclinedMarkerPath: typeof import('../../src/config/globalConfig').getDeviceKeyNudgeDeclinedMarkerPath;
let hasDeclinedDeviceKeyNudge: typeof import('../../src/config/globalConfig').hasDeclinedDeviceKeyNudge;
let setDeviceKeyNudgeDeclined: typeof import('../../src/config/globalConfig').setDeviceKeyNudgeDeclined;
let getLocalRootPath: typeof import('../../src/config/globalConfig').getLocalRootPath;
let saveLocalRoot: typeof import('../../src/config/globalConfig').saveLocalRoot;
let saveLocalRootExclusive: typeof import('../../src/config/globalConfig').saveLocalRootExclusive;
let readLocalRoot: typeof import('../../src/config/globalConfig').readLocalRoot;
let hasLocalRoot: typeof import('../../src/config/globalConfig').hasLocalRoot;
let markKeyEncSyncPending: typeof import('../../src/config/globalConfig').markKeyEncSyncPending;
let clearKeyEncSyncPending: typeof import('../../src/config/globalConfig').clearKeyEncSyncPending;
let isKeyEncSyncPending: typeof import('../../src/config/globalConfig').isKeyEncSyncPending;
let readKeyEncSyncPendingMarker: typeof import('../../src/config/globalConfig').readKeyEncSyncPendingMarker;
let getKeyEncSyncPendingPath: typeof import('../../src/config/globalConfig').getKeyEncSyncPendingPath;
let rootFingerprint: typeof import('../../src/config/globalConfig').rootFingerprint;

beforeAll(async () => {
  const mod = await import('../../src/config/globalConfig');
  getGlobalCapyDir = mod.getGlobalCapyDir;
  getOrgKeyPath = mod.getOrgKeyPath;
  getProjectKeyCachePath = mod.getProjectKeyCachePath;
  saveMasterKey = mod.saveMasterKey;
  readMasterKey = mod.readMasterKey;
  hasOrgKey = mod.hasOrgKey;
  saveProjectKeyCache = mod.saveProjectKeyCache;
  readProjectKeyCache = mod.readProjectKeyCache;
  saveAuthSession = mod.saveAuthSession;
  readAuthSession = mod.readAuthSession;
  writeKeepCache = mod.writeKeepCache;
  readKeepCache = mod.readKeepCache;
  fetchSecretsWithCache = mod.fetchSecretsWithCache;
  getForceLoginMarkerPath = mod.getForceLoginMarkerPath;
  setForceLoginMarker = mod.setForceLoginMarker;
  consumeForceLoginMarker = mod.consumeForceLoginMarker;
  getDeviceKeyNudgeDeclinedMarkerPath = mod.getDeviceKeyNudgeDeclinedMarkerPath;
  hasDeclinedDeviceKeyNudge = mod.hasDeclinedDeviceKeyNudge;
  setDeviceKeyNudgeDeclined = mod.setDeviceKeyNudgeDeclined;
  getLocalRootPath = mod.getLocalRootPath;
  saveLocalRoot = mod.saveLocalRoot;
  saveLocalRootExclusive = mod.saveLocalRootExclusive;
  readLocalRoot = mod.readLocalRoot;
  hasLocalRoot = mod.hasLocalRoot;
  markKeyEncSyncPending = mod.markKeyEncSyncPending;
  clearKeyEncSyncPending = mod.clearKeyEncSyncPending;
  isKeyEncSyncPending = mod.isKeyEncSyncPending;
  readKeyEncSyncPendingMarker = mod.readKeyEncSyncPendingMarker;
  getKeyEncSyncPendingPath = mod.getKeyEncSyncPendingPath;
  rootFingerprint = mod.rootFingerprint;
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe('GlobalConfig', () => {
  describe('paths', () => {
    it('should return paths under ~/.capy/', () => {
      expect(getGlobalCapyDir()).toBe(join(tempHome, '.capy'));
      expect(getOrgKeyPath('org_1')).toBe(join(tempHome, '.capy', 'orgs', 'org_1', 'key.enc'));
      expect(getProjectKeyCachePath('org_1', 'proj_1')).toBe(
        join(tempHome, '.capy', 'orgs', 'org_1', 'projects', 'proj_1', 'key.cache')
      );
    });
  });

  describe('master key', () => {
    it('should save and read master key', () => {
      saveMasterKey('org_test', 'encrypted-blob-data');
      const result = readMasterKey('org_test');
      expect(result).toBe('encrypted-blob-data');
    });

    it('should return null for missing org', () => {
      expect(readMasterKey('org_nonexistent')).toBeNull();
    });

    it('should report hasOrgKey correctly', () => {
      expect(hasOrgKey('org_test')).toBe(true);
      expect(hasOrgKey('org_missing')).toBe(false);
    });
  });

  describe('project key cache', () => {
    it('should save and read cached project key', () => {
      saveProjectKeyCache('org_1', 'proj_1', 'abcdef1234567890');
      const result = readProjectKeyCache('org_1', 'proj_1');
      expect(result).toBe('abcdef1234567890');
    });

    it('should return null for missing cache', () => {
      expect(readProjectKeyCache('org_1', 'proj_missing')).toBeNull();
    });
  });

  describe('auth session', () => {
    it('should save and read auth session', () => {
      const token = { access_token: 'abc', expires_at: 123 };
      saveAuthSession(token);
      const result = readAuthSession();
      expect(result).toEqual(token);
    });
  });

  describe('keep cache', () => {
    const ORG = 'org_1';
    const PROJ = 'proj_1';

    it('should round-trip write and read', () => {
      const hash = 'abc123def456';
      const blob = 'FOO=capy:res1:enc1\nBAR=capy:res2:enc2';
      writeKeepCache(ORG, PROJ, hash, blob);
      expect(readKeepCache(ORG, PROJ, hash)).toBe(blob);
    });

    it('should return null for missing hash', () => {
      expect(readKeepCache(ORG, PROJ, 'nonexistent_hash')).toBeNull();
    });

    it('should isolate cache entries across orgs with the same hash', () => {
      const hash = 'shared_hash';
      writeKeepCache('org_a', PROJ, hash, 'ORG_A_BLOB');
      writeKeepCache('org_b', PROJ, hash, 'ORG_B_BLOB');
      expect(readKeepCache('org_a', PROJ, hash)).toBe('ORG_A_BLOB');
      expect(readKeepCache('org_b', PROJ, hash)).toBe('ORG_B_BLOB');
    });

    it('should isolate cache entries across projects in the same org', () => {
      const hash = 'shared_hash';
      writeKeepCache(ORG, 'proj_a', hash, 'PROJ_A_BLOB');
      writeKeepCache(ORG, 'proj_b', hash, 'PROJ_B_BLOB');
      expect(readKeepCache(ORG, 'proj_a', hash)).toBe('PROJ_A_BLOB');
      expect(readKeepCache(ORG, 'proj_b', hash)).toBe('PROJ_B_BLOB');
    });

    it('should create file with 0o600 permissions', () => {
      const hash = 'perm_test_hash';
      writeKeepCache(ORG, PROJ, hash, 'DATA');
      const { statSync } = require('fs');
      const filePath = join(tempHome, '.capy', 'keep', ORG, PROJ, hash);
      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('fetchSecretsWithCache', () => {
    const ORG = 'org_1';
    const PROJ = 'proj_1';

    it('should return cached value without calling service', async () => {
      const hash = 'cached_hash';
      const blob = 'SECRET=capy:res:enc';
      writeKeepCache(ORG, PROJ, hash, blob);

      let called = false;
      const mockClient = {
        getSecrets: async () => { called = true; return { env_file: 'from-server' }; },
      };

      const result = await fetchSecretsWithCache(mockClient, ORG, PROJ, hash);
      expect(result).toEqual({ env_file: blob });
      expect(called).toBe(false);
    });

    it('should fetch from service on cache miss and write through', async () => {
      const hash = 'miss_hash';
      const serverBlob = 'KEY=capy:res:serverenc';
      const mockClient = {
        getSecrets: async () => ({ env_file: serverBlob }),
      };

      const result = await fetchSecretsWithCache(mockClient, ORG, PROJ, hash);
      expect(result).toEqual({ env_file: serverBlob });
      expect(readKeepCache(ORG, PROJ, hash)).toBe(serverBlob);
    });

    it('should not return another org\'s cached blob for the same hash', async () => {
      const hash = 'shared_hash';
      writeKeepCache('other_org', PROJ, hash, 'OTHER_ORG_BLOB');

      const serverBlob = 'OWN_SERVER_BLOB';
      const mockClient = {
        getSecrets: async () => ({ env_file: serverBlob }),
      };

      const result = await fetchSecretsWithCache(mockClient, ORG, PROJ, hash);
      expect(result).toEqual({ env_file: serverBlob });
      expect(readKeepCache(ORG, PROJ, hash)).toBe(serverBlob);
      expect(readKeepCache('other_org', PROJ, hash)).toBe('OTHER_ORG_BLOB');
    });

    it('should return null when service returns null', async () => {
      const hash = 'null_hash';
      const mockClient = {
        getSecrets: async () => null,
      };

      const result = await fetchSecretsWithCache(mockClient, ORG, PROJ, hash);
      expect(result).toBeNull();
      expect(readKeepCache(ORG, PROJ, hash)).toBeNull();
    });
  });

  describe('force-login marker', () => {
    it('returns false when no marker exists', () => {
      // sanity: marker should not exist at start of this describe block
      const { existsSync: realExists } = require('fs');
      if (realExists(getForceLoginMarkerPath())) {
        require('fs').rmSync(getForceLoginMarkerPath(), { force: true });
      }
      expect(consumeForceLoginMarker()).toBe(false);
    });

    it('round-trip: set then consume returns true exactly once', () => {
      setForceLoginMarker();
      expect(existsSync(getForceLoginMarkerPath())).toBe(true);

      // First consume returns true and deletes the marker
      expect(consumeForceLoginMarker()).toBe(true);
      expect(existsSync(getForceLoginMarkerPath())).toBe(false);

      // Second consume returns false — no spurious "force login" on a later run
      expect(consumeForceLoginMarker()).toBe(false);
    });

    it('writes marker with 0o600 permissions', () => {
      setForceLoginMarker();
      const { statSync } = require('fs');
      const stat = statSync(getForceLoginMarkerPath());
      expect(stat.mode & 0o777).toBe(0o600);
      consumeForceLoginMarker();
    });
  });

  describe('device-key enrollment nudge marker (final-gate MAJOR-5)', () => {
    it('returns false when no marker exists', () => {
      const { existsSync: realExists, rmSync } = require('fs');
      if (realExists(getDeviceKeyNudgeDeclinedMarkerPath())) {
        rmSync(getDeviceKeyNudgeDeclinedMarkerPath(), { force: true });
      }
      expect(hasDeclinedDeviceKeyNudge()).toBe(false);
    });

    it('setDeviceKeyNudgeDeclined persists — hasDeclinedDeviceKeyNudge stays true (unlike the one-shot force-login marker, this is NOT consumed)', () => {
      setDeviceKeyNudgeDeclined();
      expect(existsSync(getDeviceKeyNudgeDeclinedMarkerPath())).toBe(true);
      expect(hasDeclinedDeviceKeyNudge()).toBe(true);
      // Checking again does not clear it — the whole point is "never ask twice".
      expect(hasDeclinedDeviceKeyNudge()).toBe(true);

      require('fs').rmSync(getDeviceKeyNudgeDeclinedMarkerPath(), { force: true });
    });

    it("lives under auth/, never under orgs/<orgId>/users/<userId>/ — CAP-383's equivalence test pins that directory to exactly key.enc + local.key", () => {
      expect(getDeviceKeyNudgeDeclinedMarkerPath()).toContain(`${require('path').sep}auth${require('path').sep}`);
      expect(getDeviceKeyNudgeDeclinedMarkerPath()).not.toContain(`${require('path').sep}orgs${require('path').sep}`);
    });

    it('writes marker with 0o600 permissions', () => {
      setDeviceKeyNudgeDeclined();
      const { statSync } = require('fs');
      const stat = statSync(getDeviceKeyNudgeDeclinedMarkerPath());
      expect(stat.mode & 0o777).toBe(0o600);
      require('fs').rmSync(getDeviceKeyNudgeDeclinedMarkerPath(), { force: true });
    });
  });

  describe('K_local root storage', () => {
    const ORG = 'org_root';
    const USER = 'user_root';

    it('lives beside key.enc in the per-user org directory', () => {
      expect(getLocalRootPath(ORG, USER)).toBe(
        join(tempHome, '.capy', 'orgs', ORG, 'users', USER, 'local.key'),
      );
      expect(getLocalRootPath(ORG)).toBe(
        join(tempHome, '.capy', 'orgs', ORG, 'local.key'),
      );
    });

    it('round-trips raw 32-byte roots', () => {
      const kLocal = require('crypto').randomBytes(32);
      expect(hasLocalRoot(ORG, USER)).toBe(false);
      expect(readLocalRoot(ORG, USER)).toBeNull();

      saveLocalRoot(ORG, kLocal, USER);
      expect(hasLocalRoot(ORG, USER)).toBe(true);
      expect(readLocalRoot(ORG, USER)!.equals(kLocal)).toBe(true);
    });

    it('writes local.key with 0o600 permissions', () => {
      const { statSync } = require('fs');
      const stat = statSync(getLocalRootPath(ORG, USER));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('scopes roots per org+user', () => {
      const other = require('crypto').randomBytes(32);
      saveLocalRoot(ORG, other, 'user_other');
      expect(readLocalRoot(ORG, 'user_other')!.equals(other)).toBe(true);
      expect(readLocalRoot(ORG, USER)!.equals(other)).toBe(false);
    });

    it('treats a corrupt local.key as absent (never a weak root)', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      const { dirname } = require('path');
      // Whitespace-only: decodes to 0 bytes — must NOT become a usable root
      const corruptPath = getLocalRootPath(ORG, 'user_corrupt');
      mkdirSync(dirname(corruptPath), { recursive: true, mode: 0o700 });
      writeFileSync(corruptPath, '  \n', { mode: 0o600 });
      expect(readLocalRoot(ORG, 'user_corrupt')).toBeNull();
      // Truncated: decodes to fewer than 32 bytes
      const shortPath = getLocalRootPath(ORG, 'user_short');
      mkdirSync(dirname(shortPath), { recursive: true, mode: 0o700 });
      writeFileSync(shortPath, require('crypto').randomBytes(8).toString('base64'), { mode: 0o600 });
      expect(readLocalRoot(ORG, 'user_short')).toBeNull();
    });

    it('exclusive save wins once, then refuses', () => {
      const a = require('crypto').randomBytes(32);
      const b = require('crypto').randomBytes(32);
      expect(saveLocalRootExclusive(ORG, a, 'user_excl')).toBe(true);
      expect(saveLocalRootExclusive(ORG, b, 'user_excl')).toBe(false);
      // The winner's root is what's on disk
      expect(readLocalRoot(ORG, 'user_excl')!.equals(a)).toBe(true);
    });
  });

  describe('key.enc sync-pending marker (gate-2 MAJOR-1: canonical identity)', () => {
    const ORG = 'org_sync';

    it('records the canonical org id + root fingerprint, and round-trips them', () => {
      const root = require('crypto').randomBytes(32);
      markKeyEncSyncPending(ORG, 'user_marker', 'canonical_org', root);
      expect(isKeyEncSyncPending(ORG, 'user_marker')).toBe(true);
      expect(readKeyEncSyncPendingMarker(ORG, 'user_marker')).toEqual({
        canonicalOrgId: 'canonical_org',
        canonicalRootSha256: rootFingerprint(root),
      });
      clearKeyEncSyncPending(ORG, 'user_marker');
      expect(isKeyEncSyncPending(ORG, 'user_marker')).toBe(false);
      expect(readKeyEncSyncPendingMarker(ORG, 'user_marker')).toBeNull();
    });

    it('treats a missing marker, an empty (pre-fix) marker, and unparseable content all as "no canonical recorded" — never as canonical', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      const { dirname } = require('path');

      expect(readKeyEncSyncPendingMarker(ORG, 'user_missing')).toBeNull();

      // Pre-fix format: an empty marker file. Still "pending" — just no
      // recorded identity — so callers must fall back, not skip it.
      const emptyPath = getKeyEncSyncPendingPath(ORG, 'user_legacy');
      mkdirSync(dirname(emptyPath), { recursive: true, mode: 0o700 });
      writeFileSync(emptyPath, '', { mode: 0o600 });
      expect(isKeyEncSyncPending(ORG, 'user_legacy')).toBe(true);
      expect(readKeyEncSyncPendingMarker(ORG, 'user_legacy')).toBeNull();

      // Corrupt/foreign JSON shape: also null, never thrown, never trusted.
      const corruptPath = getKeyEncSyncPendingPath(ORG, 'user_corrupt_marker');
      mkdirSync(dirname(corruptPath), { recursive: true, mode: 0o700 });
      writeFileSync(corruptPath, '{"not":"a marker"}', { mode: 0o600 });
      expect(readKeyEncSyncPendingMarker(ORG, 'user_corrupt_marker')).toBeNull();
    });

    it('two different canonical roots fingerprint differently (the sweep\'s drift check depends on this)', () => {
      const a = require('crypto').randomBytes(32);
      const b = require('crypto').randomBytes(32);
      expect(rootFingerprint(a)).not.toBe(rootFingerprint(b));
      expect(rootFingerprint(a)).toBe(rootFingerprint(Buffer.from(a)));
    });
  });
});
