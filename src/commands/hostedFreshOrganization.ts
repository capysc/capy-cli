import type {
  AuthService,
  InstalledExchangeResponse,
  RenewedInitRunIdentity,
} from '../auth/authService';
import type {
  CeremonyFailure,
  CeremonyFailureCode,
  CeremonyTransport,
  EnrollmentRequest,
  EnrollmentSuccess,
  UnlockRequest,
} from '../auth/deviceKey/ceremonyTransport';
import { generatePrfSalt, isWellFormedPrfOutput } from '../auth/deviceKey/crypto';
import { runNewUserEnrollment } from '../auth/deviceKey/onboarding';
import { createDeviceKeyServiceOps } from '../auth/deviceKey/serviceOps';
import { CURRENT_KDF_VERSION, generateSeedPhrase, seedPhraseToMasterKey } from '../crypto/keyManager';
import { ServiceClient, type FinalizedSignupCustody } from '../service/serviceClient';
import type { AuthResult, Organization, ServiceToken } from '../types';
import { CapyError, ERROR_CODES } from '../types';
import { askHostedInitChannel, HostedInitChannelError } from '../ui/hostedInitChannel';
import type { HostedInitWizardSession } from '../ui/hostedInitWizardSession';
import { SEED_PHRASE_WORDS } from '../ui/onboardingWeb';
import type { CreateOrganizationData } from '../ui/screens/contract';
import { MAX_ORG_NAME_LENGTH, ORG_PHRASE_NOTES, ZERO_TRUST_URL } from './orgCreation';

const CEREMONY_FAILURES: readonly CeremonyFailureCode[] = [
  'cancelled', 'no_credential', 'prf_unsupported', 'webauthn_unavailable', 'transport_error',
];

type EnrollmentOutcome = Awaited<ReturnType<typeof runNewUserEnrollment>>;

export type HostedPersonalMint = Readonly<{
  organization: Organization & Readonly<{ key_state: 'minting' }>;
  projectId: string;
  mintClaim: Readonly<{ key_state: 'minting'; expires_at: string }>;
}>;

export type HostedFreshOrganizationResult =
  | Readonly<{
      kind: 'created';
      auth: AuthResult;
      authService: AuthService;
      serviceClient: ServiceClient;
      organization: HostedPersonalMint['organization'];
      projectId: string;
      mintClaim: HostedPersonalMint['mintClaim'];
      enrollment: EnrollmentOutcome;
      readiness: FinalizedSignupCustody;
      session: HostedInitWizardSession;
    }>
  | Readonly<{
      kind: 'cancelled';
      effects: 'none' | 'indeterminate';
      session: HostedInitWizardSession;
      authService?: AuthService;
    }>
  | Readonly<{
      kind: 'failed';
      effects: 'none' | 'indeterminate';
      error: unknown;
      session: HostedInitWizardSession;
      authService?: AuthService;
    }>;

type CeremonySettlement =
  | Readonly<{ kind: 'not-reached' }>
  | Readonly<{ kind: 'answered'; session: HostedInitWizardSession; outerCancelled: boolean }>;

export type HostedFreshOrganizationDependencies = Readonly<{
  generateSeed: () => string;
  generateSalt: () => Buffer;
  now: () => number;
  renewIdentity: (authService: AuthService, expected: Readonly<{
    userId: string;
    deadline: number;
  }>) => Promise<RenewedInitRunIdentity>;
  createOrglessServiceClient: (identity: RenewedInitRunIdentity, deadline: number) => ServiceClient;
  mintPersonalOrganization: (serviceClient: ServiceClient) => Promise<unknown>;
  installOrganization: (input: Readonly<{
    authService: AuthService;
    refreshToken: string;
    organizationId: string;
    userId: string;
  }>) => Promise<InstalledExchangeResponse>;
  createServiceClient: (authService: AuthService) => ServiceClient;
  finalizeSignupCustody: (
    serviceClient: ServiceClient,
    organizationId: string,
    credentialId: string,
  ) => Promise<FinalizedSignupCustody>;
  enroll: typeof runNewUserEnrollment;
}>;

const defaultDependencies = (serviceOrigin: string): HostedFreshOrganizationDependencies => ({
  generateSeed: generateSeedPhrase,
  generateSalt: generatePrfSalt,
  now: Date.now,
  renewIdentity: (authService, expected) => authService.renewInitRunIdentity(expected),
  createOrglessServiceClient: (identity, deadline) => {
    const token: ServiceToken = {
      access_token: identity.accessToken,
      refresh_token: identity.auth._refresh_token ?? '',
      expires_at: deadline,
      organization_id: '',
      user_id: identity.auth.user_id ?? '',
      user_email: identity.auth.user_email,
      user_first_name: identity.auth.user_first_name,
      user_last_name: identity.auth.user_last_name,
      organizations: [],
    };
    return new ServiceClient(serviceOrigin, false, async () => token);
  },
  mintPersonalOrganization: (serviceClient) => serviceClient.mintPersonalOrgCeremony(),
  installOrganization: (input) => input.authService.refreshWithCredentials(
    input.refreshToken,
    input.organizationId,
    input.userId,
  ),
  createServiceClient: (authService) => new ServiceClient(serviceOrigin, false, () => authService.getValidToken()),
  finalizeSignupCustody: (serviceClient, organizationId, credentialId) =>
    serviceClient.finalizeSignupCustody(organizationId, credentialId),
  enroll: runNewUserEnrollment,
});

const exactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length
  && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const invalidFrame = (): never => { throw new HostedInitChannelError('INIT_RUN_INVALID'); };

const checkOperationDeadline = (deadline: number, now: () => number): void => {
  if (now() >= deadline) throw new HostedInitChannelError('INIT_RUN_EXPIRED');
};

const exactServiceOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      ? value
      : null;
  } catch {
    return null;
  }
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const serviceIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 255
  && value.trim() === value && /^\S+$/u.test(value);

const opaqueCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536 && /^\S+$/u.test(value);

export const parseHostedPersonalMint = (value: unknown, now: number): HostedPersonalMint | null => {
  if (!record(value) || !exactKeys(value, ['org_id', 'project_id', 'mint_claim', 'organization'])
    || !serviceIdentifier(value.org_id) || !serviceIdentifier(value.project_id)
    || !record(value.mint_claim) || !exactKeys(value.mint_claim, ['key_state', 'expires_at'])
    || value.mint_claim.key_state !== 'minting' || typeof value.mint_claim.expires_at !== 'string'
    || !record(value.organization) || !exactKeys(value.organization, ['id', 'workos_org_id', 'name'])
    || value.organization.id !== value.org_id
    || !serviceIdentifier(value.organization.workos_org_id)
    || !serviceIdentifier(value.organization.name)) return null;
  const expiresAt = Date.parse(value.mint_claim.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return {
    organization: {
      id: value.org_id,
      workos_org_id: value.organization.workos_org_id,
      name: value.organization.name,
      key_state: 'minting',
    },
    projectId: value.project_id,
    mintClaim: { key_state: 'minting', expires_at: value.mint_claim.expires_at },
  };
};

const parseEnrollmentAnswer = (
  payload: Readonly<Record<string, unknown>>,
): EnrollmentSuccess | CeremonyFailure => {
  const common = payload.v === 1 && payload.flow === 'device-key' && payload.ceremony === 'enroll';
  if (!common || typeof payload.ok !== 'boolean') return invalidFrame();
  if (payload.ok === false) {
    if (!exactKeys(payload, ['v', 'flow', 'ceremony', 'ok', 'code'])
      || typeof payload.code !== 'string'
      || !CEREMONY_FAILURES.includes(payload.code as CeremonyFailureCode)) return invalidFrame();
    return { ok: false, code: payload.code as CeremonyFailureCode };
  }
  if (!exactKeys(payload, [
    'v', 'flow', 'ceremony', 'ok', 'credentialId', 'prfOutput', 'backupEligible', 'backupState',
  ])
    || typeof payload.credentialId !== 'string'
    || payload.credentialId.length === 0
    || payload.credentialId.length > 1400
    || !/^[A-Za-z0-9_-]+$/u.test(payload.credentialId)
    || typeof payload.prfOutput !== 'string'
    || !isWellFormedPrfOutput(payload.prfOutput)
    || typeof payload.backupEligible !== 'boolean'
    || typeof payload.backupState !== 'boolean') return invalidFrame();
  return {
    ok: true,
    credentialId: payload.credentialId,
    prfOutput: payload.prfOutput,
    backupEligible: payload.backupEligible,
    backupState: payload.backupState,
  };
};

const automaticPhraseData = (phrase: string): CreateOrganizationData => ({
  nonce: '',
  stops: [
    { id: 'phrase', label: 'Recovery phrase', state: 'current' },
    { id: 'device-key', label: 'Device key', state: 'upcoming' },
  ],
  view: 'phrase',
  maxNameLength: MAX_ORG_NAME_LENGTH,
  phraseWords: phrase.split(/\s+/u).filter(Boolean),
  bodyLines: ORG_PHRASE_NOTES,
  learnMoreUrl: ZERO_TRUST_URL,
  nonTty: {
    command: '',
    why: 'The recovery phrase must be shown to its owner.',
  },
});

const automaticPhraseProgressData = (): CreateOrganizationData => ({
  nonce: '',
  stops: [
    { id: 'phrase', label: 'Recovery phrase', state: 'done', answer: 'written down' },
    { id: 'device-key', label: 'Device key', state: 'upcoming' },
  ],
  view: 'creating',
  maxNameLength: MAX_ORG_NAME_LENGTH,
  bodyLines: ORG_PHRASE_NOTES,
  learnMoreUrl: ZERO_TRUST_URL,
  nonTty: {
    command: '',
    why: 'The recovery phrase must be shown to its owner.',
  },
});

async function confirmPhrase(input: Readonly<{
  phrase: string;
  session: HostedInitWizardSession;
}>): Promise<Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }> | Readonly<{
  kind: 'confirmed'; session: HostedInitWizardSession;
}>> {
  const words = input.phrase.split(/\s+/u).filter(Boolean);
  if (words.length !== SEED_PHRASE_WORDS) return invalidFrame();
  const response = await askHostedInitChannel<true, CreateOrganizationData>({
    channel: input.session.channel,
    screen: 'create-organization',
    data: automaticPhraseData(input.phrase),
    progressData: automaticPhraseProgressData(),
    decide: (payload) => exactKeys(payload, ['confirmed']) && payload.confirmed === true
      ? { value: true }
      : invalidFrame(),
  });
  const session = { ...input.session, channel: response.channel };
  return response.kind === 'cancelled'
    ? { kind: 'cancelled', session: { ...session, ended: true } }
    : { kind: 'confirmed', session };
}

const unsupportedCeremony = async (_request: UnlockRequest): Promise<never> => {
  throw new HostedInitChannelError('INIT_RUN_INVALID');
};

const exactRenewedIdentity = (input: Readonly<{
  renewed: RenewedInitRunIdentity;
  serviceOrigin: string;
  userId: string;
}>): boolean => {
  try {
    return input.renewed.auth.success
      && input.renewed.auth.user_id === input.userId
      && input.renewed.auth.organization_id === ''
      && (input.renewed.auth.organizations?.length ?? 0) === 0
      && input.renewed.auth._orgless_access_token === input.renewed.accessToken
      && opaqueCredential(input.renewed.auth._refresh_token)
      && opaqueCredential(input.renewed.accessToken)
      && input.renewed.authService.getOrganizationId() === null
      && input.renewed.authService.getServiceApiUrl() === input.serviceOrigin;
  } catch {
    return false;
  }
};

const exactInstalledOrganization = (input: Readonly<{
  installed: InstalledExchangeResponse;
  minted: HostedPersonalMint;
  serviceOrigin: string;
  userId: string;
}>): boolean => {
  try {
    const organizations = input.installed.auth.organizations ?? [];
    const selected = organizations.find((organization) => organization.id === input.minted.organization.id);
    return input.installed.auth.success
      && input.installed.auth.user_id === input.userId
      && input.installed.auth.organization_id === input.minted.organization.id
      && organizations.length === 1
      && selected?.workos_org_id === input.minted.organization.workos_org_id
      && selected.name === input.minted.organization.name
      && input.installed.authService.getOrganizationId() === input.minted.organization.id
      && input.installed.authService.getServiceApiUrl() === input.serviceOrigin;
  } catch {
    return false;
  }
};

export async function createHostedFreshOrganization(input: Readonly<{
  auth: AuthResult;
  authService: AuthService;
  deadline: number;
  serviceOrigin: string;
  session: HostedInitWizardSession;
  rebindSession: (session: HostedInitWizardSession, authService: AuthService) => HostedInitWizardSession;
  dependencies?: HostedFreshOrganizationDependencies;
}>): Promise<HostedFreshOrganizationResult> {
  const userId = input.auth.user_id;
  const serviceOrigin = exactServiceOrigin(input.serviceOrigin);
  const initialAuthority = (() => {
    try {
      return {
        serviceOrigin: input.authService.getServiceApiUrl(),
        organizationId: input.authService.getOrganizationId(),
      };
    } catch {
      return null;
    }
  })();
  if (!input.auth.success || !userId || (input.auth.organizations?.length ?? 0) !== 0
    || (input.auth.organization_id !== undefined && input.auth.organization_id !== '')
    || !serviceOrigin || serviceOrigin !== initialAuthority?.serviceOrigin
    || initialAuthority?.organizationId !== null
    || input.session.ended
    || input.session.channel.binding.subject_user_id !== userId
    || input.session.channel.binding.service_origin !== serviceOrigin
    || !Number.isFinite(input.deadline)) {
    return { kind: 'failed', effects: 'none', error: new HostedInitChannelError('INIT_RUN_INVALID'), session: input.session };
  }
  const dependencies = input.dependencies ?? defaultDependencies(serviceOrigin);
  const phrase = dependencies.generateSeed();
  const confirmed = await (async () => {
    try {
      checkOperationDeadline(input.deadline, dependencies.now);
      return await confirmPhrase({ phrase, session: input.session });
    } catch (error) {
      return { kind: 'failed' as const, error, session: input.session };
    }
  })();
  if (confirmed.kind === 'cancelled') return { ...confirmed, effects: 'none' };
  if (confirmed.kind === 'failed') return { ...confirmed, effects: 'none' };

  const renewed = await (async () => {
    try {
      checkOperationDeadline(input.deadline, dependencies.now);
      const value = await dependencies.renewIdentity(input.authService, { userId, deadline: input.deadline });
      checkOperationDeadline(input.deadline, dependencies.now);
      return exactRenewedIdentity({ renewed: value, serviceOrigin, userId })
        ? { kind: 'ready' as const, value }
        : { kind: 'failed' as const, error: new HostedInitChannelError('INIT_RUN_INVALID') };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (renewed.kind === 'failed') {
    return { kind: 'failed', effects: 'none', error: renewed.error, session: confirmed.session };
  }
  const minted = await (async () => {
    try {
      checkOperationDeadline(input.deadline, dependencies.now);
      const orglessClient = dependencies.createOrglessServiceClient(renewed.value, input.deadline);
      const raw = await dependencies.mintPersonalOrganization(orglessClient);
      checkOperationDeadline(input.deadline, dependencies.now);
      const value = parseHostedPersonalMint(raw, dependencies.now());
      return value
        ? { kind: 'created' as const, value }
        : { kind: 'failed' as const, error: new HostedInitChannelError('INIT_RUN_INVALID') };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (minted.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: minted.error,
      session: confirmed.session, authService: renewed.value.authService,
    };
  }
  const installed = await (async () => {
    try {
      const refreshToken = renewed.value.auth._refresh_token;
      if (!opaqueCredential(refreshToken)) return invalidFrame();
      checkOperationDeadline(input.deadline, dependencies.now);
      const value = await dependencies.installOrganization({
        authService: renewed.value.authService,
        refreshToken,
        organizationId: minted.value.organization.id,
        userId,
      });
      checkOperationDeadline(input.deadline, dependencies.now);
      return exactInstalledOrganization({ installed: value, minted: minted.value, serviceOrigin, userId })
        ? { kind: 'ready' as const, value }
        : { kind: 'failed' as const, error: new HostedInitChannelError('INIT_RUN_INVALID') };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (installed.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: installed.error,
      session: confirmed.session, authService: renewed.value.authService,
    };
  }
  const replacement = installed.value;
  const rebound = (() => {
    try {
      checkOperationDeadline(input.deadline, dependencies.now);
      const session = input.rebindSession(confirmed.session, replacement.authService);
      const valid = !session.ended
        && session.channel.binding.subject_user_id === userId
        && session.channel.binding.service_origin === serviceOrigin;
      if (!valid) return { kind: 'failed' as const, error: new HostedInitChannelError('INIT_RUN_INVALID') };
      return {
        kind: 'ready' as const,
        session,
      };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (rebound.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: rebound.error,
      session: confirmed.session, authService: replacement.authService,
    };
  }
  const reboundSession = rebound.session;
  const prepared = (() => {
    try {
      const serviceClient = dependencies.createServiceClient(replacement.authService);
      const unbounded = createDeviceKeyServiceOps(serviceClient, replacement.authService);
      const checkDeadline = () => checkOperationDeadline(input.deadline, dependencies.now);
      const ops = {
        listWrappers: () => { checkDeadline(); return unbounded.ops.listWrappers(); },
        fetchWrapper: (wrapperId: string) => { checkDeadline(); return unbounded.ops.fetchWrapper(wrapperId); },
        uploadDoorWrapper: (body: Parameters<typeof unbounded.ops.uploadDoorWrapper>[0]) => {
          checkDeadline();
          return unbounded.ops.uploadDoorWrapper(body);
        },
        verifyWrapper: (wrapperId: string) => { checkDeadline(); return unbounded.ops.verifyWrapper(wrapperId); },
        // Cleanup after a partially completed enrollment must remain available
        // after expiry; runNewUserEnrollment invokes this best-effort path.
        deleteWrapper: (wrapperId: string) => unbounded.ops.deleteWrapper(wrapperId),
      };
      const opsForOrg = async (orgId: string) => {
        checkDeadline();
        const scoped = await unbounded.opsForOrg(orgId);
        return scoped ? {
          coDecrypt: (targetOrgId: string, ciphertext: string) => {
            checkDeadline();
            return scoped.coDecrypt(targetOrgId, ciphertext);
          },
          wrapOuterLayer: (targetOrgId: string, plaintext: string) => {
            checkDeadline();
            return scoped.wrapOuterLayer(targetOrgId, plaintext);
          },
          onKeyEncRewrapped: scoped.onKeyEncRewrapped,
          uploadKeyEnc: (keyEnc: string) => { checkDeadline(); return scoped.uploadKeyEnc(keyEnc); },
          fetchKeyEnc: (wrapperId: string) => { checkDeadline(); return scoped.fetchKeyEnc(wrapperId); },
        } : null;
      };
      checkDeadline();
      const prfSalt = dependencies.generateSalt();
      return {
        kind: 'ready' as const,
        serviceClient,
        ops: { ops, opsForOrg },
        prfSalt,
      };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (prepared.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: prepared.error,
      session: reboundSession, authService: replacement.authService,
    };
  }
  const serviceClient = prepared.serviceClient;
  const prfSalt = prepared.prfSalt;
  if (prfSalt.length !== 32) {
    return {
      kind: 'failed', effects: 'indeterminate', error: new HostedInitChannelError('INIT_RUN_INVALID'),
      session: reboundSession, authService: replacement.authService,
    };
  }
  const ceremonySettlement = Promise.withResolvers<CeremonySettlement>();
  const prfSaltB64 = prfSalt.toString('base64');
  const ceremony: CeremonyTransport = {
    requestEnrollment: async (request: EnrollmentRequest) => {
      if (request.userId !== userId
        || request.userEmail !== replacement.auth.user_email
        || request.prfSalt !== prfSaltB64) {
        ceremonySettlement.resolve({ kind: 'not-reached' });
        throw new HostedInitChannelError('INIT_RUN_INVALID');
      }
      const result = await (async () => {
        try {
          return await askHostedInitChannel<EnrollmentSuccess | CeremonyFailure, Readonly<{
            v: 1; ceremony: 'enroll'; prfSalt: string;
          }>>({
            channel: reboundSession.channel,
            screen: 'device-key',
            data: { v: 1, ceremony: 'enroll', prfSalt: prfSaltB64 },
            decide: (payload) => ({ value: parseEnrollmentAnswer(payload) }),
          });
        } catch (error) {
          ceremonySettlement.resolve({ kind: 'not-reached' });
          throw error;
        }
      })();
      const session = { ...reboundSession, channel: result.channel };
      ceremonySettlement.resolve({ kind: 'answered', session, outerCancelled: result.kind === 'cancelled' });
      return result.kind === 'cancelled' ? { ok: false as const, code: 'cancelled' as const } : result.value;
    },
    requestUnlock: unsupportedCeremony,
  };
  const ops = prepared.ops;
  const enrollmentPromise = (async () => {
    try {
      return { kind: 'settled' as const, value: await dependencies.enroll({
        userId,
        userEmail: replacement.auth.user_email,
        organizations: replacement.auth.organizations ?? [minted.value.organization],
        activeOrgId: minted.value.organization.id,
        ceremony,
        ...ops,
      }, {
        orgId: minted.value.organization.id,
        masterKey: seedPhraseToMasterKey(phrase, CURRENT_KDF_VERSION),
        presetPrfSalt: prfSalt,
      }) };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  const settlement = await Promise.race([
    ceremonySettlement.promise,
    enrollmentPromise.then((): CeremonySettlement => ({ kind: 'not-reached' })),
  ]);
  const enrollment = await enrollmentPromise;
  const session = settlement.kind === 'answered' ? settlement.session : reboundSession;
  if (settlement.kind === 'answered' && settlement.outerCancelled) {
    return { kind: 'cancelled', effects: 'indeterminate', session, authService: replacement.authService };
  }
  if (enrollment.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: enrollment.error,
      session, authService: replacement.authService,
    };
  }
  if (!enrollment.value.ok || !('credentialId' in enrollment.value)) {
    return {
      kind: 'failed', effects: 'indeterminate',
      error: new CapyError(
        'Device-key enrollment did not complete',
        enrollment.value.code,
        'ceremonyCode' in enrollment.value
          ? { ceremonyCode: enrollment.value.ceremonyCode }
          : 'reason' in enrollment.value ? { reason: enrollment.value.reason } : undefined,
      ),
      session, authService: replacement.authService,
    };
  }
  const successfulEnrollment = enrollment.value;
  const finalized = await (async () => {
    try {
      checkOperationDeadline(input.deadline, dependencies.now);
      const readiness = await dependencies.finalizeSignupCustody(
        serviceClient,
        minted.value.organization.id,
        successfulEnrollment.credentialId,
      );
      checkOperationDeadline(input.deadline, dependencies.now);
      return readiness.signup_complete
        ? { kind: 'ready' as const, readiness }
        : {
            kind: 'failed' as const,
            error: new CapyError('Signup custody did not complete', ERROR_CODES.SERVICE_ERROR),
          };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (finalized.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: finalized.error,
      session, authService: replacement.authService,
    };
  }
  return {
    kind: 'created',
    organization: minted.value.organization,
    projectId: minted.value.projectId,
    mintClaim: minted.value.mintClaim,
    auth: replacement.auth,
    authService: replacement.authService,
    serviceClient,
    enrollment: successfulEnrollment,
    readiness: finalized.readiness,
    session,
  };
}
