/**
 * The pure planner of the one commit path (CAP-712): what happens to each name when
 * the caller's changes meet the server's latest, given the caller's pin.
 */
import { describe, test, expect, mock } from 'bun:test';
import { hashValue } from '../../src/sync/compareSecrets';
import { localChanges, planCommit, pinnedHashes, type LatestEntry, type Plan } from '../../src/sync/commit';
import type { KeepFile } from '../../src/types/index';

const entry = (value: string): LatestEntry => ({ line: `capy:r:${value}`, plaintext: value, hash: hashValue(value) });
const latestOf = (values: Record<string, string>): Record<string, LatestEntry> =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, entry(value)]));
const pinOf = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, hashValue(value)]));
const encryptLine = (name: string, value: string): string => `capy:new:${name}:${value}`;

function plan(args: {
  pinned: Record<string, string>;
  latest: Record<string, string>;
  set?: Record<string, string>;
  remove?: string[];
  resolutions?: Record<string, 'mine' | 'theirs'>;
}): Plan {
  return planCommit({
    pinned: pinOf(args.pinned),
    latest: latestOf(args.latest),
    changes: { set: args.set ?? {}, remove: args.remove ?? [] },
    resolutions: args.resolutions,
    encryptLine,
  });
}

const okPlan = (p: Plan) => {
  if (p.kind !== 'ok') throw new Error('expected an ok plan');
  return p;
};

describe('planCommit — set', () => {
  test('a name the server has not moved since the pin is written; every other name keeps the server line verbatim', () => {
    const p = okPlan(plan({ pinned: { X: 'x0', Y: 'y0' }, latest: { X: 'x0', Y: 'y0' }, set: { Y: 'y1' } }));
    expect(p.written).toEqual({ Y: 'y1' });
    expect(p.lines.X).toBe('capy:r:x0');
    expect(p.lines.Y).toBe('capy:new:Y:y1');
    expect(p.env).toEqual({ X: 'x0', Y: 'y1' });
  });

  test('only the changed names are encrypted', () => {
    const encrypt = mock(encryptLine);
    planCommit({
      pinned: pinOf({ A: 'a', B: 'b', C: 'c' }),
      latest: latestOf({ A: 'a', B: 'b', C: 'c' }),
      changes: { set: { B: 'b2' }, remove: [] },
      encryptLine: encrypt,
    });
    expect(encrypt.mock.calls.map((c) => c[0])).toEqual(['B']);
  });

  test('the server moved a name this caller does NOT change: not a conflict, and the server value stays', () => {
    const p = okPlan(plan({ pinned: { X: 'x0', Y: 'y0' }, latest: { X: 'x-new', Y: 'y0' }, set: { Y: 'y1' } }));
    expect(p.lines.X).toBe('capy:r:x-new');
    expect(p.env.X).toBe('x-new');
  });

  test('the server moved the name since the pin and holds a different value: conflict', () => {
    expect(plan({ pinned: { X: 'x0' }, latest: { X: 'x-new' }, set: { X: 'x-mine' } })).toEqual({ kind: 'conflict', names: ['X'] });
  });

  test('the server moved the name but already holds the intended value: nothing to write, no conflict', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x1' }, set: { X: 'x1' } }));
    expect(p.written).toEqual({});
    expect(p.lines.X).toBe('capy:r:x1');
  });

  test('added on the server since the pin (the pin does not have it): conflict when the values differ', () => {
    expect(plan({ pinned: {}, latest: { Z: 'z-theirs' }, set: { Z: 'z-mine' } })).toEqual({ kind: 'conflict', names: ['Z'] });
  });

  test('removed on the server since the pin: setting it is a conflict', () => {
    expect(plan({ pinned: { Z: 'z0' }, latest: {}, set: { Z: 'z1' } })).toEqual({ kind: 'conflict', names: ['Z'] });
  });

  test('a new name that is neither pinned nor on the server is appended', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x0' }, set: { N: 'n' } }));
    expect(Object.keys(p.lines)).toEqual(['X', 'N']);
    expect(p.written).toEqual({ N: 'n' });
  });

  test('conflicts name every contested variable, sorted, once', () => {
    const p = plan({ pinned: { B: 'b0', A: 'a0', C: 'c0' }, latest: { B: 'b1', A: 'a1', C: 'c0' }, set: { B: 'b2', A: 'a2', C: 'c2' } });
    expect(p).toEqual({ kind: 'conflict', names: ['A', 'B'] });
  });
});

describe('planCommit — remove', () => {
  test('removes a name the server has not moved', () => {
    const p = okPlan(plan({ pinned: { X: 'x0', Y: 'y0' }, latest: { X: 'x0', Y: 'y0' }, remove: ['Y'] }));
    expect(p.removed).toEqual(['Y']);
    expect(Object.keys(p.lines)).toEqual(['X']);
    expect(p.env).toEqual({ X: 'x0' });
  });

  test('the server moved it since the pin: conflict', () => {
    expect(plan({ pinned: { Y: 'y0' }, latest: { Y: 'y1' }, remove: ['Y'] })).toEqual({ kind: 'conflict', names: ['Y'] });
  });

  test('the server already removed it: a no-op, not a conflict', () => {
    const p = okPlan(plan({ pinned: { Y: 'y0', X: 'x0' }, latest: { X: 'x0' }, remove: ['Y'] }));
    expect(p.removed).toEqual([]);
    expect(Object.keys(p.lines)).toEqual(['X']);
  });

  test('added on the server since the pin: removing it is a conflict', () => {
    expect(plan({ pinned: {}, latest: { Z: 'z' }, remove: ['Z'] })).toEqual({ kind: 'conflict', names: ['Z'] });
  });
});

describe('planCommit — resolutions', () => {
  test('mine overwrites the value the server moved', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x1' }, set: { X: 'x-mine' }, resolutions: { X: 'mine' } }));
    expect(p.written).toEqual({ X: 'x-mine' });
    expect(p.env.X).toBe('x-mine');
  });

  test('theirs leaves the server value alone', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x1' }, set: { X: 'x-mine' }, resolutions: { X: 'theirs' } }));
    expect(p.written).toEqual({});
    expect(p.lines.X).toBe('capy:r:x1');
    expect(p.env.X).toBe('x1');
  });

  test('mine removes a name the server moved; theirs keeps it', () => {
    const mine = okPlan(plan({ pinned: { Y: 'y0' }, latest: { Y: 'y1' }, remove: ['Y'], resolutions: { Y: 'mine' } }));
    expect(mine.removed).toEqual(['Y']);
    const theirs = okPlan(plan({ pinned: { Y: 'y0' }, latest: { Y: 'y1' }, remove: ['Y'], resolutions: { Y: 'theirs' } }));
    expect(theirs.removed).toEqual([]);
    expect(theirs.env.Y).toBe('y1');
  });

  test('a resolution for a name nobody changes does nothing', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x1' }, resolutions: { X: 'mine' } }));
    expect(p.lines.X).toBe('capy:r:x1');
  });
});

describe('planCommit — edge cases', () => {
  test('a line this profile cannot decrypt is kept verbatim and left out of env', () => {
    const latest = { ...latestOf({ X: 'x0' }), SEALED: { line: 'capy:r:sealed-for-someone-else', plaintext: undefined, hash: 'h-sealed' } };
    const p = okPlan(planCommit({ pinned: { X: hashValue('x0'), SEALED: 'h-sealed' }, latest, changes: { set: { X: 'x1' }, remove: [] }, encryptLine }));
    expect(p.lines.SEALED).toBe('capy:r:sealed-for-someone-else');
    expect(p.env).toEqual({ X: 'x1' });
  });

  test('a name in both set and remove is set', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x0' }, set: { X: 'x1' }, remove: ['X'] }));
    expect(p.env.X).toBe('x1');
    expect(p.removed).toEqual([]);
  });

  test('an empty value is a value', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x0' }, set: { X: '' } }));
    expect(p.written).toEqual({ X: '' });
  });

  test('no changes: the server is left exactly as it is', () => {
    const p = okPlan(plan({ pinned: { X: 'x0' }, latest: { X: 'x9', Y: 'y' } }));
    expect(p.written).toEqual({});
    expect(p.removed).toEqual([]);
    expect(p.lines).toEqual({ X: 'capy:r:x9', Y: 'capy:r:y' });
  });
});

describe('localChanges / pinnedHashes', () => {
  const pinned = pinOf({ A: 'a', B: 'b', GONE: 'g' });

  test('a folder changed only what differs from its pin', () => {
    expect(localChanges({ A: 'a', B: 'b2', NEW: 'n' }, pinned, { removals: false })).toEqual({ set: { B: 'b2', NEW: 'n' }, remove: [] });
  });

  test('with removals, a pinned name gone from .env is a removal', () => {
    expect(localChanges({ A: 'a', B: 'b' }, pinned, { removals: true })).toEqual({ set: {}, remove: ['GONE'] });
  });

  test('pinnedHashes reads one branch', () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'demo',
      variables: {
        A: [
          { resource_id: 'r1', branch: 'development', value_hash: 'h-dev' },
          { resource_id: 'r1b', branch: 'staging', value_hash: 'h-stg' },
        ],
        B: [{ resource_id: 'r2', branch: 'staging', value_hash: 'h-b' }],
      },
    };
    expect(pinnedHashes(keep, 'development')).toEqual({ A: 'h-dev' });
    expect(pinnedHashes(null, 'development')).toEqual({});
  });
});
