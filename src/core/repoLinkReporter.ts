/**
 * Project -> repo links (CAP-697): when the CLI resolves a project from a
 * keep.lock inside a git worktree, it tells Capy which repo (and which folder
 * of it) holds that keep.lock. Capy stores the link, never repository
 * contents, and never a URL.
 *
 * Reporting is fire-and-forget. It never prompts, never changes a command's
 * exit code or output, and prints nothing on failure; the only thing it ever
 * prints is the one mismatch warning below, and only when the answer arrived
 * inside the wait budget.
 *
 *  - `origin` ONLY. Other remotes are ignored.
 *  - Userinfo and ports never leave this process: the remote is parsed to
 *    host/owner/name (deploy/githubApi.ts `parseRemote`) and the URL dropped.
 *  - Once per (project, host/owner/name, path) per 24h per machine, keyed on a
 *    stamp under the global capy dir. A stamp is written only after the service
 *    accepted the report.
 *  - Skipped under --dry-run, outside git, with no origin or an unparseable
 *    one, for system projects, and when the report would not pass the
 *    service's own validation.
 *  - `github_repo_id` is best effort through `gh`, skipped silently.
 *
 * Everything external is injected (`RepoLinkDeps`) so tests run with no git,
 * no gh, no network and no home directory.
 */
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { text } from 'stream/consumers';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../types/index';
import { getGlobalCapyDir } from '../config/globalConfig';
import { isGitRepo, originRemoteUrl, repoRelPath } from '../deploy/git';
import { RepoRef, RemoteRef, parseRemote, parseRepoId, repoIdArgs } from '../deploy/githubApi';
import { resolveGh } from '../utils/gh';
import { isReservedProjectName } from '../system/reservedProjectName';
import type { KnownRepo, ProjectRepoReport, ProjectRepoReportResponse } from '../service/serviceClient';

/** How long a command waits for a report before it drops it. */
export const REPORT_BUDGET_MS = 1500;
/** The service request's own timeout: a hanging service never holds the process open past this. */
const REQUEST_TIMEOUT_MS = 1400;
const GH_TIMEOUT_MS = 1000;
const THROTTLE_MS = 24 * 60 * 60 * 1000;

/** The subset of a ServiceClient the reporter uses. */
export interface RepoLinkClient {
  putProjectRepo(
    orgId: string,
    projectId: string,
    link: ProjectRepoReport,
    timeoutMs?: number,
  ): Promise<ProjectRepoReportResponse>;
}

export interface RepoLinkDeps {
  readonly isGitRepo: (cwd: string) => boolean;
  readonly originUrl: (cwd: string) => string | null;
  /** `git rev-parse --show-prefix` of `cwd`: `''` at the repo root, else `dir/sub/`. */
  readonly showPrefix: (cwd: string) => string;
  /** GitHub's numeric id, or `undefined` (no gh, not logged in, slow). Never rejects. */
  readonly githubRepoId: (repo: RepoRef) => Promise<number | undefined>;
  /** When this key was last reported, in ms since the epoch. */
  readonly readStamp: (key: string) => number | undefined;
  readonly writeStamp: (key: string, atMs: number) => void;
  readonly nowMs: () => number;
  readonly budgetMs: number;
  /** `true` turns reporting off entirely (the CAPY_NO_REPO_LINK switch). */
  readonly disabled: () => boolean;
}

export interface RepoLinkInput {
  readonly cwd: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly client: RepoLinkClient;
  readonly dryRun?: boolean;
}

export interface RepoLinkWarning {
  readonly code: typeof ERROR_CODES.KEEP_LOCK_REPO_MISMATCH;
  readonly message: string;
  /** `owner/name` of the repos this project is linked to instead. */
  readonly repos: readonly string[];
}

export type RepoLinkStatus = 'skipped' | 'throttled' | 'dropped' | 'reported';

export interface RepoLinkResult {
  readonly status: RepoLinkStatus;
  readonly warnings: readonly RepoLinkWarning[];
}

const SKIPPED: RepoLinkResult = { status: 'skipped', warnings: [] };
const DROPPED: RepoLinkResult = { status: 'dropped', warnings: [] };

// ---------------------------------------------------------------------------
// Validation: the service's own rules, checked here so a bad report is never sent.
// ---------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const OWNER_RE = /^[A-Za-z0-9_-]{1,39}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** The folder of the keep.lock, repo-relative with forward slashes; `.` for the root. */
export function folderFromPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}

export function isValidFolder(path: string): boolean {
  if (path === '.') return true;
  if (path.length === 0 || path.length > 512) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function isValidRemote(remote: RemoteRef): boolean {
  return (
    HOST_RE.test(remote.host) &&
    OWNER_RE.test(remote.owner) &&
    NAME_RE.test(remote.name) &&
    !remote.name.endsWith('.git') &&
    remote.name !== '.' &&
    remote.name !== '..'
  );
}

/** The report for `origin` at `folder`, or `null` when there is nothing valid to report. */
export function buildReport(
  originUrl: string | null,
  folder: string,
  githubRepoId?: number,
): ProjectRepoReport | null {
  const remote = originUrl === null ? null : parseRemote(originUrl);
  if (remote === null || !isValidRemote(remote) || !isValidFolder(folder)) return null;
  return {
    host: remote.host,
    owner: remote.owner,
    name: remote.name,
    path: folder,
    ...(githubRepoId === undefined ? {} : { github_repo_id: githubRepoId }),
  };
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

/** Stable key for a (project, repo, folder) triple; the repo part is case-insensitive like the service's uniqueness. */
export function throttleKey(projectId: string, report: ProjectRepoReport): string {
  const id = `${projectId}\u0000${report.host}/${report.owner.toLowerCase()}/${report.name.toLowerCase()}\u0000${report.path}`;
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

export function isThrottled(lastReportedMs: number | undefined, nowMs: number): boolean {
  return lastReportedMs !== undefined && nowMs - lastReportedMs >= 0 && nowMs - lastReportedMs < THROTTLE_MS;
}

// ---------------------------------------------------------------------------
// Mismatch warning
// ---------------------------------------------------------------------------

const sameRepo = (a: KnownRepo, b: ProjectRepoReport): boolean =>
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

/**
 * `known_repos` is every OTHER row the project already has. When there are
 * some and none is this repo (same host, case-insensitive owner/name; a
 * different folder of the same repo is still this repo), the keep.lock was
 * probably copied. One warning, listing those repos once each.
 */
export function mismatchWarning(known: readonly KnownRepo[], mine: ProjectRepoReport): RepoLinkWarning | null {
  if (known.length === 0 || known.some((k) => sameRepo(k, mine))) return null;
  const repos = [...new Set(known.map((k) => `${k.owner}/${k.name}`))];
  return {
    code: ERROR_CODES.KEEP_LOCK_REPO_MISMATCH,
    message: `keep.lock project is also linked to other repos: ${repos.join(', ')}`, // COPY-FLAG
    repos,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function githubRepoRef(report: ProjectRepoReport): RepoRef | undefined {
  return report.host === 'github.com' ? { owner: report.owner, name: report.name } : undefined;
}

async function reportOnce(input: RepoLinkInput, deps: RepoLinkDeps): Promise<RepoLinkResult> {
  if (!deps.isGitRepo(input.cwd)) return SKIPPED;
  const folder = folderFromPrefix(deps.showPrefix(input.cwd));
  const base = buildReport(deps.originUrl(input.cwd), folder);
  if (base === null) return SKIPPED;

  const key = throttleKey(input.projectId, base);
  if (isThrottled(deps.readStamp(key), deps.nowMs())) return { status: 'throttled', warnings: [] };

  const ref = githubRepoRef(base);
  const repoId = ref === undefined ? undefined : await deps.githubRepoId(ref);
  const report: ProjectRepoReport = repoId === undefined ? base : { ...base, github_repo_id: repoId };

  const response = await input.client.putProjectRepo(input.orgId, input.projectId, report, REQUEST_TIMEOUT_MS);
  deps.writeStamp(key, deps.nowMs());
  const warning = mismatchWarning(Array.isArray(response?.known_repos) ? response.known_repos : [], report);
  return { status: 'reported', warnings: warning === null ? [] : [warning] };
}

/** Resolves to `fallback` after `ms`; the timer never keeps the process alive and is cleared as soon as the work settles. */
function withBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Reports `origin` for the project and returns what happened. Never throws,
 * never prints, never takes longer than `deps.budgetMs`.
 */
export async function reportRepoLink(input: RepoLinkInput, deps: RepoLinkDeps = realDeps): Promise<RepoLinkResult> {
  if (input.dryRun === true || deps.disabled() || isReservedProjectName(input.projectName)) return SKIPPED;
  return withBudget(
    (async () => {
      try {
        return await reportOnce(input, deps);
      } catch {
        return DROPPED;
      }
    })(),
    deps.budgetMs,
    DROPPED,
  );
}

// ---------------------------------------------------------------------------
// Output: the one thing this module may print
// ---------------------------------------------------------------------------

/** Human mode: one stderr line per warning. JSON callers add `warnings` to their own envelope instead. */
export function printRepoLinkWarnings(result: RepoLinkResult): void {
  result.warnings.forEach((w) => console.error(`  ! ${w.message}`));
}

export interface ReportForCommandOpts {
  /** The command emits JSON: nothing is printed here; the caller adds `warnings` to its envelope. */
  readonly json?: boolean;
  /** Report, but never print (e.g. `capy run`, whose stderr belongs to the child). */
  readonly quiet?: boolean;
}

/** `reportRepoLink`, then the human warning when the command is not in JSON/quiet mode. */
export async function reportRepoLinkForCommand(
  input: RepoLinkInput,
  opts: ReportForCommandOpts = {},
  deps: RepoLinkDeps = realDeps,
): Promise<RepoLinkResult> {
  const result = await reportRepoLink(input, deps);
  if (opts.json !== true && opts.quiet !== true) printRepoLinkWarnings(result);
  return result;
}

/** `{ warnings }` to spread into a JSON payload, or `{}` when there is nothing to say. */
export function repoLinkWarningsField(result: RepoLinkResult): { readonly warnings?: readonly RepoLinkWarning[] } {
  return result.warnings.length === 0 ? {} : { warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

function stampDir(): string {
  return join(getGlobalCapyDir(), 'repo-links');
}

function readStampFile(key: string): number | undefined {
  try {
    const n = Number(readFileSync(join(stampDir(), key), 'utf-8').trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeStampFile(key: string, atMs: number): void {
  try {
    mkdirSync(stampDir(), { recursive: true });
    writeFileSync(join(stampDir(), key), String(atMs), 'utf-8');
  } catch {
    // Best effort: a missing stamp only means one more report next run.
  }
}

/** `gh api repos/{owner}/{name} --jq .id`, asynchronous and killed after `GH_TIMEOUT_MS`. stderr is discarded. */
function ghRepoId(repo: RepoRef): Promise<number | undefined> {
  const gh = resolveGh();
  if (gh === null) return Promise.resolve(undefined);
  return new Promise<number | undefined>((resolve) => {
    const child = spawn(gh, [...repoIdArgs(repo)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    const printed = child.stdout ? text(child.stdout).catch(() => '') : Promise.resolve('');
    const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      void printed.then((out) => resolve(code === 0 ? parseRepoId(out) : undefined));
    });
  });
}

export const realDeps: RepoLinkDeps = {
  isGitRepo,
  originUrl: originRemoteUrl,
  showPrefix: (cwd) => repoRelPath(cwd, ''),
  githubRepoId: ghRepoId,
  readStamp: readStampFile,
  writeStamp: writeStampFile,
  nowMs: () => Date.now(),
  budgetMs: REPORT_BUDGET_MS,
  disabled: () => process.env.CAPY_NO_REPO_LINK === '1',
};
