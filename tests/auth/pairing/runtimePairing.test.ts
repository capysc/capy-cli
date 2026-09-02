/**
 * CAP-628 — process-durable runtime pairing.
 *
 * The protected home is disposable and mocked before imports resolve. Tests
 * use real Unix sockets and, for the restart/shared-home case, fresh Bun
 * processes. No key bytes are printed by the child processes.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { createServer } from 'net';

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
  registerRuntimePairingWithCustody,
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
import type {
  RuntimeCustodyEnvironment,
  RuntimeCustodyProvider,
} from '../../../src/auth/pairing/runtimeCustodyProvider';

const USER_A = 'user_runtime_a';
const USER_B = 'user_runtime_b';
const CREDENTIAL_A = 'credential_runtime_a';
const K_LOCAL = Buffer.alloc(32, 0x5a);
const CUSTODY_HANDLE = 'custody-runtime-a-stable-handle';

function createCustodyProvider(options: {
  readonly handle?: string;
  readonly deleteError?: Error;
} = {}): {
  readonly provider: RuntimeCustodyProvider;
  readonly seal: ReturnType<typeof mock>;
  readonly unseal: ReturnType<typeof mock>;
  readonly remove: ReturnType<typeof mock>;
} {
  const lifecycle = new AbortController();
  const handle = options.handle ?? CUSTODY_HANDLE;
  const assertRequest = (input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle?: string;
  }): void => {
    if (
      input.environment !== 'development'
      || input.userId !== USER_A
      || (input.opaqueHandle !== undefined && input.opaqueHandle !== handle)
    ) {
      throw new CapyError('Custody binding refused.', ERROR_CODES.PERMISSION_DENIED);
    }
  };
  const seal = mock(async (input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly kLocal: Uint8Array;
  }) => {
    assertRequest(input);
    if (lifecycle.signal.aborted) {
      throw new CapyError('Custody entry was deleted.', ERROR_CODES.PERMISSION_DENIED);
    }
    expect(input.kLocal).toEqual(K_LOCAL);
    return { opaqueHandle: handle };
  });
  const unseal = mock(async (input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle: string;
  }) => {
    assertRequest(input);
    if (lifecycle.signal.aborted) {
      throw new CapyError('Custody entry was deleted.', ERROR_CODES.PERMISSION_DENIED);
    }
    return Uint8Array.from(K_LOCAL);
  });
  const remove = mock(async (input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle: string;
  }) => {
    assertRequest(input);
    if (options.deleteError) throw options.deleteError;
    lifecycle.abort();
  });
  return {
    provider: {
      kind: 'orchestrator-secret-store',
      seal,
      unseal,
      delete: remove,
    },
    seal,
    unseal,
    remove,
  };
}

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

type ShutdownFixtureBehavior = 'ack-and-linger' | 'malformed' | 'missing-ack' | 'split-ack';

async function startShutdownFixture(behavior: ShutdownFixtureBehavior): Promise<{
  readonly socketPath: string;
  readonly close: () => Promise<void>;
}> {
  const directory = mkdtempSync(join(require('os').tmpdir(), 'capy-runtime-shutdown-fixture-'));
  const socketPath = join(directory, 'holder.sock');
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = (() => {
        try {
          return JSON.parse(chunk.toString('utf8').trim()) as Readonly<{ op?: unknown }>;
        } catch {
          return null;
        }
      })();
      if (request?.op === 'verify') {
        socket.end(`${JSON.stringify({ ok: true })}\n`);
        return;
      }
      if (behavior === 'ack-and-linger') socket.end(`${JSON.stringify({ ok: true })}\n`);
      else if (behavior === 'split-ack') {
        socket.write('{"ok":');
        setTimeout(() => {
          socket.end('true}\n');
          server.close();
          rmSync(socketPath, { force: true });
        }, 10);
      }
      else if (behavior === 'malformed') socket.end('not-json\n');
      else socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: () => server.listening
      ? new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(directory, { recursive: true, force: true });
          resolve();
        });
      })
      : Promise.resolve().then(() => {
        rmSync(directory, { recursive: true, force: true });
      }),
  };
}

async function startRebindingShutdownFixture(): Promise<{
  readonly socketPath: string;
  readonly rebound: Promise<{
    readonly requestObserved: Promise<void>;
    readonly close: () => Promise<void>;
  }>;
}> {
  const directory = mkdtempSync(join(require('os').tmpdir(), 'capy-runtime-rebind-fixture-'));
  const socketPath = join(directory, 'holder.sock');
  return new Promise((resolveStarted, rejectStarted) => {
    const rebound = new Promise<{
      readonly requestObserved: Promise<void>;
      readonly close: () => Promise<void>;
    }>((resolveRebound) => {
      const original = createServer((socket) => {
        socket.once('data', () => {
          socket.end(`${JSON.stringify({ ok: false, code: 'NOT_OWNED' })}\n`);
          original.close(() => {
            const replacementStarted = new Promise<{
              readonly requestObserved: Promise<void>;
              readonly close: () => Promise<void>;
            }>((resolveReplacement) => {
              const requestObserved = new Promise<void>((resolveRequest) => {
                const replacement = createServer((replacementSocket) => {
                  replacementSocket.once('data', () => {
                    resolveRequest();
                    replacementSocket.end(`${JSON.stringify({ ok: true })}\n`);
                  });
                });
                replacement.listen(socketPath, () => resolveReplacement({
                  requestObserved,
                  close: () => new Promise<void>((resolveClose) => {
                    replacement.close(() => {
                      rmSync(directory, { recursive: true, force: true });
                      resolveClose();
                    });
                  }),
                }));
              });
            });
            void replacementStarted.then(resolveRebound);
          });
        });
      });
      original.once('error', rejectStarted);
      original.listen(socketPath, () => resolveStarted({ socketPath, rebound }));
    });
  });
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

  test('the daemon spawner seals before publishing a version-2 custody record', async () => {
    const custody = createCustodyProvider();
    const handle = await spawnGrantDaemon(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      {
        execPath: process.execPath,
        scriptPath: join(originalCwd, 'src', 'index.ts'),
        ttlMs: null,
        persistRuntimePairing: true,
        runtimeCustody: {
          provider: custody.provider,
          environment: 'development',
        },
      },
    );
    try {
      expect(custody.seal).toHaveBeenCalledTimes(1);
      expect(readRuntimePairing()).toMatchObject({
        version: 2,
        userId: USER_A,
        credentialId: CREDENTIAL_A,
        socketPath: handle.socketPath,
        custody: {
          providerKind: 'orchestrator-secret-store',
          environment: 'development',
          userId: USER_A,
          opaqueHandle: CUSTODY_HANDLE,
        },
      });
      expect(readFileSync(getRuntimePairingPath(), 'utf8')).not.toContain(K_LOCAL.toString('base64'));
      expect(await fetchGrantedKLocal(handle.socketPath, USER_A)).toMatchObject({ userId: USER_A });
    } finally {
      await clearRuntimePairing({
        resolveCustodyProvider: (kind) => kind === custody.provider.kind ? custody.provider : null,
        expectedEnvironment: 'development',
      });
    }
    expect(custody.remove).toHaveBeenCalledTimes(1);
  });

  test('reads v1 unchanged and rejects malformed or cross-user v2 custody metadata', async () => {
    const v1 = await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-v1-compatible.sock',
      expiresAt: 0,
    });
    expect(readRuntimePairing()).toEqual(v1);
    rmSync(getRuntimePairingPath(), { force: true });

    const custody = createCustodyProvider();
    const v2 = await registerRuntimePairingWithCustody(
      custody.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-compatible.sock', expiresAt: 0 },
    );
    expect(readRuntimePairing()).toEqual(v2);

    const writeRecord = (record: unknown): void => {
      mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true, mode: 0o700 });
      writeFileSync(getRuntimePairingPath(), JSON.stringify(record), { mode: 0o600 });
    };
    writeRecord({ ...v2, custody: { ...v2.custody, userId: USER_B } });
    expect(readRuntimePairing()).toBeNull();
    writeRecord({ ...v2, custody: { ...v2.custody, opaqueHandle: '' } });
    expect(readRuntimePairing()).toBeNull();
    writeRecord({ ...v2, custody: { ...v2.custody, providerKind: 'ordinary-file' } });
    expect(readRuntimePairing()).toBeNull();
    writeRecord({ ...v2, custody: { ...v2.custody, environment: 'custom-home-name' } });
    expect(readRuntimePairing()).toBeNull();
    writeRecord({ ...v2, version: 1 });
    expect(readRuntimePairing()).toBeNull();
    await expect(clearRuntimePairing({
      resolveCustodyProvider: () => custody.provider,
      expectedEnvironment: 'development',
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-invalid-record-candidate.sock',
      expiresAt: 0,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(existsSync(getRuntimePairingPath())).toBe(true);
  });

  test('wrong-user preflight occurs before provider seal and a changed stable handle is refused', async () => {
    const stable = createCustodyProvider();
    const original = await registerRuntimePairingWithCustody(
      stable.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-original.sock', expiresAt: 0 },
    );
    const wrongUser = await registerRuntimePairingWithCustody(
      stable.provider,
      'development',
      { userId: USER_B, credentialId: 'credential_runtime_b', kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-wrong-user.sock', expiresAt: 0 },
    ).then(() => null, (error: unknown) => error);
    expect(wrongUser).toMatchObject({ code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH });
    expect(stable.seal).toHaveBeenCalledTimes(1);

    await expect(registerRuntimePairingWithCustody(
      stable.provider,
      'staging',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-wrong-environment.sock', expiresAt: 0 },
    )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    const wrongKindProvider: RuntimeCustodyProvider = {
      ...stable.provider,
      kind: 'os-secure-store',
    };
    await expect(registerRuntimePairingWithCustody(
      wrongKindProvider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-wrong-provider.sock', expiresAt: 0 },
    )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(stable.seal).toHaveBeenCalledTimes(1);

    const changed = createCustodyProvider({ handle: `${CUSTODY_HANDLE}-changed` });
    const changedHandle = await registerRuntimePairingWithCustody(
      changed.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-changed.sock', expiresAt: 0 },
    ).then(() => null, (error: unknown) => error);
    expect(changedHandle).toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(changed.remove).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toEqual(original);
  });

  test('pre-registration refusals reap detached candidates and v2 cannot downgrade to v1', async () => {
    const stable = createCustodyProvider();
    const originalHandle = await spawnGrantDaemon(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      {
        execPath: process.execPath,
        scriptPath: join(originalCwd, 'src', 'index.ts'),
        ttlMs: null,
      },
    );
    const original = await registerRuntimePairingWithCustody(
      stable.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      originalHandle,
    );
    try {
      const wrongUserHandle = await spawnGrantDaemon(
        { userId: USER_B, credentialId: 'credential_runtime_b', kLocal: K_LOCAL },
        {
          execPath: process.execPath,
          scriptPath: join(originalCwd, 'src', 'index.ts'),
          ttlMs: null,
        },
      );
      await expect(registerRuntimePairingWithCustody(
        stable.provider,
        'development',
        { userId: USER_B, credentialId: 'credential_runtime_b', kLocal: K_LOCAL },
        wrongUserHandle,
      )).rejects.toMatchObject({ code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH });
      expect(await isGrantActive(wrongUserHandle.socketPath)).toBe(false);

      const changedHandle = await spawnGrantDaemon(
        { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
        {
          execPath: process.execPath,
          scriptPath: join(originalCwd, 'src', 'index.ts'),
          ttlMs: null,
        },
      );
      const changed = createCustodyProvider({ handle: `${CUSTODY_HANDLE}-changed` });
      await expect(registerRuntimePairingWithCustody(
        changed.provider,
        'development',
        { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
        changedHandle,
      )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
      expect(await isGrantActive(changedHandle.socketPath)).toBe(false);

      const downgradeHandle = await spawnGrantDaemon(
        { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
        {
          execPath: process.execPath,
          scriptPath: join(originalCwd, 'src', 'index.ts'),
          ttlMs: null,
        },
      );
      await expect(registerRuntimePairing(USER_A, CREDENTIAL_A, downgradeHandle))
        .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
      expect(await isGrantActive(downgradeHandle.socketPath)).toBe(false);
      expect(await isGrantActive(originalHandle.socketPath)).toBe(true);
      expect(readRuntimePairing()).toEqual(original);
      await expect(clearRuntimePairing({
        resolveCustodyProvider: () => stable.provider,
        expectedEnvironment: 'staging',
      })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
      expect(stable.remove).not.toHaveBeenCalled();
    } finally {
      await clearRuntimePairing({
        resolveCustodyProvider: () => stable.provider,
        expectedEnvironment: 'development',
      });
    }
  });

  test('registration rollback deletes only a new custody entry and preserves an existing stable binding', async () => {
    await registerRuntimePairing(USER_A, CREDENTIAL_A, {
      socketPath: '/tmp/capy-runtime-v1-protected.sock',
      expiresAt: 0,
    });
    const newlySealed = createCustodyProvider();
    const v1Failure = await registerRuntimePairingWithCustody(
      newlySealed.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-invalid-candidate.sock', expiresAt: 0 },
    ).then(() => null, (error: unknown) => error);
    expect(v1Failure).toMatchObject({ code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND });
    expect(newlySealed.remove).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toMatchObject({ version: 1, socketPath: '/tmp/capy-runtime-v1-protected.sock' });

    rmSync(getRuntimePairingPath(), { force: true });
    const stable = createCustodyProvider();
    const v2 = await registerRuntimePairingWithCustody(
      stable.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-protected.sock', expiresAt: 0 },
    );
    const v2Failure = await registerRuntimePairingWithCustody(
      stable.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-invalid-replacement.sock', expiresAt: 0 },
    ).then(() => null, (error: unknown) => error);
    expect(v2Failure).toMatchObject({ code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND });
    expect(stable.remove).not.toHaveBeenCalled();
    expect(readRuntimePairing()).toEqual(v2);
  });

  test('v2 logout deletes custody first and preserves every local artifact on provider failure', async () => {
    const custody = createCustodyProvider({ deleteError: new Error('provider unavailable') });
    const record = await registerRuntimePairingWithCustody(
      custody.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-logout.sock', expiresAt: 0 },
    );
    const localToken = join(process.cwd(), '.capy', 'token');
    const authSession = join(getGlobalCapyDir(), 'auth', 'session.json');
    mkdirSync(join(process.cwd(), '.capy'), { recursive: true });
    mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true });
    writeFileSync(localToken, 'local-session');
    writeFileSync(authSession, 'global-session');

    await expect(performLogoutCleanup({
      resolveRuntimeCustodyProvider: () => custody.provider,
      runtimeCustodyEnvironment: 'development',
    })).rejects.toThrow('provider unavailable');
    expect(custody.remove).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toEqual(record);
    expect(readFileSync(localToken, 'utf8')).toBe('local-session');
    expect(readFileSync(authSession, 'utf8')).toBe('global-session');

    await expect(clearRuntimePairing()).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(readRuntimePairing()).toEqual(record);
  });

  test('v2 logout preserves sessions on metadata failure and retries an idempotent provider delete', async () => {
    const custody = createCustodyProvider();
    const record = await registerRuntimePairingWithCustody(
      custody.provider,
      'development',
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      { socketPath: '/tmp/capy-runtime-v2-logout-retry.sock', expiresAt: 0 },
    );
    const localToken = join(process.cwd(), '.capy', 'token');
    const authSession = join(getGlobalCapyDir(), 'auth', 'session.json');
    mkdirSync(join(process.cwd(), '.capy'), { recursive: true });
    mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true });
    writeFileSync(localToken, 'local-session');
    writeFileSync(authSession, 'global-session');

    await expect(performLogoutCleanup({
      resolveRuntimeCustodyProvider: () => custody.provider,
      runtimeCustodyEnvironment: 'development',
      removeRuntimePairingMetadata: () => {
        throw new Error('metadata unavailable');
      },
    })).rejects.toThrow('metadata unavailable');
    expect(custody.remove).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toEqual(record);
    expect(readFileSync(localToken, 'utf8')).toBe('local-session');
    expect(readFileSync(authSession, 'utf8')).toBe('global-session');

    expect(await performLogoutCleanup({
      resolveRuntimeCustodyProvider: () => custody.provider,
      runtimeCustodyEnvironment: 'development',
    })).toBe(true);
    expect(custody.remove).toHaveBeenCalledTimes(2);
    expect(readRuntimePairing()).toBeNull();
    expect(existsSync(localToken)).toBe(false);
    expect(existsSync(authSession)).toBe(false);
  });

  test('a runtime-record write failure reaps only the newly launched holder and preserves the existing pair', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    const candidateCredential = 'credential_runtime_candidate';
    const candidate = createGrantDaemonServer(
      { userId: USER_A, credentialId: candidateCredential, kLocal: Buffer.alloc(32, 0x6c) },
      null,
    );
    await Promise.all([existing, candidate].map(
      (daemon) => listenGrantDaemonServer(daemon.server, daemon.socketPath),
    ));
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      writeFileSync(`${getRuntimePairingPath()}.${process.pid}.tmp`, 'force EEXIST', { flag: 'wx', mode: 0o600 });

      const failure = await registerRuntimePairing(USER_A, candidateCredential, candidate)
        .then(() => null)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toBe('EEXIST');
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(existing.socketPath)).toBe(true);
      expect(await isGrantActive(candidate.socketPath)).toBe(false);
      expect(existsSync(candidate.socketPath)).toBe(false);
    } finally {
      existing.close();
      candidate.close();
    }
  });

  test('ENOENT cleanup is accepted only after the exact rejected socket is proven absent', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    const absentSocketPath = join(tempHome, 'exact-rejected-holder.sock');
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      const failure = await registerRuntimePairing(USER_B, 'credential_runtime_absent', {
        socketPath: absentSocketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CapyError);
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect((failure as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
      expect(existsSync(absentSocketPath)).toBe(false);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(existing.socketPath)).toBe(true);
    } finally {
      existing.close();
    }
  });

  test('a protected existing socket is never treated as the rejected caller-owned holder', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      const failure = await registerRuntimePairing(USER_B, 'credential_runtime_alias', {
        socketPath: existing.socketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CapyError);
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect((failure as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(existing.socketPath)).toBe(true);
    } finally {
      existing.close();
    }
  });

  test('a rejected socket rebound to an unrelated holder is never reopened for shutdown', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    const candidate = await startRebindingShutdownFixture();
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      const failure = await registerRuntimePairing(USER_B, 'credential_runtime_rebound', {
        socketPath: candidate.socketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);
      const rebound = await candidate.rebound;
      try {
        expect(failure).toBeInstanceOf(AggregateError);
        const [registrationError, cleanupError] = (failure as AggregateError).errors;
        expect(registrationError).toBeInstanceOf(CapyError);
        expect((registrationError as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
        expect(String(cleanupError)).toContain('did not confirm cleanup ownership');
        const replacementWasUntouched = await Promise.race([
          rebound.requestObserved.then(() => false),
          Bun.sleep(100).then(() => true),
        ]);
        expect(replacementWasUntouched).toBe(true);
        expect(existsSync(candidate.socketPath)).toBe(true);
        expect(readRuntimePairing()).toEqual(original);
        expect(await isGrantActive(existing.socketPath)).toBe(true);
      } finally {
        await rebound.close();
      }
    } finally {
      existing.close();
    }
  });

  test('an acknowledged shutdown that leaves its exact socket behind is a combined cleanup failure', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    const lingering = await startShutdownFixture('ack-and-linger');
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      const failure = await registerRuntimePairing(USER_B, 'credential_runtime_lingering', {
        socketPath: lingering.socketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      const [registrationError, cleanupError] = (failure as AggregateError).errors;
      expect(registrationError).toBeInstanceOf(CapyError);
      expect((registrationError as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
      expect(String(cleanupError)).toContain('socket remained after shutdown');
      expect(existsSync(lingering.socketPath)).toBe(true);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(existing.socketPath)).toBe(true);
    } finally {
      existing.close();
      await lingering.close();
    }
  }, 10_000);

  test('malformed or missing shutdown acknowledgement preserves the registration error first', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      for (const behavior of ['malformed', 'missing-ack'] as const) {
        const candidate = await startShutdownFixture(behavior);
        try {
          const failure = await registerRuntimePairing(USER_B, `credential_runtime_${behavior}`, {
            socketPath: candidate.socketPath,
            expiresAt: 0,
          }).then(() => null).catch((error: unknown) => error);

          expect(failure).toBeInstanceOf(AggregateError);
          const [registrationError, cleanupError] = (failure as AggregateError).errors;
          expect(registrationError).toBeInstanceOf(CapyError);
          expect((registrationError as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
          expect(String(cleanupError)).toContain(
            behavior === 'malformed' ? 'invalid shutdown response' : 'without acknowledging shutdown',
          );
          expect(readRuntimePairing()).toEqual(original);
          expect(await isGrantActive(existing.socketPath)).toBe(true);
        } finally {
          await candidate.close();
        }
      }
    } finally {
      existing.close();
    }
  });

  test('a newline acknowledgement split across socket chunks still completes exact cleanup', async () => {
    const existing = createGrantDaemonServer(
      { userId: USER_A, credentialId: CREDENTIAL_A, kLocal: K_LOCAL },
      null,
    );
    const candidate = await startShutdownFixture('split-ack');
    await listenGrantDaemonServer(existing.server, existing.socketPath);
    try {
      const original = await registerRuntimePairing(USER_A, CREDENTIAL_A, existing);
      const failure = await registerRuntimePairing(USER_B, 'credential_runtime_split_ack', {
        socketPath: candidate.socketPath,
        expiresAt: 0,
      }).then(() => null).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CapyError);
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect((failure as CapyError).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
      expect(existsSync(candidate.socketPath)).toBe(false);
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(existing.socketPath)).toBe(true);
    } finally {
      existing.close();
      await candidate.close();
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
      expect(foreignHolder).toBeInstanceOf(AggregateError);
      const [foreignRegistrationError, foreignOwnershipError] = (foreignHolder as AggregateError).errors;
      expect(foreignRegistrationError).toBeInstanceOf(CapyError);
      expect((foreignRegistrationError as CapyError).code).toBe(ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND);
      expect(String(foreignOwnershipError)).toContain('did not confirm cleanup ownership');
      expect(readRuntimePairing()).toEqual(original);
      expect(await isGrantActive(foreign.socketPath)).toBe(true);
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
