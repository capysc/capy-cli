/**
 * CAP-384 — grantResolver.ts proven crypto-equivalent to keyResolver.ts's
 * steady-state K_local branch, without importing or mutating keyResolver.ts
 * at all (grep-verified below) and without touching disk.
 *
 * No mock.module, no globalConfig import in the module under test or this
 * file — not registered in ISOLATED_FILES.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { resolveProjectKeyFromGrant, createGrantResolutionOps, type GrantResolutionOps } from '../../../src/auth/deviceKey/grantResolver';
import { encryptMasterKey, masterKeyAAD, deriveProjectKey } from '../../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { CapyError, ERROR_CODES } from '../../../src/types/index';

const USER = 'user-grant-resolve-1';
const ORG = 'org-grant-resolve-1';
const PROJECT = 'proj-grant-resolve-1';

// Same fake KMS shape used across the device-key test suite.
const KMS_PREFIX = 'KMS1.';
const kmsWrap = (plaintext: string) => KMS_PREFIX + plaintext;
const kmsStrip = (ct: string) => {
  if (!ct.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
  return ct.slice(KMS_PREFIX.length);
};

describe('grantResolver.ts does not import keyResolver.ts', () => {
  it('source has zero IMPORT statements naming crypto/keyResolver or config/globalConfig — a structural, not just behavioral, proof of invariant 4 (prose mentions in comments are fine and expected)', () => {
    const src = readFileSync(join(import.meta.dir, '../../../src/auth/deviceKey/grantResolver.ts'), 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines.some((l) => l.includes('keyResolver'))).toBe(false);
    expect(importLines.some((l) => l.includes('globalConfig'))).toBe(false);
  });
});

describe('resolveProjectKeyFromGrant', () => {
  it('produces the IDENTICAL project key as the disk-based steady-state path, given the same K_local and key.enc', async () => {
    const kLocal = randomBytes(32);
    const masterKey = randomBytes(32);

    // Build key.enc exactly as wrapAndSaveMasterKey would: inner AES-GCM
    // under HKDF(K_local), AAD bound to (user, org), then a KMS outer layer.
    const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER, ORG));
    const keyEnc = kmsWrap(innerWrapped);

    const ops: GrantResolutionOps = {
      fetchKeyEnc: async (orgId) => {
        expect(orgId).toBe(ORG);
        return keyEnc;
      },
      coDecrypt: async (orgId, ciphertext) => {
        expect(orgId).toBe(ORG);
        return kmsStrip(ciphertext);
      },
    };

    const fromGrant = await resolveProjectKeyFromGrant(kLocal, ORG, PROJECT, USER, ops);
    const expected = deriveProjectKey(masterKey, PROJECT, ORG);

    expect(fromGrant).toBe(expected);
  });

  it('a wrong K_local fails the AEAD unwrap closed with a coded error, never a garbage key', async () => {
    const kLocal = randomBytes(32);
    const wrongKLocal = randomBytes(32);
    const masterKey = randomBytes(32);
    const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER, ORG));
    const keyEnc = kmsWrap(innerWrapped);

    const ops: GrantResolutionOps = {
      fetchKeyEnc: async () => keyEnc,
      coDecrypt: async (_orgId, ciphertext) => kmsStrip(ciphertext),
    };

    await expect(resolveProjectKeyFromGrant(wrongKLocal, ORG, PROJECT, USER, ops)).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED,
    });
  });

  it('a network failure fetching key.enc surfaces as coded PERMISSION_DENIED', async () => {
    const kLocal = randomBytes(32);
    const ops: GrantResolutionOps = {
      fetchKeyEnc: async () => {
        throw new Error('ECONNREFUSED');
      },
      coDecrypt: async (_orgId, ct) => ct,
    };

    await expect(resolveProjectKeyFromGrant(kLocal, ORG, PROJECT, USER, ops)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });
  });
});

describe('createGrantResolutionOps', () => {
  it('org-pins via authenticateSilent before each network call, and finds the live key_enc row for the org', async () => {
    const calls: string[] = [];
    const fakeAuth = {
      authenticateSilent: async (orgId: string) => {
        calls.push(`pin:${orgId}`);
        return { success: true };
      },
      refreshToken: async () => true,
    } as any;
    const fakeServiceClient = {
      listWrappers: async () => {
        calls.push('list');
        return [
          { id: 'wrapper-other-org', type: 'key_enc', organization_id: 'org-other', deleted_at: null },
          { id: 'wrapper-target', type: 'key_enc', organization_id: ORG, deleted_at: null },
          { id: 'wrapper-deleted', type: 'key_enc', organization_id: ORG, deleted_at: new Date().toISOString() },
        ];
      },
      fetchWrapper: async (id: string) => {
        calls.push(`fetch:${id}`);
        expect(id).toBe('wrapper-target');
        return { id, type: 'key_enc', key_enc: 'the-blob' };
      },
      coDecrypt: async (orgId: string, ciphertext: string) => {
        calls.push(`codecrypt:${orgId}`);
        return { plaintext: `stripped:${ciphertext}` };
      },
    } as any;

    const ops = createGrantResolutionOps(fakeServiceClient, fakeAuth);
    const blob = await ops.fetchKeyEnc(ORG);
    expect(blob).toBe('the-blob');
    const stripped = await ops.coDecrypt(ORG, 'ct');
    expect(stripped).toBe('stripped:ct');

    expect(calls).toEqual(['pin:org-grant-resolve-1', 'list', 'fetch:wrapper-target', 'pin:org-grant-resolve-1', 'codecrypt:org-grant-resolve-1']);
  });

  it('retries the wrapper listing/fetch once on the coded fresh-auth 403, per the CAP-379 contract', async () => {
    const freshAuth403 = () =>
      new CapyError('token too old', ERROR_CODES.PERMISSION_DENIED, {
        status: 403,
        code: ERROR_CODES.FRESH_AUTH_REQUIRED,
        data: { code: ERROR_CODES.FRESH_AUTH_REQUIRED, remediation: 'refresh_and_retry', max_token_age_seconds: 300 },
      });
    let listCalls = 0;
    let refreshCalls = 0;
    const fakeAuth = {
      authenticateSilent: async () => ({ success: true }),
      refreshToken: async () => {
        refreshCalls++;
        return true;
      },
    } as any;
    const fakeServiceClient = {
      listWrappers: async () => {
        listCalls++;
        if (listCalls === 1) throw freshAuth403();
        return [{ id: 'w1', type: 'key_enc', organization_id: ORG, deleted_at: null }];
      },
      fetchWrapper: async (id: string) => ({ id, type: 'key_enc', key_enc: 'ok' }),
    } as any;

    const ops = createGrantResolutionOps(fakeServiceClient, fakeAuth);
    const blob = await ops.fetchKeyEnc(ORG);
    expect(blob).toBe('ok');
    expect(listCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('throws WRAPPER_NOT_FOUND when the org has no live key_enc row', async () => {
    const fakeAuth = { authenticateSilent: async () => ({ success: true }), refreshToken: async () => true } as any;
    const fakeServiceClient = {
      listWrappers: async () => [],
      fetchWrapper: async () => {
        throw new Error('should not be called');
      },
    } as any;
    const ops = createGrantResolutionOps(fakeServiceClient, fakeAuth);
    await expect(ops.fetchKeyEnc(ORG)).rejects.toMatchObject({ code: ERROR_CODES.WRAPPER_NOT_FOUND });
  });
});
