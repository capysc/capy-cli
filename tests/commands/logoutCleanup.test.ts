import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

// Mock homedir to use a temp directory — must come before any import that uses os.homedir()
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-logout-test-'));
// Run in a temp cwd so the .capy/token sweep can't touch the repo's own .capy/
const tempCwd = mkdtempSync(join(require('os').tmpdir(), 'capy-logout-cwd-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => { mock.restore(); });

let performLogoutCleanup: typeof import('../../src/commands/logoutCommand').performLogoutCleanup;
let saveMasterKey: typeof import('../../src/config/globalConfig').saveMasterKey;
let readMasterKey: typeof import('../../src/config/globalConfig').readMasterKey;
let hasOrgKey: typeof import('../../src/config/globalConfig').hasOrgKey;
let saveLocalRoot: typeof import('../../src/config/globalConfig').saveLocalRoot;
let readLocalRoot: typeof import('../../src/config/globalConfig').readLocalRoot;
let hasLocalRoot: typeof import('../../src/config/globalConfig').hasLocalRoot;
let saveAuthSession: typeof import('../../src/config/globalConfig').saveAuthSession;
let readAuthSession: typeof import('../../src/config/globalConfig').readAuthSession;
let saveProjectKeyCache: typeof import('../../src/config/globalConfig').saveProjectKeyCache;
let readProjectKeyCache: typeof import('../../src/config/globalConfig').readProjectKeyCache;

const origCwd = process.cwd();

beforeAll(async () => {
  process.chdir(tempCwd);

  const gc = await import('../../src/config/globalConfig');
  saveMasterKey = gc.saveMasterKey;
  readMasterKey = gc.readMasterKey;
  hasOrgKey = gc.hasOrgKey;
  saveLocalRoot = gc.saveLocalRoot;
  readLocalRoot = gc.readLocalRoot;
  hasLocalRoot = gc.hasLocalRoot;
  saveAuthSession = gc.saveAuthSession;
  readAuthSession = gc.readAuthSession;
  saveProjectKeyCache = gc.saveProjectKeyCache;
  readProjectKeyCache = gc.readProjectKeyCache;

  const lc = await import('../../src/commands/logoutCommand');
  performLogoutCleanup = lc.performLogoutCleanup;
});

afterAll(() => {
  process.chdir(origCwd);
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('performLogoutCleanup', () => {
  it('clears session state but preserves key.enc and local.key', async () => {
    const orgId = 'org_logout';
    const userId = 'user_logout';
    const kLocal = randomBytes(32);

    // Recovery-equivalent state — must survive logout
    saveMasterKey(orgId, 'wrapped-master-key-blob', userId);
    saveLocalRoot(orgId, kLocal, userId);

    // Session/cache state — must be cleared
    saveAuthSession({ token: 'global' });
    saveAuthSession({ token: 'per-user' }, userId);
    saveProjectKeyCache(orgId, 'proj_1', 'deadbeef');
    mkdirSync(join(tempCwd, '.capy'), { recursive: true });
    writeFileSync(join(tempCwd, '.capy', 'token'), 'cwd-session-token');

    const cleared = await performLogoutCleanup();
    expect(cleared).toBe(true);

    // Session state gone
    expect(readAuthSession()).toBeNull();
    expect(readAuthSession(userId)).toBeNull();
    expect(readProjectKeyCache(orgId, 'proj_1')).toBeNull();
    expect(existsSync(join(tempCwd, '.capy', 'token'))).toBe(false);

    // Recovery-equivalent state intact: the wrapped master key AND the
    // machine-local root that keys its inner layer. Losing local.key would
    // orphan key.enc and force a re-invite.
    expect(hasOrgKey(orgId, userId)).toBe(true);
    expect(readMasterKey(orgId, userId)).toBe('wrapped-master-key-blob');
    expect(hasLocalRoot(orgId, userId)).toBe(true);
    expect(readLocalRoot(orgId, userId)!.equals(kLocal)).toBe(true);
  });

  it('reports nothing to clear on a second run, still preserving keys', async () => {
    const cleared = await performLogoutCleanup();
    expect(cleared).toBe(false);
    expect(hasOrgKey('org_logout', 'user_logout')).toBe(true);
    expect(hasLocalRoot('org_logout', 'user_logout')).toBe(true);
  });
});
