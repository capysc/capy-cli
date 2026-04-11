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
    it('should round-trip write and read', () => {
      const hash = 'abc123def456';
      const blob = 'FOO=capy:res1:enc1\nBAR=capy:res2:enc2';
      writeKeepCache(hash, blob);
      expect(readKeepCache(hash)).toBe(blob);
    });

    it('should return null for missing hash', () => {
      expect(readKeepCache('nonexistent_hash')).toBeNull();
    });

    it('should create file with 0o600 permissions', () => {
      const hash = 'perm_test_hash';
      writeKeepCache(hash, 'DATA');
      const { statSync } = require('fs');
      const filePath = join(tempHome, '.capy', 'keep', hash);
      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('fetchSecretsWithCache', () => {
    it('should return cached value without calling service', async () => {
      const hash = 'cached_hash';
      const blob = 'SECRET=capy:res:enc';
      writeKeepCache(hash, blob);

      let called = false;
      const mockClient = {
        getSecrets: async () => { called = true; return { env_file: 'from-server' }; },
      };

      const result = await fetchSecretsWithCache(mockClient, 'proj_1', hash);
      expect(result).toEqual({ env_file: blob });
      expect(called).toBe(false);
    });

    it('should fetch from service on cache miss and write through', async () => {
      const hash = 'miss_hash';
      const serverBlob = 'KEY=capy:res:serverenc';
      const mockClient = {
        getSecrets: async () => ({ env_file: serverBlob }),
      };

      const result = await fetchSecretsWithCache(mockClient, 'proj_1', hash);
      expect(result).toEqual({ env_file: serverBlob });
      expect(readKeepCache(hash)).toBe(serverBlob);
    });

    it('should return null when service returns null', async () => {
      const hash = 'null_hash';
      const mockClient = {
        getSecrets: async () => null,
      };

      const result = await fetchSecretsWithCache(mockClient, 'proj_1', hash);
      expect(result).toBeNull();
      expect(readKeepCache(hash)).toBeNull();
    });
  });
});
