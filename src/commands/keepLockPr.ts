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
const CONFIRM_MESSAGE = 'Create a PR with these changes?';
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
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KeepLockCommandName = 'add' | 'edit' | 'remove';

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

/** Names, Capy branch and the command that ran — never a value. */
export function buildPrBody(command: KeepLockCommandName, records: readonly EditSaveRecord[]): string {
  return [
    `Updates keep.lock after \`capy ${command}\`.`, // COPY-FLAG
    '',
    `- Capy branch: ${touchedBranches(records).map((b) => `\`${b}\``).join(', ')}`, // COPY-FLAG
    `- Variables: ${touchedNames(records).map((v) => `\`${v}\``).join(', ') || '(none)'}`, // COPY-FLAG
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

/** gh missing / not logged in wins over the step's own code; everything else is the step's. */
function failApi(failure: ApiFailure, stepCode: string): Failure {
  return failWith(failure.kind === 'GH_UNAVAILABLE' ? ERROR_CODES.KEEP_PR_GH_UNAVAILABLE : stepCode);
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

interface Plan {
  readonly path: string;
  readonly content: string;
  readonly headCommit: string;
  readonly baseTree: string;
}

/** Folds the records into the BASE branch's keep.lock. A non-error report when there is nothing to commit. */
async function planCommit(req: KeepLockPrRequest, target: Target, base: string, path: string): Promise<Step<Plan>> {
  const head = await target.github.getBranchHead(target.repo, base);
  if (!head.ok) {
    return failApi(head, head.kind === 'NOT_FOUND' ? ERROR_CODES.KEEP_PR_BASE_UNRESOLVED : ERROR_CODES.KEEP_PR_READ_FAILED);
  }
  const file = await target.github.getFile(target.repo, path, base);
  if (!file.ok) return failApi(file, ERROR_CODES.KEEP_PR_READ_FAILED);

  const baseKeep = file.value === null ? { ...req.localKeep, variables: {} } : parseKeep(file.value);
  if (baseKeep === undefined) return failWith(ERROR_CODES.KEEP_PR_READ_FAILED);

  const folded = req.records.reduce(foldEditSaveIntoKeep, baseKeep);
  const content = serializeKeep(folded);
  const noDiff =
    file.value === null ? Object.keys(folded.variables).length === 0 : content === serializeKeep(baseKeep);
  if (noDiff) {
    return { ok: false, report: { changed: true, committed: false, reason: 'NO_DIFF_VS_BASE' } };
  }
  return ok({ path, content, headCommit: head.value.commitSha, baseTree: head.value.treeSha });
}

/** blob -> tree -> commit -> ref -> pull. Each failing step is its own code. */
async function publish(
  req: KeepLockPrRequest,
  target: Target,
  base: string,
  plan: Plan,
  branch: string,
): Promise<KeepLockReport> {
  const { github, repo } = target;
  const blob = await github.createBlob(repo, plan.content);
  if (!blob.ok) return failApi(blob, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const tree = await github.createTree(repo, { baseTree: plan.baseTree, path: plan.path, blobSha: blob.value.sha });
  if (!tree.ok) return failApi(tree, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const commit = await github.createCommit(repo, {
    message: buildCommitMessage(req.records),
    tree: tree.value.sha,
    parent: plan.headCommit,
  });
  if (!commit.ok) return failApi(commit, ERROR_CODES.KEEP_PR_COMMIT_FAILED).report;
  const ref = await github.createRef(repo, branch, commit.value.sha);
  if (!ref.ok) return failApi(ref, ERROR_CODES.KEEP_PR_BRANCH_FAILED).report;
  const pull = await github.createPull(repo, {
    title: PR_TITLE,
    body: buildPrBody(req.command, req.records),
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
  const plan = await planCommit(req, target.value, base.value, deps.keepLockPath(req.cwd));
  if (!plan.ok) return plan;
  const branch = deps.branchName();
  if (!isValidBranchName(branch)) return { report: errorReport(ERROR_CODES.KEEP_PR_BRANCH_FAILED) };
  return { report: await publish(req, target.value, base.value, plan.value, branch) };
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
export function withKeepLock<T extends object>(payload: T, outcome: KeepLockPrOutcome) {
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
