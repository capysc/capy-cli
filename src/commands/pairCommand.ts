/**
 * `capy pair` (CAP-684, docs/basic-pair.md) — brings this machine into an
 * org by pulling `local.key` + `key.enc` from a browser already signed into
 * Keep, via a WorkOS RFC 8628 device-grant login.
 *
 * 1. Mint a one-time P-256 ECDH key pair and `POST /auth/device/authorize`.
 * 2. Print a QR code + link, then poll `/auth/device/token` (RFC 8628).
 * 3. Once approved, require confirmation of the returned account before
 *    installing the session the same way `capy` login does
 *    (`AuthService#installDeviceGrantSession`).
 * 4. `POST /device-pairings/pickup` with the new token, open the sealed
 *    payload with the key pair from step 1, and write `local.key` +
 *    `key.enc` for every entry whose `user_id` matches the logged-in user.
 */
import { confirmPairAccount } from './pairAccountConfirmation';
import { resolveActiveUrl } from '../config/profileConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generatePairKeyPair, openPairEnvelope, parsePairEnvelope } from '../crypto/pairCrypto';
import { authorizeDevice, pollDeviceToken } from '../auth/deviceGrant';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseMasterKeyRecord, readLocalRoot, saveLocalRoot, writeOrgKeyFileRaw } from '../config/globalConfig';
import { renderTerminalQr, type RenderedTerminalQr } from '../ui/terminalQr';
import { printMaskedLinkBlock, maskLink, type MaskedLinkPromptHandle } from '../ui/maskedLinkPrompt';
import { isFullScreenQrEligible, startFullScreenQrView, printMaskedLinkFooter } from '../ui/fullScreenQr';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';
import type { PairingEntry } from '../crypto/pairingPayload';

export type PairPresentation = 'centered' | 'inline';

export interface PairOptions {
  readonly json?: boolean;
  readonly force?: boolean;
  readonly apiUrl?: string;
  readonly devMode?: boolean;
  /** Internal root-command guard; direct `capy pair` remains account-selectable. */
  readonly expectedUserId?: string;
  /** Internal interactive-login hook. Reuses the caller's session instead of creating a second auth flow. */
  readonly authService?: AuthService;
  /** Internal UI mode: explicit `capy pair` centers the QR; onboarding keeps its flow inline. */
  readonly presentation?: PairPresentation;
  /** Internal org scope required by an interactive command that started pairing. */
  readonly organizationId?: string;
}

/** Prose/QR/progress output. Always sent to stderr under `--json` so stdout stays pure JSON; stdout in human mode otherwise. */
function announce(json: boolean, line: string): void {
  if (json) {
    console.error(line);
  } else {
    console.log(line);
  }
}

interface PairedOrg {
  org_id: string;
  user_id: string;
}

/** Writes one entry's `local.key` + `key.enc`, honoring the local.key conflict guard. Returns whether it was written or skipped (--force not needed, values matched). */
function writeEntry(entry: PairingEntry, force: boolean): 'written' {
  const keyRecord = parseMasterKeyRecord(entry.key_enc);
  if (!keyRecord || (entry.transport_id !== undefined && keyRecord.transportId !== entry.transport_id)) {
    throw new CapyError(
      'Transport key metadata does not match its pairing entry.',
      ERROR_CODES.INVALID_FORMAT,
    );
  }
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

const PAIR_LINK_LABEL = 'Approve on your other device:'; // COPY-FLAG


/**
 * Prints the non-`--json` (human) link block: QR (always the full,
 * unmasked `deviceLink` — a phone scanning it needs the real `code` query
 * param) then the masked link, interactive on a real TTY. `--json`'s own
 * progress output (to stderr, unmasked, unchanged) is a separate branch in
 * `pairCommand` below — this function is never called under `--json`.
 *
 * Full-screen centered QR (CAP-692 follow-up, shared with `capy transport`
 * via `fullScreenQr.ts`) only in a real interactive TTY, never under
 * `NO_COLOR`. The returned handle's `done`/`stop()` behave identically
 * either way, so the caller (`pairCommand` below) runs the device-token
 * poll concurrently with either variant the exact same way, and calls
 * `stop()` once the poll settles whether or not the user ever pressed a
 * key — same contract `startMaskedLinkPrompt` has always had.
 */
function printHumanPairBlock(deviceLink: string, qr: RenderedTerminalQr | null, userCode: string, presentation: PairPresentation): MaskedLinkPromptHandle | null {
  const masked = maskLink(deviceLink, 'query');

  if (presentation === 'centered' && isFullScreenQrEligible(false) && qr) {
    const view = startFullScreenQrView({
      fullUrl: deviceLink,
      maskedUrl: masked,
      label: PAIR_LINK_LABEL,
      qr,
      extraFooterLines: [`Code: ${userCode}`], // COPY-FLAG (same text as the non-full-screen path below)
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
        extraLines: [`Code: ${userCode}`], // COPY-FLAG (same text as the non-full-screen path below)
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
  console.log('');
  return prompt;
}

export async function pairCommand(options: PairOptions = {}): Promise<AuthResult> {
  const json = options.json === true;
  const force = options.force === true;
  const devMode = options.devMode === true;
  const presentation = options.presentation ?? 'centered';
  try {
    // Same precedence ServiceClient's constructor uses: explicit override
    // wins, otherwise the profile chain (CAPY_API_URL → profile → default).
    const apiUrl = options.apiUrl || resolveActiveUrl(devMode);

    const keyPair = generatePairKeyPair();
    const authorize = await authorizeDevice(apiUrl, keyPair.publicKey);

    // The QR always encodes the FULL deviceLink (fragment/query and all) —
    // only the TEXT link below is ever masked.
    const deviceLink = `${resolveKeepOrigin()}/device?code=${encodeURIComponent(authorize.user_code)}`;
    const qr = renderTerminalQr(deviceLink);

    // `--json`'s progress output (stderr, unmasked) is unchanged below;
    // this is the new masked/interactive block, printed only in human mode.
    const prompt = json ? null : printHumanPairBlock(deviceLink, qr, authorize.user_code, presentation);
    if (json) {
      announce(true, '');
      if (qr) {
        announce(true, qr.text);
        if (qr.hint) announce(true, qr.hint);
      }
      announce(true, `  Approve on your other device: ${deviceLink}`); // COPY-FLAG
      announce(true, `  Code: ${authorize.user_code}`); // COPY-FLAG
      announce(true, '');
    }

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

    if (options.expectedUserId && exchange.user.id !== options.expectedUserId) {
      throw new CapyError(
        'Pairing account does not match the account that started this command. No session or keys were installed.',
        ERROR_CODES.AUTH_FAILED,
      );
    }

    if (!await confirmPairAccount(exchange.user.email, json)) {
      throw new CapyError(
        'Pairing cancelled. No session or keys were installed.',
        ERROR_CODES.AUTH_FAILED,
      );
    }

    const authService = options.authService ?? new AuthService(options.apiUrl, devMode);
    const installed = await authService.installDeviceGrantSession(exchange.token, exchange.user, exchange.organizations);
    const authenticated = options.organizationId
      ? await authService.authenticateSilent(options.organizationId)
      : installed.organization_id
        ? installed
        : await authService.authenticateSilent();
    if (!authenticated.success) {
      throw new CapyError(
        authenticated.error || 'Device pairing could not establish an organization session.',
        ERROR_CODES.AUTH_FAILED,
      );
    }

    const serviceClient = new ServiceClient(options.apiUrl, devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    const { sealed } = await serviceClient.pickupDevicePairing(authorize.device_code);
    const envelope = parsePairEnvelope(sealed);
    const payload = openPairEnvelope(envelope, keyPair);

    const matching = payload.entries.filter((e) => e.user_id === exchange.user.id);
    if (matching.length === 0) {
      throw new CapyError(
        'No keys were waiting for this account — run `capy transport` on a machine that already has them, then try again.', // COPY-FLAG
        ERROR_CODES.PAIR_NO_KEYS,
      );
    }

    const paired: PairedOrg[] = matching.map((entry) => {
      writeEntry(entry, force);
      return { org_id: entry.org_id, user_id: entry.user_id };
    });

    if (json) {
      console.log(JSON.stringify({ ok: true, user_id: exchange.user.id, paired }, null, 2));
      return authenticated;
    }

    console.log('');
    console.log(`  Paired ${paired.length} organization${paired.length === 1 ? '' : 's'} to this machine.`); // COPY-FLAG
    console.log('');
    return authenticated;
  } catch (err) {
    refuseError(err, json);
  }
}
