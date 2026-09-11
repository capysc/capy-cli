/**
 * PairCommand orchestration tests. All effects are isolated behind Bun mocks;
 * call-history projections are immutable and no fixture touches real custody.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const registerFilesystemPairing = mock(async (..._args: readonly unknown[]) => undefined);
mock.module('../../src/config/profileConfig', () => ({ resolveActiveUrl: () => 'https://api.test.invalid' }));
const assertRuntimePairingUserImpl = mock((_userId: string): unknown => null);
mock.module('../../src/auth/pairing/runtimePairing', () => ({
  assertRuntimePairingUser: assertRuntimePairingUserImpl,
  readActiveRuntimePairing: async () => null,
  readRuntimePairing: () => null,
  recoverFilesystemRuntimePairingWhileLeaseHeld: async () => null,
  registerFilesystemRuntimePairing: registerFilesystemPairing,
}));
// `capy pair` now probes the ordinary silent path before any ceremony
// (CAP-646). The default answer is "no session", which is what every
// device-authorization test below assumes; the reuse tests override it.
const silentAuthImpl = mock(async (_organizationId?: string): Promise<any> => ({
  success: false, error_code: 'no_session', error: 'Not signed in',
}));
const sessionOrgIdImpl = mock((): string | null => null);
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    constructor(..._args: readonly unknown[]) {}
    authenticateSilent(organizationId?: string) { return silentAuthImpl(organizationId); }
    getOrganizationId() { return sessionOrgIdImpl(); }
  },
}));
mock.module('../../src/auth/pairing/pairAttemptLease', () => ({
  acquirePairAttemptLease: () => ({ version: 1, pid: 4242, startedAt: '2026-09-01T00:00:00.000Z',
    nonce: 'pair-command-test', path: '/tmp/pair-command-test.json' }),
  releasePairAttemptLease: () => true,
}));
mock.module('../../src/ui/openScreen', () => ({
  openScreen: mock(async () => ({ via: 'suppressed' as const })),
}));
const AUTHORIZATION = {
  device_code: 'dc_test', user_code: 'ABCD-1234',
  verification_uri: 'https://auth.test.invalid/device',
  verification_uri_complete: 'https://auth.test.invalid/device?user_code=ABCD-1234&code=provider-state',
  expires_in: 300, interval: 5,
};
const ceremonyImpl = mock(async (_opts: any): Promise<any> => { throw new Error('Ceremony not configured'); });
const authorizeImpl = mock(async (): Promise<any> => AUTHORIZATION);
mock.module('../../src/auth/pairing/deviceAuth', () => ({
  startDeviceAuthorization: authorizeImpl,
  deviceVerificationUrl: (authorization: typeof AUTHORIZATION) =>
    authorization.verification_uri_complete?.trim() || authorization.verification_uri,
  deviceVerificationHandoff: (authorization: typeof AUTHORIZATION) => {
    const complete = authorization.verification_uri_complete?.trim();
    return complete
      ? { url: complete, userCode: authorization.user_code, codePrefilled: true }
      : { url: authorization.verification_uri, userCode: authorization.user_code, codePrefilled: false };
  },
  awaitDeviceApproval: async (_url: string, authorization: any) => ceremonyImpl({ authorization }),
}));
const installImpl = mock(async (_session: any, _opts: any): Promise<any> => ({ orgId: null, orgTokenReady: false }));
mock.module('../../src/auth/pairing/installPairedSession', () => ({ installPairedSession: installImpl }));
const installationBaseline = { expectedUserId: null, authorities: [] } as const;
const captureInstallationImpl = mock((_userId: string | null) => installationBaseline);
mock.module('../../src/auth/pairing/pairedSessionInstallation', () => ({
  capturePairedSessionInstallationBaseline: captureInstallationImpl,
}));
const resolveKeyMaterialImpl = mock(async (_answer: any, _opts: any): Promise<any> => ({
  ok: true, material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) },
}));
mock.module('../../src/auth/pairing/pairDeviceGrant', () => ({
  grantKeyMaterialForPairedMachine: async (opts: any) => resolveKeyMaterialImpl(null, opts),
}));
const spawnResult = { socketPath: '/tmp/fake.sock', expiresAt: 0, pid: 4242 };
const spawnImpl = mock(async (_material: any, _opts: any) => spawnResult);
mock.module('../../src/auth/deviceKey/grantHolder', () => ({
  spawnGrantDaemon: spawnImpl, GRANT_SOCKET_ENV_VAR: 'CAPY_DEVICE_KEY_GRANT_SOCKET',
}));
class ExitError extends Error {
  constructor(public readonly code: number) { super(`exit:${code}`); }
}
spyOn(process, 'exit').mockImplementation((code) => { throw new ExitError(Number(code ?? 0)); });
const { PairCommand } = await import('../../src/commands/pairCommand');
const { ERROR_CODES } = await import('../../src/types/index');
const logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
const originalEnvironment = process.env;
const originalStdout = process.stdout;
const envSpy = spyOn(process, 'env', 'get');
const stdoutSpy = spyOn(process, 'stdout', 'get');
const mockEnvironment = (values: Readonly<Record<string, string>>) => envSpy.mockReturnValue({
  ...Object.fromEntries(Object.entries(originalEnvironment).filter(([key]) => !['CAPY_DEVICE_KEYS', 'NO_COLOR'].includes(key))),
  ...values,
});
const terminal = (isTTY: boolean | undefined, columns = 80, rows = 24) =>
  stdoutSpy.mockReturnValue(Object.create(originalStdout, {
    isTTY: { value: isTTY }, columns: { value: columns }, rows: { value: rows },
  }));
const logs = (): readonly string[] => logSpy.mock.calls.map((args) => args.map(String).join(' '));
const errs = (): readonly string[] => errorSpy.mock.calls.map((args) => args.map(String).join(' '));
const ceremonyCalls = () => ceremonyImpl.mock.calls.map(([options]) => options);
const installCalls = () => installImpl.mock.calls.map(([session, opts]) => ({ session, opts }));
const resolveKeyMaterialCalls = () => resolveKeyMaterialImpl.mock.calls.map(([answer, opts]) => ({ answer, opts }));
const spawnCalls = () => spawnImpl.mock.calls.map(([material, opts]) => ({ material, opts }));
afterAll(() => { mock.restore(); });

const VALID_ANSWER = {
  v: 1 as const,
  flow: 'pair' as const,
  ceremony: 'machine-pair' as const,
  session: {
    user: { id: 'user_1', email: 'u@example.com' },
    refresh_token: 'rt_1',
    organizations: [{ id: 'org_1', name: 'Org One' }],
  },
  keyMaterial: {
    orgId: 'org_1',
    prfOutput: Buffer.alloc(32, 3).toString('base64'),
    credentialId: 'cred_1',
  },
};


beforeEach(() => {
  for (const call of [ceremonyImpl, authorizeImpl, installImpl, captureInstallationImpl, resolveKeyMaterialImpl, spawnImpl,
    registerFilesystemPairing, silentAuthImpl, sessionOrgIdImpl, assertRuntimePairingUserImpl,
    logSpy, errorSpy]) call.mockClear();
  silentAuthImpl.mockImplementation(async () => ({
    success: false, error_code: 'no_session', error: 'Not signed in',
  }));
  sessionOrgIdImpl.mockImplementation(() => null);
  assertRuntimePairingUserImpl.mockImplementation(() => null);
  authorizeImpl.mockImplementation(async () => AUTHORIZATION);
  captureInstallationImpl.mockImplementation(() => installationBaseline);
  installImpl.mockImplementation(async () => ({ orgId: 'org_1', orgName: 'Org One', orgTokenReady: true }));
  resolveKeyMaterialImpl.mockImplementation(async () => ({
    ok: true, material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) },
  }));
  registerFilesystemPairing.mockImplementation(async () => undefined);
  mockEnvironment({ CAPY_DEVICE_KEYS: '1' });
  stdoutSpy.mockReturnValue(originalStdout);
});

test('captures the installation baseline before provider authorization and passes the identical baseline to install', async () => {
  authorizeImpl.mockImplementation(async () => {
    expect(captureInstallationImpl).toHaveBeenCalledTimes(1);
    return AUTHORIZATION;
  });
  ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
  expect(await new PairCommand().execute({ json: true })).toBe(0);
  expect(installCalls()[0].opts.installationBaseline).toBe(installationBaseline);
});

test('refuses unavailable authority before starting the device provider', async () => {
  captureInstallationImpl.mockImplementation(() => { throw new Error('AUTH_REFRESH_AUTHORITY_INDETERMINATE'); });
  expect(await new PairCommand().execute({ json: true })).toBe(1);
  expect(authorizeImpl).not.toHaveBeenCalled();
  expect(installImpl).not.toHaveBeenCalled();
  expect(resolveKeyMaterialImpl).not.toHaveBeenCalled();
  expect(spawnImpl).not.toHaveBeenCalled();
});

describe('PairCommand — rail always on', () => {
  test('runs the ceremony even with the legacy env flag unset', async () => {
    // Permanently ON as of onboarding v2 — the env var is no longer
    // consulted (src/auth/deviceKey/flag.ts).
    mockEnvironment({});
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    await new PairCommand().execute({});
    expect(ceremonyCalls().length).toBeGreaterThan(0);
    expect(installCalls().length).toBe(1);
  });
});

describe('PairCommand — already-active runtime', () => {
  test('classifies silent refresh outcomes without confusing provider failure with reauthentication', async () => {
    const { ensureActiveRuntimePairingSession } = await import('../../src/commands/pairCommand');
    const active = {
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    };
    const outcomeFor = (result: unknown) => ensureActiveRuntimePairingSession(
      active,
      'https://api.test.invalid',
      true,
      () => ({ authenticateSilent: async () => result as any }),
    );

    expect(await outcomeFor({ success: true, user_id: 'user_1' })).toEqual({ kind: 'ready' });
    expect(await outcomeFor({ success: true, user_id: 'user_2' })).toEqual({
      kind: 'failed',
      code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
      detail: 'The authenticated session does not match the account paired to this runtime.',
    });
    expect(await outcomeFor({
      success: false,
      error: 'Session expired — sign-in required',
      error_code: 'session_ended',
    })).toEqual({ kind: 'reauthenticate' });
    expect(await outcomeFor({
      success: false,
      error: 'Could not reach the Capy service to refresh your session',
      error_code: 'network',
    })).toEqual({
      kind: 'failed',
      code: ERROR_CODES.NETWORK_ERROR,
      detail: 'Could not reach the Capy service to refresh your session',
    });
    expect(await outcomeFor({
      success: false,
      error: 'Token refresh failed (HTTP 503)',
      error_code: 'server_error',
    })).toEqual({
      kind: 'failed',
      code: ERROR_CODES.SERVICE_ERROR,
      detail: 'Token refresh failed (HTTP 503)',
    });
    expect(await outcomeFor({
      success: false,
      error: 'Organization not found while refreshing your session',
      error_code: 'org_not_found',
    })).toEqual({
      kind: 'failed',
      code: ERROR_CODES.ORG_NOT_FOUND,
      detail: 'Organization not found while refreshing your session',
    });
  });

  test('--json returns a coded success without starting either human ceremony', async () => {
    const expiresAt = Date.now() + 600_000;
    const readActivePairing = async () => ({
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt,
    });
    const ensureActiveSession = async () => ({ kind: 'ready' as const });

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    const parsed = JSON.parse(logs().join('\n'));
    expect(parsed).toEqual({
      ok: true,
      code: ERROR_CODES.RUNTIME_PAIR_ALREADY_ACTIVE,
      alreadyActive: true,
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      envVar: 'CAPY_DEVICE_KEY_GRANT_SOCKET',
    });
    expect(exitCode).toBe(0);
    expect(ceremonyCalls()).toEqual([]);
    expect(installCalls()).toEqual([]);
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
    expect(logs().join('\n')).not.toContain('ABCD-1234');
  });

  test('an ended session re-runs device authorization but preserves the live key daemon', async () => {
    const active = {
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    };
    const readActivePairing = async () => active;
    const ensureActiveSession = async () => ({ kind: 'reauthenticate' as const });
    ceremonyImpl.mockImplementation(async () => ({
      status: 'complete',
      session: {
        ...VALID_ANSWER.session,
        user: { id: 'user_1', email: 'updated-address@example.com' },
      },
    }));

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    const parsed = JSON.parse(logs().slice(jsonStart).join('\n'));
    expect(parsed).toEqual({
      ok: true,
      code: ERROR_CODES.RUNTIME_PAIR_ALREADY_ACTIVE,
      alreadyActive: true,
      userId: 'user_1',
      userEmail: 'updated-address@example.com',
      socketPath: '/tmp/already-active.sock',
      envVar: 'CAPY_DEVICE_KEY_GRANT_SOCKET',
      sessionRefreshed: true,
    });
    expect(logs().join('\n')).toContain('updated-address@example.com');
    expect(captureInstallationImpl).toHaveBeenCalledWith('user_1');
    expect(installCalls()[0].opts.installationBaseline).toBe(installationBaseline);
    expect(ceremonyCalls().length).toBe(1);
    expect(installCalls().length).toBe(1);
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test('a different WorkOS account is refused before session install and cannot inherit the live daemon', async () => {
    const active = {
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    };
    const readActivePairing = async () => active;
    const ensureActiveSession = async () => ({ kind: 'reauthenticate' as const });
    const releasePairAttempt = mock(() => true);
    const wrongAccountSession = {
      ...VALID_ANSWER.session,
      user: { id: 'user_2', email: 'other@example.com' },
    };
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: wrongAccountSession }));

    const exitCode = await new PairCommand(undefined, false, {
      readActivePairing,
      ensureActiveSession,
      releasePairAttempt,
    })
      .execute({ json: true });

    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    expect(JSON.parse(logs().slice(jsonStart).join('\n'))).toEqual({
      ok: false,
      code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
      detail: 'The authenticated account does not match the account paired to this runtime. Sign in with the paired account or run `capy logout` first.',
      userCode: 'ABCD-1234',
    });
    expect(installCalls()).toEqual([]);
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
    expect(logs().join('\n')).not.toContain('other@example.com');
    expect(exitCode).toBe(1);
    expect(releasePairAttempt).toHaveBeenCalledTimes(1);
  });

  test('a daemon lost during reauthentication falls back to a complete pair instead of announcing a stale socket', async () => {
    const active = {
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    };
    const readActivePairing = mock(async () =>
      readActivePairing.mock.calls.length === 1 ? active : null
    );
    const ensureActiveSession = async () => ({ kind: 'reauthenticate' as const });
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    const parsed = JSON.parse(logs().slice(jsonStart).join('\n'));
    expect(captureInstallationImpl).toHaveBeenCalledWith('user_1');
    expect(installCalls()[0].opts.installationBaseline).toBe(installationBaseline);
    expect(parsed).toMatchObject({
      ok: true,
      userId: 'user_1',
      socketPath: '/tmp/fake.sock',
    });
    expect(parsed).not.toHaveProperty('sessionRefreshed');
    expect(exitCode).toBe(0);
    expect(readActivePairing).toHaveBeenCalledTimes(2);
    expect(resolveKeyMaterialCalls().length).toBe(1);
    expect(spawnCalls().length).toBe(1);
  });

  test('a refresh transport failure stays coded and does not open WorkOS', async () => {
    const readActivePairing = async () => ({
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    });
    const ensureActiveSession = async () => ({
      kind: 'failed' as const,
      code: ERROR_CODES.NETWORK_ERROR,
      detail: 'Could not reach the Capy service to refresh your session',
    });

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    expect(JSON.parse(logs().join('\n'))).toEqual({
      ok: false,
      code: ERROR_CODES.NETWORK_ERROR,
      detail: 'Could not reach the Capy service to refresh your session',
    });
    expect(ceremonyCalls()).toEqual([]);
    expect(installCalls()).toEqual([]);
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
    expect(exitCode).toBe(1);
  });

  test('a refreshed-session install failure is atomic at the command boundary and never regrants key material', async () => {
    const active = {
      userId: 'user_1',
      userEmail: 'u@example.com',
      socketPath: '/tmp/already-active.sock',
      expiresAt: 0,
    };
    const readActivePairing = async () => active;
    const ensureActiveSession = async () => ({ kind: 'reauthenticate' as const });
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    installImpl.mockImplementation(async () => {
      throw new Error('disk full');
    });

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    expect(JSON.parse(logs().slice(jsonStart).join('\n'))).toEqual({
      ok: false,
      code: ERROR_CODES.AUTH_FAILED,
      detail: 'disk full',
      userCode: 'ABCD-1234',
    });
    expect(exitCode).toBe(1);
    expect(installCalls().length).toBe(1);
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
  });
});

describe('PairCommand — overlapping ceremony', () => {
  test('--json refuses before starting WorkOS when another process owns the pair lease', async () => {
    const acquirePairAttempt = () => {
      throw new Error('Another capy pair ceremony is already active in this runtime.');
    };

    await new PairCommand(undefined, false, { acquirePairAttempt }).execute({ json: true });

    expect(JSON.parse(logs().join('\n'))).toMatchObject({
      ok: false,
      code: ERROR_CODES.PAIR_ALREADY_IN_PROGRESS,
    });
    expect(ceremonyCalls()).toEqual([]);
    expect(installCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
  });
});

describe('PairCommand — durable pairing integration', () => {
  test('restores custody under the lease before checking active pairing', async () => {
    const restorePairing = mock(async (_lease: unknown) => undefined);
    const readActivePairing = mock(async () => {
      expect(restorePairing).toHaveBeenCalledTimes(1);
      return { userId: 'user_1', userEmail: 'u@example.com', socketPath: '/tmp/restored.sock', expiresAt: 0 };
    });
    const releasePairAttempt = mock(() => true);
    const code = await new PairCommand(undefined, false, {
      restorePairing, readActivePairing, releasePairAttempt,
      ensureActiveSession: async () => ({ kind: 'ready' }),
    }).execute({ json: true });
    expect(code).toBe(0);
    expect(restorePairing.mock.calls[0]?.[0]).toMatchObject({ nonce: 'pair-command-test' });
    expect(JSON.parse(logs().join('\n')).socketPath).toBe('/tmp/restored.sock');
    expect(authorizeImpl).not.toHaveBeenCalled();
    expect(releasePairAttempt).toHaveBeenCalledTimes(1);
  });

  test('restoration failure stops before authentication and releases the lease', async () => {
    const readActivePairing = mock(async () => null);
    const releasePairAttempt = mock(() => true);
    const code = await new PairCommand(undefined, false, {
      restorePairing: async () => { throw new Error('Protected custody is unavailable'); },
      readActivePairing, releasePairAttempt,
    }).execute({ json: true });
    expect(code).toBe(1);
    expect(readActivePairing).not.toHaveBeenCalled();
    expect(authorizeImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(JSON.parse(logs().join('\n')).ok).toBe(false);
    expect(releasePairAttempt).toHaveBeenCalledTimes(1);
  });

  test('publishes durable custody after spawning and before reporting success', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    registerFilesystemPairing.mockImplementation(async (environment, org, material, handle) => {
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect(environment).toBe('development');
      expect(org).toBe('org_1');
      expect(material).toMatchObject({ userId: 'user_1', credentialId: 'cred_1' });
      expect(handle).toEqual(spawnResult);
      expect(logs().some((line) => line.includes('"ok": true'))).toBe(false);
    });
    const code = await new PairCommand(undefined, true).execute({ json: true });
    expect(code).toBe(0);
    expect(registerFilesystemPairing).toHaveBeenCalledTimes(1);
    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    expect(JSON.parse(logs().slice(jsonStart).join('\n')).ok).toBe(true);
  });

  test('durable registration failure is never reported as successful pairing', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    registerFilesystemPairing.mockImplementation(async () => { throw new Error('Custody commit failed'); });
    const releasePairAttempt = mock(() => true);
    const code = await new PairCommand(undefined, true, { releasePairAttempt }).execute({ json: true });
    expect(code).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    expect(JSON.parse(logs().slice(jsonStart).join('\n')).ok).toBe(false);
    expect(releasePairAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('PairCommand — answered', () => {
  test('installs the session and spawns the grant daemon with the right key material', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    await new PairCommand().execute({});

    expect(logs().some((l) => l.includes('ABCD-1234'))).toBe(true);
    expect(installCalls().length).toBe(1);
    expect(installCalls()[0].session).toEqual(VALID_ANSWER.session);
    expect(spawnCalls().length).toBe(1);
    expect(spawnCalls()[0].material.userId).toBe('user_1');
    expect(spawnCalls()[0].material.credentialId).toBe('cred_1');
    expect(spawnCalls()[0].material.kLocal).toEqual(Buffer.alloc(32, 9));
    expect(logs().some((l) => l.includes('u@example.com'))).toBe(true);
    expect(logs().some((l) => l.includes('Org One'))).toBe(true);
  });

  test('--json prints exactly one machine-readable object with the socket path and org', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    await new PairCommand().execute({ json: true });

    const jsonStart = logs().findIndex((l) => l.trim().startsWith('{'));
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(logs().slice(jsonStart).join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.userCode).toBe('ABCD-1234');
    expect(parsed.orgId).toBe('org_1');
    expect(parsed.socketPath).toBe('/tmp/fake.sock');
    expect(parsed.envVar).toBe('CAPY_DEVICE_KEY_GRANT_SOCKET');
    expect(parsed).not.toHaveProperty('expiresAt');
  });

  test('runtime pairing uses process-bound custody rather than the temporary 30-minute lifetime', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    await new PairCommand().execute({});
    expect(spawnCalls()[0].opts).toEqual({ ttlMs: null, persistRuntimePairing: false });
  });

  test('a coded key-material resolution failure (e.g. malformed PRF output) is rejected before spawning a daemon', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    resolveKeyMaterialImpl.mockImplementation(async () => ({ ok: false, code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED }));

    const exitCode = await new PairCommand().execute({});
    expect(spawnCalls().length).toBe(0);
    expect(exitCode).toBe(1);
  });

  test('the session installs BEFORE key material is resolved — the fetch authenticates with the just-installed session', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    await new PairCommand().execute({});
    expect(installCalls().length).toBe(1);
    expect(resolveKeyMaterialCalls().length).toBe(1);
    // CHANGED EXPECTATION (CAP-566): key material is no longer sourced from
    // the approver's sealed answer, because there is no sealed answer — that
    // payload carried the approver's own session, which is the defect this
    // ticket removes. The grant now runs over the machine's OWN authenticated
    // session, so there is nothing to pass in.
    //
    // The invariant this test exists for is UNCHANGED and still asserted
    // below: the session must be installed BEFORE key material is resolved,
    // because the grant authenticates with it. That ordering is arguably more
    // load-bearing now, not less.
    expect(resolveKeyMaterialCalls()[0].answer).toBeNull();
    // installImpl (above) resolves { orgId: 'org_1', ... } — that's the org
    // pairKeyMaterial.ts should authenticate the wrapper fetch against.
    expect(resolveKeyMaterialCalls()[0].opts.authOrgId).toBe('org_1');
  });

  test("a non-interactive multi-org install (orgId: null) still authenticates the key-material fetch, against the session's own org", async () => {
    // CHANGED EXPECTATION (CAP-566): the fallback source, not the behaviour.
    //
    // This asserted the fallback came from `answer.keyMaterial.orgId` — the
    // org the APPROVER's browser had active when it sealed the payload. There
    // is no sealed answer any more, so that source is gone.
    //
    // The behaviour it protects is unchanged and still asserted: when
    // `install.orgId` is null (the non-interactive multi-org case, where
    // installPairedSession deliberately pins nothing), the key-material fetch
    // must STILL be authenticated against some org rather than silently
    // skipped. It now falls back to an org from the machine's own session,
    // which is a strictly better source — doors are org-less server-side, so
    // any org this account belongs to authenticates the fetch, and taking it
    // from our own session removes a dependency on what the approver happened
    // to have selected.
    installImpl.mockImplementation(async () => ({ orgId: null, orgTokenReady: false }));
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    await new PairCommand().execute({});
    expect(resolveKeyMaterialCalls().length).toBe(1);
    // VALID_ANSWER.session's first organization — the fallback when
    // install.orgId is null (see pairCommand.ts's finish()).
    expect(resolveKeyMaterialCalls()[0].opts.authOrgId).toBe('org_1');
  });
});

describe('PairCommand — expired', () => {
  test('exits EXIT_NEEDS_INPUT (3), coded, and installs nothing', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'denied', error: 'expired_token' }));

    await expect(new PairCommand().execute({})).rejects.toMatchObject({ code: 3 });
    expect(installCalls().length).toBe(0);
    expect(spawnCalls().length).toBe(0);
    expect(errs().some((l) => l.includes('expired'))).toBe(true);
  });

  test('--json emits the PAIR_CODE_EXPIRED code', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'denied', error: 'expired_token' }));

    await expect(new PairCommand().execute({ json: true })).rejects.toBeInstanceOf(ExitError);
    const jsonStart = logs().findIndex((l) => l.trim().startsWith('{'));
    const parsed = JSON.parse(logs().slice(jsonStart).join('\n'));
    expect(parsed).toEqual({ ok: false, code: ERROR_CODES.PAIR_CODE_EXPIRED, userCode: 'ABCD-1234' });
  });
});

describe('PairCommand — declined/cancelled/error', () => {
  test('a CeremonyFailure code exits 1 and installs nothing', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'denied', error: 'cancelled' }));

    const exitCode = await new PairCommand().execute({});
    expect(exitCode).toBe(1);
    expect(installCalls().length).toBe(0);
    expect(spawnCalls().length).toBe(0);
  });
});

describe('PairCommand — bootstrap failure before any code is ever shown', () => {
  test('a thrown bootstrap error exits 1, prints no pairing code, installs nothing', async () => {
    authorizeImpl.mockImplementation(async () => {
      throw new Error('network is down');
    });

    const exitCode = await new PairCommand().execute({});
    expect(exitCode).toBe(1);
    expect(installCalls().length).toBe(0);
    expect(spawnCalls().length).toBe(0);
    expect(logs().join('\n')).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });
});

describe('PairCommand — install failure', () => {
  test('a session-install throw does not spawn a grant daemon', async () => {
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));
    installImpl.mockImplementation(async () => {
      throw new Error('disk full');
    });

    const exitCode = await new PairCommand().execute({});
    expect(exitCode).toBe(1);
    expect(spawnCalls().length).toBe(0);
  });
});

// CAP-409 QR follow-up. `printPairingBlock` always prints the plain URL and
// code (spec §5's bright-line exception, unrelated to TTY-ness); the QR is
// purely additive on top and gated by `renderTerminalQr` (src/ui/terminalQr.ts).
// These tests exercise that gate through the real command, not just the
// helper in isolation — proving the wiring, not just the decision function.
describe('PairCommand — terminal QR (CAP-409 follow-up)', () => {
  const HALF_BLOCK = /[█▀▄]/;
  function pending() {
    // Never resolves within a test's lifetime — these tests only care about
    // what `onCodeReady` prints synchronously, not about a ceremony outcome.
    // The command prints the block itself now, then waits — so this just
    // never resolves. Callers await a tick so the print has happened.
    ceremonyImpl.mockImplementation(() => new Promise(() => {}));
  }

  test('a wide real TTY gets the QR alongside the unconditional plain text', async () => {
    terminal(true);
    mockEnvironment({ CAPY_DEVICE_KEYS: '1' });
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs().join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(all).toContain(AUTHORIZATION.verification_uri_complete);
    expect(all).toContain('The code is prefilled. Confirm it matches');
    expect(HALF_BLOCK.test(all)).toBe(true);
  });

  test('a piped, non-TTY stdout gets the plain text but never the QR', async () => {
    terminal(undefined);
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs().join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('a narrow real TTY falls back to plain text only — no QR, no crash', async () => {
    terminal(true, 10);
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs().join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('NO_COLOR suppresses the QR even on a wide real TTY, text stays', async () => {
    terminal(true);
    mockEnvironment({ CAPY_DEVICE_KEYS: '1', NO_COLOR: '1' });
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs().join('\n');
    expect(all).toContain('ABCD-1234');
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('the CAP-386 CAPY_EVENT_V1 marker never appears here, TTY or not — the two stay mutually exclusive', () => {
    for (const isTTY of [true, undefined]) {
      logSpy.mockClear();
      terminal(isTTY);
      pending();

      void new PairCommand().execute({});

      expect(logs().join('\n')).not.toContain('CAPY_EVENT_V1');
    }
  });
});

describe('PairCommand — CAP-646 existing CLI authentication is reused', () => {
  const SIGNED_IN = {
    success: true,
    user_id: 'user_1',
    user_email: 'u@example.com',
    organization_id: 'org_1',
    organizations: [{ id: 'org_1', workos_org_id: 'wos_1', name: 'Org One' }],
  };

  test('a usable session pairs the runtime without any device ceremony', async () => {
    silentAuthImpl.mockImplementation(async () => SIGNED_IN);

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(0);
    // The whole point: no user code was ever minted, so nothing was asked of
    // the human who is already signed in on this machine.
    expect(ceremonyCalls()).toEqual([]);
    expect(authorizeImpl.mock.calls.length).toBe(0);
    expect(logs().join('\n')).not.toContain('ABCD-1234');
    // A reused session is already on disk; writing it again is exactly the
    // clobbering risk this path exists to avoid.
    expect(installCalls()).toEqual([]);
    // Custody still runs in full: the grant ceremony, the daemon, and the
    // durable runtime record.
    expect(resolveKeyMaterialCalls().length).toBe(1);
    expect(spawnCalls().length).toBe(1);
    expect(registerFilesystemPairing.mock.calls.length).toBe(1);
    expect(JSON.parse(logs().join('\n'))).toEqual({
      ok: true,
      userCode: null,
      userId: 'user_1',
      userEmail: 'u@example.com',
      orgId: 'org_1',
      orgName: 'Org One',
      orgTokenReady: true,
      socketPath: '/tmp/fake.sock',
      envVar: 'CAPY_DEVICE_KEY_GRANT_SOCKET',
    });
  });

  test('the probe is scoped to the org the session already activated', async () => {
    silentAuthImpl.mockImplementation(async () => SIGNED_IN);
    sessionOrgIdImpl.mockImplementation(() => 'org_1');

    await new PairCommand().execute({ json: true });

    expect(silentAuthImpl.mock.calls).toEqual([['org_1']]);
  });

  test('a single-org account without an activated org still resolves its custody org', async () => {
    silentAuthImpl.mockImplementation(async () => ({
      success: true,
      user_id: 'user_1',
      user_email: 'u@example.com',
      organizations: [{ id: 'org_1', workos_org_id: 'wos_1', name: 'Org One' }],
    }));

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs().join('\n'));
    expect(parsed.orgId).toBe('org_1');
    // Inferred, not exchanged — the caller must not read this as a live token.
    expect(parsed.orgTokenReady).toBe(false);
    expect(resolveKeyMaterialCalls()[0]?.opts.authOrgId).toBe('org_1');
  });

  test.each([
    ['no_session'],
    ['session_ended'],
  ])('%s is the only kind of failure that sends the human to device authorization', async (code) => {
    silentAuthImpl.mockImplementation(async () => ({ success: false, error_code: code, error: 'nope' }));
    ceremonyImpl.mockImplementation(async () => ({ status: 'complete', session: VALID_ANSWER.session }));

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(0);
    expect(ceremonyCalls().length).toBe(1);
    expect(installCalls().length).toBe(1);
    // The device block prints above the result, so start at the JSON object.
    const jsonStart = logs().findIndex((line) => line.trim().startsWith('{'));
    expect(JSON.parse(logs().slice(jsonStart).join('\n')).userCode).toBe('ABCD-1234');
  });

  test.each([
    ['network', ERROR_CODES.NETWORK_ERROR],
    ['server_error', ERROR_CODES.SERVICE_ERROR],
    ['org_not_found', ERROR_CODES.ORG_NOT_FOUND],
  ])('%s fails with its own code instead of asking for a redundant login', async (code, expected) => {
    silentAuthImpl.mockImplementation(async () => ({ success: false, error_code: code, error: 'nope' }));

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs().join('\n')).code).toBe(expected);
    // Opening a browser cannot repair a transport failure, so nothing is
    // started and the session on disk is left exactly as it was.
    expect(ceremonyCalls()).toEqual([]);
    expect(installCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
  });

  test('a session that resolves no account is a failure, not a pairing', async () => {
    silentAuthImpl.mockImplementation(async () => ({ success: true, user_email: 'u@example.com' }));

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs().join('\n')).code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(spawnCalls()).toEqual([]);
  });

  test('the runtime single-account binding is enforced on the reused path too', async () => {
    silentAuthImpl.mockImplementation(async () => SIGNED_IN);
    const { CapyError } = await import('../../src/types/index');
    assertRuntimePairingUserImpl.mockImplementation(() => {
      throw new CapyError('paired to another account', ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
    });

    const exitCode = await new PairCommand().execute({ json: true });

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs().join('\n')).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
    // Refused before any key material is fetched or any daemon is spawned.
    expect(resolveKeyMaterialCalls()).toEqual([]);
    expect(spawnCalls()).toEqual([]);
    expect(registerFilesystemPairing.mock.calls).toEqual([]);
  });

  test('a runtime whose custody is already live never reaches the probe', async () => {
    silentAuthImpl.mockImplementation(async () => SIGNED_IN);
    const readActivePairing = async () => ({
      userId: 'user_1', userEmail: 'u@example.com', socketPath: '/tmp/already-active.sock', expiresAt: 0,
    });
    const ensureActiveSession = async () => ({ kind: 'ready' as const });

    const exitCode = await new PairCommand(undefined, false, { readActivePairing, ensureActiveSession })
      .execute({ json: true });

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs().join('\n')).alreadyActive).toBe(true);
    expect(silentAuthImpl.mock.calls).toEqual([]);
    expect(spawnCalls()).toEqual([]);
  });
});
