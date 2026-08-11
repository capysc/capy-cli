/**
 * CAP-383 — plays the "mocked broker + page" role the ticket asks for: acts
 * as keep-app's `/flow/device-key` page against `BrokerCeremonyTransport`
 * (CAP-382's real transport, unmodified), with REAL envelope crypto
 * (`tests/helpers/sealEnvelope.ts`, WebCrypto, the exact page-side algorithm
 * `deviceKeyWire.ts` documents) — only the human/authenticator decision is
 * scripted.
 *
 * The ceremony REQUEST (enroll vs unlock, prfSalt / candidates) rides the
 * URL fragment, which by design never reaches the server — so, like a real
 * browser, this "page" only learns it by reading the relayed URL, captured
 * the same way `tests/auth/deviceKey/brokerCeremonyTransport.test.ts` does
 * (a `console.log` spy for the duration of the call).
 */
import { randomBytes } from 'crypto';
import { sealEnvelopePageSide } from './sealEnvelope';
import type { FakeWrapperService } from './fakeWrapperService';

type WireRequest =
  | { v: 1; ceremony: 'enroll'; prfSalt: string }
  | { v: 1; ceremony: 'unlock'; candidates: { credentialId: string; prfSalt: string }[] }
  /** CAP-384: same shape as 'unlock' — a grant runs the identical WebAuthn
   *  ceremony, just framed differently on the wire (see brokerCeremonyTransport.ts). */
  | { v: 1; ceremony: 'grant'; candidates: { credentialId: string; prfSalt: string }[] };

/** One physical authenticator, reusable across "machines" (separate homedirs/processes) — same object, same PRF map, simulating the same hardware key. */
export class SharedAuthenticator {
  private prf = new Map<string, Buffer>();
  constructor(public credentialId: string = 'cred-e2e-1') {}

  enrollResponse(prfSalt: string, opts: { backupEligible?: boolean; backupState?: boolean } = {}) {
    const output = randomBytes(32);
    this.prf.set(`${this.credentialId}:${prfSalt}`, output);
    return {
      ok: true,
      credentialId: this.credentialId,
      prfOutput: output.toString('base64'),
      backupEligible: opts.backupEligible ?? true,
      backupState: opts.backupState ?? true,
    };
  }

  unlockResponse(candidates: Array<{ credentialId: string; prfSalt: string }>) {
    for (const c of candidates) {
      const output = this.prf.get(`${c.credentialId}:${c.prfSalt}`);
      if (output) return { ok: true, credentialId: c.credentialId, prfOutput: output.toString('base64') };
    }
    return { ok: false, code: 'no_credential' as const };
  }
}

function decodeFragment(url: string): WireRequest {
  const hashIdx = url.indexOf('#r=');
  if (hashIdx === -1) throw new Error(`driveCeremony: no #r= fragment in relayed URL: ${url}`);
  const b64url = url.slice(hashIdx + 3);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function connectionIdFromUrl(url: string): string {
  const u = new URL(url.trim());
  const id = u.searchParams.get('c');
  if (!id) throw new Error(`driveCeremony: no ?c= connection id in relayed URL: ${url}`);
  return id;
}

/**
 * Runs `fn()` (which somewhere inside constructs a `BrokerCeremonyTransport`
 * pointed at `service.url` and calls requestEnrollment/requestUnlock) while
 * playing the page: captures the relayed URL, decodes the ceremony request,
 * asks `respond` for a plaintext answer body, seals it with real WebCrypto,
 * and delivers it through the fake broker's result queue.
 */
export async function driveCeremony<T>(
  service: FakeWrapperService,
  respond: (request: WireRequest) => Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalLog = console.log;
  let capturedUrl: string | undefined;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('/flow/device-key')) capturedUrl = line.trim();
  };

  try {
    const resultPromise = fn();

    const urlDeadline = Date.now() + 5000;
    while (!capturedUrl && Date.now() < urlDeadline) {
      await Bun.sleep(10);
    }
    if (!capturedUrl) {
      // Nothing was relayed — most likely the ceremony never actually ran
      // (e.g. caps rejected the request before any network call). Let the
      // real call finish so its own error surfaces instead of masking it.
      return await resultPromise;
    }

    const connectionId = connectionIdFromUrl(capturedUrl);
    const request = decodeFragment(capturedUrl);

    let conn = service.connections.get(connectionId);
    const connDeadline = Date.now() + 5000;
    while (!conn && Date.now() < connDeadline) {
      await Bun.sleep(10);
      conn = service.connections.get(connectionId);
    }
    if (!conn) throw new Error(`driveCeremony: connection ${connectionId} never registered with the fake broker`);

    const answerPayload = { v: 1, flow: 'device-key', ceremony: request.ceremony, ...respond(request) };
    const sealed = await sealEnvelopePageSide({
      plaintext: JSON.stringify(answerPayload),
      connectionId,
      clientPubkeyB64: conn.clientPubkeyB64,
    });
    conn.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });

    return await resultPromise;
  } finally {
    console.log = originalLog;
  }
}
