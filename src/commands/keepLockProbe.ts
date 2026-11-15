/**
 * What a base branch holds at one keep.lock path, judged for one project: the leaf both the
 * write point (`keepLockPr.ts`) and the stored-link rule (`repoLinksFollowGit.ts`) build on.
 * Reading only. Never throws: a read that fails is `unknown`.
 */
import type { GithubApi, RepoRef } from '../deploy/githubApi';

/**
 *   present   the file exists and carries this project's id
 *   absent    no file there
 *   other     the file exists and carries ANOTHER project's id
 *   unknown   it could not be read, or has no readable project id
 */
export type StoredPathKind = 'present' | 'absent' | 'other' | 'unknown';

/** The project id a keep.lock's text carries, or `undefined` when it is not readable. */
export function projectIdOfKeepText(raw: string): string | undefined {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  })();
  const id = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).project_id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** What a keep.lock's text says about `projectId`: present (its own), other (someone else's) or unknown. */
export function kindOfKeepText(raw: string, projectId: string): StoredPathKind {
  const found = projectIdOfKeepText(raw);
  // Both ids must be known to call the file anyone's: a side with no id says nothing.
  if (found === undefined || typeof projectId !== 'string' || projectId.length === 0) return 'unknown';
  return found === projectId ? 'present' : 'other';
}

/** The file at `filePath` (a repo path, e.g. `backend/keep.lock`) on `base`, judged for `projectId`. */
export async function probeKeepLockAt(
  github: GithubApi,
  repo: RepoRef,
  filePath: string,
  base: string,
  projectId: string,
): Promise<StoredPathKind> {
  const read = await Promise.resolve()
    .then(() => github.getFile(repo, filePath, base))
    .then(
      (got) => got,
      () => undefined,
    );
  if (read === undefined || !read.ok) return 'unknown';
  return read.value === null ? 'absent' : kindOfKeepText(read.value, projectId);
}
