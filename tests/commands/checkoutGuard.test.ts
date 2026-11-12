import { describe, test, expect } from 'bun:test';
import { findDirtyBranchIssue, findUncommittedEnvChange } from '../../src/commands/checkoutCommand';
import { hashValue } from '../../src/commands/statusCommand';
import { KeepFile } from '../../src/types/index';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { ProjectManager } from '../../src/core/projectManager';
import type { FileManager } from '../../src/files/fileManager';

const BRANCH = 'local';

function keepVars(entries: Record<string, string>): KeepFile['variables'] {
  const variables: KeepFile['variables'] = {};
  for (const [name, value] of Object.entries(entries)) {
    variables[name] = [{ resource_id: `rid-${name}`, branch: BRANCH, value_hash: hashValue(value) }];
  }
  return variables;
}

describe('findUncommittedEnvChange (checkout dirty guard)', () => {
  test('clean tree with non-empty values → null', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123', MODE: 'production' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123', MODE: 'production' }, vars, BRANCH)).toBeNull();
  });

  test('REGRESSION: empty value present and pinned empty → clean, not a deletion', () => {
    // A branch full of empty placeholders (e.g. the monorepo "local" branch)
    // must not read as dirty: '' is present, decrypts, and hash-matches the
    // pin. The old falsy `!localValue` check flagged every empty variable as
    // an uncommitted deletion, permanently blocking branch switches.
    const vars = keepVars({ POLAR_ORG_KEY: '', AWS_REGION: '', DATABASE_URL: '' });
    const local = { POLAR_ORG_KEY: '', AWS_REGION: '', DATABASE_URL: '' };
    expect(findUncommittedEnvChange(local, vars, BRANCH)).toBeNull();
  });

  test('pinned variable missing from .env → uncommitted deletion', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123', MODE: 'production' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123' }, vars, BRANCH)).toBe('MODE');
  });

  test('value edited (including empty → non-empty) → uncommitted edit', () => {
    const vars = keepVars({ POLAR_ORG_KEY: '' });
    expect(findUncommittedEnvChange({ POLAR_ORG_KEY: 'now-filled-in' }, vars, BRANCH)).toBe('POLAR_ORG_KEY');
  });

  test('value edited (non-empty → empty) → uncommitted edit', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123' });
    expect(findUncommittedEnvChange({ API_KEY: '' }, vars, BRANCH)).toBe('API_KEY');
  });

  test('variable in .env but not pinned → uncommitted addition', () => {
    const vars = keepVars({ API_KEY: 'sk_live_123' });
    expect(findUncommittedEnvChange({ API_KEY: 'sk_live_123', NEW_VAR: 'x' }, vars, BRANCH)).toBe('NEW_VAR');
  });

  test('pins on other branches are ignored', () => {
    const variables: KeepFile['variables'] = {
      PROD_ONLY: [{ resource_id: 'rid-p', branch: 'prod', value_hash: hashValue('prod-value') }],
    };
    expect(findUncommittedEnvChange({}, variables, BRANCH)).toBeNull();
  });
});

// ── findDirtyBranchIssue: the extracted core of `capy checkout`'s guard ────
//
// Extracted so `capy connect dokploy --discover` (CAP-657 follow-up defect
// fix) can run the SAME two checks before its own first checkout in a
// folder, rather than a second copy of this logic. Fakes stand in for
// `ProjectManager`/`FileManager` — only the methods the function actually
// calls.

function fakePm(over: {
  keep?: KeepFile | null;
  activeBranch?: string | null;
  syncState?: { keep_hash?: string | Record<string, string> } | null;
}): ProjectManager {
  return {
    readKeepFile: () => over.keep ?? null,
    readActiveBranch: () => over.activeBranch ?? null,
    readSyncState: () => over.syncState ?? null,
  } as unknown as ProjectManager;
}

function fakeFm(over: { envHeaderBranch?: string; localPlaintext?: Record<string, string> | (() => Record<string, string>) }): FileManager {
  return {
    readEnvMeta: () => ({ branch: over.envHeaderBranch }),
    readEncryptedEnvFile: () => {
      if (typeof over.localPlaintext === 'function') return over.localPlaintext();
      if (over.localPlaintext) return over.localPlaintext;
      throw new Error('no local .env in this fixture');
    },
  } as unknown as FileManager;
}

function keepWithPin(varName: string, branch: string, value: string): KeepFile {
  return {
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'demo',
    variables: { [varName]: [{ resource_id: 'r1', branch, value_hash: hashValue(value) }] },
  };
}

describe('findDirtyBranchIssue', () => {
  test('no keep.lock, or no resolvable branch: clean (null)', () => {
    expect(findDirtyBranchIssue(fakePm({ keep: null }), fakeFm({}), 'k')).toBeNull();
    expect(findDirtyBranchIssue(fakePm({ keep: keepWithPin('A', 'production', '1') }), fakeFm({}), 'k')).toBeNull();
  });

  test('a matching local value on every pinned name, and nothing unpinned: clean (null)', () => {
    const keep = keepWithPin('A', 'production', '1');
    const pm = fakePm({ keep, activeBranch: 'production' });
    const fm = fakeFm({ envHeaderBranch: 'production', localPlaintext: { A: '1' } });
    expect(findDirtyBranchIssue(pm, fm, 'k')).toBeNull();
  });

  test('a local value that differs from the pin: UNCOMMITTED_CHANGES, naming the variable', () => {
    const keep = keepWithPin('A', 'production', '1');
    const pm = fakePm({ keep, activeBranch: 'production' });
    const fm = fakeFm({ envHeaderBranch: 'production', localPlaintext: { A: 'edited-locally' } });
    expect(findDirtyBranchIssue(pm, fm, 'k')).toEqual({ code: 'UNCOMMITTED_CHANGES', branch: 'production', varName: 'A' });
  });

  test('an unreadable/missing .env is never read as uncommitted — falls through to check B', () => {
    const keep = keepWithPin('A', 'production', '1');
    const pm = fakePm({ keep, activeBranch: 'production', syncState: { keep_hash: { production: SyncEngine.computeKeepHash(keep, 'production') } } });
    const fm = fakeFm({ envHeaderBranch: 'production' }); // no localPlaintext → readEncryptedEnvFile throws
    expect(findDirtyBranchIssue(pm, fm, 'k')).toBeNull();
  });

  test('keep.lock changed since the last recorded push: UNPUSHED_CHANGES', () => {
    const keep = keepWithPin('A', 'production', '1');
    const pm = fakePm({ keep, activeBranch: 'production', syncState: { keep_hash: { production: 'a-stale-hash-from-before-the-pin-changed' } } });
    const fm = fakeFm({ envHeaderBranch: 'production', localPlaintext: { A: '1' } }); // clean vs. the CURRENT pin
    expect(findDirtyBranchIssue(pm, fm, 'k')).toEqual({ code: 'UNPUSHED_CHANGES', branch: 'production' });
  });

  test('the .env header branch wins over the active-branch file when they disagree (CAP-215)', () => {
    // Pinned on 'staging', active-branch file still says 'production' (a
    // checkout interrupted mid-write) — the header, not the stale active
    // branch file, decides which branch's pins to diff against.
    const keep = keepWithPin('A', 'staging', '1');
    const pm = fakePm({ keep, activeBranch: 'production' });
    const fm = fakeFm({ envHeaderBranch: 'staging', localPlaintext: { A: 'edited' } });
    expect(findDirtyBranchIssue(pm, fm, 'k')).toEqual({ code: 'UNCOMMITTED_CHANGES', branch: 'staging', varName: 'A' });
  });
});

// ── placeholders: a name an import could not read a value for ──────────────
//
// An import pins such a name with an empty `value_hash` and a `placeholder`
// marker, and .env carries only a comment for it. `capy` reads that as clean
// (pinnedHashes skips placeholders); checkout must read it the same way, or
// every branch an import left a placeholder on can never be switched away from.

const placeholderPin = (branch: string): KeepFile['variables'][string][number] => ({
  resource_id: `rid-ph-${branch}`,
  branch,
  value_hash: '',
  placeholder: { provider: 'vercel', reason: 'value_not_decrypted' },
});

describe('findUncommittedEnvChange: placeholders', () => {
  test('REGRESSION: a placeholder with no line in .env is clean, not an uncommitted deletion', () => {
    const variables: KeepFile['variables'] = {
      API_TOKEN: [placeholderPin(BRANCH)],
      ...keepVars({ DATABASE_URL: 'postgres://fake' }),
    };
    expect(findUncommittedEnvChange({ DATABASE_URL: 'postgres://fake' }, variables, BRANCH)).toBeNull();
  });

  test('a value typed into .env for a placeholder is uncommitted', () => {
    const variables: KeepFile['variables'] = { API_TOKEN: [placeholderPin(BRANCH)] };
    expect(findUncommittedEnvChange({ API_TOKEN: 'filled-in-by-hand' }, variables, BRANCH)).toBe('API_TOKEN');
  });

  test('placeholders do not hide a real edit next to them', () => {
    const variables: KeepFile['variables'] = {
      API_TOKEN: [placeholderPin(BRANCH)],
      ...keepVars({ DATABASE_URL: 'postgres://fake' }),
    };
    expect(findUncommittedEnvChange({ DATABASE_URL: 'postgres://edited' }, variables, BRANCH)).toBe('DATABASE_URL');
  });
});

describe('findDirtyBranchIssue: placeholders', () => {
  test('a branch whose only differences from .env are placeholders: clean (null), so checkout may switch', () => {
    const keep: KeepFile = {
      ...keepWithPin('A', 'production', '1'),
      variables: { ...keepWithPin('A', 'production', '1').variables, API_TOKEN: [placeholderPin('production')] },
    };
    const pm = fakePm({ keep, activeBranch: 'production', syncState: { keep_hash: { production: SyncEngine.computeKeepHash(keep, 'production') } } });
    const fm = fakeFm({ envHeaderBranch: 'production', localPlaintext: { A: '1' } });
    expect(findDirtyBranchIssue(pm, fm, 'k')).toBeNull();
  });
});
