import { SyncEngine } from '../../src/sync/syncEngine';
import { KeepFile } from '../../src/types/index';

describe('SyncEngine', () => {
  let syncEngine: SyncEngine;

  beforeEach(() => {
    syncEngine = new SyncEngine();
  });

  describe('mergeWithKeep', () => {
    test('should update existing variables in keep', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test',
        variables: {
          EXISTING_VAR: [
            { resource_id: 'res_old', value_hash: 'abc12345', branch: 'development' },
          ]
        }
      };

      const pushedVariables = {
        EXISTING_VAR: { resource_id: 'res_new', value_hash: 'newhash123' }
      };

      const result = syncEngine.mergeWithKeep(keep, pushedVariables);

      expect(result.variables.EXISTING_VAR[0].resource_id).toBe('res_new');
      expect(result.variables.EXISTING_VAR[0].value_hash).toBe('newhash123');
    });

    test('should add new variables to keep', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org_123',
        project_id: 'proj_456',
        project_name: 'test',
        variables: {}
      };

      const pushedVariables = {
        NEW_VAR: { resource_id: 'res_123', value_hash: 'hash1' }
      };

      const result = syncEngine.mergeWithKeep(keep, pushedVariables);

      expect(result.variables.NEW_VAR).toBeDefined();
      expect(result.variables.NEW_VAR[0].resource_id).toBe('res_123');
    });
  });

  describe('computeKeepHash', () => {
    it('produces deterministic hash', () => {
      const keep: KeepFile = {
        version: '3.0',
        org_id: 'org1',
        project_id: 'proj1',
        project_name: 'test',
        variables: {
          DB_URL: [{ resource_id: 'abc', value_hash: 'hash1', branch: 'development' }],
          API_KEY: [{ resource_id: 'def', value_hash: 'hash3', branch: 'development' }],
        },
      };
      expect(SyncEngine.computeKeepHash(keep)).toBe(SyncEngine.computeKeepHash(keep));
    });

    it('is order-independent on variable keys', () => {
      const keepA: KeepFile = {
        version: '3.0', org_id: 'o', project_id: 'p', project_name: 't',
        variables: {
          API_KEY: [{ resource_id: 'def', value_hash: 'h2', branch: 'development' }],
          DB_URL: [{ resource_id: 'abc', value_hash: 'h1', branch: 'development' }],
        },
      };
      const keepB: KeepFile = {
        version: '3.0', org_id: 'o', project_id: 'p', project_name: 't',
        variables: {
          DB_URL: [{ resource_id: 'abc', value_hash: 'h1', branch: 'development' }],
          API_KEY: [{ resource_id: 'def', value_hash: 'h2', branch: 'development' }],
        },
      };
      expect(SyncEngine.computeKeepHash(keepA)).toBe(SyncEngine.computeKeepHash(keepB));
    });

    it('produces different hashes for different branch values', () => {
      const keep: KeepFile = {
        version: '3.0', org_id: 'o', project_id: 'p', project_name: 't',
        variables: {
          DB_URL: [
            { resource_id: 'abc', value_hash: 'h1', branch: 'development' },
            { resource_id: 'abc', branch: 'staging', value_hash: 'h2' },
          ],
        },
      };
      // Default branch hash should differ from staging branch hash because value_hash differs
      expect(SyncEngine.computeKeepHash(keep)).not.toBe(SyncEngine.computeKeepHash(keep, 'staging'));
    });

    it('returns 64-char hex for empty variables', () => {
      const keep: KeepFile = {
        version: '3.0', org_id: 'o', project_id: 'p', project_name: 't',
        variables: {},
      };
      expect(SyncEngine.computeKeepHash(keep)).toHaveLength(64);
    });

    it('changes when value_hash changes', () => {
      const makeKeep = (hash: string): KeepFile => ({
        version: '3.0', org_id: 'o', project_id: 'p', project_name: 't',
        variables: { DB_URL: [{ resource_id: 'abc', value_hash: hash, branch: 'development' }] },
      });
      expect(SyncEngine.computeKeepHash(makeKeep('a'))).not.toBe(SyncEngine.computeKeepHash(makeKeep('b')));
    });
  });
});