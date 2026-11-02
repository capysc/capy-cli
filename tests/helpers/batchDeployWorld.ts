/**
 * A fake Capy + GitHub + Dokploy world for the batch deploy tests (CAP-704): projects with
 * encrypted branches, repos whose `.capy/deploy.json` and keep.lock differ per branch, and a
 * Dokploy adapter whose calls are read back from `mock` logs. Everything is injected into the
 * engine (`BatchEnv`); nothing here touches the network, `gh`, git or a home directory.
 *
 * Stateless on purpose: answers are a pure function of the fixtures, and what the engine did
 * is read back from the call logs, so no test keeps a mutable fake.
 */
import { createHash } from 'crypto';
import { mock } from 'bun:test';
import { Encryptor } from '../../src/crypto/encryptor';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { serializeKeep } from '../../src/files/fileManager';
import { CapyError, KeepFile } from '../../src/types/index';
import type { ApiResult, GithubApi } from '../../src/deploy/githubApi';
import type { DeployAdapter, DeployContext, DeployResult, PreflightResult, TargetConfig } from '../../src/deploy/adapter';
import type { BatchEnv, BatchTarget } from '../../src/deploy/batchDeploy';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';

/** Values no output may ever contain. */
export const VALUES: Readonly<Record<string, string>> = {
  API_KEY: 'SENTINEL-api-key-7c1d0e5a',
  DB_URL: 'SENTINEL-db-url-2b9e44f1',
};
export const NAME = 'API_KEY';

const hash16 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);
export const hashOf = (name: string): string => hash16(VALUES[name]);

export const PROJECTS = ['pA', 'pB', 'pC'] as const;
export type ProjectId = (typeof PROJECTS)[number];
export const PROJECT_NAMES: Readonly<Record<ProjectId, string>> = { pA: 'mono-backend', pB: 'solo-server', pC: 'unlinked' };
export const KEYS: Readonly<Record<ProjectId, string>> = {
  pA: Encryptor.generateKey(),
  pB: Encryptor.generateKey(),
  pC: Encryptor.generateKey(),
};

export const LEGACY_RECORD = { provider: 'dokploy', target: 'legacy', deployed_value_hash: 'abc123abc123abcd', deployed_at: '2026-01-01T00:00:00.000Z' };

/** The branches the server holds, by `project/branch`. */
export const SERVER_BRANCHES: ReadonlyArray<{ readonly project: ProjectId; readonly branch: string }> = [
  { project: 'pA', branch: 'production' },
  { project: 'pA', branch: 'staging' },
  { project: 'pB', branch: 'staging' },
  { project: 'pC', branch: 'development' },
];

const entryFor = (branch: string, name: string, extra: object = {}) => ({
  resource_id: deriveResourceId(branch, name),
  branch,
  value_hash: hashOf(name),
  changed_at: '2026-01-01T00:00:00.000Z',
  ...extra,
});

/** The server's keep for one (project, branch): API_KEY and DB_URL pinned; pA/production's API_KEY already carries ANOTHER target's record. */
export function serverKeepFor(project: ProjectId, branch: string, vars: readonly string[] = ['API_KEY', 'DB_URL']): KeepFile {
  const extra = project === 'pA' && branch === 'production' ? { targets: [LEGACY_RECORD] } : {};
  return {
    version: '3.0',
    org_id: 'org1',
    project_id: project,
    project_name: PROJECT_NAMES[project],
    variables: Object.fromEntries(vars.map((v) => [v, [entryFor(branch, v, v === 'API_KEY' ? extra : {})]])),
  } as unknown as KeepFile;
}

/** The server's blob for one (project, branch). Built once per call site so the ciphertext is stable. */
export const blobFor = (project: ProjectId, branch: string, vars: readonly string[] = ['API_KEY', 'DB_URL']): string =>
  vars.map((v) => `${v}=capy:${deriveResourceId(branch, v)}:${Encryptor.encrypt(VALUES[v], KEYS[project])}`).join('\n');

export interface ServiceOpts {
  /** The vars every branch holds (default API_KEY and DB_URL). */
  readonly vars?: readonly string[];
  readonly failRead?: Readonly<Record<string, string>>;
  readonly failPush?: Readonly<Record<string, string>>;
  readonly failLatest?: Readonly<Record<string, string>>;
  /** Wait this long in each read (for concurrency tests). */
  readonly delayMs?: (key: string) => number;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeService(opts: ServiceOpts = {}) {
  const vars = opts.vars ?? ['API_KEY', 'DB_URL'];
  const blobs = Object.fromEntries(SERVER_BRANCHES.map((b) => [`${b.project}/${b.branch}`, blobFor(b.project, b.branch, vars)]));
  const find = (project: string, branch: string) => SERVER_BRANCHES.find((b) => b.project === project && b.branch === branch);
  const getDecryptData = mock(async (projectId: string, branch?: string) => {
    const key = `${projectId}/${branch}`;
    const failure = opts.failRead?.[key];
    if (failure) throw new CapyError('read failed', failure);
    await sleepMs(opts.delayMs?.(key) ?? 0);
    const b = find(projectId, branch ?? '');
    if (!b) throw new CapyError('no such branch', 'BRANCH_NOT_FOUND');
    return {
      env_content: blobs[key],
      decrypt_key: '',
      expires_at: '',
      keep_hash: 'h',
      keep_file: JSON.stringify(serverKeepFor(b.project, b.branch, vars)),
    };
  });
  const getLatestSecrets = mock(async (projectId: string, branch: string) => {
    const key = `${projectId}/${branch}`;
    const failure = opts.failLatest?.[key];
    if (failure) throw new CapyError('read failed', failure);
    const b = find(projectId, branch);
    if (!b) return null;
    return { env_file: blobs[key], keep_hash: 'h', keep_file: JSON.stringify(serverKeepFor(b.project, b.branch, vars)) };
  });
  const pushSecrets = mock(async (projectId: string, _keep: string, _blob: string, branch: string) => {
    const failure = opts.failPush?.[`${projectId}/${branch}`];
    if (failure) throw new CapyError('push failed', failure);
    return { keep_hash: 'h2' };
  });
  return { getDecryptData, getLatestSecrets, pushSecrets, blobs };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

export interface RepoFixture {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  /** Files by ref (a branch), then by repo path. A missing path is a missing file. */
  readonly files: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Calls that fail with REQUEST_FAILED: `getFile`, `createPull`, ... */
  readonly fail?: readonly string[];
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failed = (): ApiResult<never> => ({ ok: false, kind: 'REQUEST_FAILED', status: 500 });

export function fakeGithub(repos: readonly RepoFixture[]) {
  const find = (r: { owner: string; name: string }) =>
    repos.find((x) => x.owner.toLowerCase() === r.owner.toLowerCase() && x.name.toLowerCase() === r.name.toLowerCase());
  const guard = <T>(r: { owner: string; name: string }, call: string, value: () => T): ApiResult<T> =>
    find(r)?.fail?.includes(call) ? failed() : ok(value());
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10);
  const api = {
    getRepo: mock(async (r) => {
      const repo = find(r);
      return repo ? ok({ defaultBranch: repo.defaultBranch }) : failed();
    }),
    getDefaultBranches: mock(async (rs: ReadonlyArray<{ owner: string; name: string }>) => ok(rs.map((r) => find(r)?.defaultBranch ?? null))),
    listBranches: mock(async () => ok([] as readonly string[])),
    getBranchHead: mock(async (r, branch: string) => {
      const repo = find(r);
      if (!repo || !(branch in repo.files)) return { ok: false as const, kind: 'NOT_FOUND' as const, status: 404 };
      return guard(r, 'getBranchHead', () => ({ commitSha: `head-${branch}`, treeSha: `tree-${branch}` }));
    }),
    getFile: mock(async (r, path: string, ref: string) => guard(r, 'getFile', () => find(r)?.files[ref]?.[path] ?? null)),
    createBlob: mock(async (r, content: string) => guard(r, 'createBlob', () => ({ sha: `blob-${sha(content)}` }))),
    createTree: mock(async (r) => guard(r, 'createTree', () => ({ sha: `tree-new-${r.name}` }))),
    createCommit: mock(async (r) => guard(r, 'createCommit', () => ({ sha: `commit-${r.name}` }))),
    createRef: mock(async (r, branch: string) => guard(r, 'createRef', () => ({ ref: `refs/heads/${branch}` }))),
    createPull: mock(async (r, params: { head: string }) =>
      guard(r, 'createPull', () => ({ url: `https://github.com/${r.owner}/${r.name}/pull/${params.head.length}` })),
    ),
  } satisfies Record<keyof GithubApi, unknown>;
  return api as unknown as GithubApi & typeof api;
}

// ── Targets ─────────────────────────────────────────────────────────────────

export const dokployTarget = (name: string, over: Partial<TargetConfig> = {}): TargetConfig => ({
  name,
  kind: 'dokploy',
  branch: 'production',
  vars: ['API_KEY', 'DB_URL'],
  mode: 'ci',
  gitBaseBranch: 'main',
  options: { baseUrl: 'https://dokploy.example.com', applicationId: `app-${name}` },
  ...over,
});

const deployJson = (targets: readonly TargetConfig[]): string =>
  JSON.stringify({ version: '1', targets: Object.fromEntries(targets.map((t) => [t.name, t])) });

/** pA's targets on mono's default branch. */
export const MONO_TARGETS: readonly TargetConfig[] = [
  dokployTarget('api'),
  dokployTarget('worker', { vars: ['API_KEY'] }),
  { ...dokployTarget('cf'), kind: 'cf-worker', vars: ['API_KEY'], options: {} },
  dokployTarget('direct', { mode: 'direct', vars: ['API_KEY'] }),
];
export const SOLO_TARGETS: readonly TargetConfig[] = [dokployTarget('site', { branch: 'staging', gitBaseBranch: 'staging', vars: ['API_KEY'] })];
/** A target that exists only on mono's `develop` branch: an unmerged discover PR. */
export const UNMERGED_TARGET: TargetConfig = dokployTarget('unmerged', { vars: ['API_KEY'] });

/** A keep.lock as GitHub holds it for a (project, branch), optionally with the targets already recorded. */
export function githubKeepFor(project: ProjectId, branch: string, recorded: readonly string[] = []): string {
  const keep = serverKeepFor(project, branch);
  const withTargets = (name: string): KeepFile['variables'][string] =>
    keep.variables[name].map((e) => ({
      ...e,
      targets: recorded.map((t) => ({ provider: 'dokploy', target: t, deployed_value_hash: hashOf(name), deployed_at: '2026-01-02T00:00:00.000Z' })),
    }));
  return serializeKeep({ ...keep, variables: { API_KEY: withTargets('API_KEY'), DB_URL: withTargets('DB_URL') } });
}

export interface WorldOpts {
  /** Targets already recorded in mono's keep.lock on main, so the gate sees nothing to do. */
  readonly recordedOnMain?: readonly string[];
  readonly monoFail?: readonly string[];
  readonly soloFail?: readonly string[];
  readonly monoTargets?: readonly TargetConfig[];
}

export function standardRepos(opts: WorldOpts = {}): readonly RepoFixture[] {
  const recorded = opts.recordedOnMain ?? [];
  return [
    {
      owner: 'Acme',
      name: 'mono',
      defaultBranch: 'main',
      fail: opts.monoFail,
      files: {
        main: { 'backend/.capy/deploy.json': deployJson(opts.monoTargets ?? MONO_TARGETS), 'backend/keep.lock': githubKeepFor('pA', 'production', recorded) },
        develop: { 'backend/.capy/deploy.json': deployJson([...(opts.monoTargets ?? MONO_TARGETS), UNMERGED_TARGET]) },
      },
    },
    {
      owner: 'Acme',
      name: 'solo',
      defaultBranch: 'trunk',
      fail: opts.soloFail,
      files: {
        trunk: { '.capy/deploy.json': deployJson(SOLO_TARGETS), 'keep.lock': githubKeepFor('pB', 'staging') },
        staging: { 'keep.lock': githubKeepFor('pB', 'staging') },
      },
    },
  ];
}

export const LINKS: readonly OrgRepoLink[] = [
  { project_id: 'pA', project_name: PROJECT_NAMES.pA, host: 'github.com', owner: 'Acme', name: 'mono', path: 'backend', github_repo_id: 1, last_seen_at: '' },
  { project_id: 'pB', project_name: PROJECT_NAMES.pB, host: 'github.com', owner: 'Acme', name: 'solo', path: '.', github_repo_id: 2, last_seen_at: '' },
];

// ── The secrets index ───────────────────────────────────────────────────────

const loc = (project: ProjectId, branch: string, targets: ReadonlyArray<{ provider: string; target: string }> = []) => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  branch,
  protected: false,
  service: null,
  ...(targets.length === 0 ? {} : { targets: targets.map((t) => ({ ...t, stale: true })) }),
});

/** One row of API_KEY: three locations, with the targets Capy has delivered to (one of them, `ghost`, is no longer in any deploy.json on the default branch). */
export function indexRows(): SecretIndexRow[] {
  return [
    {
      name: NAME,
      value_hash: hashOf(NAME),
      locations: [
        loc('pA', 'production', [
          { provider: 'dokploy', target: 'api' },
          { provider: 'dokploy', target: 'unmerged' },
        ]),
        loc('pA', 'staging'),
        loc('pB', 'staging', [{ provider: 'dokploy', target: 'site' }]),
      ],
      users: [],
    } as SecretIndexRow,
  ];
}

// ── Dokploy adapter and env ─────────────────────────────────────────────────

export interface AdapterScript {
  readonly preflight?: (config: TargetConfig) => PreflightResult;
  readonly deploy?: (config: TargetConfig, ctx: DeployContext) => DeployResult | Promise<DeployResult>;
}

export function fakeAdapter(script: AdapterScript = {}) {
  const preflight = mock(async (config: TargetConfig, _ctx: unknown) => script.preflight?.(config) ?? ({ ok: true } as PreflightResult));
  const deploy = mock(
    async (config: TargetConfig, ctx: DeployContext) =>
      script.deploy?.(config, ctx) ?? ({ ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }] } as DeployResult),
  );
  return {
    id: 'dokploy',
    label: 'Dokploy',
    description: '',
    varKind: 'runtime',
    defaultMode: 'ci',
    requires: { binaries: [] },
    detect: async () => ({}),
    preflight,
    deploy,
  } as unknown as DeployAdapter & { readonly preflight: typeof preflight; readonly deploy: typeof deploy };
}

export function makeEnv(
  service: ReturnType<typeof fakeService>,
  github: GithubApi | undefined,
  adapter: DeployAdapter,
  over: Partial<BatchEnv> = {},
) {
  const openKeys = mock(() => async (projectId: string) => KEYS[projectId as ProjectId]);
  const env: BatchEnv = {
    client: service as unknown as BatchEnv['client'],
    orgId: 'org1',
    openKeys,
    github: () => github,
    branchName: () => 'capy/deploy-test-branch',
    adapter,
    resolveApiKey: async () => undefined,
    ...over,
  };
  return { env, openKeys };
}

/** Every string argument of every call of these mocks, JSON-flattened: what a leak test searches. */
export function everythingSentTo(...mocks: ReadonlyArray<{ readonly mock: { readonly calls: readonly unknown[][] } }>): string {
  return mocks.map((m) => JSON.stringify(m.mock.calls)).join('\n');
}

export const batchTarget = (project: ProjectId, config: TargetConfig, over: Partial<BatchTarget> = {}): BatchTarget => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  branch: config.branch,
  repo: project === 'pA' ? { owner: 'Acme', name: 'mono' } : { owner: 'Acme', name: 'solo' },
  path: project === 'pA' ? 'backend' : '.',
  base: config.gitBaseBranch ?? 'main',
  config,
  ...over,
});
