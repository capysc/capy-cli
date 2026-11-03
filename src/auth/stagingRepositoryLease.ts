import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { lockSync } from 'proper-lockfile';
import { getGlobalCapyDir } from '../config/globalConfig';
import { FlowRuntimeError } from '../errors/flowRuntimeError';

/** Serializes staging flows for one canonical repository; the library owns the heartbeat. */
export async function withStagingRepositoryLease<T>(
  repositoryRoot: string, operation: () => Promise<T>, directory = join(getGlobalCapyDir(), 'flow-locks'),
): Promise<T> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new FlowRuntimeError('FLOW_REPOSITORY_LOCK_PERMISSIONS');
  const digest = createHash('sha256').update(repositoryRoot).digest('hex');
  const target = join(directory, digest);
  mkdirSync(target, { mode: 0o700, recursive: true });
  const targetStat = lstatSync(target);
  if (!targetStat.isDirectory() || (targetStat.mode & 0o077) !== 0 || (process.getuid && targetStat.uid !== process.getuid())) throw new FlowRuntimeError('FLOW_REPOSITORY_LOCK_PERMISSIONS');
  const release = (() => {
    try { return lockSync(target, { realpath: false, stale: 30000, update: 10000 }); }
    catch (error) {
      throw new FlowRuntimeError(error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED' ? 'FLOW_REPOSITORY_BUSY' : 'FLOW_REPOSITORY_LOCK_FAILED');
    }
  })();
  try { return await operation(); }
  finally { release(); }
}
