/**
 * `capy pair` (CAP-684, docs/basic-pair.md) — brings this machine into an
 * org by pulling `local.key` + `key.enc` from a browser already signed into
 * Keep, via a WorkOS RFC 8628 device-grant login.
 *
 * 1. Mint a one-time P-256 ECDH key pair and `POST /auth/device/authorize`.
 * 2. Print a QR code + link, then poll `/auth/device/token` (RFC 8628).
 * 3. Once approved, install the session the same way `capy` login does
 *    (`AuthService#installDeviceGrantSession`).
 * 4. `POST /device-pairings/pickup` with the new token, open the sealed
 *    payload with the key pair from step 1, and write `local.key` +
 *    `key.enc` for every entry whose `user_id` matches the logged-in user.
 */
import { resolveActiveUrl } from '../config/profileConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generatePairKeyPair, openPairEnvelope, parsePairEnvelope } from '../crypto/pairCrypto';
import { authorizeDevice, pollDeviceToken } from '../auth/deviceGrant';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { readLocalRoot, saveLocalRoot, writeOrgKeyFileRaw } from '../config/globalConfig';
import { renderTerminalQr } from '../ui/terminalQr';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';
import type { PairingEntry } from '../crypto/pairingPayload';

export interface PairOptions {
  json?: boolean;
  force?: boolean;
  apiUrl?: string;
  devMode?: boolean;
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

export async function pairCommand(options: PairOptions = {}): Promise<void> {
  const json = options.json === true;
  const force = options.force === true;
  const devMode = options.devMode === true;
  try {
    // Same precedence ServiceClient's constructor uses: explicit override
    // wins, otherwise the profile chain (CAPY_API_URL → profile → default).
    const apiUrl = options.apiUrl || resolveActiveUrl(devMode);

    const keyPair = generatePairKeyPair();
    const authorize = await authorizeDevice(apiUrl, keyPair.publicKey);

    const deviceLink = `${resolveKeepOrigin()}/device?code=${encodeURIComponent(authorize.user_code)}`;
    const qr = renderTerminalQr(deviceLink);
    announce(json, '');
    if (qr) announce(json, qr);
    announce(json, `  Approve on your other device: ${deviceLink}`); // COPY-FLAG
    announce(json, `  Code: ${authorize.user_code}`); // COPY-FLAG
    announce(json, '');

    const exchange = await pollDeviceToken(apiUrl, authorize.device_code, {
      intervalMs: authorize.interval * 1000,
      timeoutMs: authorize.expires_in * 1000,
    });

    const authService = new AuthService(options.apiUrl, devMode);
    const installed = await authService.installDeviceGrantSession(exchange.token, exchange.user, exchange.organizations);
    if (!installed.organization_id) {
      // Multi-org account with no org scoped by the device-grant token yet —
      // resolve into one the same way every other org-context command does.
      await authService.authenticateSilent();
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
      return;
    }

    console.log('');
    console.log(`  Paired ${paired.length} organization${paired.length === 1 ? '' : 's'} to this machine.`); // COPY-FLAG
    console.log('');
  } catch (err) {
    refuseError(err, json);
  }
}
