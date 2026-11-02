/**
 * Bounded retry with backoff, for calls a rate limit rejected (HTTP 429, GitHub's
 * secondary limits). The CALLER decides, from a status code or a structured header
 * and never from message text, whether a result is "rate limited" and how long the
 * server asked it to wait; this module only does the waiting and the counting.
 *
 *  - at most `RETRY_MAX_ATTEMPTS` attempts in all (so three retries);
 *  - the server's own wait (`Retry-After` / `RateLimit-Reset`) when it sent one,
 *    else exponential: 2s, 4s, 8s;
 *  - no single wait is longer than `BACKOFF_CAP_MS`;
 *  - a stop request ends the waiting early and gives up with the last answer.
 */
export const RETRY_MAX_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_CAP_MS = 60_000;

/** Waits `ms` (or until `signal` aborts, whichever is first). Injectable so tests never really wait. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** How long to wait before attempt `attemptNo + 1`: the server's hint when there is one, else 2s, 4s, 8s; never over the cap. */
export function retryDelayMs(attemptNo: number, hintMs?: number): number {
  const wanted = hintMs === undefined ? BASE_FOR(attemptNo) : Math.max(0, hintMs);
  return Math.min(BACKOFF_CAP_MS, wanted);
}

const BASE_FOR = (attemptNo: number): number => BACKOFF_BASE_MS * 2 ** (attemptNo - 1);

/** What `retrying` needs to know about an answer that was rate limited. */
export interface RetryHint {
  /** The wait the server asked for, in ms. */
  readonly afterMs?: number;
}

/**
 * Runs `attempt`; while `hint(result)` says it was rate limited, waits and runs it
 * again, up to `RETRY_MAX_ATTEMPTS` attempts. Returns the last answer (still rate
 * limited if the attempts ran out, or if `stop` says to give up).
 */
export async function retrying<T>(
  attempt: () => Promise<T>,
  hint: (result: T) => RetryHint | undefined,
  sleep: Sleep = realSleep,
  stop?: AbortSignal,
  attemptNo: number = 1,
): Promise<T> {
  const stopped = (): boolean => stop?.aborted === true;
  const result = await attempt();
  const h = hint(result);
  if (h === undefined || attemptNo >= RETRY_MAX_ATTEMPTS || stopped()) return result;
  await sleep(retryDelayMs(attemptNo, h.afterMs), stop);
  return stopped() ? result : retrying(attempt, hint, sleep, stop, attemptNo + 1);
}
