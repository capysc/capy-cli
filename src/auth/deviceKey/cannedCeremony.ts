/**
 * A `CeremonyTransport` whose answer is already in hand.
 *
 * CAP-451: the in-process broker ceremony (`capy onboard --broker-ceremony`)
 * gets its PRF result — enrollment or unlock — bundled into the SAME sealed
 * `sandbox_session` answer that delivered the session (`first_run.kind:
 * 'create_org'` carries `credential_id`+`prf_output`; `'unlock'` carries the
 * same pair). There is no second WebAuthn round trip to run: the human
 * already completed it on the Keep page in the same visit. This transport
 * hands that pre-obtained result straight back, so `runNewUserEnrollment` /
 * `runUnlock` (`./onboarding.ts`) can be driven exactly as they are for a
 * live `BrokerCeremonyTransport` ceremony, without minting a second
 * connection or relaying a second URL.
 *
 * `BrokerCeremonyTransport` itself is untouched — this is a second,
 * independent implementation of the same interface, not a variant of it.
 */
import type {
  CeremonyFailure,
  CeremonyTransport,
  EnrollmentRequest,
  EnrollmentSuccess,
  GrantRequest,
  GrantSuccess,
  UnlockRequest,
  UnlockSuccess,
} from './ceremonyTransport';
import { isWellFormedPrfOutput } from './crypto';

/** The PRF pair carried in a `create_org` first_run answer, plus the credential's backup flags. */
export interface CannedEnrollmentResult {
  credentialId: string;
  prfOutput: string;
  backupEligible: boolean;
  backupState: boolean;
}

/** Build a `CeremonyTransport` whose `requestEnrollment` resolves immediately to `result`. */
export function cannedEnrollmentTransport(result: CannedEnrollmentResult): CeremonyTransport {
  return {
    async requestEnrollment(_req: EnrollmentRequest): Promise<EnrollmentSuccess | CeremonyFailure> {
      // Pre-obtained does not mean well-formed — see requestUnlock below.
      if (!isWellFormedPrfOutput(result.prfOutput)) return { ok: false, code: 'transport_error' };
      return {
        ok: true,
        credentialId: result.credentialId,
        prfOutput: result.prfOutput,
        backupEligible: result.backupEligible,
        backupState: result.backupState,
      };
    },
    async requestUnlock(_req: UnlockRequest): Promise<UnlockSuccess | CeremonyFailure> {
      // Never called by the create_org path — present only to satisfy the
      // interface. A programming error, not a runtime outcome a caller
      // should branch on, so it fails loudly rather than returning a
      // plausible-looking CeremonyFailure.
      throw new Error('cannedEnrollmentTransport.requestUnlock is not implemented');
    },
    async requestGrant(_req: GrantRequest): Promise<GrantSuccess | CeremonyFailure> {
      throw new Error('cannedEnrollmentTransport.requestGrant is not implemented');
    },
  };
}

/** The PRF pair carried in an `unlock` first_run answer. */
export interface CannedUnlockResult {
  credentialId: string;
  prfOutput: string;
}

/** Build a `CeremonyTransport` whose `requestUnlock` resolves immediately to `result`. */
export function cannedUnlockTransport(result: CannedUnlockResult): CeremonyTransport {
  return {
    async requestEnrollment(_req: EnrollmentRequest): Promise<EnrollmentSuccess | CeremonyFailure> {
      throw new Error('cannedUnlockTransport.requestEnrollment is not implemented');
    },
    async requestUnlock(_req: UnlockRequest): Promise<UnlockSuccess | CeremonyFailure> {
      // The result arriving pre-obtained says nothing about it being usable:
      // it was produced by the same page, over the same PRF extension, as a
      // relayed answer — it just travelled inside the sealed sandbox_session
      // rather than over a second round trip. An empty or short prfOutput
      // here reaches deriveDeviceKeyKek exactly as it would there, and on
      // THIS rail the throw is swallowed by sandboxCeremony's best-effort
      // catch, so it surfaces as an unexplained key_not_on_device with no
      // trace of the cause. `transport_error` because a malformed payload in
      // an otherwise-valid envelope is a delivery fault, not the
      // authenticator declining to evaluate (`prf_unsupported`), which the
      // page reports for itself.
      if (!isWellFormedPrfOutput(result.prfOutput)) return { ok: false, code: 'transport_error' };
      return { ok: true, credentialId: result.credentialId, prfOutput: result.prfOutput };
    },
    async requestGrant(_req: GrantRequest): Promise<GrantSuccess | CeremonyFailure> {
      throw new Error('cannedUnlockTransport.requestGrant is not implemented');
    },
  };
}
