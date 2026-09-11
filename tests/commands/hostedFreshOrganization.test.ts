import { expect, mock, test } from 'bun:test';
import type {
  AuthService,
  InstalledExchangeResponse,
  RenewedInitRunIdentity,
} from '../../src/auth/authService';
import type { BrokerConnection } from '../../src/service/brokerClient';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { ServiceClient } from '../../src/service/serviceClient';
import type { AuthResult } from '../../src/types';
import type { InitRunBinding, InitWizardFrame } from '../../src/auth/initRunContract';
import type { HostedInitWizardSession } from '../../src/ui/hostedInitWizardSession';
import {
  createHostedFreshOrganization,
  parseHostedPersonalMint,
  type HostedFreshOrganizationDependencies,
} from '../../src/commands/hostedFreshOrganization';

const now = Date.parse('2026-09-10T05:00:00.000Z');
const deadline = now + 7_200_000;
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
  name: 'quiet-river-a1b2c3',
  key_state: 'minting' as const,
};
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mintClaim = {
  key_state: 'minting' as const,
  expires_at: new Date(now + 900_000).toISOString(),
};
const mintResponse = {
  org_id: organization.id,
  project_id: projectId,
  mint_claim: mintClaim,
  organization: {
    id: organization.id,
    workos_org_id: organization.workos_org_id,
    name: organization.name,
  },
} as const;
const auth: AuthResult = {
  success: true,
  organization_id: '',
  user_id: binding.subject_user_id,
  user_email: 'person@example.test',
  organizations: [],
  _refresh_token: 'refresh_initial',
  _orgless_access_token: 'identity_initial',
};
const renewedAuth: AuthResult = {
  ...auth,
  _refresh_token: `refresh_${'r'.repeat(512)}`,
  _orgless_access_token: `header.payload.${'s'.repeat(512)}`,
};
const replacementAuth: AuthResult = {
  success: true,
  organization_id: organization.id,
  organization_name: organization.name,
  user_id: binding.subject_user_id,
  user_email: auth.user_email,
  organizations: [organization],
};
const readiness = {
  key_state: 'minted' as const,
  signup_complete: true,
  retryable: false,
  custody: {
    key_state: 'minted',
    ceremony_pending: false,
    has_live_wrapped_k_local: true,
  },
} as const;
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

type Answer = Readonly<Record<string, unknown>> | 'cancel';

const connection = (index: number): BrokerConnection => ({
  connectionId: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900_000).toISOString(),
  keypair: mintConnectionKeypair(),
});

const channelHarness = (answers: readonly Answer[], inputBinding: InitRunBinding = binding) => {
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
      binding: inputBinding,
      sequence: index * 2,
      attempt_id: 'attempt_1',
      ...(answer === 'cancel' ? { kind: 'cancel' } : { kind: 'answer', answer }),
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
  const session: HostedInitWizardSession = {
    channel: {
      broker,
      binding: inputBinding,
      current: connections[0],
      successor: connections[1],
      sequence: 0,
      deadline,
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

const authServices = () => {
  const initial = {
    getOrganizationId: () => null,
    getServiceApiUrl: () => binding.service_origin,
  } as unknown as AuthService;
  const renewed = {
    getOrganizationId: () => null,
    getServiceApiUrl: () => binding.service_origin,
  } as unknown as AuthService;
  const replacement = {
    getOrganizationId: () => organization.id,
    getServiceApiUrl: () => binding.service_origin,
    getValidToken: mock(async () => null),
  } as unknown as AuthService;
  const identity: RenewedInitRunIdentity = {
    auth: renewedAuth,
    authService: renewed,
    accessToken: renewedAuth._orgless_access_token!,
  };
  const installed: InstalledExchangeResponse = { auth: replacementAuth, authService: replacement };
  return { initial, renewed, replacement, identity, installed };
};

const dependencyHarness = (input: Readonly<{
  services?: ReturnType<typeof authServices>;
  mint?: unknown;
  enrollment?: 'success' | 'failure';
  finalized?: typeof readiness | Readonly<{ signup_complete: false }>;
  now?: () => number;
}> = {}) => {
  const services = input.services ?? authServices();
  const orglessClient = {} as ServiceClient;
  const serviceClient = {} as ServiceClient;
  const renewIdentity = mock(async () => services.identity);
  const createOrglessServiceClient = mock(() => orglessClient);
  const mintPersonalOrganization = mock(async () => input.mint ?? mintResponse);
  const installOrganization = mock(async () => services.installed);
  const createServiceClient = mock(() => serviceClient);
  const finalizeSignupCustody = mock(async () => input.finalized ?? readiness);
  const enrollmentRequest = mock(async () => undefined);
  const enroll: HostedFreshOrganizationDependencies['enroll'] = mock(async (deps, args) => {
    enrollmentRequest(deps, args);
    const ceremony = await deps.ceremony.requestEnrollment({
      userId: deps.userId,
      userEmail: deps.userEmail,
      prfSalt: args.presetPrfSalt!.toString('base64'),
    });
    return input.enrollment === 'failure' || !ceremony.ok
      ? { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.ok ? 'transport_error' : ceremony.code }
      : {
          ok: true,
          credentialId: ceremony.credentialId,
          wrapperId: 'wrapper_demo',
          verified: true,
          backupEligible: ceremony.backupEligible,
          backupState: ceremony.backupState,
          orgs: [{ orgId: organization.id, status: 'uploaded' }],
        };
  });
  const value: HostedFreshOrganizationDependencies = {
    generateSeed: mock(() => 'abandon '.repeat(23) + 'about'),
    generateSalt: mock(() => Buffer.alloc(32, 7)),
    now: input.now ?? (() => now),
    renewIdentity,
    createOrglessServiceClient,
    mintPersonalOrganization,
    installOrganization,
    createServiceClient,
    finalizeSignupCustody: finalizeSignupCustody as HostedFreshOrganizationDependencies['finalizeSignupCustody'],
    enroll,
  };
  return {
    value,
    services,
    orglessClient,
    serviceClient,
    renewIdentity,
    createOrglessServiceClient,
    mintPersonalOrganization,
    installOrganization,
    createServiceClient,
    finalizeSignupCustody,
    enrollmentRequest,
  };
};

const frame = (call: readonly unknown[]): InitWizardFrame<Record<string, unknown>> =>
  JSON.parse(call[2] as string) as InitWizardFrame<Record<string, unknown>>;

const run = (
  channel: ReturnType<typeof channelHarness>,
  dependencies: ReturnType<typeof dependencyHarness>,
  inputAuth: AuthResult = auth,
) => createHostedFreshOrganization({
  auth: inputAuth,
  authService: dependencies.services.initial,
  deadline,
  serviceOrigin: binding.service_origin,
  session: channel.session,
  rebindSession: (session) => session,
  dependencies: dependencies.value,
});

test('confirms the nameless phrase before mint, adopts the default project, and finalizes exact custody', async () => {
  const channel = channelHarness([{ confirmed: true }, successAnswer]);
  const dependencies = dependencyHarness();
  dependencies.mintPersonalOrganization.mockImplementationOnce(async () => {
    expect(channel.broker.sendRequest.mock.calls.length).toBeGreaterThan(0);
    expect(channel.broker.pollAnswer).toHaveBeenCalledTimes(1);
    return mintResponse;
  });

  const result = await run(channel, dependencies);

  expect(result).toMatchObject({
    kind: 'created',
    organization,
    projectId,
    mintClaim,
    enrollment: { ok: true, credentialId: successAnswer.credentialId },
    readiness,
  });
  expect(dependencies.renewIdentity).toHaveBeenCalledWith(dependencies.services.initial, {
    userId: binding.subject_user_id,
    deadline,
  });
  expect(renewedAuth._refresh_token!.length).toBeGreaterThan(255);
  expect(renewedAuth._orgless_access_token!.length).toBeGreaterThan(255);
  expect(dependencies.mintPersonalOrganization).toHaveBeenCalledWith(dependencies.orglessClient);
  expect(dependencies.installOrganization).toHaveBeenCalledWith({
    authService: dependencies.services.renewed,
    refreshToken: renewedAuth._refresh_token,
    organizationId: organization.id,
    userId: binding.subject_user_id,
  });
  expect(dependencies.finalizeSignupCustody).toHaveBeenCalledWith(
    dependencies.serviceClient,
    organization.id,
    successAnswer.credentialId,
  );
  const frames = channel.broker.sendRequest.mock.calls.map(frame);
  const phrase = frames[0]?.data as Readonly<Record<string, unknown>>;
  expect(phrase).not.toHaveProperty('name');
  expect(phrase).not.toHaveProperty('nameStatus');
  expect(phrase).not.toHaveProperty('nameError');
  expect(phrase.stops).toEqual([
    { id: 'phrase', label: 'Recovery phrase', state: 'current' },
    { id: 'device-key', label: 'Device key', state: 'upcoming' },
  ]);
  const progress = frames.find((item) => item.kind === 'progress'
    && item.screen === 'create-organization')?.data;
  expect(progress).not.toHaveProperty('name');
  expect(progress).not.toHaveProperty('phraseWords');
  expect(progress).not.toHaveProperty('phraseRevealed');
  expect(progress?.stops).toEqual([
    { id: 'phrase', label: 'Recovery phrase', state: 'done', answer: 'written down' },
    { id: 'device-key', label: 'Device key', state: 'upcoming' },
  ]);
  expect(frames.every((item) => !JSON.stringify(item).includes('abandon')
    || item.screen === 'create-organization')).toBe(true);
});

test('cancellation before the mint transition has no effects', async () => {
  const channel = channelHarness(['cancel']);
  const dependencies = dependencyHarness();

  await expect(run(channel, dependencies)).resolves.toMatchObject({ kind: 'cancelled', effects: 'none' });
  expect(dependencies.renewIdentity).not.toHaveBeenCalled();
  expect(dependencies.mintPersonalOrganization).not.toHaveBeenCalled();
  expect(dependencies.installOrganization).not.toHaveBeenCalled();
  expect(dependencies.value.enroll).not.toHaveBeenCalled();
});

test('identity renewal refusal before mint remains effects-none', async () => {
  const channel = channelHarness([{ confirmed: true }]);
  const dependencies = dependencyHarness();
  dependencies.renewIdentity.mockRejectedValueOnce(new Error('renewal refused'));

  await expect(run(channel, dependencies)).resolves.toMatchObject({ kind: 'failed', effects: 'none' });
  expect(dependencies.renewIdentity).toHaveBeenCalledTimes(1);
  expect(dependencies.mintPersonalOrganization).not.toHaveBeenCalled();
  expect(dependencies.installOrganization).not.toHaveBeenCalled();
});

test('strictly validates the personal mint identities and lease', async () => {
  const malformed = [
    null,
    [],
    { ...mintResponse, project_id: '' },
    { ...mintResponse, extra: true },
    { ...mintResponse, organization: { ...mintResponse.organization, id: 'other' } },
    { ...mintResponse, mint_claim: { ...mintClaim, key_state: 'minted' } },
    { ...mintResponse, mint_claim: { ...mintClaim, expires_at: new Date(now).toISOString() } },
  ] as const;

  expect(parseHostedPersonalMint(mintResponse, now)).toEqual({ organization, projectId, mintClaim });
  expect(malformed.map((value) => parseHostedPersonalMint(value, now))).toEqual(malformed.map(() => null));
});

test('a malformed mint response is indeterminate and never installs or enrolls', async () => {
  const channel = channelHarness([{ confirmed: true }]);
  const dependencies = dependencyHarness({ mint: { ...mintResponse, project_id: '' } });

  await expect(run(channel, dependencies)).resolves.toMatchObject({
    kind: 'failed',
    effects: 'indeterminate',
    authService: dependencies.services.renewed,
  });
  expect(dependencies.installOrganization).not.toHaveBeenCalled();
  expect(dependencies.value.enroll).not.toHaveBeenCalled();
  expect(dependencies.finalizeSignupCustody).not.toHaveBeenCalled();
});

test('rejects replacement authority drift after one mint without starting custody', async () => {
  const channel = channelHarness([{ confirmed: true }]);
  const services = authServices();
  const dependencies = dependencyHarness({ services: {
    ...services,
    installed: {
      ...services.installed,
      auth: { ...replacementAuth, user_id: 'other_user' },
    },
  } });

  await expect(run(channel, dependencies)).resolves.toMatchObject({ kind: 'failed', effects: 'indeterminate' });
  expect(dependencies.mintPersonalOrganization).toHaveBeenCalledTimes(1);
  expect(dependencies.installOrganization).toHaveBeenCalledTimes(1);
  expect(dependencies.value.enroll).not.toHaveBeenCalled();
});

test('blocks repository continuation on definitive device refusal without calling the custody finalizer', async () => {
  const channel = channelHarness([
    { confirmed: true },
    { v: 1, flow: 'device-key', ceremony: 'enroll', ok: false, code: 'webauthn_unavailable' },
  ]);
  const dependencies = dependencyHarness({ enrollment: 'failure' });

  await expect(run(channel, dependencies)).resolves.toMatchObject({
    kind: 'failed',
    effects: 'indeterminate',
    error: { code: 'DEVICE_KEY_CEREMONY_FAILED', details: { ceremonyCode: 'webauthn_unavailable' } },
    authService: dependencies.services.replacement,
    session: { channel: { sequence: 4 } },
  });
  expect(dependencies.finalizeSignupCustody).not.toHaveBeenCalled();
});

test('device-custody cancellation after mint is indeterminate', async () => {
  const channel = channelHarness([{ confirmed: true }, 'cancel']);
  const dependencies = dependencyHarness();

  await expect(run(channel, dependencies)).resolves.toMatchObject({
    kind: 'cancelled',
    effects: 'indeterminate',
  });
  expect(dependencies.mintPersonalOrganization).toHaveBeenCalledTimes(1);
  expect(dependencies.value.enroll).toHaveBeenCalledTimes(1);
  expect(dependencies.finalizeSignupCustody).not.toHaveBeenCalled();
});

test('fails indeterminate when authoritative finalization remains incomplete', async () => {
  const channel = channelHarness([{ confirmed: true }, successAnswer]);
  const dependencies = dependencyHarness({ finalized: { signup_complete: false } });

  await expect(run(channel, dependencies)).resolves.toMatchObject({
    kind: 'failed',
    effects: 'indeterminate',
    error: { code: 'SERVICE_ERROR' },
  });
  expect(dependencies.finalizeSignupCustody).toHaveBeenCalledTimes(1);
});

test('rejects initial subject and origin drift before phrase or identity work', async () => {
  const driftedBinding = { ...binding, subject_user_id: 'other_user' };
  const channel = channelHarness([], driftedBinding);
  const dependencies = dependencyHarness();

  await expect(run(channel, dependencies)).resolves.toMatchObject({ kind: 'failed', effects: 'none' });
  expect(channel.broker.sendRequest).not.toHaveBeenCalled();
  expect(dependencies.renewIdentity).not.toHaveBeenCalled();
  expect(dependencies.mintPersonalOrganization).not.toHaveBeenCalled();
});
