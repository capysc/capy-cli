/**
 * The small slice of the GitHub REST API the keep.lock PR step needs, reached
 * through the user's own `gh` login (`gh api`).
 *
 * Nothing here clones, checks out, or commits locally: the PR is built
 * remotely (blob -> tree -> commit -> ref -> pull), so the user's checkout is
 * never touched.
 *
 * Every call returns a result, never throws, and a failure is decided only by
 * `gh`'s exit status and the HTTP status code of the response — never by the
 * text of an error message. Arguments always go to `gh` as an argv array
 * (never a shell string) and request bodies go in on stdin (`--input -`).
 */
import { spawn, spawnSync } from 'child_process';
import { text } from 'stream/consumers';
import { RETRY_MAX_ATTEMPTS, Sleep, realSleep, retryDelayMs, retrying, BACKOFF_CAP_MS } from '../utils/backoff';

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export type ApiFailureKind = 'GH_UNAVAILABLE' | 'NOT_FOUND' | 'REQUEST_FAILED' | 'TIMEOUT' | 'RATE_LIMITED';

export interface ApiFailure {
  readonly ok: false;
  readonly kind: ApiFailureKind;
  readonly status?: number;
  /** `RATE_LIMITED` only: how long GitHub asked us to wait, when it said. */
  readonly retryAfterMs?: number;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

export interface TreeEntry {
  readonly path: string;
  readonly blobSha: string;
}

export type CreateTreeParams =
  | { readonly baseTree: string; readonly path: string; readonly blobSha: string }
  | { readonly baseTree: string; readonly entries: readonly TreeEntry[] };

/** The files a `createTree` call writes, whichever shape it was given. */
export function treeEntriesOf(params: CreateTreeParams): readonly TreeEntry[] {
  return 'entries' in params ? params.entries : [{ path: params.path, blobSha: params.blobSha }];
}

/** Injectable seam: tests implement this directly, no network and no `gh`. */
export interface GithubApi {
  getRepo(repo: RepoRef): Promise<ApiResult<{ readonly defaultBranch: string }>>;
  /**
   * The default branch of MANY repos in one GraphQL call per `DEFAULT_BRANCH_CHUNK`
   * repos, in the order given. A repo that is missing, inaccessible or empty comes
   * back `null` (an unknown base), never as a failure; only the call as a whole
   * failing is a failure (then use `getRepo` per repo).
   */
  getDefaultBranches(
    repos: readonly RepoRef[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<ApiResult<ReadonlyArray<string | null>>>;
  listBranches(repo: RepoRef): Promise<ApiResult<readonly string[]>>;
  getBranchHead(repo: RepoRef, branch: string): Promise<ApiResult<{ readonly commitSha: string; readonly treeSha: string }>>;
  /** `value: null` when the file does not exist at `ref`. */
  getFile(repo: RepoRef, path: string, ref: string): Promise<ApiResult<string | null>>;
  createBlob(repo: RepoRef, content: string): Promise<ApiResult<{ readonly sha: string }>>;
  /** One file (`path` + `blobSha`) or several (`entries`) written onto `baseTree` as one tree. */
  createTree(repo: RepoRef, params: CreateTreeParams): Promise<ApiResult<{ readonly sha: string }>>;
  createCommit(
    repo: RepoRef,
    params: { readonly message: string; readonly tree: string; readonly parent: string },
  ): Promise<ApiResult<{ readonly sha: string }>>;
  createRef(repo: RepoRef, branch: string, sha: string): Promise<ApiResult<{ readonly ref: string }>>;
  createPull(
    repo: RepoRef,
    params: { readonly title: string; readonly body: string; readonly head: string; readonly base: string },
  ): Promise<ApiResult<{ readonly url: string }>>;
}

// ---------------------------------------------------------------------------
// Remote identity
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

function splitRemote(url: string): { readonly host: string; readonly path: string } | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, path: parsed.pathname };
    } catch {
      return null;
    }
  }
  // scp-like: [user@]host:owner/name(.git)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(url);
  return scp ? { host: scp[1], path: scp[2] } : null;
}

export interface RemoteRef {
  /** Lowercased bare hostname (no port, no userinfo). */
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * `host`, `owner` and `name` of an `origin` URL on ANY host: SSH (scp-like or
 * `ssh://`), HTTPS or `git://`, with or without `.git`. Userinfo (tokens, user
 * names) and any port are dropped here and appear nowhere in the result. A path
 * that is not exactly `owner/name` (a GitLab subgroup, say) is `null`.
 */
export function parseRemote(url: string): RemoteRef | null {
  const parts = splitRemote(url.trim());
  if (!parts) return null;
  const segments = parts.path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  const valid = [owner, name].every((s) => NAME_RE.test(s) && s !== '.' && s !== '..');
  return valid && parts.host.length > 0 ? { host: parts.host.toLowerCase(), owner, name } : null;
}

/**
 * `owner/name` on github.com from an `origin` URL. Userinfo (tokens, user
 * names) is dropped here and appears nowhere in the result. Anything that is
 * not a github.com repository is `null`.
 */
export function parseGithubRemote(url: string): RepoRef | null {
  const remote = parseRemote(url);
  return remote !== null && remote.host === 'github.com' ? { owner: remote.owner, name: remote.name } : null;
}

/** git's ref-name rules (`git check-ref-format`), for a branch name. */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
    return false;
  }
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  return name.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

// ---------------------------------------------------------------------------
// gh runner
// ---------------------------------------------------------------------------

export interface GhRunResult {
  /** false when `gh` could not be started at all. */
  readonly spawned: boolean;
  readonly status: number | null;
  readonly stdout: string;
  /** `gh` did not finish in time and was killed (`spawned` is true, `status` is null). */
  readonly timedOut?: boolean;
  /** The caller's `signal` aborted the call and `gh` was killed. */
  readonly aborted?: boolean;
}

export interface GhRunOptions {
  /** Kill `gh` after this long. Default: `GH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Kill `gh` when this aborts. */
  readonly signal?: AbortSignal;
}

/** A `gh` runner may answer at once (a test double, `spawnGhRunner`) or later (`spawnGhRunnerAsync`). */
export type GhRunner = (
  args: readonly string[],
  stdin?: string,
  opts?: GhRunOptions,
) => GhRunResult | Promise<GhRunResult>;

/** Every `gh` call is stopped after this long, so nothing waits forever on a stalled network. */
export const GH_TIMEOUT_MS = 20_000;
/** The batched GraphQL read gets a little longer (it carries up to 50 repos). */
export const GH_GRAPHQL_TIMEOUT_MS = 30_000;

/** `gh`'s documented exit status for "authentication required". */
const GH_EXIT_AUTH_REQUIRED = 4;

/** Runs the real `gh` with an argv array. stderr is captured and discarded, never printed. */
export function spawnGhRunner(gh: string, defaultTimeoutMs: number = GH_TIMEOUT_MS): GhRunner {
  return (args, stdin, opts) => {
    const r = spawnSync(gh, [...args], {
      encoding: 'utf-8',
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts?.timeoutMs ?? defaultTimeoutMs,
      killSignal: 'SIGKILL',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    // Node reports a killed-on-timeout child as an `ETIMEDOUT` error with a null status.
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { spawned: r.error === undefined || timedOut, status: r.status, stdout: r.stdout ?? '', ...(timedOut ? { timedOut } : {}) };
  };
}

/**
 * The same, without blocking the event loop: for a caller that draws a screen
 * while `gh` runs, and for several `gh` calls at once. stderr is discarded.
 */
export function spawnGhRunnerAsync(gh: string, defaultTimeoutMs: number = GH_TIMEOUT_MS): GhRunner {
  return (args, stdin, opts) =>
    new Promise<GhRunResult>((resolve) => {
      if (opts?.signal?.aborted) return resolve({ spawned: true, status: null, stdout: '', aborted: true });
      const child = spawn(gh, [...args], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      });
      // The only thing this module ever kills `gh` for is the timeout and the caller's abort, both with SIGKILL.
      const kill = () => child.kill('SIGKILL');
      const timer = setTimeout(kill, opts?.timeoutMs ?? defaultTimeoutMs);
      opts?.signal?.addEventListener('abort', kill, { once: true });
      type Ended = { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string };
      const printed = child.stdout ? text(child.stdout).catch(() => '') : Promise.resolve('');
      // Normally the call ends when `gh` has closed its output. A killed `gh` ends it at once: a grandchild still
      // holding the pipe open must not keep a timed-out call waiting.
      const closed = new Promise<Ended>((done) =>
        child.on('close', (status, signal) => void printed.then((stdout) => done({ status, signal, stdout }))),
      );
      const killed = new Promise<Ended>((done) =>
        child.once('exit', (status, signal) => (signal === 'SIGKILL' ? done({ status, signal, stdout: '' }) : undefined)),
      );
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ spawned: false, status: null, stdout: '' });
      });
      void Promise.race([closed, killed]).then(({ status, signal, stdout }) => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', kill);
        const aborted = opts?.signal?.aborted === true;
        const timedOut = signal === 'SIGKILL' && !aborted;
        resolve({ spawned: true, status, stdout, ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin);
    });
}

interface Included {
  readonly status: number;
  /** Response headers, names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Splits `gh api --include` output: the status of the first line, the headers, and the body after the blank line. */
function parseIncluded(stdout: string): Included | null {
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(stdout);
  if (!statusMatch) return null;
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split ? stdout.slice(0, split.index) : stdout;
  const headers = Object.fromEntries(
    head
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const colon = line.indexOf(':');
        return colon <= 0 ? [] : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const];
      }),
  );
  return { status: Number(statusMatch[1]), headers, body: split ? stdout.slice(split.index + split[0].length) : '' };
}

/**
 * Is this response a rate limit, and how long did GitHub ask us to wait? Decided by the
 * STATUS and the structured headers only: 429, or 403 carrying `retry-after` or
 * `x-ratelimit-remaining: 0` (GitHub's secondary and primary limits). Never by the body's words.
 */
export function rateLimitOf(status: number, headers: Readonly<Record<string, string>>): { readonly retryAfterMs?: number } | undefined {
  const limited = status === 429 || (status === 403 && (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0'));
  if (!limited) return undefined;
  const seconds = Number(headers['retry-after']);
  const reset = Number(headers['x-ratelimit-reset']);
  const retryAfterMs = Number.isFinite(seconds) && headers['retry-after'] !== undefined
    ? seconds * 1000
    : Number.isFinite(reset) && headers['x-ratelimit-reset'] !== undefined
      ? Math.max(0, reset * 1000 - Date.now())
      : undefined;
  return retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(BACKOFF_CAP_MS, retryAfterMs) };
}

function failureFor(status: number | null, headers: Readonly<Record<string, string>> = {}): ApiFailure {
  if (status === 401) return { ok: false, kind: 'GH_UNAVAILABLE', status };
  if (status === 404) return { ok: false, kind: 'NOT_FOUND', status };
  const limited = status === null ? undefined : rateLimitOf(status, headers);
  if (status !== null && limited !== undefined) {
    return { ok: false, kind: 'RATE_LIMITED', status, ...(limited.retryAfterMs === undefined ? {} : { retryAfterMs: limited.retryAfterMs }) };
  }
  return status === null ? { ok: false, kind: 'REQUEST_FAILED' } : { ok: false, kind: 'REQUEST_FAILED', status };
}

/**
 * `run`, but a call GitHub rate limited is tried again after the wait it asked for (else 2s, 4s, 8s),
 * up to `RETRY_MAX_ATTEMPTS` attempts. A rejected request did not happen, so repeating even a write is safe.
 * Every other answer passes through untouched.
 */
export function withRateLimitBackoff(run: GhRunner, sleep: Sleep = realSleep): GhRunner {
  return (args, stdin, opts) =>
    retrying(
      async () => run(args, stdin, opts),
      (r) => {
        const included = r.spawned ? parseIncluded(r.stdout) : null;
        return included === null ? undefined : (rateLimitOf(included.status, included.headers) === undefined ? undefined : { afterMs: rateLimitOf(included.status, included.headers)?.retryAfterMs });
      },
      sleep,
      opts?.signal,
    );
}

export { RETRY_MAX_ATTEMPTS, retryDelayMs };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function request(
  run: GhRunner,
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown,
  opts?: GhRunOptions,
): Promise<ApiResult<unknown>> {
  const args = [
    'api',
    '--hostname',
    'github.com',
    '--include',
    '--method',
    method,
    '-H',
    'Accept: application/vnd.github+json',
    ...(body === undefined ? [] : ['--input', '-']),
    endpoint,
  ];
  const r = await run(args, body === undefined ? undefined : JSON.stringify(body), opts);
  if (!r.spawned || r.status === GH_EXIT_AUTH_REQUIRED) return { ok: false, kind: 'GH_UNAVAILABLE' };
  if (r.timedOut === true) return { ok: false, kind: 'TIMEOUT' };
  if (r.aborted === true) return { ok: false, kind: 'REQUEST_FAILED' };
  const included = parseIncluded(r.stdout);
  if (!included) return { ok: false, kind: 'REQUEST_FAILED' };
  if (included.status >= 400) return failureFor(included.status, included.headers);
  return { ok: true, value: parseJson(included.body) };
}

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
}

function pick<T>(result: ApiResult<unknown>, read: (v: Obj) => T | undefined): ApiResult<T> {
  if (!result.ok) return result;
  const obj = asObject(result.value);
  const value = obj ? read(obj) : undefined;
  return value === undefined ? { ok: false, kind: 'REQUEST_FAILED' } : { ok: true, value };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function nested(obj: Obj, key: string, field: string): string | undefined {
  const inner = asObject(obj[key]);
  return inner ? str(inner[field]) : undefined;
}

const segment = (s: string): string => s.split('/').map(encodeURIComponent).join('/');
const base = (repo: RepoRef): string => `repos/${repo.owner}/${repo.name}`;

/** Repos per GraphQL query. */
export const DEFAULT_BRANCH_CHUNK = 50;

/** `items` in consecutive groups of at most `size`. */
export function chunked<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  return items.length === 0 ? [] : [items.slice(0, size), ...chunked(items.slice(size), size)];
}

/**
 * ONE GraphQL query for `repos`: an aliased `repository(owner:, name:)` field each.
 * The names go in as variables, never into the query text. GitHub answers 200 with
 * `data` (a missing or inaccessible repo is a null node, with an `errors` entry) or,
 * when the call as a whole is refused, no `data` at all: only that is a failure.
 */
async function defaultBranchChunk(
  run: GhRunner,
  repos: readonly RepoRef[],
  signal?: AbortSignal,
): Promise<ApiResult<ReadonlyArray<string | null>>> {
  const declared = repos.map((_, i) => `$o${i}:String!,$n${i}:String!`).join(',');
  const fields = repos
    .map((_, i) => `r${i}:repository(owner:$o${i},name:$n${i}){defaultBranchRef{name}}`)
    .join(' ');
  const variables = Object.fromEntries(repos.flatMap((r, i) => [[`o${i}`, r.owner], [`n${i}`, r.name]]));
  const answer = await request(run, 'POST', 'graphql', { query: `query(${declared}){${fields}}`, variables }, { timeoutMs: GH_GRAPHQL_TIMEOUT_MS, signal });
  if (!answer.ok) return answer;
  const data = asObject(asObject(answer.value)?.data);
  if (data === undefined) return { ok: false, kind: 'REQUEST_FAILED' };
  return { ok: true, value: repos.map((_, i) => nested(asObject(data[`r${i}`]) ?? {}, 'defaultBranchRef', 'name') ?? null) };
}

/** The real implementation: every call is one `gh api` invocation. */
export function createGhApi(rawRun: GhRunner, sleep: Sleep = realSleep): GithubApi {
  const run = withRateLimitBackoff(rawRun, sleep);
  const post = (repo: RepoRef, path: string, body: unknown) => request(run, 'POST', `${base(repo)}/${path}`, body);
  return {
    async getRepo(repo) {
      return pick(await request(run, 'GET', base(repo)), (o) => {
        const defaultBranch = str(o.default_branch);
        return defaultBranch === undefined ? undefined : { defaultBranch };
      });
    },

    async getDefaultBranches(repos, opts) {
      const chunks = chunked(repos, DEFAULT_BRANCH_CHUNK);
      const results = await Promise.all(chunks.map((chunk) => defaultBranchChunk(run, chunk, opts?.signal)));
      const failed = results.find((r) => !r.ok);
      return failed && !failed.ok ? failed : { ok: true, value: results.flatMap((r) => (r.ok ? r.value : [])) };
    },

    async listBranches(repo) {
      // `--jq` prints one name per line across every page; only the exit status decides success.
      const r = await run(
        ['api', '--hostname', 'github.com', '--paginate', `${base(repo)}/branches?per_page=100`, '--jq', '.[].name'],
        undefined,
      );
      if (!r.spawned || r.status === GH_EXIT_AUTH_REQUIRED) return { ok: false, kind: 'GH_UNAVAILABLE' };
      if (r.timedOut === true) return { ok: false, kind: 'TIMEOUT' };
      if (r.status !== 0) return { ok: false, kind: 'REQUEST_FAILED' };
      return { ok: true, value: r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
    },

    async getBranchHead(repo, branch) {
      const ref = pick(await request(run, 'GET', `${base(repo)}/git/ref/heads/${segment(branch)}`), (o) =>
        nested(o, 'object', 'sha'),
      );
      if (!ref.ok) return ref;
      const commit = pick(await request(run, 'GET', `${base(repo)}/git/commits/${ref.value}`), (o) => nested(o, 'tree', 'sha'));
      if (!commit.ok) return commit;
      return { ok: true, value: { commitSha: ref.value, treeSha: commit.value } };
    },

    async getFile(repo, path, ref) {
      const result = await request(run, 'GET', `${base(repo)}/contents/${segment(path)}?ref=${encodeURIComponent(ref)}`);
      if (!result.ok) return result.kind === 'NOT_FOUND' ? { ok: true, value: null } : result;
      const obj = asObject(result.value);
      const content = obj && obj.encoding === 'base64' ? str(obj.content) : undefined;
      if (content === undefined) return { ok: false, kind: 'REQUEST_FAILED' };
      return { ok: true, value: Buffer.from(content, 'base64').toString('utf-8') };
    },

    async createBlob(repo, content) {
      return pick(await post(repo, 'git/blobs', { content, encoding: 'utf-8' }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createTree(repo, params) {
      const tree = treeEntriesOf(params).map(({ path, blobSha }) => ({ path, mode: '100644', type: 'blob', sha: blobSha }));
      return pick(await post(repo, 'git/trees', { base_tree: params.baseTree, tree }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createCommit(repo, { message, tree, parent }) {
      return pick(await post(repo, 'git/commits', { message, tree, parents: [parent] }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createRef(repo, branch, sha) {
      return pick(await post(repo, 'git/refs', { ref: `refs/heads/${branch}`, sha }), (o) => {
        const ref = str(o.ref);
        return ref === undefined ? undefined : { ref };
      });
    },

    async createPull(repo, { title, body, head, base: baseBranch }) {
      return pick(await post(repo, 'pulls', { title, body, head, base: baseBranch }), (o) => {
        const url = str(o.html_url);
        return url === undefined ? undefined : { url };
      });
    },
  };
}

/** The `gh` argv that prints a repository's numeric id (`gh api repos/{owner}/{name} --jq .id`). */
export function repoIdArgs(repo: RepoRef): readonly string[] {
  return ['api', '--hostname', 'github.com', base(repo), '--jq', '.id'];
}

/** A positive integer id from what `repoIdArgs` printed, else `undefined`. */
export function parseRepoId(stdout: string): number | undefined {
  const id = Number(stdout.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
