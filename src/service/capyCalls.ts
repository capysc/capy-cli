/**
 * Calls to the Capy service that run in bulk (`capy secrets`): each one reports the
 * rate-limit reading it saw (`RateLimit-Remaining` / `RateLimit-Reset`, surfaced by
 * `ServiceClient` as a structured `RateInfo`), and one the service refused with 429
 * is tried again after the wait it asked for (else 2s, 4s, 8s), up to
 * `RETRY_MAX_ATTEMPTS` attempts. A 429 is recognised by its code (`RATE_LIMITED`),
 * never by its message. A request the service rejected did not happen, so repeating
 * even a write is safe.
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { RetryHint, Sleep, realSleep, retrying } from '../utils/backoff';
import type { RateInfo } from '../utils/pool';

/** A call that never throws: its value or its error, and the last rate-limit reading it saw. */
export type Called<T> =
  | { readonly ok: true; readonly value: T; readonly rate?: RateInfo }
  | { readonly ok: false; readonly error: unknown; readonly rate?: RateInfo };

/**
 * Runs `call`, handing it a callback the service client reports each response's
 * rate-limit reading to. Resolves with the call's outcome and the first reading.
 */
export function observed<T>(call: (onRate: (rate: RateInfo) => void) => Promise<T>): Promise<Called<T>> {
  return new Promise<Called<T>>((resolveCalled) => {
    // The readings arrive before the call settles. `rate` settles on the first reading, or `undefined` once the call is over.
    const rate: Promise<RateInfo | undefined> = new Promise<RateInfo | undefined>((resolveRate) => {
      void (async () => call(resolveRate))().then(
        (value) => {
          resolveRate(undefined);
          void rate.then((r) => resolveCalled({ ok: true, value, ...(r === undefined ? {} : { rate: r }) }));
        },
        (error: unknown) => {
          resolveRate(undefined);
          void rate.then((r) => resolveCalled({ ok: false, error, ...(r === undefined ? {} : { rate: r }) }));
        },
      );
    });
  });
}

/** The wait a 429 asked for, from its structured details (never from its message). */
export function rateLimitHint(error: unknown): RetryHint | undefined {
  if (!(error instanceof CapyError) || error.code !== ERROR_CODES.RATE_LIMITED) return undefined;
  const afterMs: unknown = error.details?.retry_after_ms;
  return typeof afterMs === 'number' ? { afterMs } : {};
}

/** `observed`, with a 429 tried again (bounded). The last answer is returned, still a 429 if the attempts ran out. */
export function callWithBackoff<T>(
  call: (onRate: (rate: RateInfo) => void) => Promise<T>,
  sleep: Sleep = realSleep,
): Promise<Called<T>> {
  return retrying(
    () => observed(call),
    (result) => (result.ok ? undefined : rateLimitHint(result.error)),
    sleep,
  );
}

/** The same for a caller that wants the plain value or the thrown error (the unlock). */
export async function retryOnRateLimit<T>(call: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  const answer = await callWithBackoff(() => call(), sleep);
  if (answer.ok) return answer.value;
  throw answer.error;
}
