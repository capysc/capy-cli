import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { CapyError } from '../../src/types/index';

// Mock homedir to a temp dir BEFORE importing anything that reads os.homedir().
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-local-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let km: typeof import('../../src/crypto/keyManager');
let kr: typeof import('../../src/crypto/keyResolver');
let gc: typeof import('../../src/config/globalConfig');

beforeAll(async () => {
  km = await import('../../src/crypto/keyManager');
  kr = await import('../../src/crypto/keyResolver');
  gc = await import('../../src/config/globalConfig');
});

describe('local-only keystore', () => {
  it('round-trips M through saveLocalKey + decryptLocalMasterKeyHex', () => {
    const realPhrase = km.generateSeedPhrase();
    const M = km.seedPhraseToMasterKey(realPhrase);

    expect(gc.hasLocalKey()).toBe(false);
    kr.saveLocalKey(M, 'correct horse battery');
    expect(gc.hasLocalKey()).toBe(true);

    const hex = kr.decryptLocalMasterKeyHex('correct horse battery');
    expect(hex).toBe(M.toString('hex'));
  });

  it('rejects a wrong passphrase with a clean error', () => {
    const M = km.seedPhraseToMasterKey(km.generateSeedPhrase());
    kr.saveLocalKey(M, 'right-passphrase');

    let err: unknown;
    try {
      kr.decryptLocalMasterKeyHex('wrong-passphrase');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CapyError);
    expect((err as CapyError).message).toContain('Incorrect passphrase');
  });

  it('records the passphrase wrapping method + iterations', () => {
    const M = km.seedPhraseToMasterKey(km.generateSeedPhrase());
    kr.saveLocalKey(M, 'pw');
    const rec = gc.readLocalKeyRecord();
    expect(rec?.wrapping_method).toBe('passphrase');
    expect(rec?.iterations).toBe(km.LOCAL_KEY_ITERATIONS);
    expect(typeof rec?.salt).toBe('string');
  });

  it('derives the same project key as the seed-phrase path with org pinned to local', () => {
    const M = km.seedPhraseToMasterKey(km.generateSeedPhrase());
    const hex = M.toString('hex');
    const viaLocal = kr.resolveFromLocalKey(hex, 'proj-123');
    const viaDerive = km.deriveProjectKey(M, 'proj-123', gc.LOCAL_ORG_ID);
    expect(viaLocal).toBe(viaDerive);
  });

  it('produces distinct keys for distinct projects', () => {
    const M = km.seedPhraseToMasterKey(km.generateSeedPhrase());
    const hex = M.toString('hex');
    expect(kr.resolveFromLocalKey(hex, 'a')).not.toBe(kr.resolveFromLocalKey(hex, 'b'));
  });
});

describe('local-only session (idle auto-lock)', () => {
  const HOUR = 60 * 60 * 1000;

  it('round-trips and respects an unexpired window', () => {
    gc.saveLocalSession('deadbeef');
    expect(gc.isLocalUnlocked(HOUR)).toBe(true);
    expect(gc.readLocalSession(HOUR)).toBe('deadbeef');
  });

  it('treats an idle-expired session as locked and clears it', () => {
    gc.saveLocalSession('cafef00d');
    // A negative timeout forces "now - last_used_at > timeout" to be true.
    expect(gc.isLocalUnlocked(-1)).toBe(false);
    // Cleared as a side effect — a subsequent generous check is still locked.
    expect(gc.isLocalUnlocked(HOUR)).toBe(false);
  });

  it('clearLocalSession locks immediately', () => {
    gc.saveLocalSession('abc123');
    expect(gc.isLocalUnlocked(HOUR)).toBe(true);
    gc.clearLocalSession();
    expect(gc.isLocalUnlocked(HOUR)).toBe(false);
    expect(gc.readLocalSession(HOUR)).toBeNull();
  });
});
