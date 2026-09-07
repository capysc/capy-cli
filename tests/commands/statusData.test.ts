import { describe, expect, it } from 'bun:test';
import { branchHashes, localStatusHashes, makeStatusReport } from '../../src/commands/statusData';
import { compareSecrets, hashValue } from '../../src/commands/statusComparison';

describe('status report truthfulness', () => {
  it('identifies a local deletion when remote still matches the pin', () => {
    const report = makeStatusReport({ projectName: 'p', branch: 'b', pinned: { KEY: 'hash' }, local: {}, remote: { KEY: 'hash' } });
    expect(report.diffs).toMatchObject([{ variable: 'KEY', type: 'deleted' }]);
    expect(report.localMatchesPinned).toBe(false);
    expect(report.remoteMatchesPinned).toBe(true);
  });
  it('distinguishes a genuinely empty remote from unavailable remote state', () => {
    const hashes = { TOKEN: hashValue('private-value') };
    const empty = makeStatusReport({ projectName: 'p', branch: 'b', pinned: hashes, local: hashes, remote: {} });
    expect(empty.inSync).toBe(false);
    expect(empty.diffs).toMatchObject([{ variable: 'TOKEN', type: 'deleted' }]);
    expect(empty.remoteMatchesPinned).toBe(false);
    const unavailable = makeStatusReport({ projectName: 'p', branch: 'b', pinned: hashes, local: hashes, remote: {}, remoteFailure: 'network_error' });
    expect(unavailable.inSync).toBe(false);
    expect(unavailable.remoteMatchesPinned).toBe(false);
    expect(unavailable.remoteFailure).toBe('network_error');
  });
  it('reports remote additions and changed values against the pin', () => {
    const report = makeStatusReport({ projectName: 'p', branch: 'b', pinned: { KEY: 'old' }, local: { KEY: 'old' }, remote: { KEY: 'new', EXTRA: 'hash' } });
    expect(report.diffs.map((diff) => diff.variable)).toEqual(['KEY', 'EXTRA']);
    expect(report.localMatchesPinned).toBe(true);
    expect(report.remoteMatchesPinned).toBe(false);
    expect(report.totalSecrets).toBe(2);
  });
  it('compares only hashes and never returns plaintext or encrypted values', () => {
    const local = localStatusHashes({ KEY: 'capy:encrypted', PLAIN: 'private-plain' }, () => 'private-decrypted');
    expect(local).toEqual({ KEY: hashValue('private-decrypted'), PLAIN: hashValue('private-plain') });
    expect(JSON.stringify(local)).not.toContain('private');
    expect(JSON.stringify(local)).not.toContain('capy:');
  });
  it('does not turn a decryption failure into a reported deletion', () => {
    expect(() => localStatusHashes({ KEY: 'capy:unreadable' }, () => { throw new Error('PRIVATE'); }))
      .toThrow('A local value could not be read securely');
  });
  it('selects only active-branch metadata', () => {
    const keep = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'p', variables: {
      KEY: [{ branch: 'dev', resource_id: 'r', value_hash: 'dev-hash' }, { branch: 'other', resource_id: 'r2', value_hash: 'other-hash' }],
    } };
    expect(branchHashes(keep, 'dev')).toEqual({ KEY: 'dev-hash' });
  });
  it('retains legacy empty-remote semantics only when availability is unspecified', () => {
    expect(compareSecrets({ KEY: 'hash' }, { KEY: 'hash' }, {}).diffs).toEqual([]);
    expect(compareSecrets({ KEY: 'hash' }, { KEY: 'hash' }, {}, true).diffs).toHaveLength(1);
  });
  it('reports matching lockless remote/local state as in sync', () => {
    const hashes = { KEY: hashValue('fixture') };
    expect(makeStatusReport({ projectName: 'default', branch: 'development', pinned: hashes, local: hashes, remote: hashes }).inSync).toBe(true);
  });
});
