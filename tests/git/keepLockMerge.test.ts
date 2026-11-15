/**
 * The keep.lock three-way merge (`src/git/keepLockMerge.ts`): every rule, as a
 * pure function over file text. The merged text must be byte-identical to what
 * `serializeKeep` (the CLI's own writer) produces for the same content.
 */
import { describe, test, expect } from 'bun:test';
import { serializeKeep } from '../../src/files/fileManager';
import { mergeKeepLock, mergeKeepLockText } from '../../src/git/keepLockMerge';
import type { KeepFile } from '../../src/types/index';

type Entry = Record<string, unknown>;

const entry = (name: string, branch: string, hash: string, extra: Entry = {}): Entry => ({
  resource_id: `id-${name}`,
  branch,
  value_hash: hash,
  ...extra,
});

const keep = (variables: Record<string, Entry[]>, top: Record<string, unknown> = {}): KeepFile =>
  ({ version: '3.0', org_id: 'org', project_id: 'proj', project_name: 'proj-name', ...top, variables }) as unknown as KeepFile;

const text = (k: KeepFile): string => serializeKeep(k);

/** The merge of three keeps as text. */
const merge = (base: KeepFile | null, ours: KeepFile, theirs: KeepFile) =>
  mergeKeepLockText(base === null ? null : text(base), text(ours), text(theirs));

const mergedText = (r: ReturnType<typeof merge>): string => ('merged' in r ? r.merged : `CONFLICT ${JSON.stringify(r.conflict)}`);
const reasons = (r: ReturnType<typeof merge>) => ('conflict' in r ? r.conflict : []);

const target = (name: string, hash: string, at: string, extra: Entry = {}): Entry => ({
  provider: 'dokploy',
  target: name,
  deployed_value_hash: hash,
  deployed_at: at,
  ...extra,
});

describe('keep.lock merge: the real example that conflicted', () => {
  const base = keep({
    ALPHA: [entry('ALPHA', 'prod', 'h1')],
    BRAVO: [entry('BRAVO', 'prod', 'h2')],
    ZULU: [entry('ZULU', 'prod', 'h3')],
  });
  // ours: a new name, and `changed_at` added on BRAVO.
  const ours = keep({
    ALPHA: [entry('ALPHA', 'prod', 'h1')],
    BRAVO: [entry('BRAVO', 'prod', 'h2', { changed_at: '2026-11-10T10:00:00.000Z' })],
    WORKOS_SUBDOMAIN: [entry('WORKOS_SUBDOMAIN', 'prod', 'h9')],
    ZULU: [entry('ZULU', 'prod', 'h3')],
  });
  // theirs: no such name, and `targets` added on the same BRAVO entry.
  const theirs = keep({
    ALPHA: [entry('ALPHA', 'prod', 'h1')],
    BRAVO: [entry('BRAVO', 'prod', 'h2', { targets: [target('web', 'h2', '2026-11-11T09:00:00.000Z')] })],
    ZULU: [entry('ZULU', 'prod', 'h3')],
  });
  const expected = keep({
    ALPHA: [entry('ALPHA', 'prod', 'h1')],
    BRAVO: [
      entry('BRAVO', 'prod', 'h2', {
        changed_at: '2026-11-10T10:00:00.000Z',
        targets: [target('web', 'h2', '2026-11-11T09:00:00.000Z')],
      }),
    ],
    WORKOS_SUBDOMAIN: [entry('WORKOS_SUBDOMAIN', 'prod', 'h9')],
    ZULU: [entry('ZULU', 'prod', 'h3')],
  });

  test('merges with no conflict, to exactly the content the CLI would write', () => {
    expect(mergedText(merge(base, ours, theirs))).toBe(text(expected));
  });

  test('is the same file whichever side is "ours"', () => {
    expect(mergedText(merge(base, theirs, ours))).toBe(text(expected));
  });

  test('ends with a newline, names sorted, fixed key order', () => {
    const out = mergedText(merge(base, ours, theirs));
    expect(out.endsWith('\n')).toBe(true);
    const names = Object.keys((JSON.parse(out) as KeepFile).variables);
    expect(names).toEqual(names.toSorted());
  });
});

describe('keep.lock merge: names and entries', () => {
  const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });

  test('a name added on one side only is kept, from either side', () => {
    const added = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], NEW: [entry('NEW', 'prod', 'n1')] });
    expect(mergedText(merge(base, added, base))).toBe(text(added));
    expect(mergedText(merge(base, base, added))).toBe(text(added));
  });

  test('different names added on both sides are both kept', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], ONE: [entry('ONE', 'prod', 'o')] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], TWO: [entry('TWO', 'prod', 't')] });
    const expected = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], ONE: [entry('ONE', 'prod', 'o')], TWO: [entry('TWO', 'prod', 't')] });
    expect(mergedText(merge(base, a, b))).toBe(text(expected));
  });

  test('entries for different branches added on each side are both kept', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1'), entry('ALPHA', 'dev', 'd1')] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1'), entry('ALPHA', 'stage', 's1')] });
    const merged = JSON.parse(mergedText(merge(base, a, b))) as KeepFile;
    expect(merged.variables.ALPHA.map((e) => e.branch)).toEqual(['dev', 'prod', 'stage']);
  });

  test('the same entry added on both sides identically merges to that entry', () => {
    const both = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], NEW: [entry('NEW', 'prod', 'n1')] });
    expect(mergedText(merge(base, both, both))).toBe(text(both));
  });

  test('a name removed on one side and untouched on the other is removed', () => {
    const removed = keep({});
    expect(mergedText(merge(base, removed, base))).toBe(text(removed));
    expect(mergedText(merge(base, base, removed))).toBe(text(removed));
  });

  test('an entry removed on one side and untouched on the other is removed; the name goes with its last entry', () => {
    const two = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1'), entry('ALPHA', 'dev', 'd1')] });
    const oneLeft = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
    expect(mergedText(merge(two, oneLeft, two))).toBe(text(oneLeft));
  });

  test('removed on one side and changed on the other is a conflict', () => {
    const changed = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1-new')] });
    const removed = keep({});
    expect(reasons(merge(base, removed, changed))).toEqual([{ code: 'ENTRY_REMOVED_AND_CHANGED', name: 'ALPHA', branch: 'prod' }]);
    expect(reasons(merge(base, changed, removed))).toEqual([{ code: 'ENTRY_REMOVED_AND_CHANGED', name: 'ALPHA', branch: 'prod' }]);
  });

  test('a changed field on an entry the other side never touched is taken', () => {
    const changed = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1-new')] });
    expect(mergedText(merge(base, changed, base))).toBe(text(changed));
    expect(mergedText(merge(base, base, changed))).toBe(text(changed));
  });

  test('both sides changing the same field to the same thing take it', () => {
    const changed = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1-new', { changed_at: '2026-11-10T10:00:00.000Z' })] });
    expect(mergedText(merge(base, changed, changed))).toBe(text(changed));
  });

  test('a placeholder resolved on one side and untouched on the other takes the resolved entry', () => {
    const placeholder = keep({ ALPHA: [entry('ALPHA', 'prod', '', { placeholder: { provider: 'vercel', reason: 'sensitive_unreadable' } })] });
    const resolved = keep({ ALPHA: [entry('ALPHA', 'prod', 'h-real', { changed_at: '2026-11-10T10:00:00.000Z' })] });
    expect(mergedText(merge(placeholder, resolved, placeholder))).toBe(text(resolved));
  });

  test('other entry fields (connector) merge per field, and the same field changed differently conflicts', () => {
    const withConnector = (provider: string) => keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { connector: { provider } })] });
    expect(mergedText(merge(base, withConnector('a'), base))).toBe(text(withConnector('a')));
    expect(reasons(merge(base, withConnector('a'), withConnector('b')))).toEqual([
      { code: 'ENTRY_FIELD_DIVERGED', name: 'ALPHA', branch: 'prod', field: 'connector' },
    ]);
  });

  test('the bytes do not depend on which side is ours: extra fields come out in one fixed order', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { zeta: 1, changed_at: '2026-11-10T10:00:00.000Z' })] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { alpha: 2, connector: { provider: 'x' } })] });
    const expected = text(keep({
      ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-10T10:00:00.000Z', connector: { provider: 'x' }, alpha: 2, zeta: 1 })],
    }));
    expect(mergedText(merge(base, a, b))).toBe(expected);
    expect(mergedText(merge(base, b, a))).toBe(expected);
  });

  test('two sides that agree on a value written with its keys in a different order get one order', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { connector: { provider: 'x', account: 'y' } })] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { connector: { account: 'y', provider: 'x' } })] });
    expect(mergedText(merge(base, a, b))).toBe(mergedText(merge(base, b, a)));
  });

  test('an entry both sides left byte-identical keeps its own field order', () => {
    const odd = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { zeta: 1, alpha: 2 })] });
    expect(mergedText(merge(odd, odd, odd))).toBe(text(odd));
  });

  test('a variable named __proto__ is dropped, as the CLI writer has always dropped it', () => {
    const withProto = '{"version":"3.0","org_id":"org","project_id":"proj","project_name":"proj-name","variables":{"__proto__":[{"resource_id":"r","value_hash":"h"}],"ALPHA":[{"resource_id":"id-ALPHA","branch":"prod","value_hash":"h1"}]}}';
    const out = mergedText(mergeKeepLockText(withProto, withProto, withProto));
    expect(out).not.toContain('__proto__');
    expect(out).toContain('"ALPHA"');
  });

  test('an unchanged file merges to the same bytes', () => {
    expect(mergedText(merge(base, base, base))).toBe(text(base));
  });
});

describe('keep.lock merge: value_hash and changed_at', () => {
  const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });

  test('value_hash changed to different things on both sides is a conflict that names the entry', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'hA')] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'hB')] });
    expect(reasons(merge(base, a, b))).toEqual([{ code: 'VALUE_HASH_DIVERGED', name: 'ALPHA', branch: 'prod', field: 'value_hash' }]);
  });

  test('value_hash added differently on both sides with no ancestor entry is a conflict too', () => {
    const a = keep({ NEW: [entry('NEW', 'prod', 'hA')] });
    const b = keep({ NEW: [entry('NEW', 'prod', 'hB')] });
    expect(reasons(merge(base, a, b))).toEqual([{ code: 'VALUE_HASH_DIVERGED', name: 'NEW', branch: 'prod', field: 'value_hash' }]);
  });

  test('changed_at differing with the same value_hash: the later date wins, whichever side has it', () => {
    const early = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-01T00:00:00.000Z' })] });
    const late = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-09T00:00:00.000Z' })] });
    expect(mergedText(merge(base, early, late))).toBe(text(late));
    expect(mergedText(merge(base, late, early))).toBe(text(late));
  });

  test('one side changed the value and the other only moved changed_at: changed_at comes from the side that changed the value, never a pairing neither side had', () => {
    const anc = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-01T00:00:00.000Z' })] });
    const valueChanged = keep({ ALPHA: [entry('ALPHA', 'prod', 'h2', { changed_at: '2026-10-05T00:00:00.000Z' })] });
    const onlyMoved = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-09T00:00:00.000Z' })] });
    const expected = text(valueChanged);
    expect(mergedText(merge(anc, valueChanged, onlyMoved))).toBe(expected);
    expect(mergedText(merge(anc, onlyMoved, valueChanged))).toBe(expected);
  });

  test('the side that changed the value has no changed_at: the other side\'s date is not attached to the new value', () => {
    const anc = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
    const valueChanged = keep({ ALPHA: [entry('ALPHA', 'prod', 'h2')] });
    const onlyMoved = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-09T00:00:00.000Z' })] });
    expect(mergedText(merge(anc, valueChanged, onlyMoved))).toBe(text(valueChanged));
    expect(mergedText(merge(anc, onlyMoved, valueChanged))).toBe(text(valueChanged));
  });

  test('changed_at that already existed in the ancestor and moved on both sides: the later wins', () => {
    const anc = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-01T00:00:00.000Z' })] });
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-05T00:00:00.000Z' })] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-07T00:00:00.000Z' })] });
    expect(mergedText(merge(anc, a, b))).toBe(text(b));
  });

  test('timestamps in different time zones are ordered as instants, not as strings', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-09T23:00:00.000-05:00' })] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-10T01:00:00.000Z' })] });
    // 23:00-05:00 is 04:00Z the next day, later than 01:00Z.
    expect(mergedText(merge(base, a, b))).toBe(text(a));
  });

  test('changed_at that is the same instant written two ways is not a disagreement: the same file whichever side is ours', () => {
    const z = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-10T10:00:00.000Z' })] });
    const offset = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-10T05:00:00.000-05:00' })] });
    expect(mergedText(merge(base, z, offset))).toBe(mergedText(merge(base, offset, z)));
    expect('merged' in merge(base, z, offset)).toBe(true);
  });

  test('changed_at removed on one side and moved on the other: the date that is there wins over an absent one', () => {
    const anc = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-01T00:00:00.000Z' })] });
    const removed = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
    const moved = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-10-09T00:00:00.000Z' })] });
    expect(mergedText(merge(anc, removed, moved))).toBe(text(moved));
  });

  test('changed_at that is not a date on both sides cannot be ordered: conflict', () => {
    const a = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: 'soon' })] });
    const b = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: 'later' })] });
    expect(reasons(merge(base, a, b)).map((r) => r.code)).toEqual(['CHANGED_AT_UNORDERABLE']);
  });
});

describe('keep.lock merge: targets', () => {
  const withTargets = (targets: Entry[] | undefined, hash = 'h1') =>
    keep({ ALPHA: [entry('ALPHA', 'prod', hash, targets === undefined ? {} : { targets })] });
  const web = (at: string, hash = 'h1', extra: Entry = {}) => target('web', hash, at, extra);
  const api = (at: string) => target('api', 'h1', at);

  test('different targets added on each side are both kept', () => {
    const anc = withTargets(undefined);
    const a = withTargets([web('2026-11-01T00:00:00.000Z')]);
    const b = withTargets([api('2026-11-02T00:00:00.000Z')]);
    const merged = JSON.parse(mergedText(merge(anc, a, b))) as KeepFile;
    const targets = (merged.variables.ALPHA[0].targets ?? []).map((t) => t.target);
    expect(targets.toSorted()).toEqual(['api', 'web']);
  });

  test('the same target changed on both sides: the later deployed_at wins, whichever side has it', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z', 'h0')]);
    const early = withTargets([web('2026-11-02T00:00:00.000Z', 'h-early')]);
    const late = withTargets([web('2026-11-05T00:00:00.000Z', 'h-late')]);
    expect(mergedText(merge(anc, early, late))).toBe(text(withTargets([web('2026-11-05T00:00:00.000Z', 'h-late')])));
    expect(mergedText(merge(anc, late, early))).toBe(text(withTargets([web('2026-11-05T00:00:00.000Z', 'h-late')])));
  });

  test('a target changed on one side only is taken even when the other side added another target', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z', 'h0')]);
    const a = withTargets([web('2026-11-03T00:00:00.000Z', 'h3')]);
    const b = withTargets([web('2026-11-01T00:00:00.000Z', 'h0'), api('2026-11-02T00:00:00.000Z')]);
    const merged = JSON.parse(mergedText(merge(anc, a, b))) as KeepFile;
    const byName = Object.fromEntries((merged.variables.ALPHA[0].targets ?? []).map((t) => [t.target, t.deployed_value_hash]));
    expect(byName).toEqual({ web: 'h3', api: 'h1' });
  });

  test('a target removed on one side and untouched on the other is removed', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z'), api('2026-11-01T00:00:00.000Z')]);
    const removedApi = withTargets([web('2026-11-01T00:00:00.000Z')]);
    expect(mergedText(merge(anc, removedApi, anc))).toBe(text(removedApi));
  });

  test('a target removed on one side and changed on the other is a conflict', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z')]);
    const removed = withTargets([api('2026-11-01T00:00:00.000Z')]);
    const changed = withTargets([web('2026-11-04T00:00:00.000Z', 'h4'), api('2026-11-01T00:00:00.000Z')]);
    expect(reasons(merge(anc, removed, changed))).toEqual([
      { code: 'TARGET_REMOVED_AND_CHANGED', name: 'ALPHA', branch: 'prod', provider: 'dokploy', target: 'web' },
    ]);
  });

  test('the same target changed differently at the same deployed_at cannot be ordered: conflict', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z', 'h0')]);
    const a = withTargets([web('2026-11-05T00:00:00.000Z', 'hA')]);
    const b = withTargets([web('2026-11-05T00:00:00.000Z', 'hB')]);
    expect(reasons(merge(anc, a, b)).map((r) => r.code)).toEqual(['TARGET_DIVERGED']);
  });

  test('a placeholder target (no deployed_at) loses to a delivered one', () => {
    const anc = withTargets(undefined);
    const placeholder = withTargets([{ provider: 'dokploy', target: 'web' }]);
    const delivered = withTargets([web('2026-11-05T00:00:00.000Z', 'h1')]);
    expect(mergedText(merge(anc, placeholder, delivered))).toBe(text(delivered));
  });

  test('targets on both sides with the same elements in a different order are written in (provider, target) order, whichever side is ours', () => {
    const a = withTargets([web('2026-11-01T00:00:00.000Z'), api('2026-11-01T00:00:00.000Z')]);
    const b = withTargets([api('2026-11-01T00:00:00.000Z'), web('2026-11-01T00:00:00.000Z')]);
    const expected = text(b);
    expect(mergedText(merge(withTargets(undefined), a, b))).toBe(expected);
    expect(mergedText(merge(withTargets(undefined), b, a))).toBe(expected);
  });

  test('merged targets come out in (provider, target) order whichever side added which', () => {
    const anc = withTargets(undefined);
    const a = withTargets([web('2026-11-01T00:00:00.000Z')]);
    const b = withTargets([api('2026-11-02T00:00:00.000Z')]);
    const expected = text(withTargets([api('2026-11-02T00:00:00.000Z'), web('2026-11-01T00:00:00.000Z')]));
    expect(mergedText(merge(anc, a, b))).toBe(expected);
    expect(mergedText(merge(anc, b, a))).toBe(expected);
  });

  describe('deploy ids (live tokens) are never dropped', () => {
    const anc = withTargets([web('2026-11-01T00:00:00.000Z', 'h0', { deploy_id: 'D0' })]);
    const ancestorTarget = (extra: Entry, at: string) => withTargets([web(at, 'h-new', extra)]);
    const reason = { code: 'TARGET_DEPLOY_IDS_UNACCOUNTED', name: 'ALPHA', branch: 'prod', provider: 'dokploy', target: 'web' };

    test('the later delivery wins only when it accounts for the loser\'s live deploy_id', () => {
      const early = ancestorTarget({ deploy_id: 'D1', superseded_deploy_ids: ['D0'] }, '2026-11-02T00:00:00.000Z');
      const late = ancestorTarget({ deploy_id: 'D2', superseded_deploy_ids: ['D0'] }, '2026-11-05T00:00:00.000Z');
      expect(reasons(merge(anc, early, late))).toEqual([reason]);
      expect(reasons(merge(anc, late, early))).toEqual([reason]);
    });

    test('accounted for: the winner lists the loser\'s deploy_id as superseded', () => {
      const early = ancestorTarget({ deploy_id: 'D1', superseded_deploy_ids: ['D0'] }, '2026-11-02T00:00:00.000Z');
      const late = ancestorTarget({ deploy_id: 'D2', superseded_deploy_ids: ['D0', 'D1'] }, '2026-11-05T00:00:00.000Z');
      expect(mergedText(merge(anc, early, late))).toBe(text(late));
      expect(mergedText(merge(anc, late, early))).toBe(text(late));
    });

    test('the winner has the same deploy_id as the loser: accounted for', () => {
      const early = ancestorTarget({ deploy_id: 'D1' }, '2026-11-02T00:00:00.000Z');
      const late = ancestorTarget({ deploy_id: 'D1' }, '2026-11-05T00:00:00.000Z');
      expect(mergedText(merge(anc, early, late))).toBe(text(late));
    });

    test('a superseded id only the loser holds is also unaccounted for', () => {
      const early = ancestorTarget({ superseded_deploy_ids: ['D0', 'DX'] }, '2026-11-02T00:00:00.000Z');
      const late = ancestorTarget({ deploy_id: 'D2', superseded_deploy_ids: ['D0'] }, '2026-11-05T00:00:00.000Z');
      expect(reasons(merge(anc, early, late))).toEqual([reason]);
    });

    test('a loser with no deploy ids loses freely', () => {
      const early = ancestorTarget({}, '2026-11-02T00:00:00.000Z');
      const late = ancestorTarget({ deploy_id: 'D2' }, '2026-11-05T00:00:00.000Z');
      expect(mergedText(merge(anc, early, late))).toBe(text(late));
    });

    test('a target changed on one side only is taken whole, deploy ids and all', () => {
      const changed = ancestorTarget({ deploy_id: 'D2', superseded_deploy_ids: ['D0'] }, '2026-11-05T00:00:00.000Z');
      expect(mergedText(merge(anc, changed, anc))).toBe(text(changed));
    });
  });
});

describe('keep.lock merge: top-level fields', () => {
  const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
  const withTop = (top: Record<string, unknown>) => keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] }, top);
  /** The same file as JSON text without going through the CLI's writer (which would drop fields it does not know). */
  const rawWithTop = (top: Record<string, unknown>): string => JSON.stringify(withTop(top));

  test('deploy_revision is a count of forced redeploys: both sides redeployed, so both increases count', () => {
    expect(mergedText(merge(withTop({ deploy_revision: 3 }), withTop({ deploy_revision: 4 }), withTop({ deploy_revision: 4 })))).toBe(
      text(withTop({ deploy_revision: 5 })),
    );
  });

  test('deploy_revision raised on one side only is that side\'s value; absent counts as zero', () => {
    expect(mergedText(merge(base, withTop({ deploy_revision: 1 }), base))).toBe(text(withTop({ deploy_revision: 1 })));
    expect(mergedText(merge(base, base, withTop({ deploy_revision: 2 })))).toBe(text(withTop({ deploy_revision: 2 })));
    expect(mergedText(merge(base, withTop({ deploy_revision: 1 }), withTop({ deploy_revision: 1 })))).toBe(
      text(withTop({ deploy_revision: 2 })),
    );
  });

  test('both sides removing deploy_revision is not a conflict; one side removing it while the other left it alone removes it', () => {
    const had = withTop({ deploy_revision: 3 });
    expect(mergedText(merge(had, base, base))).toBe(text(base));
    expect(mergedText(merge(had, base, had))).toBe(text(base));
    expect(mergedText(merge(had, had, base))).toBe(text(base));
  });

  test('deploy_revision absent everywhere stays absent', () => {
    expect(mergedText(merge(base, base, base))).not.toContain('deploy_revision');
  });

  test('deploy_revision that went down, or is not a count, is not that kind of field: conflict', () => {
    const down = merge(withTop({ deploy_revision: 5 }), withTop({ deploy_revision: 2 }), withTop({ deploy_revision: 6 }));
    expect(reasons(down)).toEqual([{ code: 'DEPLOY_REVISION_UNORDERABLE', field: 'deploy_revision' }]);
    const weird = mergeKeepLockText(text(base), rawWithTop({ deploy_revision: 'two' }), text(base));
    expect(reasons(weird)).toEqual([{ code: 'DEPLOY_REVISION_UNORDERABLE', field: 'deploy_revision' }]);
  });

  test('an identity field changed on one side is taken; changed differently on both is a conflict', () => {
    const renamed = withTop({ project_name: 'renamed' });
    expect(mergedText(merge(base, renamed, base))).toBe(text(renamed));
    const other = withTop({ project_name: 'other' });
    expect(reasons(merge(base, renamed, other))).toEqual([{ code: 'TOP_LEVEL_DIVERGED', field: 'project_name' }]);
    expect(reasons(merge(base, withTop({ version: '4.0' }), withTop({ version: '5.0' })))).toEqual([
      { code: 'TOP_LEVEL_DIVERGED', field: 'version' },
    ]);
  });

  test('a top-level field the CLI writer does not know is a conflict, never dropped silently', () => {
    const unknown = mergeKeepLockText(text(base), rawWithTop({ future_field: 1 }), text(base));
    expect(reasons(unknown)).toEqual([{ code: 'UNKNOWN_TOP_LEVEL_FIELD', field: 'future_field' }]);
  });
});

describe('keep.lock merge: no ancestor', () => {
  const a = keep({ ONE: [entry('ONE', 'prod', 'o')] });
  const b = keep({ TWO: [entry('TWO', 'prod', 't')] });

  test('both sides added the file: merges as if the ancestor were empty', () => {
    const expected = keep({ ONE: [entry('ONE', 'prod', 'o')], TWO: [entry('TWO', 'prod', 't')] });
    expect(mergedText(merge(null, a, b))).toBe(text(expected));
  });

  test('git hands add/add an empty ancestor file: blank text is no ancestor', () => {
    const expected = keep({ ONE: [entry('ONE', 'prod', 'o')], TWO: [entry('TWO', 'prod', 't')] });
    expect(mergedText(mergeKeepLockText('', text(a), text(b)))).toBe(text(expected));
    expect(mergedText(mergeKeepLockText('\n  \n', text(a), text(b)))).toBe(text(expected));
  });

  test('the same name with different hashes on both sides is still a conflict', () => {
    const c = keep({ ONE: [entry('ONE', 'prod', 'x')] });
    expect(reasons(merge(null, a, c)).map((r) => r.code)).toEqual(['VALUE_HASH_DIVERGED']);
  });

  test('different project identity on both sides, no ancestor: conflict', () => {
    const other = keep({ ONE: [entry('ONE', 'prod', 'o')] }, { project_id: 'another' });
    expect(reasons(merge(null, a, other))).toEqual([{ code: 'TOP_LEVEL_DIVERGED', field: 'project_id' }]);
  });
});

describe('keep.lock merge: a side that is not a valid keep.lock is a conflict, never a silent pick', () => {
  const good = text(keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] }));

  test('JSON that does not parse, on each side', () => {
    expect(mergeKeepLockText(good, '{ nope', good)).toEqual({ conflict: [{ code: 'INVALID_KEEP_LOCK', side: 'ours' }] });
    expect(mergeKeepLockText(good, good, '')).toEqual({ conflict: [{ code: 'INVALID_KEEP_LOCK', side: 'theirs' }] });
    expect(mergeKeepLockText('{ nope', good, good)).toEqual({ conflict: [{ code: 'INVALID_KEEP_LOCK', side: 'base' }] });
  });

  test('a base that is the JSON literal null is not "no ancestor"', () => {
    expect(mergeKeepLockText('null', good, good)).toEqual({ conflict: [{ code: 'INVALID_KEEP_LOCK', side: 'base' }] });
  });

  test('every invalid side is reported', () => {
    expect(mergeKeepLockText(good, '[', '[')).toEqual({
      conflict: [
        { code: 'INVALID_KEEP_LOCK', side: 'ours' },
        { code: 'INVALID_KEEP_LOCK', side: 'theirs' },
      ],
    });
  });

  test('valid JSON of the wrong shape', () => {
    const missingName = JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'p', variables: {} });
    const entriesNotArray = JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'p', project_name: 'n', variables: { A: { resource_id: 'r', value_hash: 'h' } } });
    const noHash = JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'p', project_name: 'n', variables: { A: [{ resource_id: 'r' }] } });
    const duplicateBranch = JSON.stringify({
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'n',
      variables: { A: [{ resource_id: 'r', branch: 'prod', value_hash: 'h' }, { resource_id: 's', branch: 'prod', value_hash: 'i' }] },
    });
    const badTargets = JSON.stringify({
      version: '3.0', org_id: 'o', project_id: 'p', project_name: 'n',
      variables: { A: [{ resource_id: 'r', value_hash: 'h', targets: [{ provider: 'x' }] }] },
    });
    [missingName, entriesNotArray, noHash, duplicateBranch, badTargets, '"text"', '7', 'null'].forEach((bad) => {
      expect(mergeKeepLockText(good, bad, good)).toEqual({ conflict: [{ code: 'INVALID_KEEP_LOCK', side: 'ours' }] });
    });
  });

  test('the pure function takes parsed values and applies the same validation', () => {
    expect(mergeKeepLock(null, 5, { nope: true })).toEqual({
      conflict: [
        { code: 'INVALID_KEEP_LOCK', side: 'ours' },
        { code: 'INVALID_KEEP_LOCK', side: 'theirs' },
      ],
    });
  });
});

describe('keep.lock merge: the pure function', () => {
  test('returns the merged KeepFile', () => {
    const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
    const ours = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')], NEW: [entry('NEW', 'prod', 'n')] });
    const result = mergeKeepLock(base, ours, base);
    expect('merged' in result && Object.keys(result.merged.variables)).toEqual(['ALPHA', 'NEW']);
  });

  test('does not modify its inputs', () => {
    const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1')] });
    const ours = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { changed_at: '2026-11-10T10:00:00.000Z' })] });
    const theirs = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { targets: [target('web', 'h1', '2026-11-11T00:00:00.000Z')] })] });
    const before = JSON.stringify([base, ours, theirs]);
    mergeKeepLock(base, ours, theirs);
    expect(JSON.stringify([base, ours, theirs])).toBe(before);
  });

  test('entries the CLI writes with extras it does not know are carried through', () => {
    const base = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { vendor_note: { a: 1 } })] });
    const ours = keep({ ALPHA: [entry('ALPHA', 'prod', 'h1', { vendor_note: { a: 1 } })], NEW: [entry('NEW', 'prod', 'n')] });
    expect(mergedText(merge(base, ours, base))).toBe(text(ours));
  });
});
