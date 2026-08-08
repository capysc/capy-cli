import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

// Mock homedir before any import that uses it (repo test convention).
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-synchook-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let keyResolver: typeof import('../../src/crypto/keyResolver');
let keyManager: typeof import('../../src/crypto/keyManager');
let gc: typeof import('../../src/config/globalConfig');

beforeAll(async () => {
  keyResolver = await import('../../src/crypto/keyResolver');
  keyManager = await import('../../src/crypto/keyManager');
  gc = await import('../../src/config/globalConfig');
});

const KMS_PREFIX = 'KMS1.';
const kms = () => ({
  coDecrypt: async (_o: string, ct: string) => {
    if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
    return ct.slice(KMS_PREFIX.length);
  },
  wrapOuterLayer: async (_o: string, pt: string) => KMS_PREFIX + pt,
});

/**
 * The CAP-380 sync-invariant seam: every key.enc (re)write inside
 * wrapAndSaveMasterKey fires the optional onKeyEncRewrapped hook — including
 * the transparent legacy migration — and steady-state call sites that don't
 * provide the hook are untouched.
 */
describe('KeyServiceOps.onKeyEncRewrapped', () => {
  it('fires after a fresh wrap, with the org and user', async () => {
    const calls: Array<[string, string]> = [];
    const ops = { ...kms(), onKeyEncRewrapped: (o: string, u: string) => calls.push([o, u]) };
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), 'orgH1', 'userH', ops);
    expect(calls).toEqual([['orgH1', 'userH']]);
    expect(gc.readMasterKey('orgH1', 'userH')).not.toBeNull();
  });

  it('fires during the transparent legacy→K_local migration inside unwrapMasterKey', async () => {
    const orgId = 'orgH2';
    const userId = 'userH';
    const masterKey = randomBytes(32);
    // A legacy single-wrapped blob (oldest format: no KMS outer, inner keyed
    // by SHA256(userId:orgId)) — exactly what the migration path targets.
    const legacyBlob = keyManager.encryptMasterKey(
      masterKey,
      keyManager.deriveWrappingKey(userId, orgId),
      keyManager.masterKeyAAD(userId, orgId),
    );
    gc.saveMasterKey(orgId, legacyBlob, userId);

    const calls: Array<[string, string]> = [];
    const ops = { ...kms(), onKeyEncRewrapped: (o: string, u: string) => calls.push([o, u]) };
    const resolved = await keyResolver.unwrapMasterKey(orgId, userId, ops);
    expect(resolved.equals(masterKey)).toBe(true);
    expect(calls).toEqual([[orgId, userId]]);
    // And the migration actually re-keyed the blob (KMS outer present now).
    expect(gc.readMasterKey(orgId, userId)!.startsWith(KMS_PREFIX)).toBe(true);
  });

  it('a throwing hook cannot disturb the wrap path', async () => {
    const ops = {
      ...kms(),
      onKeyEncRewrapped: () => {
        throw new Error('hook exploded');
      },
    };
    const masterKey = randomBytes(32);
    await keyResolver.wrapAndSaveMasterKey(masterKey, 'orgH3', 'userH', ops);
    expect(gc.readMasterKey('orgH3', 'userH')).not.toBeNull();
    const resolved = await keyResolver.unwrapMasterKey('orgH3', 'userH', kms());
    expect(resolved.equals(masterKey)).toBe(true);
  });

  it('ops without the hook behave exactly as before (steady state untouched)', async () => {
    const masterKey = randomBytes(32);
    await keyResolver.wrapAndSaveMasterKey(masterKey, 'orgH4', 'userH', kms());
    const resolved = await keyResolver.unwrapMasterKey('orgH4', 'userH', kms());
    expect(resolved.equals(masterKey)).toBe(true);
  });
});
