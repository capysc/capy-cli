/**
 * Discovery mode for `capy connect dokploy --discover` (CAP-657 follow-up).
 *
 * Every one of the target org's Dokploy services is Compose, not
 * Application — and there are MANY of them, across MANY Dokploy projects and
 * environments. Rather than the human typing `--application`/`--compose`
 * once per service, discovery finds every Dokploy service whose git source
 * matches a repo reachable from `cwd`, groups them into Capy projects (one
 * per Dokploy project+service, folder = the deepest directory its compose
 * files share — nested services fold into their ancestor's folder as extra
 * branches instead, see "Nested folders" below), maps each Dokploy
 * ENVIRONMENT to a Capy BRANCH, and — for a real (non-dry-run), confirmed
 * run — RUNS THE EXISTING GIT-MODEL COMMANDS, per folder, in order: init
 * the folder's project if it has none yet, then per environment (staging
 * first, then any others alphabetically, production LAST) checkout that
 * branch and run the single-service import on it.
 *
 * 2026-09-26 REWRITE (Vince): the previous design had discovery itself
 * compute a multi-branch "apply plan" (inheritance chains, first-import
 * clear/replace/import) against baselines it fetched and cached itself. That
 * had three real defects (local-keep.lock-based first-import detection could
 * clear live server data on a fresh clone; a swallowed fetch error defaulted
 * to `{}` and then pruned a whole branch; the plan preview and the apply
 * could diverge) and was scrapped rather than patched a fourth time.
 * Discovery is now a PLANNER + SEQUENCER only: it never computes a
 * clear/replace/import plan itself, and it never touches Dokploy vars past
 * what `--compose`/`--application`'s own single-service import (below, and
 * in `dokploy.ts`) already does. The only new behaviour that import gained
 * for this is `--overwrite` (see `dokploy.ts#computeOverwritePlan`) — a
 * flag usable standalone too, not something discovery invented for itself.
 * Discovery DOES decide, per step, whether to pass `--overwrite`
 * automatically — see "Auto-overwrite", below — but the actual clear/
 * replace/import computation still happens entirely inside `import()`.
 *
 * Environment order (2026-09-26, Vince): STAGING first (if present), then
 * any OTHER environments alphabetically (e.g. `preview`), PRODUCTION last
 * (if present) — never "production first". A service that only has some of
 * these environments just runs the steps it has, in this same relative
 * order (production-only = one step). Production is created from whatever
 * branch the previous step left the folder on, the same git-model copy
 * `capy checkout -b` performs — and, since it's last, that is always the
 * folder's FINAL branch. See `orderEnvironments`.
 *
 * Auto-overwrite (2026-09-26, Vince): when a step's checkout CREATES the
 * branch — i.e. it's a git-model COPY of the previous branch, never a
 * branch that already existed before this run — that step's import runs
 * with `--overwrite` automatically, still listed by name and confirmed (or
 * `--yes`) exactly like a user-passed `--overwrite`. A branch that already
 * EXISTED before the run is only overwritten if the human passed
 * `--overwrite` themselves. The FIRST environment of a brand-new project is
 * the one exception: its checkout also "creates" the branch, but there is
 * nothing to overwrite yet (an empty project has no prior branch to copy),
 * so it is a plain import. See `runDiscoverySequence`.
 *
 * Nested folders (2026-09-26, Vince, decision #8): when one matched
 * service's folder lies INSIDE another's, in the SAME Dokploy project and
 * the SAME repo (e.g. `backend-preview`'s `backend/deployment/develop/`
 * inside `backend-stack`'s `backend/deployment/`), the inner service joins
 * the OUTER folder's Capy project as branch(es) named after its own
 * environment(s), instead of becoming a nested project of its own. A joined
 * branch that collides with a branch the outer group already has is a
 * genuine collision — asked about (or refused non-interactively) exactly
 * like any other mapping collision. Two services that merely compute the
 * SAME folder by coincidence (neither is a proper subfolder of the other)
 * are NOT "nested" — that stays the pre-existing "same folder, different
 * service" collision case, unaffected by this rule. See `mergeNestedFolders`.
 *
 * READ-ONLY on the Dokploy side, same as the single-service import: this
 * module only ever calls `listProjects` (`GET project.all`), `getApplication`
 * (`GET application.one`) and `getCompose` (`GET compose.one`) — never a
 * write. Read-only on the LOCAL git side too, with one exception: after a
 * REAL (non-dry-run) run, discovery commits the keep.lock/.gitignore files
 * IT ITSELF wrote onto a new branch (see `../../git/discoveryCommit.ts`) —
 * never pushed, never touching `.env`, never anything the run didn't write
 * itself. Every other git call here remains read-only (`remote get-url`,
 * `rev-parse --is-inside-work-tree`, `rev-parse --show-toplevel`). Discovery
 * DOES call Capy's own service (`listBranches`, `listProjects`,
 * `initializeProject`, `createBranch`, `getDecryptData`) — that surface was
 * never part of the "read-only on Dokploy" rule, which is about the
 * third-party API, not Capy's own.
 *
 * `project.all`'s shape is CONFIRMED LIVE (2026-09-26): a read-only inventory
 * ran against exactly the shape `fetchAllServiceDetails` (below) expects and
 * found 49 compose services. `application.one`'s git-source detail fields
 * remain UNVERIFIED — see `DokployApplication`'s own doc in `dokployApi.ts`
 * — assumed symmetrical with `compose.one`'s (which WAS checked live).
 *
 * Decisions, stated plainly rather than as open questions:
 *   - A non-git source is `sourceType: 'raw'`, or missing `owner`/
 *     `repository` outright (e.g. a Docker-image service) — reported
 *     `no_git_source`, never guessed at.
 *   - GitLab subgroups (`group/subgroup/repo`) collapse to the immediate
 *     parent as `owner` in remote-URL parsing — a known simplification, not
 *     a full subgroup path (see `parseGitRemoteUrl`).
 *   - `--application`/`--compose` under `--discover` (a collision
 *     disambiguator, not an import source — see `ConnectOpts.discover`'s
 *     doc) resolve to ONE preferred id as `opts.application ?? opts.compose`
 *     when both are somehow passed together.
 *   - A repo whose remote can't be READ (as opposed to "has no `origin`") —
 *     most commonly `git`'s own "detected dubious ownership" refusal when
 *     the CLI runs as a different uid than the repo's owner (a live
 *     sandbox defect, 2026-09-26) — is reported per repo with
 *     `DOKPLOY_REMOTE_UNREADABLE` and git's own reason (names only, NEVER
 *     parsed to decide anything — only exit status ever is), rather than
 *     silently producing `no_remote_match` for every one of its services.
 *   - `repoDir` is always the git repo's TOP-LEVEL directory
 *     (`git rev-parse --show-toplevel`), never whatever subfolder `cwd`
 *     happened to be run from — running discovery from inside a repo's
 *     subfolder (e.g. `backend/`) must compute folders relative to the
 *     REPO ROOT, exactly as running it from the root would (a live sandbox
 *     defect, 2026-09-26).
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, posix } from 'node:path';
import { DokployClient, DokployProjectSummary, listImportableEntries, sortedCopy } from '../../deploy/dokployApi';
import { isReservedProjectName } from '../../system/reservedProjectName';
import { KeepFile } from '../../types/index';
import type { AuthService } from '../../auth/authService';
import type { ServiceClient } from '../../service/serviceClient';
import type { ImportOutcome } from './registry';
import type { DiscoveryCommitOutcome } from '../../git/discoveryCommit';

/**
 * The context `capy connect dokploy --discover` runs with — deliberately
 * LIGHTER than the single-service import's `ResolvedContext`: org + auth +
 * serviceClient only, no project key, no keep.lock, no `.env` decrypt.
 * Discovery's whole point is running from BEFORE any of those exist — an
 * uninitialized clone, or a parent folder of several repos — so requiring
 * them up front (as `resolveContext()` does, exiting "No keep.lock found"
 * outside an initialized project) would defeat it. Each discovered FOLDER
 * resolves its own project key once its project is known to exist (see
 * `DiscoverySequenceDeps.ensureProject`).
 */
export interface DiscoveryContext {
  orgId: string;
  userId: string;
  authService: AuthService;
  serviceClient: ServiceClient;
}

// ── Git remote reading (read-only: `remote get-url`, `rev-parse`) ─────────

export interface GitRemoteRef {
  host: string;
  owner: string;
  repo: string;
}

function runGitReadOnly(args: readonly string[], cwd: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

/**
 * Parses an `origin`-style remote URL — SSH shorthand (`git@host:owner/repo`),
 * `ssh://` or `https://` — into `{ host, owner, repo }`, lowercased, with a
 * trailing `.git` stripped. GitLab subgroups (`group/subgroup/repo`) collapse
 * to the immediate parent as `owner` — a known simplification, not a full
 * subgroup path. Returns null for anything else (e.g. a local filesystem
 * remote).
 */
export function parseGitRemoteUrl(raw: string): GitRemoteRef | null {
  const trimmed = raw.trim();
  const urlForm = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  const scpForm = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(trimmed);
  const m = urlForm ?? scpForm;
  if (!m) return null;
  const host = m[1].toLowerCase();
  const path = m[2].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1].toLowerCase();
  const owner = parts[parts.length - 2].toLowerCase();
  if (!repo || !owner) return null;
  return { host, owner, repo };
}

/** `.git` present on disk at `dir` — the fs-level signal that a git command failing there is a real ERROR, never "not a repo" (immune to git's own "dubious ownership" refusal, which is a git-level check, not an fs one). */
function hasDotGit(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * `cwd` itself when it has a `.git` entry; otherwise its immediate child
 * directories that do — never a deeper recursive scan.
 */
function listChildDirs(cwd: string): readonly string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(cwd, d.name));
  } catch {
    return [];
  }
}

export type RepoProbeResult =
  | { kind: 'ok'; repoRoot: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'not_a_repo' };

/**
 * Probes exactly one directory: is it (part of) a readable git repo, and if
 * so, what is its TOP-LEVEL directory (`git rev-parse --show-toplevel` —
 * never assumes `dir` itself is the root; running discovery from a
 * subfolder must still compute folders relative to the repo root, a live
 * sandbox defect fix). `.git` existing on disk at `dir` but git itself
 * refusing to read it (most commonly "detected dubious ownership" when the
 * CLI runs as a different uid than the repo's owner) is `'unreadable'` —
 * never silently `'not_a_repo'`. `message` is git's own stderr, for DISPLAY
 * only — every decision here branches on exit status (`code`) alone, never
 * on this text.
 */
function probeRepoDir(dir: string): RepoProbeResult {
  const insideCheck = runGitReadOnly(['rev-parse', '--is-inside-work-tree'], dir);
  if (insideCheck.code === 0) {
    const topLevel = runGitReadOnly(['rev-parse', '--show-toplevel'], dir);
    if (topLevel.code === 0 && topLevel.stdout.trim()) {
      return { kind: 'ok', repoRoot: topLevel.stdout.trim() };
    }
    // `rev-parse --is-inside-work-tree` succeeded but `--show-toplevel`
    // somehow didn't (very rare) — a real error, never "not a repo".
    return { kind: 'unreadable', message: topLevel.stderr.trim() || `git exited ${topLevel.code}` };
  }
  if (hasDotGit(dir)) {
    return { kind: 'unreadable', message: insideCheck.stderr.trim() || `git exited ${insideCheck.code}` };
  }
  return { kind: 'not_a_repo' };
}

/** `cwd` itself when it's a readable repo (its TOP-LEVEL dir, never a subfolder); otherwise its immediate child directories that are — never a deeper recursive scan. Silently drops unreadable repos — see `findCandidateReposResult` for the error-carrying version discovery's own plan-building uses. */
export function findCandidateRepoDirs(cwd: string): readonly string[] {
  const self = probeRepoDir(cwd);
  if (self.kind === 'ok') return [self.repoRoot];
  if (self.kind === 'unreadable') return [];
  return listChildDirs(cwd).flatMap((c) => {
    const probe = probeRepoDir(c);
    return probe.kind === 'ok' ? [probe.repoRoot] : [];
  });
}

/** `origin`'s remote for a directory KNOWN to be a readable repo — `null` when there's no `origin`, or its URL doesn't parse (unchanged, ordinary "no match" territory). */
function readOriginRemote(repoRoot: string): GitRemoteRef | null {
  const r = runGitReadOnly(['remote', 'get-url', 'origin'], repoRoot);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return parseGitRemoteUrl(r.stdout);
}

export interface CandidateRepo {
  repoDir: string;
  remote: GitRemoteRef;
}

export interface DiscoveryRemoteReadError {
  repoDir: string;
  /** Stable refusal code — branch on this, never on `message`. */
  code: 'DOKPLOY_REMOTE_UNREADABLE';
  /** git's own stderr (or a fallback naming its exit code) — for display only. */
  message: string;
}

export interface CandidateReposResult {
  repos: readonly CandidateRepo[];
  /** Repos git itself refused to read (see `probeRepoDir`'s doc) — reported explicitly, never silently absorbed into "no match". */
  unreadable: readonly DiscoveryRemoteReadError[];
}

/**
 * Every candidate repo dir under `cwd` that has a parseable `origin` remote,
 * PLUS every repo directory git itself refused to read (`.git` present on
 * disk, but a git command there failed) — reported as `unreadable` rather
 * than silently producing no match for that repo's services (the exact
 * defect a live sandbox run hit: git's "dubious ownership" refusal made
 * every single service come back `no_remote_match`).
 */
export function findCandidateReposResult(cwd: string): CandidateReposResult {
  const self = probeRepoDir(cwd);
  if (self.kind === 'unreadable') {
    return { repos: [], unreadable: [{ repoDir: cwd, code: 'DOKPLOY_REMOTE_UNREADABLE', message: self.message }] };
  }
  if (self.kind === 'ok') {
    const remote = readOriginRemote(self.repoRoot);
    return { repos: remote ? [{ repoDir: self.repoRoot, remote }] : [], unreadable: [] };
  }
  const childProbes = listChildDirs(cwd).map((dir) => ({ dir, probe: probeRepoDir(dir) }));
  return {
    repos: childProbes.flatMap(({ probe }) => {
      if (probe.kind !== 'ok') return [];
      const remote = readOriginRemote(probe.repoRoot);
      return remote ? [{ repoDir: probe.repoRoot, remote }] : [];
    }),
    unreadable: childProbes.flatMap(({ dir, probe }) =>
      probe.kind === 'unreadable' ? [{ repoDir: dir, code: 'DOKPLOY_REMOTE_UNREADABLE' as const, message: probe.message }] : [],
    ),
  };
}

/** Every candidate repo dir under `cwd` that has a parseable `origin` remote. Kept for callers that don't need the unreadable-repo distinction — `findCandidateReposResult` is what `buildDiscoveryPlan`'s caller actually uses. */
export function findCandidateRepos(cwd: string): readonly CandidateRepo[] {
  return findCandidateReposResult(cwd).repos;
}

// ── Folder computation ──────────────────────────────────────────────────────

/** Forward-slashed, `./`-stripped, no trailing slash. */
export function normalizeRelativeDir(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\/+/, '');
  // `posix.dirname('docker-compose.yml')` is `'.'` (current directory) — the
  // same "repo root" `''` already means everywhere else in this module.
  return cleaned === '.' ? '' : cleaned;
}

/** The deepest directory every one of `dirs` shares. `''` (repo root) when any input is `''`, or on no common prefix. */
export function deepestCommonDir(dirs: readonly string[]): string {
  const normalized = dirs.map(normalizeRelativeDir);
  if (normalized.some((d) => d === '')) return '';
  const segLists = normalized.map((d) => d.split('/').filter(Boolean));
  const shortest = Math.min(...segLists.map((s) => s.length));
  // The first index where not every list agrees with the first list's own
  // segment — everything before it is the common prefix. `findIndex` over a
  // generated index range replaces a mutable accumulator + manual `break`.
  const firstMismatch = Array.from({ length: shortest }, (_, i) => i).findIndex(
    (i) => !segLists.every((s) => s[i] === segLists[0][i]),
  );
  const commonLength = firstMismatch === -1 ? shortest : firstMismatch;
  return segLists[0].slice(0, commonLength).join('/');
}

/** A Compose service's folder is its compose file's directory; an Application's is the repo root (`''`). */
export function serviceFolder(service: { serviceKind: 'application' | 'compose'; composePath?: string }): string {
  if (service.serviceKind === 'application' || !service.composePath) return '';
  return normalizeRelativeDir(posix.dirname(normalizeRelativeDir(service.composePath)));
}

/** True when `inner`'s folder is a PROPER subfolder of `outer`'s — never equal (two coincidentally-equal folders are the pre-existing "same folder, different service" collision case, not nesting). Repo root `''` is a proper ancestor of every non-root folder. */
function isProperSubfolder(inner: string, outer: string): boolean {
  if (inner === outer) return false;
  if (outer === '') return true;
  return inner.startsWith(`${outer}/`);
}

// ── Default project naming (mirrors `ProjectManager.getDefaultProjectName`) ─

/**
 * `<repo>/<folder>`, or just `<repo>` at repo root — normalized exactly like
 * `ProjectManager.getDefaultProjectName()` (lowercase, non-alnum → `-`,
 * collapsed, trimmed), and refusing the same reserved name.
 */
export function defaultDiscoveryProjectName(repoDir: string, folder: string): string {
  const raw = folder ? `${basename(repoDir)}/${folder}` : basename(repoDir);
  if (isReservedProjectName(raw)) return 'my-project';
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'my-project';
  if (isReservedProjectName(normalized)) return 'my-project';
  return normalized;
}

// ── Matching Dokploy services to repos ──────────────────────────────────────

export type DiscoveryServiceKind = 'application' | 'compose';

interface ServiceDetail {
  projectName: string;
  environmentId: string;
  environmentName: string;
  serviceId: string;
  serviceKind: DiscoveryServiceKind;
  serviceName: string;
  sourceType?: string;
  owner?: string;
  repository?: string;
  branch?: string;
  composePath?: string;
  rawEnv: string | null;
}

export type DiscoveryUnmatchedReason = 'no_git_source' | 'no_remote_match';

export interface DiscoveryUnmatched {
  projectName: string;
  serviceName: string;
  serviceKind: DiscoveryServiceKind;
  serviceId: string;
  reason: DiscoveryUnmatchedReason;
}

interface MatchedService extends ServiceDetail {
  repoDir: string;
}

/** `listProjects`/`getApplication`/`getCompose` only — the read-only surface discovery needs from a `DokployClient`. */
export type DiscoveryDokployClient = Pick<DokployClient, 'listProjects' | 'getApplication' | 'getCompose'>;

function serviceDisplayName(ref: { name?: string; appName?: string; id: string }): string {
  return ref.name ?? ref.appName ?? ref.id;
}

/** Every service across every project/environment, with full detail (`GET application.one`/`GET compose.one` each). Sequential — deterministic call order for tests, and gentle on the Dokploy instance. */
interface ServiceRefContext {
  projectName: string;
  environmentId: string;
  environmentName: string;
  serviceId: string;
  serviceKind: DiscoveryServiceKind;
  serviceName: string;
}

/** Every (project, environment, service-ref) triple, flattened — the fetch loop below reduces over this list rather than nesting three loops with a mutable accumulator. */
function flattenServiceRefs(projects: readonly DokployProjectSummary[]): readonly ServiceRefContext[] {
  return projects.flatMap((project) =>
    project.environments.flatMap((env) => [
      ...env.applications.map((ref) => ({
        projectName: project.name,
        environmentId: env.environmentId,
        environmentName: env.name,
        serviceId: ref.id,
        serviceKind: 'application' as const,
        serviceName: serviceDisplayName(ref),
      })),
      ...env.composes.map((ref) => ({
        projectName: project.name,
        environmentId: env.environmentId,
        environmentName: env.name,
        serviceId: ref.id,
        serviceKind: 'compose' as const,
        serviceName: serviceDisplayName(ref),
      })),
    ]),
  );
}

async function fetchAllServiceDetails(client: DiscoveryDokployClient): Promise<readonly ServiceDetail[]> {
  const projects = await client.listProjects();
  const refs = flattenServiceRefs(projects);
  // Sequential (not parallel): deterministic call order for tests, and
  // gentle on the Dokploy instance. A `.reduce` over a promise keeps that
  // order without a mutable accumulator — same pattern the single-service
  // import's own conflict-classification reduce uses.
  return refs.reduce<Promise<readonly ServiceDetail[]>>(async (accPromise, ref) => {
    const acc = await accPromise;
    if (ref.serviceKind === 'application') {
      const app = await client.getApplication(ref.serviceId);
      return [
        ...acc,
        {
          ...ref,
          sourceType: app.sourceType,
          owner: app.owner,
          repository: app.repository,
          branch: app.branch,
          rawEnv: app.env,
        },
      ];
    }
    const compose = await client.getCompose(ref.serviceId);
    return [
      ...acc,
      {
        ...ref,
        sourceType: compose.sourceType,
        owner: compose.owner,
        repository: compose.repository,
        branch: compose.branch,
        composePath: compose.composePath,
        rawEnv: compose.env,
      },
    ];
  }, Promise.resolve([]));
}

function matchDetail(
  detail: ServiceDetail,
  repos: readonly CandidateRepo[],
): { kind: 'matched'; value: MatchedService } | { kind: 'unmatched'; value: DiscoveryUnmatched } {
  const base = {
    projectName: detail.projectName,
    serviceName: detail.serviceName,
    serviceKind: detail.serviceKind,
    serviceId: detail.serviceId,
  };
  const hasGitSource = !!detail.owner && !!detail.repository && detail.sourceType?.toLowerCase() !== 'raw';
  if (!hasGitSource) {
    return { kind: 'unmatched', value: { ...base, reason: 'no_git_source' } };
  }
  const hit = repos.find(
    (r) => r.remote.owner === detail.owner!.toLowerCase() && r.remote.repo === detail.repository!.toLowerCase(),
  );
  if (!hit) return { kind: 'unmatched', value: { ...base, reason: 'no_remote_match' } };
  return { kind: 'matched', value: { ...detail, repoDir: hit.repoDir } };
}

// ── Grouping into Capy-project folders ──────────────────────────────────────

export interface DiscoveryPlanEnv {
  /** The Dokploy environment name — becomes the Capy branch name. */
  environmentName: string;
  serviceId: string;
  serviceKind: DiscoveryServiceKind;
  variableCount: number;
  skippedCount: number;
  /** The Dokploy service's git branch — informational only, never the Capy branch. */
  gitBranch?: string;
  /** Already-fetched (`application.one`/`compose.one`) env — plan preview reads this; the real per-environment import step re-fetches fresh rather than trusting a plan-time snapshot that may be stale by the time it runs. */
  rawEnv: string | null;
  /**
   * PREVIEW ONLY, and only known when `DiscoveryPlanFolder.initialized` —
   * whether this environment's branch already exists on the server, i.e.
   * whether the sequence's checkout step will be `capy checkout <branch>`
   * (true) or `capy checkout -b <branch>` (false). Undefined for an
   * uninitialized folder: there is no project yet to ask, so the printed
   * plan assumes `checkout -b` for every environment there — the real
   * sequence runner always re-checks for itself regardless of this preview,
   * so a wrong guess here never causes a wrong action, only a slightly
   * inaccurate preview line.
   */
  branchExists?: boolean;
  /**
   * PREVIEW ONLY — whether this step's import is expected to run with
   * `--overwrite` AUTOMATICALLY (see this file's "Auto-overwrite" doc):
   * `branchExists === false` (the checkout will CREATE the branch, a
   * git-model copy of the previous one) except for the very first
   * environment of a brand-new (uninitialized) project, which is a plain
   * import. Same caveat as `branchExists`: a preview, never authoritative —
   * the real sequence decides for itself from what `checkoutBranch` ACTUALLY
   * did, never from this field.
   */
  willAutoOverwrite: boolean;
}

/** A nested service folded into another's Capy project (see this file's "Nested folders" doc) — display only; its environments already live in the OUTER folder's own `environments`. */
export interface DiscoveryMergedService {
  projectName: string;
  serviceName: string;
  environmentNames: readonly string[];
}

export interface DiscoveryPlanFolder {
  repoDir: string;
  /** Relative to `repoDir`; `''` = repo root. */
  folder: string;
  projectName: string;
  serviceName: string;
  environments: readonly DiscoveryPlanEnv[];
  /** Whether this folder already has a local keep.lock. `false` means the sequence's first step is project init. */
  initialized: boolean;
  /** Present only when one or more OTHER services' folders nested inside this one and joined it as extra branches — see this file's "Nested folders" doc. */
  mergedServices?: readonly DiscoveryMergedService[];
}

function groupKey(m: MatchedService): string {
  return `${m.repoDir}\u0000${m.projectName}\u0000${m.serviceName}`;
}

/** Plan-time-only local keep.lock read (no auth) — just enough to know whether a folder is initialized, and which project to ask the server about. */
export type PeekLocalKeep = (repoDir: string, folder: string) => KeepFile | null;

/** Plan-time-only: the server's branches for an ALREADY-initialized folder's project — used only to preview checkout vs checkout -b (see `DiscoveryPlanEnv.branchExists`'s doc). Never called for a folder with no local keep.lock. */
export type ListServerBranches = (projectId: string) => Promise<ReadonlyArray<{ name: string }>>;

/** One matched (project,service) group's own natural folder + environments — pre-merge, pre-nesting-resolution. */
interface FolderGroup {
  repoDir: string;
  projectName: string;
  serviceName: string;
  /** This group's OWN folder — the deepest dir its own compose files share. Never relabeled; nesting resolution reads this directly. */
  folder: string;
  environments: readonly Omit<DiscoveryPlanEnv, 'branchExists' | 'willAutoOverwrite'>[];
}

function envFromMatch(m: MatchedService): Omit<DiscoveryPlanEnv, 'branchExists' | 'willAutoOverwrite'> {
  const importable = listImportableEntries(m.rawEnv);
  const candidates = importable.filter((e) => !e.skip);
  return {
    environmentName: m.environmentName,
    serviceId: m.serviceId,
    serviceKind: m.serviceKind,
    variableCount: candidates.length,
    skippedCount: importable.length - candidates.length,
    gitBranch: m.branch,
    rawEnv: m.rawEnv,
  };
}

/** The CLOSEST same-repo, same-Dokploy-project ancestor whose folder `g`'s folder is a proper subfolder of — or `null` when `g` is itself a root (no such ancestor). */
function closestAncestor(g: FolderGroup, all: readonly FolderGroup[]): FolderGroup | null {
  const ancestors = all.filter(
    (o) => o !== g && o.repoDir === g.repoDir && o.projectName === g.projectName && isProperSubfolder(g.folder, o.folder),
  );
  if (ancestors.length === 0) return null;
  // Closest = the deepest (longest-path) proper ancestor.
  return ancestors.reduce((best, c) => (c.folder.length > best.folder.length ? c : best));
}

function rootOf(g: FolderGroup, all: readonly FolderGroup[]): FolderGroup {
  const ancestor = closestAncestor(g, all);
  return ancestor ? rootOf(ancestor, all) : g;
}

async function groupMatchedServices(
  matched: readonly MatchedService[],
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
  /** `--environment` (CAP-657 follow-up): keeps only environments whose name is in this set — case-sensitive exact match. Applied AFTER nesting-ancestor identification (which service folds into which never depends on the filter) but BEFORE collision detection (so a collision is only raised about environments the filter kept). */
  environmentFilter?: ReadonlySet<string>,
): Promise<{ folders: readonly DiscoveryPlanFolder[]; collisions: readonly DiscoveryCollision[] }> {
  const byGroup = new Map<string, readonly MatchedService[]>();
  for (const m of matched) {
    const key = groupKey(m);
    byGroup.set(key, [...(byGroup.get(key) ?? []), m]);
  }
  const groups: readonly FolderGroup[] = [...byGroup.values()].map((members) => ({
    repoDir: members[0].repoDir,
    projectName: members[0].projectName,
    serviceName: members[0].serviceName,
    folder: deepestCommonDir(members.map((m) => serviceFolder(m))),
    environments: members.map((m) => envFromMatch(m)),
  }));

  const filteredEnvsOf = (g: FolderGroup) =>
    environmentFilter ? g.environments.filter((e) => environmentFilter.has(e.environmentName)) : g.environments;

  // Collision detection runs on the PRE-merge view, folder-relabeled to each
  // group's nesting ROOT: a nested child's branch colliding with one the
  // ancestor already has is a genuine collision (Vince's decision #8), and
  // this reuses `detectCollisions` completely unchanged — it already flags
  // any cell two DISTINCT services map to, regardless of why they got
  // there. Two UNRELATED groups merely computing the same folder by
  // coincidence (neither a proper subfolder of the other, so `rootOf`
  // leaves each as its own root) reproduce today's pre-existing "same
  // folder, different service" collision exactly as before. Nesting
  // ancestry (`rootOf`) always reads from the FULL, unfiltered `groups` —
  // which service folds into which never depends on `--environment`.
  const detectionFolders: readonly DiscoveryPlanFolder[] = groups.map((g) => ({
    repoDir: g.repoDir,
    folder: rootOf(g, groups).folder,
    projectName: g.projectName,
    serviceName: g.serviceName,
    initialized: false, // irrelevant for collision detection
    environments: filteredEnvsOf(g).map((e) => ({ ...e, willAutoOverwrite: false })),
  }));
  const collisions = detectCollisions(detectionFolders);

  // The FINAL merge: one DiscoveryPlanFolder per nesting cluster (a lone
  // root with nothing nested into it is its own singleton cluster) —
  // `initialized`/`branchExists` resolved against the ROOT's own
  // (repoDir, folder), never a nested child's.
  const clusters = new Map<FolderGroup, readonly FolderGroup[]>();
  for (const g of groups) {
    const root = rootOf(g, groups);
    clusters.set(root, [...(clusters.get(root) ?? []), g]);
  }

  const maybeFolders: readonly (DiscoveryPlanFolder | null)[] = await Promise.all(
    [...clusters.entries()].map(async ([root, members]): Promise<DiscoveryPlanFolder | null> => {
      const memberEnvs = members.map((m) => ({ member: m, envs: filteredEnvsOf(m) }));
      const totalEnvCount = memberEnvs.reduce((n, p) => n + p.envs.length, 0);
      // Every one of this cluster's environments was filtered out —
      // "folders left with no steps drop out of the plan entirely" (no
      // init, no checkout, no commit).
      if (totalEnvCount === 0) return null;

      const localKeep = peek.peekLocalKeep(root.repoDir, root.folder);
      const initialized = !!localKeep;
      const serverBranchNames = initialized
        ? new Set((await peek.listServerBranches(localKeep!.project_id)).map((b) => b.name))
        : null;
      const orderedNames = orderEnvironments(memberEnvs.flatMap((p) => p.envs)).map((e) => e.environmentName);
      const environments: readonly DiscoveryPlanEnv[] = memberEnvs.flatMap((p) =>
        p.envs.map((e) => {
          const branchExists = serverBranchNames ? serverBranchNames.has(e.environmentName) : undefined;
          const willCreateBranch = branchExists === false || !initialized;
          const isFirstInOrder = orderedNames[0] === e.environmentName;
          const willAutoOverwrite = willCreateBranch && !(!initialized && isFirstInOrder);
          return { ...e, ...(branchExists !== undefined ? { branchExists } : {}), willAutoOverwrite };
        }),
      );
      const nested = memberEnvs.filter((p) => p.member !== root && p.envs.length > 0);
      return {
        repoDir: root.repoDir,
        folder: root.folder,
        projectName: root.projectName,
        serviceName: root.serviceName,
        environments,
        initialized,
        ...(nested.length > 0
          ? {
              mergedServices: nested.map((p) => ({
                projectName: p.member.projectName,
                serviceName: p.member.serviceName,
                environmentNames: p.envs.map((e) => e.environmentName),
              })),
            }
          : {}),
      };
    }),
  );
  const folders: readonly DiscoveryPlanFolder[] = maybeFolders.filter((f): f is DiscoveryPlanFolder => f !== null);

  return { folders, collisions };
}

// ── Collisions ───────────────────────────────────────────────────────────────

export interface DiscoveryCollisionCandidate {
  projectName: string;
  serviceName: string;
  serviceId: string;
  serviceKind: DiscoveryServiceKind;
}

export interface DiscoveryCollision {
  repoDir: string;
  folder: string;
  environmentName: string;
  candidates: readonly DiscoveryCollisionCandidate[];
}

/** Two or more distinct (project, service) groups mapping the same (repoDir, folder, environment). */
function detectCollisions(folders: readonly DiscoveryPlanFolder[]): readonly DiscoveryCollision[] {
  interface Cell {
    repoDir: string;
    folder: string;
    environmentName: string;
    projectName: string;
    serviceName: string;
    serviceId: string;
    serviceKind: DiscoveryServiceKind;
  }
  const cells: Cell[] = folders.flatMap((f) =>
    f.environments.map((e) => ({
      repoDir: f.repoDir,
      folder: f.folder,
      environmentName: e.environmentName,
      projectName: f.projectName,
      serviceName: f.serviceName,
      serviceId: e.serviceId,
      serviceKind: e.serviceKind,
    })),
  );
  const byCell = new Map<string, readonly Cell[]>();
  for (const cell of cells) {
    const key = `${cell.repoDir}\u0000${cell.folder}\u0000${cell.environmentName}`;
    byCell.set(key, [...(byCell.get(key) ?? []), cell]);
  }
  return [...byCell.values()].flatMap((entries) => {
    const distinctServices = new Set(entries.map((e) => `${e.projectName}\u0000${e.serviceName}`));
    if (distinctServices.size <= 1) return [];
    const [{ repoDir, folder, environmentName }] = entries;
    return [
      {
        repoDir,
        folder,
        environmentName,
        candidates: entries.map((e) => ({
          projectName: e.projectName,
          serviceName: e.serviceName,
          serviceId: e.serviceId,
          serviceKind: e.serviceKind,
        })),
      },
    ];
  });
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface DiscoveryPlan {
  folders: readonly DiscoveryPlanFolder[];
  collisions: readonly DiscoveryCollision[];
  unmatched: readonly DiscoveryUnmatched[];
  /** Repos git itself refused to read — see `DiscoveryRemoteReadError`'s doc. Attached by `buildDiscoveryPlan`'s caller (which is where the repo scan itself happens); always `[]` when this function builds a plan on its own in a test. */
  unreadableRepos: readonly DiscoveryRemoteReadError[];
  /** Every DISTINCT Dokploy environment name seen across every MATCHED service, BEFORE any `--environment` filter — the "names that exist" list for `DOKPLOY_ENVIRONMENT_NOT_FOUND`. */
  allEnvironmentNames: readonly string[];
  /** The `--environment` names this plan was filtered to, if any (CAP-657 follow-up) — for the plan header ("filtered to: staging"). Absent when no filter was passed. */
  environmentFilter?: readonly string[];
}

/**
 * Reads `project.all` plus full detail on every service, matches against
 * `repos`, groups into Capy-project folders (folding nested services in as
 * extra branches — see this file's "Nested folders" doc), and flags
 * collisions. Apart from the injected `client`/`peek`, this never writes
 * anything — `peek.listServerBranches` is a plain read (`GET` equivalent on
 * Capy's own service), never a create. Safe to call under `--dry-run` as-is.
 */
export async function buildDiscoveryPlan(
  client: DiscoveryDokployClient,
  repos: readonly CandidateRepo[],
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
  /** `--environment` (CAP-657 follow-up) — see `groupMatchedServices`'s own doc for exactly where this applies (after nesting, before collision detection). */
  environmentFilter?: readonly string[],
): Promise<DiscoveryPlan> {
  const details = await fetchAllServiceDetails(client);
  const results = details.map((d) => matchDetail(d, repos));
  const matched = results.flatMap((r) => (r.kind === 'matched' ? [r.value] : []));
  const unmatched = results.flatMap((r) => (r.kind === 'unmatched' ? [r.value] : []));
  const allEnvironmentNames = [...new Set(matched.map((m) => m.environmentName))].sort();
  const filterSet = environmentFilter && environmentFilter.length > 0 ? new Set(environmentFilter) : undefined;
  const { folders, collisions } = await groupMatchedServices(matched, peek, filterSet);
  return {
    folders,
    collisions,
    unmatched,
    unreadableRepos: [],
    allEnvironmentNames,
    ...(filterSet ? { environmentFilter: [...filterSet] } : {}),
  };
}

// ── Collision resolution ─────────────────────────────────────────────────────

export interface CollisionResolution {
  repoDir: string;
  folder: string;
  environmentName: string;
  winnerServiceId: string;
}

/**
 * Resolves every collision: a `preferredServiceId` (from `--application`/
 * `--compose`) wins any collision it is a candidate of; otherwise, when
 * interactive, `askWinner` is asked per collision; otherwise this refuses
 * (`ok: false`) — the caller maps that to `DOKPLOY_MAPPING_COLLISION`, zero
 * writes. Never prompts when `interactive` is false, matching every other
 * picker in this codebase.
 */
export async function resolveCollisions(
  collisions: readonly DiscoveryCollision[],
  opts: {
    preferredServiceId?: string;
    interactive: boolean;
    askWinner?: (collision: DiscoveryCollision) => Promise<string>;
  },
): Promise<{ ok: true; resolutions: readonly CollisionResolution[] } | { ok: false }> {
  type Acc = { ok: true; resolutions: readonly CollisionResolution[] } | { ok: false };
  // A `.reduce` over a promise, not a `for` loop with a mutable array: once
  // one collision refuses, every later iteration short-circuits through the
  // `!acc.ok` check below rather than calling `askWinner` again — the same
  // "ask at most what's needed, in order" contract a `for`+`break` would
  // give, without a mutable accumulator.
  return collisions.reduce<Promise<Acc>>(async (accPromise, c) => {
    const acc = await accPromise;
    if (!acc.ok) return acc;
    const preferred = opts.preferredServiceId
      ? c.candidates.find((cand) => cand.serviceId === opts.preferredServiceId)
      : undefined;
    if (preferred) {
      return {
        ok: true,
        resolutions: [...acc.resolutions, { repoDir: c.repoDir, folder: c.folder, environmentName: c.environmentName, winnerServiceId: preferred.serviceId }],
      };
    }
    if (opts.interactive && opts.askWinner) {
      const winnerServiceId = await opts.askWinner(c);
      return {
        ok: true,
        resolutions: [...acc.resolutions, { repoDir: c.repoDir, folder: c.folder, environmentName: c.environmentName, winnerServiceId }],
      };
    }
    return { ok: false };
  }, Promise.resolve({ ok: true, resolutions: [] }));
}

/** Drops the LOSING side of every resolved collision from `folders`; drops a folder entirely once it has no environments left. Works the same whether `folders` is pre- or post-merge — it keys off each environment's own `serviceId`, never the folder's top-level `projectName`/`serviceName`. */
export function applyCollisionResolutions(
  folders: readonly DiscoveryPlanFolder[],
  resolutions: readonly CollisionResolution[],
): readonly DiscoveryPlanFolder[] {
  const winnerFor = new Map<string, string>();
  for (const r of resolutions) winnerFor.set(`${r.repoDir}\u0000${r.folder}\u0000${r.environmentName}`, r.winnerServiceId);
  return folders.flatMap((folder) => {
    const environments = folder.environments.filter((env) => {
      const winner = winnerFor.get(`${folder.repoDir}\u0000${folder.folder}\u0000${env.environmentName}`);
      return winner === undefined || winner === env.serviceId;
    });
    return environments.length > 0 ? [{ ...folder, environments }] : [];
  });
}

// ── Sequencing (staging first, then alphabetical, production LAST) ─────────

/**
 * STAGING first (if present), then any OTHER environments alphabetically
 * (e.g. `preview`), PRODUCTION last (if present) — deterministic
 * regardless of the order Dokploy's own API happened to list them in, and
 * regardless of which subset of these a given service actually has (a
 * production-only service is just one step). Used both for the plan's
 * printed command sequence and for the real run's actual order. Production
 * being LAST means it is always created from whatever branch the previous
 * step left the folder on (the git-model copy `capy checkout -b`
 * performs), and is always the folder's FINAL branch when it's applied.
 */
export function orderEnvironments<T extends { environmentName: string }>(environments: readonly T[]): readonly T[] {
  const staging = environments.filter((e) => e.environmentName === 'staging');
  const production = environments.filter((e) => e.environmentName === 'production');
  const rest = sortedCopy(
    environments.filter((e) => e.environmentName !== 'staging' && e.environmentName !== 'production'),
    (a, b) => a.environmentName.localeCompare(b.environmentName),
  );
  return [...staging, ...rest, ...production];
}

// ── Running the sequence (writes: local keep.lock + .env only) ─────────────

/**
 * The per-folder, per-environment steps discovery runs — each one THE SAME
 * function a human would reach by typing the equivalent command by hand in
 * that folder, called in-process rather than shelled out. None of these may
 * ever call `process.exit`: a multi-folder run must be able to abort ONE
 * folder on a coded failure and continue with the next, which the CLI's own
 * command classes (`CapyCommand`, `CheckoutCommand`) cannot do as they
 * stand today (see `dokploy.ts`'s own doc on `buildRealDiscoverySequenceDeps`
 * for exactly where this deviates from literally invoking those classes, and
 * why).
 */
export interface DiscoverySequenceDeps {
  /**
   * No keep.lock at (repoDir, folder) → run the init flow (existing-project
   * picking, or create new, in the caller's org) — interactive only; a
   * non-interactive run refuses `DOKPLOY_FOLDER_NOT_INITIALIZED` naming the
   * folder, and NEVER auto-creates a project. A keep.lock already there is
   * just read for its project id — no network call, no re-init.
   */
  ensureProject: (
    repoDir: string,
    folder: string,
  ) => Promise<{ ok: true; projectId: string; created: boolean } | { ok: false; code: string; message: string }>;
  /**
   * The SAME dirty-working-tree guard `capy checkout` enforces before
   * switching branches — run ONCE per folder, right after `ensureProject`
   * succeeds and before this folder's FIRST checkout, never per
   * environment (every later checkout in the same folder just switched
   * away from a branch this run itself wrote, which cannot be dirty).
   * Skipped entirely by the caller for a folder whose project was just
   * created this run (`ensureProject`'s `created: true`) — nothing exists
   * yet to be dirty about. A dirty folder aborts with zero writes.
   */
  checkFolderDirty: (repoDir: string, folder: string, projectId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * Switches (repoDir, folder) onto `branchName`: pulls it if it already
   * exists on the server, or creates it — seeded from the folder's CURRENT
   * branch, the same git-model copy `capy checkout -b` performs — otherwise.
   * Never `process.exit`s; a coded failure aborts the folder.
   */
  checkoutBranch: (
    repoDir: string,
    folder: string,
    projectId: string,
    branchName: string,
  ) => Promise<{ ok: true; created: boolean } | { ok: false; code: string; message: string }>;
  /**
   * The single-service import itself (`dokployConnector.import`), run
   * against the branch `checkoutBranch` just switched (repoDir, folder)
   * onto, and — on success — written/pushed exactly the way a plain `capy
   * connect dokploy --compose <id>` run would be. `overwrite` is the
   * EFFECTIVE per-step value — the human's own `--overwrite` flag OR'd with
   * auto-overwrite (see this file's own doc) — computed by
   * `runDiscoverySequence` itself, never decided by this dep.
   */
  importIntoBranch: (repoDir: string, folder: string, env: DiscoveryPlanEnv, overwrite: boolean) => Promise<ImportOutcome>;
}

export interface DiscoverySequenceEnvResult {
  environmentName: string;
  branchCreated: boolean;
  /** Whether THIS step's import ran with `--overwrite` — by user flag, auto-detection, or both; see this file's "Auto-overwrite" doc. */
  overwrote: boolean;
  outcome: Extract<ImportOutcome, { ok: true }>;
}

export type DiscoveryFolderResult =
  | {
      repoDir: string;
      folder: string;
      ok: true;
      projectCreated: boolean;
      environments: readonly DiscoverySequenceEnvResult[];
      /** The branch (repoDir, folder)'s local `.env`/`.capy/branch` were left on — the last step actually run. */
      activeBranch: string;
    }
  | {
      repoDir: string;
      folder: string;
      ok: false;
      /** Stable refusal code — branch on this, never on `message`. */
      code: string;
      message: string;
      /** Environments this folder finished BEFORE the step that aborted it. */
      environments: readonly DiscoverySequenceEnvResult[];
    };

interface SequenceAcc {
  results: readonly DiscoverySequenceEnvResult[];
  lastBranch?: string;
  failure?: { code: string; message: string };
}

/**
 * One folder's command sequence: init (if needed), then per environment
 * (staging first, then alphabetical, production last) checkout + import —
 * sequentially, since each step depends on the branch the previous one
 * left the folder on. Any failed step aborts the REST of this folder with
 * a coded error — nothing swallowed, nothing defaulted — and the steps
 * already completed are still reported (see `DiscoveryFolderResult`'s
 * `ok: false` branch). Never writes anything for a step past the one that
 * failed.
 *
 * Auto-overwrite (see this file's own doc): a step whose checkout CREATED
 * the branch (`checkout.created`) runs its import with `--overwrite`
 * automatically, OR'd with the human's own `opts.overwrite` — EXCEPT the
 * very first step of a brand-new project (`project.created` AND no prior
 * step has completed yet in this folder), which is always a plain import
 * regardless: an empty project's first branch has nothing to overwrite.
 */
export async function runDiscoverySequence(
  folder: DiscoveryPlanFolder,
  opts: { overwrite: boolean },
  deps: DiscoverySequenceDeps,
): Promise<DiscoveryFolderResult> {
  const project = await deps.ensureProject(folder.repoDir, folder.folder);
  if (!project.ok) {
    return { repoDir: folder.repoDir, folder: folder.folder, ok: false, code: project.code, message: project.message, environments: [] };
  }

  // A brand-new project has nothing to be dirty about yet — only check an
  // EXISTING folder's working tree, and only once, before its first checkout.
  if (!project.created) {
    const dirty = await deps.checkFolderDirty(folder.repoDir, folder.folder, project.projectId);
    if (!dirty.ok) {
      return { repoDir: folder.repoDir, folder: folder.folder, ok: false, code: dirty.code, message: dirty.message, environments: [] };
    }
  }

  const ordered = orderEnvironments(folder.environments);
  const final = await ordered.reduce<Promise<SequenceAcc>>(async (accPromise, env) => {
    const acc = await accPromise;
    if (acc.failure) return acc; // a prior environment already aborted this folder — nothing further runs.

    const checkout = await deps.checkoutBranch(folder.repoDir, folder.folder, project.projectId, env.environmentName);
    if (!checkout.ok) {
      return { ...acc, failure: { code: checkout.code, message: checkout.message } };
    }

    const isFirstStep = acc.results.length === 0;
    const autoOverwrite = checkout.created && !(project.created && isFirstStep);
    const effectiveOverwrite = opts.overwrite || autoOverwrite;

    const outcome = await deps.importIntoBranch(folder.repoDir, folder.folder, env, effectiveOverwrite);
    if (!outcome.ok) {
      return { ...acc, failure: { code: outcome.code, message: outcome.message } };
    }

    const result: DiscoverySequenceEnvResult = {
      environmentName: env.environmentName,
      branchCreated: checkout.created,
      overwrote: effectiveOverwrite,
      outcome,
    };
    return { results: [...acc.results, result], lastBranch: env.environmentName };
  }, Promise.resolve({ results: [] }));

  if (final.failure) {
    return { repoDir: folder.repoDir, folder: folder.folder, ok: false, code: final.failure.code, message: final.failure.message, environments: final.results };
  }
  return {
    repoDir: folder.repoDir,
    folder: folder.folder,
    ok: true,
    projectCreated: project.created,
    environments: final.results,
    // `folder.environments` is never empty (grouping never produces a
    // folder with zero environments), so at least one step always ran when
    // `final.failure` is absent.
    activeBranch: final.lastBranch ?? '',
  };
}

/** Every folder's sequence, in turn — sequential across folders too: a fresh project's own key resolution shouldn't race a sibling folder's. */
export async function runDiscoverySequences(
  folders: readonly DiscoveryPlanFolder[],
  opts: { overwrite: boolean },
  deps: DiscoverySequenceDeps,
): Promise<readonly DiscoveryFolderResult[]> {
  return folders.reduce<Promise<readonly DiscoveryFolderResult[]>>(async (accPromise, folder) => {
    const acc = await accPromise;
    return [...acc, await runDiscoverySequence(folder, opts, deps)];
  }, Promise.resolve([]));
}

// ── Outcome (what `capy connect dokploy --discover` reports) ───────────────

/**
 * One repo's commit result (CAP-657 follow-up decision #9) — the keep.lock/
 * `.gitignore` files a real discovery run wrote get committed onto a new
 * branch, in the repo they live in; a dry run (or a repo with nothing
 * successful to commit) instead previews the branch + files. See
 * `../../git/discoveryCommit.ts`'s own doc for the write path and its
 * refusal codes.
 */
export type DiscoveryRepoCommitResult = { repoDir: string } & DiscoveryCommitOutcome;

export type DiscoveryOutcome =
  | {
      ok: true;
      dryRun: boolean;
      plan: DiscoveryPlan;
      /** Present only once a real (non-dry-run) run actually reached the write step. */
      applied?: readonly DiscoveryFolderResult[];
      /** True when the human declined the pre-write confirmation — nothing was applied. */
      cancelled?: boolean;
      /** One entry per repo touched by the plan (dry run: every repo the plan would touch) — see `DiscoveryRepoCommitResult`'s own doc. Absent only when nothing was ever going to be committed (no matched repos at all). */
      commits?: readonly DiscoveryRepoCommitResult[];
    }
  | {
      ok: false;
      /** Stable refusal code — branch on this, never on `message`. */
      code: string;
      message: string;
    };
