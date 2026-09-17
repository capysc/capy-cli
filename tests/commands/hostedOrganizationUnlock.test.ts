import { expect, mock, test } from 'bun:test';
import type { AuthService } from '../../src/auth/authService';
import type { CeremonyAborted, OnboardingDeps, UnlockSummary } from '../../src/auth/deviceKey/onboarding';
import type { UnlockRequest } from '../../src/auth/deviceKey/ceremonyTransport';
import type { ServiceClient } from '../../src/service/serviceClient';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { BrokerConnection } from '../../src/service/brokerClient';
import type { AuthResult } from '../../src/types';
import type { InitRunBinding, InitWizardFrame } from '../../src/auth/initRunContract';
import { HostedInitChannelError } from '../../src/ui/hostedInitChannel';
import type { HostedInitWizardSession } from '../../src/ui/hostedInitWizardSession';
import { PASSPHRASE_CREDENTIAL_ID } from '../../src/auth/deviceKey/passphraseDoor';
import {
  parseHostedUnlockAnswer,
  unlockHostedOrganization,
  validateHostedUnlockRequest,
  type HostedOrganizationUnlockDependencies,
} from '../../src/commands/hostedOrganizationUnlock';

const now = Date.parse('2026-09-11T17:00:00.000Z');
const deadline = now + 7_200_000;
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'user_demo';
const serviceOrigin = 'https://api.dev.example';
const credentialId = 'credential_demo';
const prfSalt = Buffer.alloc(32, 7).toString('base64');
const prfOutput = Buffer.alloc(32, 8).toString('base64');

const binding: InitRunBinding = {
  run_id: '11111111-1111-4111-8111-111111111111',
  subject_user_id: userId,
  service_origin: serviceOrigin,
  runtime_id: '77777777-7777-4777-8777-777777777777',
  repository_fingerprint: `sha256:${'a'.repeat(64)}`,
  cli_key_fingerprint: `sha256:${'b'.repeat(64)}`,
};

const auth: AuthResult = {
  success: true,
  user_id: userId,
  user_email: 'person@example.test',
  organization_id: organizationId,
  organization_name: 'Northwind',
  organizations: [{
    id: organizationId,
    workos_org_id: 'org_provider',
    name: 'Northwind',
    key_state: 'minted',
  }],
};

const unlockRequest: UnlockRequest = {
  userId,
  candidates: [{ credentialId, prfSalt }],
};

const connection = (index: number): BrokerConnection => ({
  connectionId: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900_000).toISOString(),
  keypair: mintConnectionKeypair(),
});

type BrowserAnswer = Readonly<Record<string, unknown>> | 'outer-cancel';

const channelHarness = (answer: BrowserAnswer, nowFn: () => number = () => now) => {
  const connections = [connection(1), connection(2), connection(3)] as const;
  const createConnection = mock(async () => connections[2]);
  const pollExchange = mock(async () => ({ kind: 'pending' as const, pagePubkeyB64: 'synthetic-page-key' }));
  const pollAnswer = mock(async () => ({
    kind: 'answered' as const,
    plaintext: JSON.stringify({
      v: 1,
      flow: 'init-wizard',
      binding,
      sequence: 0,
      attempt_id: 'attempt_1',
      ...(answer === 'outer-cancel'
        ? { kind: 'cancel' }
        : { kind: 'answer', answer }),
    }),
  }));
  const sendRequest = mock(async () => ({ kind: 'sent' as const }));
  const cancel = mock(async () => undefined);
  const session: HostedInitWizardSession = {
    channel: {
      broker: { createConnection, pollExchange, pollAnswer, sendRequest, cancel },
      binding,
      current: connections[0],
      successor: connections[1],
      sequence: 0,
      deadline,
      now: nowFn,
      attemptId: () => 'attempt_1',
      pause: async () => undefined,
      cleanupTimeoutMs: 10,
    },
    input: { organization: { kind: 'existing', name: 'Northwind' } },
    step: 'organization',
    block: null,
    encryptView: null,
    ended: false,
  };
  return { connections, session, createConnection, pollAnswer, sendRequest, cancel };
};

const authHarness = (input: Readonly<{
  authOrganizationId?: string | null;
  serviceOrganizationId?: string | null;
  origin?: string;
  restored?: AuthResult;
}> = {}) => {
  const restore = mock(async () => input.restored ?? auth);
  const authService = {
    getOrganizationId: () => input.serviceOrganizationId === undefined ? organizationId : input.serviceOrganizationId,
    getServiceApiUrl: () => input.origin ?? serviceOrigin,
    authenticateSilent: restore,
  } as unknown as AuthService;
  return {
    authService,
    restore,
    auth: {
      ...auth,
      organization_id: input.authOrganizationId === undefined ? organizationId : input.authOrganizationId ?? undefined,
    },
  };
};

const emptyServiceOps = () => ({
  ops: {
    listWrappers: mock(async () => []),
    fetchWrapper: mock(async () => { throw new Error('unexpected fetchWrapper'); }),
    uploadDoorWrapper: mock(async () => { throw new Error('unexpected uploadDoorWrapper'); }),
    verifyWrapper: mock(async () => undefined),
    deleteWrapper: mock(async () => undefined),
  },
  opsForOrg: mock(async () => null),
});

const dependencies = (input: Readonly<{
  detect: HostedOrganizationUnlockDependencies['detect'];
  unlock: HostedOrganizationUnlockDependencies['unlock'];
  serviceOps?: HostedOrganizationUnlockDependencies['serviceOps'];
}>): HostedOrganizationUnlockDependencies => ({
  detect: input.detect,
  unlock: input.unlock,
  serviceOps: input.serviceOps ?? (() => emptyServiceOps()),
});

const unlockDetection = {
  kind: 'unlock',
  inventory: [],
  orgsWithLocalRoot: [],
} as const;

const unavailableDetection = {
  kind: 'recovery_or_transport',
  inventory: [],
  orgsWithLocalRoot: [],
} as const;

const capturedCode = (operation: () => unknown): string | null => {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof HostedInitChannelError ? error.code : 'UNEXPECTED_ERROR';
  }
};

const decodedFrame = (call: readonly unknown[]): InitWizardFrame<unknown> =>
  JSON.parse(call[2] as string) as InitWizardFrame<unknown>;

test('request validation closes null, malformed, oversized, duplicate, and extra-key candidates', () => {
  const malformed = [
    null,
    {},
    { userId, candidates: null },
    { userId, candidates: [] },
    { userId: 'user_other', candidates: unlockRequest.candidates },
    { userId, candidates: [null] },
    { userId, candidates: [{ credentialId, prfSalt, extra: true }] },
    { userId, candidates: [{ credentialId: 'not valid', prfSalt }] },
    { userId, candidates: [{ credentialId, prfSalt: Buffer.alloc(31).toString('base64') }] },
    { userId, candidates: [unlockRequest.candidates[0], unlockRequest.candidates[0]] },
    { userId, candidates: Array.from({ length: 33 }, (_, index) => ({ credentialId: `credential_${index}`, prfSalt })) },
  ] as const;
  expect(malformed.map((request) => capturedCode(() =>
    validateHostedUnlockRequest(request as unknown as UnlockRequest, userId))))
    .toEqual(malformed.map(() => 'INIT_RUN_INVALID'));
  expect(capturedCode(() => validateHostedUnlockRequest(unlockRequest, userId))).toBeNull();
  expect(capturedCode(() => validateHostedUnlockRequest({
    userId,
    candidates: [{ credentialId: PASSPHRASE_CREDENTIAL_ID, prfSalt }],
  }, userId))).toBeNull();
});

test('answer validation accepts only closed failures or a candidate-bound PRF result', () => {
  const validFailure = { v: 1, flow: 'device-key', ceremony: 'unlock', ok: false, code: 'no_credential' } as const;
  const validSuccess = { v: 1, flow: 'device-key', ceremony: 'unlock', ok: true, credentialId, prfOutput } as const;
  expect(parseHostedUnlockAnswer(validFailure, unlockRequest)).toEqual({ ok: false, code: 'no_credential' });
  expect(parseHostedUnlockAnswer(validSuccess, unlockRequest)).toEqual({ ok: true, credentialId, prfOutput });
  const malformed = [
    null,
    {},
    { ...validFailure, code: 'private_error' },
    { ...validFailure, extra: true },
    { ...validSuccess, credentialId: 'credential_other' },
    { ...validSuccess, prfOutput: Buffer.alloc(31).toString('base64') },
    { ...validSuccess, extra: true },
  ] as const;
  expect(malformed.map((payload) => capturedCode(() =>
    parseHostedUnlockAnswer(payload as unknown as Readonly<Record<string, unknown>>, unlockRequest))))
    .toEqual(malformed.map(() => 'INIT_RUN_INVALID'));
});

test('refuses wrong subject, service origin, selected organization, current authority, or membership before detection', async () => {
  const channel = channelHarness({ v: 1 });
  const detect = mock(async () => unlockDetection);
  const unlock = mock(async (): Promise<UnlockSummary> => ({ ok: true, credentialId, orgs: [] }));
  const baseAuthority = authHarness();
  const cases = [
    { session: { ...channel.session, channel: { ...channel.session.channel, binding: { ...binding, subject_user_id: 'user_other' } } }, auth: auth, authService: baseAuthority.authService },
    { session: channel.session, auth, authService: authHarness({ origin: 'https://other.example' }).authService },
    { session: channel.session, auth: authHarness({ authOrganizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).auth, authService: baseAuthority.authService },
    { session: channel.session, auth, authService: authHarness({ serviceOrganizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).authService },
    { session: channel.session, auth: { ...auth, organizations: [] }, authService: baseAuthority.authService },
  ] as const;
  const outcomes = await Promise.all(cases.map((entry) => unlockHostedOrganization({
    ...entry,
    serviceClient: {} as ServiceClient,
    organizationId,
    dependencies: dependencies({ detect, unlock }),
  })));
  expect(outcomes.map((outcome) => outcome.kind)).toEqual(cases.map(() => 'failed'));
  expect(outcomes.map((outcome) => outcome.kind === 'failed' && capturedCode(() => { throw outcome.error; })))
    .toEqual(cases.map(() => 'INIT_RUN_INVALID'));
  expect(detect).not.toHaveBeenCalled();
});

test('uses the existing encrypted channel, advances its successor, installs the selected org, and restores its authority', async () => {
  const channel = channelHarness({
    v: 1, flow: 'device-key', ceremony: 'unlock', ok: true, credentialId, prfOutput,
  });
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    const ceremony = await deps.ceremony.requestUnlock(unlockRequest);
    return ceremony.ok
      ? { ok: true, credentialId: ceremony.credentialId, orgs: [{ orgId: organizationId, status: 'installed' }] }
      : { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.code };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth,
    authService: authority.authService,
    serviceClient: {} as ServiceClient,
    organizationId,
    session: channel.session,
    dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({
    kind: 'finished', installedCurrentOrg: true, effectsStarted: true,
    session: { ended: false, channel: { sequence: 2, current: { connectionId: channel.connections[2].connectionId } } },
  });
  expect(authority.restore).toHaveBeenCalledTimes(1);
  expect(authority.restore).toHaveBeenCalledWith(organizationId);
  expect(channel.sendRequest).toHaveBeenCalledTimes(2);
  const frames = channel.sendRequest.mock.calls.map(decodedFrame);
  expect(frames[0]).toMatchObject({
    kind: 'ceremony', screen: 'device-key', sequence: 0,
    data: { v: 1, ceremony: 'unlock', candidates: unlockRequest.candidates },
  });
  expect(frames[1]).toMatchObject({ kind: 'progress', screen: 'device-key', sequence: 1 });
  expect(JSON.stringify(frames)).not.toContain(prfOutput);
  expect(channel.session.channel.sequence).toBe(0);
});

test('a typed ceremony cancellation advances the channel without restoring or writing authority', async () => {
  const channel = channelHarness({
    v: 1, flow: 'device-key', ceremony: 'unlock', ok: false, code: 'cancelled',
  });
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    const ceremony = await deps.ceremony.requestUnlock(unlockRequest);
    return ceremony.ok
      ? { ok: true, credentialId: ceremony.credentialId, orgs: [] }
      : { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.code };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({ kind: 'cancelled', session: { ended: false, channel: { sequence: 2 } } });
  expect(authority.restore).not.toHaveBeenCalled();
  expect(channel.sendRequest).toHaveBeenCalledTimes(2);
});

test('an outer channel cancellation closes the session and never reaches selected-org restoration', async () => {
  const channel = channelHarness('outer-cancel');
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    const ceremony = await deps.ceremony.requestUnlock(unlockRequest);
    return ceremony.ok
      ? { ok: true, credentialId: ceremony.credentialId, orgs: [] }
      : { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.code };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({ kind: 'cancelled', session: { ended: true } });
  expect(authority.restore).not.toHaveBeenCalled();
  expect(channel.cancel).toHaveBeenCalledWith(channel.connections[0].connectionId);
  expect(channel.cancel).toHaveBeenCalledWith(channel.connections[1].connectionId);
});

test('unavailable inventory returns the existing recovery path without opening a ceremony', async () => {
  const channel = channelHarness({ v: 1 });
  const authority = authHarness();
  const detect = mock(async () => unavailableDetection);
  const unlock = mock(async (): Promise<UnlockSummary> => ({ ok: true, credentialId, orgs: [] }));
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toEqual({
    kind: 'finished', session: channel.session, installedCurrentOrg: false, effectsStarted: false,
  });
  expect(unlock).not.toHaveBeenCalled();
  expect(channel.sendRequest).not.toHaveBeenCalled();
  expect(authority.restore).not.toHaveBeenCalled();
});

test('the per-operation deadline guard refuses a service call before the underlying operation starts', async () => {
  const clock = mock(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementation(() => deadline);
  const channel = channelHarness({ v: 1 }, clock);
  const authority = authHarness();
  const listWrappers = mock(async () => []);
  const serviceOps: HostedOrganizationUnlockDependencies['serviceOps'] = () => ({
    ...emptyServiceOps(),
    ops: { ...emptyServiceOps().ops, listWrappers },
  });
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    await deps.ops.listWrappers();
    return { ok: true, credentialId, orgs: [] };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock, serviceOps }),
  });
  expect(result).toMatchObject({ kind: 'failed', error: { code: 'INIT_RUN_EXPIRED' } });
  expect(listWrappers).not.toHaveBeenCalled();
  expect(authority.restore).not.toHaveBeenCalled();
});

test('a scoped operation obtained before expiry cannot start its underlying fetch after expiry', async () => {
  const clock = mock(() => now);
  const channel = channelHarness({ v: 1 }, clock);
  const authority = authHarness();
  const fetchKeyEnc = mock(async () => 'wrapped-key');
  const opsForOrg = mock(async () => ({
    coDecrypt: mock(async () => 'plaintext'),
    wrapOuterLayer: mock(async () => 'ciphertext'),
    uploadKeyEnc: mock(async () => undefined),
    fetchKeyEnc,
  }));
  const serviceOps: HostedOrganizationUnlockDependencies['serviceOps'] = () => ({
    ...emptyServiceOps(),
    opsForOrg,
  });
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    const scoped = await deps.opsForOrg(organizationId);
    if (!scoped) throw new Error('expected scoped operations');
    clock.mockImplementation(() => deadline);
    await scoped.fetchKeyEnc('wrapper_demo');
    return { ok: true, credentialId, orgs: [] };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock, serviceOps }),
  });
  expect(result).toMatchObject({ kind: 'failed', error: { code: 'INIT_RUN_EXPIRED' } });
  expect(opsForOrg).toHaveBeenCalledTimes(1);
  expect(fetchKeyEnc).not.toHaveBeenCalled();
  expect(authority.restore).not.toHaveBeenCalled();
});

test('expiry after selected-org restoration refuses continuation', async () => {
  const clock = mock(() => deadline)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now)
    .mockImplementationOnce(() => now);
  const channel = channelHarness({ v: 1 }, clock);
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock = mock(async (): Promise<UnlockSummary> => ({
    ok: true, credentialId, orgs: [{ orgId: organizationId, status: 'installed' }],
  }));
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({ kind: 'failed', error: { code: 'INIT_RUN_EXPIRED' } });
  expect(authority.restore).toHaveBeenCalledTimes(1);
});

test('a restored token for another subject cannot authorize continuation', async () => {
  const channel = channelHarness({ v: 1 });
  const authority = authHarness({ restored: { ...auth, user_id: 'user_other' } });
  const detect = mock(async () => unlockDetection);
  const unlock = mock(async (): Promise<UnlockSummary> => ({
    ok: true, credentialId, orgs: [{ orgId: organizationId, status: 'installed' }],
  }));
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({ kind: 'failed', error: { code: 'AUTH_FAILED' } });
  expect(authority.restore).toHaveBeenCalledTimes(1);
  expect(authority.restore).toHaveBeenCalledWith(organizationId);
});

test('preserves the advanced channel on a definitive ceremony error', async () => {
  const channel = channelHarness({
    v: 1, flow: 'device-key', ceremony: 'unlock', ok: false, code: 'no_credential',
  });
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock: HostedOrganizationUnlockDependencies['unlock'] = mock(async (deps) => {
    const ceremony = await deps.ceremony.requestUnlock(unlockRequest);
    return ceremony.ok
      ? { ok: true, credentialId: ceremony.credentialId, orgs: [] }
      : { ok: false, code: 'DEVICE_KEY_CEREMONY_FAILED', ceremonyCode: ceremony.code };
  });
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({
    kind: 'failed',
    session: { ended: false, channel: { sequence: 2 } },
    error: { code: 'DEVICE_KEY_CEREMONY_FAILED', details: { ceremonyCode: 'no_credential' } },
  });
  expect(authority.restore).not.toHaveBeenCalled();
});

test('reports partial cross-org installation without claiming the selected org was installed', async () => {
  const channel = channelHarness({ v: 1 });
  const authority = authHarness();
  const detect = mock(async () => unlockDetection);
  const unlock = mock(async (): Promise<UnlockSummary | CeremonyAborted> => ({
    ok: true,
    credentialId,
    orgs: [
      { orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'installed' },
      { orgId: organizationId, status: 'failed', code: 'WRAPPER_NOT_FOUND' },
    ],
  }));
  const result = await unlockHostedOrganization({
    auth: authority.auth, authService: authority.authService, serviceClient: {} as ServiceClient,
    organizationId, session: channel.session, dependencies: dependencies({ detect, unlock }),
  });
  expect(result).toMatchObject({ kind: 'finished', installedCurrentOrg: false, effectsStarted: true });
  expect(authority.restore).toHaveBeenCalledTimes(1);
});
