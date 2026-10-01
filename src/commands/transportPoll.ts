/**
 * `capy transport`'s redemption poll (CAP-692 follow-up): while the
 * QR/link is shown interactively, poll `GET /transports/:id`
 * (`serviceClient.getTransportStatus`) every 2s so the command can quit on
 * its own once the link is activated elsewhere, instead of sitting there
 * after the job is already done.
 *
 * Pure and injectable — `getStatus`/`now`/`sleep` are all passed in, so
 * tests drive the whole state machine with a fake clock and no real
 * timers or network calls (see tests/commands/transportPoll.test.ts).
 *
 * `stopSignal` is whatever makes the surrounding prompt/view close for a
 * reason OTHER than redemption/expiry — in production, the masked-link
 * prompt's or full-screen view's own `done` promise, which resolves when
 * the user presses q (see `maskedLinkPrompt.ts` / `fullScreenQr.ts`). Once
 * it resolves, EVERY subsequent step of the loop (the next status check,
 * the next sleep) resolves immediately to `'stopped'` instead of actually
 * waiting — no further polling after the prompt is gone, and no overlap
 * (never two outstanding `getStatus` calls at once: every iteration fully
 * awaits one call, then sleeps, then recurses).
 */
import type { TransportStatusResult } from '../service/serviceClient';

export type TransportPollOutcome = 'redeemed' | 'expired';

export interface PollTransportRedemptionOptions {
  readonly getStatus: () => Promise<TransportStatusResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalMs: number;
  /** Resolves once polling should stop for a reason other than redemption/expiry (e.g. the user pressed q). */
  readonly stopSignal: Promise<void>;
  /**
   * Local deadline, epoch ms (typically `Date.parse(expires_at)`) — once
   * `now()` passes it the loop reports `'expired'`, same as the spec's
   * "or local time passes expires_at". It never skips straight to that
   * verdict, though: every tick checks the server first regardless of the
   * local clock, so an activation in the last few seconds before the
   * deadline still reports as `'redeemed'` — the local check only wins
   * when that same tick's server answer was NOT `'redeemed'`.
   */
  readonly localExpiresAtMs?: number;
  readonly now: () => number;
}

type StepResult = TransportPollOutcome | 'stopped' | 'continue';

async function step(opts: PollTransportRedemptionOptions): Promise<StepResult> {
  // `stopSignal` races FIRST in both `Promise.race` calls below: when both
  // operands are already settled (as they are in a test with a mocked,
  // instantly-resolving `getStatus`/`sleep` AND an already-resolved
  // `stopSignal`), `Promise.race` breaks the tie in favor of whichever
  // operand's `.then()` was attached first — so listing `stopSignal`
  // first means an already-closed prompt always wins a tie, rather than
  // the loop re-checking status/re-sleeping forever because a mocked
  // dependency "wins" every tie by construction order. A stopSignal that
  // is still genuinely pending is unaffected either way — the real
  // winner is whichever promise actually settles first in wall-clock time.
  const stopOrStatus = await Promise.race([
    opts.stopSignal.then((): 'stopped' => 'stopped'),
    opts.getStatus().then((status): TransportStatusResult | 'stopped' => status),
  ]);
  if (stopOrStatus === 'stopped') return 'stopped';
  if (stopOrStatus.kind === 'redeemed') return 'redeemed';
  if (stopOrStatus.kind === 'expired') return 'expired';
  if (opts.localExpiresAtMs !== undefined && opts.now() >= opts.localExpiresAtMs) return 'expired';
  // 'pending' and 'unknown' (which also covers a 429 from the service's
  // mutation limiter — a non-decisive answer, not a verdict) both just
  // mean "keep waiting silently".

  const stopOrSlept = await Promise.race([
    opts.stopSignal.then((): 'stopped' => 'stopped'),
    opts.sleep(opts.intervalMs).then((): 'continue' => 'continue'),
  ]);
  return stopOrSlept;
}

/**
 * Polls until `'redeemed'`/`'expired'` (local or server-reported), or
 * until `stopSignal` wins the race first (returns `null` — the caller
 * closed the prompt for its own reason, e.g. the user pressed q).
 */
export async function pollTransportRedemption(opts: PollTransportRedemptionOptions): Promise<TransportPollOutcome | null> {
  const result = await step(opts);
  if (result === 'stopped') return null;
  if (result === 'continue') return pollTransportRedemption(opts);
  return result;
}
