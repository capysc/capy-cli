/**
 * The onboarding detection fork (CAP-380), in the documented order and no
 * other:
 *
 *   wrappers exist server-side  → Case C/C′  (unlock: download, ceremony, unwrap, write)
 *   else local.key on disk      → Case B     (first enrollment from this machine)
 *   else orgs exist             → Case B′    (explicit route to seed recovery or capy transport)
 *   else                        → Case A     (brand-new: mint everything)
 *
 * Pure — every input is a fact the caller already established, so the
 * mandatory case-matrix test enumerates all worlds without mocks.
 *
 * Two recorded decisions:
 * - "wrappers exist" means LIVE DOORS exist. C's first act is a get()
 *   ceremony, which only doors can answer. A key_enc row without any live
 *   door is unreachable under the server's own ≥1-anchored-door invariant
 *   (CAP-379); if a defective server ever produced one, falling through to
 *   the B/B′/A checks degrades gracefully instead of dead-ending in a
 *   ceremony that cannot succeed. The matrix pins this row.
 * - C vs C′ is not decided here: whether the credential lives in a local
 *   authenticator or arrives via QR/hybrid transport is the ceremony's own
 *   discovery (CAP-381 page), invisible to the CLI. Both are `unlock`.
 */

/** What the fork decided this machine+account is. */
export type OnboardingCaseKind =
  /** Case C / C′ — enrolled user, fresh machine: download + unlock ceremony. */
  | 'unlock'
  /** Case B — existing user, existing machine, first device key: enroll. */
  | 'enroll_existing'
  /** Case B′ — existing user, fresh machine, no device key: an explicit
   * routing branch to seed-phrase recovery or capy transport/redeem
   * (invariant 8: those flows are the destination, never replaced). */
  | 'recovery_or_transport'
  /** Case A — brand-new user: mint seed → M, mint K_local, enroll, upload, write. */
  | 'brand_new';

export interface DetectionInputs {
  /** Live wrapped_k_local rows in the caller's server inventory. */
  liveDoorCount: number;
  /** Live key_enc rows in the caller's server inventory. */
  liveKeyEncCount: number;
  /** ANY org dir on this machine holds a user-scoped local.key (globalConfig.listOrgsWithLocalRoot). */
  hasLocalRoot: boolean;
  /** Organizations in the authenticated session. */
  organizationCount: number;
}

export function decideOnboardingCase(inputs: DetectionInputs): OnboardingCaseKind {
  if (inputs.liveDoorCount > 0) return 'unlock';
  if (inputs.hasLocalRoot) return 'enroll_existing';
  if (inputs.organizationCount > 0) return 'recovery_or_transport';
  return 'brand_new';
}
