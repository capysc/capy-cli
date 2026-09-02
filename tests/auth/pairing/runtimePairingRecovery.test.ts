/**
 * Provider-neutral runtime-pairing recovery.
 *
 * The suite writes only metadata below a mocked temporary Capy home. The
 * already-live case uses the production Unix-socket identity protocol; the
 * recovery failure and arbitration cases inject holders so every refusal and
 * cleanup edge remains deterministic and no key bytes leave this process.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-runtime-recovery-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

import {
  getRuntimePairingPath,
  readRuntimePairing,
  recoverRuntimePairingFromCustody,
  type RecoveryGrantMaterial,
  type RuntimePairingRecordV1,
  type RuntimePairingRecordV2,
  type RuntimePairingRecoveryDependencies,
} from '../../../src/auth/pairing/runtimePairing';
import {
  createGrantDaemonServer,
  listenGrantDaemonServer,
} from '../../../src/auth/deviceKey/grantHolder';
import { getGlobalCapyDir } from '../../../src/config/globalConfig';
import type { PairAttemptLease } from '../../../src/auth/pairing/pairAttemptLease';
import type {
  RuntimeCustodyEnvironment,
  RuntimeCustodyProvider,
  RuntimeCustodyProviderResolver,
} from '../../../src/auth/pairing/runtimeCustodyProvider';
import { CapyError, ERROR_CODES } from '../../../src/types/index';

const USER_ID = 'user_runtime_recovery';
const OTHER_USER_ID = 'user_runtime_recovery_other';
const CREDENTIAL_ID = 'credential_runtime_recovery';
const ENVIRONMENT: RuntimeCustodyEnvironment = 'development';
const OLD_SOCKET = join(tempHome, 'dead-runtime-holder.sock');
const CANDIDATE_SOCKET = join(tempHome, 'candidate-runtime-holder.sock');
const WINNER_SOCKET = join(tempHome, 'winner-runtime-holder.sock');
const OPAQUE_HANDLE = 'runtime-recovery-provider-entry';
const PAIRED_AT = '2026-09-02T12:34:56.000Z';
const K_LOCAL = Uint8Array.from({ length: 32 }, () => 0x6d);

const BASE_RECORD: RuntimePairingRecordV2 = {
  version: 2,
  userId: USER_ID,
  credentialId: CREDENTIAL_ID,
  socketPath: OLD_SOCKET,
  expiresAt: 0,
  pairedAt: PAIRED_AT,
  custody: {
    providerKind: 'orchestrator-secret-store',
    environment: ENVIRONMENT,
    userId: USER_ID,
    opaqueHandle: OPAQUE_HANDLE,
  },
};

const TEST_LEASE: PairAttemptLease = {
  version: 1,
  pid: process.pid,
  startedAt: PAIRED_AT,
  nonce: 'runtime-recovery-test-lease',
  path: join(tempHome, 'runtime-recovery-test-lease.json'),
};

function writeRecord(record: unknown): void {
  mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true, mode: 0o700 });
  writeFileSync(getRuntimePairingPath(), JSON.stringify(record, null, 2), { mode: 0o600 });
}

function createProvider(
  unsealImplementation: RuntimeCustodyProvider['unseal'] = async () => Uint8Array.from(K_LOCAL),
): {
  readonly provider: RuntimeCustodyProvider;
  readonly unseal: ReturnType<typeof mock<RuntimeCustodyProvider['unseal']>>;
} {
  const unseal = mock<RuntimeCustodyProvider['unseal']>(unsealImplementation);
  return {
    provider: {
      kind: 'orchestrator-secret-store',
      seal: async () => ({ opaqueHandle: OPAQUE_HANDLE }),
      unseal,
      delete: async () => undefined,
    },
    unseal,
  };
}

function request(
  resolveProvider: RuntimeCustodyProviderResolver,
  overrides: {
    readonly environment?: RuntimeCustodyEnvironment;
    readonly expectedUserId?: string;
  } = {},
): {
  readonly environment: RuntimeCustodyEnvironment;
  readonly expectedUserId: string;
  readonly resolveProvider: RuntimeCustodyProviderResolver;
} {
  return {
    environment: overrides.environment ?? ENVIRONMENT,
    expectedUserId: overrides.expectedUserId ?? USER_ID,
    resolveProvider,
  };
}

function isolatedLeaseDependencies(
  overrides: Omit<
    RuntimePairingRecoveryDependencies,
    'acquireLease' | 'ownsLease' | 'releaseLease'
  > = {},
  ownsLeaseImplementation: (lease: PairAttemptLease) => boolean = () => true,
): RuntimePairingRecoveryDependencies & {
  readonly acquireLease: ReturnType<typeof mock<() => PairAttemptLease>>;
  readonly ownsLease: ReturnType<typeof mock<(lease: PairAttemptLease) => boolean>>;
  readonly releaseLease: ReturnType<typeof mock<(lease: PairAttemptLease) => boolean>>;
} {
  const acquireLease = mock(() => TEST_LEASE);
  const ownsLease = mock(ownsLeaseImplementation);
  const releaseLease = mock((_lease: PairAttemptLease) => true);
  return { ...overrides, acquireLease, ownsLease, releaseLease };
}

beforeEach(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

describe('runtime pairing custody recovery', () => {
  test('missing and v1 metadata remain legacy outcomes without provider or lease access', async () => {
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => {
      throw new Error('provider must remain untouched');
    });
    const acquireLease = mock<() => PairAttemptLease>(() => {
      throw new Error('lease must remain untouched');
    });
    const dependencies = { acquireLease };

    expect(await recoverRuntimePairingFromCustody(request(resolveProvider), dependencies))
      .toEqual({ kind: 'not_v2' });

    const v1: RuntimePairingRecordV1 = {
      version: 1,
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      socketPath: OLD_SOCKET,
      expiresAt: 0,
      pairedAt: PAIRED_AT,
    };
    writeRecord(v1);
    expect(await recoverRuntimePairingFromCustody(request(resolveProvider), dependencies))
      .toEqual({ kind: 'not_v2' });
    expect(readRuntimePairing()).toEqual(v1);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
  });

  test('invalid metadata is refused and preserved byte-for-byte', async () => {
    const invalid = JSON.stringify({ ...BASE_RECORD, custody: { ...BASE_RECORD.custody, userId: OTHER_USER_ID } });
    mkdirSync(join(getGlobalCapyDir(), 'auth'), { recursive: true, mode: 0o700 });
    writeFileSync(getRuntimePairingPath(), invalid, { mode: 0o600 });
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => null);
    const acquireLease = mock<() => PairAttemptLease>(() => TEST_LEASE);

    await expect(recoverRuntimePairingFromCustody(request(resolveProvider), { acquireLease }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(readFileSync(getRuntimePairingPath(), 'utf8')).toBe(invalid);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
  });

  test('a live v2 holder returns active through the real identity socket without provider or lease access', async () => {
    const holder = createGrantDaemonServer(
      { userId: USER_ID, credentialId: CREDENTIAL_ID, kLocal: Buffer.from(K_LOCAL) },
      null,
    );
    await listenGrantDaemonServer(holder.server, holder.socketPath);
    const liveRecord = { ...BASE_RECORD, socketPath: holder.socketPath };
    writeRecord(liveRecord);
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => {
      throw new Error('provider must remain untouched');
    });
    const acquireLease = mock<() => PairAttemptLease>(() => {
      throw new Error('lease must remain untouched');
    });
    try {
      expect(await recoverRuntimePairingFromCustody(request(resolveProvider), { acquireLease }))
        .toEqual({ kind: 'active', record: liveRecord });
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(acquireLease).not.toHaveBeenCalled();
    } finally {
      holder.close();
    }
  });

  test('wrong user, environment, provider, and expired metadata fail closed before recovery', async () => {
    const providerFixture = createProvider();
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => providerFixture.provider);
    const neverSpawn = mock(async (_material: RecoveryGrantMaterial) => {
      throw new Error('spawn must remain untouched');
    });
    const probeHolder = mock(async () => false);

    writeRecord(BASE_RECORD);
    await expect(recoverRuntimePairingFromCustody(
      request(resolveProvider, { expectedUserId: OTHER_USER_ID }),
      { probeHolder, spawnHolder: neverSpawn },
    )).rejects.toMatchObject({ code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH });

    writeRecord(BASE_RECORD);
    await expect(recoverRuntimePairingFromCustody(
      request(resolveProvider, { environment: 'staging' }),
      { probeHolder, spawnHolder: neverSpawn },
    )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });

    const expired = { ...BASE_RECORD, expiresAt: 10 };
    writeRecord(expired);
    await expect(recoverRuntimePairingFromCustody(
      request(resolveProvider),
      { now: () => 10, probeHolder, spawnHolder: neverSpawn },
    )).rejects.toMatchObject({ code: ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED });

    writeRecord(BASE_RECORD);
    const wrongKindProvider: RuntimeCustodyProvider = {
      ...providerFixture.provider,
      kind: 'os-secure-store',
    };
    const wrongKindResolver = mock<RuntimeCustodyProviderResolver>(() => wrongKindProvider);
    const leaseDependencies = isolatedLeaseDependencies({ probeHolder, spawnHolder: neverSpawn });
    await expect(recoverRuntimePairingFromCustody(
      request(wrongKindResolver),
      leaseDependencies,
    )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });

    expect(providerFixture.unseal).not.toHaveBeenCalled();
    expect(neverSpawn).not.toHaveBeenCalled();
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
  });

  test('a dead v2 record recovers and preserves every field except its socket address', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const resolveProvider = mock<RuntimeCustodyProviderResolver>((kind) =>
      kind === providerFixture.provider.kind ? providerFixture.provider : null
    );
    const probeHolder = mock(async (socketPath: string) => socketPath === CANDIDATE_SOCKET);
    const spawnHolder = mock(async (_material: RecoveryGrantMaterial) => ({
      socketPath: CANDIDATE_SOCKET,
      expiresAt: 0,
    }));
    const dependencies = isolatedLeaseDependencies({ probeHolder, spawnHolder });

    const outcome = await recoverRuntimePairingFromCustody(request(resolveProvider), dependencies);
    const recovered = { ...BASE_RECORD, socketPath: CANDIDATE_SOCKET };
    expect(outcome).toEqual({ kind: 'recovered', record: recovered });
    expect(readRuntimePairing()).toEqual(recovered);
    expect(readFileSync(getRuntimePairingPath(), 'utf8'))
      .not.toContain(Buffer.from(K_LOCAL).toString('base64'));
    expect(providerFixture.unseal).toHaveBeenCalledTimes(1);
    expect(providerFixture.unseal).toHaveBeenCalledWith({
      environment: ENVIRONMENT,
      userId: USER_ID,
      opaqueHandle: OPAQUE_HANDLE,
    });
    expect(spawnHolder).toHaveBeenCalledWith({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      kLocal: K_LOCAL,
    });
    expect(dependencies.acquireLease).toHaveBeenCalledTimes(1);
    expect(dependencies.releaseLease).toHaveBeenCalledWith(TEST_LEASE);
  });

  test('provider wipe and invalid provider output preserve metadata and never spawn', async () => {
    const providerWiped = new CapyError('provider entry was wiped', ERROR_CODES.PERMISSION_DENIED);
    const wipedFixture = createProvider(async () => {
      throw providerWiped;
    });
    const spawnHolder = mock(async (_material: RecoveryGrantMaterial) => ({
      socketPath: CANDIDATE_SOCKET,
      expiresAt: 0,
    }));
    const probeHolder = mock(async () => false);

    writeRecord(BASE_RECORD);
    await expect(recoverRuntimePairingFromCustody(
      request(() => wipedFixture.provider),
      isolatedLeaseDependencies({ probeHolder, spawnHolder }),
    )).rejects.toBe(providerWiped);
    expect(readRuntimePairing()).toEqual(BASE_RECORD);

    const invalidFixture = createProvider(async () => Uint8Array.from([1, 2, 3]));
    writeRecord(BASE_RECORD);
    await expect(recoverRuntimePairingFromCustody(
      request(() => invalidFixture.provider),
      isolatedLeaseDependencies({ probeHolder, spawnHolder }),
    )).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
    expect(spawnHolder).not.toHaveBeenCalled();
  });

  test('spawn failure preserves metadata and still releases the recovery lease', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const spawnFailure = new Error('candidate spawn failed');
    const spawnHolder = mock(async (_material: RecoveryGrantMaterial) => {
      throw spawnFailure;
    });
    const dependencies = isolatedLeaseDependencies({
      probeHolder: async () => false,
      spawnHolder,
    });

    await expect(recoverRuntimePairingFromCustody(
      request(() => providerFixture.provider),
      dependencies,
    )).rejects.toBe(spawnFailure);
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
    expect(dependencies.releaseLease).toHaveBeenCalledWith(TEST_LEASE);
  });

  test('a candidate that fails the exact identity probe is cleaned up under the recorded identity', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const cleanupCandidate = mock(async (
      _socketPath: string,
      _userId: string,
      _credentialId: string,
    ) => undefined);
    const dependencies = isolatedLeaseDependencies({
      probeHolder: async () => false,
      spawnHolder: async () => ({ socketPath: CANDIDATE_SOCKET, expiresAt: 0 }),
      cleanupCandidate,
    });

    await expect(recoverRuntimePairingFromCustody(
      request(() => providerFixture.provider),
      dependencies,
    )).rejects.toMatchObject({ code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND });
    expect(cleanupCandidate).toHaveBeenCalledTimes(1);
    expect(cleanupCandidate).toHaveBeenCalledWith(CANDIDATE_SOCKET, USER_ID, CREDENTIAL_ID);
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
  });

  test('a rejected candidate probe is cleaned up and preserves the probe error', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const probeFailure = new Error('candidate identity probe failed');
    const cleanupCandidate = mock(async (
      _socketPath: string,
      _userId: string,
      _credentialId: string,
    ) => undefined);
    const dependencies = isolatedLeaseDependencies({
      probeHolder: async (socketPath: string) => {
        if (socketPath === OLD_SOCKET) return false;
        throw probeFailure;
      },
      spawnHolder: async () => ({ socketPath: CANDIDATE_SOCKET, expiresAt: 0 }),
      cleanupCandidate,
    });

    await expect(recoverRuntimePairingFromCustody(
      request(() => providerFixture.provider),
      dependencies,
    )).rejects.toBe(probeFailure);
    expect(cleanupCandidate).toHaveBeenCalledWith(CANDIDATE_SOCKET, USER_ID, CREDENTIAL_ID);
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
  });

  test('a CAS loser cleans its candidate and reuses the live winner', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const winner = { ...BASE_RECORD, socketPath: WINNER_SOCKET };
    const cleanupCandidate = mock(async (
      _socketPath: string,
      _userId: string,
      _credentialId: string,
    ) => undefined);
    const compareAndSwapSocket = mock((
      _expected: RuntimePairingRecordV2,
      _replacement: RuntimePairingRecordV2,
    ) => {
      writeRecord(winner);
      return 'changed' as const;
    });
    const dependencies = isolatedLeaseDependencies({
      probeHolder: async (socketPath: string) =>
        socketPath === CANDIDATE_SOCKET || socketPath === WINNER_SOCKET,
      spawnHolder: async () => ({ socketPath: CANDIDATE_SOCKET, expiresAt: 0 }),
      cleanupCandidate,
      compareAndSwapSocket,
    });

    expect(await recoverRuntimePairingFromCustody(
      request(() => providerFixture.provider),
      dependencies,
    )).toEqual({ kind: 'reused', record: winner });
    expect(cleanupCandidate).toHaveBeenCalledWith(CANDIDATE_SOCKET, USER_ID, CREDENTIAL_ID);
    expect(readRuntimePairing()).toEqual(winner);
  });

  test('lease contention times out without touching provider custody', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const contention = new CapyError('pair already in progress', ERROR_CODES.PAIR_ALREADY_IN_PROGRESS);
    const acquireLease = mock<() => PairAttemptLease>(() => {
      throw contention;
    });
    const wait = mock(async (_milliseconds: number) => undefined);

    await expect(recoverRuntimePairingFromCustody(
      request(() => providerFixture.provider),
      {
        acquireLease,
        now: () => 1_000,
        wait,
        waitTimeoutMs: 0,
        probeHolder: async () => false,
      },
    )).rejects.toBe(contention);
    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(providerFixture.unseal).not.toHaveBeenCalled();
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
  });

  test('a stale or fabricated acquired lease is refused before provider I/O', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider();
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => providerFixture.provider);
    const spawnHolder = mock(async (_material: RecoveryGrantMaterial) => ({
      socketPath: CANDIDATE_SOCKET,
      expiresAt: 0,
    }));
    const dependencies = isolatedLeaseDependencies({
      probeHolder: async () => false,
      spawnHolder,
    }, () => false);

    await expect(recoverRuntimePairingFromCustody(
      request(resolveProvider),
      dependencies,
    )).rejects.toMatchObject({ code: ERROR_CODES.PAIR_ALREADY_IN_PROGRESS });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(providerFixture.unseal).not.toHaveBeenCalled();
    expect(spawnHolder).not.toHaveBeenCalled();
    expect(dependencies.releaseLease).toHaveBeenCalledWith(TEST_LEASE);
    expect(readRuntimePairing()).toEqual(BASE_RECORD);
  });

  test('two concurrent recoveries perform one unseal and one spawn', async () => {
    writeRecord(BASE_RECORD);
    const providerFixture = createProvider(async () => {
      await Bun.sleep(35);
      return Uint8Array.from(K_LOCAL);
    });
    const resolveProvider = mock<RuntimeCustodyProviderResolver>(() => providerFixture.provider);
    const spawnHolder = mock(async (_material: RecoveryGrantMaterial) => ({
      socketPath: CANDIDATE_SOCKET,
      expiresAt: 0,
    }));
    const dependencies: RuntimePairingRecoveryDependencies = {
      probeHolder: async (socketPath: string) => socketPath === CANDIDATE_SOCKET,
      spawnHolder,
    };

    const outcomes = await Promise.all([
      recoverRuntimePairingFromCustody(request(resolveProvider), dependencies),
      recoverRuntimePairingFromCustody(request(resolveProvider), dependencies),
    ]);

    expect(outcomes.map(({ kind }) => kind).toSorted()).toEqual(
      expect.arrayContaining(['recovered', expect.stringMatching(/^(active|reused)$/)]),
    );
    expect(outcomes.filter(({ kind }) => kind === 'recovered')).toHaveLength(1);
    expect(providerFixture.unseal).toHaveBeenCalledTimes(1);
    expect(spawnHolder).toHaveBeenCalledTimes(1);
    expect(readRuntimePairing()).toEqual({ ...BASE_RECORD, socketPath: CANDIDATE_SOCKET });
  });
});
