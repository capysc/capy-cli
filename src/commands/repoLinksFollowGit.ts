/**
 * A project lives wherever git has a `keep.lock` carrying its `project_id`. The
 * stored repo links ("this project was seen at owner/name, folder X") only say
 * where the project was SEEN; after a `git mv` of a project's files there are
 * two of them, and the old one is stale.
 *
 * For one project in one repo, on the base branch a run reads, each stored path
 * is judged by that branch's own `keep.lock` at that path:
 *
 *   present   the file exists and carries this project's id        (a)
 *   absent    no file there                                         (b)
 *   other     the file exists and carries ANOTHER project's id      (c)
 *   unknown   it could not be read, or has no readable project id
 *
 * The rule (`judgePaths`):
 *  - At least one path is present: only the present ones (and any unknown, which
 *    is not proof of anything) are written. An absent path is never written, so
 *    no empty keep.lock is scaffolded there.
 *  - No path is present: the stored paths are used as before (first-time setup
 *    does not change).
 *  - An `other` path is never written, in either case: this project's entries
 *    must not be folded into another project's keep.lock.
 *
 * A stale link (absent, while a present one exists for the same project and
 * repo) is reported only when the evidence is the repo's DEFAULT branch, and
 * `deleteStaleLinks` then asks the service to forget it, best effort. A project's
 * last link is never stale: a present link always remains.
 *
 * Reading only: nothing here writes to GitHub. Never throws.
 */
import type { GithubApi, RepoRef } from '../deploy/githubApi';
import type { KeepFile } from '../types/index';
import type { KnownRepo, OrgRepoLink, ServiceClient } from '../service/serviceClient';
import { PoolItem, runPool } from '../utils/pool';
import { RepoTarget, keepLockPathOf, repoKey } from './secretsSet';

export type StoredPathKind = 'present' | 'absent' | 'other' | 'unknown';

/** A stored link, as far as judging it is concerned. */
export interface StoredPath {
  readonly project_id: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** Folder of the keep.lock in the repo; `.` for the root. */
  readonly path: string;
}

/** Whose branch the judgement was read from: only the repo's default branch may lead to a deletion. */
export type Evidence = 'default' | 'other';

/** How many keep.lock reads run at once. */
const PROBE_CONCURRENCY = 6;
/** The service's own timeout for one best-effort delete. */
const DELETE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// One path
// ---------------------------------------------------------------------------

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
  if (found === undefined) return 'unknown';
  return found === projectId ? 'present' : 'other';
}

/** One path judged by the keep.lock `base` holds there. Any failure to read is `unknown`. */
export async function probeStoredPath(github: GithubApi, path: StoredPath, base: string): Promise<StoredPathKind> {
  const repo: RepoRef = { owner: path.owner, name: path.name };
  const read = await Promise.resolve()
    .then(() => github.getFile(repo, keepLockPathOf(path.path), base))
    .then(
      (got) => got,
      () => undefined,
    );
  if (read === undefined || !read.ok) return 'unknown';
  return read.value === null ? 'absent' : kindOfKeepText(read.value, path.project_id);
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export interface Judged<T> {
  /** The paths a write may go to. */
  readonly keep: readonly T[];
  /** Absent paths while a present one exists: the links that no longer say where the project lives. */
  readonly stale: readonly T[];
  /** Paths holding another project's keep.lock: never written, never deleted. */
  readonly foreign: readonly T[];
}

/** Pure. The paths of ONE project in ONE repo, each with what its base branch holds there. */
export function judgePaths<T>(entries: ReadonlyArray<{ readonly item: T; readonly kind: StoredPathKind }>): Judged<T> {
  const anyPresent = entries.some((e) => e.kind === 'present');
  const itemsOf = (wanted: (kind: StoredPathKind) => boolean): readonly T[] => entries.filter((e) => wanted(e.kind)).map((e) => e.item);
  return {
    keep: itemsOf((kind) => kind !== 'other' && (!anyPresent || kind !== 'absent')),
    stale: anyPresent ? itemsOf((kind) => kind === 'absent') : [],
    foreign: itemsOf((kind) => kind === 'other'),
  };
}

const groupKeyOf = (p: StoredPath): string => `${p.project_id}\u0000${repoKey(p)}`;
const pathKeyOf = (p: StoredPath): string => `${groupKeyOf(p)}\u0000${p.path}`;

export interface Followed<T> {
  readonly keep: readonly T[];
  /** Empty unless the evidence is the default branch. */
  readonly stale: readonly T[];
  readonly foreign: readonly T[];
}

/**
 * Judges every stored path against `bases` (each repo's base branch by `repoKey`; `evidence` says whether
 * those are default branches). A repo with no known base, or no `github`, is not judged: its paths are kept
 * as they are. The input order is kept.
 */
export async function followGit<T extends StoredPath>(
  github: GithubApi | undefined,
  paths: readonly T[],
  bases: Readonly<Record<string, string>>,
  evidence: Evidence,
  signal?: AbortSignal,
): Promise<Followed<T>> {
  const judgeable = github === undefined ? [] : paths.filter((p) => bases[repoKey(p)] !== undefined);
  if (github === undefined || judgeable.length === 0) return { keep: paths, stale: [], foreign: [] };

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

  const groups = [...new Set(paths.map(groupKeyOf))].map((key) => judgePaths(paths.filter((p) => groupKeyOf(p) === key).map((item) => ({ item, kind: kindOf(item) }))));
  const once = (items: readonly T[]): readonly T[] => items.filter((p, i) => items.findIndex((o) => pathKeyOf(o) === pathKeyOf(p)) === i);
  const stale = once(groups.flatMap((g) => g.stale));
  const foreign = once(groups.flatMap((g) => g.foreign));
  const dropped = new Set([...stale, ...foreign].map(pathKeyOf));
  return {
    keep: paths.filter((p) => !dropped.has(pathKeyOf(p))),
    stale: evidence === 'default' ? stale : [],
    foreign,
  };
}

// ---------------------------------------------------------------------------
// The links a run plans from
// ---------------------------------------------------------------------------

export interface FollowedLinks {
  readonly links: readonly OrgRepoLink[];
  /** The links to forget (default-branch evidence only). */
  readonly stale: readonly OrgRepoLink[];
}

/** The same rule over org links (`capy secrets deploy`): the links a run may read and write through. */
export async function followGitLinks(
  github: GithubApi | undefined,
  links: readonly OrgRepoLink[],
  bases: Readonly<Record<string, string>>,
  evidence: Evidence,
  signal?: AbortSignal,
): Promise<FollowedLinks> {
  const followed = await followGit(github, links, bases, evidence, signal);
  return { links: followed.keep, stale: followed.stale };
}

export interface FollowedTargets {
  readonly targets: readonly RepoTarget[];
  readonly stale: readonly StoredPath[];
}

/**
 * The same rule over the repos a `capy secrets set` run would open a PR in: a target keeps only the folders a
 * write may go to, and a target left with none is dropped. Nothing judged to change: the very same targets back.
 */
export async function followGitTargets(
  github: GithubApi | undefined,
  targets: readonly RepoTarget[],
  bases: Readonly<Record<string, string>>,
  evidence: Evidence,
  signal?: AbortSignal,
): Promise<FollowedTargets> {
  const stored = targets.flatMap((t) => t.files.map((file) => ({ project_id: file.project_id, host: t.host, owner: t.owner, name: t.name, path: file.path })));
  const followed = await followGit(github, stored, bases, evidence, signal);
  if (followed.keep.length === stored.length) return { targets, stale: followed.stale };
  const kept = new Set(followed.keep.map(pathKeyOf));
  const narrowed = targets
    .map((t) => ({ ...t, files: t.files.filter((file) => kept.has(pathKeyOf({ project_id: file.project_id, host: t.host, owner: t.owner, name: t.name, path: file.path }))) }))
    .filter((t) => t.files.length > 0);
  return { targets: narrowed, stale: followed.stale };
}

// ---------------------------------------------------------------------------
// Forgetting stale links
// ---------------------------------------------------------------------------

/** What the service client offers for forgetting one link. */
export type LinkDeleter = Pick<ServiceClient, 'deleteProjectRepo'>;

/**
 * Asks the service to forget each stale link. Best effort, and silent: a failure (network, 403, an older
 * service with no such route) is dropped and changes nothing the command reports. A client with no such
 * call does nothing. Never throws.
 */
export async function deleteStaleLinks(
  client: Partial<LinkDeleter> | undefined,
  orgId: string,
  stale: readonly StoredPath[],
): Promise<void> {
  const deleteOne = client?.deleteProjectRepo;
  if (deleteOne === undefined || stale.length === 0) return;
  const distinct = stale.filter((p, i) => stale.findIndex((o) => pathKeyOf(o) === pathKeyOf(p)) === i);
  await Promise.all(
    distinct.map((p) => {
      const link: KnownRepo = { host: p.host, owner: p.owner, name: p.name, path: p.path };
      return Promise.resolve()
        .then(() => deleteOne.call(client, orgId, p.project_id, link, DELETE_TIMEOUT_MS))
        .then(
          () => undefined,
          () => undefined,
        );
    }),
  );
}

// ---------------------------------------------------------------------------
// A write onto one base branch (`capy secrets deploy`'s keep.lock PR)
// ---------------------------------------------------------------------------

/** What the base holds at the planned folder: no file, this project's, or another's. */
function kindOfOwn(own: { readonly existed: boolean; readonly keep: Pick<KeepFile, 'project_id'> }, projectId: string): StoredPathKind {
  if (!own.existed) return 'absent';
  return own.keep.project_id === projectId ? 'present' : 'other';
}

export type Placement =
  /** Write at the folder as planned. */
  | { readonly kind: 'here' }
  /** This branch keeps the project's files in another stored folder: write there. */
  | { readonly kind: 'moved'; readonly path: string }
  /** The folder holds another project's keep.lock and the project has nowhere else on this branch. */
  | { readonly kind: 'refused' };

/**
 * Where a write onto `base` goes: `ownPath` as planned, or, when this base branch does not carry the project's
 * keep.lock there (a move that has not reached this branch), the one other stored folder that does. Judged by this
 * branch's own files, whatever the default branch says. `own` is what the base holds at `ownPath` (already read).
 */
export async function placeOnBase(
  github: GithubApi,
  base: string,
  ownPath: StoredPath,
  own: { readonly existed: boolean; readonly keep: Pick<KeepFile, 'project_id'> },
  others: readonly string[],
): Promise<Placement> {
  const ownKind = kindOfOwn(own, ownPath.project_id);
  if (ownKind === 'present') return { kind: 'here' };
  const kinds = await Promise.all(others.map(async (path) => ({ path, kind: await probeStoredPath(github, { ...ownPath, path }, base) })));
  const living = kinds.filter((k) => k.kind === 'present');
  if (living.length === 1) return { kind: 'moved', path: living[0].path };
  return ownKind === 'other' ? { kind: 'refused' } : { kind: 'here' };
}
