/**
 * Discovery mode for `capy connect dokploy --discover` (CAP-657 follow-up).
 *
 * Every one of the target org's Dokploy services is Compose, not
 * Application — and there are MANY of them, across MANY Dokploy projects and
 * environments. Rather than the human typing `--application`/`--compose`
 * once per service, discovery finds every Dokploy service whose git source
 * matches a repo reachable from `cwd`, groups them into Capy projects (one
 * per Dokploy project+service, folder = the deepest directory its compose
 * files share), maps each Dokploy ENVIRONMENT to a Capy BRANCH, and — for a
 * real (non-dry-run), confirmed run — RUNS THE EXISTING GIT-MODEL COMMANDS,
 * per folder, in order: init the folder's project if it has none yet, then
 * per environment (production first, then alphabetical) checkout that
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
 *
 * READ-ONLY on the Dokploy side, same as the single-service import: this
 * module only ever calls `listProjects` (`GET project.all`), `getApplication`
 * (`GET application.one`) and `getCompose` (`GET compose.one`) — never a
 * write. Read-only on the LOCAL git side too: only `remote get-url` and
 * `rev-parse` (via `isGitRepo`) — never a git command that writes. Discovery
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
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, posix } from 'node:path';
import { isGitRepo } from '../../deploy/git';
import { DokployClient, DokployProjectSummary, listImportableEntries, sortedCopy } from '../../deploy/dokployApi';
import { isReservedProjectName } from '../../system/reservedProjectName';
import { KeepFile } from '../../types/index';
import type { AuthService } from '../../auth/authService';
import type { ServiceClient } from '../../service/serviceClient';
import type { ImportOutcome } from './registry';

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

function runGitReadOnly(args: readonly string[], cwd: string): { stdout: string; code: number } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', code: r.status ?? 1 };
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

/** `origin`'s remote, parsed — or null when `cwd` isn't a repo, has no `origin`, or it doesn't parse. */
export function readOriginRemote(cwd: string): GitRemoteRef | null {
  if (!isGitRepo(cwd)) return null;
  const r = runGitReadOnly(['remote', 'get-url', 'origin'], cwd);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  return parseGitRemoteUrl(r.stdout);
}

/**
 * `cwd` itself when it's a repo; otherwise its immediate child directories
 * that are repos (a `.git` entry present) — never a deeper recursive scan.
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

export function findCandidateRepoDirs(cwd: string): readonly string[] {
  if (isGitRepo(cwd)) return [cwd];
  return listChildDirs(cwd).filter((c) => existsSync(join(c, '.git')));
}

export interface CandidateRepo {
  repoDir: string;
  remote: GitRemoteRef;
}

/** Every candidate repo dir under `cwd` that has a parseable `origin` remote. */
export function findCandidateRepos(cwd: string): readonly CandidateRepo[] {
  return findCandidateRepoDirs(cwd).flatMap((repoDir) => {
    const remote = readOriginRemote(repoDir);
    return remote ? [{ repoDir, remote }] : [];
  });
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
}

function groupKey(m: MatchedService): string {
  return `${m.repoDir}\u0000${m.projectName}\u0000${m.serviceName}`;
}

/** Plan-time-only local keep.lock read (no auth) — just enough to know whether a folder is initialized, and which project to ask the server about. */
export type PeekLocalKeep = (repoDir: string, folder: string) => KeepFile | null;

/** Plan-time-only: the server's branches for an ALREADY-initialized folder's project — used only to preview checkout vs checkout -b (see `DiscoveryPlanEnv.branchExists`'s doc). Never called for a folder with no local keep.lock. */
export type ListServerBranches = (projectId: string) => Promise<ReadonlyArray<{ name: string }>>;

async function groupMatchedServices(
  matched: readonly MatchedService[],
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
): Promise<readonly DiscoveryPlanFolder[]> {
  const groups = new Map<string, readonly MatchedService[]>();
  for (const m of matched) {
    const key = groupKey(m);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return Promise.all(
    [...groups.values()].map(async (members) => {
      const folder = deepestCommonDir(members.map((m) => serviceFolder(m)));
      // One physical keep.lock per folder — read once per group, not per environment.
      const localKeep = peek.peekLocalKeep(members[0].repoDir, folder);
      const initialized = !!localKeep;
      const serverBranchNames = initialized ? new Set((await peek.listServerBranches(localKeep!.project_id)).map((b) => b.name)) : null;
      const environments: readonly DiscoveryPlanEnv[] = members.map((m) => {
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
          ...(serverBranchNames ? { branchExists: serverBranchNames.has(m.environmentName) } : {}),
        };
      });
      return {
        repoDir: members[0].repoDir,
        folder,
        projectName: members[0].projectName,
        serviceName: members[0].serviceName,
        environments,
        initialized,
      };
    }),
  );
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
}

/**
 * Reads `project.all` plus full detail on every service, matches against
 * `repos`, groups into Capy-project folders, and flags collisions. Apart
 * from the injected `client`/`peek`, this never writes anything —
 * `peek.listServerBranches` is a plain read (`GET` equivalent on Capy's own
 * service), never a create. Safe to call under `--dry-run` as-is.
 */
export async function buildDiscoveryPlan(
  client: DiscoveryDokployClient,
  repos: readonly CandidateRepo[],
  peek: { peekLocalKeep: PeekLocalKeep; listServerBranches: ListServerBranches },
): Promise<DiscoveryPlan> {
  const details = await fetchAllServiceDetails(client);
  const results = details.map((d) => matchDetail(d, repos));
  const matched = results.flatMap((r) => (r.kind === 'matched' ? [r.value] : []));
  const unmatched = results.flatMap((r) => (r.kind === 'unmatched' ? [r.value] : []));
  const folders = await groupMatchedServices(matched, peek);
  const collisions = detectCollisions(folders);
  return { folders, collisions, unmatched };
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

/** Drops the LOSING side of every resolved collision from `folders`; drops a folder entirely once it has no environments left. */
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

// ── Sequencing (production first, then alphabetical) ───────────────────────

/**
 * `production` first (if present), then every other environment
 * alphabetically — deterministic regardless of the order Dokploy's own API
 * happened to list them in. Used both for the plan's printed command
 * sequence and for the real run's actual order.
 */
export function orderEnvironments<T extends { environmentName: string }>(environments: readonly T[]): readonly T[] {
  const production = environments.filter((e) => e.environmentName === 'production');
  const rest = sortedCopy(
    environments.filter((e) => e.environmentName !== 'production'),
    (a, b) => a.environmentName.localeCompare(b.environmentName),
  );
  return [...production, ...rest];
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
   * connect dokploy --compose <id>` run would be. `overwrite` is discovery's
   * OWN `--overwrite` flag, threaded straight through to the single-service
   * import's identical flag — never decided per-environment.
   */
  importIntoBranch: (repoDir: string, folder: string, env: DiscoveryPlanEnv, overwrite: boolean) => Promise<ImportOutcome>;
}

export interface DiscoverySequenceEnvResult {
  environmentName: string;
  branchCreated: boolean;
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
 * (production first, then alphabetical) checkout + import — sequentially,
 * since each step depends on the branch the previous one left the folder
 * on. Any failed step aborts the REST of this folder with a coded error —
 * nothing swallowed, nothing defaulted — and the steps already completed
 * are still reported (see `DiscoveryFolderResult`'s `ok: false` branch).
 * Never writes anything for a step past the one that failed.
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

    const outcome = await deps.importIntoBranch(folder.repoDir, folder.folder, env, opts.overwrite);
    if (!outcome.ok) {
      return { ...acc, failure: { code: outcome.code, message: outcome.message } };
    }

    const result: DiscoverySequenceEnvResult = { environmentName: env.environmentName, branchCreated: checkout.created, outcome };
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

export type DiscoveryOutcome =
  | {
      ok: true;
      dryRun: boolean;
      plan: DiscoveryPlan;
      /** Present only once a real (non-dry-run) run actually reached the write step. */
      applied?: readonly DiscoveryFolderResult[];
      /** True when the human declined the pre-write confirmation — nothing was applied. */
      cancelled?: boolean;
    }
  | {
      ok: false;
      /** Stable refusal code — branch on this, never on `message`. */
      code: string;
      message: string;
    };
