/**
 * The shared conflict module (CAP-717, src/sync/conflicts.ts): the id that binds a decision to what was seen,
 * the flags, and the "apply the resolutions or refuse" step every write command goes through. Pure: no server,
 * no folder. Each test asserts the PROPERTY a caller relies on.
 */
import { describe, test, expect } from 'bun:test';
import {
  CONFLICT_ID_FORMAT,
  ConflictRefusal,
  conflictIdOf,
  conflictRefusalFor,
  gateConflicts,
  parseConflictFlags,
  protocolDecider,
  resolveKeyOf,
  seenResolutions,
  sourceResolutions,
  targetResolutions,
  type Conflict,
  type ConflictScope,
} from '../../src/sync/conflicts';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const source = (name: string, theirs: string, over: Partial<Extract<Conflict, { kind: 'source' }>> = {}): Conflict => ({
  kind: 'source',
  name,
  project: 'demo',
  branch: 'production',
  pinned: '1111111111111111',
  yours: '2222222222222222',
  theirs,
  ...over,
});

const target = (name: string, over: Partial<Extract<Conflict, { kind: 'target' }>> = {}): Conflict => ({
  kind: 'target',
  name,
  target: 'dokploy-production',
  pinned: '1111111111111111',
  yours: '2222222222222222',
  theirs: '3333333333333333',
  ...over,
});

const scope = (conflicts: readonly Conflict[], over: Partial<ConflictScope> = {}): ConflictScope => ({
  project: 'demo',
  branch: 'production',
  serverKeepHash: 'abcdabcdabcdabcd',
  conflicts,
  ...over,
});

const refusalOf = (run: () => unknown): ConflictRefusal => {
  try {
    run();
  } catch (err) {
    if (err instanceof ConflictRefusal) return err;
    throw err;
  }
  throw new Error('expected a ConflictRefusal');
};

describe('conflictIdOf', () => {
  const base = [scope([source('A', 'aaaaaaaaaaaaaaaa'), source('B', 'bbbbbbbbbbbbbbbb')])];

  test('is c_ + 12 hex, and does not depend on the order the conflicts were found in', () => {
    const id = conflictIdOf(base);
    expect(id).toMatch(CONFLICT_ID_FORMAT);
    expect(conflictIdOf([scope([source('B', 'bbbbbbbbbbbbbbbb'), source('A', 'aaaaaaaaaaaaaaaa')])])).toBe(id);
  });

  test('changes when anything it binds changes: a fingerprint, the server keep hash, the branch, the project, a name, a kind', () => {
    const id = conflictIdOf(base);
    const others = [
      conflictIdOf([scope([source('A', 'cccccccccccccccc'), source('B', 'bbbbbbbbbbbbbbbb')])]), // theirs moved again
      conflictIdOf([scope([source('A', 'aaaaaaaaaaaaaaaa', { yours: '9999999999999999' }), source('B', 'bbbbbbbbbbbbbbbb')])]), // yours
      conflictIdOf([scope([source('A', 'aaaaaaaaaaaaaaaa', { pinned: null }), source('B', 'bbbbbbbbbbbbbbbb')])]), // pinned
      conflictIdOf([scope(base[0].conflicts, { serverKeepHash: 'ffffffffffffffff' })]),
      conflictIdOf([scope(base[0].conflicts, { branch: 'staging' })]),
      conflictIdOf([scope(base[0].conflicts, { project: 'other' })]),
      conflictIdOf([scope([source('A', 'aaaaaaaaaaaaaaaa')])]), // a name fewer
      conflictIdOf([scope([target('A'), source('B', 'bbbbbbbbbbbbbbbb')])]), // a kind
    ];
    expect(new Set([id, ...others]).size).toBe(others.length + 1);
  });

  test('theirs_changed_at is not part of it (the spec binds fingerprints only)', () => {
    const a = conflictIdOf([scope([source('A', 'aaaaaaaaaaaaaaaa')])]);
    const b = conflictIdOf([scope([source('A', 'aaaaaaaaaaaaaaaa', { theirs_changed_at: '2026-10-01T21:44:18Z' })])]);
    expect(b).toBe(a);
  });
});

describe('parseConflictFlags', () => {
  const ID = 'c_9f2e41a07b3d';

  test('NAME=mine|theirs, and NAME@TARGET=... for a target, repeatable', () => {
    const flags = parseConflictFlags({ resolve: ['A=mine', 'B=theirs', 'C@dokploy-production=mine'], conflict: ID });
    expect(flags).toEqual({ resolutions: { A: 'mine', B: 'theirs', 'C@dokploy-production': 'mine' }, conflictId: ID });
  });

  test('a bad form is SECRETS_RESOLVE_INVALID (code, not prose)', () => {
    ['A', 'A=', 'A=ours', '=mine', 'A=mine=theirs', '1A=mine', 'A@=mine'].forEach((bad) => {
      const err = (() => {
        try {
          parseConflictFlags({ resolve: [bad], conflict: ID });
          return undefined;
        } catch (e) {
          return e as CapyError;
        }
      })();
      expect(err?.code).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    });
  });

  test('--resolve without --conflict is SECRETS_RESOLVE_NEEDS_CONFLICT; a malformed id is SECRETS_RESOLVE_INVALID', () => {
    expect(() => parseConflictFlags({ resolve: ['A=mine'] })).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_NEEDS_CONFLICT }));
    expect(() => parseConflictFlags({ resolve: ['A=mine'], conflict: 'c_nothex' })).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_INVALID }));
    expect(() => parseConflictFlags({ conflict: 'whatever' })).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_INVALID }));
  });

  test('one name decided two ways is refused; the same answer twice is fine; there is no resolve-all', () => {
    expect(() => parseConflictFlags({ resolve: ['A=mine', 'A=theirs'], conflict: ID })).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_INVALID }));
    expect(parseConflictFlags({ resolve: ['A=mine', 'A=mine'], conflict: ID }).resolutions).toEqual({ A: 'mine' });
    // (A variable may be NAMED `all`; the point is that no spelling means "every conflict".)
    ['*=mine', '--all', 'ALL', '=mine'].forEach((x) => expect(() => parseConflictFlags({ resolve: [x], conflict: ID })).toThrow());
  });

  test('no flags is no decisions', () => {
    expect(parseConflictFlags({})).toEqual({ resolutions: {}, conflictId: undefined });
    expect(parseConflictFlags({ resolve: [] })).toEqual({ resolutions: {}, conflictId: undefined });
  });
});

describe('gateConflicts', () => {
  const scopes = [scope([source('A', 'aaaaaaaaaaaaaaaa'), source('B', 'bbbbbbbbbbbbbbbb'), target('A')])];
  const id = conflictIdOf(scopes);
  const flags = (resolve: readonly string[], conflict: string | undefined = id) => parseConflictFlags({ resolve, conflict });

  test('nothing in conflict decides nothing', () => {
    expect(gateConflicts(flags([]), [scope([])])).toEqual({});
  });

  test('without --conflict every conflict is reported, with the id: SECRETS_CONFLICT', () => {
    const refusal = refusalOf(() => gateConflicts(flags([], undefined), scopes));
    expect(refusal.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(refusal.payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: id });
    expect(refusal.payload.conflicts).toHaveLength(3);
  });

  test('a --conflict that is not the id of exactly these is stale: the FRESH conflicts and a NEW id come back', () => {
    const refusal = refusalOf(() => gateConflicts(flags(['A=mine'], 'c_000000000000'), scopes));
    expect(refusal.code).toBe(ERROR_CODES.SECRETS_CONFLICT_STALE);
    expect(refusal.payload.conflict_id).toBe(id);
    expect(refusal.payload.conflicts).toHaveLength(3);
  });

  test('the id matches but a conflicting name has no answer: the REMAINING ones come back (the id of the whole set, so a rerun keeps it)', () => {
    const refusal = refusalOf(() => gateConflicts(flags(['A=mine', 'B=theirs']), scopes));
    expect(refusal.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(refusal.payload.conflict_id).toBe(id);
    expect(refusal.payload.conflicts.map(resolveKeyOf)).toEqual(['A@dokploy-production']);
  });

  test('every conflict answered: the decisions, source and target apart', () => {
    const decided = gateConflicts(flags(['A=mine', 'B=theirs', 'A@dokploy-production=theirs']), scopes);
    expect(decided).toEqual({ A: 'mine', B: 'theirs', 'A@dokploy-production': 'theirs' });
    expect(sourceResolutions(decided)).toEqual({ A: 'mine', B: 'theirs' });
    expect(targetResolutions(decided, 'dokploy-production')).toEqual({ A: 'theirs' });
    expect(targetResolutions(decided, 'elsewhere')).toEqual({});
  });

  test('seenResolutions binds each decision to the fingerprints of the conflict it answered, and drops answers to nothing', () => {
    const decided = gateConflicts(flags(['A=mine', 'B=theirs', 'A@dokploy-production=theirs']), scopes);
    const seen = seenResolutions({ ...decided, 'ZZZ@dokploy-production': 'mine' }, scopes.flatMap((s) => s.conflicts));
    const target = scopes.flatMap((s) => s.conflicts).find((c) => c.kind === 'target')!;
    expect(seen['A@dokploy-production']).toEqual({ choice: 'theirs', theirs: target.theirs, yours: target.yours });
    expect(Object.keys(seen).toSorted()).toEqual(['A', 'A@dokploy-production', 'B']);
    expect(targetResolutions(seen, 'dokploy-production')).toEqual({ A: seen['A@dokploy-production'] });
  });

  test('answers for names that are not in the conflict are ignored, never applied', () => {
    expect(gateConflicts(flags(['A=mine', 'B=mine', 'A@dokploy-production=mine', 'ZZZ=theirs']), scopes)).toEqual({
      A: 'mine',
      B: 'mine',
      'A@dokploy-production': 'mine',
    });
  });

  test('several places bind one id, and moving any one of them makes the answer stale', () => {
    const two = [scope([source('A', 'aaaaaaaaaaaaaaaa')]), scope([source('A', 'aaaaaaaaaaaaaaaa', { branch: 'staging' })], { branch: 'staging' })];
    const both = conflictIdOf(two);
    expect(gateConflicts(parseConflictFlags({ resolve: ['A=mine'], conflict: both }), two)).toEqual({ A: 'mine' });
    const moved = [two[0], scope([source('A', 'dddddddddddddddd', { branch: 'staging' })], { branch: 'staging' })];
    expect(refusalOf(() => gateConflicts(parseConflictFlags({ resolve: ['A=mine'], conflict: both }), moved)).code).toBe(ERROR_CODES.SECRETS_CONFLICT_STALE);
  });

  test('a payload names fingerprints and the code, never anything else: exactly ok, code, conflict_id, conflicts (dry_run on a preview)', () => {
    const refusal = refusalOf(() => gateConflicts(flags([], undefined), scopes));
    expect(Object.keys(refusal.payload).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'ok']);
    const preview = conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes, undefined, { dryRun: true });
    expect(Object.keys(preview.payload).toSorted()).toEqual(['code', 'conflict_id', 'conflicts', 'dry_run', 'ok']);
    expect(preview.payload.conflict_id).toBe(id);
  });

  test('protocolDecider asks the same gate for one scope', () => {
    const found = [source('A', 'aaaaaaaaaaaaaaaa') as Extract<Conflict, { kind: 'source' }>];
    const view = { project: 'demo', branch: 'production', serverKeepHash: 'abcdabcdabcdabcd' };
    const here = conflictIdOf([scope(found)]);
    expect(protocolDecider(parseConflictFlags({ resolve: ['A=theirs'], conflict: here }))(found, view)).toEqual({ A: 'theirs' });
    expect(() => protocolDecider(parseConflictFlags({}))(found, view)).toThrow(ConflictRefusal);
  });
});
