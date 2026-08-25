/**
 * Final-gate BLOCKER-1(c) — `capy run`'s device-key fallback.
 *
 * `runCommand.ts:166-201` used to go straight from a missing/invalid
 * key.enc (`resolveProjectKey` throwing PERMISSION_DENIED) to a hard
 * failure whose only remedy was "ask the project owner to invite you" —
 * even on a machine that could unlock via an already-enrolled device key.
 * This file drives `runCommand()` directly (it's a plain exported async
 * function, not a class) with every dependency mocked, so it tests the
 * DECISION logic the command layer now adds — never touching
 * `keyResolver.ts`, which stays real-import-shaped everywhere else in the
 * suite (invariant 4).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const USER_ID = 'user_run_fallback';
const ORG_ID = 'org-run-fallback';
const PROJECT_ID = 'proj-run-fallback';

mock.module('../../src/config/profileConfig', () => ({
  isLocalOnly: () => false,
}));

let silentAuthResult: unknown = {
  success: true,
  user_id: USER_ID,
  user_email: 'u@example.com',
  organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Org' }],
};
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return silentAuthResult;
    }
    getValidToken() {
      return Promise.resolve({ access_token: 'fake' });
    }
  },
  silentAuthFailureMessage: (r: any) => r?.error || 'not authenticated',
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    coDecrypt() { return Promise.resolve({ plaintext: 'unused' }); }
    wrapOuterLayer() { return Promise.resolve({ ciphertext: 'unused' }); }
  },
}));

// resolveProjectKey: fails N times, then (optionally) succeeds — mirrors "no
// key.enc" followed by "unlock ceremony installed one". `failureCode` picks
// which coded error it fails with, so one test can prove a non-PERMISSION_
// DENIED failure (e.g. a network blip) never gets routed through the
// unlock path at all.
let resolveCallCount = 0;
let resolveFailuresBeforeSuccess = Infinity; // Infinity = always fails
let failureCode: 'PERMISSION_DENIED' | 'NETWORK_ERROR' = 'PERMISSION_DENIED';
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(async () => {
    resolveCallCount++;
    if (resolveCallCount <= resolveFailuresBeforeSuccess) {
      const { CapyError, ERROR_CODES } = await import('../../src/types/index');
      if (failureCode === 'NETWORK_ERROR') {
        throw new CapyError('network blip', ERROR_CODES.NETWORK_ERROR);
      }
      throw new CapyError(
        "You do not have access to this project's secrets.\n\nAsk the project owner to invite you, or run capy in a different directory to create your own project.",
        ERROR_CODES.PERMISSION_DENIED,
        { orgId: ORG_ID },
      );
    }
    return 'deadbeef'.repeat(8);
  }),
}));

let deviceKeysOn = false;
mock.module('../../src/auth/deviceKey/flag', () => ({
  deviceKeysEnabled: () => deviceKeysOn,
}));

let unlockResult: { ok: boolean; installedCurrentOrg: boolean } = { ok: false, installedCurrentOrg: false };
const unlockCalls: unknown[] = [];
// Same never-throws, safe-no-op contract as attemptCaseCUnlock —
// defaults to "no pending pickup" so every EXISTING test in this file keeps
// taking exactly the path it took before this export existed.
let pickupResult: { ok: boolean } = { ok: false };
const pickupCalls: unknown[] = [];
mock.module('../../src/auth/deviceKey/wiring', () => ({
  attemptCaseCUnlock: mock(async (ctx: unknown) => {
    unlockCalls.push(ctx);
    return unlockResult;
  }),
  attemptPickupConsumption: mock(async (ctx: unknown) => {
    pickupCalls.push(ctx);
    return pickupResult;
  }),
}));

mock.module('../../src/files/fileManager', () => ({
  FileManager: class {
    readEnvFile() {
      return { SECRET_VAR: 'capy:res123:ciphertext-blob' };
    }
    isEncrypted(v: string) {
      return typeof v === 'string' && v.startsWith('capy:');
    }
    decryptValue(_v: string, key: string) {
      return `decrypted-with-${key}`;
    }
  },
}));

const tempDir = mkdtempSync(join(tmpdir(), 'capy-run-fallback-'));
const originalCwd = process.cwd();

afterAll(() => {
  mock.restore();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

let runCommand: (args: string[], devMode?: boolean) => Promise<number>;

beforeEach(async () => {
  ({ runCommand } = await import('../../src/commands/runCommand'));
  process.chdir(tempDir);
  writeFileSync(
    join(tempDir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'demo', variables: {} }),
  );
  resolveCallCount = 0;
  resolveFailuresBeforeSuccess = Infinity;
  failureCode = 'PERMISSION_DENIED';
  deviceKeysOn = false;
  unlockResult = { ok: false, installedCurrentOrg: false };
  unlockCalls.length = 0;
  pickupResult = { ok: false };
  pickupCalls.length = 0;
  silentAuthResult = {
    success: true,
    user_id: USER_ID,
    user_email: 'u@example.com',
    organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Org' }],
  };
});

afterEach(() => {
  process.chdir(originalCwd);
});

function captureLogs(fn: () => Promise<number>): Promise<{ code: number; errs: string[] }> {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
  return fn()
    .then((code) => ({ code, errs }))
    .finally(() => {
      console.error = orig;
    });
}

describe('capy run — device-key fallback on a missing/invalid key.enc (BLOCKER-1c)', () => {
  test('flag off: never touches the unlock path, fails with the invite-and-device-key remediation', async () => {
    deviceKeysOn = false;
    const { code, errs } = await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(code).toBe(1);
    expect(unlockCalls).toHaveLength(0);
    const out = errs.join('\n');
    expect(out).toContain('capy redeem');
    expect(out.toLowerCase()).toContain('device key');
  });

  test('flag on, unlock declines/fails: still fails, remediation still names the device key', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: false, installedCurrentOrg: false };
    const { code, errs } = await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(code).toBe(1);
    expect(unlockCalls).toHaveLength(1);
    // resolveProjectKey was tried once up front; no retry since unlock didn't succeed.
    expect(resolveCallCount).toBe(1);
    expect(errs.join('\n').toLowerCase()).toContain('device key');
  });

  test('flag on, unlock succeeds: resolveProjectKey is retried once and the run proceeds', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: true, installedCurrentOrg: true };
    resolveFailuresBeforeSuccess = 1; // first call fails, retry (2nd call) succeeds

    const { code, errs } = await captureLogs(() => runCommand(['echo', 'ok']));
    expect(code).toBe(0);
    expect(unlockCalls).toHaveLength(1);
    expect(resolveCallCount).toBe(2);
    expect(errs).toHaveLength(0);
  });

  test('flag on, unlock reports ok but the retry still fails: falls through to remediation, never throws unhandled', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: true, installedCurrentOrg: false };
    resolveFailuresBeforeSuccess = Infinity; // retry fails too

    const { code, errs } = await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(code).toBe(1);
    expect(resolveCallCount).toBe(2);
    expect(errs.join('\n').toLowerCase()).toContain('device key');
  });

  test('a non-PERMISSION_DENIED failure (e.g. network) is never routed through the unlock path', async () => {
    deviceKeysOn = true;
    failureCode = 'NETWORK_ERROR';

    const { code, errs } = await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(code).toBe(1);
    expect(unlockCalls).toHaveLength(0);
    expect(resolveCallCount).toBe(1);
    expect(errs.join('\n')).toContain('network blip');
  });
});

describe('capy run — pending-pickup fallback (tried after attemptCaseCUnlock)', () => {
  test('flag on, case-C unlock declines, no pending pickup: pickup IS tried, still fails with the same remediation', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: false, installedCurrentOrg: false };
    pickupResult = { ok: false };

    const { code, errs } = await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(code).toBe(1);
    expect(unlockCalls).toHaveLength(1);
    expect(pickupCalls).toHaveLength(1);
    // Neither attempt unlocked anything — no retry beyond the initial call.
    expect(resolveCallCount).toBe(1);
    expect(errs.join('\n').toLowerCase()).toContain('device key');
  });

  test('flag on, case-C unlock declines, pickup succeeds: resolveProjectKey is retried and the run proceeds', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: false, installedCurrentOrg: false };
    pickupResult = { ok: true };
    resolveFailuresBeforeSuccess = 1; // first call fails, retry (2nd call) succeeds

    const { code, errs } = await captureLogs(() => runCommand(['echo', 'ok']));
    expect(code).toBe(0);
    expect(unlockCalls).toHaveLength(1);
    expect(pickupCalls).toHaveLength(1);
    expect(resolveCallCount).toBe(2);
    expect(errs).toHaveLength(0);
  });

  test('flag on, case-C unlock succeeds outright: pickup is never tried (unlocked already true)', async () => {
    deviceKeysOn = true;
    unlockResult = { ok: true, installedCurrentOrg: true };
    resolveFailuresBeforeSuccess = 1;

    const { code } = await captureLogs(() => runCommand(['echo', 'ok']));
    expect(code).toBe(0);
    expect(pickupCalls).toHaveLength(0);
  });

  test('flag off: pickup is never touched, same as the unlock path', async () => {
    deviceKeysOn = false;
    await captureLogs(() => runCommand(['echo', 'unreached']));
    expect(pickupCalls).toHaveLength(0);
  });
});
