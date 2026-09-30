/**
 * `capy transport` "v2" (CAP-684, docs/basic-pair.md — updated 2026-09-30).
 * `capy redeem` is untouched: it shares only `crypto/inviteCrypto.ts`'s
 * parse/unwrap helpers, which this command never imports.
 *
 * Moves this machine's `local.key` + `key.enc` (for the project's org and
 * the current user) to another device, via Keep:
 *
 *   1. Mint a random 32-byte key S and hand it to the service AS the
 *      `POST /transports` `ciphertext` field (base64url) — the service
 *      stores only this one-time decryption key, never the key material
 *      itself, and hands back `{id, expires_at}`.
 *   2. Seal the payload under S with AAD bound to `id` (`sealTransportPayload`),
 *      so sealing can only happen after step 1 — the AAD needs the id.
 *   3. Print a QR code + `.../transport#<id>.<iv>.<ct>`. S is NEVER in the
 *      link; the link is useless without also authenticating as the right
 *      user to activate the row and get S back.
 */
import { resolveOrgContext } from '../core/orgContext';
import { readLocalRoot, readOrgKeyFileRaw } from '../config/globalConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generateTransportKey, sealTransportPayload } from '../crypto/transportCrypto';
import type { TransportPayload } from '../crypto/pairingPayload';
import { renderTerminalQr } from '../ui/terminalQr';
import { printMaskedLinkBlock } from '../ui/maskedLinkPrompt';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';

export interface TransportOptions {
  json?: boolean;
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

      const payload: TransportPayload = {
        v: 1,
        entries: [{
          org_id: orgId,
          user_id: userId,
          k_local: kLocal.toString('base64url'),
          key_enc: keyEnc,
        }],
      };

      const key = generateTransportKey();
      const { id, expires_at } = await serviceClient.createTransport(key.toString('base64url'));

      // AAD binds to `id`, which only exists after the call above — sealing
      // has to happen here, not before it, unlike v1's token-first order.
      const fragment = sealTransportPayload(payload, key, id);
      const url = `${resolveKeepOrigin()}/transport#${id}.${fragment.iv}.${fragment.ct}`;

      if (json) {
        console.log(JSON.stringify({ url, expires_at }, null, 2));
        return;
      }

      // The QR always encodes the FULL url (it has to — scanning it on a
      // phone is how the other device gets the key material) even though
      // the text link below is masked; only the printed text is masked.
      const qr = renderTerminalQr(url);
      console.log('');
      if (qr) console.log(qr);
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
