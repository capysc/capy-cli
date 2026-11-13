import { describe, test, expect, mock } from 'bun:test';
import { runPool } from '../../src/utils/pool';

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The most items of `events` open at once, `+item` opening and `-item` closing. */
const maxOpen = (events: readonly string[]): number =>
  events.reduce(
    (acc, e) => {
      const open = acc.open + (e.startsWith('+') ? 1 : -1);
      return { open, max: Math.max(acc.max, open) };
    },
    { open: 0, max: 0 },
  ).max;

const laneOfItem = (item: string): string => item.slice(0, 1);

describe('runPool lanes', () => {
  test('items of one lane never run together; other lanes still run alongside, up to the limit', async () => {
    const log = mock((_e: string) => undefined);
    const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'];
    const out = await runPool({
      items,
      limit: 6,
      lane: laneOfItem,
      run: async (item) => {
        log(`+${item}`);
        await sleepMs(5);
        log(`-${item}`);
        return { result: item };
      },
    });
    const events = log.mock.calls.map((c) => c[0]);
    expect(out.results).toEqual(items);
    // Never more than one at a time within a lane.
    expect(['a', 'b', 'c'].map((lane) => maxOpen(events.filter((e) => laneOfItem(e.slice(1)) === lane)))).toEqual([1, 1, 1]);
    // Three lanes at once.
    expect(maxOpen(events)).toBe(3);
  });

  test('a lane waiting for itself does not hold back another lane behind it in the input', async () => {
    const log = mock((_e: string) => undefined);
    await runPool({
      items: ['a1', 'a2', 'b1'],
      limit: 2,
      lane: laneOfItem,
      run: async (item) => {
        log(`+${item}`);
        await sleepMs(item === 'a1' ? 10 : 1);
        log(`-${item}`);
        return { result: item };
      },
    });
    const events = log.mock.calls.map((c) => c[0]);
    // b1 starts while a1 is still running, ahead of a2.
    expect(events.indexOf('+b1')).toBeLessThan(events.indexOf('-a1'));
    expect(events.indexOf('+a2')).toBeGreaterThan(events.indexOf('-a1'));
  });

  test('within a lane the items start in input order', async () => {
    const log = mock((_e: string) => undefined);
    await runPool({
      items: ['a1', 'a2', 'a3', 'a4'],
      limit: 4,
      lane: laneOfItem,
      run: async (item) => {
        log(item);
        return { result: item };
      },
    });
    expect(log.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  test('a stop: the running item finishes, no item starts after, and `cancelled` is exactly the never-started ones in input order', async () => {
    const stop = new AbortController();
    const out = await runPool({
      items: ['a1', 'a2', 'b1', 'b2', 'a3'],
      limit: 2,
      lane: laneOfItem,
      stop: stop.signal,
      run: async (item) => {
        if (item === 'b1') stop.abort();
        await sleepMs(3);
        return { result: item };
      },
    });
    expect(out.results).toEqual(['a1', 'b1']);
    expect(out.cancelled).toEqual(['a2', 'b2', 'a3']);
  });

  test('without a lane nothing changes: every item is its own lane', async () => {
    const log = mock((_e: string) => undefined);
    const out = await runPool({
      items: ['a1', 'a2', 'a3', 'a4', 'a5'],
      limit: 3,
      run: async (item) => {
        log(`+${item}`);
        await sleepMs(4);
        log(`-${item}`);
        return { result: item };
      },
    });
    expect(maxOpen(log.mock.calls.map((c) => c[0]))).toBe(3);
    expect(out.results).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(out.cancelled).toEqual([]);
  });
});
