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
  readActiveRuntimePairing,
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
  rmSync(join(tempHome, '.capy-dev'), { recursive: true, force: true });
});

afterAll(() => {
  process.chdir(originalCwd);
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

async function childResult(source: string, globalDirName = '.capy'): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['-e', source], {
    cwd: originalCwd,
    env: {
      ...process.env,
      HOME: tempHome,
      CAPY_GLOBAL_DIR_NAME: globalDirName,
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

  test('two fresh capy-dev processes sharing ~/.capy-dev discover and use the live pair without an exported socket', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      const registerSource = [
        "import { registerRuntimePairing } from './src/auth/pairing/runtimePairing.ts';",
        `await registerRuntimePairing('${USER_A}', '${CREDENTIAL_A}', {`,
        `  socketPath: '${daemon.socketPath}',`,
        `  expiresAt: ${daemon.expiresAt},`,
        `});`,
        `console.log('REGISTERED_DEV_PAIR');`,
      ].join('\n');
      const registered = await childResult(registerSource, '.capy-dev');
      expect({ status: registered.status, stdout: registered.stdout.trim(), stderr: registered.stderr }).toEqual({
        status: 0,
        stdout: 'REGISTERED_DEV_PAIR',
        stderr: '',
      });
      expect(existsSync(join(tempHome, '.capy-dev', 'auth', 'runtime-pair.json'))).toBe(true);
      expect(existsSync(join(tempHome, '.capy', 'auth', 'runtime-pair.json'))).toBe(false);

      const source = [
        "import { configuredGrantSocketPath } from './src/auth/deviceKey/ephemeral.ts';",
        "import { fetchGrantedKLocal } from './src/auth/deviceKey/grantHolder.ts';",
        `const path = configuredGrantSocketPath();`,
        `if (!path) process.exit(10);`,
        `const grant = await fetchGrantedKLocal(path, '${USER_A}');`,
        `if (grant.userId !== '${USER_A}' || grant.kLocal.length !== 32) process.exit(11);`,
        `console.log('PAIR_OK');`,
      ].join('\n');
      const [first, second] = await Promise.all([
        childResult(source, '.capy-dev'),
        childResult(source, '.capy-dev'),
      ]);
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

  test('production, development, and staging runtime-pair registries stay in separate protected homes', async () => {
    const roots = [
      { directory: '.capy', userId: 'user_prod_root', credentialId: 'credential_prod_root' },
      { directory: '.capy-dev', userId: 'user_dev_root', credentialId: 'credential_dev_root' },
      { directory: '.capy-staging', userId: 'user_staging_root', credentialId: 'credential_staging_root' },
    ] as const;
    const daemons = roots.map((root, index) => createGrantDaemonServer(
      { userId: root.userId, credentialId: root.credentialId, kLocal: Buffer.alloc(32, index + 1) },
      null,
    ));
    await Promise.all(daemons.map((daemon) => listenGrantDaemonServer(daemon.server, daemon.socketPath)));
    try {
      const registrations = await Promise.all(roots.map((root, index) => childResult([
        "import { registerRuntimePairing } from './src/auth/pairing/runtimePairing.ts';",
        `await registerRuntimePairing('${root.userId}', '${root.credentialId}', {`,
        `  socketPath: '${daemons[index].socketPath}',`,
        `  expiresAt: 0,`,
        `});`,
        `console.log('PAIR_ROOT_OK');`,
      ].join('\n'), root.directory)));

      expect(registrations.map(({ status, stdout, stderr }) => ({
        status,
        stdout: stdout.trim(),
        stderr,
      }))).toEqual(roots.map(() => ({ status: 0, stdout: 'PAIR_ROOT_OK', stderr: '' })));
      expect(roots.map((root) => JSON.parse(readFileSync(
        join(tempHome, root.directory, 'auth', 'runtime-pair.json'),
        'utf8',
      )).userId)).toEqual(roots.map(({ userId }) => userId));
    } finally {
      daemons.forEach((daemon) => daemon.close());
    }
  });

  test('a fresh free-sync process resolves through persisted pair metadata with no socket environment variable', async () => {
    const syncKLocal = Buffer.alloc(32, 0x4c);
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: syncKLocal },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, daemon);
      const source = [
        "import { resolveFreeSyncProjectKey } from './src/sync/freeSyncKeyResolver.ts';",
        "import { encryptMasterKey, masterKeyAAD, deriveProjectKey } from './src/crypto/keyManager.ts';",
        "import { deriveLocalInnerKey } from './src/crypto/localKeyRoot.ts';",
        `const user = '${USER_A}';`,
        `const org = 'org_runtime_sync';`,
        `const project = 'project_runtime_sync';`,
        `const kLocal = Buffer.alloc(32, 0x4c);`,
        `const masterKey = Buffer.alloc(32, 0x6b);`,
        `const keyEnc = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(user, org));`,
        `const key = await resolveFreeSyncProjectKey(org, project, user, {`,
        `  coDecrypt: async () => { throw new Error('disk custody must not run'); },`,
        `  wrapOuterLayer: async () => { throw new Error('disk custody must not run'); },`,
        `}, {`,
        `  fetchKeyEnc: async () => keyEnc,`,
        `  coDecrypt: async (_orgId, ciphertext) => ciphertext,`,
        `});`,
        `if (key !== deriveProjectKey(masterKey, project, org)) process.exit(12);`,
        `console.log('FREE_SYNC_PAIR_OK');`,
      ].join('\n');
      const result = await childResult(source);
      expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr }).toEqual({
        status: 0,
        stdout: 'FREE_SYNC_PAIR_OK',
        stderr: '',
      });
      expect(result.stdout).not.toContain(syncKLocal.toString('base64'));
    } finally {
      daemon.close();
    }
  });

  test('a fresh free-sync process without runtime or disk custody fails closed', async () => {
    const source = [
      "import { resolveFreeSyncProjectKey } from './src/sync/freeSyncKeyResolver.ts';",
      `const outcome = await resolveFreeSyncProjectKey('org_unavailable', 'project_unavailable', '${USER_A}', {`,
      `  coDecrypt: async (_orgId, ciphertext) => ciphertext,`,
      `  wrapOuterLayer: async (_orgId, plaintext) => plaintext,`,
      `}, {`,
      `  fetchKeyEnc: async () => { throw new Error('grant custody must not run'); },`,
      `  coDecrypt: async (_orgId, ciphertext) => ciphertext,`,
      `}).then(() => 'UNEXPECTED_SUCCESS').catch((error) => String(error?.code));`,
      `console.log(outcome);`,
    ].join('\n');
    const result = await childResult(source);
    expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr }).toEqual({
      status: 0,
      stdout: ERROR_CODES.PERMISSION_DENIED,
      stderr: '',
    });
  });

  test('reports active only when the bound user session and live unexpired daemon agree', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, daemon);
      await installPairedSession({
        user: { id: USER_A, email: 'a@example.com' },
        refresh_token: 'refresh_a',
        organizations: [],
      });

      expect(await readActiveRuntimePairing()).toEqual({
        userId: USER_A,
        userEmail: 'a@example.com',
        socketPath: daemon.socketPath,
        expiresAt: daemon.expiresAt,
      });
    } finally {
      daemon.close();
    }
  });

  test('an unavailable daemon is not active and therefore remains retryable', async () => {
    await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-pair-unavailable.sock',
      expiresAt: Date.now() + 30_000,
    });
    await installPairedSession({
      user: { id: USER_A, email: 'a@example.com' },
      refresh_token: 'refresh_a',
      organizations: [],
    });

    expect(await readActiveRuntimePairing()).toBeNull();
    expect(assertRuntimePairingUser(USER_A)?.userId).toBe(USER_A);
  });

  test('an expired record is not active even if its daemon still answers during reap grace', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      30_000,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await registerRuntimePairing(USER_A, CREDENTIAL_A, {
        socketPath: daemon.socketPath,
        expiresAt: Date.now() - 1,
      });
      await installPairedSession({
        user: { id: USER_A, email: 'a@example.com' },
        refresh_token: 'refresh_a',
        organizations: [],
      });

      expect(await isGrantActive(daemon.socketPath)).toBe(true);
      expect(await readActiveRuntimePairing()).toBeNull();
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

  test('mismatched, foreign, and expired replacements cannot displace or stop a valid pair', async () => {
    const valid = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    const foreign = createGrantDaemonServer(
      { userId: USER_B, credentialId: 'credential_runtime_b', kLocal: Buffer.alloc(32, 0x2b) },
      null,
    );
    const expired = createGrantDaemonServer(
      { userId: USER_A, credentialId: 'credential_runtime_expired', kLocal: Buffer.alloc(32, 0x3c) },
      null,
    );
    await Promise.all([valid, foreign, expired].map(
      (daemon) => listenGrantDaemonServer(daemon.server, daemon.socketPath),
    ));
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, valid);

      const wrongAccount = await registerRuntimePairing(USER_B, 'credential_runtime_b', {
        socketPath: valid.socketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);
      expect(wrongAccount).toBeInstanceOf(CapyError);
      expect((wrongAccount as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(valid.socketPath)).toBe(true);

      const foreignHolder = await registerRuntimePairing(USER_A, CREDENTIAL_A, foreign)
        .then(() => null)
        .catch((error: unknown) => error);
      expect(foreignHolder).toBeInstanceOf(CapyError);
      expect((foreignHolder as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(foreign.socketPath)).toBe(false);
      expect(await isGrantActive(valid.socketPath)).toBe(true);

      const expiredHolder = await registerRuntimePairing(USER_A, 'credential_runtime_expired', {
        socketPath: expired.socketPath,
        expiresAt: Date.now() - 1,
      }).then(() => null).catch((error: unknown) => error);
      expect(expiredHolder).toBeInstanceOf(CapyError);
      expect((expiredHolder as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(expired.socketPath)).toBe(false);
      expect(await fetchGrantedKLocal(valid.socketPath, USER_A)).toMatchObject({
        userId: USER_A,
        credentialId: CREDENTIAL_A,
      });
    } finally {
      valid.close();
      foreign.close();
      expired.close();
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
