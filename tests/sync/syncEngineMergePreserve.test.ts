import { describe, test, expect } from 'bun:test';
import { SyncEngine } from '../../src/sync/syncEngine';
import { KeepFile, ConnectorMetadata } from '../../src/types/index';

/**
 * Regression test for the load-bearing fix in mergeWithKeep: the merge must
 * preserve extra fields on existing entries (e.g. `connector`). Without the
 * spread in syncEngine.ts:236, every sync wipes the connector marker and
 * `capy rotate` can't find which variables it owns.
 */

const baseConnector: ConnectorMetadata = {
  provider: 'stripe',
  source: 'cli',
  mode: 'test',
  account_id: 'acct_1Abc',
  expires_at: 1717000000,
  created_at: 1709200000,
  fingerprint: 'rk_…xyz',
};

function keepWithConnector(branch: string = 'main'): KeepFile {
  return {
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'demo',
    variables: {
      STRIPE_SECRET_KEY: [
        {
          resource_id: 'res-1',
          branch,
          value_hash: 'hash-old',
          connector: { ...baseConnector },
        },
      ],
    },
  };
}

describe('SyncEngine.mergeWithKeep preserves extras', () => {
  test('connector field survives a value_hash update on the same branch', () => {
    const engine = new SyncEngine();
    const keep = keepWithConnector('main');

    const merged = engine.mergeWithKeep(
      keep,
      { STRIPE_SECRET_KEY: { resource_id: 'res-1', value_hash: 'hash-new' } },
      'main',
    );

    const entry = merged.variables.STRIPE_SECRET_KEY[0];
    expect(entry.value_hash).toBe('hash-new');
    expect(entry.connector).toEqual(baseConnector);
  });

  test('connector field on a different branch is left alone', () => {
    const engine = new SyncEngine();
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        STRIPE_SECRET_KEY: [
          { resource_id: 'res-1', branch: 'main', value_hash: 'hash-main', connector: { ...baseConnector } },
          { resource_id: 'res-1', branch: 'dev', value_hash: 'hash-dev' },
        ],
      },
    };

    const merged = engine.mergeWithKeep(
      keep,
      { STRIPE_SECRET_KEY: { resource_id: 'res-1', value_hash: 'hash-dev2' } },
      'dev',
    );

    const mainEntry = merged.variables.STRIPE_SECRET_KEY.find((e) => e.branch === 'main')!;
    const devEntry = merged.variables.STRIPE_SECRET_KEY.find((e) => e.branch === 'dev')!;
    expect(mainEntry.connector).toEqual(baseConnector);
    expect(devEntry.value_hash).toBe('hash-dev2');
    expect(devEntry.connector).toBeUndefined();
  });

  test('a brand-new var on a brand-new branch starts without connector and that is fine', () => {
    const engine = new SyncEngine();
    const keep = keepWithConnector('main');

    const merged = engine.mergeWithKeep(
      keep,
      { OTHER_VAR: { resource_id: 'res-2', value_hash: 'h' } },
      'main',
    );

    expect(merged.variables.OTHER_VAR[0].connector).toBeUndefined();
    expect(merged.variables.STRIPE_SECRET_KEY[0].connector).toEqual(baseConnector);
  });

  test('entry without value_hash falls back to empty string and preserves connector', () => {
    const engine = new SyncEngine();
    const keep = keepWithConnector('main');

    const merged = engine.mergeWithKeep(
      keep,
      { STRIPE_SECRET_KEY: { resource_id: 'res-1' } },
      'main',
    );

    expect(merged.variables.STRIPE_SECRET_KEY[0].value_hash).toBe('');
    expect(merged.variables.STRIPE_SECRET_KEY[0].connector).toEqual(baseConnector);
  });
});
