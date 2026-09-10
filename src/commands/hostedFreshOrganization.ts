import type { AuthService, InstalledInitRunOrganization } from '../auth/authService';
import { INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH } from '../auth/initRunOrganizationInstaller';
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
import { ServiceClient } from '../service/serviceClient';
import type { AuthResult } from '../types';
import { CapyError } from '../types';
import { askHostedInitChannel, HostedInitChannelError } from '../ui/hostedInitChannel';
import type { HostedInitWizardSession } from '../ui/hostedInitWizardSession';
import { buildCreateOrganizationData } from '../ui/onboardingWeb';
import type { CreateOrganizationData } from '../ui/screens/contract';
import {
  MAX_ORG_NAME_LENGTH,
  ORG_PHRASE_NOTES,
  ZERO_TRUST_URL,
} from './orgCreation';

const NAME_CHECK_TIMEOUT_MS = 10_000;
const NAME_CHECK_RESPONSE_LIMIT = 8_192;
const CEREMONY_FAILURES: readonly CeremonyFailureCode[] = [
  'cancelled', 'no_credential', 'prf_unsupported', 'webauthn_unavailable', 'transport_error',
];

type EnrollmentOutcome = Awaited<ReturnType<typeof runNewUserEnrollment>>;

export type HostedFreshOrganizationResult =
  | Readonly<{
      kind: 'created';
      auth: AuthResult;
      authService: AuthService;
      serviceClient: ServiceClient;
      organization: InstalledInitRunOrganization['organization'];
      enrollment: EnrollmentOutcome;
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
  checkName: (name: string) => Promise<'available' | 'taken' | 'unreachable'>;
  createServiceClient: (authService: AuthService) => ServiceClient;
  enroll: typeof runNewUserEnrollment;
}>;

class HostedOrganizationCreationError extends CapyError {
  constructor(
    readonly original: unknown,
    readonly session: HostedInitWizardSession,
  ) {
    super('The hosted organization outcome was not confirmed', 'INIT_RUN_ORGANIZATION_INDETERMINATE');
  }
}

class HostedOrganizationQuestionError extends Error {
  constructor(
    readonly original: unknown,
    readonly session: HostedInitWizardSession,
  ) {
    super('INIT_RUN_ORGANIZATION_QUESTION_FAILED');
  }
}

const defaultDependencies = (serviceOrigin: string, deadline: number): HostedFreshOrganizationDependencies => ({
  generateSeed: generateSeedPhrase,
  generateSalt: generatePrfSalt,
  now: Date.now,
  checkName: (name) => checkNameAvailability({ serviceOrigin, deadline, name }),
  createServiceClient: (authService) => new ServiceClient(serviceOrigin, false, () => authService.getValidToken()),
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

const checkNameAvailability = async (input: Readonly<{
  serviceOrigin: string;
  deadline: number;
  name: string;
}>): Promise<'available' | 'taken' | 'unreachable'> => {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) throw new HostedInitChannelError('INIT_RUN_EXPIRED');
  const response = await (async () => {
    try {
      return await fetch(`${input.serviceOrigin}/auth/check-org-name`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.name }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(NAME_CHECK_TIMEOUT_MS, remaining))),
      });
    } catch {
      return null;
    }
  })();
  if (!response?.ok) return 'unreachable';
  const body = await (async () => {
    try {
      const text = await response.text();
      return text.length <= NAME_CHECK_RESPONSE_LIMIT ? JSON.parse(text) as unknown : null;
    } catch {
      return null;
    }
  })();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unreachable';
  const record = body as Readonly<Record<string, unknown>>;
  return exactKeys(record, ['available']) && typeof record.available === 'boolean'
    ? record.available ? 'available' : 'taken'
    : 'unreachable';
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

const createOrganizationData = (input: Readonly<{
  phrase: string;
  name?: string;
  nameError?: CreateOrganizationData['nameError'];
  nameOnly?: boolean;
}>): CreateOrganizationData => buildCreateOrganizationData({
  phrase: input.phrase,
  bodyLines: ORG_PHRASE_NOTES,
  learnMoreUrl: ZERO_TRUST_URL,
  maxNameLength: MAX_ORG_NAME_LENGTH,
  name: input.name,
  nameError: input.nameError === 'RACE_409' ? input.nameError : undefined,
  nameOnly: input.nameOnly,
  state: {
    name: input.name,
    nameError: input.nameError,
  },
}, '');

async function askName(input: Readonly<{
  checkName: HostedFreshOrganizationDependencies['checkName'];
  phrase: string;
  session: HostedInitWizardSession;
  name?: string;
  nameError?: CreateOrganizationData['nameError'];
  nameOnly?: boolean;
}>): Promise<Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }> | Readonly<{
  kind: 'named'; name: string; session: HostedInitWizardSession;
}>> {
  const data = createOrganizationData(input);
  const response = await (async () => {
    try {
      return await askHostedInitChannel<string, CreateOrganizationData>({
        channel: input.session.channel,
        screen: 'create-organization',
        data,
        decide: (payload) => {
          if (!exactKeys(payload, ['name']) || typeof payload.name !== 'string') return invalidFrame();
          const name = payload.name.trim();
          if (name.length === 0) return {
            error: 'EMPTY',
            rejectedData: createOrganizationData({ ...input, name, nameError: 'EMPTY' }),
          };
          if (name.length > MAX_ORG_NAME_LENGTH) return {
            error: 'TOO_LONG',
            rejectedData: createOrganizationData({ ...input, name, nameError: 'TOO_LONG' }),
          };
          return { value: name };
        },
      });
    } catch (error) {
      throw new HostedOrganizationQuestionError(error, input.session);
    }
  })();
  const session = { ...input.session, channel: response.channel };
  if (response.kind === 'cancelled') return { kind: 'cancelled', session: { ...session, ended: true } };
  const availability = await (async () => {
    try { return await input.checkName(response.value); }
    catch (error) { throw new HostedOrganizationQuestionError(error, session); }
  })();
  return availability === 'taken'
    ? askName({ ...input, session, name: response.value, nameError: 'TAKEN' })
    : { kind: 'named', name: response.value, session };
}

async function confirmPhrase(input: Readonly<{
  phrase: string;
  name: string;
  session: HostedInitWizardSession;
}>): Promise<Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }> | Readonly<{
  kind: 'confirmed'; session: HostedInitWizardSession;
}>> {
  const data = createOrganizationData(input);
  const progressData: CreateOrganizationData = {
    ...createOrganizationData({ ...input, nameOnly: true }),
    view: 'creating',
  };
  const response = await (async () => {
    try {
      return await askHostedInitChannel<true, CreateOrganizationData>({
        channel: input.session.channel,
        screen: 'create-organization',
        data,
        progressData,
        decide: (payload) => exactKeys(payload, ['confirmed']) && payload.confirmed === true
          ? { value: true }
          : invalidFrame(),
      });
    } catch (error) {
      throw new HostedOrganizationQuestionError(error, input.session);
    }
  })();
  const session = { ...input.session, channel: response.channel };
  return response.kind === 'cancelled'
    ? { kind: 'cancelled', session: { ...session, ended: true } }
    : { kind: 'confirmed', session };
}

async function nameAndConfirm(input: Readonly<{
  checkName: HostedFreshOrganizationDependencies['checkName'];
  phrase: string;
  session: HostedInitWizardSession;
  racedName?: string;
}>): Promise<Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }> | Readonly<{
  kind: 'confirmed'; name: string; session: HostedInitWizardSession;
}>> {
  const named = await askName({
    ...input,
    name: input.racedName,
    nameError: input.racedName ? 'RACE_409' : undefined,
    nameOnly: input.racedName !== undefined,
  });
  if (named.kind === 'cancelled') return named;
  if (input.racedName !== undefined) return { kind: 'confirmed', name: named.name, session: named.session };
  const confirmed = await confirmPhrase({ phrase: input.phrase, name: named.name, session: named.session });
  return confirmed.kind === 'cancelled'
    ? confirmed
    : { kind: 'confirmed', name: named.name, session: confirmed.session };
}

const createOrganization = async (input: Readonly<{
  authService: AuthService;
  checkName: HostedFreshOrganizationDependencies['checkName'];
  deadline: number;
  phrase: string;
  session: HostedInitWizardSession;
  userId: string;
  racedName?: string;
}>): Promise<Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }> | Readonly<{
  kind: 'created'; installed: InstalledInitRunOrganization; session: HostedInitWizardSession;
}>> => {
  const confirmed = await nameAndConfirm(input);
  if (confirmed.kind === 'cancelled') return confirmed;
  try {
    const installed = await input.authService.createInitRunOrganization(confirmed.name, {
      userId: input.userId,
      deadline: input.deadline,
    });
    return { kind: 'created', installed, session: confirmed.session };
  } catch (error) {
    if (error instanceof CapyError && error.code === INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH) {
      return createOrganization({ ...input, session: confirmed.session, racedName: confirmed.name });
    }
    throw new HostedOrganizationCreationError(error, confirmed.session);
  }
};

const unsupportedCeremony = async (_request: UnlockRequest): Promise<never> => {
  throw new HostedInitChannelError('INIT_RUN_INVALID');
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
  const configuredServiceOrigin = (() => {
    try { return input.authService.getServiceApiUrl(); } catch { return null; }
  })();
  if (!input.auth.success || !userId || (input.auth.organizations?.length ?? 0) !== 0
    || !serviceOrigin || serviceOrigin !== configuredServiceOrigin) {
    return { kind: 'failed', effects: 'none', error: new HostedInitChannelError('INIT_RUN_INVALID'), session: input.session };
  }
  const dependencies = input.dependencies ?? defaultDependencies(serviceOrigin, input.deadline);
  const phrase = dependencies.generateSeed();
  const created = await (async () => {
    try {
      return await createOrganization({
        authService: input.authService,
        checkName: dependencies.checkName,
        deadline: input.deadline,
        phrase,
        session: input.session,
        userId,
      });
    } catch (error) {
      const session = error instanceof HostedOrganizationCreationError
        || error instanceof HostedOrganizationQuestionError
        ? error.session
        : input.session;
      return {
        kind: 'failed' as const,
        effects: error instanceof HostedOrganizationCreationError ? 'indeterminate' as const : 'none' as const,
        error: error instanceof HostedOrganizationQuestionError ? error.original : error,
        session,
      };
    }
  })();
  if (created.kind === 'cancelled') return { ...created, effects: 'none' };
  if (created.kind === 'failed') return created;

  const replacement = created.installed;
  const rebound = (() => {
    try {
      const organizations = replacement.auth.organizations ?? [];
      const valid = replacement.auth.success
        && replacement.auth.user_id === userId
        && replacement.auth.organization_id === replacement.organization.id
        && organizations.length === 1
        && organizations[0]?.id === replacement.organization.id
        && organizations[0]?.workos_org_id === replacement.organization.workos_org_id
        && replacement.authService.getServiceApiUrl() === serviceOrigin
        && dependencies.now() < input.deadline;
      if (!valid) return { kind: 'failed' as const, error: new HostedInitChannelError('INIT_RUN_INVALID') };
      return {
        kind: 'ready' as const,
        session: input.rebindSession(created.session, replacement.authService),
      };
    } catch (error) {
      return { kind: 'failed' as const, error };
    }
  })();
  if (rebound.kind === 'failed') {
    return {
      kind: 'failed', effects: 'indeterminate', error: rebound.error,
      session: created.session, authService: replacement.authService,
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
        organizations: replacement.auth.organizations ?? [replacement.organization],
        activeOrgId: replacement.organization.id,
        ceremony,
        ...ops,
      }, {
        orgId: replacement.organization.id,
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
  return {
    kind: 'created',
    organization: replacement.organization,
    auth: replacement.auth,
    authService: replacement.authService,
    serviceClient,
    enrollment: enrollment.value,
    session,
  };
}
