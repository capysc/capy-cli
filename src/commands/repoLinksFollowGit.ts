/**
 * A project lives wherever git has a `keep.lock` carrying its `project_id`. The
 * stored repo links ("this project was seen at owner/name, folder X") only say
 * where the project was SEEN; after a `git mv` of a project's files there are
 * two of them. Both stay: each git branch gets the move at its own time, and a
 * branch that has not got it yet still needs the old one.
 *
 * For one project in one repo, on the base branch a run reads, each stored path
 * is judged by that branch's own `keep.lock` at that path (`StoredPathKind`):
 *
 *  - At least one path is present: only the present ones (and any unknown, which
 *    is not proof of anything) are planned. An absent path is not planned, so no
 *    empty keep.lock is scaffolded there.
 *  - No path is present: the stored paths are used as before (first-time setup
 *    does not change).
 *  - An `other` path is never planned: this project's entries must not be folded
 *    into another project's keep.lock.
 *
 * The write point (`keepLockPr.ts`) holds the same line again against the files
 * the base branch has at the moment of writing. Rows are never removed.
 *
 * Reading only: nothing here writes to GitHub. Never throws.
 */
import type { GithubApi, RepoRef } from '../deploy/githubApi';
import type { OrgRepoLink } from '../service/serviceClient';
import { PoolItem, runPool } from '../utils/pool';
import { RepoTarget, keepLockPathOf, repoKey, repoLabel } from './secretsSet';
import { StoredPathKind, probeKeepLockAt } from './keepLockProbe';

export { kindOfKeepText, projectIdOfKeepText, type StoredPathKind } from './keepLockProbe';

/** A stored link, as far as judging it is concerned. */
export interface StoredPath {
  readonly project_id: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** Folder of the keep.lock in the repo; `.` for the root. */
  readonly path: string;
}

/** How many keep.lock reads run at once. */
const PROBE_CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// One path
// ---------------------------------------------------------------------------

/** One stored path judged by the keep.lock `base` holds there. Any failure to read is `unknown`. */
export function probeStoredPath(github: GithubApi, path: StoredPath, base: string): Promise<StoredPathKind> {
  const repo: RepoRef = { owner: path.owner, name: path.name };
  return probeKeepLockAt(github, repo, keepLockPathOf(path.path), base, path.project_id);
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export interface Judged<T> {
  /** The paths a write may go to. */
  readonly keep: readonly T[];
  /** Paths holding another project's keep.lock: never written. */
  readonly foreign: readonly T[];
}

/** Pure. The paths of ONE project in ONE repo, each with what its base branch holds there. */
export function judgePaths<T>(entries: ReadonlyArray<{ readonly item: T; readonly kind: StoredPathKind }>): Judged<T> {
  const anyPresent = entries.some((e) => e.kind === 'present');
  const itemsOf = (wanted: (kind: StoredPathKind) => boolean): readonly T[] => entries.filter((e) => wanted(e.kind)).map((e) => e.item);
  return {
    keep: itemsOf((kind) => kind !== 'other' && (!anyPresent || kind !== 'absent')),
    foreign: itemsOf((kind) => kind === 'other'),
  };
}

const groupKeyOf = (p: StoredPath): string => `${p.project_id}\u0000${repoKey(p)}`;
const pathKeyOf = (p: StoredPath): string => `${groupKeyOf(p)}\u0000${p.path}`;

export interface Followed<T> {
  readonly keep: readonly T[];
  readonly foreign: readonly T[];
  /** The foreign paths of every project left with nothing to write to: all of its stored paths hold another project's keep.lock (or none could be written). */
  readonly blocked: readonly T[];
}

/**
 * Judges every stored path against `bases` (each repo's base branch by `repoKey`). A repo with no known base, or no
 * `github`, is not judged: its paths are kept as they are. The input order is kept.
 */
export async function followGit<T extends StoredPath>(
  github: GithubApi | undefined,
  paths: readonly T[],
  bases: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Followed<T>> {
  const judgeable = github === undefined ? [] : paths.filter((p) => bases[repoKey(p)] !== undefined);
  if (github === undefined || judgeable.length === 0) return { keep: paths, foreign: [], blocked: [] };

  const distinct = judgeable.filter((p, i) => judgeable.findIndex((o) => pathKeyOf(o) === pathKeyOf(p)) === i);
  const probed = await runPool({
    items: distinct,
    limit: PROBE_CONCURRENCY,
    stop: signal,
    run: async (p): Promise<PoolItem<StoredPathKind>> => ({ result: await probeStoredPath(github, p, bases[repoKey(p)]) }),
  });
  // A path whose read was never started (a stop) is not judged.
  const kindByPath = new Map(distinct.flatMap((p, i): Array<readonly [string, StoredPathKind]> => (probed.results[i] === undefined ? [] : [[pathKeyOf(p), probed.results[i]]])));
  const kindOf = (p: T): StoredPathKind => kindByPath.get(pathKeyOf(p)) ?? 'unknown';

  const judged = [...new Set(paths.map(groupKeyOf))].map((key) => judgePaths(paths.filter((p) => groupKeyOf(p) === key).map((item) => ({ item, kind: kindOf(item) }))));
  const kept = new Set(judged.flatMap((j) => j.keep).map(pathKeyOf));
  const once = (items: readonly T[]): readonly T[] => items.filter((p, i, all) => all.findIndex((o) => pathKeyOf(o) === pathKeyOf(p)) === i);
  return {
    keep: paths.filter((p) => kept.has(pathKeyOf(p))),
    foreign: once(judged.flatMap((j) => j.foreign)),
    blocked: once(judged.filter((j) => j.keep.length === 0).flatMap((j) => j.foreign)),
  };
}

// ---------------------------------------------------------------------------
// The links a run plans from
// ---------------------------------------------------------------------------

export interface FollowedLinks {
  /** The links a run may read and write through. */
  readonly links: readonly OrgRepoLink[];
  /** The links of projects left with nothing to write to: each holds another project's keep.lock on the base. */
  readonly blocked: readonly OrgRepoLink[];
}

/** The same rule over org links (`capy secrets deploy`). */
export async function followGitLinks(
  github: GithubApi | undefined,
  links: readonly OrgRepoLink[],
  bases: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<FollowedLinks> {
  const followed = await followGit(github, links, bases, signal);
  return { links: followed.keep, blocked: followed.blocked };
}

export interface FollowedTargets {
  readonly targets: readonly RepoTarget[];
  /**
   * `owner/name` of each repo that has a project left with nothing to write to (every stored path holds another project's
   * keep.lock on the base): reported as a failed repo with `KEEP_LOCK_PROJECT_MISMATCH`, never silently dropped.
   */
  readonly mismatched: readonly string[];
}

/**
 * The same rule over the repos a `capy secrets set` run would open a PR in: a target keeps only the folders a
 * write may go to, and a target left with none is dropped. Nothing judged to change: the very same targets back.
 */
export async function followGitTargets(
  github: GithubApi | undefined,
  targets: readonly RepoTarget[],
  bases: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<FollowedTargets> {
  const stored = targets.flatMap((t) => t.files.map((file) => ({ project_id: file.project_id, host: t.host, owner: t.owner, name: t.name, path: file.path })));
  const followed = await followGit(github, stored, bases, signal);
  const mismatched = [...new Set(followed.blocked.map((p) => repoLabel(p)))];
  if (followed.keep.length === stored.length) return { targets, mismatched };
  const kept = new Set(followed.keep.map(pathKeyOf));
  return {
    targets: targets
      .map((t) => ({ ...t, files: t.files.filter((file) => kept.has(pathKeyOf({ project_id: file.project_id, host: t.host, owner: t.owner, name: t.name, path: file.path }))) }))
      .filter((t) => t.files.length > 0),
    mismatched,
  };
}

// ---------------------------------------------------------------------------
// A write onto one base branch (`capy secrets deploy`'s keep.lock PR)
// ---------------------------------------------------------------------------

export type Placement =
  /** Write at the folder as planned. */
  | { readonly kind: 'here' }
  /** This branch keeps the project's files in another stored folder: write there. */
  | { readonly kind: 'moved'; readonly path: string }
  /** This branch has the project's keep.lock in several other stored folders and not at the planned one: nothing says which, nothing is written. */
  | { readonly kind: 'skipped' }
  /** The planned folder is not the project's here and an other stored folder could not be read: nothing can be said, nothing is written (retriable). */
  | { readonly kind: 'unreadable' };

/**
 * Where a write onto `base` goes. Judged by this branch's own files, whatever the default branch says:
 *  - the planned folder carries the project's keep.lock: there;
 *  - it does not, and exactly one other stored folder does: that one;
 *  - it does not, and another stored folder could not be read: nowhere yet (`unreadable`), whatever the rest say;
 *  - it does not, and several others do: nowhere (`skipped`);
 *  - no stored folder carries it (first-time setup), or no other folder is stored: the planned one, as before.
 * Another project's file at the planned folder, with nowhere else to go, is left to the write point, which refuses it.
 */
export async function placeOnBase(github: GithubApi, base: string, ownPath: StoredPath, others: readonly string[]): Promise<Placement> {
  if (others.length === 0) return { kind: 'here' };
  const own = await probeStoredPath(github, ownPath, base);
  if (own === 'present') return { kind: 'here' };
  const kinds = await Promise.all(others.map(async (path) => ({ path, kind: await probeStoredPath(github, { ...ownPath, path }, base) })));
  if (kinds.some((k) => k.kind === 'unknown')) return { kind: 'unreadable' };
  const living = kinds.filter((k) => k.kind === 'present');
  if (living.length === 1) return { kind: 'moved', path: living[0].path };
  return living.length > 1 ? { kind: 'skipped' } : { kind: 'here' };
}
