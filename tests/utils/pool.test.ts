import { describe, test, expect, mock } from 'bun:test';
import { mergeRates, paceWaitMs, runPool } from '../../src/utils/pool';
import { retryDelayMs, retrying, RETRY_MAX_ATTEMPTS, BACKOFF_CAP_MS } from '../../src/utils/backoff';

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const maxOpen = (events: readonly string[]): number =>
  events.reduce((acc, e) => ({ open: acc.open + (e === '+' ? 1 : -1), max: Math.max(acc.max, acc.open + (e === '+' ? 1 : -1)) }), { open: 0, max: 0 }).max;

describe('runPool', () => {
  test('never runs more than `limit` at once and returns every result in input order', async () => {
    const log = mock((_e: string) => undefined);
    const out = await runPool({
      items: Array.from({ length: 13 }, (_, i) => i),
      limit: 4,
      run: async (n) => {
        log('+');
        await sleepMs(13 - n); // the early ones are slowest
        log('-');
        return { result: n * 10 };
      },
    });
    expect(maxOpen(log.mock.calls.map((c) => c[0]))).toBe(4);
    expect(out.results).toEqual(Array.from({ length: 13 }, (_, i) => i * 10));
    expect(out.cancelled).toEqual([]);
  });

  test('no items: nothing runs and it still reports once', async () => {
    const onChange = mock((_p: unknown) => undefined);
    const out = await runPool({ items: [], limit: 3, run: async () => ({ result: 1 }), onChange });
    expect(out).toEqual({ results: [], cancelled: [] });
    expect(onChange.mock.calls).toEqual([[{ done: 0, inFlight: 0, total: 0 }]]);
  });

  test('a stop lets every running item finish, starts none, and cancels exactly the rest (in order)', async () => {
    const stop = new AbortController();
    const started = mock((_n: number) => undefined);
    const onStopping = mock((_n: number) => undefined);
    const out = await runPool({
      items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      limit: 3,
      stop: stop.signal,
      onStopping,
      run: async (item, i) => {
        started(i);
        if (i === 1) stop.abort();
        await sleepMs(10);
        return { result: item.toUpperCase() };
      },
    });
    expect(started.mock.calls).toHaveLength(2); // the stop came while the 2nd was starting: the 3rd never does
    expect(out.results).toEqual(['A', 'B']);
    expect(out.cancelled).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(onStopping.mock.calls).toEqual([[2]]);
  });

  test('already stopped: nothing starts, everything is cancelled, no stopping report', async () => {
    const stop = new AbortController();
    stop.abort();
    const onStopping = mock((_n: number) => undefined);
    const run = mock(async (_i: number) => ({ result: 1 }));
    const out = await runPool({ items: [1, 2, 3], limit: 2, stop: stop.signal, run, onStopping });
    expect(run.mock.calls).toHaveLength(0);
    expect(out).toEqual({ results: [], cancelled: [1, 2, 3] });
    expect(onStopping.mock.calls).toHaveLength(0);
  });

  test('a stop after every item has started cancels nothing and still waits for them', async () => {
    const stop = new AbortController();
    const out = await runPool({
      items: [1, 2],
      limit: 5,
      stop: stop.signal,
      run: async (n) => {
        if (n === 2) stop.abort();
        await sleepMs(5);
        return { result: n };
      },
    });
    expect(out).toEqual({ results: [1, 2], cancelled: [] });
  });

  test('progress: `done` counts finished items, once each', async () => {
    const onChange = mock((_p: { done: number; inFlight: number; total: number }) => undefined);
    await runPool({ items: [1, 2, 3, 4, 5], limit: 2, onChange, run: async (n) => ({ result: n }) });
    expect(onChange.mock.calls.map((c) => c[0].done)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(onChange.mock.calls.every((c) => c[0].total === 5 && c[0].inFlight <= 2)).toBe(true);
  });

  test('pacing: at the reserve nothing new starts until the reset; running ones finish', async () => {
    const log = mock((_e: string) => undefined);
    const sleep = mock(async (ms: number) => {
      log(`sleep:${ms}`);
    });
    const clock = (): number => (log.mock.calls.some((c) => c[0].startsWith('sleep')) ? 20_000 : 10_000);
    await runPool({
      items: [1, 2, 3, 4, 5, 6],
      limit: 3,
      reserve: 5,
      now: clock,
      sleep,
      run: async (n) => {
        log(`start:${n}`);
        await sleepMs(2);
        return { result: n, rate: { remaining: 2, resetAt: 15_000 } };
      },
    });
    const events = log.mock.calls.map((c) => c[0]);
    const firstSleep = events.findIndex((e) => e.startsWith('sleep'));
    expect(events[firstSleep]).toBe('sleep:5000');
    expect(events.slice(0, firstSleep).filter((e) => e.startsWith('start'))).toHaveLength(3);
    expect(events.slice(firstSleep).filter((e) => e.startsWith('start'))).toHaveLength(3);
  });
});

describe('rate helpers', () => {
  test('paceWaitMs: only at or under the reserve, only until the reset, never over the cap', () => {
    expect(paceWaitMs({ remaining: 5, resetAt: 9000 }, 1000, 5)).toBe(8000);
    expect(paceWaitMs({ remaining: 6, resetAt: 9000 }, 1000, 5)).toBe(0);
    expect(paceWaitMs({ remaining: 0, resetAt: 900 }, 1000, 5)).toBe(0);
    expect(paceWaitMs({ remaining: 0, resetAt: 1_000_000 }, 1000, 5)).toBe(BACKOFF_CAP_MS);
    expect(paceWaitMs({ remaining: 0, resetAt: 9000 }, 1000, undefined)).toBe(0);
    expect(paceWaitMs(undefined, 1000, 5)).toBe(0);
  });

  test('mergeRates keeps the reading with less left, and drops a window that has already reset', () => {
    expect(mergeRates({ remaining: 9, resetAt: 5000 }, { remaining: 4, resetAt: 5000 }, 1000)).toEqual({ remaining: 4, resetAt: 5000 });
    expect(mergeRates({ remaining: 1, resetAt: 500 }, { remaining: 80, resetAt: 5000 }, 1000)).toEqual({ remaining: 80, resetAt: 5000 });
    expect(mergeRates({ remaining: 1, resetAt: 500 }, undefined, 1000)).toBeUndefined();
    expect(mergeRates(undefined, undefined, 1000)).toBeUndefined();
  });
});

describe('backoff', () => {
  test('retryDelayMs: the server\'s wait when given, else 2s, 4s, 8s; capped', () => {
    expect([1, 2, 3].map((n) => retryDelayMs(n))).toEqual([2000, 4000, 8000]);
    expect(retryDelayMs(1, 750)).toBe(750);
    expect(retryDelayMs(1, 9_999_999)).toBe(BACKOFF_CAP_MS);
  });

  test('retrying stops after the bounded attempts and returns the last answer', async () => {
    const sleep = mock(async (_ms: number) => undefined);
    const attempt = mock(async () => 'limited');
    const result = await retrying(attempt, () => ({}), sleep);
    expect(result).toBe('limited');
    expect(attempt.mock.calls).toHaveLength(RETRY_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  test('retrying returns the first answer that is not limited', async () => {
    const sleep = mock(async (_ms: number) => undefined);
    const answers = ['limited', 'ok'];
    const attempt = mock(async () => answers[attempt.mock.calls.length - 1]);
    expect(await retrying(attempt, (a) => (a === 'limited' ? { afterMs: 10 } : undefined), sleep)).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10]);
  });
});
