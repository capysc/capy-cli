/**
 * CeremonyTransport — the seam between the CLI's device-key onboarding fork
 * (CAP-380, this side) and the browser WebAuthn ceremony (CAP-381, the other
 * side: a keep.capy.sc page reached over the connection broker).
 *
 * SECURITY CONTRACT (CAP-372, pinned): the page never holds K_local or M in
 * JS, and for desktop flows it never derives the KEK either. The ONLY secret
 * that crosses this seam is the raw PRF output, sealed in the broker's E2E
 * envelope on the wire. KEK derivation (HKDF, versioned info string) and the
 * AES-256-GCM wrap/unwrap of K_local happen exclusively CLI-side — see
 * ./crypto.ts. An implementation that returns anything derived from K_local
 * is defective by contract.
 *
 * The CLI mints the per-enrollment PRF salt and supplies it here; the page
 * evaluates the PRF extension with it (create-time when supported, otherwise
 * the create-then-get fallback — that fallback is internal to the ceremony
 * and invisible to this interface). For unlock, the CLI supplies every
 * enrolled credential's {id, salt} so the page can run get() with
 * evalByCredential across all of them; the response names which credential
 * the authenticator actually used.
 *
 * Failures are values, not exceptions: the fork branches on `code`
 * (machine-readable, stable) — e.g. `prf_unsupported` routes to the
 * transport/redeem fallback, `cancelled` aborts politely. Transport-level
 * breakage (broker unreachable, connection expired) is `transport_error`.
 *
 * PAGE-SIDE CAPS (gate-2 MINOR-2, for the CAP-382 transport implementation):
 * the keep-app ceremony page enforces hard limits on what fits in the
 * broker fragment it is reached through (`keep-app/src/lib/flow/deviceKeyWire.ts`,
 * `MAX_UNLOCK_CANDIDATES`/fragment size/credential-id length) — currently 32
 * unlock candidates, a 16 KiB fragment, and 1400-char credential ids. A
 * `requestUnlock` call built from more live doors (or with abnormally large
 * credential ids) than that produces a fragment the page rejects outright as
 * INVALID_REQUEST: the page never attaches, and the CLI just waits out its
 * long-poll into an undiagnosable `transport_error`. The CAP-382
 * implementation of this interface MUST mirror these caps CLI-side and fail
 * fast with a coded error before ever building the oversized request — do
 * not rely on the page's rejection to surface the problem.
 */

/** Stable, machine-readable reasons a ceremony did not produce a PRF result. */
export type CeremonyFailureCode =
  | 'cancelled'
  | 'no_credential'
  | 'prf_unsupported'
  | 'webauthn_unavailable'
  | 'transport_error';

export interface CeremonyFailure {
  ok: false;
  code: CeremonyFailureCode;
}

export interface EnrollmentRequest {
  /** WorkOS user id — becomes the WebAuthn user handle scope. */
  userId: string;
  /** Shown by the authenticator UI; optional. */
  userEmail?: string;
  /** base64, 32 bytes, minted by the CLI per enrollment (stored server-side as prf_salt). */
  prfSalt: string;
}

export interface EnrollmentSuccess {
  ok: true;
  /** base64url credential id as the authenticator reported it. Opaque to the CLI. */
  credentialId: string;
  /** base64, 32 bytes: the raw PRF evaluation under `prfSalt`. NEVER logged. */
  prfOutput: string;
  /**
   * Credential backup flags from the authenticator data. `backupEligible:
   * false` means the credential is locked to this device — the caller warns
   * and pushes seed-phrase recording (CAP-372).
   */
  backupEligible: boolean;
  backupState: boolean;
}

export interface UnlockCandidate {
  /** A live door's credential id (server inventory). */
  credentialId: string;
  /** That door's stored prf_salt (base64). */
  prfSalt: string;
}

export interface UnlockRequest {
  userId: string;
  /** Every live door — get() runs evalByCredential across ALL of them. */
  candidates: UnlockCandidate[];
}

export interface UnlockSuccess {
  ok: true;
  /** Which candidate the authenticator used — selects the door row to unwrap. */
  credentialId: string;
  /** base64, 32 bytes: the PRF evaluation under that candidate's salt. NEVER logged. */
  prfOutput: string;
}

/**
 * The third ceremony variant (CAP-384): identical WebAuthn mechanics to
 * `unlock` (get() with evalByCredential across every live door), but a
 * DIFFERENT destination for the result. Unlock installs K_local durably
 * (local.key + key.enc) via onboarding.ts's `installOrgFromServer`. A grant
 * hands the same PRF output to `grant.ts`'s ceremony-only path, which derives
 * K_local and stops — nothing touches disk (see grantHolder.ts). The wire
 * shape is identical to UnlockRequest/UnlockSuccess; a distinct type alias
 * keeps the two call sites self-documenting about which destination they
 * feed, and keeps the `ceremony:'grant'` framing on the wire (deviceKeyWire.ts)
 * distinct from `ceremony:'unlock'` so the keep-app page can show copy that
 * "plainly states" this is a temporary, in-memory grant (CAP-384 requirement)
 * rather than an ordinary machine unlock.
 */
export type GrantRequest = UnlockRequest;
export type GrantSuccess = UnlockSuccess;

export interface CeremonyTransport {
  /** Create a new device-key credential and evaluate its PRF. */
  requestEnrollment(req: EnrollmentRequest): Promise<EnrollmentSuccess | CeremonyFailure>;
  /** Evaluate the PRF of one already-enrolled credential. */
  requestUnlock(req: UnlockRequest): Promise<UnlockSuccess | CeremonyFailure>;
  /**
   * Evaluate the PRF of one already-enrolled credential for a per-chat
   * sandbox grant. The page must render copy that plainly states this is
   * granting a temporary, in-memory key to a named sandbox for this chat
   * only — never conflated with an ordinary unlock. Implementations SHOULD
   * pass the sandbox's display label as the connection's `machineName` (the
   * same field enroll/unlock already use for "asked by <machine>"), so the
   * page needs no new wire field to show who is asking.
   *
   * OPTIONAL on the interface (unlike requestEnrollment/requestUnlock) so
   * every existing CeremonyTransport fake across the test suite — including
   * CAP-383's equivalence test, which invariant 4 requires stays untouched —
   * keeps compiling without adding a method it never exercises. grant.ts
   * treats a missing implementation as `transport_error`.
   */
  requestGrant?(req: GrantRequest): Promise<GrantSuccess | CeremonyFailure>;
}
