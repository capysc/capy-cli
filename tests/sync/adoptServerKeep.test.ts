import { describe, test, expect } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';
import { KeepFile } from '../../src/types/index';

/**
 * After a push, the server returns the same keep.lock with server-assigned
 * changed_at timestamps. adoptServerKeep picks that copy when it's usable so
 * the local file (and the committed one) carries the timestamps immediately,
 * and falls back to the locally-merged keep otherwise (older service,
 * malformed response).
 */

const fallback: KeepFile = {
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'demo',
  variables: {
    FOO: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1' }],
  },
};

describe('SyncEngine.adoptServerKeep', () => {
  test('adopts the server copy with its changed_at timestamps', () => {
    const serverKeep = JSON.stringify({
      ...fallback,
      variables: {
        FOO: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1', changed_at: '2026-06-10T12:00:00.000Z' }],
      },
    });
    const adopted = SyncEngine.adoptServerKeep(serverKeep, fallback);
    expect(adopted.variables.FOO[0].changed_at).toBe('2026-06-10T12:00:00.000Z');
  });

  test('falls back when the server sent no keep_file (older service)', () => {
    expect(SyncEngine.adoptServerKeep(undefined, fallback)).toBe(fallback);
  });

  test('falls back on unparseable JSON', () => {
    expect(SyncEngine.adoptServerKeep('{not json', fallback)).toBe(fallback);
  });

  test('falls back on parseable JSON that is not a keep file', () => {
    expect(SyncEngine.adoptServerKeep('null', fallback)).toBe(fallback);
    expect(SyncEngine.adoptServerKeep('"string"', fallback)).toBe(fallback);
    expect(SyncEngine.adoptServerKeep('{"no_variables":true}', fallback)).toBe(fallback);
  });
});
