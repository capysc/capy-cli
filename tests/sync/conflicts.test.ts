/**
 * The non-TTY protocol's pure half (src/sync/conflicts.ts; docs/conflict-resolution.md): the rows are bare `capy`'s
 * `compareSecrets` rows, the id binds the answers to exactly those rows, `--resolve` / `--conflict` are validated with
 * codes, and `gateConflicts` either returns an answer for every row or refuses with the payload. Fingerprints only.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { compareSecrets } from '../../src/sync/compareSecrets';
import {
  CONFLICT_ID_FORMAT,
  ConflictRefusal,
  conflictIdOf,
  conflictRefusalFor,
  exitOnConflictRefusal,
  gateConflicts,
  parseConflictFlags,
  printConflictRefusal,
  seenResolutions,
  sourceRowsOf,
  targetResolutions,
  type ConflictScope,
  type SourceConflict,
  type TargetConflict,
} from '../../src/sync/conflicts';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const view = { project: 'swot-analysis-generator-server', branch: 'production', serverKeepHash: 'a'.repeat(64) };

/** Rows exactly as bare `capy` computes them: `compareSecrets` over (pinned, local, remote) fingerprints. */
const rows = (
  pinned: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, string>,
  at = view,
): readonly SourceConflict[] => sourceRowsOf(compareSecrets(pinned, local, remote).diffs, at);

const gemini = rows({ GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: '7b69759630f869f2' });
const scope = (conflicts: readonly (SourceConflict | TargetConflict)[], at = view): ConflictScope => ({ ...at, conflicts });

describe('the rows', () => {
  test('are compareSecrets rows: name, project, branch, type, pinned, local, remote (fingerprints, null where there is no value)', () => {
    expect(gemini).toEqual([
      {
        name: 'GEMINI_TIMEOUT_SECONDS',
        project: 'swot-analysis-generator-server',
        branch: 'production',
        type: 'changed',
        pinned: '2abaca4911e68fa9',
        local: '2abaca4911e68fa9',
        remote: '7b69759630f869f2',
      },
    ]);
    expect(rows({}, {}, { NEW: 'aaaa' })).toMatchObject([{ name: 'NEW', type: 'new', pinned: null, local: null, remote: 'aaaa' }]);
    expect(rows({ GONE: 'bbbb' }, {}, { OTHER: 'cccc' }).find((r) => r.name === 'GONE')).toMatchObject({ pinned: 'bbbb', local: null, remote: null });
  });
});

describe('conflictIdOf', () => {
  test('is c_ + 12 hex, the same for the same project, branch, server keep hash and rows (in any order)', () => {
    const two = rows({ A: 'a1', B: 'b1' }, { A: 'a2', B: 'b1' }, { A: 'a1', B: 'b2' });
    const id = conflictIdOf([scope(two)]);
    expect(id).toMatch(CONFLICT_ID_FORMAT);
    expect(conflictIdOf([scope([...two].reverse())])).toBe(id);
  });

  test('changes when anything it binds moves: a fingerprint, the server keep hash, the branch, the project, a row', () => {
    const base = conflictIdOf([scope(gemini)]);
    const moved = rows({ GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: 'ffffffffffffffff' });
    expect(conflictIdOf([scope(moved)])).not.toBe(base);
    expect(conflictIdOf([scope(gemini, { ...view, serverKeepHash: 'b'.repeat(64) })])).not.toBe(base);
    expect(conflictIdOf([scope(rows({ GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: '2abaca4911e68fa9' }, { GEMINI_TIMEOUT_SECONDS: '7b69759630f869f2' }, { ...view, branch: 'staging' }), { ...view, branch: 'staging' })])).not.toBe(base);
    expect(conflictIdOf([scope([...gemini, ...rows({}, { EXTRA: 'e1' }, { OTHER: 'o1' })])])).not.toBe(base);
  });

  test('a platform row is bound too, with its target', () => {
    const platform: TargetConflict = { name: 'STRIPE_KEY', target: 'dokploy-production', pinned: null, local: 'l1', remote: 'r1' };
    const other: TargetConflict = { ...platform, target: 'dokploy-staging' };
    expect(conflictIdOf([scope([platform])])).not.toBe(conflictIdOf([scope([other])]));
  });
});

describe('parseConflictFlags', () => {
  const id = 'c_9f2e41a07b3d';

  test('the four choices for a variable, local|remote for a platform value', () => {
    expect(
      parseConflictFlags({ resolve: ['A=pinned', 'B=local', 'C=remote', 'D=delete', 'E@prod=local', 'F@prod=remote'], conflict: id }),
    ).toEqual({ resolutions: { A: 'pinned', B: 'local', C: 'remote', D: 'delete', 'E@prod': 'local', 'F@prod': 'remote' }, conflictId: id });
  });

  test('anything else is SECRETS_RESOLVE_INVALID: mine/theirs (retired), a platform value pinned or deleted, a malformed form or id, two answers for one key', () => {
    const codeOf = (raw: Parameters<typeof parseConflictFlags>[0]): string | undefined => {
      try {
        parseConflictFlags(raw);
        return undefined;
      } catch (err) {
        return err instanceof CapyError ? err.code : 'not-coded';
      }
    };
    expect(codeOf({ resolve: ['A=mine'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A=theirs'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A@prod=pinned'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A@prod=delete'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A:local'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A=local'], conflict: 'c_nothex' })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    expect(codeOf({ resolve: ['A=local', 'A=remote'], conflict: id })).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
  });

  test('--resolve without --conflict is SECRETS_RESOLVE_NEEDS_CONFLICT; --conflict alone is fine', () => {
    expect(() => parseConflictFlags({ resolve: ['A=local'] })).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_NEEDS_CONFLICT }));
    expect(parseConflictFlags({ conflict: id })).toEqual({ resolutions: {}, conflictId: id });
  });
});

describe('gateConflicts', () => {
  const scopes = [scope(gemini)];
  const id = conflictIdOf(scopes);
  const refusalOf = (run: () => unknown): ConflictRefusal => {
    try {
      run();
    } catch (err) {
      if (err instanceof ConflictRefusal) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  };

  test('no rows: nothing to answer', () => {
    expect(gateConflicts({ resolutions: {}, conflictId: undefined }, [scope([])])).toEqual({});
  });

  test('without --conflict: SECRETS_CONFLICT with every row and the id (exit 3 is the caller\'s)', () => {
    const refusal = refusalOf(() => gateConflicts({ resolutions: {}, conflictId: undefined }, scopes));
    expect(refusal.payload).toEqual({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: id, conflicts: gemini });
  });

  test('every row answered against the right id: the answers', () => {
    expect(gateConflicts({ resolutions: { GEMINI_TIMEOUT_SECONDS: 'local' }, conflictId: id }, scopes)).toEqual({ GEMINI_TIMEOUT_SECONDS: 'local' });
  });

  test('a partial set of answers: the rows still open, under the id of the WHOLE set', () => {
    const two = [scope(rows({ A: 'a1', B: 'b1' }, { A: 'a2', B: 'b2' }, { A: 'a1', B: 'b1' }))];
    const refusal = refusalOf(() => gateConflicts({ resolutions: { A: 'local' }, conflictId: conflictIdOf(two) }, two));
    expect(refusal.payload.code).toBe('SECRETS_CONFLICT');
    expect(refusal.payload.conflict_id).toBe(conflictIdOf(two));
    expect(refusal.payload.conflicts.map((c) => c.name)).toEqual(['B']);
  });

  test('an id that is not the id of exactly these rows: SECRETS_CONFLICT_STALE with the fresh rows and the fresh id', () => {
    const refusal = refusalOf(() => gateConflicts({ resolutions: { GEMINI_TIMEOUT_SECONDS: 'local' }, conflictId: 'c_000000000000' }, scopes));
    expect(refusal.payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE', conflict_id: id });
    expect(refusal.payload.conflicts).toEqual(gemini);
  });

  test('--dry-run reports the rows with dry_run and never applies, even with the right answers', () => {
    const refusal = refusalOf(() => gateConflicts({ resolutions: { GEMINI_TIMEOUT_SECONDS: 'local' }, conflictId: id }, scopes, { dryRun: true }));
    expect(refusal.payload).toEqual({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: id, conflicts: gemini, dry_run: true });
  });

  test('a platform row is answered as NAME@TARGET, and bound to the fingerprints it was answered against', () => {
    const platform: TargetConflict = { name: 'STRIPE_KEY', target: 'dokploy-production', pinned: null, local: 'l1', remote: 'r1' };
    const platformScopes = [scope([platform])];
    const answers = gateConflicts({ resolutions: { 'STRIPE_KEY@dokploy-production': 'remote' }, conflictId: conflictIdOf(platformScopes) }, platformScopes);
    expect(answers).toEqual({ 'STRIPE_KEY@dokploy-production': 'remote' });
    const bound = seenResolutions(answers, [platform]);
    expect(bound).toEqual({ 'STRIPE_KEY@dokploy-production': { choice: 'remote', local: 'l1', remote: 'r1' } });
    expect(targetResolutions(bound, 'dokploy-production')).toEqual({ STRIPE_KEY: { choice: 'remote', local: 'l1', remote: 'r1' } });
  });
});

describe('what is printed', () => {
  test('stdout: the payload as JSON, nothing else. stderr: prose with the names and no value or fingerprint', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      printConflictRefusal(conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [scope(gemini)]));
      expect(log.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflicts: gemini });
      const prose = err.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(prose).toContain('GEMINI_TIMEOUT_SECONDS');
      expect(prose).toContain('--resolve');
      expect(prose).not.toContain('7b69759630f869f2');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test('exitOnConflictRefusal exits 3 for a refusal and leaves any other error to the caller', () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      exitOnConflictRefusal(new Error('something else'));
      expect(exit).not.toHaveBeenCalled();
      exitOnConflictRefusal(conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [scope(gemini)]));
      expect(exit).toHaveBeenCalledWith(3);
    } finally {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  });
});
