import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lock } from 'proper-lockfile';

/** Serialize refresh + persistence, including the first write of a session. */
export async function withSessionLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lock(path, {
    // Lock the stable pathname, even before the first session file exists.
    realpath: false,
    retries: { retries: 8, minTimeout: 100, maxTimeout: 500 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
