/**
 * Writes with no folder (src/sync/noFolder.ts; docs/conflict-resolution.md, "Commands with no folder"): for each value
 * written, `compareSecrets` over pinned (the value the person was shown), local (the new value) and remote (what Capy
 * holds there now). Unchanged since it was shown, or already holding the new value: no decision. Moved: a row.
 */
import { describe, test, expect } from 'bun:test';
import { bindAnswer, actionFor, holdsFor, movedRow, type WriteComparison } from '../../src/sync/noFolder';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const base: WriteComparison = {
  name: 'API_KEY',
  project: 'web',
  branch: 'production',
  shown: 'aaaaaaaaaaaaaaaa',
  local: 'bbbbbbbbbbbbbbbb',
  remote: 'aaaaaaaaaaaaaaaa',
  serverKeepHash: 'k'.repeat(64),
};

describe('movedRow', () => {
  test('Capy unchanged since it was shown: write, no decision', () => {
    expect(movedRow(base)).toBeUndefined();
  });

  test('Capy already holds the new value: nothing to write, no decision', () => {
    expect(movedRow({ ...base, remote: base.local })).toBeUndefined();
  });

  test('Capy moved to something else: the compareSecrets row, with the project and branch', () => {
    expect(movedRow({ ...base, remote: 'cccccccccccccccc' })).toEqual({
      name: 'API_KEY',
      project: 'web',
      branch: 'production',
      type: 'changed',
      pinned: 'aaaaaaaaaaaaaaaa',
      local: 'bbbbbbbbbbbbbbbb',
      remote: 'cccccccccccccccc',
    });
  });

  test('the location lost the variable since it was shown: a row with no remote', () => {
    expect(movedRow({ ...base, remote: undefined })).toMatchObject({ name: 'API_KEY', pinned: 'aaaaaaaaaaaaaaaa', local: 'bbbbbbbbbbbbbbbb', remote: null });
  });
});

describe('answers', () => {
  const row = movedRow({ ...base, remote: 'cccccccccccccccc' });

  test('local writes, remote leaves the location; pinned and delete are refused with a code', () => {
    expect(actionFor('local')).toBe('write');
    expect(actionFor('remote')).toBe('leave');
    expect(() => actionFor('pinned')).toThrow(expect.objectContaining({ code: ERROR_CODES.SECRETS_RESOLVE_INVALID }));
    expect(() => actionFor('delete')).toThrow(CapyError);
  });

  test('an answer holds only for the state it was made against', () => {
    if (row === undefined) throw new Error('fixture');
    const answer = bindAnswer('local', row);
    expect(answer).toEqual({ choice: 'local', remote: 'cccccccccccccccc', local: 'bbbbbbbbbbbbbbbb' });
    expect(holdsFor(answer, row)).toBe(true);
    expect(holdsFor(answer, { ...row, remote: 'dddddddddddddddd' })).toBe(false);
    expect(holdsFor(answer, { ...row, local: 'eeeeeeeeeeeeeeee' })).toBe(false);
    expect(holdsFor(undefined, row)).toBe(false);
  });
});
