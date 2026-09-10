import { createHash } from 'crypto';
import { describe, expect, it, jest } from 'bun:test';
import { AuthService } from '../../src/auth/authService';
import type { SessionStorageBackend } from '../../src/auth/session/backend';
import {
  completeInitRunAuthentication,
  createInitRunBootstrap,
  publishInitRunConnection,
  recordInitRunTerminal,
  resolveInitRunBrokerAccessToken,
  type InitRunBootstrap,
  type InitRunBootstrapTransport,
} from '../../src/auth/initRunBootstrap';
import {
  initRunCliKeyFingerprint,
  mintInitRunDeliveryKeypair,
} from '../../src/auth/initRunEnvelope';
import { sealInitRunAuthResult } from '../../../../service/src/initRuns/crypto';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '77777777-7777-4777-8777-777777777777';
const SERVICE_ORIGIN = 'https://api.dev.example';
const KEEP_ORIGIN = 'https://keep.dev.example';
const REPOSITORY_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const EXPIRES_AT = '2026-09-10T05:10:00.000Z';
const NOW = Date.parse('2026-09-10T05:00:00.000Z');
const RUN_SECRET = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

function fakeJwt(payload: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.fixture`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function transport(fetcher: typeof fetch): InitRunBootstrapTransport {
  return {
    fetch: fetcher,
    now: () => NOW,
    sleep: jest.fn(async () => undefined),
  };
}

function installedContext(): Readonly<{
  auth: { readonly success: true; readonly user_id: string; readonly organizations: readonly never[] };
  authService: AuthService;
}> {
  return {
    auth: { success: true, user_id: 'user_expected', organizations: [] },
    authService: {} as AuthService,
  };
}

function unselectedAuthService(): AuthService {
  return {
    getOrganizationId: () => null,
    getToken: jest.fn(() => null),
  } as unknown as AuthService;
}

function storage(): Readonly<{
  backend: SessionStorageBackend;
  save: ReturnType<typeof jest.fn>;
}> {
  const save = jest.fn();
  return {
    backend: {
      load: jest.fn(() => save.mock.calls.at(-1)?.[0] ?? null),
      save,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, fn) => fn(null),
    },
    save,
  };
}

function bootstrap(): InitRunBootstrap {
  const deliveryKeypair = mintInitRunDeliveryKeypair();
  const cliKeyFingerprint = initRunCliKeyFingerprint(deliveryKeypair.publicKeyB64);
  if (!cliKeyFingerprint) throw new Error('fixture key was not valid P-256');
  return {
    request: {
      serviceOrigin: SERVICE_ORIGIN,
      keepOrigin: KEEP_ORIGIN,
      runtimeId: RUNTIME_ID,
      repositoryFingerprint: REPOSITORY_FINGERPRINT,
      machineName: 'fixture-machine',
      expectedUserId: null,
    },
    response: {
      v: 1,
      run_id: RUN_ID,
      run_secret: RUN_SECRET,
      claim_code: '7KM2-W9QD-R4TX',
      entry_url: `${KEEP_ORIGIN}/flow/init-wizard?run=${RUN_ID}`,
      expires_at: EXPIRES_AT,
    },
    handoff: {
      runId: RUN_ID,
      entryUrl: `${KEEP_ORIGIN}/flow/init-wizard?run=${RUN_ID}`,
      claimCode: '7KM2-W9QD-R4TX',
      expiresAt: EXPIRES_AT,
    },
    pkce: {
      codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    },
    deliveryKeypair,
    cliKeyFingerprint,
  };
}

function completionFixture(prepared: InitRunBootstrap) {
  const binding = {
    run_id: RUN_ID,
    subject_user_id: 'user_expected',
    service_origin: SERVICE_ORIGIN,
    runtime_id: RUNTIME_ID,
    repository_fingerprint: REPOSITORY_FINGERPRINT,
    cli_key_fingerprint: prepared.cliKeyFingerprint,
  } as const;
  const response = {
    token: { access_token: null, refresh_token: 'rt_fixture', expires_in: 0 },
    user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
    organizations: [],
  } as const;
  const sealed = sealInitRunAuthResult({
    cliPubkeyB64: prepared.deliveryKeypair.publicKeyB64,
    binding,
    plaintext: JSON.stringify({
      v: 1,
      binding,
      auth_epoch: 1,
      response,
      broker_access_token: 'broker.fixture.token',
    }),
  });
  if (!sealed.ok) throw new Error('fixture sealing failed');
  const receipt = `sha256:${createHash('sha256').update(sealed.sealed_auth_result).digest('hex')}`;
  const authorizedStatus = {
    v: 1,
    run_id: RUN_ID,
    status: 'authorized',
    expected_user_id: null,
    subject_user_id: 'user_expected',
    service_origin: SERVICE_ORIGIN,
    runtime_id: RUNTIME_ID,
    repository_fingerprint: REPOSITORY_FINGERPRINT,
    cli_key_fingerprint: prepared.cliKeyFingerprint,
    machine_name: 'fixture-machine',
    entry_url: `${KEEP_ORIGIN}/flow/init-wizard?run=${RUN_ID}`,
    expires_at: '2026-09-10T07:00:00.000Z',
    auth_epoch: 1,
    authorization_pending: false,
    auth_error_code: null,
    first_connection_id: null,
    terminal_receipt: null,
  } as const;
  return { binding, response, sealed, receipt, authorizedStatus } as const;
}

describe('hosted init-run bootstrap', () => {
  it('installs the canonical response only for the expected subject', async () => {
    const target = storage();
    const auth = new AuthService(SERVICE_ORIGIN, false, 'user_expected', target.backend);
    const response = {
      token: { access_token: null, refresh_token: 'rt_fixture', expires_in: 0 },
      user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
      organizations: [],
    } as const;

    const installed = await auth.installExchangeResponse(response, { userId: 'user_expected' });
    expect(installed.auth).toMatchObject({ success: true, user_id: 'user_expected', _refresh_token: 'rt_fixture' });
    expect(installed.authService).not.toBe(auth);
    expect(target.save).toHaveBeenCalledTimes(1);

    const replay = await auth.installExchangeResponse(response, { userId: 'user_expected' });
    expect(replay.auth).toEqual(installed.auth);
    expect(target.save).toHaveBeenCalledTimes(1);

    const otherTarget = storage();
    const other = new AuthService(SERVICE_ORIGIN, false, 'user_expected', otherTarget.backend);
    const error = await other.installExchangeResponse(response, { userId: 'user_other' }).catch((cause) => cause);
    expect(error.code).toBe('AUTH_FAILED');
    expect(otherTarget.save).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a session authority that changed after the installer was constructed', async () => {
    const original = {
      version: 2 as const,
      user_id: 'user_expected',
      user_email: 'fixture@example.com',
      refresh_token: 'rt_original',
      organizations: [],
      sessions: {},
    };
    const changed = { ...original, refresh_token: 'rt_concurrently_rotated' };
    const save = jest.fn();
    const backend: SessionStorageBackend = {
      load: jest.fn()
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(changed),
      save,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, fn) => fn(null),
    };
    const auth = new AuthService(SERVICE_ORIGIN, false, 'user_expected', backend);
    const error = await auth.installExchangeResponse({
      token: { access_token: null, refresh_token: 'rt_hosted', expires_in: 0 },
      user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
      organizations: [],
    }, { userId: 'user_expected' }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(save).not.toHaveBeenCalled();
  });

  it('reports persistence failure before returning a replacement auth context', async () => {
    const target = storage();
    target.save.mockImplementation(() => {
      throw new Error('fixture persistence failure');
    });
    const auth = new AuthService(SERVICE_ORIGIN, false, 'user_expected', target.backend);
    const error = await auth.installExchangeResponse({
      token: { access_token: null, refresh_token: 'rt_hosted', expires_in: 0 },
      user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
      organizations: [],
    }, { userId: 'user_expected' }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(target.save).toHaveBeenCalledTimes(1);
  });

  it('refuses acknowledgement when the replacement context cannot reload the persisted authority', async () => {
    const save = jest.fn();
    const backend: SessionStorageBackend = {
      load: jest.fn(() => null),
      save,
      clear: jest.fn(),
      discover: jest.fn(() => null),
      withRefreshLock: async (_userId, fn) => fn(null),
    };
    const auth = new AuthService(SERVICE_ORIGIN, false, 'user_expected', backend);
    const error = await auth.installExchangeResponse({
      token: { access_token: null, refresh_token: 'rt_hosted', expires_in: 0 },
      user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
      organizations: [],
    }, { userId: 'user_expected' }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('preserves token-claim then single-org resolution and leaves multi-org selection open', async () => {
    const orgA = { id: 'org_a', workos_org_id: 'workos_a', name: 'A', key_state: 'minted' } as const;
    const orgB = { id: 'org_b', workos_org_id: 'workos_b', name: 'B', key_state: 'minted' } as const;
    const cases = [
      {
        accessToken: fakeJwt({ org_id: orgB.workos_org_id }),
        organizations: [orgA, orgB],
        expectedOrganizationId: orgB.id,
      },
      {
        accessToken: 'not-a-jwt',
        organizations: [orgA],
        expectedOrganizationId: orgA.id,
      },
      {
        accessToken: 'not-a-jwt',
        organizations: [orgA, orgB],
        expectedOrganizationId: '',
      },
    ] as const;

    for (const selected of cases) {
      const target = storage();
      const auth = new AuthService(SERVICE_ORIGIN, false, 'user_expected', target.backend);
      const installed = await auth.installExchangeResponse({
        token: { access_token: selected.accessToken, refresh_token: 'rt_fixture', expires_in: 600 },
        user: { id: 'user_expected', email: 'fixture@example.com', first_name: null, last_name: null },
        organizations: selected.organizations,
      }, { userId: 'user_expected' });

      expect(installed.auth.organization_id).toBe(selected.expectedOrganizationId);
      expect(installed.authService).not.toBe(auth);
      if (selected.accessToken !== 'not-a-jwt') {
        expect(installed.authService.getToken()?.organization_id).toBe(selected.expectedOrganizationId);
      }
      expect(target.save.mock.calls[0]?.[0].sessions).toEqual(selected.expectedOrganizationId
        ? { [selected.expectedOrganizationId]: expect.objectContaining({ access_token: selected.accessToken }) }
        : {});
    }
  });

  it('creates a run only at the exact configured service and Keep origins', async () => {
    const fetcher = jest.fn(async () => json({
      v: 1,
      run_id: RUN_ID,
      run_secret: RUN_SECRET,
      claim_code: '7KM2-W9QD-R4TX',
      entry_url: `${KEEP_ORIGIN}/flow/init-wizard?run=${RUN_ID}`,
      expires_at: EXPIRES_AT,
    })) as unknown as typeof fetch;
    const created = await createInitRunBootstrap({
      serviceOrigin: SERVICE_ORIGIN,
      keepOrigin: KEEP_ORIGIN,
      runtimeId: RUNTIME_ID,
      repositoryFingerprint: 'a'.repeat(64),
      machineName: 'fixture-machine',
      expectedUserId: null,
    }, transport(fetcher));

    expect(created.handoff).toEqual({
      runId: RUN_ID,
      entryUrl: `${KEEP_ORIGIN}/flow/init-wizard?run=${RUN_ID}`,
      claimCode: '7KM2-W9QD-R4TX',
      expiresAt: EXPIRES_AT,
    });
    expect(created.request.repositoryFingerprint).toBe(REPOSITORY_FINGERPRINT);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${SERVICE_ORIGIN}/init-runs`);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('refuses a non-loopback cleartext service before sending the run secret request', async () => {
    const fetcher = jest.fn() as unknown as typeof fetch;
    const error = await createInitRunBootstrap({
      serviceOrigin: 'http://capy-dev.internal:3001',
      keepOrigin: KEEP_ORIGIN,
      runtimeId: RUNTIME_ID,
      repositoryFingerprint: REPOSITORY_FINGERPRINT,
      machineName: 'fixture-machine',
      expectedUserId: null,
    }, transport(fetcher)).catch((cause) => cause);

    expect(error.code).toBe('INIT_RUN_CONFIGURATION');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds a create request even when the transport never settles', async () => {
    const fetcher = jest.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const error = await createInitRunBootstrap({
      serviceOrigin: SERVICE_ORIGIN,
      keepOrigin: KEEP_ORIGIN,
      runtimeId: RUNTIME_ID,
      repositoryFingerprint: REPOSITORY_FINGERPRINT,
      machineName: 'fixture-machine',
      expectedUserId: null,
    }, {
      ...transport(fetcher),
      requestTimeoutMs: 5,
    }).catch((cause) => cause);

    expect(error.code).toBe('NETWORK_ERROR');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('verifies receipt, outer and inner binding, installs the session, then acknowledges', async () => {
    const prepared = bootstrap();
    const { binding, response, sealed, receipt, authorizedStatus } = completionFixture(prepared);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(json({
        v: 1,
        status: 'complete',
        binding,
        auth_epoch: 1,
        credential_receipt: receipt,
        sealed_auth_result: sealed.sealed_auth_result,
      }))
      .mockResolvedValueOnce(json(authorizedStatus)) as unknown as typeof fetch;
    const install = jest.fn(async () => installedContext());
    const authService = { installExchangeResponse: install } as unknown as AuthService;

    const result = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService,
      transport: transport(fetcher),
    });

    expect(result.binding).toEqual(binding);
    expect(result.brokerAccessToken).toBe('broker.fixture.token');
    expect(install).toHaveBeenCalledWith(response, { userId: 'user_expected' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer broker.fixture.token',
    });
  });

  it('retries the same exchange after a lost network response and consumes the durable replay', async () => {
    const prepared = bootstrap();
    const { binding, response, sealed, receipt, authorizedStatus } = completionFixture(prepared);
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(json({
        v: 1,
        status: 'complete',
        binding,
        auth_epoch: 1,
        credential_receipt: receipt,
        sealed_auth_result: sealed.sealed_auth_result,
      }))
      .mockResolvedValueOnce(json(authorizedStatus)) as unknown as typeof fetch;
    const install = jest.fn(async () => installedContext());

    const result = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService: { installExchangeResponse: install } as unknown as AuthService,
      transport: transport(fetcher),
    });

    expect(result.authEpoch).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('refuses an exchange that arrives after the frozen pre-auth deadline before session installation', async () => {
    const prepared = bootstrap();
    const { binding, sealed, receipt } = completionFixture(prepared);
    const fetcher = jest.fn(async () => json({
      v: 1,
      status: 'complete',
      binding,
      auth_epoch: 1,
      credential_receipt: receipt,
      sealed_auth_result: sealed.sealed_auth_result,
    })) as unknown as typeof fetch;
    const install = jest.fn();
    const baseTransport = transport(fetcher);
    const error = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService: { installExchangeResponse: install } as unknown as AuthService,
      transport: {
        ...baseTransport,
        now: () => fetcher.mock.calls.length === 0 ? NOW : Date.parse(EXPIRES_AT),
      },
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_RUN_EXPIRED');
    expect(install).not.toHaveBeenCalled();
  });

  it('treats a mismatched acknowledgement projection as indeterminate after installation', async () => {
    const prepared = bootstrap();
    const { binding, response, sealed, receipt, authorizedStatus } = completionFixture(prepared);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(json({
        v: 1,
        status: 'complete',
        binding,
        auth_epoch: 1,
        credential_receipt: receipt,
        sealed_auth_result: sealed.sealed_auth_result,
      }))
      .mockResolvedValueOnce(json({
        ...authorizedStatus,
        runtime_id: '88888888-8888-4888-8888-888888888888',
      })) as unknown as typeof fetch;
    const install = jest.fn(async () => installedContext());

    const error = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService: { installExchangeResponse: install } as unknown as AuthService,
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(install).toHaveBeenCalledWith(response, { userId: 'user_expected' });
  });

  it('reports an indeterminate delivery when acknowledgement may have committed', async () => {
    const prepared = bootstrap();
    const { binding, response, sealed, receipt } = completionFixture(prepared);
    const fetcher = jest.fn()
      .mockResolvedValueOnce(json({
        v: 1,
        status: 'complete',
        binding,
        auth_epoch: 1,
        credential_receipt: receipt,
        sealed_auth_result: sealed.sealed_auth_result,
      }))
      .mockResolvedValueOnce(json({ error: 'response lost', code: 'SERVICE_ERROR' }, 500)) as unknown as typeof fetch;
    const install = jest.fn(async () => installedContext());

    const error = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService: { installExchangeResponse: install } as unknown as AuthService,
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(install).toHaveBeenCalledWith(response, { userId: 'user_expected' });
  });

  it('refuses an outer binding mismatch before decryption, session install, or acknowledgement', async () => {
    const prepared = bootstrap();
    const binding = {
      run_id: RUN_ID,
      subject_user_id: 'user_expected',
      service_origin: SERVICE_ORIGIN,
      runtime_id: '88888888-8888-4888-8888-888888888888',
      repository_fingerprint: REPOSITORY_FINGERPRINT,
      cli_key_fingerprint: prepared.cliKeyFingerprint,
    } as const;
    const fetcher = jest.fn(async () => json({
      v: 1,
      status: 'complete',
      binding,
      auth_epoch: 1,
      credential_receipt: `sha256:${'c'.repeat(64)}`,
      sealed_auth_result: 'opaque-test-ciphertext',
    })) as unknown as typeof fetch;
    const install = jest.fn();
    const error = await completeInitRunAuthentication({
      bootstrap: prepared,
      authService: { installExchangeResponse: install } as unknown as AuthService,
      transport: transport(fetcher),
    }).catch((cause) => cause);
    expect(error.code).toBe('INIT_BINDING_MISMATCH');
    expect(install).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('publishes the first broker connection with the frozen run binding and recovers the exact idempotent response', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const connectionId = '22222222-2222-4222-8222-222222222222';
    const authorized = {
      auth: { success: true, user_id: 'user_expected' },
      authService: unselectedAuthService(),
      binding: fixture.binding,
      authEpoch: 1,
      credentialReceipt: fixture.receipt,
      brokerAccessToken: 'broker.fixture.token',
      runSecret: RUN_SECRET,
      expiresAt: '2026-09-10T07:00:00.000Z',
    } as const;
    const running = {
      ...fixture.authorizedStatus,
      status: 'running',
      first_connection_id: connectionId,
    } as const;
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(json(running)) as unknown as typeof fetch;

    const result = await publishInitRunConnection({
      bootstrap: prepared,
      authorized,
      firstConnectionId: connectionId,
      transport: transport(fetcher),
    });

    expect(result).toEqual(running);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      v: 1,
      action: 'publish',
      run_secret: RUN_SECRET,
      binding: fixture.binding,
      first_connection_id: connectionId,
    });
  });

  it('uses the original broker token only before organization selection', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const getToken = jest.fn(() => ({
      access_token: 'unexpected-refreshed-token',
      expires_at: NOW + 60_000,
      organization_id: 'org-1',
      user_id: fixture.binding.subject_user_id,
    }));
    const token = await resolveInitRunBrokerAccessToken({
      auth: { success: true, user_id: fixture.binding.subject_user_id },
      authService: {
        getOrganizationId: () => null,
        getToken,
      } as unknown as AuthService,
      binding: fixture.binding,
      authEpoch: 1,
      credentialReceipt: fixture.receipt,
      brokerAccessToken: 'broker.fixture.token',
      runSecret: RUN_SECRET,
      expiresAt: EXPIRES_AT,
    }, () => NOW);

    expect(token).toBe('broker.fixture.token');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('uses the selected organization session for continuation requests', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const connectionId = '22222222-2222-4222-8222-222222222222';
    const running = {
      ...fixture.authorizedStatus,
      status: 'running',
      first_connection_id: connectionId,
    } as const;
    const getToken = jest.fn(() => ({
      access_token: 'refreshed.fixture.token',
      expires_at: NOW + 60_000,
      organization_id: 'org-1',
      user_id: fixture.binding.subject_user_id,
    }));
    const getValidToken = jest.fn(async () => null);
    const fetcher = jest.fn(async () => json(running)) as unknown as typeof fetch;
    await publishInitRunConnection({
      bootstrap: prepared,
      authorized: {
        auth: { success: true, user_id: fixture.binding.subject_user_id },
        authService: {
          getOrganizationId: () => 'org-1',
          getToken,
          getValidToken,
        } as unknown as AuthService,
        binding: fixture.binding,
        authEpoch: 1,
        credentialReceipt: fixture.receipt,
        brokerAccessToken: 'expired.fixture.token',
        runSecret: RUN_SECRET,
        expiresAt: EXPIRES_AT,
      },
      firstConnectionId: connectionId,
      transport: transport(fetcher),
    });

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getValidToken).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer refreshed.fixture.token' });
  });

  it('never falls back to the exchange token when the selected session has no cached token', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const fetcher = jest.fn(async () => json(fixture.authorizedStatus)) as unknown as typeof fetch;
    const authorized = {
      auth: { success: true, user_id: fixture.binding.subject_user_id },
      authService: {
        getOrganizationId: () => 'org-1',
        getToken: jest.fn(() => null),
      } as unknown as AuthService,
      binding: fixture.binding,
      authEpoch: 1,
      credentialReceipt: fixture.receipt,
      brokerAccessToken: 'expired.fixture.token',
      runSecret: RUN_SECRET,
      expiresAt: EXPIRES_AT,
    } as const;
    const error = await publishInitRunConnection({
      bootstrap: prepared,
      authorized,
      firstConnectionId: '22222222-2222-4222-8222-222222222222',
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses an expired selected-session token without starting a refresh or request', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const getValidToken = jest.fn(async () => ({ access_token: 'must-not-be-used' }));
    const fetcher = jest.fn(async () => json(fixture.authorizedStatus)) as unknown as typeof fetch;
    const error = await publishInitRunConnection({
      bootstrap: prepared,
      authorized: {
        auth: { success: true, user_id: fixture.binding.subject_user_id },
        authService: {
          getOrganizationId: () => 'org-1',
          getToken: () => ({
            access_token: 'expired.selected.token',
            expires_at: NOW,
            organization_id: 'org-1',
            user_id: fixture.binding.subject_user_id,
          }),
          getValidToken,
        } as unknown as AuthService,
        binding: fixture.binding,
        authEpoch: 1,
        credentialReceipt: fixture.receipt,
        brokerAccessToken: 'exchange.token',
        runSecret: RUN_SECRET,
        expiresAt: EXPIRES_AT,
      },
      firstConnectionId: '22222222-2222-4222-8222-222222222222',
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(getValidToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps a selected-session getter failure to a fixed code before any request', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const fetcher = jest.fn(async () => json(fixture.authorizedStatus)) as unknown as typeof fetch;
    const error = await publishInitRunConnection({
      bootstrap: prepared,
      authorized: {
        auth: { success: true, user_id: fixture.binding.subject_user_id },
        authService: {
          getOrganizationId: () => 'org-1',
          getToken: () => { throw new Error('fixture getter failure'); },
        } as unknown as AuthService,
        binding: fixture.binding,
        authEpoch: 1,
        credentialReceipt: fixture.receipt,
        brokerAccessToken: 'exchange.token',
        runSecret: RUN_SECRET,
        expiresAt: EXPIRES_AT,
      },
      firstConnectionId: '22222222-2222-4222-8222-222222222222',
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects selected-session metadata for a different subject before continuation', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const fetcher = jest.fn(async () => json(fixture.authorizedStatus)) as unknown as typeof fetch;
    const authorized = {
      auth: { success: true, user_id: fixture.binding.subject_user_id },
      authService: {
        getOrganizationId: () => 'org-1',
        getToken: jest.fn(() => ({
          access_token: 'wrong-subject.fixture.token',
          expires_at: NOW + 60_000,
          organization_id: 'org-1',
          user_id: 'user_other',
        })),
      } as unknown as AuthService,
      binding: fixture.binding,
      authEpoch: 1,
      credentialReceipt: fixture.receipt,
      brokerAccessToken: 'expired.fixture.token',
      runSecret: RUN_SECRET,
      expiresAt: EXPIRES_AT,
    } as const;
    const error = await recordInitRunTerminal({
      bootstrap: prepared,
      authorized,
      receipt: {
        v: 1,
        run_id: RUN_ID,
        receipt_id: '33333333-3333-4333-8333-333333333333',
        status: 'failed',
        code: 'INIT_DELIVERY_INDETERMINATE',
        repository_verified: false,
        custody_verified: false,
        effects: 'indeterminate',
        completed_at: '2026-09-10T05:20:00.000Z',
      },
      transport: transport(fetcher),
    }).catch((cause) => cause);

    expect(error.code).toBe('INIT_DELIVERY_INDETERMINATE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts terminal authority only when the service returns the identical receipt', async () => {
    const prepared = bootstrap();
    const fixture = completionFixture(prepared);
    const authorized = {
      auth: { success: true, user_id: 'user_expected' },
      authService: unselectedAuthService(),
      binding: fixture.binding,
      authEpoch: 1,
      credentialReceipt: fixture.receipt,
      brokerAccessToken: 'broker.fixture.token',
      runSecret: RUN_SECRET,
      expiresAt: '2026-09-10T07:00:00.000Z',
    } as const;
    const receipt = {
      v: 1,
      run_id: RUN_ID,
      receipt_id: '33333333-3333-4333-8333-333333333333',
      status: 'succeeded',
      code: null,
      repository_verified: true,
      custody_verified: false,
      effects: 'complete',
      completed_at: '2026-09-10T05:20:00.000Z',
    } as const;
    const terminal = {
      ...fixture.authorizedStatus,
      status: 'terminal',
      first_connection_id: '22222222-2222-4222-8222-222222222222',
      terminal_receipt: receipt,
      expires_at: '2026-09-11T05:20:00.000Z',
    } as const;
    const fetcher = jest.fn(async () => json(terminal)) as unknown as typeof fetch;

    const result = await recordInitRunTerminal({
      bootstrap: prepared,
      authorized,
      receipt,
      transport: transport(fetcher),
    });

    expect(result.terminal_receipt).toEqual(receipt);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      v: 1,
      action: 'terminal',
      run_secret: RUN_SECRET,
      binding: fixture.binding,
      terminal_receipt: receipt,
    });
  });
});
