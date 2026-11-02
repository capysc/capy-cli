/**
 * A fake Capy world for the `capy secrets` edit tests (CAP-698): projects and
 * branches holding one secret NAME, a service that answers `getDecryptData` /
 * `pushSecrets`, and a GitHub that answers the PR calls. Everything is injected
 * into the engine (`SetEnv`); nothing here touches the network, `gh`, git or a
 * home directory.
 *
 * Stateless on purpose: the service's answers are a pure function of the fixtures,
 * and what the engine did is read back from the `mock` call logs, so no test
 * needs a mutable fake.
 */
import { createHash } from 'crypto';
import { mock } from 'bun:test';
import { Encryptor } from '../../src/crypto/encryptor';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { SyncEngine } from '../../src/sync/syncEngine';
import { serializeKeep } from '../../src/files/fileManager';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';
import type { ApiResult, GithubApi } from '../../src/deploy/githubApi';
import type { SetEnv } from '../../src/commands/secretsSet';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';

export const NAME = 'ANTHROPIC_API_KEY';
export const OLD_VALUE = 'old-value-0000';
/** A value no output may ever contain. */
export const SENTINEL = 'SENTINEL-new-secret-value-9f3a1c';
export const OTHER_NAME = 'OTHER_VAR';
export const OTHER_VALUE = 'other-value-1111';

const hash16 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);

export const PROJECT_IDS = ['pA', 'pB', 'pC', 'pD'] as const;
export type ProjectId = (typeof PROJECT_IDS)[number];

export const PROJECT_NAMES: Readonly<Record<ProjectId, string>> = {
  pA: 'mono-backend',
  pB: 'mono-frontend',
  pC: 'solo-server',
  pD: 'unlinked',
};

/** One key per project: a value encrypted for one project cannot be read with another's key. */
export const KEYS: Readonly<Record<ProjectId, string>> = {
  pA: Encryptor.generateKey(),
  pB: Encryptor.generateKey(),
  pC: Encryptor.generateKey(),
  pD: Encryptor.generateKey(),
};

export interface Loc {
  readonly project: ProjectId;
  readonly branch: string;
  readonly protected?: boolean;
  /** What NAME currently holds there. */
  readonly value?: string;
  /** What OTHER_VAR's pinned hash on GitHub should be, to make GitHub's keep.lock diverge from the server's. */
  readonly githubOtherHash?: string;
}

export const LOCATIONS: readonly Loc[] = [
  { project: 'pA', branch: 'production', protected: true },
  { project: 'pA', branch: 'staging' },
  { project: 'pB', branch: 'production', protected: true },
  { project: 'pC', branch: 'development' },
  { project: 'pD', branch: 'development' },
];

const keyOf = (l: { project: ProjectId; branch: string }): string => `${l.project}/${l.branch}`;

function envBlob(l: Loc): string {
  const key = KEYS[l.project];
  const line = (name: string, value: string) =>
    `${name}=capy:${deriveResourceId(l.branch, name)}:${Encryptor.encrypt(value, key)}`;
  return [line(OTHER_NAME, OTHER_VALUE), line(NAME, l.value ?? OLD_VALUE)].join('\n');
}

/** The server's keep for a project: NAME and OTHER_VAR pinned on every branch listed. */
export function serverKeep(project: ProjectId, locs: readonly Loc[] = LOCATIONS): KeepFile {
  const mine = locs.filter((l) => l.project === project);
  const entry = (name: string, branch: string, value: string) => ({
    resource_id: deriveResourceId(branch, name),
    branch,
    value_hash: hash16(value),
    changed_at: '2026-01-01T00:00:00.000Z',
  });
  return {
    version: '3.0',
    org_id: 'org1',
    project_id: project,
    project_name: PROJECT_NAMES[project],
    variables: {
      [NAME]: mine.map((l) => entry(NAME, l.branch, l.value ?? OLD_VALUE)),
      [OTHER_NAME]: mine.map((l) => entry(OTHER_NAME, l.branch, OTHER_VALUE)),
    },
  };
}

export interface ServiceOpts {
  readonly locs?: readonly Loc[];
  /** `project/branch` keys whose push (or read) fails with this code. */
  readonly failPush?: Readonly<Record<string, string>>;
  readonly failRead?: Readonly<Record<string, string>>;
}

/** The fake service: `getDecryptData` answers from fixtures, `pushSecrets` is a mock that stamps `changed_at`. */
export function fakeService(opts: ServiceOpts = {}) {
  const locs = opts.locs ?? LOCATIONS;
  // Built once, so every read of a branch returns the very same ciphertext (a fresh encrypt would differ each time).
  const blobs = Object.fromEntries(locs.map((l) => [keyOf(l), envBlob(l)]));
  const getDecryptData = mock(async (projectId: string, branch?: string) => {
    const l = locs.find((x) => x.project === projectId && x.branch === branch);
    const failure = opts.failRead?.[`${projectId}/${branch}`];
    if (failure) throw new CapyError('read failed', failure);
    if (!l) throw new CapyError('no such branch', ERROR_CODES.BRANCH_NOT_FOUND);
    return {
      env_content: blobs[keyOf(l)],
      decrypt_key: '',
      expires_at: '',
      keep_file: JSON.stringify(serverKeep(l.project, locs)),
    };
  });
  const pushSecrets = mock(async (projectId: string, keepFile: string, _blob: string, branch: string) => {
    const failure = opts.failPush?.[`${projectId}/${branch}`];
    if (failure) throw new CapyError('push failed', failure);
    const keep = JSON.parse(keepFile) as KeepFile;
    const stamped: KeepFile = {
      ...keep,
      variables: Object.fromEntries(
        Object.entries(keep.variables).map(([name, entries]) => [
          name,
          entries.map((e) => (e.branch === branch && name === NAME ? { ...e, changed_at: '2026-10-02T00:00:00.000Z' } : e)),
        ]),
      ),
    };
    return { keep_hash: SyncEngine.computeKeepHash(keep, branch), keep_file: JSON.stringify(stamped) };
  });
  return { getDecryptData, pushSecrets };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

export interface RepoFixture {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  /** keep.lock text by repo path; a missing path is a missing file. */
  readonly files: Readonly<Record<string, string>>;
  /** Make a call fail: `createPull`, `createRef`, ... */
  readonly fail?: readonly string[];
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const fail = (): ApiResult<never> => ({ ok: false, kind: 'REQUEST_FAILED', status: 500 });

export function fakeGithub(repos: readonly RepoFixture[]) {
  const find = (r: { owner: string; name: string }) =>
    repos.find((x) => x.owner.toLowerCase() === r.owner.toLowerCase() && x.name.toLowerCase() === r.name.toLowerCase());
  const guard = <T>(r: { owner: string; name: string }, call: string, value: () => T): ApiResult<T> =>
    find(r)?.fail?.includes(call) ? fail() : ok(value());
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10);

  const api = {
    getRepo: mock(async (r) => {
      const repo = find(r);
      return repo ? guard(r, 'getRepo', () => ({ defaultBranch: repo.defaultBranch })) : fail();
    }),
    // ONE batched read for many repos; a repo it does not know is null (an unknown base), like GitHub's null node.
    getDefaultBranches: mock(async (repos: ReadonlyArray<{ owner: string; name: string }>) => {
      const failing = repos.some((r) => find(r)?.fail?.includes('getDefaultBranches'));
      return failing ? fail() : ok(repos.map((r) => find(r)?.defaultBranch ?? null));
    }),
    listBranches: mock(async () => ok([] as readonly string[])),
    getBranchHead: mock(async (r) => guard(r, 'getBranchHead', () => ({ commitSha: `head-${r.name}`, treeSha: `tree-${r.name}` }))),
    getFile: mock(async (r, path: string) => guard(r, 'getFile', () => find(r)?.files[path] ?? null)),
    createBlob: mock(async (r, content: string) => guard(r, 'createBlob', () => ({ sha: `blob-${sha(content)}` }))),
    createTree: mock(async (r) => guard(r, 'createTree', () => ({ sha: `tree-new-${r.name}` }))),
    createCommit: mock(async (r) => guard(r, 'createCommit', () => ({ sha: `commit-${r.name}` }))),
    createRef: mock(async (r, branch: string) => guard(r, 'createRef', () => ({ ref: `refs/heads/${branch}` }))),
    createPull: mock(async (r) => guard(r, 'createPull', () => ({ url: `https://github.com/${r.owner}/${r.name}/pull/${r.name.length}` }))),
  } satisfies Record<keyof GithubApi, unknown>;
  return api as unknown as GithubApi & typeof api;
}

/** A keep.lock text as GitHub holds it: the project's entries, optionally with OTHER_VAR pinned to a different hash. */
export function githubKeep(project: ProjectId, locs: readonly Loc[] = LOCATIONS): string {
  const base = serverKeep(project, locs);
  const mine = locs.filter((l) => l.project === project);
  const other = (base.variables[OTHER_NAME] ?? []).map((e) => {
    const l = mine.find((x) => x.branch === e.branch);
    return l?.githubOtherHash ? { ...e, value_hash: l.githubOtherHash } : e;
  });
  return serializeKeep({ ...base, variables: { ...base.variables, [OTHER_NAME]: other } });
}

// ── Env, rows and links ─────────────────────────────────────────────────────

export function makeEnv(service: ReturnType<typeof fakeService>, github: GithubApi | undefined): SetEnv & {
  readonly writeCache: ReturnType<typeof mock>;
} {
  const writeCache = mock((_o: string, _p: string, _h: string, _b: string) => undefined);
  return {
    client: service as unknown as SetEnv['client'],
    orgId: 'org1',
    openKeys: () => async (projectId) => KEYS[projectId as ProjectId],
    writeCache,
    github: () => github,
    branchName: () => 'capy/keep-lock-test-branch',
  };
}

/** The `capy secrets` rows: one row per distinct current value of NAME. */
export function indexRows(locs: readonly Loc[] = LOCATIONS): SecretIndexRow[] {
  const values = [...new Set(locs.map((l) => l.value ?? OLD_VALUE))];
  return values.map((v) => ({
    name: NAME,
    value_hash: hash16(v),
    locations: locs
      .filter((l) => (l.value ?? OLD_VALUE) === v)
      .map((l) => ({
        project_id: l.project,
        project_name: PROJECT_NAMES[l.project],
        branch: l.branch,
        protected: l.protected === true,
        service: null,
      })),
    users: [],
  }));
}

export const LINKS: readonly OrgRepoLink[] = [
  { project_id: 'pA', project_name: PROJECT_NAMES.pA, host: 'github.com', owner: 'Acme', name: 'mono', path: 'backend', github_repo_id: 1, last_seen_at: '' },
  { project_id: 'pB', project_name: PROJECT_NAMES.pB, host: 'github.com', owner: 'acme', name: 'Mono', path: 'frontend', github_repo_id: 1, last_seen_at: '' },
  { project_id: 'pC', project_name: PROJECT_NAMES.pC, host: 'github.com', owner: 'Acme', name: 'solo', path: '.', github_repo_id: 2, last_seen_at: '' },
];

export function standardRepos(locs: readonly Loc[] = LOCATIONS): readonly RepoFixture[] {
  return [
    {
      owner: 'Acme',
      name: 'mono',
      defaultBranch: 'main',
      files: { 'backend/keep.lock': githubKeep('pA', locs), 'frontend/keep.lock': githubKeep('pB', locs) },
    },
    { owner: 'Acme', name: 'solo', defaultBranch: 'trunk', files: { 'keep.lock': githubKeep('pC', locs) } },
  ];
}

/** Every string argument of every call of these mocks, JSON-flattened: what a leak test searches. */
export function everythingSentTo(...mocks: ReadonlyArray<{ readonly mock: { readonly calls: readonly unknown[][] } }>): string {
  return mocks.map((m) => JSON.stringify(m.mock.calls)).join('\n');
}

// ── Bigger worlds, for the concurrency tests ────────────────────────────────

/** `n` locations spread over the four projects (a, b, c, then d), in a fixed order: the first project gets the most branches. */
export function manyLocs(n: number): readonly Loc[] {
  const perProject = Math.ceil(n / PROJECT_IDS.length);
  return Array.from({ length: n }, (_, i): Loc => ({
    project: PROJECT_IDS[Math.floor(i / perProject)],
    branch: `br${i}`,
    protected: i === 0,
  }));
}

/** `n` repos that each carry project pC's keep.lock at the root, with GitHub fixtures to match. */
export function manyRepos(n: number, locs: readonly Loc[] = LOCATIONS) {
  const names = Array.from({ length: n }, (_, i) => `repo${i + 1}`);
  return {
    targets: names.map((name) => ({
      host: 'github.com',
      owner: 'Acme',
      name,
      files: [{ project_id: 'pC', project_name: PROJECT_NAMES.pC, path: '.' }],
    })),
    fixtures: names.map((name): RepoFixture => ({ owner: 'Acme', name, defaultBranch: 'main', files: { 'keep.lock': githubKeep('pC', locs) } })),
    bases: Object.fromEntries(names.map((name) => [`github.com/acme/${name}`, 'main'])) as Readonly<Record<string, string>>,
  };
}
