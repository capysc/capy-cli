/**
 * CAP-409 (hardened) — resolves `capy pair`'s granted K_local AFTER the
 * session has already been installed, per CAP-372's restored invariant: the
 * approving page only ever hands over the raw PRF output (never K_local
 * itself — see `./pairContract.ts`'s `PairMachineAnswerKeyMaterial`). This
 * module is the CLI-side second half of that split: authenticate with the
 * just-installed session, fetch this account's own wrapped_k_local, derive
 * the KEK, and unwrap locally — the EXACT ceremony CAP-384's sandbox grant
 * already implements (`../deviceKey/grant.ts`'s `runGrantCeremony`).
 *
 * Rather than duplicating that door-discovery + KEK-derivation + unwrap
 * logic, `resolveGrantedMaterialFromAnswer` hands `runGrantCeremony` an
 * ALREADY-ANSWERED `CeremonyTransport`: the real WebAuthn/PRF ceremony ran
 * asynchronously on the approving page (over the pairing broker), long
 * before this module ever runs, so there is nothing left for a "transport"
 * to do but hand back the known `{credentialId, prfOutput}` the instant
 * grant.ts asks for it. `requestGrant` is the only method that can ever be
 * called through this path (grant.ts never calls enroll/unlock);
 * `requestEnrollment`/`requestUnlock` exist solely to satisfy
 * `CeremonyTransport`'s shape.
 *
 * ORDERING: the caller (pairCommand.ts) MUST install the session
 * (`installPairedSession`) before calling `resolvePairedKeyMaterial` —
 * fetching a wrapper is an authenticated API call that needs a session on
 * disk to authenticate with. Doors (`wrapped_k_local`) are org-less and
 * per-credential server-side (see `serviceClient.ts`'s own comment), so
 * `authOrgId` need not be the org the session ultimately activates for the
 * user — ANY org this account belongs to yields a usable bearer token for
 * the fetch. `pairCommand.ts` prefers the just-installed session's active
 * org and falls back to `answer.keyMaterial.orgId` (the org the browser
 * had active at approval time — always present on a validated answer) when
 * `installPairedSession` didn't pin one (the non-interactive multi-org
 * case — see `installPairedSession.ts`'s own doc for why that path
 * deliberately returns `orgId: null`).
 */
import { AuthService } from '../authService';
import { ServiceClient } from '../../service/serviceClient';
import { createDeviceKeyServiceOps } from '../deviceKey/serviceOps';
import { runGrantCeremony, type GrantOps, type GrantedKeyMaterial } from '../deviceKey/grant';
import type { CeremonyTransport } from '../deviceKey/ceremonyTransport';
import { CapyError, ERROR_CODES } from '../../types/index';
import type { PairMachineAnswer } from './pairContract';

export type ResolvedPairedKeyMaterial =
  | { ok: true; material: GrantedKeyMaterial }
  | { ok: false; code: string };

/** A CeremonyTransport whose `requestGrant` never runs a real WebAuthn
 *  ceremony — see this file's header for why that's correct here. */
function alreadyAnsweredTransport(answer: PairMachineAnswer): CeremonyTransport {
  return {
    requestEnrollment: async () => ({ ok: false, code: 'transport_error' }),
    requestUnlock: async () => ({ ok: false, code: 'transport_error' }),
    requestGrant: async () => ({
      ok: true,
      credentialId: answer.keyMaterial.credentialId,
      prfOutput: answer.keyMaterial.prfOutput,
    }),
  };
}

/**
 * Pure core: given wrapper ops that are already authenticated, resolve the
 * answer's PRF result into K_local via `runGrantCeremony`, mapping every
 * failure (thrown CapyError or a `{ok:false, code}` ceremony verdict) into
 * the SAME typed result shape — no exceptions escape this function. Kept
 * separate from `resolvePairedKeyMaterial` so it is unit-testable with a
 * `FakeOps`, without touching `AuthService`/`ServiceClient`/the network at
 * all (mirrors `tests/auth/deviceKey/grant.test.ts`'s own style).
 */
export async function resolveGrantedMaterialFromAnswer(
  answer: PairMachineAnswer,
  ops: GrantOps,
): Promise<ResolvedPairedKeyMaterial> {
  try {
    const outcome = await runGrantCeremony({
      userId: answer.session.user.id,
      ceremony: alreadyAnsweredTransport(answer),
      ops,
    });
    return outcome.ok ? { ok: true, material: outcome.material } : { ok: false, code: outcome.code };
  } catch (err) {
    if (err instanceof CapyError) return { ok: false, code: err.code };
    throw err;
  }
}

export interface ResolvePairedKeyMaterialOptions {
  apiUrl?: string;
  devMode?: boolean;
  /** The org to authenticate the wrapper fetch against, or null when the
   *  caller has none available (e.g. a malformed/adversarial zero-org
   *  answer) — see this file's header for why any org will do. */
  authOrgId: string | null;
}

/**
 * Production entry point: authenticate against `opts.authOrgId` using the
 * session `installPairedSession` already wrote to disk, build the real
 * wrapper-fetch ops (fresh-auth-retrying, same as every other device-key
 * caller — `../deviceKey/serviceOps.ts`), and resolve K_local.
 */
export async function resolvePairedKeyMaterial(
  answer: PairMachineAnswer,
  opts: ResolvePairedKeyMaterialOptions,
): Promise<ResolvedPairedKeyMaterial> {
  if (!opts.authOrgId) {
    // No organization to authenticate the wrapper fetch against. In
    // practice this should be unreachable — keep-app's own /pair approval
    // gates on the approving session having an active org (NO_ORGANIZATION),
    // so a real answer always carries at least one — but this fails closed
    // rather than assuming that invariant holds against a malformed answer.
    return { ok: false, code: ERROR_CODES.AUTH_FAILED };
  }

  const authService = new AuthService(opts.apiUrl, opts.devMode ?? false, answer.session.user.id);
  const pinned = await authService.authenticateSilent(opts.authOrgId);
  if (!pinned.success) {
    // Propagate WHY, not just that it failed — session_ended/no_session vs.
    // network/server_error are different remedies (see
    // tests/auth/silentAuthFailureRemedy.test.ts, which pins that every
    // terminal `authenticateSilent` failure in this codebase surfaces
    // `error_code` rather than going bare).
    return { ok: false, code: pinned.error_code ?? ERROR_CODES.AUTH_FAILED };
  }

  const serviceClient = new ServiceClient(opts.apiUrl, opts.devMode ?? false);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  const { ops } = createDeviceKeyServiceOps(serviceClient, authService);

  return resolveGrantedMaterialFromAnswer(answer, ops);
}
