import { expect, mock, test } from 'bun:test';
import type { AuthService, InstalledInitRunOrganization } from '../../src/auth/authService';
import { INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH } from '../../src/auth/initRunOrganizationInstaller';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { BrokerConnection } from '../../src/service/brokerClient';
import { CapyError, type AuthResult } from '../../src/types';
import type { InitRunBinding, InitWizardFrame } from '../../src/auth/initRunContract';
import type { HostedInitWizardSession } from '../../src/ui/hostedInitWizardSession';
import {
  createHostedFreshOrganization,
  type HostedFreshOrganizationDependencies,
} from '../../src/commands/hostedFreshOrganization';

const now = Date.parse('2026-09-10T05:00:00.000Z');
const binding: InitRunBinding = {
  run_id: '11111111-1111-4111-8111-111111111111',
  subject_user_id: 'user_demo',
  service_origin: 'https://api.dev.example',
  runtime_id: '77777777-7777-4777-8777-777777777777',
  repository_fingerprint: `sha256:${'a'.repeat(64)}`,
  cli_key_fingerprint: `sha256:${'b'.repeat(64)}`,
};
const organization = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workos_org_id: 'org_provider',
  name: 'Northwind',
} as const;
const auth: AuthResult = {
  success: true,
  user_id: binding.subject_user_id,
  user_email: 'person@example.test',
  organizations: [],
  _refresh_token: 'refresh_initial',
};
const replacementAuth: AuthResult = {
  ...auth,
  organization_id: organization.id,
  organization_name: organization.name,
  organizations: [organization],
  _refresh_token: 'refresh_replaced',
};

const connection = (index: number): BrokerConnection => ({
  connectionId: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900_000).toISOString(),
  keypair: mintConnectionKeypair(),
});

type Answer = Readonly<Record<string, unknown>> | 'cancel';

const channelHarness = (answers: readonly Answer[]) => {
  const connections = Array.from({ length: 12 }, (_, index) => connection(index + 1));
  const createConnection = mock(async () => connections[0]);
  connections.forEach((item) => createConnection.mockImplementationOnce(async () => item));
  const pollExchange = mock(async () => ({ kind: 'pending' as const, pagePubkeyB64: 'synthetic-page-key' }));
  const pollAnswer = mock(async () => ({ kind: 'network' as const }));
  answers.forEach((answer, index) => pollAnswer.mockImplementationOnce(async () => ({
    kind: 'answered' as const,
    plaintext: JSON.stringify({
      v: 1,
      flow: 'init-wizard',
      binding,
      sequence: index * 2,
      attempt_id: 'attempt_1',
      ...(answer === 'cancel'
        ? { kind: 'cancel' }
        : { kind: 'answer', answer }),
    }),
  })));
  const sendRequest = mock(async () => ({ kind: 'sent' as const }));
  const broker = {
    createConnection,
    pollExchange,
    pollAnswer,
    sendRequest,
    cancel: mock(async () => undefined),
  };
  const current = connections[0];
  const successor = connections[1];
  const session: HostedInitWizardSession = {
    channel: {
      broker,
      binding,
      current,
      successor,
      sequence: 0,
      deadline: now + 7200000,
      now: () => now,
      attemptId: () => 'attempt_1',
      pause: async () => undefined,
      cleanupTimeoutMs: 10,
    },
    input: {},
    step: 'organization',
    block: null,
    encryptView: null,
    ended: false,
  };
  return { broker, session };
};

const installed = (authService: AuthService): InstalledInitRunOrganization => ({
  organization,
  auth: replacementAuth,
  authService,
});

const authHarness = (outcomes: readonly ('success' | 'safe-conflict' | 'unknown')[]) => {
  const replacement = {
    getValidToken: mock(async () => null),
    getServiceApiUrl: () => binding.service_origin,
  } as unknown as AuthService;
  const create = mock(async () => installed(replacement));
  outcomes.forEach((outcome) => create.mockImplementationOnce(async () => {
    if (outcome === 'safe-conflict') {
      throw new CapyError('reserved', INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH);
    }
    if (outcome === 'unknown') throw new CapyError('provider conflict', 'INIT_RUN_ORGANIZATION_INDETERMINATE');
    return installed(replacement);
  }));
  const initial = {
    getServiceApiUrl: () => binding.service_origin,
    createInitRunOrganization: create,
  } as unknown as AuthService;
  return { create, initial, replacement };
};

const frame = (call: readonly unknown[]): InitWizardFrame<Record<string, unknown>> =>
  JSON.parse(call[2] as string) as InitWizardFrame<Record<string, unknown>>;

const dependencies = (input: Readonly<{
  checkName?: HostedFreshOrganizationDependencies['checkName'];
  ceremonyOutcome?: 'success' | 'failure';
}> = {}) => {
  const salt = Buffer.alloc(32, 7);
  const enrollmentRequest = mock(async () => undefined);
  const enroll: HostedFreshOrganizationDependencies['enroll'] = mock(async (deps, args) => {
    enrollmentRequest(deps, args);
    const ceremony = await deps.ceremony.requestEnrollment({
      userId: deps.userId,
      userEmail: deps.userEmail,
      prfSalt: args.presetPrfSalt!.toString('base64'),
    });
    return ceremony.ok
      ? {
          ok: true,
          credentialId: ceremony.credentialId,
          wrapperId: 'wrapper_demo',
          verified: true,
          backupEligible: ceremony.backupEligible,
          backupState: ceremony.backupState,
          orgs: [{ orgId: organization.id, status: 'uploaded' }],
        }
      : { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.code };
  });
  const serviceClient = {} as never;
  const value: HostedFreshOrganizationDependencies = {
    generateSeed: mock(() => 'abandon '.repeat(23) + 'about'),
    generateSalt: mock(() => salt),
    now: () => now,
    checkName: input.checkName ?? mock(async () => 'available' as const),
    createServiceClient: mock(() => serviceClient),
    enroll,
  };
  return { value, salt, enrollmentRequest };
};

const successAnswer = {
  v: 1,
  flow: 'device-key',
  ceremony: 'enroll',
  ok: true,
  credentialId: 'credential_demo',
  prfOutput: Buffer.alloc(32, 9).toString('base64'),
  backupEligible: true,
  backupState: false,
} as const;

test('shows the phrase once, sanitizes accepted progress and feeds the same salt through enrollment', async () => {
  const channel = channelHarness([{ name: organization.name }, { confirmed: true }, successAnswer]);
  const authority = authHarness(['success']);
  const deps = dependencies();
  const rebindSession = mock((session: HostedInitWizardSession) => session);
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession,
    dependencies: deps.value,
  });
  expect(result.kind).toBe('created');
  expect(authority.create).toHaveBeenCalledTimes(1);
  expect(rebindSession).toHaveBeenCalledWith(expect.any(Object), authority.replacement);
  expect(deps.enrollmentRequest).toHaveBeenCalledTimes(1);
  expect(deps.enrollmentRequest.mock.calls[0][1].presetPrfSalt).toEqual(deps.salt);
  const frames = channel.broker.sendRequest.mock.calls.map(frame);
  expect(frames.filter((item) => JSON.stringify(item).includes('abandon'))).toHaveLength(1);
  expect(frames.find((item) => item.screen === 'device-key')?.data).toEqual({
    v: 1,
    ceremony: 'enroll',
    prfSalt: deps.salt.toString('base64'),
  });
  const phraseProgress = frames.find((item) => item.kind === 'progress' && item.screen === 'create-organization'
    && (item.data as { view?: string }).view === 'creating');
  expect(phraseProgress?.data).not.toHaveProperty('phraseWords');
});

test('retries only the coded pre-refresh conflict with the same phrase and no second phrase view', async () => {
  const channel = channelHarness([
    { name: organization.name },
    { confirmed: true },
    { name: 'Northwind Labs' },
    successAnswer,
  ]);
  const authority = authHarness(['safe-conflict', 'success']);
  const deps = dependencies();
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession: (session) => session,
    dependencies: deps.value,
  });
  expect(result.kind).toBe('created');
  expect(authority.create).toHaveBeenCalledTimes(2);
  expect(authority.create.mock.calls.map((call) => call[0])).toEqual([organization.name, 'Northwind Labs']);
  expect(deps.value.generateSeed).toHaveBeenCalledTimes(1);
  const frames = channel.broker.sendRequest.mock.calls.map(frame);
  expect(frames.filter((item) => JSON.stringify(item).includes('abandon'))).toHaveLength(1);
  expect(frames.some((item) => item.kind === 'view'
    && item.screen === 'create-organization'
    && (item.data as { nameError?: string }).nameError === 'RACE_409')).toBe(true);
});

test('does not replay an uncoded conflict or unknown create outcome', async () => {
  const channel = channelHarness([{ name: organization.name }, { confirmed: true }]);
  const authority = authHarness(['unknown', 'success']);
  const deps = dependencies();
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession: (session) => session,
    dependencies: deps.value,
  });
  expect(result).toMatchObject({ kind: 'failed', effects: 'indeterminate' });
  expect(authority.create).toHaveBeenCalledTimes(1);
  expect(deps.value.enroll).not.toHaveBeenCalled();
});

test('preserves the advanced channel cursor when the bounded name check fails', async () => {
  const channel = channelHarness([{ name: organization.name }]);
  const authority = authHarness(['success']);
  const deps = dependencies({ checkName: mock(async () => {
    throw new CapyError('expired', 'INIT_RUN_EXPIRED');
  }) });
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession: (session) => session,
    dependencies: deps.value,
  });
  expect(result).toMatchObject({
    kind: 'failed',
    effects: 'none',
    error: { code: 'INIT_RUN_EXPIRED' },
    session: { channel: { sequence: 2 } },
  });
  expect(authority.create).not.toHaveBeenCalled();
});

test('passes a definitive nested refusal through the enrollment engine and preserves outer cancellation', async () => {
  const nested = channelHarness([
    { name: organization.name },
    { confirmed: true },
    { v: 1, flow: 'device-key', ceremony: 'enroll', ok: false, code: 'webauthn_unavailable' },
  ]);
  const nestedAuthority = authHarness(['success']);
  const nestedDeps = dependencies({ ceremonyOutcome: 'failure' });
  const nestedResult = await createHostedFreshOrganization({
    auth,
    authService: nestedAuthority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: nested.session,
    rebindSession: (session) => session,
    dependencies: nestedDeps.value,
  });
  expect(nestedResult).toMatchObject({ kind: 'created', enrollment: { ok: false, ceremonyCode: 'webauthn_unavailable' } });
  expect(nestedDeps.enrollmentRequest).toHaveBeenCalledTimes(1);

  const cancelled = channelHarness([{ name: organization.name }, { confirmed: true }, 'cancel']);
  const cancelledAuthority = authHarness(['success']);
  const cancelledDeps = dependencies();
  const cancelledResult = await createHostedFreshOrganization({
    auth,
    authService: cancelledAuthority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: cancelled.session,
    rebindSession: (session) => session,
    dependencies: cancelledDeps.value,
  });
  expect(cancelledResult).toMatchObject({ kind: 'cancelled', effects: 'indeterminate' });
  expect(cancelledDeps.enrollmentRequest).toHaveBeenCalledTimes(1);
});

test('retains replacement authority and starts no enrollment operation after the run deadline', async () => {
  const channel = channelHarness([{ name: organization.name }, { confirmed: true }]);
  const authority = authHarness(['success']);
  const deps = dependencies();
  const deadlineNow = mock(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now + 7200000);
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession: (session) => session,
    dependencies: { ...deps.value, now: deadlineNow },
  });
  expect(result).toMatchObject({
    kind: 'failed',
    effects: 'indeterminate',
    authService: authority.replacement,
  });
  expect(deps.value.generateSalt).not.toHaveBeenCalled();
  expect(deps.value.enroll).not.toHaveBeenCalled();
});

test('deadline guards forward enrollment operations while preserving the replacement authority', async () => {
  const channel = channelHarness([{ name: organization.name }, { confirmed: true }]);
  const authority = authHarness(['success']);
  const base = dependencies();
  const deadlineNow = mock(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now + 7200000);
  const enroll: HostedFreshOrganizationDependencies['enroll'] = mock(async (deps) => {
    await deps.ops.uploadDoorWrapper({
      wrapped_k_local: 'ciphertext',
      iv: 'iv',
      prf_salt: Buffer.alloc(32).toString('base64'),
      credential_id: 'credential_demo',
      kdf_version: 1,
    });
    throw new Error('unreachable');
  });
  const result = await createHostedFreshOrganization({
    auth,
    authService: authority.initial,
    deadline: now + 7200000,
    serviceOrigin: binding.service_origin,
    session: channel.session,
    rebindSession: (session) => session,
    dependencies: { ...base.value, now: deadlineNow, enroll },
  });
  expect(result).toMatchObject({
    kind: 'failed',
    effects: 'indeterminate',
    authService: authority.replacement,
    error: { code: 'INIT_RUN_EXPIRED' },
  });
  expect(enroll).toHaveBeenCalledTimes(1);
  expect(channel.broker.pollAnswer).toHaveBeenCalledTimes(2);
});
