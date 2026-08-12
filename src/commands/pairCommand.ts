/**
 * `capy pair` (CAP-409) — RFC 8628-style machine pairing for a headless
 * machine with no browser at all: SSH'd into a container, nothing to open a
 * browser tab with, no existing capy session on this box yet.
 *
 * Unlike `capy transport`/`capy redeem` (which require an ALREADY
 * `capy`-initialized machine to mint the code), `capy pair` needs nothing but
 * network access on this end. It anonymously bootstraps a CAP-403 connection
 * (`purpose: 'machine-pair'`), prints a short human code, and long-polls for
 * a sealed answer from whichever already-signed-in device the human enters
 * that code on. See `../auth/pairing/pairCeremony.ts` for the poll loop and
 * `../auth/pairing/pairContract.ts` for the sealed payload's shape.
 *
 * Two halves land on success, mirroring the CAP-384 sandbox grant's split,
 * installed IN THIS ORDER (the second half depends on the first):
 *   - Session: written to ~/.capy through the CLI's one existing session
 *     writer (`installPairedSession.ts`) — every other command that reads
 *     ~/.capy afterward just works.
 *   - Key material: the sealed answer never carries K_local (CAP-372,
 *     restored — see `../auth/pairing/pairContract.ts`'s header), only the
 *     raw PRF output. `resolvePairedKeyMaterial` (`../auth/pairing/
 *     pairKeyMaterial.ts`) uses the session just installed above to fetch
 *     this account's own wrapped_k_local over the authenticated API and
 *     unwraps it locally — the identical ceremony CAP-384's grant already
 *     runs. K_local itself is still NEVER written to disk (this is a
 *     headless machine; the acceptance criterion is explicit that no
 *     recovery-equivalent material is ever displayed or persisted anywhere)
 *     — it is handed to the exact same in-memory grant daemon `capy
 *     device-key grant` already uses (`spawnGrantDaemon`), so `capy run` and
 *     friends find a live `CAPY_DEVICE_KEY_GRANT_SOCKET` exactly as they
 *     would after a manual grant. The cost of this extra round trip over the
 *     old (page-unwraps) design is one accepted trade: it turns "read
 *     K_local out of page memory" into "make an authenticated,
 *     fresh-auth-gated, rate-limited, audit-logged API call" for an attacker
 *     who has only compromised the page (XSS, a malicious dependency), not
 *     the whole keep-app origin.
 *
 * GATED BEHIND CAPY_DEVICE_KEYS, matching `capy device-key grant`'s own
 * `refuseFlagOff()` exactly — verified necessary, not assumed: `runCommand.ts`'s
 * ENTIRE grant-consuming branch (the `configuredGrantSocketPath()` check and
 * everything under it) is nested inside its own `deviceKeysEnabled()` check,
 * so a grant obtained with the flag unset is unusable by `capy run` no
 * matter what — it falls straight through to "ask the project owner to
 * invite you" and never looks at the socket at all. Completing the ceremony
 * without the flag would leave the customer with a socket that works but
 * nothing downstream willing to use it — a confusing half-fixed state, not
 * a working one. Gating here fails fast with the same clear message
 * `device-key grant` already gives, instead of a surprise ten minutes later.
 */
import { hostname } from 'os';
import { ERROR_CODES } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { resolveActiveUrl } from '../config/profileConfig';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import { runPairCeremony } from '../auth/pairing/pairCeremony';
import { installPairedSession } from '../auth/pairing/installPairedSession';
import { resolvePairedKeyMaterial } from '../auth/pairing/pairKeyMaterial';
import type { PairMachineAnswer } from '../auth/pairing/pairContract';
import { spawnGrantDaemon, GRANT_SOCKET_ENV_VAR, DEFAULT_GRANT_TTL_MS } from '../auth/deviceKey/grantHolder';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

function refuseFlagOff(): never {
  console.error('');
  console.error('  Device keys are not enabled on this build.');
  console.error(`  Set ${B('CAPY_DEVICE_KEYS=1')} to try them.`);
  console.error('');
  process.exit(1);
}

const CEREMONY_FAILURE_MESSAGES: Record<string, string> = {
  cancelled: 'The pairing request was cancelled.',
  no_credential: 'No device key answered this pairing request.',
  prf_unsupported: 'That device does not support the device-key ceremony.',
  webauthn_unavailable: 'WebAuthn was unavailable on the approving device.',
  transport_error: 'The pairing ceremony could not be completed.',
};

export interface PairCommandOptions {
  json?: boolean;
  /** Lifetime of the granted, in-memory device key — same knob as
   *  `device-key grant --ttl-minutes`. Not the connection/code TTL, which is
   *  fixed (see PAIR_TTL_SECONDS in pairCeremony.ts). */
  ttlMinutes?: number;
}

export class PairCommand {
  constructor(private apiUrl?: string, private devMode: boolean = false) {}

  async execute(options: PairCommandOptions = {}): Promise<void> {
    if (!deviceKeysEnabled()) refuseFlagOff();

    const serviceUrl = resolveActiveUrl(this.devMode);

    let outcome;
    try {
      outcome = await runPairCeremony({
        serviceUrl,
        machineName: `sandbox:${hostname()}`,
        onCodeReady: (userCode) => this.printPairingBlock(userCode),
      });
    } catch (err) {
      // Bootstrap itself failed (network/service) before any code was ever
      // shown — nothing to walk back, just report and exit.
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        console.log(JSON.stringify({ ok: false, code: ERROR_CODES.NETWORK_ERROR, detail: message }, null, 2));
      } else {
        console.error('');
        console.error(`  Could not start pairing: ${message}`);
        console.error('');
      }
      process.exitCode = 1;
      return;
    }

    switch (outcome.kind) {
      case 'expired': {
        if (options.json) {
          console.log(JSON.stringify({ ok: false, code: ERROR_CODES.PAIR_CODE_EXPIRED, userCode: outcome.userCode }, null, 2));
        } else {
          console.error('');
          console.error('  This pairing code has expired.');
          console.error(`  Run ${B('capy pair')} again.`);
          console.error('');
        }
        process.exit(EXIT_NEEDS_INPUT);
        return;
      }
      case 'failure': {
        const message = CEREMONY_FAILURE_MESSAGES[outcome.code] ?? 'The pairing ceremony did not complete.';
        if (options.json) {
          console.log(JSON.stringify({ ok: false, code: outcome.code, userCode: outcome.userCode }, null, 2));
        } else {
          console.error('');
          console.error(`  ${message} (${outcome.code})`);
          console.error('  No session or key material was installed.');
          console.error('');
        }
        process.exitCode = 1;
        return;
      }
      case 'answered':
        await this.finish(outcome.answer, outcome.userCode, options);
        return;
    }
  }

  /**
   * The spec's exact terminal UX (§4.2). No TTY-gating — spec §5's
   * documented bright-line exception: this code is a claim ticket, not a
   * credential, so printing it unconditionally is safe (unlike
   * `capy transport`'s TRANSPORT_CODE_UNSAFE_SURFACE class of secret).
   */
  private printPairingBlock(userCode: string): void {
    console.log('');
    console.log(`  To sign this machine in, go to ${B('keep.capy.sc/pair')}`);
    console.log(`  on a device where you're signed in, and enter:  ${B(userCode)}`);
    console.log('');
    console.log('  Waiting…');
  }

  private async finish(answer: PairMachineAnswer, userCode: string, options: PairCommandOptions): Promise<void> {
    let install;
    try {
      install = await installPairedSession(answer.session, { apiUrl: this.apiUrl, devMode: this.devMode });
    } catch (err) {
      // The session half failed to install — do not proceed to grant a key
      // for a session that isn't actually usable. No key material daemon is
      // spawned; nothing partial is left running.
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        console.log(JSON.stringify({ ok: false, code: ERROR_CODES.AUTH_FAILED, detail: message, userCode }, null, 2));
      } else {
        console.error('');
        console.error(`  Pairing succeeded but the session could not be installed: ${message}`);
        console.error('');
      }
      process.exitCode = 1;
      return;
    }

    // The session is on disk now — fetch this account's own wrapped_k_local
    // over the authenticated API and unwrap it locally (see this file's
    // header and pairKeyMaterial.ts). Doors are org-less server-side, so
    // ANY org this account belongs to authenticates the fetch: prefer the
    // org the session just activated, falling back to answer.keyMaterial.orgId
    // (the org the browser had active at approval time) for the
    // non-interactive multi-org case where install.orgId is deliberately
    // null (installPairedSession.ts's own doc explains why).
    const authOrgId = install.orgId ?? answer.keyMaterial.orgId;
    const resolved = await resolvePairedKeyMaterial(answer, {
      apiUrl: this.apiUrl,
      devMode: this.devMode,
      authOrgId,
    });
    if (!resolved.ok) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, code: resolved.code, userCode }, null, 2));
      } else {
        console.error('');
        console.error(`  Pairing succeeded but the key material could not be granted (${resolved.code}).`);
        console.error(`  The session was installed; run ${B('capy pair')} again to retry the key grant.`);
        console.error('');
      }
      process.exitCode = 1;
      return;
    }

    const ttlMs = options.ttlMinutes ? options.ttlMinutes * 60_000 : DEFAULT_GRANT_TTL_MS;
    const daemon = await spawnGrantDaemon(resolved.material, { ttlMs });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            userCode,
            userId: answer.session.user.id,
            userEmail: answer.session.user.email,
            orgId: install.orgId,
            orgName: install.orgName ?? null,
            orgTokenReady: install.orgTokenReady,
            socketPath: daemon.socketPath,
            expiresAt: daemon.expiresAt,
            envVar: GRANT_SOCKET_ENV_VAR,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');
    console.log(`  \x1b[32mPaired as ${B(answer.session.user.email)}.\x1b[0m`);
    if (install.orgId) {
      console.log(`  Active organization: ${B(install.orgName || install.orgId)}`);
    } else if (answer.session.organizations.length === 0) {
      console.log(`  No organizations yet — run ${B('capy')} to create one.`);
    } else {
      console.log(`  Multiple organizations available — run ${B('capy org')} to pick one.`);
    }
    console.log(`  Granted a temporary device key to this machine for this session.`);
    console.log(`  It lives in memory and is never written to disk; it expires at ${new Date(daemon.expiresAt).toISOString()}.`);
    console.log('');
    console.log('  Set this on every subsequent capy invocation in this session:');
    console.log('');
    console.log(`    ${B(`${GRANT_SOCKET_ENV_VAR}=${daemon.socketPath}`)}`);
    console.log('');
  }
}
