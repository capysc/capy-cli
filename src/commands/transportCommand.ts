/**
 * `capy transport` (CAP-684, docs/basic-pair.md; CAP-692 for the wire
 * format). `capy redeem` is untouched: it shares only
 * `crypto/inviteCrypto.ts`'s parse/unwrap helpers, which this command never
 * imports.
 *
 * Moves this machine's `local.key` + `key.enc` (for the project's org and
 * the current user) to another device, via Keep:
 *
 *   1. Pack this machine's `key.enc` + `local.key` into the v3 fixed-layout
 *      binary plaintext (`transportPackV3.ts`). There is no older link
 *      format to fall back to — if packing isn't lossless (foreign/corrupt
 *      `key.enc`), this refuses with a coded `TRANSPORT_KEY_FORMAT_UNSUPPORTED`
 *      BEFORE ever asking the service for a transport row, so nothing is
 *      wasted on a link that could never be produced.
 *   2. Mint a random 32-byte key S and hand it to the service AS the
 *      `POST /transports` `ciphertext` field (base64url) — the service
 *      stores only this one-time decryption key, never the key material
 *      itself, and hands back `{id, expires_at}`.
 *   3. Seal the packed plaintext under S with AAD bound to `id`
 *      (`sealTransportV3`), so sealing can only happen after step 2 — the
 *      AAD needs the id.
 *   4. Print a QR code + `.../transport#3.<id>.<blob>`. S is NEVER in the
 *      link; the link is useless without also authenticating as the right
 *      user to activate the row and get S back.
 */
import { resolveOrgContext } from '../core/orgContext';
import { readLocalRoot, readOrgKeyFileRaw } from '../config/globalConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generateTransportKey, packTransportV3, sealTransportV3 } from '../crypto/transportPackV3';
import type { PairingEntry } from '../crypto/pairingPayload';
import { renderTerminalQr } from '../ui/terminalQr';
import { printMaskedLinkBlock } from '../ui/maskedLinkPrompt';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';

export interface TransportOptions {
  json?: boolean;
}

/**
 * ANSI bold for an inline command name, respecting `NO_COLOR` the same way
 * `terminalQr.ts` gates its own decoration (https://no-color.org — any
 * non-empty value opts out). Plain `\x1b[1m` bold, the same look
 * `errorScreen.ts`'s `bold()` gives inline command names like
 * `capy decrypt`/`capy transport` in prose — just gated on `NO_COLOR` too,
 * since this is new styled output rather than an existing call site.
 */
function bold(s: string): string {
  const noColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length > 0;
  return noColor ? s : `\x1b[1m${s}\x1b[0m`;
}

/**
 * CAP-684 copy (Vince-approved verbatim, 2026-09-30): explains what
 * `capy transport` is for and how to use the link, printed before the
 * QR/link themselves. Built fresh per call (never a module-level constant)
 * so it re-reads `NO_COLOR` at print time, same as the rest of this file.
 */
// COPY-FLAG (approved verbatim — see CAP-684 follow-up)
function buildTransportIntro(): string {
  return [
    `  Transport works with ${bold('capy pair')} to let you use Capy anywhere: your other devices, sandboxes, and cloud AI sessions.`,
    '',
    `  Open or scan this link to activate your transport key and keep it in a browser you can always reach. We recommend your phone's browser. Sign in with the same account as this capy session, or activation won't work.`,
    '',
    `  If you lose the device or browser that activated the key, run ${bold('capy transport')} on any device where Capy is set up. That creates a new transport key to activate in a new browser.`,
    '',
    `  Why we do this: https://capy.sc/zero-trust`,
  ].join('\n');
}

export class TransportCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(options: TransportOptions = {}): Promise<void> {
    const json = options.json === true;
    try {
      const { orgId, userId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

      const kLocal = readLocalRoot(orgId, userId);
      const keyEnc = readOrgKeyFileRaw(orgId, userId);
      if (!kLocal || !keyEnc) {
        throw new CapyError(
          'No local key found for this organization on this machine — nothing to transport.', // COPY-FLAG
          ERROR_CODES.TRANSPORT_NO_LOCAL_KEY,
        );
      }

      const entry: PairingEntry = {
        org_id: orgId,
        user_id: userId,
        k_local: kLocal.toString('base64url'),
        key_enc: keyEnc,
      };

      // v3 (CAP-692) is the only wire format — pack BEFORE ever calling the
      // service, so an unpackable key.enc never burns a one-time transport
      // row for a link that was never going to exist.
      const packed = packTransportV3(entry);
      if (!packed) {
        throw new CapyError(
          "This machine's key file is in a format capy transport can't turn into a link.", // COPY-FLAG
          ERROR_CODES.TRANSPORT_KEY_FORMAT_UNSUPPORTED,
        );
      }

      const key = generateTransportKey();
      const { id, expires_at } = await serviceClient.createTransport(key.toString('base64url'));

      // AAD binds to `id`, which only exists after the call above — sealing
      // has to happen here, not before it.
      const fragment = sealTransportV3(packed, key, id);
      const url = `${resolveKeepOrigin()}/transport#${fragment}`;

      if (json) {
        console.log(JSON.stringify({ url, expires_at }, null, 2));
        return;
      }

      // The QR always encodes the FULL url (it has to — scanning it on a
      // phone is how the other device gets the key material) even though
      // the text link below is masked; only the printed text is masked.
      const qr = renderTerminalQr(url);
      console.log('');
      console.log(buildTransportIntro());
      if (qr) {
        console.log(qr.text);
        if (qr.hint) console.log(qr.hint);
      }
      const prompt = printMaskedLinkBlock({ fullUrl: url, kind: 'fragment', label: 'Open on your other device:' });
      console.log(`  Expires ${expires_at}`); // COPY-FLAG
      console.log('');
      // Only set when both ends are a real TTY (see printMaskedLinkBlock) —
      // blocks until q/Enter/Esc; the link stays valid for 15 minutes
      // either way, so there's no harm in just returning if the caller's
      // own process is torn down (e.g. piped into something else) first.
      if (prompt) await prompt.done;
    } catch (err) {
      refuseError(err, json);
    }
  }
}
