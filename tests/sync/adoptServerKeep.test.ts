import { describe, test, expect } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';
import { KeepFile } from '../../src/types/index';

/**
 * After a push, the server returns its latest keep (the union of every
 * machine's last push) with server-assigned changed_at timestamps.
 * adoptServerKeep splices ONLY the pushed branch's entries out of that copy
 * (CAP-303) — the server has no authority over branches this push didn't
 * touch, so the local file keeps its own entries for them. Falls back to the
 * locally-merged keep when the response is missing or unusable (older
 * service, malformed response).
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
  test('adopts the server copy of the pushed branch with its changed_at timestamps', () => {
    const serverKeep = JSON.stringify({
      ...fallback,
      variables: {
        FOO: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1', changed_at: '2026-06-10T12:00:00.000Z' }],
      },
    });
    const adopted = SyncEngine.adoptServerKeep(serverKeep, fallback, 'development');
    expect(adopted.variables.FOO[0].changed_at).toBe('2026-06-10T12:00:00.000Z');
  });

  test('does not let the server rewrite branches the push did not touch (CAP-303)', () => {
    const localWithMain: KeepFile = {
      ...fallback,
      variables: {
        FOO: [
          { resource_id: 'r1', branch: 'development', value_hash: 'h1' },
          { resource_id: 'rm', branch: 'main', value_hash: 'hm-local' },
        ],
      },
    };
    // Server's union keep carries a different (e.g. staler) main entry and an
    // extra main-only variable — neither may land in the local file from a
    // development push.
    const serverKeep = JSON.stringify({
      ...fallback,
      variables: {
        FOO: [
          { resource_id: 'r1', branch: 'development', value_hash: 'h1', changed_at: '2026-06-10T12:00:00.000Z' },
          { resource_id: 'rm', branch: 'main', value_hash: 'hm-server' },
        ],
        MAIN_ONLY: [{ resource_id: 'rx', branch: 'main', value_hash: 'hx' }],
      },
    });

    const adopted = SyncEngine.adoptServerKeep(serverKeep, localWithMain, 'development');
    expect(adopted.variables.FOO.find(e => e.branch === 'main')?.value_hash).toBe('hm-local');
    expect(adopted.variables.FOO.find(e => e.branch === 'development')?.changed_at).toBe('2026-06-10T12:00:00.000Z');
    expect(adopted.variables.MAIN_ONLY).toBeUndefined();
  });

  test('falls back when the server sent no keep_file (older service)', () => {
    expect(SyncEngine.adoptServerKeep(undefined, fallback, 'development')).toBe(fallback);
  });

  test('falls back on unparseable JSON', () => {
    expect(SyncEngine.adoptServerKeep('{not json', fallback, 'development')).toBe(fallback);
  });

  test('falls back on parseable JSON that is not a keep file', () => {
    expect(SyncEngine.adoptServerKeep('null', fallback, 'development')).toBe(fallback);
    expect(SyncEngine.adoptServerKeep('"string"', fallback, 'development')).toBe(fallback);
    expect(SyncEngine.adoptServerKeep('{"no_variables":true}', fallback, 'development')).toBe(fallback);
  });
});
