/**
 * `watchForRedemption` (src/commands/transportCommand.ts, CAP-692
 * follow-up) — the glue between the pure poll loop (transportPoll.ts,
 * tested on its own) and a prompt/view handle (`{done, stop}`, either the
 * masked-link prompt's or the full-screen view's). A fake handle + a fake
 * `serviceClient.getTransportStatus` drive every outcome with no real
 * TTY or network calls. `watchForRedemption` builds its own real
 * `setTimeout`-based `sleep(5000)` internally for the "keep waiting"
 * step — these tests never actually reach that wait: `redeemed`/`expired`
 * settle on the very first tick, and the "user quits" case resolves the
 * handle's `done` (which `pollTransportRedemption` races ahead of the
 * sleep) within a couple of microtask ticks, long before any real 5s
 * timer could fire.
 */
import { describe, test, expect, mock } from 'bun:test';
import { watchForRedemption } from '../../src/commands/transportCommand';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import type { TransportStatusResult } from '../../src/service/serviceClient';

/**
 * A `{done, stop}` handle whose `done` resolves only when `close()` is
 * called — stands in for either the masked-link prompt's or the
 * full-screen view's handle. Built with `Promise.withResolvers()` so
 * there is no mutable binding of our own to hold the resolver — and
 * `stop` is a `mock()` so call counts are read from ITS OWN call log,
 * never an accumulator this file owns.
 */
function fakeHandle(): { done: Promise<void>; stop: ReturnType<typeof mock>; close: () => void } {
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const stop = mock(() => resolve());
  return { done, stop, close: () => resolve() };
}

describe('watchForRedemption', () => {
  test('redeemed: calls stop(), prints the done message, returns normally (no quit-by-user)', async () => {
    const handle = fakeHandle();
    const getTransportStatus = mock(async (): Promise<TransportStatusResult> => ({ kind: 'redeemed' }));
    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy as any;
    try {
      const result = await watchForRedemption({
        serviceClient: { getTransportStatus },
        id: 'transport-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        handle,
        awaitStop: false,
      });
      expect(result).toBeUndefined();
      expect(handle.stop).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Activated'))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test('expired: calls stop() and throws a coded TRANSPORT_EXPIRED CapyError', async () => {
    const handle = fakeHandle();
    const getTransportStatus = mock(async (): Promise<TransportStatusResult> => ({ kind: 'expired' }));

    try {
      await watchForRedemption({
        serviceClient: { getTransportStatus },
        id: 'transport-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        handle,
        awaitStop: false,
      });
      throw new Error('expected watchForRedemption to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CapyError);
      expect(err.code).toBe(ERROR_CODES.TRANSPORT_EXPIRED);
    }
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  test('unknown, then the handle closes on its own (user pressed q): returns quit-by-user, never calls stop() itself', async () => {
    const handle = fakeHandle();
    const getTransportStatus = mock(async (): Promise<TransportStatusResult> => ({ kind: 'unknown' }));

    const pending = watchForRedemption({
      serviceClient: { getTransportStatus },
      id: 'transport-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      handle,
      awaitStop: false,
    });

    // Let a couple of unknown ticks happen, then simulate the user
    // pressing q (the handle resolves `done` on its own — same as a real
    // masked-link-prompt/full-screen `stop()` reaction to a keypress).
    await Promise.resolve();
    await Promise.resolve();
    handle.close();

    const result = await pending;
    expect(result).toBe('quit-by-user');
    expect(handle.stop).not.toHaveBeenCalled();
  });

  test('awaitStop true (full-screen) and false (plain prompt) both call stop() exactly once on redemption', async () => {
    const handleTrue = fakeHandle();
    const getTransportStatusTrue = mock(async (): Promise<TransportStatusResult> => ({ kind: 'redeemed' }));
    await watchForRedemption({
      serviceClient: { getTransportStatus: getTransportStatusTrue },
      id: 't',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      handle: handleTrue,
      awaitStop: true,
    });
    expect(handleTrue.stop).toHaveBeenCalledTimes(1);

    const handleFalse = fakeHandle();
    const getTransportStatusFalse = mock(async (): Promise<TransportStatusResult> => ({ kind: 'redeemed' }));
    await watchForRedemption({
      serviceClient: { getTransportStatus: getTransportStatusFalse },
      id: 't',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      handle: handleFalse,
      awaitStop: false,
    });
    expect(handleFalse.stop).toHaveBeenCalledTimes(1);
  });

  test('local expiry still checks the server one more time first (same property as the pure poll loop)', async () => {
    const handle = fakeHandle();
    const getTransportStatus = mock(async (): Promise<TransportStatusResult> => ({ kind: 'redeemed' }));

    const result = await watchForRedemption({
      serviceClient: { getTransportStatus },
      id: 'transport-1',
      expiresAt: new Date(Date.now() - 1).toISOString(), // already in the past
      handle,
      awaitStop: false,
    });

    expect(result).toBeUndefined(); // redeemed, not expired, despite the past expiresAt
    expect(getTransportStatus).toHaveBeenCalledTimes(1);
  });
});
