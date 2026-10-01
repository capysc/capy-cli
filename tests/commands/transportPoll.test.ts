/**
 * `src/commands/transportPoll.ts` (CAP-692 follow-up) — the pure,
 * injectable redemption poll loop. A fake clock (`now`), a no-op `sleep`
 * (resolves immediately — these tests don't need to wait for real time),
 * and a scripted `getStatus` drive every branch with no real timers or
 * network calls.
 */
import { describe, test, expect, mock } from 'bun:test';
import { pollTransportRedemption } from '../../src/commands/transportPoll';
import type { TransportStatusResult } from '../../src/service/serviceClient';

/** Never resolves on its own — a stand-in for the prompt/view's `done` when the test wants the loop to run until `getStatus` settles it. */
function neverStop(): Promise<void> {
  return new Promise<void>(() => {});
}

/** A `stopSignal` resolved right away — simulates "the user already pressed q before the next tick". */
function alreadyStopped(): Promise<void> {
  return Promise.resolve();
}

const noopSleep = async (_ms: number): Promise<void> => {};

describe('pollTransportRedemption', () => {
  test('pending, then pending again, then redeemed: outcome is redeemed, getStatus called for every tick', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>()
      .mockResolvedValueOnce({ kind: 'pending', expiresAt: '2026-10-01T00:00:00.000Z' })
      .mockResolvedValueOnce({ kind: 'pending', expiresAt: '2026-10-01T00:00:00.000Z' })
      .mockResolvedValueOnce({ kind: 'redeemed' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: neverStop(),
      now: () => 0,
    });

    expect(outcome).toBe('redeemed');
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  test('the server reports expired: outcome is expired', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockResolvedValue({ kind: 'expired' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: neverStop(),
      now: () => 0,
    });

    expect(outcome).toBe('expired');
  });

  test('unknown (e.g. a 429 from the mutation limiter) keeps the loop going — never mistaken for redeemed', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>()
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'redeemed' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: neverStop(),
      now: () => 0,
    });

    expect(outcome).toBe('redeemed');
    expect(getStatus).toHaveBeenCalledTimes(4);
  });

  test('unknown forever just keeps waiting until the stop signal wins — resolves null, not expired or redeemed', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockResolvedValue({ kind: 'unknown' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: alreadyStopped(),
      now: () => 0,
    });

    expect(outcome).toBeNull();
  });

  test('the stop signal (user pressed q) wins before any status settles: resolves null', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockImplementation(
      () => new Promise<TransportStatusResult>(() => {}), // never resolves
    );

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: alreadyStopped(),
      now: () => 0,
    });

    expect(outcome).toBeNull();
  });

  test('polling makes no further getStatus calls once stopped (no overlap, no calls after exit)', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockResolvedValue({ kind: 'pending', expiresAt: 'x' });
    // Resolves once getStatus has been called twice — reads the mock's own
    // call log (its library-owned mutable state) rather than a binding of
    // ours, so this needs no `let`/manual resolve of its own.
    const stopAfterTwoCalls = async (): Promise<void> => {
      while (getStatus.mock.calls.length < 2) {
        await Promise.resolve();
      }
    };

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: stopAfterTwoCalls(),
      now: () => 0,
    });
    const callsAtStop = getStatus.mock.calls.length;

    expect(outcome).toBeNull();
    // Give any wrongly-still-running recursion a few microtask turns to
    // prove it does NOT make another call after the stop signal fired.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getStatus.mock.calls.length).toBe(callsAtStop);
  });

  test('local expiry: a server answer that is neither redeemed nor expired, past the local deadline, reports expired', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockResolvedValue({ kind: 'pending', expiresAt: 'x' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: neverStop(),
      now: () => 10_000, // already past localExpiresAtMs below
      localExpiresAtMs: 5_000,
    });

    expect(outcome).toBe('expired');
  });

  test('local expiry still checks the server ONE more time first — a redemption in the last few seconds still reports redeemed, not expired', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>().mockResolvedValue({ kind: 'redeemed' });

    const outcome = await pollTransportRedemption({
      getStatus,
      sleep: noopSleep,
      intervalMs: 5000,
      stopSignal: neverStop(),
      now: () => 10_000, // already past the local deadline
      localExpiresAtMs: 5_000,
    });

    expect(outcome).toBe('redeemed');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  test('sleeps between ticks using the injected interval', async () => {
    const getStatus = mock<() => Promise<TransportStatusResult>>()
      .mockResolvedValueOnce({ kind: 'pending', expiresAt: 'x' })
      .mockResolvedValueOnce({ kind: 'redeemed' });
    const sleep = mock(async (_ms: number) => {});

    await pollTransportRedemption({ getStatus, sleep, intervalMs: 5000, stopSignal: neverStop(), now: () => 0 });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});
