/**
 * `capy transport` (CAP-684, docs/basic-pair.md; CAP-692 for the wire
 * format). `capy redeem` is untouched: it shares only
 * `crypto/inviteCrypto.ts`'s parse/unwrap helpers, which this command never
 * imports.
 *
 * Creates a revocable credential for another device without changing this
 * machine's `local.key` or `key.enc`:
 *
 *   1. Open the source credential without migrating or rewriting it.
 *   2. Reserve a persistent transport id, mint a fresh K_transport, and wrap
 *      the same master key under it with the id bound in service context.
 *   3. Seal `{K_transport, key.enc, id, org, user}` under random link key S
 *      and upload it to the reserved row. The service never sees either key.
 *   4. Print a QR code + `.../transport#4.<id>.<S>` (`transportFragmentV4`).
 *      The link carries only the id and S (~100 chars, so the QR stays
 *      small); Keep activates the row as the signed-in user and decrypts
 *      the blob with S in the browser.
 */
import { hostname } from 'os';
import { resolveOrgContext } from '../core/orgContext';
import { buildTransportKeyFile } from '../config/globalConfig';
import { resolveKeepOrigin } from '../config/keepOrigin';
import { generateTransportKey, sealTransportBlob, transportFragmentV4 } from '../crypto/transportPackV3';
import { generateTransportLocalRoot, serializePersistentTransportPayload } from '../crypto/persistentTransportPayload';
import { unwrapMasterKey, type KeyServiceOps } from '../crypto/keyResolver';
import { encryptMasterKey, masterKeyAAD } from '../crypto/keyManager';
import { deriveLocalInnerKey } from '../crypto/localKeyRoot';
import { renderTerminalQr } from '../ui/terminalQr';
import { printMaskedLinkBlock, maskLink } from '../ui/maskedLinkPrompt';
import { isFullScreenQrEligible, startFullScreenQrView, printMaskedLinkFooter } from '../ui/fullScreenQr';
import { pollTransportRedemption } from './transportPoll';
import type { TransportStatusResult } from '../service/serviceClient';
import { CapyError, ERROR_CODES } from '../types/index';
import { refuseError } from './pairingRefusal';

/**
 * `/transports/:id` sits behind the service's mutation limiter (30
 * requests/min per IP) — 5s keeps this well under budget even alongside
 * whatever else the same machine is doing.
 */
const REDEMPTION_POLL_INTERVAL_MS = 5000;

const TRANSPORT_REDEEMED_MESSAGE = '  Activated. This protected transport is ready in that browser.'; // COPY-FLAG
const TRANSPORT_EXPIRED_MESSAGE = 'This transport link expired. Run capy transport again.'; // COPY-FLAG

/** Minimal shape `watchForRedemption` needs off `serviceClient` — easier to fake in tests than the full `ServiceClient` class. */
interface TransportStatusSource {
  getTransportStatus(id: string): Promise<TransportStatusResult>;
}

function transportKeyServiceOps(serviceClient: {
  coDecrypt(orgId: string, ciphertext: string, notAfter?: number, transportId?: string): Promise<{ plaintext: string }>;
  wrapOuterLayer(orgId: string, plaintext: string, notAfter?: number, transportId?: string): Promise<{ ciphertext: string }>;
}): KeyServiceOps {
  return {
    coDecrypt: (orgId, ciphertext, transportId) => serviceClient.coDecrypt(orgId, ciphertext, undefined, transportId).then(({ plaintext }) => plaintext),
    wrapOuterLayer: (orgId, plaintext) => serviceClient.wrapOuterLayer(orgId, plaintext).then(({ ciphertext }) => ciphertext),
  };
}

/** Either handle shape (`MaskedLinkPromptHandle` or `FullScreenQrHandle`) — both are structurally `{done, stop}`. */
interface ClosablePrompt {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

/**
 * Watches `GET /transports/:id` (CAP-692 follow-up) while `handle`
 * (the masked-link prompt or the full-screen view) is open, so the
 * command quits on its own once the link is redeemed elsewhere instead of
 * sitting there after the job is already done — see transportPoll.ts for
 * the actual poll/race logic, which treats `handle.done` (resolves on
 * q/Enter/Esc, same for either handle shape) as the "stop, nothing
 * happened" signal.
 *
 * Returns `'quit-by-user'` when `handle.done` won the race on its own
 * (the caller should fall through to its normal "print the link footer"
 * ending); returns normally after printing the done message on
 * redemption; throws the coded `TRANSPORT_EXPIRED` refusal on expiry —
 * either way, `handle.stop()` (restoring the terminal) always runs first.
 */
export async function watchForRedemption(args: {
  serviceClient: TransportStatusSource;
  id: string;
  expiresAt: string;
  handle: ClosablePrompt;
  /** True for the full-screen view, where `stop()`'s terminal restoration needs one more microtask tick to complete; false for the plain masked-link prompt, where `stop()` is fully synchronous. */
  awaitStop: boolean;
}): Promise<'quit-by-user' | void> {
  const outcome = await pollTransportRedemption({
    getStatus: () => args.serviceClient.getTransportStatus(args.id),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    intervalMs: REDEMPTION_POLL_INTERVAL_MS,
    stopSignal: args.handle.done,
    now: () => Date.now(),
    localExpiresAtMs: Date.parse(args.expiresAt),
  });
  if (outcome === null) return 'quit-by-user';

  args.handle.stop();
  if (args.awaitStop) await args.handle.done;

  if (outcome === 'redeemed') {
    console.log(TRANSPORT_REDEEMED_MESSAGE);
    return;
  }
  throw new CapyError(TRANSPORT_EXPIRED_MESSAGE, ERROR_CODES.TRANSPORT_EXPIRED);
}

export interface TransportOptions {
  readonly json?: boolean;
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
    `  Why we do this: https://capy.sc/zero-trust`,
  ].join('\n');
}

const LINK_LABEL = 'Open on your other device:'; // COPY-FLAG

export class TransportCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
  ) {}

  async execute(options: TransportOptions = {}): Promise<void> {
    const json = options.json === true;
    try {
      const { orgId, userId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

      const keyServiceOps = transportKeyServiceOps(serviceClient);
      const sourceMasterKey = await unwrapMasterKey(orgId, userId, keyServiceOps, { migrateLegacy: false });
      const { id, expires_at } = await serviceClient.createTransport(orgId, hostname());
      const transportRoot = generateTransportLocalRoot();
      const innerWrapped = encryptMasterKey(sourceMasterKey, deriveLocalInnerKey(transportRoot), masterKeyAAD(userId, orgId));
      const outerWrapped = await serviceClient.wrapOuterLayer(orgId, innerWrapped, undefined, id);
      const keyEnc = buildTransportKeyFile(orgId, outerWrapped.ciphertext, id);
      const payload = serializePersistentTransportPayload({
        v: 1,
        k_local: transportRoot.toString('base64url'),
        key_enc: keyEnc,
        transport_id: id,
        org_id: orgId,
        user_id: userId,
      });
      const linkKey = generateTransportKey();
      const blob = sealTransportBlob(payload, linkKey);
      await serviceClient.uploadTransport(id, blob);
      const fragment = transportFragmentV4(id, linkKey);
      const url = `${resolveKeepOrigin()}/transport#${fragment}`;

      if (json) {
        console.log(JSON.stringify({ url, expires_at }, null, 2));
        return;
      }

      console.log('');
      console.log(buildTransportIntro());

      // The QR always encodes the FULL url (it has to — scanning it on a
      // phone is how the other device gets the key material) even though
      // the text link is masked; only the printed text is masked.
      const qr = renderTerminalQr(url);

      // Full-screen centered QR (CAP-692 follow-up): only in a real
      // interactive TTY, never under --json (already returned above) or
      // NO_COLOR. Whenever this is eligible, `renderTerminalQr` above is
      // guaranteed non-null too (the hard-skip conditions are the same or
      // stricter), so `qr` is never null here in that branch.
      if (isFullScreenQrEligible(false) && qr) {
        const masked = maskLink(url, 'fragment');
        const view = startFullScreenQrView({
          fullUrl: url,
          maskedUrl: masked,
          label: LINK_LABEL,
          qr,
          // The alternate screen hides the intro printed above, so show it inside the view too.
          headerLines: buildTransportIntro().split('\n'),
          extraFooterLines: [`Expires ${expires_at}`], // COPY-FLAG (same text as the non-full-screen path below)
        });
        const watch = await watchForRedemption({ serviceClient, id, expiresAt: expires_at, handle: view, awaitStop: true });
        if (watch !== 'quit-by-user') return; // redeemed (printed) or expired (thrown) above.
        printMaskedLinkFooter(process.stdout, {
          fullUrl: url,
          maskedUrl: masked,
          label: LINK_LABEL,
          extraLines: [`Expires ${expires_at}`], // COPY-FLAG (same text as the non-full-screen path below)
        });
        return;
      }

      if (qr) {
        console.log(qr.text);
        if (qr.hint) console.log(qr.hint);
      }
      const prompt = printMaskedLinkBlock({ fullUrl: url, kind: 'fragment', label: LINK_LABEL });
      console.log(`  Expires ${expires_at}`); // COPY-FLAG
      console.log('');
      // Only set when both ends are a real TTY (see printMaskedLinkBlock) —
      // watches for redemption concurrently with the key listener (q/Enter/Esc);
      // the link stays valid for 15 minutes either way, so there's no harm
      // in just returning if the caller's own process is torn down (e.g.
      // piped into something else) first.
      if (prompt) await watchForRedemption({ serviceClient, id, expiresAt: expires_at, handle: prompt, awaitStop: false });
    } catch (err) {
      refuseError(err, json);
    }
  }
}
