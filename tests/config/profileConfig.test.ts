import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';

// Mock homedir to a temp dir BEFORE importing profileConfig — its
// getGlobalCapyDir() lookup hits homedir() lazily but caching is by module
// init, so we lock it down up front.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-profile-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

let mod: typeof import('../../src/config/profileConfig');

beforeEach(async () => {
  // Reset state between tests: wipe the config file, clear env overrides.
  const capyDir = join(tempHome, '.capy');
  if (existsSync(capyDir)) rmSync(capyDir, { recursive: true, force: true });
  delete process.env.CAPY_API_URL;
  delete process.env.CAPY_PROFILE;

  mod = await import('../../src/config/profileConfig');
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

describe('profileConfig', () => {
  describe('read/write round-trip', () => {
    it('returns null when no config exists', () => {
      expect(mod.readProfileConfig()).toBeNull();
    });

    it('round-trips a config', () => {
      const config = {
        default: 'acme',
        profiles: {
          acme: { url: 'https://capy.acme.com', caBundle: '/etc/ca.crt' },
          cloud: { url: 'https://api.capy.sc' },
        },
      };
      mod.writeProfileConfig(config);
      expect(mod.readProfileConfig()).toEqual(config);
    });

    it('writes with 0o600 permissions', () => {
      mod.writeProfileConfig({ default: 'a', profiles: { a: { url: 'https://x' } } });
      const path = join(tempHome, '.capy', 'config.json');
      const stat = statSync(path);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('returns null for malformed JSON instead of throwing', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      mkdirSync(join(tempHome, '.capy'), { recursive: true });
      writeFileSync(join(tempHome, '.capy', 'config.json'), '{not valid json');
      expect(mod.readProfileConfig()).toBeNull();
    });

    it('returns null when JSON is wrong shape', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      mkdirSync(join(tempHome, '.capy'), { recursive: true });
      writeFileSync(join(tempHome, '.capy', 'config.json'), '{"foo":"bar"}');
      expect(mod.readProfileConfig()).toBeNull();
    });
  });

  describe('resolveActiveUrl precedence', () => {
    it('falls back to cloud default when no config, no env', () => {
      expect(mod.resolveActiveUrl(false)).toBe(mod.DEFAULT_CLOUD_URL);
    });

    it('falls back to localhost in dev mode', () => {
      expect(mod.resolveActiveUrl(true)).toBe('http://localhost:3000');
    });

    it('CAPY_API_URL wins over everything', () => {
      mod.writeProfileConfig({ default: 'acme', profiles: { acme: { url: 'https://acme' } } });
      process.env.CAPY_API_URL = 'https://override';
      expect(mod.resolveActiveUrl(false)).toBe('https://override');
    });

    it('CAPY_PROFILE selects a named profile', () => {
      mod.writeProfileConfig({
        default: 'cloud',
        profiles: {
          cloud: { url: 'https://api.capy.sc' },
          acme: { url: 'https://capy.acme.com' },
        },
      });
      process.env.CAPY_PROFILE = 'acme';
      expect(mod.resolveActiveUrl(false)).toBe('https://capy.acme.com');
    });

    it('config.default is used when no env override', () => {
      mod.writeProfileConfig({
        default: 'acme',
        profiles: { acme: { url: 'https://capy.acme.com' } },
      });
      expect(mod.resolveActiveUrl(false)).toBe('https://capy.acme.com');
    });

    it('falls back to cloud when default points at missing profile (corrupt config)', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      mkdirSync(join(tempHome, '.capy'), { recursive: true });
      // default names a profile that doesn't exist in the map
      writeFileSync(
        join(tempHome, '.capy', 'config.json'),
        JSON.stringify({ default: 'missing', profiles: { other: { url: 'https://other' } } }),
      );
      expect(mod.resolveActiveUrl(false)).toBe(mod.DEFAULT_CLOUD_URL);
    });
  });

  describe('CAPY_PROFILE error', () => {
    it('throws when CAPY_PROFILE names a non-existent profile', () => {
      mod.writeProfileConfig({
        default: 'cloud',
        profiles: { cloud: { url: 'https://api.capy.sc' } },
      });
      process.env.CAPY_PROFILE = 'nope';
      expect(() => mod.getActiveProfile()).toThrow(/no such profile/);
    });

    it('throws when CAPY_PROFILE is set but no config exists', () => {
      process.env.CAPY_PROFILE = 'anything';
      expect(() => mod.getActiveProfile()).toThrow(/no such profile/);
    });
  });

  describe('resolveActiveCaBundle', () => {
    it('returns null when no profile', () => {
      expect(mod.resolveActiveCaBundle()).toBeNull();
    });

    it('returns null when profile has no caBundle', () => {
      mod.writeProfileConfig({ default: 'a', profiles: { a: { url: 'https://x' } } });
      expect(mod.resolveActiveCaBundle()).toBeNull();
    });

    it('returns the bundle path for the active profile', () => {
      mod.writeProfileConfig({
        default: 'a',
        profiles: { a: { url: 'https://x', caBundle: '/etc/ca.crt' } },
      });
      expect(mod.resolveActiveCaBundle()).toBe('/etc/ca.crt');
    });

    it('expands ~/ in caBundle paths', () => {
      mod.writeProfileConfig({
        default: 'a',
        profiles: { a: { url: 'https://x', caBundle: '~/byoc/ca.crt' } },
      });
      expect(mod.resolveActiveCaBundle()).toBe(join(tempHome, 'byoc/ca.crt'));
    });

    it('returns null when CAPY_API_URL overrides everything', () => {
      mod.writeProfileConfig({
        default: 'a',
        profiles: { a: { url: 'https://x', caBundle: '/etc/ca.crt' } },
      });
      process.env.CAPY_API_URL = 'https://override';
      expect(mod.resolveActiveCaBundle()).toBeNull();
    });
  });

  describe('saveAndActivateProfile', () => {
    it('creates config on first call', () => {
      mod.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
      const config = mod.readProfileConfig();
      expect(config?.default).toBe('acme');
      expect(config?.profiles.acme.url).toBe('https://capy.acme.com');
    });

    it('preserves existing profiles when adding a new one', () => {
      mod.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
      mod.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
      const config = mod.readProfileConfig();
      expect(Object.keys(config!.profiles).sort()).toEqual(['acme', 'cloud']);
      expect(config?.default).toBe('acme');
    });

    it('overwrites a profile with the same name', () => {
      mod.saveAndActivateProfile('acme', { url: 'https://old' });
      mod.saveAndActivateProfile('acme', { url: 'https://new' });
      expect(mod.readProfileConfig()?.profiles.acme.url).toBe('https://new');
    });
  });

  describe('setActiveProfile', () => {
    it('switches the default', () => {
      mod.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
      mod.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
      // saveAndActivateProfile leaves "acme" as default; switch back
      mod.setActiveProfile('cloud');
      expect(mod.readProfileConfig()?.default).toBe('cloud');
    });

    it('throws on missing config', () => {
      expect(() => mod.setActiveProfile('any')).toThrow(/No profiles configured/);
    });

    it('throws on missing profile', () => {
      mod.saveAndActivateProfile('a', { url: 'https://x' });
      expect(() => mod.setActiveProfile('b')).toThrow(/does not exist/);
    });
  });

  describe('removeProfile', () => {
    it('removes a non-active profile', () => {
      mod.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
      mod.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
      mod.setActiveProfile('cloud');
      mod.removeProfile('acme');
      const config = mod.readProfileConfig();
      expect(config?.profiles.acme).toBeUndefined();
      expect(config?.profiles.cloud).toBeDefined();
    });

    it('refuses to remove the active profile', () => {
      mod.saveAndActivateProfile('acme', { url: 'https://x' });
      expect(() => mod.removeProfile('acme')).toThrow(/Cannot remove the active/);
    });

    it('throws on missing profile', () => {
      expect(() => mod.removeProfile('nope')).toThrow(/does not exist/);
    });
  });

  describe('listProfiles', () => {
    it('returns empty array when no config', () => {
      expect(mod.listProfiles()).toEqual([]);
    });

    it('marks the active profile', () => {
      mod.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
      mod.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
      const list = mod.listProfiles();
      expect(list).toHaveLength(2);
      const acme = list.find((p) => p.name === 'acme');
      const cloud = list.find((p) => p.name === 'cloud');
      expect(acme?.active).toBe(true);
      expect(cloud?.active).toBe(false);
    });
  });

  describe('deriveProfileName', () => {
    it('strips the capy. prefix', () => {
      expect(mod.deriveProfileName('https://capy.acme.com')).toBe('acme');
    });

    it('strips capy. and returns first label', () => {
      expect(mod.deriveProfileName('https://capy.internal')).toBe('internal');
    });

    it('uses the leftmost label otherwise', () => {
      expect(mod.deriveProfileName('https://secrets.acme.com')).toBe('secrets');
    });

    it('falls back on bare hosts', () => {
      expect(mod.deriveProfileName('https://localhost')).toBe('localhost');
    });

    it('falls back on garbage input', () => {
      expect(mod.deriveProfileName('not-a-url')).toBe('byoc');
    });
  });
});
