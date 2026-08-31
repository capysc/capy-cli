/**
 * CAP-628 — process-durable runtime pairing.
 *
 * The protected home is disposable and mocked before imports resolve. Tests
 * use real Unix sockets and, for the restart/shared-home case, fresh Bun
 * processes. No key bytes are printed by the child processes.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-runtime-pairing-'));
const tempCwd = mkdtempSync(join(require('os').tmpdir(), 'capy-runtime-pairing-cwd-'));
const originalCwd = process.cwd();
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});
process.chdir(tempCwd);

import {
  assertRuntimePairingUser,
  clearRuntimePairing,
  getRuntimePairingPath,
  readRuntimePairing,
  registerRuntimePairing,
} from '../../../src/auth/pairing/runtimePairing';
import { configuredGrantSocketPath } from '../../../src/auth/deviceKey/ephemeral';
import {
  createGrantDaemonServer,
  fetchGrantedKLocal,
  isGrantActive,
  listenGrantDaemonServer,
  spawnGrantDaemon,
} from '../../../src/auth/deviceKey/grantHolder';
import { installPairedSession } from '../../../src/auth/pairing/installPairedSession';
import { getAuthSessionPath, getGlobalCapyDir } from '../../../src/config/globalConfig';
import { performLogoutCleanup } from '../../../src/commands/logoutCommand';
import { CapyError, ERROR_CODES } from '../../../src/types/index';

const USER_A = 'user_runtime_a';
const USER_B = 'user_runtime_b';
const CREDENTIAL_A = 'credential_runtime_a';
const K_LOCAL = Buffer.alloc(32, 0x5a);

beforeEach(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
});

afterAll(() => {
  process.chdir(originalCwd);
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

async function childResult(source: string): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['-e', source], {
    cwd: originalCwd,
    env: {
      ...process.env,
      HOME: tempHome,
      CAPY_GLOBAL_DIR_NAME: '.capy',
      CAPY_DEVICE_KEY_GRANT_SOCKET: '',
    },
  });
  const status = new Promise<number | null>((resolve) => child.once('close', resolve));
  const stdout = child.stdout
    ? new Response(child.stdout as unknown as ReadableStream).text()
    : Promise.resolve('');
  const stderr = child.stderr
    ? new Response(child.stderr as unknown as ReadableStream).text()
    : Promise.resolve('');
  const result = await Promise.all([status, stdout, stderr]);
  return { status: result[0], stdout: result[1], stderr: result[2] };
}

describe('runtime pairing registry', () => {
  test('persists only non-secret metadata with mode 0600 in the environment home', async () => {
    const record = await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-pair-test.sock',
      expiresAt: Date.now() + 30_000,
    });

    expect(getRuntimePairingPath()).toBe(join(tempHome, '.capy', 'auth', 'runtime-pair.json'));
    expect(readRuntimePairing()).toEqual(record);
    expect(statSync(getRuntimePairingPath()).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(getRuntimePairingPath(), 'utf8');
    expect(serialized).not.toContain(K_LOCAL.toString('base64'));
    expect(Object.keys(JSON.parse(serialized)).toSorted()).toEqual([
      'credentialId',
      'expiresAt',
      'pairedAt',
      'socketPath',
      'userId',
      'version',
    ]);
  });

  test('the production daemon spawner commits the runtime record when pair requests persistence', async () => {
    const handle = await spawnGrantDaemon(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      {
        execPath: process.execPath,
        scriptPath: join(originalCwd, 'src', 'index.ts'),
        ttlMs: 10_000,
        persistRuntimePairing: true,
      },
    );
    try {
      expect(readRuntimePairing()).toMatchObject({
        userId: USER_A,
        credentialId: CREDENTIAL_A,
        socketPath: handle.socketPath,
      });
      expect(await fetchGrantedKLocal(handle.socketPath, USER_A)).toMatchObject({ userId: USER_A });
    } finally {
      await clearRuntimePairing();
    }
  });

  test('two fresh processes sharing the protected home discover and use the live pair without an exported socket', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, daemon);
      expect(configuredGrantSocketPath()).toBe(daemon.socketPath);

      const source = [
        "import { configuredGrantSocketPath } from './src/auth/deviceKey/ephemeral.ts';",
        "import { fetchGrantedKLocal } from './src/auth/deviceKey/grantHolder.ts';",
        `const path = configuredGrantSocketPath();`,
        `if (!path) process.exit(10);`,
        `const grant = await fetchGrantedKLocal(path, '${USER_A}');`,
        `if (grant.userId !== '${USER_A}' || grant.kLocal.length !== 32) process.exit(11);`,
        `console.log('PAIR_OK');`,
      ].join('\n');
      const [first, second] = await Promise.all([childResult(source), childResult(source)]);
      expect({ status: first.status, stdout: first.stdout.trim(), stderr: first.stderr }).toEqual({
        status: 0,
        stdout: 'PAIR_OK',
        stderr: '',
      });
      expect({ status: second.status, stdout: second.stdout.trim(), stderr: second.stderr }).toEqual({
        status: 0,
        stdout: 'PAIR_OK',
        stderr: '',
      });
      expect(first.stdout).not.toContain(K_LOCAL.toString('base64'));
      expect(second.stdout).not.toContain(K_LOCAL.toString('base64'));
    } finally {
      daemon.close();
    }
  });

  test('same-user re-pair replaces the daemon while preserving the account binding', async () => {
    const first = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    const second = createGrantDaemonServer(
      { userId: USER_A, credentialId: 'credential_runtime_a_2', kLocal: Buffer.alloc(32, 0x2a) },
      30_000,
    );
    await Promise.all([
      listenGrantDaemonServer(first.server, first.socketPath),
      listenGrantDaemonServer(second.server, second.socketPath),
    ]);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, first);
      await registerRuntimePairing(USER_A, 'credential_runtime_a_2', second);
      expect(assertRuntimePairingUser(USER_A)?.socketPath).toBe(second.socketPath);
      expect(await isGrantActive(first.socketPath)).toBe(false);
      expect(await isGrantActive(second.socketPath)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  test('wrong-user pairing refuses before a session write and same-user resume still succeeds', async () => {
    await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-pair-original.sock',
      expiresAt: Date.now() + 30_000,
    });
    const wrongSession = {
      user: { id: USER_B, email: 'b@example.com' },
      refresh_token: 'refresh_b',
      organizations: [],
    };

    const refusal = await installPairedSession(wrongSession)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CapyError);
    expect((refusal as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
    expect(existsSync(getAuthSessionPath(USER_B))).toBe(false);
    expect(readRuntimePairing()?.userId).toBe(USER_A);

    const resumed = await installPairedSession({
      user: { id: USER_A, email: 'a@example.com' },
      refresh_token: 'refresh_a',
      organizations: [],
    });
    expect(resumed).toEqual({ orgId: null, orgTokenReady: false });
    expect(existsSync(getAuthSessionPath(USER_A))).toBe(true);
  });

  test('wiping the protected home removes both discovery and the account binding', async () => {
    await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-pair-wipe.sock',
      expiresAt: Date.now() + 30_000,
    });
    rmSync(getGlobalCapyDir(), { recursive: true, force: true });

    expect(readRuntimePairing()).toBeNull();
    expect(configuredGrantSocketPath()).toBeNull();
    expect(assertRuntimePairingUser(USER_B)).toBeNull();
  });

  test('logout removes the association and shuts down the live in-memory grant', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, daemon);
      expect(await fetchGrantedKLocal(daemon.socketPath, USER_A)).toMatchObject({ userId: USER_A });

      expect(await performLogoutCleanup()).toBe(true);
      expect(readRuntimePairing()).toBeNull();
      expect(await isGrantActive(daemon.socketPath)).toBe(false);
    } finally {
      daemon.close();
    }
  });
});
