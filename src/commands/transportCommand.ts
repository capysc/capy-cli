/**
 * `capy transport` (CAP-684, docs/basic-pair.md) — replaces the old
 * invite-shaped transport command. `capy redeem` is untouched: it shares
 * only `crypto/inviteCrypto.ts`'s parse/unwrap helpers, which this command
 * never imports.
 *
 * Moves this machine's `local.key` + `key.enc` (for the project's org and
 * the current user) to another device, via Keep: seal them under a random
 * key T, hand the ciphertext to the service (which never sees T — it only
 * ever travels in the printed URL's fragment, which browsers never send to
 * a server), and print a QR code plus the link.
 */
import { resolveOrgContext } from '../core/orgContext';
import { readLocalRoot, readOrgKeyFileRaw } from '../config/globalConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generateTransportToken, sealTransportPayload } from '../crypto/transportCrypto';
import type { TransportPayload } from '../crypto/pairingPayload';
import { renderTerminalQr } from '../ui/terminalQr';
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

      const token = generateTransportToken();
      const envelope = sealTransportPayload(payload, token);

      const { id, expires_at } = await serviceClient.createTransport(JSON.stringify(envelope));
      const url = `${resolveKeepOrigin()}/transport#${id}.${token.toString('base64url')}`;

      if (json) {
        console.log(JSON.stringify({ url, expires_at }, null, 2));
        return;
      }

      const qr = renderTerminalQr(url);
      console.log('');
      if (qr) console.log(qr);
      console.log(`  Open on your other device: ${url}`); // COPY-FLAG
      console.log(`  Expires ${expires_at}`); // COPY-FLAG
      console.log('');
    } catch (err) {
      refuseError(err, json);
    }
  }
}
