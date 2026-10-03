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
import { spawnSync } from 'child_process';

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export type ApiFailureKind = 'GH_UNAVAILABLE' | 'NOT_FOUND' | 'REQUEST_FAILED';

export interface ApiFailure {
  readonly ok: false;
  readonly kind: ApiFailureKind;
  readonly status?: number;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

/** Injectable seam: tests implement this directly, no network and no `gh`. */
export interface GithubApi {
  getRepo(repo: RepoRef): Promise<ApiResult<{ readonly defaultBranch: string }>>;
  listBranches(repo: RepoRef): Promise<ApiResult<readonly string[]>>;
  getBranchHead(repo: RepoRef, branch: string): Promise<ApiResult<{ readonly commitSha: string; readonly treeSha: string }>>;
  /** `value: null` when the file does not exist at `ref`. */
  getFile(repo: RepoRef, path: string, ref: string): Promise<ApiResult<string | null>>;
  createBlob(repo: RepoRef, content: string): Promise<ApiResult<{ readonly sha: string }>>;
  createTree(
    repo: RepoRef,
    params: { readonly baseTree: string; readonly path: string; readonly blobSha: string },
  ): Promise<ApiResult<{ readonly sha: string }>>;
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

/**
 * `owner/name` on github.com from an `origin` URL: SSH (scp-like or `ssh://`),
 * HTTPS or `git://`, with or without `.git`. Userinfo (tokens, user names) is
 * dropped here and appears nowhere in the result. Anything that is not a
 * github.com repository is `null`.
 */
export function parseGithubRemote(url: string): RepoRef | null {
  const parts = splitRemote(url.trim());
  if (!parts || parts.host.toLowerCase() !== 'github.com') return null;
  const segments = parts.path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  const valid = [owner, name].every((s) => NAME_RE.test(s) && s !== '.' && s !== '..');
  return valid ? { owner, name } : null;
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
}

export type GhRunner = (args: readonly string[], stdin?: string) => GhRunResult;

/** `gh`'s documented exit status for "authentication required". */
const GH_EXIT_AUTH_REQUIRED = 4;

/** Runs the real `gh` with an argv array. stderr is captured and discarded, never printed. */
export function spawnGhRunner(gh: string): GhRunner {
  return (args, stdin) => {
    const r = spawnSync(gh, [...args], {
      encoding: 'utf-8',
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    return { spawned: r.error === undefined, status: r.status, stdout: r.stdout ?? '' };
  };
}

interface Included {
  readonly status: number;
  readonly body: string;
}

/** Splits `gh api --include` output: the numeric status of the first line, and the body after the blank line. */
function parseIncluded(stdout: string): Included | null {
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(stdout);
  if (!statusMatch) return null;
  const split = /\r?\n\r?\n/.exec(stdout);
  return { status: Number(statusMatch[1]), body: split ? stdout.slice(split.index + split[0].length) : '' };
}

function failureFor(status: number | null): ApiFailure {
  if (status === 401) return { ok: false, kind: 'GH_UNAVAILABLE', status };
  if (status === 404) return { ok: false, kind: 'NOT_FOUND', status };
  return status === null ? { ok: false, kind: 'REQUEST_FAILED' } : { ok: false, kind: 'REQUEST_FAILED', status };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function request(run: GhRunner, method: 'GET' | 'POST', endpoint: string, body?: unknown): ApiResult<unknown> {
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
  const r = run(args, body === undefined ? undefined : JSON.stringify(body));
  if (!r.spawned || r.status === GH_EXIT_AUTH_REQUIRED) return { ok: false, kind: 'GH_UNAVAILABLE' };
  const included = parseIncluded(r.stdout);
  if (!included) return { ok: false, kind: 'REQUEST_FAILED' };
  if (included.status >= 400) return failureFor(included.status);
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

/** The real implementation: every call is one `gh api` invocation. */
export function createGhApi(run: GhRunner): GithubApi {
  const post = (repo: RepoRef, path: string, body: unknown) => request(run, 'POST', `${base(repo)}/${path}`, body);
  return {
    async getRepo(repo) {
      return pick(request(run, 'GET', base(repo)), (o) => {
        const defaultBranch = str(o.default_branch);
        return defaultBranch === undefined ? undefined : { defaultBranch };
      });
    },

    async listBranches(repo) {
      // `--jq` prints one name per line across every page; only the exit status decides success.
      const r = run(
        ['api', '--hostname', 'github.com', '--paginate', `${base(repo)}/branches?per_page=100`, '--jq', '.[].name'],
        undefined,
      );
      if (!r.spawned || r.status === GH_EXIT_AUTH_REQUIRED) return { ok: false, kind: 'GH_UNAVAILABLE' };
      if (r.status !== 0) return { ok: false, kind: 'REQUEST_FAILED' };
      return { ok: true, value: r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
    },

    async getBranchHead(repo, branch) {
      const ref = pick(request(run, 'GET', `${base(repo)}/git/ref/heads/${segment(branch)}`), (o) =>
        nested(o, 'object', 'sha'),
      );
      if (!ref.ok) return ref;
      const commit = pick(request(run, 'GET', `${base(repo)}/git/commits/${ref.value}`), (o) => nested(o, 'tree', 'sha'));
      if (!commit.ok) return commit;
      return { ok: true, value: { commitSha: ref.value, treeSha: commit.value } };
    },

    async getFile(repo, path, ref) {
      const result = request(run, 'GET', `${base(repo)}/contents/${segment(path)}?ref=${encodeURIComponent(ref)}`);
      if (!result.ok) return result.kind === 'NOT_FOUND' ? { ok: true, value: null } : result;
      const obj = asObject(result.value);
      const content = obj && obj.encoding === 'base64' ? str(obj.content) : undefined;
      if (content === undefined) return { ok: false, kind: 'REQUEST_FAILED' };
      return { ok: true, value: Buffer.from(content, 'base64').toString('utf-8') };
    },

    async createBlob(repo, content) {
      return pick(post(repo, 'git/blobs', { content, encoding: 'utf-8' }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createTree(repo, { baseTree, path, blobSha }) {
      const tree = [{ path, mode: '100644', type: 'blob', sha: blobSha }];
      return pick(post(repo, 'git/trees', { base_tree: baseTree, tree }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createCommit(repo, { message, tree, parent }) {
      return pick(post(repo, 'git/commits', { message, tree, parents: [parent] }), (o) => {
        const sha = str(o.sha);
        return sha === undefined ? undefined : { sha };
      });
    },

    async createRef(repo, branch, sha) {
      return pick(post(repo, 'git/refs', { ref: `refs/heads/${branch}`, sha }), (o) => {
        const ref = str(o.ref);
        return ref === undefined ? undefined : { ref };
      });
    },

    async createPull(repo, { title, body, head, base: baseBranch }) {
      return pick(post(repo, 'pulls', { title, body, head, base: baseBranch }), (o) => {
        const url = str(o.html_url);
        return url === undefined ? undefined : { url };
      });
    },
  };
}
