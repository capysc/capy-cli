/**
 * `capy pair` (CAP-684, docs/basic-pair.md) — signs this machine in through
 * Keep, via a WorkOS RFC 8628 device-grant login. Two modes
 * (`auth/pairing/pairScope.ts`):
 *
 *  - `capy pair`: sign-in only, Keep `/pair`, for a machine that already has
 *    its keys. Nothing is picked up; a machine without usable keys for the org
 *    is refused before anything is installed (PAIR_TRANSPORT_REQUIRED).
 *  - `capy pair --transport` (or `--signup` for a fresh project): Keep
 *    `/transport/pair` seals `local.key` + `key.enc` to this run's key, and they
 *    are picked up as described below. Meant to happen once per runtime.
 *
 * The approver's Keep session decides the org (checked against their WorkOS
 * membership); this folder's keep.lock org is only a hint. The service hands
 * the session only to the account that approved in Keep (else
 * PAIR_ACCESS_DENIED), and says which org it was bound to.
 *
 * 1. Mint a one-time P-256 ECDH key pair and `POST /auth/device/authorize`.
 * 2. Print a QR code + link, then poll `/auth/device/token` (RFC 8628).
 * 3. Once approved, require confirmation of the returned account before
 *    installing the session the same way `capy` login does
 *    (`AuthService#installDeviceGrantSession`).
 * 4. Unless usable keys of the approving account are already on this machine for
 *    every organization of the account (and `--force` was not given; then
 *    pairing only signs in): `POST /device-pairings/pickup` with the new token,
 *    open the sealed payload with the key pair from step 1, and write
 *    `local.key` + `key.enc` for every entry whose `user_id` matches the
 *    logged-in user.
 */
import { prepareTransportCustody } from '../auth/pairing/transportCustody';
import { confirmPairAccount } from './pairAccountConfirmation';
import { resolveActiveUrl } from '../config/profileConfig';
import { generatePairKeyPair, openPairEnvelope, parsePairEnvelope, type PairKeyPair } from '../crypto/pairCrypto';
import { authorizeDevice, pollDeviceToken, type DeviceTokenExchange, type PairingIntent } from '../auth/deviceGrant';
import { pairApprovalLink, resolvePairScope, type PairScope } from '../auth/pairing/pairScope';
import { pairKeyFingerprint } from '../crypto/pairFingerprint';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { hasUsableOrgKeys, readLocalRoot, saveLocalRoot, writeOrgKeyFileRaw } from '../config/globalConfig';
import { renderTerminalQr, type RenderedTerminalQr } from '../ui/terminalQr';
import { printMaskedLinkBlock, maskLink, type MaskedLinkPromptHandle } from '../ui/maskedLinkPrompt';
import { isFullScreenQrEligible, startFullScreenQrView, printMaskedLinkFooter } from '../ui/fullScreenQr';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';
import type { PairingEntry } from '../crypto/pairingPayload';

export interface PairOptions {
  readonly json?: boolean;
  readonly force?: boolean;
  readonly apiUrl?: string;
  readonly devMode?: boolean;
  /** `--transport`: hand keys over to this machine (Keep `/transport/pair`), for the project in this folder. */
  readonly transport?: boolean;
  /** `--signup`: a fresh project; the approver creates the org in Keep. */
  readonly signup?: boolean;
  /** `--org <id>`: an org hint for a multi-org account, when this folder does not give one. */
  readonly org?: string;
  /** `--title`: the agent's short reason for pairing; Keep's pairing heading. Display only. */
  readonly title?: string;
  /** `--description`: what the agent will do once paired; shown under the heading. Display only. */
  readonly description?: string;
}

/** The trimmed, non-empty `--title`/`--description`, as sent to the service. */
export function pairIntent(options: Pick<PairOptions, 'title' | 'description'>): PairingIntent {
  const title = options.title?.trim();
  const description = options.description?.trim();
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

interface PairedOrg {
  readonly org_id: string;
  readonly user_id: string;
}

/** Writes one entry's `local.key` + `key.enc`, honoring the local.key conflict guard. Returns whether it was written or skipped (--force not needed, values matched). */
function writeEntry(entry: PairingEntry, force: boolean): 'written' {
  const newKLocal = Buffer.from(entry.k_local, 'base64url');
  const existing = readLocalRoot(entry.org_id, entry.user_id);
  if (existing && !existing.equals(newKLocal) && !force) {
    throw new CapyError(
      `This machine already has a different local key for org ${entry.org_id} — pass --force to overwrite it.`, // COPY-FLAG
      ERROR_CODES.PAIR_LOCAL_KEY_CONFLICT,
      { org_id: entry.org_id },
    );
  }
  saveLocalRoot(entry.org_id, newKLocal, entry.user_id);
  writeOrgKeyFileRaw(entry.org_id, entry.key_enc, entry.user_id);
  return 'written';
}

/** What a link elicitation says the pairing is for. Display text for the agent. */
export const PAIR_DEFAULT_PURPOSE = 'Sign in or sign up in Keep, prepare Transport, and pair this CLI.'; // COPY-FLAG

/** What a link elicitation says the pairing is for: the agent's own words when given, else what each kind of pairing does. */
export function pairPurpose(scope: { readonly mode: 'session' | 'transport'; readonly signup: boolean }, intent: PairingIntent = {}): string {
  if (intent.description ?? intent.title) return (intent.description ?? intent.title)!;
  if (scope.signup) return PAIR_DEFAULT_PURPOSE;
  return scope.mode === 'session'
    ? 'Sign this machine in with Keep. Its keys are already here; none are sent.' // COPY-FLAG
    : 'Send this project\'s keys to this machine from Keep, and sign it in.'; // COPY-FLAG
}

const PAIR_LINK_LABEL = 'Approve on your other device:'; // COPY-FLAG


/**
 * Prints the non-`--json` (human) link block: QR (always the full,
 * unmasked `deviceLink` — a phone scanning it needs the real `code` query
 * param) then the masked link, interactive on a real TTY. Agents do not come
 * through here: `capy pair --json` is `pairAgentCommand.ts`, and this function
 * is never called under `--json`.
 *
 * Full-screen centered QR (CAP-692 follow-up, shared with `capy transport`
 * via `fullScreenQr.ts`) only in a real interactive TTY, never under
 * `NO_COLOR`. The returned handle's `done`/`stop()` behave identically
 * either way, so the caller (`pairCommand` below) runs the device-token
 * poll concurrently with either variant the exact same way, and calls
 * `stop()` once the poll settles whether or not the user ever pressed a
 * key — same contract `startMaskedLinkPrompt` has always had.
 */
function printHumanPairBlock(deviceLink: string, qr: RenderedTerminalQr | null, userCode: string, fingerprint: string): MaskedLinkPromptHandle | null {
  const masked = maskLink(deviceLink, 'query');
  const keyLine = `Key fingerprint: ${fingerprint} (Keep shows the same)`; // COPY-FLAG

  if (isFullScreenQrEligible(false) && qr) {
    const view = startFullScreenQrView({
      fullUrl: deviceLink,
      maskedUrl: masked,
      label: PAIR_LINK_LABEL,
      qr,
      extraFooterLines: [`Code: ${userCode}`, keyLine], // COPY-FLAG (same text as the non-full-screen path below)
    });
    // Whenever the view closes — the user pressed q, or the surrounding
    // poll's `finally { prompt?.stop() }` closed it for them — the masked
    // link + code need to be left in scrollback, same as the non-full-screen
    // path already leaves in place from its very first print.
    void view.done.then(() => {
      printMaskedLinkFooter(process.stdout, {
        fullUrl: deviceLink,
        maskedUrl: masked,
        label: PAIR_LINK_LABEL,
        extraLines: [`Code: ${userCode}`, keyLine], // COPY-FLAG (same text as the non-full-screen path below)
      });
    });
    return view;
  }

  console.log('');
  if (qr) {
    console.log(qr.text);
    if (qr.hint) console.log(qr.hint);
  }
  const prompt = printMaskedLinkBlock({ fullUrl: deviceLink, kind: 'query', label: PAIR_LINK_LABEL });
  console.log(`  Code: ${userCode}`); // COPY-FLAG
  console.log(`  ${keyLine}`);
  console.log('');
  return prompt;
}

/** What `finishPairing` did with the keys: `picked_up` (fetched and written) or `already_present` (the machine already had them). */
export type PairKeys = 'picked_up' | 'already_present';

export interface PairResult {
  /** The organizations whose keys were written. Empty when `keys` is `already_present`. */
  readonly paired: readonly PairedOrg[];
  readonly keys: PairKeys;
}

/** The session `installPairSession` put in place. */
interface InstalledPairSession {
  readonly authService: AuthService;
  /** The organization the session landed on, or '' when none could be resolved. */
  readonly organizationId: string;
}

/**
 * Installs the device-grant session. With no organization scoped by the device-grant token yet (a multi-org account),
 * the session is resolved into one the same way every other org-context command does.
 */
async function installPairSession(exchange: DeviceTokenExchange, options: PairOptions): Promise<InstalledPairSession> {
  const authService = new AuthService(options.apiUrl, options.devMode === true);
  const installed = await authService.installDeviceGrantSession(exchange.token, exchange.user, exchange.organizations);
  if (installed.organization_id) return { authService, organizationId: installed.organization_id };
  const resolved = await authService.authenticateSilent();
  return { authService, organizationId: resolved?.organization_id ?? '' };
}

/**
 * Picks up the sealed payload for `deviceCode`, opens it with the one-time key pair, and writes `local.key` + `key.enc`
 * for every entry that belongs to the approving account. Nothing waiting for this account is `PAIR_NO_KEYS`.
 */
async function pickUpPairedKeys(
  session: InstalledPairSession,
  exchange: DeviceTokenExchange,
  keyPair: PairKeyPair,
  deviceCode: string,
  options: PairOptions,
): Promise<readonly PairedOrg[]> {
  const serviceClient = new ServiceClient(options.apiUrl, options.devMode === true);
  serviceClient.setTokenProvider((rejected) => session.authService.getValidToken(rejected));

  const { sealed } = await serviceClient.pickupDevicePairing(deviceCode);
  const envelope = parsePairEnvelope(sealed);
  const payload = openPairEnvelope(envelope, keyPair);

  // Only the org Keep bound this pairing to (the approver's session org) may receive keys here. Keep seals only that
  // org's keys; anything else in the envelope is ignored rather than trusted.
  const matching = payload.entries.filter((e) => e.user_id === exchange.user.id
    && (exchange.pairedOrgId === null || e.org_id === exchange.pairedOrgId));
  if (matching.length === 0) {
    throw new CapyError(
      'No keys were waiting for this account — run `capy transport` on a machine that already has them, then try again.', // COPY-FLAG
      ERROR_CODES.PAIR_NO_KEYS,
    );
  }

  // A current Transport arrives bound to its transport id; verify it and rebind it to this installation before any write.
  const prepared = await Promise.all(matching.map((entry) => prepareTransportCustody(entry, {
    unwrap: async (orgId, ciphertext, transportId) => (await serviceClient.coDecrypt(orgId, ciphertext, undefined, transportId)).plaintext,
    wrap: async (orgId, innerCiphertext) => (await serviceClient.wrapOuterLayer(orgId, innerCiphertext)).ciphertext,
  })));
  return prepared.map((entry) => {
    writeEntry(entry, options.force === true);
    return { org_id: entry.org_id, user_id: entry.user_id };
  });
}

/**
 * Sign-in-only pairing: usable keys of the approving account are already on this machine for the organization the
 * session landed on AND for every other organization of the account, and `--force` was not given. Then nothing is picked
 * up and no key file is read, moved or rewritten. If any of them is missing, unreadable or corrupt, the pickup runs, as
 * it always did, and rewrites them.
 */
function keysAlreadyHere(session: InstalledPairSession, exchange: DeviceTokenExchange, force: boolean): boolean {
  if (force) return false;
  if (session.organizationId === '') return false;
  // Without a user id every key path falls back to the un-scoped files, which could belong to anyone.
  if (typeof exchange.user.id !== 'string' || exchange.user.id === '') return false;
  const orgIds = [...new Set([session.organizationId, ...exchange.organizations.map((org) => org.id)])];
  return orgIds.every((orgId) => hasUsableOrgKeys(orgId, exchange.user.id));
}

/**
 * Sign-in only: the machine must already hold usable keys of the approving account for the org Keep bound the pairing
 * to (the approver's session org, as the service reports it). Checked before anything is installed, so a refusal
 * leaves the machine exactly as it was.
 */
function requireKeysForSignIn(exchange: DeviceTokenExchange): void {
  const userId = typeof exchange.user.id === 'string' && exchange.user.id !== '' ? exchange.user.id : null;
  if (exchange.pairedOrgId && userId && hasUsableOrgKeys(exchange.pairedOrgId, userId)) return;
  throw new CapyError(
    'This machine has no keys for that organization yet. Run capy pair --transport in the project to receive them. Nothing was installed.', // COPY-FLAG
    ERROR_CODES.PAIR_TRANSPORT_REQUIRED,
  );
}

/**
 * Everything after the approving account is accepted. Sign-in only (`session`): check the keys are here, then install
 * the session and stop. Key handover (`transport`): install the device-grant session, then either stop there (the
 * keys are already here) or pick up and write the keys. Shared by the terminal flow below and by `capy pair --wait`
 * (`pairAgentCommand.ts`); behaviour is the same in both.
 */
export async function finishPairing(
  exchange: DeviceTokenExchange,
  keyPair: PairKeyPair,
  deviceCode: string,
  options: PairOptions,
  scope: Pick<PairScope, 'mode'>,
): Promise<PairResult> {
  if (scope.mode === 'session') {
    requireKeysForSignIn(exchange);
    await installPairSession(exchange, options);
    return { paired: [], keys: 'already_present' };
  }
  const session = await installPairSession(exchange, options);
  if (keysAlreadyHere(session, exchange, options.force === true)) {
    return { paired: [], keys: 'already_present' };
  }
  const paired = await pickUpPairedKeys(session, exchange, keyPair, deviceCode, options);
  return { paired, keys: 'picked_up' };
}

/** The one line the terminal flow prints when pairing ends. */
function pairedSummary(paired: readonly PairedOrg[], keys: PairKeys): string {
  if (keys === 'already_present') return '  This location is signed in. Its keys were already here.'; // COPY-FLAG
  return `  Paired ${paired.length} organization${paired.length === 1 ? '' : 's'} to this machine.`; // COPY-FLAG
}

export async function pairCommand(options: PairOptions = {}): Promise<void> {
  const json = options.json === true;
  const devMode = options.devMode === true;
  try {
    // Same precedence ServiceClient's constructor uses: explicit override
    // wins, otherwise the profile chain (CAPY_API_URL → profile → default).
    const apiUrl = options.apiUrl || resolveActiveUrl(devMode);

    const scope = resolvePairScope(options);
    const keyPair = generatePairKeyPair();
    const authorize = await authorizeDevice(apiUrl, keyPair.publicKey, scope, pairIntent(options));

    // The QR always encodes the FULL deviceLink (fragment/query and all) —
    // only the TEXT link below is ever masked.
    const deviceLink = pairApprovalLink(scope, authorize.user_code);
    const qr = json ? null : renderTerminalQr(deviceLink);

    const prompt = json ? null : printHumanPairBlock(deviceLink, qr, authorize.user_code, pairKeyFingerprint(keyPair.publicKey));

    // The poll and the masked-link key listener (`c`/`r`/`q`) run
    // CONCURRENTLY — the listener is event-driven (stdin 'data'), never a
    // blocking read, so it can never delay this. `prompt.stop()` always
    // runs once the poll settles (success OR failure), restoring raw mode
    // and detaching the listener even if the user never pressed a key.
    const exchange = await (async () => {
      try {
        return await pollDeviceToken(apiUrl, authorize.device_code, {
          intervalMs: authorize.interval * 1000,
          timeoutMs: authorize.expires_in * 1000,
        });
      } finally {
        prompt?.stop();
      }
    })();

    if (!await confirmPairAccount(exchange.user.email, json)) {
      throw new CapyError(
        'Pairing cancelled. No session or keys were installed.',
        ERROR_CODES.AUTH_FAILED,
      );
    }

    const { paired, keys } = await finishPairing(exchange, keyPair, authorize.device_code, options, scope);

    if (json) {
      console.log(JSON.stringify({ ok: true, user_id: exchange.user.id, paired, keys }, null, 2));
      return;
    }

    console.log('');
    console.log(pairedSummary(paired, keys));
    console.log('');
  } catch (err) {
    refuseError(err, json);
  }
}
