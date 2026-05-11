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
});
