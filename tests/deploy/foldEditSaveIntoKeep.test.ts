/**
 * Unit tests for `foldEditSaveIntoKeep` (src/deploy/keepGate.ts) — the pure
 * fold the `capy edit` exit-time PR flow (editExitFlow.ts) replays, one
 * recorded session save at a time, onto whatever keep.lock the chosen
 * target git branch actually has.
 */
import { describe, test, expect } from 'bun:test';
import { foldEditSaveIntoKeep, EditSaveRecord } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import { KeepFile, KeepVariableEntry } from '../../src/types/index';

function entry(overrides: Partial<KeepVariableEntry> & { resource_id: string; value_hash: string }): KeepVariableEntry {
  return { ...overrides };
}

function baseKeep(variables: Record<string, KeepVariableEntry[]>): KeepFile {
  return {
    version: '3',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'test-project',
    variables,
  };
}

describe('foldEditSaveIntoKeep', () => {
  test('replaces the existing (variable, branch) entry, leaving other fields alone', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'old-hash' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'new-hash' }) }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY).toHaveLength(1);
    expect(folded.variables.API_KEY[0].value_hash).toBe('new-hash');
    expect(folded.variables.API_KEY[0].resource_id).toBe('r1');
    // Untouched top-level fields carry through.
    expect(folded.org_id).toBe('org-1');
  });

  test('adds a brand-new variable that had no prior entry at all', () => {
    const keep = baseKeep({});
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'NEW_VAR', entry: entry({ resource_id: 'r-new', branch: 'production', value_hash: 'h1' }) }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.NEW_VAR).toEqual([
      entry({ resource_id: 'r-new', branch: 'production', value_hash: 'h1' }),
    ]);
  });

  test('adds a new branch entry to a variable that already has entries on OTHER branches', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'staging', value_hash: 'staging-hash' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'prod-hash' }) }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY).toHaveLength(2);
    const staging = folded.variables.API_KEY.find((e) => e.branch === 'staging');
    const production = folded.variables.API_KEY.find((e) => e.branch === 'production');
    expect(staging?.value_hash).toBe('staging-hash');
    expect(production?.value_hash).toBe('prod-hash');
  });

  test('a null entry deletes the (variable, branch) pin, leaving other branches of the same variable', () => {
    const keep = baseKeep({
      API_KEY: [
        entry({ resource_id: 'r1', branch: 'production', value_hash: 'prod-hash' }),
        entry({ resource_id: 'r1', branch: 'staging', value_hash: 'staging-hash' }),
      ],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: null }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY).toEqual([
      entry({ resource_id: 'r1', branch: 'staging', value_hash: 'staging-hash' }),
    ]);
  });

  test('a null entry that empties a variable\'s entry list drops the variable key entirely', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'prod-hash' })],
      DB_URL: [entry({ resource_id: 'r2', branch: 'production', value_hash: 'db-hash' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: null }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(Object.keys(folded.variables)).not.toContain('API_KEY');
    // Every other variable is untouched.
    expect(folded.variables.DB_URL).toEqual([
      entry({ resource_id: 'r2', branch: 'production', value_hash: 'db-hash' }),
    ]);
  });

  test('variables and branch entries not named in the record are left byte-for-byte untouched', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'prod-hash' })],
      DB_URL: [entry({ resource_id: 'r2', branch: 'production', value_hash: 'db-hash' })],
      UNRELATED: [entry({ resource_id: 'r3', branch: 'staging', value_hash: 'stg-hash' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'changed' }) }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.DB_URL).toEqual(keep.variables.DB_URL);
    expect(folded.variables.UNRELATED).toEqual(keep.variables.UNRELATED);
  });

  test('a fold that reproduces exactly what was already there serializes identically (no-diff detection)', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'same-hash' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'same-hash' }) }],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(serializeKeep(folded)).toBe(serializeKeep(keep));
  });

  test('multiple touched variables in one save all fold together', () => {
    const keep = baseKeep({});
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [
        { variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'h1' }) },
        { variable: 'DB_URL', entry: entry({ resource_id: 'r2', branch: 'production', value_hash: 'h2' }) },
      ],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY[0].value_hash).toBe('h1');
    expect(folded.variables.DB_URL[0].value_hash).toBe('h2');
  });

  test('does not mutate the input keep object', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'old-hash' })],
    });
    const beforeSerialized = serializeKeep(keep);
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [{ variable: 'API_KEY', entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'new-hash' }) }],
    };

    foldEditSaveIntoKeep(keep, record);

    expect(serializeKeep(keep)).toBe(beforeSerialized);
  });

  // ── Dates rule ─────────────────────────────────────────────────────────
  // Mirrors buildDeployKeep's `entry.value_hash !== hash` check: same
  // value_hash as the target already has → keep the TARGET's own entry
  // exactly (its dates are never moved by an unrelated save); different hash
  // → use the save's entry (which carries the real server-assigned date).

  test('same value_hash as the target: keeps the TARGET entry\'s changed_at exactly, ignoring the save\'s own changed_at', () => {
    const keep = baseKeep({
      API_KEY: [
        entry({ resource_id: 'r1', branch: 'production', value_hash: 'aaaa000000000002', changed_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [
        {
          variable: 'API_KEY',
          entry: entry({
            resource_id: 'r1',
            branch: 'production',
            value_hash: 'aaaa000000000002', // same hash as the target
            changed_at: '2026-09-29T10:05:00.000Z', // the save's own (wrong) date
          }),
        },
      ],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY[0].changed_at).toBe('2026-01-02T00:00:00.000Z');
    // The target's entry is used byte-for-byte — not just its date.
    expect(folded.variables.API_KEY[0]).toEqual(keep.variables.API_KEY[0]);
  });

  test('same value_hash, target has no changed_at at all: stays absent, not backfilled from the save', () => {
    const keep = baseKeep({
      API_KEY: [entry({ resource_id: 'r1', branch: 'production', value_hash: 'same-hash' })], // no changed_at
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [
        {
          variable: 'API_KEY',
          entry: entry({
            resource_id: 'r1',
            branch: 'production',
            value_hash: 'same-hash',
            changed_at: '2026-09-29T10:05:00.000Z',
          }),
        },
      ],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY[0].changed_at).toBeUndefined();
    expect(folded.variables.API_KEY[0]).toEqual(keep.variables.API_KEY[0]);
  });

  test('different value_hash: uses the save\'s entry, changed_at included', () => {
    const keep = baseKeep({
      API_KEY: [
        entry({ resource_id: 'r1', branch: 'production', value_hash: 'old-hash', changed_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [
        {
          variable: 'API_KEY',
          entry: entry({
            resource_id: 'r1',
            branch: 'production',
            value_hash: 'new-hash',
            changed_at: '2026-09-29T10:05:00.000Z',
          }),
        },
      ],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(folded.variables.API_KEY[0].value_hash).toBe('new-hash');
    expect(folded.variables.API_KEY[0].changed_at).toBe('2026-09-29T10:05:00.000Z');
  });

  test('a save whose every touched entry has the same value_hash as the target produces no diff', () => {
    const keep = baseKeep({
      API_KEY: [
        entry({ resource_id: 'r1', branch: 'production', value_hash: 'same-hash', changed_at: '2026-01-02T00:00:00.000Z' }),
      ],
      DB_URL: [entry({ resource_id: 'r2', branch: 'production', value_hash: 'same-hash-2' })],
    });
    const record: EditSaveRecord = {
      branch: 'production',
      entries: [
        {
          variable: 'API_KEY',
          entry: entry({ resource_id: 'r1', branch: 'production', value_hash: 'same-hash', changed_at: '2026-09-29T10:05:00.000Z' }),
        },
        {
          variable: 'DB_URL',
          entry: entry({ resource_id: 'r2', branch: 'production', value_hash: 'same-hash-2', changed_at: '2026-09-29T10:05:00.000Z' }),
        },
      ],
    };

    const folded = foldEditSaveIntoKeep(keep, record);

    expect(serializeKeep(folded)).toBe(serializeKeep(keep));
  });
});
