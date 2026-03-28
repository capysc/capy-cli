import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock homedir to use a temp directory
const tempHome = mkdtempSync(join(tmpdir(), 'capy-test-'));
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tempHome,
}));

import {
  getGlobalCapyDir,
  getOrgKeyPath,
  getProjectKeyCachePath,
  saveMasterKey,
  readMasterKey,
  hasOrgKey,
  saveProjectKeyCache,
  readProjectKeyCache,
  saveAuthSession,
  readAuthSession,
} from '../../src/config/globalConfig';

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
