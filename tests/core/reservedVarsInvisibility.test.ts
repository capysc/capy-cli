/**
 * CAP-424 — reserved runtime variables must be invisible to every surface
 * that treats an unknown plaintext key as "a new project secret to adopt".
 *
 * One predicate, five consumers. These tests pin the consumers, so removing
 * the filter from any one of them fails here rather than in production.
 *
 * Pure by design: no filesystem. `tests/core/projectManager.test.ts` installs
 * a process-wide `mock.module('fs')` that leaks into every file sharing its
 * bun process, so the write-path coverage lives in
 * `tests/files/reservedVarsWrite.test.ts`, registered in ISOLATED_FILES.
 */
import { describe, test, expect } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';

describe('syncEngine never sees reserved runtime variables', () => {
  const engine = () => new SyncEngine();

  test('a differing SECRETS_BLOB is not a conflict', () => {
    // The destructive case: two deploy targets legitimately hold different
    // values for the same name. Offering keep-local vs keep-remote would let
    // one machine's credential overwrite another's, and neither answer is
    // right because the premise — one value per name per branch — is false.
    const changes = engine().compareEnvironments(
      { SECRETS_BLOB: 'from-droplet-a', REAL_SECRET: 'same' },
      { SECRETS_BLOB: 'from-droplet-b', REAL_SECRET: 'same' },
    );

    expect(changes.conflicts.map((c) => c.name)).not.toContain('SECRETS_BLOB');
    expect(changes.conflicts).toHaveLength(0);
  });

  test('reserved names never appear as new, deleted or unchanged either', () => {
    const changes = engine().compareEnvironments(
      { SECRETS_BLOB: 'a', PROJECT_KEY: 'b', _CAPY_DEPLOY_KEY: 'c', MINE: 'v' },
      { ONLY_REMOTE: 'r' },
    );

    const everyName = [
      ...changes.newLocal,
      ...changes.newRemote,
      ...changes.conflicts,
      ...changes.unchanged,
      ...changes.deleted,
      ...changes.deletedLocal,
    ].map((v) => v.name);

    for (const reserved of ['SECRETS_BLOB', 'PROJECT_KEY', '_CAPY_DEPLOY_KEY']) {
      expect(everyName).not.toContain(reserved);
    }
    // The real variables still flow through normally.
    expect(everyName).toContain('MINE');
    expect(everyName).toContain('ONLY_REMOTE');
  });

  test('a project variable merely resembling a reserved one is untouched', () => {
    const changes = engine().compareEnvironments(
      { MY_PROJECT_KEY: 'a', DEPLOY_KEY: 'x' },
      { MY_PROJECT_KEY: 'b', DEPLOY_KEY: 'x' },
    );

    expect(changes.conflicts.map((c) => c.name)).toContain('MY_PROJECT_KEY');
    expect(changes.unchanged.map((c) => c.name)).toContain('DEPLOY_KEY');
  });
});
