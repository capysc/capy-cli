/**
 * CAP-566 — key material for a machine authenticated by the DEVICE GRANT.
 *
 * The session half changed; this half deliberately did not. Under the old
 * ceremony the approving browser ran the PRF and sealed the raw output into
 * the pairing answer, and `pairKeyMaterial.ts` unwrapped it. Now the machine
 * holds its own CLI-kind session, so it runs the SAME CAP-384 grant ceremony
 * every other device-key caller runs — `runGrantCeremony` over a
 * `BrokerCeremonyTransport`.
 *
 * The broker transport is what keeps this workable on the machine `capy pair`
 * exists for: one with no browser at all. The PRF still happens on the
 * human's OWN device, reached through the broker — it is not moved onto the
 * headless box, and no WebAuthn is attempted locally. K_local is never
 * written to disk; it goes to the in-memory grant daemon exactly as
 * `capy device-key grant` already does.
 *
 * Nothing about the PRF path changes. What changes is only that the ceremony
 * now runs over a session belonging to THIS machine rather than one copied
 * from the approver.
 */
import { hostname } from 'os';
import { AuthService } from '../authService';
import { ServiceClient } from '../../service/serviceClient';
import { createDeviceKeyServiceOps } from '../deviceKey/serviceOps';
import { runGrantCeremony, type GrantedKeyMaterial } from '../deviceKey/grant';
import { BrokerCeremonyTransport } from '../deviceKey/brokerCeremonyTransport';
import type { CeremonyTransport } from '../deviceKey/ceremonyTransport';
import { ERROR_CODES } from '../../types/index';

export interface PairDeviceGrantOptions {
  readonly apiUrl?: string;
  readonly devMode?: boolean;
  /** The org to authenticate the wrapper fetch against. Doors are org-less
   *  server-side, so ANY org this account belongs to works. */
  readonly authOrgId: string | null;
  readonly userId: string;
  readonly serviceUrl: string;
}

export type PairDeviceGrantResult =
  | { readonly ok: true; readonly material: GrantedKeyMaterial }
  | { readonly ok: false; readonly code: string };

export async function grantKeyMaterialForPairedMachine(
  opts: PairDeviceGrantOptions,
): Promise<PairDeviceGrantResult> {
  if (!opts.authOrgId) {
    // Fails closed rather than assuming the account has an org. A machine can
    // legitimately authenticate into an org-less account; there is simply no
    // key material to grant it yet.
    return { ok: false, code: ERROR_CODES.AUTH_FAILED };
  }

  const authService = new AuthService(opts.apiUrl, opts.devMode ?? false, opts.userId);
  const pinned = await authService.authenticateSilent(opts.authOrgId);
  if (!pinned.success) {
    // Propagate WHY: session_ended / no_session and network / server_error are
    // different remedies, so the code is carried rather than flattened.
    return { ok: false, code: pinned.error_code ?? ERROR_CODES.AUTH_FAILED };
  }

  const serviceClient = new ServiceClient(opts.apiUrl, opts.devMode ?? false);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  const { ops } = createDeviceKeyServiceOps(serviceClient, authService);

  const ceremony: CeremonyTransport = new BrokerCeremonyTransport({
    serviceUrl: opts.serviceUrl,
    // Same accessor shape wiring.ts's `currentOrgToken` uses — the transport
    // wants the bearer string, not the token record.
    getToken: async () => (await authService.getValidToken())?.access_token ?? null,
    machineName: hostname(),
  });

  return runGrantCeremony({ userId: opts.userId, ceremony, ops });
}
