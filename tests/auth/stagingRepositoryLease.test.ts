import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStagingRepositoryLease } from '../../src/auth/stagingRepositoryLease';

test('a second flow cannot apply to the same repository while its first flow is active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'capy-synthetic-flow-lock-'));
  try {
    await withStagingRepositoryLease('/synthetic/repo', async () => {
      await expect(withStagingRepositoryLease('/synthetic/repo', async () => 'must not execute', directory)).rejects.toThrow('FLOW_REPOSITORY_BUSY');
      expect(await withStagingRepositoryLease('/synthetic/other', async () => 'independent', directory)).toBe('independent');
    }, directory);
    expect(await withStagingRepositoryLease('/synthetic/repo', async () => 'released', directory)).toBe('released');
    await expect(withStagingRepositoryLease('/synthetic/repo', async () => { throw new Error('synthetic failure'); }, directory)).rejects.toThrow('synthetic failure');
    expect(await withStagingRepositoryLease('/synthetic/repo', async () => 'released after failure', directory)).toBe('released after failure');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
