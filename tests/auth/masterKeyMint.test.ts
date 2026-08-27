/**
 * `src/auth/masterKeyMint.ts` — the CLI half of the master-key first-mint
 * fix for auto-provisioned personal orgs (created server-side with no key at
 * all; see the module's own docblock). Covers, in order:
 *
 *  - `mintMasterKeyForOrg`'s ceremony ordering: claim BEFORE the phrase is
 *    ever shown, local save (wrapAndSaveMasterKey) BEFORE finalize, and that
 *    a claim refusal (ALREADY_MINTED / IN_PROGRESS) stops everything before
 *    a phrase is generated or shown.
 *  - `isNoKeyOnDeviceError`'s structural signal (never message text — Rule 4).
 *  - `mintThenRetryOnNoKey` / `shouldAttemptMint`'s gating: known-minted skip,
 *    non-interactive skip, and "any mint refusal rethrows the ORIGINAL error,
 *    never the mint's own".
 *  - `resolveProjectKeyWithMintFallback`'s pass-through-on-success and
 *    fallback-on-no-key-error behavior.
 *
 * `keyManager` and `keyResolver` are mocked so no real PBKDF2/disk I/O runs
 * in a unit test — the lock-less `resolveContext` INTEGRATION (this module
 * wired into a real temp directory) lives in
 * tests/commands/connectors/locklessMintFallback.test.ts instead.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { mock, describe, test, expect, beforeEach } from 'bun:test';

const calls: string[] = [];
let wrapErr: Error | null = null;

mock.module(require('path').join(import.meta.dir, '../../src/crypto/keyManager.ts'), () => ({
  generateSeedPhrase: () => {
    calls.push('generateSeedPhrase');
    return 'test seed phrase not a real bip39 mnemonic at all here';
  },
  seedPhraseToMasterKey: () => {
    calls.push('seedPhraseToMasterKey');
    return Buffer.alloc(32, 7);
  },
  CURRENT_KDF_VERSION: 2,
}));

mock.module(require('path').join(import.meta.dir, '../../src/crypto/keyResolver.ts'), () => ({
  wrapAndSaveMasterKey: mock(async () => {
    calls.push('wrapAndSaveMasterKey');
    if (wrapErr) throw wrapErr;
  }),
  resolveProjectKey: mock(async () => {
    calls.push('resolveProjectKey');
    const next = resolveProjectKeyQueue.shift();
    if (!next) throw new Error('resolveProjectKey called with nothing queued');
    return next();
  }),
}));

mock.module(require('path').join(import.meta.dir, '../../src/ui/recoveryPhrase.ts'), () => ({
  displayAndConfirmRecoveryPhrase: mock(async () => {
    calls.push('displayAndConfirmRecoveryPhrase');
  }),
}));

let interactive = true;
mock.module(require('path').join(import.meta.dir, '../../src/ui/interactive.ts'), () => ({
  isInteractive: () => interactive,
}));

// Partial mock: only getOrgKeyPath is overridden (points at a per-test temp
// file) so the finalize-race discard can be asserted; everything else is the
// real module.
const realGlobalConfig = require('../../src/config/globalConfig');
let orgKeyPathForTest = '';
mock.module(require('path').join(import.meta.dir, '../../src/config/globalConfig.ts'), () => ({
  ...realGlobalConfig,
  getOrgKeyPath: (orgId: string, userId?: string) => {
    calls.push(`getOrgKeyPath:${orgId}:${userId}`);
    return orgKeyPathForTest || realGlobalConfig.getOrgKeyPath(orgId, userId);
  },
}));

import { writeFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mintMasterKeyForOrg,
  isNoKeyOnDeviceError,
  mintThenRetryOnNoKey,
  shouldAttemptMint,
  resolveProjectKeyWithMintFallback,
} from '../../src/auth/masterKeyMint';
import { CapyError, ERROR_CODES } from '../../src/types/index';

let resolveProjectKeyQueue: Array<() => Promise<string>> = [];

function fakeServiceClient(overrides: { claim?: () => any; finalize?: () => any } = {}): any {
  return {
    claimKeyMint: mock(async (_orgId: string) => {
      calls.push('claimKeyMint');
      if (overrides.claim) return overrides.claim();
      return { key_state: 'minting', expires_at: '2099-01-01T00:00:00Z' };
    }),
    finalizeKeyMint: mock(async (_orgId: string) => {
      calls.push('finalizeKeyMint');
      if (overrides.finalize) return overrides.finalize();
      return { key_state: 'minted' };
    }),
  };
}

const keyServiceOps = {
  coDecrypt: async () => '',
  wrapOuterLayer: async () => '',
};

beforeEach(() => {
  calls.length = 0;
  wrapErr = null;
  interactive = true;
  resolveProjectKeyQueue = [];
  orgKeyPathForTest = '';
});

describe('mintMasterKeyForOrg', () => {
  test('happy path: claim before phrase, local save before finalize', async () => {
    const serviceClient = fakeServiceClient();
    await mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps });

    expect(calls).toEqual([
      'claimKeyMint',
      'generateSeedPhrase',
      'displayAndConfirmRecoveryPhrase',
      // The pre-save re-claim: the phrase confirm waits on a human and can
      // outlast the lease, so the lease is revalidated (own re-claim extends
      // it) immediately before anything touches disk.
      'claimKeyMint',
      'seedPhraseToMasterKey',
      'wrapAndSaveMasterKey',
      'finalizeKeyMint',
    ]);
  });

  test('re-claim after the phrase confirm refuses: NOTHING is saved, the claim error propagates', async () => {
    const lost = new CapyError('mid-mint elsewhere', ERROR_CODES.KEY_MINT_IN_PROGRESS, { status: 409 });
    const claimResults: Array<() => any> = [() => undefined, () => { throw lost; }];
    const serviceClient = fakeServiceClient({ claim: () => claimResults.shift()!() });

    await expect(
      mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps }),
    ).rejects.toBe(lost);
    expect(calls).toContain('displayAndConfirmRecoveryPhrase');
    expect(calls).not.toContain('wrapAndSaveMasterKey');
    expect(calls).not.toContain('finalizeKeyMint');
  });

  test('finalize KEY_MINT_NOT_CLAIMED (lost the sub-second race): local key material is discarded and the coded error thrown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-mint-test-'));
    orgKeyPathForTest = join(dir, 'key.enc');
    writeFileSync(orgKeyPathForTest, 'fake-key-material');
    const serviceClient = fakeServiceClient({
      finalize: () => { throw new CapyError('not claimed', ERROR_CODES.KEY_MINT_NOT_CLAIMED, { status: 409 }); },
    });

    const thrown = await mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps })
      .then(() => undefined, (e) => e);
    expect(thrown).toBeInstanceOf(CapyError);
    expect((thrown as CapyError).code).toBe(ERROR_CODES.KEY_MINT_NOT_CLAIMED);
    // The losing side's key.enc is gone — keeping it would poison every
    // later decrypt AND encrypt with a master key the org never converged on.
    expect(existsSync(orgKeyPathForTest)).toBe(false);
  });

  test('claim KEY_ALREADY_MINTED propagates unmodified; nothing else runs (no phrase generated or shown)', async () => {
    const err = new CapyError('already minted', ERROR_CODES.KEY_ALREADY_MINTED, { status: 409 });
    const serviceClient = fakeServiceClient({ claim: () => { throw err; } });

    await expect(
      mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps }),
    ).rejects.toBe(err);
    expect(calls).toEqual(['claimKeyMint']);
  });

  test('claim KEY_MINT_IN_PROGRESS propagates unmodified; no phrase shown', async () => {
    const err = new CapyError('another device is mid-mint', ERROR_CODES.KEY_MINT_IN_PROGRESS, {
      status: 409,
      expires_at: '2030-01-01T00:00:00Z',
    });
    const serviceClient = fakeServiceClient({ claim: () => { throw err; } });

    await expect(
      mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps }),
    ).rejects.toBe(err);
    expect(calls).toEqual(['claimKeyMint']);
    expect(calls).not.toContain('displayAndConfirmRecoveryPhrase');
  });

  test('finalize failure after a successful local save is not fatal — mint still resolves', async () => {
    const serviceClient = fakeServiceClient({
      finalize: () => { throw new CapyError('boom', ERROR_CODES.SERVICE_ERROR); },
    });

    await expect(
      mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps }),
    ).resolves.toBeUndefined();
    expect(calls).toContain('wrapAndSaveMasterKey');
    expect(calls).toContain('finalizeKeyMint');
  });

  test('finalize NETWORK_ERROR is retried exactly once, then swallowed', async () => {
    let finalizeAttempts = 0;
    const serviceClient = fakeServiceClient({
      finalize: () => {
        finalizeAttempts += 1;
        throw new CapyError('net blip', ERROR_CODES.NETWORK_ERROR);
      },
    });

    await mintMasterKeyForOrg({ orgId: 'org-1', userId: 'user-1', serviceClient, keyServiceOps });
    expect(finalizeAttempts).toBe(2);
  });
});

describe('isNoKeyOnDeviceError', () => {
  test('KEY_NOT_ON_DEVICE (capyCommand.ts\'s own hasOrgKey check) is a no-key error', () => {
    expect(isNoKeyOnDeviceError(new CapyError('x', ERROR_CODES.KEY_NOT_ON_DEVICE))).toBe(true);
  });

  test('PERMISSION_DENIED with no details.status (keyResolver\'s "no blob at all" branch) is a no-key error', () => {
    expect(isNoKeyOnDeviceError(new CapyError('x', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' }))).toBe(true);
  });

  test('PERMISSION_DENIED WITH details.status=403 (a re-thrown server 403 — membership revoked family) is NOT a no-key error', () => {
    expect(isNoKeyOnDeviceError(new CapyError('x', ERROR_CODES.PERMISSION_DENIED, { status: 403 }))).toBe(false);
  });

  test('other codes (network, generic service errors) are never no-key errors', () => {
    expect(isNoKeyOnDeviceError(new CapyError('x', ERROR_CODES.NETWORK_ERROR))).toBe(false);
    expect(isNoKeyOnDeviceError(new Error('plain error'))).toBe(false);
  });
});

describe('shouldAttemptMint', () => {
  test('known-minted always refuses, interactive or not', () => {
    expect(shouldAttemptMint('minted', undefined)).toBe(false);
    expect(shouldAttemptMint('minted', true)).toBe(false);
  });

  test('unminted/unknown + a real TTY => true', () => {
    expect(shouldAttemptMint('unminted', undefined)).toBe(true);
    expect(shouldAttemptMint('minting', undefined)).toBe(true);
    expect(shouldAttemptMint(undefined, undefined)).toBe(true);
  });

  test('`web: true` does NOT bypass isInteractive() — the phrase rail is not wired yet (see the function\'s own docblock), so honoring it here would let a non-interactive caller past this gate and into a real claimKeyMint call before failing later at the phrase-display step', () => {
    interactive = false;
    expect(shouldAttemptMint('unminted', true)).toBe(false);
    expect(shouldAttemptMint(undefined, true)).toBe(false);
  });

  test('non-interactive and not --web => false, regardless of key_state', () => {
    interactive = false;
    expect(shouldAttemptMint('unminted', false)).toBe(false);
    expect(shouldAttemptMint(undefined, undefined)).toBe(false);
  });
});

describe('mintThenRetryOnNoKey', () => {
  test('non-interactive: rethrows original, no claim call, no output (byte-identical to today)', async () => {
    interactive = false;
    const serviceClient = fakeServiceClient();
    const originalErr = new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' });

    await expect(
      mintThenRetryOnNoKey(originalErr, { orgId: 'o', userId: 'u', serviceClient, keyServiceOps }, async () => 'retried'),
    ).rejects.toBe(originalErr);
    expect(calls).toEqual([]);
  });

  test('known-already-minted: rethrows original, no claim call at all', async () => {
    const serviceClient = fakeServiceClient();
    const originalErr = new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' });

    await expect(
      mintThenRetryOnNoKey(
        originalErr,
        { orgId: 'o', userId: 'u', serviceClient, keyServiceOps, orgKeyState: 'minted' },
        async () => 'retried',
      ),
    ).rejects.toBe(originalErr);
    expect(calls).toEqual([]);
  });

  test('happy path: mints, then calls retry and returns its value', async () => {
    const serviceClient = fakeServiceClient();
    const originalErr = new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' });

    const result = await mintThenRetryOnNoKey(
      originalErr,
      { orgId: 'o', userId: 'u', serviceClient, keyServiceOps, orgKeyState: 'unminted' },
      async () => 'retried-value',
    );

    expect(result).toBe('retried-value');
    expect(calls).toContain('claimKeyMint');
    expect(calls).toContain('wrapAndSaveMasterKey');
  });

  test('claim refuses (ALREADY_MINTED) mid-attempt: rethrows the ORIGINAL error, never the mint\'s own', async () => {
    const mintErr = new CapyError('already minted', ERROR_CODES.KEY_ALREADY_MINTED, { status: 409 });
    const serviceClient = fakeServiceClient({ claim: () => { throw mintErr; } });
    const originalErr = new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' });

    await expect(
      mintThenRetryOnNoKey(originalErr, { orgId: 'o', userId: 'u', serviceClient, keyServiceOps }, async () => 'x'),
    ).rejects.toBe(originalErr);
  });

  test('retry itself fails after a successful mint: that NEW error propagates, not the stale original', async () => {
    const serviceClient = fakeServiceClient();
    const originalErr = new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' });
    const retryErr = new Error('still broken after mint');

    await expect(
      mintThenRetryOnNoKey(originalErr, { orgId: 'o', userId: 'u', serviceClient, keyServiceOps }, async () => {
        throw retryErr;
      }),
    ).rejects.toBe(retryErr);
  });
});

describe('resolveProjectKeyWithMintFallback', () => {
  test('resolveProjectKey succeeds on the first try: returned directly, no claim call', async () => {
    resolveProjectKeyQueue = [() => Promise.resolve('deadbeef'.repeat(8))];
    const serviceClient = fakeServiceClient();

    const key = await resolveProjectKeyWithMintFallback({
      orgId: 'o',
      projectId: 'p',
      userId: 'u',
      serviceClient,
      keyServiceOps,
    });

    expect(key).toBe('deadbeef'.repeat(8));
    expect(calls).toEqual(['resolveProjectKey']);
  });

  test('a non-no-key error (e.g. network) is never routed through the mint fallback', async () => {
    const err = new CapyError('net blip', ERROR_CODES.NETWORK_ERROR);
    resolveProjectKeyQueue = [() => { throw err; }];
    const serviceClient = fakeServiceClient();

    await expect(
      resolveProjectKeyWithMintFallback({ orgId: 'o', projectId: 'p', userId: 'u', serviceClient, keyServiceOps }),
    ).rejects.toBe(err);
    expect(calls).toEqual(['resolveProjectKey']);
  });

  test('no-key error + unminted org: mints then retries resolveProjectKey once, returning its result', async () => {
    resolveProjectKeyQueue = [
      () => { throw new CapyError('no key', ERROR_CODES.PERMISSION_DENIED, { orgId: 'o' }); },
      () => Promise.resolve('cafebabe'.repeat(8)),
    ];
    const serviceClient = fakeServiceClient();

    const key = await resolveProjectKeyWithMintFallback({
      orgId: 'o',
      projectId: 'p',
      userId: 'u',
      serviceClient,
      keyServiceOps,
      orgKeyState: 'unminted',
    });

    expect(key).toBe('cafebabe'.repeat(8));
    expect(calls).toEqual([
      'resolveProjectKey',
      'claimKeyMint',
      'generateSeedPhrase',
      'displayAndConfirmRecoveryPhrase',
      'claimKeyMint', // pre-save re-claim (lease revalidated after the human-speed confirm)
      'seedPhraseToMasterKey',
      'wrapAndSaveMasterKey',
      'finalizeKeyMint',
      'resolveProjectKey',
    ]);
  });
});
