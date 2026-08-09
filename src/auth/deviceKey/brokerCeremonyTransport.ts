/**
 * BrokerCeremonyTransport (CAP-382) — the broker-backed implementation of
 * `CeremonyTransport` (./ceremonyTransport.ts), wiring CAP-380's onboarding
 * engine to CAP-381's keep-app device-key ceremony page over the CAP-375/376
 * connection broker (`../../service/brokerClient.ts`).
 *
 * Protocol (mirrors keep-app's `src/lib/flow/deviceKeyWire.ts`, which this
 * file's constants and framing are pinned against):
 *
 *   1. `POST /connections` (purpose `'device-key'`, ttl >= 900s per the
 *      Gate-2 guidance on `brokerClient.ts`) mints a connection and an
 *      ephemeral P-256 keypair — `BrokerClient`'s job, not this file's.
 *   2. The ceremony request — `{v:1, ceremony:'enroll', prfSalt}` or
 *      `{v:1, ceremony:'unlock', candidates}` — rides the URL FRAGMENT
 *      (`#r=<base64url(JSON)>`, keep-app's `ceremonyRequestFragment`
 *      algorithm reproduced here CLI-side), never the broker's own fields:
 *      the fragment never leaves the browser, and nothing in it is trusted
 *      for identity (the page's own session decides who's asking; a
 *      tampered salt just fails closed CLI-side at AEAD unwrap later).
 *   3. The URL (`https://keep.capy.sc/flow/device-key?c=<id>#r=...`) is
 *      printed to stdout — the MCP relay convention, matching
 *      `authService.ts`'s `relayAuthScreenViaKeep` — and the CLI long-polls
 *      for the sealed answer.
 *   4. The opened envelope's plaintext is `{v:1, flow:'device-key',
 *      ceremony:'enroll'|'unlock', ...result}`. The `{v, flow, ceremony}`
 *      framing is validated BEFORE the rest is trusted as the seam's
 *      result — exactly as keep-app's `deviceKeyWire.ts` documents the
 *      pairing (`DeviceKeyAnswerPayload`).
 *
 * PAGE-SIDE CAPS mirrored here CLI-side, checked BEFORE any network call
 * (ceremonyTransport.ts's own mandate, gate-2 MINOR-2): 32 unlock
 * candidates, a 16 KiB fragment, 1400-char credential ids
 * (`keep-app/src/lib/flow/deviceKeyWire.ts`'s `MAX_UNLOCK_CANDIDATES` /
 * `MAX_FRAGMENT_LENGTH` / credential-id cap). These are structural bugs in
 * the caller, not ceremony outcomes a human declined — thrown as coded
 * `CapyError`s rather than folded into the `CeremonyFailure` union, whose
 * fixed vocabulary (cancelled/no_credential/prf_unsupported/
 * webauthn_unavailable/transport_error) has no slot for "the request itself
 * was too big."
 */
import { hostname } from 'os';
import { CapyError, ERROR_CODES } from '../../types/index';
import { BrokerClient, type BrokerConnection } from '../../service/brokerClient';
import { keepOrigin } from '../../ui/screens/keepScreens';
import { openScreen } from '../../ui/openScreen';
import { isInteractive } from '../../ui/interactive';
import type {
  CeremonyFailure,
  CeremonyFailureCode,
  CeremonyTransport,
  EnrollmentRequest,
  EnrollmentSuccess,
  UnlockCandidate,
  UnlockRequest,
  UnlockSuccess,
} from './ceremonyTransport';

/** Mirrors `keep-app/src/lib/flow/deviceKeyWire.ts`'s guardrails (gate-2 MINOR-2). */
export const MAX_UNLOCK_CANDIDATES = 32;
/** 16 KiB — the whole `#r=...` fragment string, matching the page's `hash.length` check. */
export const MAX_FRAGMENT_LENGTH = 16_384;
/** base64url of the WebAuthn spec's 1023-byte credential id cap. */
export const MAX_CREDENTIAL_ID_LENGTH = 1400;

/**
 * Ceremony connections wait on a human touch/approval, not an instant
 * no-submit redirect — the Gate-2 guidance on `brokerClient.ts`:
 * `ttlSeconds` >= 900 (the broker's own max), `deadlineMs` >=
 * `ttlSeconds * 1000`. The 30s margin here keeps the client from giving up
 * a beat before the broker itself would.
 */
export const DEVICE_KEY_TTL_SECONDS = 900;
export const DEVICE_KEY_DEADLINE_MS = DEVICE_KEY_TTL_SECONDS * 1000 + 30_000;

/** One vocabulary across broker purpose, keep-app flow route, and payload `flow` (CAP-376/381 convention). */
const DEVICE_KEY_PURPOSE = 'device-key';
const DEVICE_KEY_FLOW = 'device-key';
const FRAGMENT_KEY = 'r';

type WireRequest =
  | { v: 1; ceremony: 'enroll'; prfSalt: string }
  | { v: 1; ceremony: 'unlock'; candidates: { credentialId: string; prfSalt: string }[] };

const CEREMONY_FAILURE_CODES: readonly CeremonyFailureCode[] = [
  'cancelled',
  'no_credential',
  'prf_unsupported',
  'webauthn_unavailable',
  'transport_error',
];

function isCeremonyFailureCode(value: unknown): value is CeremonyFailureCode {
  return typeof value === 'string' && (CEREMONY_FAILURE_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * base64url(JSON), unpadded — byte-identical to keep-app's
 * `ceremonyRequestFragment` (`btoa` + manual `+`/`/`→`-`/`_` + strip `=`
 * padding transform). Node's `base64url` Buffer encoding already omits
 * padding, so this is a direct algorithmic match, not just an interop test.
 */
function encodeCeremonyFragment(request: WireRequest): string {
  const json = JSON.stringify(request);
  const b64url = Buffer.from(json, 'utf8').toString('base64url');
  return `#${FRAGMENT_KEY}=${b64url}`;
}

function buildDeviceKeyUrl(connectionId: string, fragment: string, origin: string): string {
  const url = new URL(`/flow/${DEVICE_KEY_FLOW}`, origin);
  url.searchParams.set('c', connectionId);
  return `${url.toString()}${fragment}`;
}

/**
 * Print before waiting — the MCP relays what interactive runs print,
 * mirroring authService.ts's relayAuthScreenViaKeep / oauthServer's auth-URL
 * print.
 *
 * Final-gate MAJOR-2: also OPENS the URL, same as every other browser-
 * opening flow in the CLI (`browserWizard.ts` prints and calls
 * `openScreen`; `oauthServer.ts` does the same for the WorkOS sign-in URL).
 * This page is exactly that kind of URL — a real hosted page at
 * keep.capy.sc with its own session, not a CLI-served loopback dialog — so
 * it uses `kind: 'handoff'`, the same choice oauthServer.ts makes and for
 * the same reason (see openScreen.ts's module doc).
 *
 * Gated on `isInteractive()` (`../../ui/interactive.ts`, this repo's
 * standing TTY/agent-detection primitive) rather than opening
 * unconditionally: a real terminal gets a window like every other flow, but
 * the MCP's `capy_sync` spawns this path with piped/non-TTY stdin — exactly
 * the case `isInteractive()` exists to catch — so that caller still only
 * ever gets the printed URL to relay, never a browser this process has no
 * business opening on someone else's machine. `openScreen`'s own
 * `CAPY_WEB_NO_OPEN` check remains underneath as the CI/test backstop.
 */
export function relayUrl(label: string, url: string): void {
  console.log('');
  console.log(`  ${label}`);
  console.log(`  ${url}`);
  console.log('');
  if (isInteractive()) {
    void openScreen(url, { kind: 'handoff' });
  }
}

export interface BrokerCeremonyTransportOptions {
  /** Service base URL (same resolution as ServiceClient/BrokerClient). */
  serviceUrl: string;
  /**
   * Supplies the token the broker's CLI-side create/result verbs send.
   * Org-scoped and the Wave-B org-less (`scope:"user"`) token are both
   * valid — `POST /connections` is org-optional (`BearerUserJWT`, CAP-375
   * Wave-A/B). Case A enrollment (a zero-org identity) deliberately supplies
   * the org-less token here, so the ceremony's connection is itself
   * org-less — a device key is a user-level credential (CAP-380 decision
   * 3), not an org-scoped one, independent of whether an org-scoped token
   * also happens to be available by call time. Every other case supplies
   * the caller's current org-scoped token.
   */
  getToken: () => string | null | Promise<string | null>;
  machineName?: string;
  ttlSeconds?: number;
  deadlineMs?: number;
  /** Test-only override; production default is `keepOrigin()` (CAPY_KEEP_ORIGIN-aware, else keep.capy.sc). */
  originOverride?: string;
}

/**
 * Broker-backed `CeremonyTransport`: relays an enroll/unlock ceremony to
 * keep.capy.sc's `/flow/device-key` page over the connection broker and maps
 * its sealed answer back onto the seam's result types.
 */
export class BrokerCeremonyTransport implements CeremonyTransport {
  private readonly broker: BrokerClient;

  constructor(private readonly options: BrokerCeremonyTransportOptions) {
    this.broker = new BrokerClient(options.serviceUrl, options.getToken);
  }

  async requestEnrollment(req: EnrollmentRequest): Promise<EnrollmentSuccess | CeremonyFailure> {
    const request: WireRequest = { v: 1, ceremony: 'enroll', prfSalt: req.prfSalt };
    const fragment = this.buildFragmentOrThrow(request);
    return this.run('enroll', fragment, (payload) => this.toEnrollmentResult(payload));
  }

  async requestUnlock(req: UnlockRequest): Promise<UnlockSuccess | CeremonyFailure> {
    this.assertCandidateCaps(req.candidates);
    const request: WireRequest = {
      v: 1,
      ceremony: 'unlock',
      candidates: req.candidates.map((c) => ({ credentialId: c.credentialId, prfSalt: c.prfSalt })),
    };
    const fragment = this.buildFragmentOrThrow(request);
    return this.run('unlock', fragment, (payload) => this.toUnlockResult(payload));
  }

  // ---- page-side caps, mirrored CLI-side and checked before any network call ----

  private assertCandidateCaps(candidates: UnlockCandidate[]): void {
    if (candidates.length > MAX_UNLOCK_CANDIDATES) {
      throw new CapyError(
        `Too many device keys to unlock at once (${candidates.length} > ${MAX_UNLOCK_CANDIDATES}). ` +
          'The ceremony page enforces this cap; refusing to send an oversized request rather than ' +
          'let it fail unattached on the other end.',
        ERROR_CODES.DEVICE_KEY_TOO_MANY_CANDIDATES,
        { count: candidates.length, max: MAX_UNLOCK_CANDIDATES },
      );
    }
    for (const candidate of candidates) {
      if (candidate.credentialId.length > MAX_CREDENTIAL_ID_LENGTH) {
        throw new CapyError(
          `A device-key credential id is longer than the ceremony page accepts ` +
            `(${candidate.credentialId.length} > ${MAX_CREDENTIAL_ID_LENGTH} chars).`,
          ERROR_CODES.DEVICE_KEY_CREDENTIAL_ID_TOO_LONG,
          { length: candidate.credentialId.length, max: MAX_CREDENTIAL_ID_LENGTH },
        );
      }
    }
  }

  private buildFragmentOrThrow(request: WireRequest): string {
    const fragment = encodeCeremonyFragment(request);
    if (fragment.length > MAX_FRAGMENT_LENGTH) {
      throw new CapyError(
        `The device-key ceremony request is too large for the broker fragment ` +
          `(${fragment.length} > ${MAX_FRAGMENT_LENGTH} bytes).`,
        ERROR_CODES.DEVICE_KEY_FRAGMENT_TOO_LARGE,
        { length: fragment.length, max: MAX_FRAGMENT_LENGTH },
      );
    }
    return fragment;
  }

  // ---- shared connection / long-poll / framing-validation plumbing ----

  private async run<T extends { ok: true }>(
    ceremony: 'enroll' | 'unlock',
    fragment: string,
    mapSuccess: (payload: Record<string, unknown>) => T | null,
  ): Promise<T | CeremonyFailure> {
    let connection: BrokerConnection;
    try {
      connection = await this.broker.createConnection({
        purpose: DEVICE_KEY_PURPOSE,
        machineName: this.options.machineName ?? hostname(),
        ttlSeconds: this.options.ttlSeconds ?? DEVICE_KEY_TTL_SECONDS,
      });
    } catch {
      // Coded CapyError from BrokerClient (network/service/auth) — a
      // transport-level breakage the seam has a code for. Mirrors
      // relayAuthScreenViaKeep's "nothing branches on which failure".
      return { ok: false, code: 'transport_error' };
    }

    const origin = this.options.originOverride ?? keepOrigin();
    const url = buildDeviceKeyUrl(connection.connectionId, fragment, origin);
    relayUrl(ceremony === 'enroll' ? 'Set up your device key:' : 'Unlock with your device key:', url);

    const ack = await this.broker.awaitAnswer(connection, {
      deadlineMs: this.options.deadlineMs ?? DEVICE_KEY_DEADLINE_MS,
    });
    if (ack.kind !== 'answered') {
      // expired / consumed / timeout / network / service / bad_envelope all
      // collapse to transport_error — the seam has no vocabulary for any of
      // these page-unreachable breakages (ceremonyTransport.ts header doc).
      return { ok: false, code: 'transport_error' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(ack.plaintext);
    } catch {
      return { ok: false, code: 'transport_error' };
    }
    if (!isRecord(parsed)) return { ok: false, code: 'transport_error' };

    // Validate the {v, flow, ceremony} framing BEFORE stripping/trusting the
    // rest, exactly as keep-app's deviceKeyWire.ts documents the pairing —
    // a malformed or foreign envelope must never be read as a real result.
    if (parsed.v !== 1 || parsed.flow !== DEVICE_KEY_FLOW || parsed.ceremony !== ceremony) {
      return { ok: false, code: 'transport_error' };
    }

    if (parsed.ok === false) {
      return isCeremonyFailureCode(parsed.code) ? { ok: false, code: parsed.code } : { ok: false, code: 'transport_error' };
    }
    if (parsed.ok !== true) return { ok: false, code: 'transport_error' };

    const result = mapSuccess(parsed);
    return result ?? { ok: false, code: 'transport_error' };
  }

  private toEnrollmentResult(payload: Record<string, unknown>): EnrollmentSuccess | null {
    const { credentialId, prfOutput, backupEligible, backupState } = payload;
    if (
      typeof credentialId !== 'string' ||
      typeof prfOutput !== 'string' ||
      typeof backupEligible !== 'boolean' ||
      typeof backupState !== 'boolean'
    ) {
      return null;
    }
    return { ok: true, credentialId, prfOutput, backupEligible, backupState };
  }

  private toUnlockResult(payload: Record<string, unknown>): UnlockSuccess | null {
    const { credentialId, prfOutput } = payload;
    if (typeof credentialId !== 'string' || typeof prfOutput !== 'string') return null;
    return { ok: true, credentialId, prfOutput };
  }
}
