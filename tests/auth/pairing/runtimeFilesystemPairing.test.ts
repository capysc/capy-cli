import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

const home = mkdtempSync(join(tmpdir(), 'capy-filesystem-pair-'));
mock.module('os', () => ({ ...require('os'), homedir: () => home }));

import { getGlobalCapyDir, getLocalRootPath, saveLocalRootExclusive } from '../../../src/config/globalConfig';
import {
  clearRuntimePairing, getRuntimePairingPath, readRuntimePairing,
  recoverFilesystemRuntimePairing, registerFilesystemRuntimePairing,
  type RuntimePairingRecoveryDependencies, type RuntimePairingRecordV1,
} from '../../../src/auth/pairing/runtimePairing';
import { createGrantDaemonServer, listenGrantDaemonServer } from '../../../src/auth/deviceKey/grantHolder';

const userId = 'user_filesystem';
const orgId = 'org_custody';
const credentialId = 'credential_filesystem';
const key = Buffer.alloc(32, 0x45);
const request = { environment: 'development', expectedUserId: userId } as const;

beforeEach(() => { rmSync(getGlobalCapyDir(), { recursive: true, force: true }); });
afterAll(() => { mock.restore(); rmSync(home, { recursive: true, force: true }); });

function fixture(): RuntimePairingRecordV1 {
  saveLocalRootExclusive(orgId, key, userId);
  const record: RuntimePairingRecordV1 = {
    version: 1, userId, credentialId, socketPath: join(home, 'old.sock'), expiresAt: 0, pairedAt: '2026-09-06T00:00:00.000Z',
    filesystemCustody: { environment: 'development', orgId, path: getLocalRootPath(orgId, userId),
      sha256: createHash('sha256').update(key).digest('hex') },
  };
  mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true, mode: 0o700 });
  writeFileSync(getRuntimePairingPath(), JSON.stringify(record), { mode: 0o600 });
  return record;
}

function dependencies(overrides: RuntimePairingRecoveryDependencies = {}) {
  return {
    probeHolder: mock(async (path: string) => path === join(home, 'new.sock')),
    spawnHolder: mock(async (material: { readonly kLocal: Uint8Array }) => {
      expect(Buffer.from(material.kLocal)).toEqual(key);
      return { socketPath: join(home, 'new.sock'), expiresAt: 0 };
    }),
    cleanupCandidate: mock(async () => undefined),
    ...overrides,
  };
}

describe('filesystem-backed runtime pairing', () => {
  test('restores a lost holder from protected existing custody and preserves binding', async () => {
    const original = fixture();
    const deps = dependencies();
    const restored = await recoverFilesystemRuntimePairing(request, deps);
    expect(restored).toEqual({ ...original, socketPath: join(home, 'new.sock') });
    expect(readRuntimePairing()).toEqual(restored);
    expect(deps.spawnHolder).toHaveBeenCalledTimes(1);
    await recoverFilesystemRuntimePairing(request, deps);
    expect(deps.spawnHolder).toHaveBeenCalledTimes(1);
    expect(readFileSync(getRuntimePairingPath(), 'utf8')).not.toContain(key.toString('base64'));
  });

  test('logout removes the only restore authority while preserving the local key', async () => {
    fixture();
    await clearRuntimePairing();
    expect(existsSync(getLocalRootPath(orgId, userId))).toBe(true);
    const deps = dependencies();
    expect(await recoverFilesystemRuntimePairing(request, deps)).toBeNull();
    expect(deps.spawnHolder).not.toHaveBeenCalled();
  });

  test('concurrent callers reuse one restored holder', async () => {
    fixture();
    const spawnHolder = mock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { socketPath: join(home, 'new.sock'), expiresAt: 0 };
    });
    const deps = dependencies({ spawnHolder });
    const results = await Promise.all([recoverFilesystemRuntimePairing(request, deps),
      recoverFilesystemRuntimePairing(request, deps)]);
    expect(results[0]).toEqual(results[1]);
    expect(spawnHolder).toHaveBeenCalledTimes(1);
  });

  test('refuses wrong user and environment before spawning', async () => {
    fixture();
    const deps = dependencies();
    await expect(recoverFilesystemRuntimePairing({ ...request, expectedUserId: 'user_other' }, deps)).rejects.toThrow();
    await expect(recoverFilesystemRuntimePairing({ ...request, environment: 'staging' }, deps)).rejects.toThrow();
    expect(deps.spawnHolder).not.toHaveBeenCalled();
  });

  for (const defect of ['missing', 'corrupt', 'different-key', 'permissions', 'symlink'] as const) {
    test(`refuses ${defect} custody without modifying the runtime record`, async () => {
      const record = fixture();
      const path = getLocalRootPath(orgId, userId);
      if (defect === 'missing') rmSync(path);
      if (defect === 'corrupt') writeFileSync(path, 'not a key');
      if (defect === 'different-key') writeFileSync(path, Buffer.alloc(32, 1).toString('base64'));
      if (defect === 'permissions') chmodSync(path, 0o644);
      if (defect === 'symlink') {
        rmSync(path);
        symlinkSync(join(home, 'missing-target'), path);
      }
      const deps = dependencies();
      await expect(recoverFilesystemRuntimePairing(request, deps)).rejects.toThrow();
      expect(deps.spawnHolder).not.toHaveBeenCalled();
      expect(readRuntimePairing()).toEqual(record);
    });
  }

  test('refuses a relocated binding and malformed metadata', async () => {
    const record = fixture();
    writeFileSync(getRuntimePairingPath(), JSON.stringify({ ...record,
      filesystemCustody: { ...record.filesystemCustody, path: join(home, 'other.key') } }));
    await expect(recoverFilesystemRuntimePairing(request, dependencies())).rejects.toThrow();
    writeFileSync(getRuntimePairingPath(), '{}');
    await expect(recoverFilesystemRuntimePairing(request, dependencies())).rejects.toThrow();
  });

  test('cleans a wrong-identity replacement and leaves the original binding intact', async () => {
    const record = fixture();
    const cleanupCandidate = mock(async () => undefined);
    await expect(recoverFilesystemRuntimePairing(request, dependencies({
      probeHolder: async () => false, cleanupCandidate,
    }))).rejects.toThrow();
    expect(cleanupCandidate).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toEqual(record);
  });

  test('never republishes a binding removed during restore', async () => {
    fixture();
    const cleanupCandidate = mock(async () => undefined);
    await expect(recoverFilesystemRuntimePairing(request, dependencies({
      spawnHolder: async () => {
        rmSync(getRuntimePairingPath());
        return { socketPath: join(home, 'new.sock'), expiresAt: 0 };
      }, cleanupCandidate,
    }))).rejects.toThrow();
    expect(readRuntimePairing()).toBeNull();
    expect(cleanupCandidate).toHaveBeenCalledTimes(1);
  });

  test('publishes filesystem binding against a real identity-verified holder', async () => {
    const holder = createGrantDaemonServer({ userId, credentialId, kLocal: key }, null);
    const socketPath = holder.socketPath;
    await listenGrantDaemonServer(holder.server, socketPath);
    try {
      const record = await registerFilesystemRuntimePairing('development', orgId,
        { userId, credentialId, kLocal: key }, { socketPath, expiresAt: 0 });
      expect(record.filesystemCustody?.path).toBe(getLocalRootPath(orgId, userId));
      expect(readRuntimePairing()).toEqual(record);
    } finally { holder.close(); }
  });

  test('a fresh CLI process restores a holder and obtains the key without another ceremony', async () => {
    const record = fixture();
    // The fresh process explicitly uses a disposable development home.
    const childHome = join(home, '.capy-dev');
    const childKey = join(childHome, 'orgs', orgId, 'users', userId, 'local.key');
    mkdirSync(join(childHome, 'orgs', orgId, 'users', userId), { recursive: true, mode: 0o700 });
    writeFileSync(childKey, key.toString('base64'), { mode: 0o600 });
    mkdirSync(join(childHome, 'auth'), { recursive: true, mode: 0o700 });
    writeFileSync(join(childHome, 'auth', 'runtime-pair.json'), JSON.stringify({ ...record,
      filesystemCustody: { ...record.filesystemCustody, path: childKey } }), { mode: 0o600 });
    const sourceRoot = join(import.meta.dir, '../../../src');
    const script = `
      import { recoverFilesystemRuntimePairing, clearRuntimePairing } from ${JSON.stringify(join(sourceRoot, 'auth/pairing/runtimePairing.ts'))};
      import { spawnGrantDaemon, fetchGrantedKLocal } from ${JSON.stringify(join(sourceRoot, 'auth/deviceKey/grantHolder.ts'))};
      const record = await recoverFilesystemRuntimePairing(${JSON.stringify(request)}, {
        spawnHolder: (material) => spawnGrantDaemon({ ...material, kLocal: Buffer.from(material.kLocal) },
          { ttlMs: null, persistRuntimePairing: false, scriptPath: ${JSON.stringify(join(sourceRoot, 'index.ts'))} }),
      });
      try {
        const material = await fetchGrantedKLocal(record.socketPath, ${JSON.stringify(userId)});
        console.log(JSON.stringify({ restored: Boolean(record), correctKey: material.kLocal.equals(Buffer.alloc(32, 0x45)) }));
      } finally { await clearRuntimePairing(); }
    `;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      env: { ...process.env, HOME: home, CAPY_GLOBAL_DIR_NAME: '.capy-dev', CAPY_DEVICE_KEY_GRANT_SOCKET: '' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ restored: true, correctKey: true });
    expect(stdout).not.toContain(key.toString('base64'));
    expect(existsSync(getLocalRootPath(orgId, userId))).toBe(true);
  });
});
