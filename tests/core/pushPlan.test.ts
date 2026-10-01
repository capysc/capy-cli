/**
 * CAP-659 Phase 2 — `capy push --dry-run`'s diff math, in isolation. Pure
 * functions, no IO: the add/change/remove classification `pushCommand.ts`'s
 * `previewPush` and `checkoutCommand.ts`'s `previewSwitch` both build their
 * `DryRunChange[]` from.
 */
import { describe, test, expect } from 'bun:test';
import { computePushDiff, pushPlan } from '../../src/core/pushPlan';

describe('computePushDiff', () => {
  test('a name only in local is an add', () => {
    expect(computePushDiff({}, { FOO: 'hash-a' })).toEqual([{ name: 'FOO', kind: 'add' }]);
  });

  test('a name only in pinned (missing locally) is a remove', () => {
    expect(computePushDiff({ FOO: 'hash-a' }, {})).toEqual([{ name: 'FOO', kind: 'remove' }]);
  });

  test('same name, different hash, is a change', () => {
    expect(computePushDiff({ FOO: 'hash-a' }, { FOO: 'hash-b' })).toEqual([{ name: 'FOO', kind: 'change' }]);
  });

  test('same name, same hash, reports nothing', () => {
    expect(computePushDiff({ FOO: 'hash-a' }, { FOO: 'hash-a' })).toEqual([]);
  });

  test('absent from both reports nothing', () => {
    expect(computePushDiff({}, {})).toEqual([]);
  });

  test('never reports a value — only names and a hash hint never leaves this module', () => {
    const diffs = computePushDiff({ SECRET: 'deadbeef' }, { SECRET: 'cafebabe' });
    expect(JSON.stringify(diffs)).not.toContain('deadbeef');
    expect(JSON.stringify(diffs)).not.toContain('cafebabe');
  });

  test('sorted by name for deterministic output', () => {
    const diffs = computePushDiff({}, { ZEBRA: 'h1', APPLE: 'h2' });
    expect(diffs.map((d) => d.name)).toEqual(['APPLE', 'ZEBRA']);
  });

  test('mixed add/change/remove in one call', () => {
    const pinned = { KEEP_SAME: 'h1', WILL_CHANGE: 'h2', WILL_REMOVE: 'h3' };
    const local = { KEEP_SAME: 'h1', WILL_CHANGE: 'h2-new', WILL_ADD: 'h4' };
    const diffs = computePushDiff(pinned, local);
    expect(diffs).toEqual([
      { name: 'WILL_ADD', kind: 'add' },
      { name: 'WILL_CHANGE', kind: 'change' },
      { name: 'WILL_REMOVE', kind: 'remove' },
    ]);
  });
});

describe('pushPlan', () => {
  test('maps each diff kind to a DryRunChange, reversible, naming only', () => {
    const changes = pushPlan([
      { name: 'ADD_ME', kind: 'add' },
      { name: 'CHANGE_ME', kind: 'change' },
      { name: 'REMOVE_ME', kind: 'remove' },
    ]);
    expect(changes).toEqual([
      { where: 'capy_service', action: 'push new secret', target: 'ADD_ME', reversible: true },
      { where: 'capy_service', action: 'push changed secret', target: 'CHANGE_ME', reversible: true },
      { where: 'capy_service', action: 'remove pinned secret', target: 'REMOVE_ME', reversible: true },
    ]);
  });

  test('no diffs → no changes', () => {
    expect(pushPlan([])).toEqual([]);
  });
});
