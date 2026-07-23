import { describe, test, expect } from 'bun:test';
import { compareSecrets, hashValue } from '../../src/commands/statusCommand';

// compareSecrets takes maps of variable -> value_hash for pinned, and
// variable -> plaintext for local/remote (it hashes local/remote internally...
// actually it compares the values passed directly). We pass pre-hashed values
// consistently across all three so equality reflects "same value".
const h = (v: string) => hashValue(v);

describe('compareSecrets — CAP-307 silent reconcile', () => {
  test('missing pin + local === remote → no diff, no direction hints', () => {
    const pinned = {};
    const local = { API_KEY: h('abc'), DB_URL: h('postgres') };
    const remote = { API_KEY: h('abc'), DB_URL: h('postgres') };

    const { diffs, showLocal, showRemote } = compareSecrets(pinned, local, remote);

    expect(diffs).toHaveLength(0);
    expect(showLocal).toBe(false);
    expect(showRemote).toBe(false);
  });

  test('missing pin + local !== remote → still a diff (genuine divergence)', () => {
    const pinned = {};
    const local = { API_KEY: h('local-val') };
    const remote = { API_KEY: h('remote-val') };

    const { diffs, showLocal, showRemote } = compareSecrets(pinned, local, remote);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].variable).toBe('API_KEY');
    expect(showLocal).toBe(true);
    expect(showRemote).toBe(true);
  });

  test('mixed: one var reconciles silently, another genuinely differs', () => {
    const pinned = {};
    const local = { SAME: h('x'), DIFF: h('local') };
    const remote = { SAME: h('x'), DIFF: h('remote') };

    const { diffs } = compareSecrets(pinned, local, remote);

    // Only DIFF should surface; SAME is silently reconciled.
    expect(diffs.map(d => d.variable)).toEqual(['DIFF']);
  });

  test('local-only new var (no remote entry) still surfaces', () => {
    const pinned = {};
    const local = { NEW: h('x') };
    const remote = { OTHER: h('y') }; // hasRemote true, but NEW absent remotely

    const { diffs } = compareSecrets(pinned, local, remote);

    const vars = diffs.map(d => d.variable).sort();
    expect(vars).toContain('NEW');
  });
});
