import { mock, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-profile-cmd-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

let cmd: typeof import('../../src/commands/profileCommand');
let profileConfig: typeof import('../../src/config/profileConfig');

beforeEach(async () => {
  const capyDir = join(tempHome, '.capy');
  if (existsSync(capyDir)) rmSync(capyDir, { recursive: true, force: true });
  delete process.env.CAPY_API_URL;
  delete process.env.CAPY_PROFILE;

  cmd = await import('../../src/commands/profileCommand');
  profileConfig = await import('../../src/config/profileConfig');
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
  mock.restore();
});

describe('useCommand', () => {
  it('switches the active profile and returns 0', async () => {
    profileConfig.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
    profileConfig.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
    const code = await cmd.useCommand('cloud');
    expect(code).toBe(0);
    expect(profileConfig.readProfileConfig()?.default).toBe('cloud');
  });

  it('returns 1 on missing profile', async () => {
    profileConfig.saveAndActivateProfile('a', { url: 'https://x' });
    const code = await cmd.useCommand('nope');
    expect(code).toBe(1);
  });

  it('returns 1 when no config exists', async () => {
    const code = await cmd.useCommand('any');
    expect(code).toBe(1);
  });
});

describe('profileListCommand', () => {
  it('returns 0 with empty config', async () => {
    const code = await cmd.profileListCommand();
    expect(code).toBe(0);
  });

  it('returns 0 with profiles configured', async () => {
    profileConfig.saveAndActivateProfile('a', { url: 'https://x' });
    profileConfig.saveAndActivateProfile('b', { url: 'https://y' });
    const code = await cmd.profileListCommand();
    expect(code).toBe(0);
  });
});

describe('profileShowCommand', () => {
  it('returns 1 with no config', async () => {
    const code = await cmd.profileShowCommand();
    expect(code).toBe(1);
  });

  it('shows the active profile by default', async () => {
    profileConfig.saveAndActivateProfile('a', { url: 'https://x' });
    const code = await cmd.profileShowCommand();
    expect(code).toBe(0);
  });

  it('returns 1 on missing named profile', async () => {
    profileConfig.saveAndActivateProfile('a', { url: 'https://x' });
    const code = await cmd.profileShowCommand('nope');
    expect(code).toBe(1);
  });
});

describe('profileRemoveCommand', () => {
  it('removes a non-active profile', async () => {
    profileConfig.saveAndActivateProfile('cloud', { url: 'https://api.capy.sc' });
    profileConfig.saveAndActivateProfile('acme', { url: 'https://capy.acme.com' });
    profileConfig.setActiveProfile('cloud');
    const code = await cmd.profileRemoveCommand('acme');
    expect(code).toBe(0);
    expect(profileConfig.readProfileConfig()?.profiles.acme).toBeUndefined();
  });

  it('returns 1 when removing the active profile', async () => {
    profileConfig.saveAndActivateProfile('acme', { url: 'https://x' });
    const code = await cmd.profileRemoveCommand('acme');
    expect(code).toBe(1);
    expect(profileConfig.readProfileConfig()?.profiles.acme).toBeDefined();
  });

  it('returns 1 on missing profile', async () => {
    const code = await cmd.profileRemoveCommand('nope');
    expect(code).toBe(1);
  });
});
