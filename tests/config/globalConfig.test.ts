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
});
