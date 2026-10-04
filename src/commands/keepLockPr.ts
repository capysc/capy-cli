/**
 * The keep.lock PR step: the one place `capy add`, `capy edit` (TUI
 * and piped) and `capy remove` offer to turn a keep.lock change into a PR.
 *
 * It is built on the GitHub API through the user's own `gh` login
 * (deploy/githubApi.ts): the PR branch is created remotely — blob, tree,
 * commit, ref, pull — so nothing is cloned, checked out or committed locally.
 * The records of what the command changed are folded into the BASE branch's
 * keep.lock (never the local file), so the PR carries exactly the change.
 *
 * Two questions, asked in this order, each skippable by a flag:
 *   "Create a PR with these changes?"  (--pr / --no-pr)
 *   "Select base branch for PR"        (--pr-base <branch>)
 *
 * Never prompts without a terminal or under `--json`. A failure of this step
 * never fails the secret change: it is reported as `keep_lock.error`, decided
 * by error codes and statuses — never by message text.
 */
import { randomBytes } from 'crypto';
import inquirer from 'inquirer';
import { ERROR_CODES, KeepFile } from '../types/index';
import { serializeKeep } from '../files/fileManager';
import { EditSaveRecord, foldEditSaveIntoKeep } from '../deploy/keepGate';
import { isGitRepo, originRemoteUrl, repoRelPath } from '../deploy/git';
import {
  ApiFailure,
  GithubApi,
  RepoRef,
  createGhApi,
  isValidBranchName,
  parseGithubRemote,
  spawnGhRunner,
} from '../deploy/githubApi';
import { resolveGh } from '../utils/gh';
import { refusePiped } from './pipedValue';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

// The two approved prompt strings, verbatim.
export const CONFIRM_MESSAGE = 'Create a PR with these changes?';
const BASE_MESSAGE = 'Select base branch for PR';

// COPY-FLAG: no approved string fits these; minimal and neutral.
const NOT_COMMITTED_MESSAGE = 'Saved to Keep — not committed to git (no PR opened).'; // COPY-FLAG
const NO_DIFF_MESSAGE = 'no keep.lock changes to commit against the base branch'; // COPY-FLAG
const PR_AND_NO_PR_MESSAGE = '--pr and --no-pr cannot be used together.'; // COPY-FLAG
const BAD_BASE_MESSAGE = '--pr-base is not a valid branch name.'; // COPY-FLAG

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [ERROR_CODES.KEEP_PR_NOT_GIT_REPO]: 'This directory is not a git repository.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_NO_GITHUB_REMOTE]: 'There is no GitHub origin remote.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_GH_UNAVAILABLE]: 'The gh CLI is missing or not logged in.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_BASE_UNRESOLVED]: 'The base branch could not be resolved.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_READ_FAILED]: 'Reading from GitHub failed.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_COMMIT_FAILED]: 'Creating the commit on GitHub failed.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_BRANCH_FAILED]: 'Creating the PR branch on GitHub failed.', // COPY-FLAG
  [ERROR_CODES.KEEP_PR_CREATE_FAILED]: 'Creating the PR failed.', // COPY-FLAG
  [ERROR_CODES.GITHUB_TIMEOUT]: 'GitHub did not answer in time.', // COPY-FLAG
  [ERROR_CODES.GITHUB_RATE_LIMITED]: 'GitHub is limiting requests.', // COPY-FLAG
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KeepLockCommandName = 'add' | 'edit' | 'remove' | 'secrets';

export interface PrFlags {
  /** `--pr` */
  readonly pr?: boolean;
  /** `--no-pr` */
  readonly noPr?: boolean;
  /** `--pr-base <branch>` */
  readonly prBase?: string;
}

/** One question a flag could have answered — same shape `capy agents` / `capy remove` use. */
export interface UnansweredStop {
  readonly id: 'create_pr' | 'pr_base';
  readonly flag: '--pr' | '--pr-base';
}

export interface KeepLockError {
  readonly code: string;
  readonly message: string;
}

export type KeepLockReport =
  | { readonly changed: false }
  | { readonly changed: true; readonly committed: true; readonly pr_url: string; readonly base: string }
  | {
      readonly changed: true;
      readonly committed: false;
      readonly reason?: 'NO_DIFF_VS_BASE';
      readonly error?: KeepLockError;
    };

export interface KeepLockPrOutcome {
  readonly keep_lock: KeepLockReport;
  /** Top-level sibling of `keep_lock` in a command's JSON. */
  readonly unanswered?: readonly UnansweredStop[];
  /** Human-mode only: a person was asked and said no / cancelled. Never part of the JSON. */
  readonly declined?: boolean;
}

/** What the PR step WOULD do under `--dry-run`. Nothing was changed, so `committed` is always false. */
export interface KeepLockPreview {
  /** Would keep.lock change at all? */
  readonly changed: boolean;
  readonly committed: false;
  /** Present only when a PR would be opened (`--pr` and keep.lock would change). `base: null` + `error`: the base could not be read. */
  readonly would_pr: { readonly base: string | null; readonly error?: { readonly code: string } } | null;
}

export interface KeepLockPreviewOutcome {
  readonly keep_lock: KeepLockPreview;
  /** As in a real run: the questions `--pr` / `--no-pr` / `--pr-base` would have answered. */
  readonly unanswered?: readonly UnansweredStop[];
}

export interface KeepLockPrRequest {
  readonly command: KeepLockCommandName;
  readonly cwd: string;
  /** What the command changed in keep.lock. Empty means "nothing changed". */
  readonly records: readonly EditSaveRecord[];
  /** The local keep, used only to scaffold identity when the base branch has no keep.lock yet. */
  readonly localKeep: KeepFile;
  readonly flags: PrFlags;
  readonly json: boolean;
  readonly nonTty?: boolean;
}

/** Injectable seam: tests replace prompts, git reads and the GitHub API. */
export interface KeepLockPrDeps {
  readonly hasTerminal: () => boolean;
  /** `null`: cancelled (Esc / Ctrl-C). */
  readonly confirm: () => Promise<boolean | null>;
  /** `null`: cancelled (Esc / Ctrl-C). Branches arrive default-first. */
  readonly pickBase: (branches: readonly string[]) => Promise<string | null>;
  readonly isGitRepo: (cwd: string) => boolean;
  readonly originUrl: (cwd: string) => string | null;
  readonly keepLockPath: (cwd: string) => string;
  /** `undefined` when `gh` is not installed. */
  readonly github: () => GithubApi | undefined;
  readonly branchName: () => string;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Reads `--pr` / `--no-pr` from the raw argv. Commander folds the pair into
 * ONE attribute (last one wins), which would hide the contradiction
 * `--pr --no-pr`, so the tokens themselves are looked at.
 */
export function readPrFlags(rawArgs: readonly string[], prBase: string | undefined): PrFlags {
  const end = rawArgs.indexOf('--');
  const tokens = end === -1 ? rawArgs : rawArgs.slice(0, end);
  return { pr: tokens.includes('--pr'), noPr: tokens.includes('--no-pr'), prBase };
}

interface ArgvSource {
  readonly rawArgs?: readonly string[];
  readonly parent?: ArgvSource | null;
}

function rawArgsOf(command: ArgvSource): readonly string[] {
  return command.parent ? rawArgsOf(command.parent) : (command.rawArgs ?? []);
}

/** `readPrFlags` for a Commander command: the full argv lives on the root command. */
export function prFlagsFromCommand(command: ArgvSource, prBase: string | undefined): PrFlags {
  return readPrFlags(rawArgsOf(command), prBase);
}

/** The pre-flight refusals, run before the command changes anything. Exits. */
export function refuseBadPrFlags(flags: PrFlags, json: boolean): void {
  if (flags.pr === true && flags.noPr === true) {
    refusePiped(json, ERROR_CODES.INVALID_FORMAT, PR_AND_NO_PR_MESSAGE);
  }
  if (flags.prBase !== undefined && !isValidBranchName(flags.prBase)) {
    refusePiped(json, ERROR_CODES.INVALID_FORMAT, BAD_BASE_MESSAGE);
  }
}

/** Questions a flag could still have answered, in the order they are asked. */
export function unansweredStops(flags: PrFlags): readonly UnansweredStop[] {
  return [
    ...(flags.pr === true || flags.noPr === true ? [] : [{ id: 'create_pr', flag: '--pr' } as const]),
    ...(flags.prBase === undefined ? [{ id: 'pr_base', flag: '--pr-base' } as const] : []),
  ];
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type Entry = KeepFile['variables'][string][number];

function entryOn(keep: KeepFile | null | undefined, variable: string, branch: string): Entry | null {
  return keep?.variables[variable]?.find((e) => e.branch === branch) ?? null;
}

/**
 * The records for a write of `names` on the Capy `branch`: what each name's
 * entry is now (`after`) where it differs from `before`. Empty when keep.lock
 * did not change for any of them (e.g. `--no-push`, or a value that was
 * already pinned).
 */
export function recordsForWrite(
  before: KeepFile,
  after: KeepFile | null | undefined,
  branch: string,
  names: readonly string[],
): readonly EditSaveRecord[] {
  if (!after) return [];
  const changed = names
    .map((variable) => ({ variable, previous: entryOn(before, variable, branch), entry: entryOn(after, variable, branch) }))
    .filter(({ previous, entry }) => JSON.stringify(previous) !== JSON.stringify(entry));
  return changed.length === 0 ? [] : [{ branch, entries: changed.map(({ variable, entry }) => ({ variable, entry })) }];
}

/** `capy remove`: every name is dropped from the branch. */
export function recordsForRemoval(branch: string, names: readonly string[]): readonly EditSaveRecord[] {
  return names.length === 0 ? [] : [{ branch, entries: names.map((variable) => ({ variable, entry: null })) }];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Default branch first, then the rest in their given order, de-duplicated. */
export function orderBranches(defaultBranch: string, branches: readonly string[]): readonly string[] {
  return [...new Set([defaultBranch, ...branches])];
}

/** Type-to-filter: case-insensitive substring match; an empty term lists everything. */
export function filterBranches(branches: readonly string[], term: string | undefined): readonly string[] {
  const needle = (term ?? '').trim().toLowerCase();
  return needle.length === 0 ? branches : branches.filter((b) => b.toLowerCase().includes(needle));
}

/** `capy/keep-lock-<UTC yyyymmdd-hhmmss>-<4 hex chars>` — deterministic shape, unique per run. */
export function newPrBranchName(now: Date = new Date(), rand: string = randomBytes(2).toString('hex')): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return `capy/keep-lock-${stamp}-${rand}`;
}

const PR_TITLE = 'chore(capy): update keep.lock'; // COPY-FLAG

function touchedNames(records: readonly EditSaveRecord[]): readonly string[] {
  return [...new Set(records.flatMap((r) => r.entries.map((e) => e.variable)))];
}

function touchedBranches(records: readonly EditSaveRecord[]): readonly string[] {
  return [...new Set(records.map((r) => r.branch))];
}

/** Names and Capy branch only — never a value. */
export function buildCommitMessage(records: readonly EditSaveRecord[]): string {
  return [
    PR_TITLE,
    '',
    `Capy branch: ${touchedBranches(records).join(', ')}`, // COPY-FLAG
    `Variables: ${touchedNames(records).join(', ') || '(none)'}`, // COPY-FLAG
  ].join('\n');
}

/** Names, Capy branch and the command that ran — never a value. `paths` (several keep.lock files) adds one line. */
export function buildPrBody(
  command: KeepLockCommandName,
  records: readonly EditSaveRecord[],
  paths: readonly string[] = [],
): string {
  return [
    `Updates keep.lock after \`capy ${command}\`.`, // COPY-FLAG
    '',
    `- Capy branch: ${touchedBranches(records).map((b) => `\`${b}\``).join(', ')}`, // COPY-FLAG
    `- Variables: ${touchedNames(records).map((v) => `\`${v}\``).join(', ') || '(none)'}`, // COPY-FLAG
    ...(paths.length > 1 ? [`- Files: ${paths.map((p) => `\`${p}\``).join(', ')}`] : []), // COPY-FLAG
    `- Command: \`capy ${command}\``, // COPY-FLAG
    '',
    'Names only. No secret values appear in this PR.', // COPY-FLAG
  ].join('\n');
}

function parseKeep(raw: string): KeepFile | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    const vars = obj?.variables;
    return typeof vars === 'object' && vars !== null && !Array.isArray(vars) ? (parsed as KeepFile) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

interface Failure {
  readonly ok: false;
  readonly report: KeepLockReport;
  readonly cancelled?: boolean;
}

type Step<T> = { readonly ok: true; readonly value: T } | Failure;

const ok = <T>(value: T): Step<T> => ({ ok: true, value });

function errorReport(code: string): KeepLockReport {
  return { changed: true, committed: false, error: { code, message: ERROR_MESSAGES[code] ?? code } };
}

const failWith = (code: string): Failure => ({ ok: false, report: errorReport(code) });

/** gh missing / not logged in, or a GitHub call that timed out, wins over the step's own code; everything else is the step's. */
function failApi(failure: ApiFailure, stepCode: string): Failure {
  if (failure.kind === 'GH_UNAVAILABLE') return failWith(ERROR_CODES.KEEP_PR_GH_UNAVAILABLE);
  if (failure.kind === 'RATE_LIMITED') return failWith(ERROR_CODES.GITHUB_RATE_LIMITED);
  return failWith(failure.kind === 'TIMEOUT' ? ERROR_CODES.GITHUB_TIMEOUT : stepCode);
}

interface Target {
  readonly repo: RepoRef;
  readonly github: GithubApi;
}

function resolveTarget(cwd: string, deps: KeepLockPrDeps): Step<Target> {
  if (!deps.isGitRepo(cwd)) return failWith(ERROR_CODES.KEEP_PR_NOT_GIT_REPO);
  const url = deps.originUrl(cwd);
  const repo = url === null ? null : parseGithubRemote(url);
  if (repo === null) return failWith(ERROR_CODES.KEEP_PR_NO_GITHUB_REMOTE);
  const github = deps.github();
  return github === undefined ? failWith(ERROR_CODES.KEEP_PR_GH_UNAVAILABLE) : ok({ repo, github });
}

async function resolveBase(
  flags: PrFlags,
  interactive: boolean,
  target: Target,
  deps: KeepLockPrDeps,
): Promise<Step<string>> {
  if (flags.prBase !== undefined) return ok(flags.prBase.trim());
  const info = await target.github.getRepo(target.repo);
  if (!info.ok) return failApi(info, ERROR_CODES.KEEP_PR_BASE_UNRESOLVED);
  if (!interactive) return ok(info.value.defaultBranch);
  const listed = await target.github.listBranches(target.repo);
  if (!listed.ok) return failApi(listed, ERROR_CODES.KEEP_PR_READ_FAILED);
  const picked = await deps.pickBase(orderBranches(info.value.defaultBranch, listed.value));
  return picked === null ? { ok: false, report: { changed: true, committed: false }, cancelled: true } : ok(picked);
}

/** One keep.lock to update: where it lives in the repo, what to fold into it, and the identity to scaffold it with if the base has none. */
export interface KeepLockFileSpec {
  readonly path: string;
  readonly records: readonly EditSaveRecord[];
  readonly localKeep: KeepFile;
}

/** What a base branch holds at one keep.lock path. */
export interface BaseKeep {
  readonly path: string;
  readonly keep: KeepFile;
  /** `false`: the base has no keep.lock there yet (`keep` is an empty scaffold). */
  readonly existed: boolean;
}

interface Plan {
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly headCommit: string;
  readonly baseTree: string;
  readonly bases: readonly BaseKeep[];
}

async function readBase(target: Target, base: string, spec: KeepLockFileSpec): Promise<Step<BaseKeep>> {
  const file = await target.github.getFile(target.repo, spec.path, base);
  if (!file.ok) return failApi(file, ERROR_CODES.KEEP_PR_READ_FAILED);
  if (file.value === null) {
    return ok({ path: spec.path, keep: { ...spec.localKeep, variables: {} }, existed: false });
  }
  const parsed = parseKeep(file.value);
  return parsed === undefined
    ? failWith(ERROR_CODES.KEEP_PR_READ_FAILED)
    : ok({ path: spec.path, keep: parsed, existed: true });
}

/** Reads every spec's keep.lock from `base`. */
async function readBases(
  target: Target,
  base: string,
  specs: readonly KeepLockFileSpec[],
): Promise<Step<readonly BaseKeep[]>> {
  const reads = await Promise.all(specs.map((spec) => readBase(target, base, spec)));
  const failed = reads.find((r): r is Failure => !r.ok);
  return failed ?? ok(reads.flatMap((r) => (r.ok ? [r.value] : [])));
}

/** Folds each spec's records into the BASE branch's keep.lock. A non-error report when there is nothing to commit. */
async function planCommit(target: Target, base: string, specs: readonly KeepLockFileSpec[]): Promise<Step<Plan>> {
  const head = await target.github.getBranchHead(target.repo, base);
  if (!head.ok) {
    return failApi(head, head.kind === 'NOT_FOUND' ? ERROR_CODES.KEEP_PR_BASE_UNRESOLVED : ERROR_CODES.KEEP_PR_READ_FAILED);
  }
  const bases = await readBases(target, base, specs);
  if (!bases.ok) return bases;

  const changed = specs.flatMap((spec, i) => {
    const before = bases.value[i];
    const folded = spec.records.reduce(foldEditSaveIntoKeep, before.keep);
    const content = serializeKeep(folded);
    const noDiff = before.existed ? content === serializeKeep(before.keep) : Object.keys(folded.variables).length === 0;
    return noDiff ? [] : [{ path: spec.path, content }];
  });
  if (changed.length === 0) {
    return { ok: false, report: { changed: true, committed: false, reason: 'NO_DIFF_VS_BASE' } };
  }
  return ok({ files: changed, headCommit: head.value.commitSha, baseTree: head.value.treeSha, bases: bases.value });
}

/** blob(s) -> tree -> commit -> ref -> pull. Each failing step is its own code. */
async function publish(
  target: Target,
  base: string,
  plan: Plan,
  branch: string,
  wording: { readonly command: KeepLockCommandName; readonly records: readonly EditSaveRecord[] },
): Promise<KeepLockReport> {
  const { github, repo } = target;
  const blobs = await Promise.all(plan.files.map((f) => github.createBlob(repo, f.content)));
  const blobShas = blobs.flatMap((b) => (b.ok ? [b.value.sha] : []));
  const blobFailure = blobs.find((b) => !b.ok);
  if (blobFailure && !blobFailure.ok) return failApi(blobFailure, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const entries = plan.files.map((f, i) => ({ path: f.path, blobSha: blobShas[i] }));
  const tree = await github.createTree(
    repo,
    entries.length === 1
      ? { baseTree: plan.baseTree, path: entries[0].path, blobSha: entries[0].blobSha }
      : { baseTree: plan.baseTree, entries },
  );
  if (!tree.ok) return failApi(tree, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const commit = await github.createCommit(repo, {
    message: buildCommitMessage(wording.records),
    tree: tree.value.sha,
    parent: plan.headCommit,
  });
  if (!commit.ok) return failApi(commit, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const ref = await github.createRef(repo, branch, commit.value.sha);
  if (!ref.ok) return failApi(ref, ERROR_CODES.KEEP_PR_BRANCH_FAILED).report;
  const pull = await github.createPull(repo, {
    title: PR_TITLE,
    body: buildPrBody(wording.command, wording.records, plan.files.map((f) => f.path)),
    head: branch,
    base,
  });
  if (!pull.ok) return failApi(pull, ERROR_CODES.KEEP_PR_CREATE_FAILED).report;
  return { changed: true, committed: true, pr_url: pull.value.url, base };
}

async function openPr(
  req: KeepLockPrRequest,
  interactive: boolean,
  deps: KeepLockPrDeps,
): Promise<{ readonly report: KeepLockReport; readonly cancelled?: boolean }> {
  const target = resolveTarget(req.cwd, deps);
  if (!target.ok) return target;
  const base = await resolveBase(req.flags, interactive, target.value, deps);
  if (!base.ok) return base;
  const spec: KeepLockFileSpec = { path: deps.keepLockPath(req.cwd), records: req.records, localKeep: req.localKeep };
  const plan = await planCommit(target.value, base.value, [spec]);
  if (!plan.ok) return plan;
  const branch = deps.branchName();
  if (!isValidBranchName(branch)) return { report: errorReport(ERROR_CODES.KEEP_PR_BRANCH_FAILED) };
  return {
    report: await publish(target.value, base.value, plan.value, branch, { command: req.command, records: req.records }),
  };
}

// ---------------------------------------------------------------------------
// Several keep.lock files in one PR (`capy secrets set`)
// ---------------------------------------------------------------------------

export interface KeepLockPullRequest {
  readonly command: KeepLockCommandName;
  readonly repo: RepoRef;
  /** One or more keep.lock files of the repo (a monorepo has one per project folder). Each folds its own records, which may span several Capy branches. */
  readonly files: readonly KeepLockFileSpec[];
  /** The PR base. Absent: the repo's default branch. */
  readonly base?: string;
}

export type KeepLockPullRequestResult =
  | {
      readonly ok: true;
      readonly pr_url: string;
      readonly base: string;
      readonly paths: readonly string[];
      /** What the base branch held before the PR, for the caller's own comparisons. */
      readonly bases: readonly BaseKeep[];
    }
  | { readonly ok: false; readonly code: string; readonly reason?: 'NO_DIFF_VS_BASE' };

/** The code a failed step carries (`KEEP_PR_READ_FAILED` when it carries none). */
function failureCode(failure: Failure): string {
  const report = failure.report;
  return report.changed && !report.committed && report.error ? report.error.code : ERROR_CODES.KEEP_PR_READ_FAILED;
}

/** The repo's default branch (the PR base when none is given). */
export async function resolveDefaultBase(
  github: GithubApi,
  repo: RepoRef,
): Promise<{ readonly ok: true; readonly base: string } | { readonly ok: false; readonly code: string }> {
  const info = await github.getRepo(repo);
  return info.ok ? { ok: true, base: info.value.defaultBranch } : { ok: false, code: failureCode(failApi(info, ERROR_CODES.KEEP_PR_BASE_UNRESOLVED)) };
}

/** Reads what `base` holds at each spec's path (read-only: opens nothing, writes nothing). */
export async function readKeepLockBases(
  github: GithubApi,
  repo: RepoRef,
  base: string,
  specs: readonly KeepLockFileSpec[],
): Promise<{ readonly ok: true; readonly bases: readonly BaseKeep[] } | { readonly ok: false; readonly code: string }> {
  const read = await readBases({ github, repo }, base, specs);
  return read.ok ? { ok: true, bases: read.value } : { ok: false, code: failureCode(read) };
}

/**
 * Opens ONE pull request, on `base` (default: the repo's default branch), that
 * updates every file in `files`: one blob each, one tree, one commit. Never
 * prompts, never throws, never reports a value (names only, see
 * `buildPrBody`). A failure is its own code.
 */
export async function openKeepLockPullRequest(
  req: KeepLockPullRequest,
  deps: Pick<KeepLockPrDeps, 'branchName'> & { readonly github: GithubApi },
): Promise<KeepLockPullRequestResult> {
  try {
    const target: Target = { repo: req.repo, github: deps.github };
    const base =
      req.base !== undefined ? { ok: true as const, base: req.base } : await resolveDefaultBase(deps.github, req.repo);
    if (!base.ok) return { ok: false, code: base.code };
    const plan = await planCommit(target, base.base, req.files);
    if (!plan.ok) {
      const report = plan.report;
      return report.changed && !report.committed && report.reason === 'NO_DIFF_VS_BASE'
        ? { ok: false, code: 'NO_DIFF_VS_BASE', reason: 'NO_DIFF_VS_BASE' }
        : { ok: false, code: failureCode(plan) };
    }
    const branch = deps.branchName();
    if (!isValidBranchName(branch)) return { ok: false, code: ERROR_CODES.KEEP_PR_BRANCH_FAILED };
    const records = req.files.flatMap((f) => f.records);
    const report = await publish(target, base.base, plan.value, branch, { command: req.command, records });
    if (report.changed && report.committed) {
      return { ok: true, pr_url: report.pr_url, base: base.base, paths: plan.value.files.map((f) => f.path), bases: plan.value.bases };
    }
    return { ok: false, code: report.changed && !report.committed && report.error ? report.error.code : ERROR_CODES.KEEP_PR_CREATE_FAILED };
  } catch {
    return { ok: false, code: ERROR_CODES.KEEP_PR_CREATE_FAILED };
  }
}

/** Human wording for a keep.lock PR failure code (the same copy the PR step uses). */
export function keepPrErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? code;
}

type Answer = 'yes' | 'no' | 'declined' | 'unanswered';

async function answerFor(flags: PrFlags, interactive: boolean, deps: KeepLockPrDeps): Promise<Answer> {
  if (flags.noPr === true) return 'no';
  if (flags.pr === true) return 'yes';
  if (!interactive) return 'unanswered';
  return (await deps.confirm()) === true ? 'yes' : 'declined';
}

async function runStep(req: KeepLockPrRequest, deps: KeepLockPrDeps): Promise<KeepLockPrOutcome> {
  if (req.records.length === 0) return { keep_lock: { changed: false } };
  const interactive = deps.hasTerminal() && !req.json && req.nonTty !== true;
  const notCommitted: KeepLockReport = { changed: true, committed: false };

  const answer = await answerFor(req.flags, interactive, deps);
  if (answer === 'no') return { keep_lock: notCommitted };
  if (answer === 'declined') return { keep_lock: notCommitted, declined: true };
  if (answer === 'unanswered') return { keep_lock: notCommitted, unanswered: unansweredStops(req.flags) };

  const opened = await openPr(req, interactive, deps);
  return opened.cancelled === true ? { keep_lock: opened.report, declined: true } : { keep_lock: opened.report };
}

async function previewBase(cwd: string, flags: PrFlags, deps: KeepLockPrDeps): Promise<{ base: string | null; error?: { code: string } }> {
  try {
    const target = resolveTarget(cwd, deps);
    if (!target.ok) return { base: null, error: { code: failureCode(target) } };
    const base = await resolveBase(flags, false, target.value, deps);
    return base.ok ? { base: base.value } : { base: null, error: { code: failureCode(base) } };
  } catch {
    return { base: null, error: { code: ERROR_CODES.KEEP_PR_BASE_UNRESOLVED } };
  }
}

/**
 * `--dry-run`: what the PR step would do, without doing any of it. Mirrors the
 * non-interactive answers of a real run: `--no-pr` or an unchanged keep.lock
 * means no PR; `--pr` means a PR on `--pr-base` or the repo's default branch
 * (READ from GitHub, nothing written); neither flag leaves the questions
 * `unanswered`. Never prompts, never writes, never throws.
 */
export async function previewKeepLockPrStep(
  req: { readonly changed: boolean; readonly cwd: string; readonly flags: PrFlags },
  deps: KeepLockPrDeps = defaultDeps,
): Promise<KeepLockPreviewOutcome> {
  const none: KeepLockPreview = { changed: req.changed, committed: false, would_pr: null };
  if (!req.changed || req.flags.noPr === true) return { keep_lock: none };
  if (req.flags.pr !== true) return { keep_lock: none, unanswered: unansweredStops(req.flags) };
  return { keep_lock: { ...none, would_pr: await previewBase(req.cwd, req.flags, deps) } };
}

/**
 * Runs the step and returns what happened. Does not print: the caller decides
 * where the human line goes (see `reportKeepLockHuman`) and merges the
 * outcome into its JSON (see `withKeepLock`). Never throws — the change this
 * step follows has already succeeded, so anything unexpected is reported as a
 * coded `keep_lock.error`.
 */
export async function runKeepLockPrStep(
  req: KeepLockPrRequest,
  deps: KeepLockPrDeps = defaultDeps,
): Promise<KeepLockPrOutcome> {
  try {
    return await runStep(req, deps);
  } catch (err) {
    return isPromptCancel(err)
      ? { keep_lock: { changed: true, committed: false }, declined: true }
      : { keep_lock: errorReport(ERROR_CODES.KEEP_PR_CREATE_FAILED) };
  }
}

/** Adds `keep_lock` (and `unanswered`, when present) to a command's JSON payload. */
export function withKeepLock<T extends object>(
  payload: T,
  outcome: Pick<KeepLockPrOutcome, 'unanswered'> & { readonly keep_lock: KeepLockReport | KeepLockPreview },
) {
  return {
    ...payload,
    keep_lock: outcome.keep_lock,
    ...(outcome.unanswered === undefined ? {} : { unanswered: outcome.unanswered }),
  };
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

export interface HumanReportOpts {
  /** Where the PR URL line goes: stdout for terminal flows, stderr when stdout is reserved (piped). */
  readonly successTo: 'stdout' | 'stderr';
  /** Also say "not committed" when no flag answered and nobody was asked (non-terminal edit sessions). */
  readonly noteUnanswered: boolean;
}

/** One short line. Never prints for `keep_lock.changed: false`. */
export function reportKeepLockHuman(outcome: KeepLockPrOutcome, opts: HumanReportOpts): void {
  const report = outcome.keep_lock;
  if (!report.changed) return;
  const out = opts.successTo === 'stdout' ? console.log : console.error;
  if (report.committed) {
    out(`  ${opts.successTo === 'stdout' ? GREEN('✓') : '✓'} PR      ${report.pr_url}`);
    return;
  }
  if (report.error) {
    console.error(`${YELLOW('!')} could not open the PR (${report.error.code}): ${report.error.message}`); // COPY-FLAG
    return;
  }
  if (report.reason === 'NO_DIFF_VS_BASE') {
    out(`  ${DIM('·')} ${NO_DIFF_MESSAGE}.`);
    return;
  }
  if (outcome.declined === true || (outcome.unanswered !== undefined && opts.noteUnanswered)) {
    console.error(DIM(NOT_COMMITTED_MESSAGE));
  }
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

function isPromptCancel(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ExitPromptError' || name === 'AbortPromptError';
}

interface CancellablePrompt<T> extends Promise<T> {
  readonly ui: { close(): void };
}

/**
 * Runs one inquirer prompt where Esc cancels as well as Ctrl-C: `null` on
 * either. A lone ESC byte is Esc; arrow keys arrive as a longer `ESC [ A`
 * sequence and are left to the prompt. The only listener this adds to stdin
 * is removed again before returning, so nothing outlives the prompt.
 */
async function askCancellable<T>(start: () => CancellablePrompt<T>): Promise<T | null> {
  const prompt = start();
  const onData = (chunk: Buffer | string) => {
    if (String(chunk) === '\x1b') prompt.ui.close();
  };
  process.stdin.on('data', onData);
  try {
    return await prompt;
  } catch (err) {
    if (isPromptCancel(err)) return null;
    throw err;
  } finally {
    process.stdin.removeListener('data', onData);
  }
}

async function confirmPr(): Promise<boolean | null> {
  const answer = await askCancellable(() =>
    inquirer.prompt<{ create: boolean }>([{ type: 'confirm', name: 'create', message: CONFIRM_MESSAGE, default: false }]),
  );
  return answer === null ? null : answer.create === true;
}

/** The searchable base-branch list: type to filter, arrows and Enter to choose, Esc / Ctrl-C to cancel. */
async function pickBaseBranch(branches: readonly string[]): Promise<string | null> {
  const answer = await askCancellable(() =>
    inquirer.prompt<{ base: string }>([
      {
        type: 'search',
        name: 'base',
        message: BASE_MESSAGE,
        pageSize: 12,
        source: (term: string | undefined) => filterBranches(branches, term).map((b) => ({ name: b, value: b })),
      },
    ]),
  );
  return answer === null ? null : answer.base;
}

function realGithub(): GithubApi | undefined {
  const gh = resolveGh();
  return gh === null ? undefined : createGhApi(spawnGhRunner(gh));
}

export const defaultDeps: KeepLockPrDeps = {
  hasTerminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm: confirmPr,
  pickBase: pickBaseBranch,
  isGitRepo,
  originUrl: originRemoteUrl,
  keepLockPath: (cwd) => repoRelPath(cwd, 'keep.lock'),
  github: realGithub,
  branchName: () => newPrBranchName(),
};
