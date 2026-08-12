/**
 * CAP-409 — `capy pair`'s ceremony orchestration: mint the ephemeral
 * keypair, bootstrap the anonymous connection, hand the caller the user_code
 * to display, then long-poll until answered or the connection's own
 * `expires_at` passes.
 *
 * Mirrors `PairingBrokerClient`'s discipline (never throws mid-poll; every
 * ending is a typed variant) and `BrokerCeremonyTransport.run()`'s framing
 * validation (a malformed/foreign/wrong-key envelope collapses to
 * `transport_error`, never a partial success — see pairContract.ts).
 */
import { hostname } from 'os';
import { PairingBrokerClient } from './pairingBrokerClient';
import { parsePairPayload, PairMachineAnswer, PAIR_PURPOSE } from './pairContract';
import type { CeremonyFailureCode } from '../deviceKey/ceremonyTransport';

/**
 * Ceremony connections wait on a human finding a second device, signing in,
 * and transcribing a code — not an instant redirect. Matches
 * `DEVICE_KEY_TTL_SECONDS`'s reasoning (brokerCeremonyTransport.ts) and the
 * broker's own 900s cap (CAP-375's TTL ceiling).
 */
export const PAIR_TTL_SECONDS = 900;
/** openapi's `wait_seconds` max — matches `BrokerClient`'s `DEFAULT_WAIT_SECONDS`. */
const POLL_WAIT_SECONDS = 25;
/** Gap between `pending` polls — matches `BrokerClient`'s `DEFAULT_POLL_GAP_MS`.
 *  A real server long-polls for the full `wait_seconds` before answering
 *  `pending`, so this is a backstop against busy-looping a fast/naive stub,
 *  not the primary wait mechanism. */
const PENDING_POLL_GAP_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PairCeremonyOutcome =
  | { kind: 'answered'; answer: PairMachineAnswer; userCode: string }
  | { kind: 'failure'; code: CeremonyFailureCode; userCode: string }
  | { kind: 'expired'; userCode: string };

export interface PairCeremonyOptions {
  serviceUrl: string;
  machineName?: string;
  ttlSeconds?: number;
  /** Called exactly once, the instant the connection is minted — the caller
   *  prints the RFC-8628-style block right away (spec §5: the code is a
   *  claim ticket, safe to print unconditionally, no TTY-gating). */
  onCodeReady: (userCode: string) => void;
}

/**
 * Run the full ceremony. Throws only if the initial bootstrap call itself
 * fails (network/service error, before any code was ever shown — nothing to
 * report as "expired" or "declined" yet). Every ending AFTER a code was
 * shown is a typed `PairCeremonyOutcome`, never a throw.
 */
export async function runPairCeremony(opts: PairCeremonyOptions): Promise<PairCeremonyOutcome> {
  const client = new PairingBrokerClient(opts.serviceUrl);
  const bootstrap = await client.bootstrap({
    purpose: PAIR_PURPOSE,
    machineName: opts.machineName ?? hostname(),
    ttlSeconds: opts.ttlSeconds ?? PAIR_TTL_SECONDS,
  });

  opts.onCodeReady(bootstrap.userCode);

  while (Date.now() < bootstrap.expiresAtMs) {
    const remainingMs = bootstrap.expiresAtMs - Date.now();
    const waitSeconds = Math.max(1, Math.min(POLL_WAIT_SECONDS, Math.ceil(remainingMs / 1000)));
    const result = await client.pollOnce(bootstrap, waitSeconds);

    switch (result.kind) {
      case 'pending':
        if (Date.now() < bootstrap.expiresAtMs) await sleep(PENDING_POLL_GAP_MS);
        continue;
      case 'answered': {
        const parsed = parsePairPayload(result.plaintext);
        if (parsed.kind === 'answer') {
          return { kind: 'answered', answer: parsed.answer, userCode: bootstrap.userCode };
        }
        if (parsed.kind === 'failure') {
          return { kind: 'failure', code: parsed.code, userCode: bootstrap.userCode };
        }
        // Malformed/foreign plaintext — fail closed, never accept as a
        // partial result. Same bucket transport_error already covers for
        // every other unreachable/untrustworthy broker outcome.
        return { kind: 'failure', code: 'transport_error', userCode: bootstrap.userCode };
      }
      case 'bad_envelope':
        // AEAD open failed — wrong key, wrong connection binding, or
        // tampered bytes. Fail closed; never treated as key material.
        return { kind: 'failure', code: 'transport_error', userCode: bootstrap.userCode };
      case 'expired':
        return { kind: 'expired', userCode: bootstrap.userCode };
      case 'consumed':
      case 'network':
      case 'service':
        return { kind: 'failure', code: 'transport_error', userCode: bootstrap.userCode };
    }
  }

  // Our own clock reached the connection's expires_at with no answer ever
  // delivered — best-effort cancel so the broker sees a dead link rather
  // than a silent void, same posture as BrokerClient.awaitAnswer's timeout.
  await client.cancel(bootstrap);
  return { kind: 'expired', userCode: bootstrap.userCode };
}
