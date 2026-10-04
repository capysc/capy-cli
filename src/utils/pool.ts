/**
 * A bounded worker pool for the `capy secrets` runs: `limit` items at a time,
 * never more, with a stop that lets EVERY item already running finish and starts
 * no new one, and optional pacing from the service's `RateLimit-Remaining` /
 * `RateLimit-Reset` headers.
 *
 * Written without a mutable binding: the scheduler is a recursion over an
 * immutable state (the next index, the items in flight, the results so far, the
 * last rate-limit reading), so nothing here is shared between the items.
 *
 *  - Items start in input order. Results come back in INPUT order, whatever order
 *    they finished in.
 *  - A stop (`stop` aborts) starts nothing further; the items in flight finish.
 *    `cancelled` is exactly the items that were never started.
 *  - Pacing: when an item reports `remaining <= reserve` for a window that has not
 *    reset yet, no new item starts until that reset. Items already running finish.
 *  - `run` must not reject: an item reports its own failure in its result.
 */
import { BACKOFF_CAP_MS, Sleep, realSleep } from './backoff';

/** What a rate-limited endpoint said it has left: how many calls, and when (epoch ms) the window resets. */
export interface RateInfo {
  readonly remaining: number;
  readonly resetAt: number;
}

/** Stop starting new items when this few calls (or fewer) are left in the window. */
export const PACING_RESERVE = 5;

/** What one item hands back: its result, and the last rate-limit reading it saw (if any). */
export interface PoolItem<R> {
  readonly result: R;
  readonly rate?: RateInfo;
}

export interface PoolProgress {
  readonly done: number;
  readonly inFlight: number;
  readonly total: number;
}

export interface PoolOptions<T, R> {
  readonly items: readonly T[];
  /** At most this many items run at once. */
  readonly limit: number;
  readonly run: (item: T, index: number) => Promise<PoolItem<R>>;
  readonly stop?: AbortSignal;
  /** Pace new starts off the rate-limit readings; absent: no pacing. */
  readonly reserve?: number;
  readonly now?: () => number;
  readonly sleep?: Sleep;
  /** At the start, whenever an item finishes, and when a stop is noticed. */
  readonly onChange?: (progress: PoolProgress) => void;
  /** Once, when a stop is noticed while items are still running: how many will be waited for. */
  readonly onStopping?: (inFlight: number) => void;
}

export interface PoolResult<T, R> {
  /** The results of the items that were started, in input order. */
  readonly results: readonly R[];
  /** The items never started, in input order. */
  readonly cancelled: readonly T[];
}

/** Of two readings, the one that leaves less room (a reading whose window has already reset is dropped). */
export function mergeRates(a: RateInfo | undefined, b: RateInfo | undefined, now: number): RateInfo | undefined {
  const live = [a, b].filter((r): r is RateInfo => r !== undefined && r.resetAt > now);
  return live.length === 0 ? undefined : live.reduce((low, r) => (r.remaining < low.remaining ? r : low));
}

/** How long to hold back new starts for `rate`: until its window resets, once it is down to `reserve`. */
export function paceWaitMs(rate: RateInfo | undefined, now: number, reserve: number | undefined): number {
  if (rate === undefined || reserve === undefined || rate.remaining > reserve || rate.resetAt <= now) return 0;
  return Math.min(BACKOFF_CAP_MS, rate.resetAt - now);
}

type Wake<R> =
  | { readonly kind: 'settled'; readonly index: number; readonly item: PoolItem<R> }
  | { readonly kind: 'stop' }
  | { readonly kind: 'timer' };

interface State<R> {
  readonly next: number;
  readonly flying: ReadonlyMap<number, Promise<Wake<R>>>;
  readonly done: ReadonlyMap<number, R>;
  readonly pace: RateInfo | undefined;
  readonly announced: boolean;
}

export async function runPool<T, R>(opts: PoolOptions<T, R>): Promise<PoolResult<T, R>> {
  const { items, limit, run, stop, reserve, onChange, onStopping } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const total = items.length;
  const size = Math.max(1, limit);
  const isStopped = (): boolean => stop?.aborted === true;
  const stopWake: Promise<Wake<R>> =
    stop === undefined || isStopped()
      ? new Promise<Wake<R>>(() => undefined)
      : new Promise<Wake<R>>((resolve) => stop.addEventListener('abort', () => resolve({ kind: 'stop' }), { once: true }));

  const report = (s: State<R>): void => onChange?.({ done: s.done.size, inFlight: s.flying.size, total });

  const start = (s: State<R>): State<R> => {
    const index = s.next;
    const flying = run(items[index], index).then((item): Wake<R> => ({ kind: 'settled', index, item }));
    return { ...s, next: index + 1, flying: new Map([...s.flying, [index, flying]]) };
  };

  const wait = async (s: State<R>, holdMs: number): Promise<State<R>> => {
    const timerControl = new AbortController();
    const timer: Promise<Wake<R>> =
      holdMs > 0 ? sleep(holdMs, timerControl.signal).then((): Wake<R> => ({ kind: 'timer' })) : new Promise<Wake<R>>(() => undefined);
    // Once stopped, the stop wake has already been taken: waiting on it again would spin.
    const woke = await Promise.race([...s.flying.values(), timer, ...(isStopped() ? [] : [stopWake])]);
    timerControl.abort();
    if (woke.kind === 'timer') return { ...s, pace: undefined };
    if (woke.kind === 'stop') return s;
    const after: State<R> = {
      ...s,
      flying: new Map([...s.flying].filter(([index]) => index !== woke.index)),
      done: new Map([...s.done, [woke.index, woke.item.result]]),
      pace: mergeRates(s.pace, woke.item.rate, now()),
    };
    report(after);
    return after;
  };

  const step = async (s: State<R>): Promise<PoolResult<T, R>> => {
    const canStart = s.next < total && !isStopped();
    if (isStopped() && !s.announced && s.flying.size > 0) {
      onStopping?.(s.flying.size);
      report(s);
      return step({ ...s, announced: true });
    }
    if (!canStart && s.flying.size === 0) {
      return { results: [...s.done].sort(([a], [b]) => a - b).map(([, r]) => r), cancelled: items.slice(s.next) };
    }
    if (canStart && s.flying.size < size) {
      const hold = paceWaitMs(s.pace, now(), reserve);
      return step(hold === 0 ? start(s) : await wait(s, hold));
    }
    return step(await wait(s, 0));
  };

  const initial: State<R> = { next: 0, flying: new Map(), done: new Map(), pace: undefined, announced: false };
  report(initial);
  return step(initial);
}
