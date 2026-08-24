/**
 * Master-key mint fix (auto-provisioned personal orgs have no key at all
 * until an owner first mints one): `resolveContext`'s lock-less path
 * (`resolveLocklessContext` in `src/commands/connectors/shared.ts`) now
 * routes a "no key on this device" failure through
 * `resolveProjectKeyWithMintFallback` (`src/auth/masterKeyMint.ts`) instead
 * of failing straight to the invite-code remedy.
 *
 * This file drives that integration end to end against a real temp
 * directory: `keyResolver.resolveProjectKey` is mocked to fail once (the
 * "no key.enc yet" shape — PERMISSION_DENIED with no `details.status`, same
 * client-local signal `runCommand.ts`'s device-key fallback already keys
 * off) then succeed (the "post-mint retry" shape); `ServiceClient` gains
 * `claimKeyMint`/`finalizeKeyMint`; `ui/recoveryPhrase` and `ui/interactive`
 * are faked so the ceremony runs without a real terminal. `masterKeyMint.ts`
 * itself is REAL — this is the integration, not a unit test of it (that
 * lives in masterKeyMint.test.ts).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { mock, describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(require('os').tmpdir(), 'capy-lockless-mint-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => TEMP_HOME };
});

const PROJECT_KEY = 'c'.repeat(64);
const ORG_ID = 'org-personal';

const calls: string[] = [];

type AuthResult = {
  success: boolean;
  user_id?: string;
  organization_id?: string;
  organizations?: Array<{ id: string; workos_org_id: string; name: string; key_state?: string }>;
  error?: string;
};

let authResultQueue: AuthResult[] = [];
mock.module(join(import.meta.dir, '../../../src/auth/authService.ts'), () => ({
  AuthService: class {
    constructor(_apiUrl?: string, _devMode?: boolean, _sessionUserId?: string) {}
    async authenticateSilent(_orgId?: string): Promise<AuthResult> {
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    async authenticate(_orgId?: string): Promise<AuthResult> {
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999 };
    }
  },
}));

type Project = { id: string; name: string; organization_id: string };
let listProjectsResult: Project[] = [];
let getDecryptDataResult: any = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
let claimResult: { key_state: 'minting'; expires_at: string } | (() => any) = { key_state: 'minting', expires_at: '2099-01-01T00:00:00Z' };
let finalizeResult: { key_state: 'minted' } | (() => any) = { key_state: 'minted' };

mock.module(join(import.meta.dir, '../../../src/service/serviceClient.ts'), () => ({
  ServiceClient: class {
    constructor(_apiUrl?: string, _devMode?: boolean) {}
    setTokenProvider() {}
    async listProjects(): Promise<Project[]> {
      return listProjectsResult;
    }
    async getDecryptData(_projectId: string, _branch?: string) {
      return getDecryptDataResult;
    }
    async coDecrypt() {
      return { plaintext: '' };
    }
    async wrapOuterLayer() {
      return { ciphertext: '' };
    }
    async claimKeyMint(_orgId: string) {
      calls.push('claimKeyMint');
      if (typeof claimResult === 'function') return claimResult();
      return claimResult;
    }
    async finalizeKeyMint(_orgId: string) {
      calls.push('finalizeKeyMint');
      if (typeof finalizeResult === 'function') return finalizeResult();
      return finalizeResult;
    }
  },
}));

let resolveProjectKeyQueue: Array<() => Promise<string>> = [];
mock.module(join(import.meta.dir, '../../../src/crypto/keyResolver.ts'), () => ({
  resolveProjectKey: mock(async () => {
    calls.push('resolveProjectKey');
    const next = resolveProjectKeyQueue.shift();
    if (!next) throw new Error('resolveProjectKey called with nothing queued');
    return next();
  }),
  wrapAndSaveMasterKey: mock(async () => {
    calls.push('wrapAndSaveMasterKey');
  }),
}));

mock.module(join(import.meta.dir, '../../../src/crypto/keyManager.ts'), () => ({
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

mock.module(join(import.meta.dir, '../../../src/ui/recoveryPhrase.ts'), () => ({
  displayAndConfirmRecoveryPhrase: mock(async () => {
    calls.push('displayAndConfirmRecoveryPhrase');
  }),
}));

let interactive = true;
mock.module(join(import.meta.dir, '../../../src/ui/interactive.ts'), () => ({
  isInteractive: () => interactive,
}));

// resolveContext's catch prints the error screen and would otherwise
// `process.exit()` the real test worker (errorScreen.ts's displayErrorAndExit
// contract) — a no-op here so the subsequent `throw err` in shared.ts runs
// and the ORIGINAL error's identity survives for `.rejects.toBe(err)`.
mock.module(join(import.meta.dir, '../../../src/ui/errorScreen.ts'), () => ({
  displayErrorAndExit: mock(async () => {}),
}));

afterAll(() => {
  mock.restore();
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

import { resolveContext } from '../../../src/commands/connectors/shared';
import { CapyError, ERROR_CODES } from '../../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-lockless-mint-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function resetState(): void {
  authResultQueue = [];
  listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: ORG_ID }];
  getDecryptDataResult = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
  resolveProjectKeyQueue = [];
  claimResult = { key_state: 'minting', expires_at: '2099-01-01T00:00:00Z' };
  finalizeResult = { key_state: 'minted' };
  calls.length = 0;
  interactive = true;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  resetState();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The "no key.enc on this device yet" shape unwrapMasterKey throws — client-local, no details.status. */
function noKeyError(): CapyError {
  return new CapyError(
    'You do not have access to this project\'s secrets.',
    ERROR_CODES.PERMISSION_DENIED,
    { orgId: ORG_ID },
  );
}

describe('resolveContext (lock-less) — mint chokepoint', () => {
  test('unminted owned org: resolveProjectKey fails once, mint runs, retry succeeds', async () => {
    authResultQueue = [{
      success: true,
      user_id: 'user-1',
      organization_id: ORG_ID,
      organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Personal', key_state: 'unminted' }],
    }];
    resolveProjectKeyQueue = [
      () => { throw noKeyError(); },
      () => Promise.resolve(PROJECT_KEY),
    ];

    const ctx = await resolveContext({ devMode: true });

    expect(ctx.projectKey).toBe(PROJECT_KEY);
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

  test('org already minted (known from the auth-response list): no claim call, original error surfaces', async () => {
    authResultQueue = [{
      success: true,
      user_id: 'user-1',
      organization_id: ORG_ID,
      organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Personal', key_state: 'minted' }],
    }];
    const err = noKeyError();
    resolveProjectKeyQueue = [() => { throw err; }];

    await expect(resolveContext({ devMode: true })).rejects.toBe(err);
    expect(calls).toEqual(['resolveProjectKey']);
    expect(calls).not.toContain('claimKeyMint');
  });

  test('non-interactive: byte-identical — no claim call, original error surfaces', async () => {
    interactive = false;
    authResultQueue = [{
      success: true,
      user_id: 'user-1',
      organization_id: ORG_ID,
      organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Personal', key_state: 'unminted' }],
    }];
    const err = noKeyError();
    resolveProjectKeyQueue = [() => { throw err; }];

    await expect(resolveContext({ devMode: true })).rejects.toBe(err);
    expect(calls).toEqual(['resolveProjectKey']);
    expect(calls).not.toContain('claimKeyMint');
    expect(calls).not.toContain('displayAndConfirmRecoveryPhrase');
  });

  test('claim answers KEY_ALREADY_MINTED: original no-key error surfaces, not the mint error', async () => {
    authResultQueue = [{
      success: true,
      user_id: 'user-1',
      organization_id: ORG_ID,
      // key_state absent — the claim's own 409 is the probe.
      organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Personal' }],
    }];
    const err = noKeyError();
    resolveProjectKeyQueue = [() => { throw err; }];
    claimResult = () => {
      throw new CapyError('already minted', ERROR_CODES.KEY_ALREADY_MINTED, { status: 409 });
    };

    await expect(resolveContext({ devMode: true })).rejects.toBe(err);
    expect(calls).toEqual(['resolveProjectKey', 'claimKeyMint']);
    expect(calls).not.toContain('displayAndConfirmRecoveryPhrase');
  });
});
