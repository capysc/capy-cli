/**
 * `capy pair` (CAP-409, device-grant internals per CAP-566/#328) — RFC 8628
 * machine pairing for a headless machine with no browser at all: SSH'd into
 * a container, nothing to open a browser tab with, no existing capy session
 * on this box yet.
 *
 * Unlike `capy transport`/`capy redeem` (which require an ALREADY
 * `capy`-initialized machine to mint the code), `capy pair` needs nothing but
 * network access on this end. It authenticates the MACHINE ITSELF via
 * WorkOS's own device-authorization grant — never an already-signed-in
 * device sealing and handing over ITS session — so this machine is CLI-kind
 * by construction rather than by arrangement. See
 * `../auth/pairing/deviceAuth.ts` for the authorize/poll loop (both legs go
 * through the SERVICE, never `api.workos.com` directly) and
 * `../auth/pairing/pairContract.ts` for the resulting session shape.
 *
 * Two halves land on success, mirroring the CAP-384 sandbox grant's split,
 * installed IN THIS ORDER (the second half depends on the first):
 *   - Session: written to ~/.capy through the CLI's one existing session
 *     writer (`installPairedSession.ts`) — every other command that reads
 *     ~/.capy afterward just works.
 *   - Key material: with the session on disk, `grantKeyMaterialForPairedMachine`
 *     (`../auth/pairing/pairDeviceGrant.ts`) runs the ORDINARY CAP-384 grant
 *     ceremony over it (`runGrantCeremony` against a `BrokerCeremonyTransport`)
 *     — the PRF still happens on the human's OWN device, reached through the
 *     broker; nothing WebAuthn-shaped is attempted on this headless box.
 *     Approved key material uses the existing protected filesystem local.key
 *     custody, with an explicit account/environment binding. The same grant
 *     holder serves subsequent commands and can be restored after restart.
 *     Logout removes the runtime binding, not the retained recovery files;
 *     exporting CAPY_DEVICE_KEY_GRANT_SOCKET remains a backwards-compatible
 *     override, not a requirement.
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
import { CapyError, ERROR_CODES, type AuthResult } from '../types/index';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { resolveActiveUrl } from '../config/profileConfig';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import {
  startDeviceAuthorization,
  awaitDeviceApproval,
  deviceVerificationHandoff,
  type DeviceAuthorization,
  type DevicePollResult,
} from '../auth/pairing/deviceAuth';
import { installPairedSession } from '../auth/pairing/installPairedSession';
import { grantKeyMaterialForPairedMachine } from '../auth/pairing/pairDeviceGrant';
import type { PairMachineAnswerSession } from '../auth/pairing/pairContract';
import { spawnGrantDaemon, GRANT_SOCKET_ENV_VAR } from '../auth/deviceKey/grantHolder';
import { keepOrigin } from '../ui/screens/keepScreens';
import { openScreen } from '../ui/openScreen';
import { renderTerminalQr } from '../ui/terminalQr';
import {
  readActiveRuntimePairing,
  readRuntimePairing,
  recoverFilesystemRuntimePairingWhileLeaseHeld,
  registerFilesystemRuntimePairing,
  type ActiveRuntimePairing,
} from '../auth/pairing/runtimePairing';
import { runtimePairingEnvironment } from '../auth/pairing/runtimePairingEnvironment';
import {
  acquirePairAttemptLease,
  releasePairAttemptLease,
  type PairAttemptLease,
} from '../auth/pairing/pairAttemptLease';
import { AuthService } from '../auth/authService';

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
  readonly json?: boolean;
}

export type ActivePairingSessionOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'reauthenticate' }
  | { readonly kind: 'failed'; readonly code: string; readonly detail: string };

interface ActivePairingSessionAuth {
  readonly authenticateSilent: () => Promise<AuthResult>;
}

type ActivePairingSessionAuthFactory = (
  active: ActiveRuntimePairing,
  apiUrl: string | undefined,
  devMode: boolean,
) => ActivePairingSessionAuth;

/**
 * A live runtime-pair daemon proves that key custody is still available; it
 * does not make an expired WorkOS session immortal. Before treating `pair`
 * as a no-op, use the persisted refresh token through the ordinary silent
 * auth path. An ended/missing session needs a fresh device-authorization
 * login, while transport/service failures stay failures (opening WorkOS
 * cannot repair them).
 */
export async function ensureActiveRuntimePairingSession(
  active: ActiveRuntimePairing,
  apiUrl: string | undefined,
  devMode: boolean,
  createAuth: ActivePairingSessionAuthFactory = (_active, resolvedApiUrl, resolvedDevMode) =>
    new AuthService(resolvedApiUrl, resolvedDevMode, _active.userId),
): Promise<ActivePairingSessionOutcome> {
  const result = await createAuth(active, apiUrl, devMode).authenticateSilent();
  if (result.success) {
    return result.user_id === active.userId
      ? { kind: 'ready' }
      : {
          kind: 'failed',
          code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
          detail: 'The authenticated session does not match the account paired to this runtime.',
        };
  }
  if (result.error_code === 'session_ended' || result.error_code === 'no_session') {
    return { kind: 'reauthenticate' };
  }
  const code = result.error_code === 'network'
    ? ERROR_CODES.NETWORK_ERROR
    : result.error_code === 'server_error'
      ? ERROR_CODES.SERVICE_ERROR
      : result.error_code === 'org_not_found'
        ? ERROR_CODES.ORG_NOT_FOUND
        : ERROR_CODES.AUTH_FAILED;
  return {
    kind: 'failed',
    code,
    detail: result.error || 'Could not refresh the paired runtime session.',
  };
}

export interface PairCommandDependencies {
  readonly restorePairing?: (lease: PairAttemptLease) => Promise<void>;
  readonly readActivePairing?: () => Promise<ActiveRuntimePairing | null>;
  readonly ensureActiveSession?: (active: ActiveRuntimePairing) => Promise<ActivePairingSessionOutcome>;
  readonly acquirePairAttempt?: () => PairAttemptLease;
  readonly releasePairAttempt?: (lease: PairAttemptLease) => boolean;
}

type PairCommandExitCode = 0 | 1;

export class PairCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
    private readonly dependencies: PairCommandDependencies = {},
  ) {}

  async execute(options: PairCommandOptions = {}): Promise<PairCommandExitCode> {
    if (!deviceKeysEnabled()) refuseFlagOff();
    return this.executePairAttempt(options);
  }

  private async executePairAttempt(options: PairCommandOptions): Promise<PairCommandExitCode> {
    const acquired = (() => {
      try {
        return { ok: true as const, lease: (this.dependencies.acquirePairAttempt ?? acquirePairAttemptLease)() };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    if (!acquired.ok) {
      const code = acquired.error instanceof CapyError
        ? acquired.error.code
        : ERROR_CODES.PAIR_ALREADY_IN_PROGRESS;
      const detail = acquired.error instanceof Error
        ? acquired.error.message
        : 'Another capy pair ceremony is already active in this runtime.';
      if (options.json) {
        console.log(JSON.stringify({ ok: false, code, detail }, null, 2));
      } else {
        console.error('');
        console.error(`  ${detail}`);
        console.error('');
      }
      return 1;
    }

    try {
      const restoration = await (async () => {
        try {
          await (this.dependencies.restorePairing ?? (async (lease) => {
            const record = readRuntimePairing();
            if (record?.version === 1 && record.filesystemCustody) {
              await recoverFilesystemRuntimePairingWhileLeaseHeld({
                expectedUserId: record.userId,
                environment: runtimePairingEnvironment(this.devMode),
              }, lease);
            }
          }))(acquired.lease);
          return { ok: true as const };
        } catch (error) { return { ok: false as const, error }; }
      })();
      if (!restoration.ok) return this.reportPairingFailure(restoration.error, options);
      // Serialize the active-session probe as well as the browser ceremony.
      // Refresh tokens may rotate, so two simultaneous `pair` commands must
      // not both refresh the same persisted token before reaching the lease.
      const active = await (this.dependencies.readActivePairing ?? readActiveRuntimePairing)();
      if (active) {
        const session = await (
          this.dependencies.ensureActiveSession
          ?? ((pairing) => ensureActiveRuntimePairingSession(pairing, this.apiUrl, this.devMode))
        )(active);
        if (session.kind === 'ready') {
          this.reportAlreadyActive(active, options);
          return 0;
        }
        if (session.kind === 'failed') {
          return this.reportActiveSessionFailure(session, options);
        }
      }
      return await this.executeWithLease(options, acquired.lease, active);
    } finally {
      (this.dependencies.releasePairAttempt ?? releasePairAttemptLease)(acquired.lease);
    }
  }

  private reportPairingFailure(error: unknown, options: PairCommandOptions): PairCommandExitCode {
    return this.reportActiveSessionFailure({
      kind: 'failed',
      code: error instanceof CapyError ? error.code : ERROR_CODES.AUTH_FAILED,
      detail: error instanceof Error ? error.message : 'Pairing could not be completed. Try again.',
    }, options);
  }

  private async executeWithLease(
    options: PairCommandOptions,
    lease: PairAttemptLease,
    active: ActiveRuntimePairing | null,
  ): Promise<PairCommandExitCode> {
    const serviceUrl = resolveActiveUrl(this.devMode);

    // Extracted so the outcome is a single const rather than a reassigned
    // binding (codebase immutability rule).
    const runDeviceFlow = async (): Promise<{ authorization: DeviceAuthorization; result: DevicePollResult }> => {
      const authorization = await startDeviceAuthorization(serviceUrl);
      await this.printPairingBlock(authorization);
      return { authorization, result: await awaitDeviceApproval(serviceUrl, authorization) };
    };

    const flow = await (async () => {
      try {
        return { ok: true as const, value: await runDeviceFlow() };
      } catch (err) {
        return { ok: false as const, err };
      }
    })();

    if (!flow.ok) {
      const err = flow.err;
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
      return 1;
    }

    const { authorization, result } = flow.value;
    const userCode = authorization.user_code;

    switch (result.status) {
      case 'complete':
        if (active) {
          return this.finishSessionRefresh(result.session, userCode, options);
        }
        return this.finish(result.session, userCode, options);
      case 'denied': {
        // `expired_token` keeps its own exit code and remedy: the code simply
        // ran out, which is a retry, not a refusal.
        if (result.error === 'expired_token') {
          if (options.json) {
            console.log(JSON.stringify({ ok: false, code: ERROR_CODES.PAIR_CODE_EXPIRED, userCode }, null, 2));
          } else {
            console.error('');
            console.error('  This pairing code has expired.');
            console.error(`  Run ${B('capy pair')} again.`);
            console.error('');
          }
          // `process.exit()` does not unwind `finally`, so release the
          // in-flight ceremony lease before preserving the CLI's established
          // immediate EXIT_NEEDS_INPUT behavior.
          (this.dependencies.releasePairAttempt ?? releasePairAttemptLease)(lease);
          process.exit(EXIT_NEEDS_INPUT);
        }
        const message = CEREMONY_FAILURE_MESSAGES[result.error] ?? 'The pairing request was not approved.';
        if (options.json) {
          console.log(JSON.stringify({ ok: false, code: result.error, userCode }, null, 2));
        } else {
          console.error('');
          console.error(`  ${message} (${result.error})`);
          console.error('  No session or key material was installed.');
          console.error('');
        }
        return 1;
      }
      case 'pending': {
        const detail = 'The pairing poll ended before device authorization reached a terminal state.';
        if (options.json) {
          console.log(JSON.stringify({ ok: false, code: ERROR_CODES.SERVICE_ERROR, detail, userCode }, null, 2));
        } else {
          console.error('');
          console.error(`  ${detail}`);
          console.error('');
        }
        return 1;
      }
    }
  }

  private reportAlreadyActive(
    active: ActiveRuntimePairing,
    options: PairCommandOptions,
    sessionRefreshed: boolean = false,
  ): void {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            code: ERROR_CODES.RUNTIME_PAIR_ALREADY_ACTIVE,
            alreadyActive: true,
            userId: active.userId,
            userEmail: active.userEmail,
            socketPath: active.socketPath,
            envVar: GRANT_SOCKET_ENV_VAR,
            ...(sessionRefreshed ? { sessionRefreshed: true } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');
    console.log(
      sessionRefreshed
        ? `  \x1b[32mSession refreshed; still paired as ${B(active.userEmail)}.\x1b[0m`
        : `  \x1b[32mAlready paired as ${B(active.userEmail)}.\x1b[0m`,
    );
    console.log('  This device is ready to use Capy.');
    console.log('');
  }

  private reportActiveSessionFailure(
    failure: Extract<ActivePairingSessionOutcome, { readonly kind: 'failed' }>,
    options: PairCommandOptions,
  ): PairCommandExitCode {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, code: failure.code, detail: failure.detail }, null, 2));
    } else {
      console.error('');
      console.error(`  ${failure.detail}`);
      console.error('');
    }
    return 1;
  }

  private async finishSessionRefresh(
    session: PairMachineAnswerSession,
    userCode: string,
    options: PairCommandOptions,
  ): Promise<PairCommandExitCode> {
    // The device flow can outlive its starting daemon (logout, crash, or a
    // same-user replacement). Re-read the runtime authority before choosing
    // the install-only path: when custody disappeared, finish as a full pair
    // so the newly authenticated session never gets reported with a dead
    // socket; when it changed, bind the result to the current record.
    const current = await (this.dependencies.readActivePairing ?? readActiveRuntimePairing)();
    if (!current) {
      return this.finish(session, userCode, options);
    }

    if (session.user.id !== current.userId) {
      const detail = 'The authenticated account does not match the account paired to this runtime. Sign in with the paired account or run `capy logout` first.';
      if (options.json) {
        console.log(JSON.stringify({
          ok: false,
          code: ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH,
          detail,
          userCode,
        }, null, 2));
      } else {
        console.error('');
        console.error(`  ${detail}`);
        console.error('');
      }
      return 1;
    }

    const installed = await (async () => {
      try {
        return {
          ok: true as const,
          value: await installPairedSession(session, { apiUrl: this.apiUrl, devMode: this.devMode }),
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    if (!installed.ok) {
      const detail = installed.error instanceof Error
        ? installed.error.message
        : 'The refreshed session could not be installed.';
      if (options.json) {
        console.log(JSON.stringify({ ok: false, code: ERROR_CODES.AUTH_FAILED, detail, userCode }, null, 2));
      } else {
        console.error('');
        console.error(`  Authentication succeeded but the refreshed session could not be installed: ${detail}`);
        console.error('');
      }
      return 1;
    }

    this.reportAlreadyActive({ ...current, userEmail: session.user.email }, options, true);
    return 0;
  }

  /**
   * The device-grant terminal UX. No TTY-gating for the URL/code
   * themselves — spec §5's documented bright-line exception: this code is a
   * claim ticket, not a credential, so printing it unconditionally is safe
   * (unlike `capy transport`'s TRANSPORT_CODE_UNSAFE_SURFACE class of
   * secret). The URL and code below print unconditionally, every time.
   *
   * The QR (CAP-409 follow-up) is purely additive on top of that: a
   * Unicode half-block rendering of the exact same URL, shown only when
   * `renderTerminalQr` decides the terminal can actually display it (real
   * TTY, no NO_COLOR-style opt-out, wide/tall enough for this URL's
   * encoding). It never carries information the text above doesn't already
   * have, and it is never the only way to reach the code — see
   * `../ui/terminalQr.ts`'s file header. WorkOS's
   * `verification_uri_complete` includes the code, so both the text link and
   * QR open AuthKit with the code prefilled. The code is still printed for
   * the confirmation comparison and for the bare-URI compatibility fallback.
   */
  private async printPairingBlock(authorization: DeviceAuthorization): Promise<void> {
    // The verification URI comes from the AUTHORIZE response — it is WorkOS's
    // page now, not Keep's /pair, because the machine authenticates itself
    // rather than being handed a session (CAP-566). Never hardcoded: the IdP
    // owns that URL and is entitled to change it.
    const handoff = deviceVerificationHandoff(authorization);
    const url = handoff.url;
    const userCode = handoff.userCode;
    const codeInstruction = handoff.codePrefilled
      ? `  The code is prefilled. Confirm it matches: ${B(userCode)}`
      : `  If prompted, enter: ${B(userCode)}`;
    console.log('');
    console.log(`  To sign this machine in, go to ${B(url)}`);
    console.log(codeInstruction);
    // Open the COMPLETE WorkOS handoff ourselves rather than asking an agent
    // to reconstruct it from terminal prose. Agent clients commonly redact or
    // normalize high-entropy query values; dropping `user_code` turns the
    // one-click confirmation into manual transcription. `openScreen` is
    // best-effort and honors CAPY_WEB_NO_OPEN, so headless/cloud runtimes keep
    // the printed URL and code fallback without failing the pairing flow.
    await openScreen(url, { kind: 'handoff' });
    const qr = renderTerminalQr(url);
    if (qr) {
      console.log('');
      console.log(qr);
    }
    console.log('');
    console.log('  Waiting…');
  }

  private async finish(
    session: PairMachineAnswerSession,
    userCode: string,
    options: PairCommandOptions,
  ): Promise<PairCommandExitCode> {
    // Single const rather than a reassigned binding (immutability rule).
    const installed = await (async () => {
      try {
        return { ok: true as const, value: await installPairedSession(session, { apiUrl: this.apiUrl, devMode: this.devMode }) };
      } catch (err) {
        return { ok: false as const, err };
      }
    })();

    if (!installed.ok) {
      const err = installed.err;
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
      return 1;
    }

    // The session is on disk now — fetch this account's own wrapped_k_local
    // over the authenticated API and unwrap it locally (see this file's
    // header and pairKeyMaterial.ts). Doors are org-less server-side, so
    // ANY org this account belongs to authenticates the fetch: prefer the
    // org the session just activated, falling back to answer.keyMaterial.orgId
    // (the org the browser had active at approval time) for the
    // non-interactive multi-org case where install.orgId is deliberately
    // null (installPairedSession.ts's own doc explains why).
    // The session belongs to THIS machine now, so the key-material half runs
    // the ordinary CAP-384 grant ceremony over it rather than unwrapping a
    // PRF output sealed by the approver. The PRF itself still happens on the
    // human's own device, reached through the broker transport — nothing
    // WebAuthn-shaped is attempted on this headless box.
    const install = installed.value;
    const authOrgId = install.orgId ?? session.organizations[0]?.id ?? null;
    const resolved = await grantKeyMaterialForPairedMachine({
      apiUrl: this.apiUrl,
      devMode: this.devMode,
      authOrgId,
      userId: session.user.id,
      serviceUrl: resolveActiveUrl(this.devMode),
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
      return 1;
    }

    // This org is a custody storage location, not a repository attribution.
    if (!authOrgId) {
      throw new CapyError('Your account needs an organization before this device can be connected.', ERROR_CODES.AUTH_FAILED);
    }
    const persisted = await (async () => {
      try {
        const daemon = await spawnGrantDaemon(resolved.material, { ttlMs: null, persistRuntimePairing: false });
        await registerFilesystemRuntimePairing(
          runtimePairingEnvironment(this.devMode), authOrgId, resolved.material, daemon,
        );
        return { ok: true as const, daemon };
      } catch (error) { return { ok: false as const, error }; }
    })();
    if (!persisted.ok) return this.reportPairingFailure(persisted.error, options);
    const daemon = persisted.daemon;

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            userCode,
            userId: session.user.id,
            userEmail: session.user.email,
            orgId: install.orgId,
            orgName: install.orgName ?? null,
            orgTokenReady: install.orgTokenReady,
            socketPath: daemon.socketPath,
            envVar: GRANT_SOCKET_ENV_VAR,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log('');
    console.log(`  \x1b[32mPaired as ${B(session.user.email)}.\x1b[0m`);
    if (install.orgId) {
      console.log(`  Active organization: ${B(install.orgName || install.orgId)}`);
    } else if (session.organizations.length === 0) {
      console.log(`  No organizations yet — run ${B('capy')} to create one.`);
    } else {
      console.log(`  Multiple organizations available — run ${B('capy org')} to pick one.`);
    }
    console.log('  This device stays connected across restarts while its protected Capy files remain.');
    console.log('  Run `capy logout` to disconnect it.');
    console.log('');
    return 0;
  }
}
