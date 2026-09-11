import type { AuthService } from '../auth/authService';
import type { CeremonyFailure, CeremonyTransport, UnlockRequest, UnlockSuccess } from '../auth/deviceKey/ceremonyTransport';
import { MAX_CREDENTIAL_ID_LENGTH, MAX_UNLOCK_CANDIDATES } from '../auth/deviceKey/brokerCeremonyTransport';
import { isWellFormedPrfOutput } from '../auth/deviceKey/crypto';
import { detectOnboardingCase, runUnlock, type OnboardingDeps } from '../auth/deviceKey/onboarding';
import { createDeviceKeyServiceOps } from '../auth/deviceKey/serviceOps';
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES, type AuthResult } from '../types';
import { askHostedInitChannel, HostedInitChannelError } from '../ui/hostedInitChannel';
import type { HostedInitWizardSession } from '../ui/hostedInitWizardSession';

type Settlement = Readonly<{ session: HostedInitWizardSession; cancelled: boolean }>;
export type HostedOrganizationUnlockResult =
  | Readonly<{ kind: 'finished'; session: HostedInitWizardSession; installedCurrentOrg: boolean; effectsStarted: boolean }>
  | Readonly<{ kind: 'cancelled'; session: HostedInitWizardSession }>
  | Readonly<{ kind: 'failed'; session: HostedInitWizardSession; error: unknown }>;

export type HostedOrganizationUnlockDependencies = Readonly<{
  detect: typeof detectOnboardingCase;
  unlock: typeof runUnlock;
  serviceOps: typeof createDeviceKeyServiceOps;
}>;

const exactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (): never => { throw new HostedInitChannelError('INIT_RUN_INVALID'); };
const failureCodes = ['cancelled', 'no_credential', 'prf_unsupported', 'webauthn_unavailable', 'transport_error'] as const;

export function validateHostedUnlockRequest(request: UnlockRequest, expectedUserId: string): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || request.userId !== expectedUserId || !Array.isArray(request.candidates) || request.candidates.length === 0
    || request.candidates.length > MAX_UNLOCK_CANDIDATES
    || request.candidates.some((candidate) => !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !exactKeys(candidate, ['credentialId', 'prfSalt']) || typeof candidate.credentialId !== 'string'
      || typeof candidate.prfSalt !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(candidate.credentialId)
      || candidate.credentialId.length > MAX_CREDENTIAL_ID_LENGTH
      || !isWellFormedPrfOutput(candidate.prfSalt))
    || new Set(request.candidates.map((candidate) => candidate.credentialId)).size !== request.candidates.length) invalid();
}

export function parseHostedUnlockAnswer(
  payload: Readonly<Record<string, unknown>>,
  request: UnlockRequest,
): UnlockSuccess | CeremonyFailure {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.v !== 1 || payload.flow !== 'device-key' || payload.ceremony !== 'unlock') return invalid();
  if (payload.ok === false) {
    if (!exactKeys(payload, ['v', 'flow', 'ceremony', 'ok', 'code'])
      || !failureCodes.some((code) => code === payload.code)) return invalid();
    return { ok: false, code: payload.code as CeremonyFailure['code'] };
  }
  if (payload.ok !== true || !exactKeys(payload, ['v', 'flow', 'ceremony', 'ok', 'credentialId', 'prfOutput'])
    || typeof payload.credentialId !== 'string' || typeof payload.prfOutput !== 'string'
    || !request.candidates.some((candidate) => candidate.credentialId === payload.credentialId)
    || !isWellFormedPrfOutput(payload.prfOutput)) return invalid();
  return { ok: true, credentialId: payload.credentialId, prfOutput: payload.prfOutput };
}

/** Use the existing unlock engine through the current encrypted init channel. */
export async function unlockHostedOrganization(input: Readonly<{
  auth: AuthResult;
  authService: AuthService;
  serviceClient: ServiceClient;
  organizationId: string;
  session: HostedInitWizardSession;
  dependencies?: HostedOrganizationUnlockDependencies;
}>): Promise<HostedOrganizationUnlockResult> {
  const userId = input.auth.user_id;
  if (!input.auth.success || !userId || input.session.ended
    || input.auth.organization_id !== input.organizationId
    || input.authService.getOrganizationId() !== input.organizationId
    || input.session.channel.binding.subject_user_id !== userId
    || input.session.channel.binding.service_origin !== input.authService.getServiceApiUrl()
    || !input.auth.organizations?.some((organization) => organization.id === input.organizationId)) {
    return { kind: 'failed', session: input.session, error: new HostedInitChannelError('INIT_RUN_INVALID') };
  }
  const dependencies = input.dependencies ?? {
    detect: detectOnboardingCase, unlock: runUnlock, serviceOps: createDeviceKeyServiceOps,
  };
  const settlement = Promise.withResolvers<Settlement>();
  const checkDeadline = (): void => {
    if (input.session.channel.now() >= input.session.channel.deadline) throw new HostedInitChannelError('INIT_RUN_EXPIRED');
  };
  const ceremony: CeremonyTransport = {
    requestEnrollment: async () => invalid(),
    requestUnlock: async (request) => {
      checkDeadline();
      validateHostedUnlockRequest(request, userId);
      const response = await askHostedInitChannel<UnlockSuccess | CeremonyFailure, Readonly<{
        v: 1; ceremony: 'unlock'; candidates: UnlockRequest['candidates'];
      }>>({
        channel: input.session.channel,
        screen: 'device-key',
        data: { v: 1, ceremony: 'unlock', candidates: request.candidates.map((candidate) => ({ ...candidate })) },
        decide: (payload) => ({ value: parseHostedUnlockAnswer(payload, request) }),
      });
      const cancelled = response.kind === 'cancelled';
      settlement.resolve({ session: { ...input.session, channel: response.channel, ended: cancelled }, cancelled });
      return cancelled ? { ok: false, code: 'cancelled' } : response.value;
    },
  };
  const operation = (async () => {
    checkDeadline();
    const operations = dependencies.serviceOps(input.serviceClient, input.authService);
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      checkDeadline();
      const result = await operation();
      checkDeadline();
      return result;
    };
    const deps: OnboardingDeps = {
      userId, userEmail: input.auth.user_email, organizations: [...(input.auth.organizations ?? [])],
      activeOrgId: input.organizationId, ceremony,
      ops: {
        listWrappers: () => guarded(() => operations.ops.listWrappers()),
        fetchWrapper: (id) => guarded(() => operations.ops.fetchWrapper(id)),
        uploadDoorWrapper: (body) => guarded(() => operations.ops.uploadDoorWrapper(body)),
        verifyWrapper: (id) => guarded(() => operations.ops.verifyWrapper(id)),
        deleteWrapper: (id) => guarded(() => operations.ops.deleteWrapper(id)),
      },
      opsForOrg: async (orgId) => {
        const scoped = await guarded(() => operations.opsForOrg(orgId));
        if (!scoped) return null;
        return {
          coDecrypt: (id, ciphertext) => guarded(() => scoped.coDecrypt(id, ciphertext)),
          wrapOuterLayer: (id, plaintext) => guarded(() => scoped.wrapOuterLayer(id, plaintext)),
          onKeyEncRewrapped: scoped.onKeyEncRewrapped
            ? (id, subject, root) => {
                checkDeadline();
                return scoped.onKeyEncRewrapped!(id, subject, root);
              }
            : undefined,
          uploadKeyEnc: (keyEnc) => guarded(() => scoped.uploadKeyEnc(keyEnc)),
          fetchKeyEnc: (id) => guarded(() => scoped.fetchKeyEnc(id)),
        };
      },
    };
    const detected = await dependencies.detect(deps);
    checkDeadline();
    if (detected.kind !== 'unlock') return { cancelled: false, installedCurrentOrg: false, effectsStarted: false };
    const result = await dependencies.unlock(deps, detected.inventory);
    checkDeadline();
    if (!result.ok) {
      if (result.ceremonyCode === 'cancelled') return { cancelled: true, installedCurrentOrg: false, effectsStarted: false };
      throw new CapyError('Device-key unlock did not complete.', result.code, { ceremonyCode: result.ceremonyCode });
    }
    // The engine can install keys for several orgs; restore the selected org
    // before the CLI continues with its existing service client and session.
    const restored = await guarded(() => input.authService.authenticateSilent(input.organizationId));
    if (!restored.success || restored.user_id !== userId || restored.organization_id !== input.organizationId) {
      throw new CapyError('Could not restore the selected organization session.', ERROR_CODES.AUTH_FAILED);
    }
    return {
      cancelled: false,
      installedCurrentOrg: result.orgs.some((org) => org.orgId === input.organizationId
        && (org.status === 'installed' || org.status === 'already_provisioned')),
      effectsStarted: result.orgs.some((org) => org.status === 'installed'),
    };
  })().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  const observed = await Promise.race([
    settlement.promise,
    operation.then((): Settlement => ({ session: input.session, cancelled: false })),
  ]);
  const result = await operation;
  if (observed.cancelled) return { kind: 'cancelled', session: observed.session };
  if (!result.ok) return { kind: 'failed', session: observed.session, error: result.error };
  if (result.value.cancelled) return { kind: 'cancelled', session: observed.session };
  return {
    kind: 'finished', session: observed.session,
    installedCurrentOrg: result.value.installedCurrentOrg,
    effectsStarted: result.value.effectsStarted,
  };
}
