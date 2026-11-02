/**
 * A fake world for `capy deploy dokploy --discover` tests (CAP-703): a Dokploy
 * instance, the Capy repo links and secret NAME index, and GitHub. Everything
 * is an in-memory fake; nothing touches the network, `gh` or a real service.
 *
 * Two SENTINEL VALUES are planted: one in every Dokploy service env, one in
 * every Capy index row (as the value hash). The command must never print,
 * write or send either.
 *
 * No mutation: the fakes are static data plus `mock()` functions, whose
 * recorded calls the tests read.
 */
import { createHash } from 'node:crypto';
import { mock } from 'bun:test';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import type { ApiResult, GithubApi, RepoRef } from '../../src/deploy/githubApi';
import type { DiscoveryDokployClient } from '../../src/commands/connectors/dokployDiscovery';
import type { DeployDiscoverIo } from '../../src/commands/deployDiscover/command';

export const SENTINEL_DOKPLOY = 'SENTINEL-DOKPLOY-VALUE-7f3a9c41';
export const SENTINEL_CAPY = 'SENTINEL-CAPY-VALUE-b21e44d0';
export const TOKEN = 'dokploy-token-for-this-test-only';
export const BASE_URL = 'https://dokploy.example.com';

// ── Dokploy ──────────────────────────────────────────────────────────────────

export interface FakeService {
  readonly id: string;
  readonly kind: 'compose' | 'application';
  readonly name: string;
  readonly environment: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly sourceType?: string;
  readonly branch?: string;
  readonly composePath?: string;
  readonly buildPath?: string;
  /** Env variable NAMES; each gets the Dokploy sentinel as its value. */
  readonly envNames: readonly string[];
}

export const envTextOf = (names: readonly string[]): string => names.map((n) => `${n}=${SENTINEL_DOKPLOY}`).join('\n');

export function dokployFake(services: readonly FakeService[]) {
  const environments = [...new Set(services.map((s) => s.environment))];
  const projects = [
    {
      projectId: 'dp_1',
      name: 'Dokploy Project',
      environments: environments.map((env) => ({
        environmentId: `env_${env}`,
        name: env,
        applications: services.filter((s) => s.environment === env && s.kind === 'application').map((s) => ({ id: s.id, kind: 'application' as const, name: s.name })),
        composes: services.filter((s) => s.environment === env && s.kind === 'compose').map((s) => ({ id: s.id, kind: 'compose' as const, name: s.name })),
      })),
    },
  ];
  const byId = new Map(services.map((s) => [s.id, s] as const));
  const listProjects = mock(async () => projects);
  const getApplication = mock(async (id: string) => {
    const s = byId.get(id) as FakeService;
    return {
      applicationId: id,
      name: s.name,
      env: envTextOf(s.envNames),
      buildArgs: null,
      buildSecrets: null,
      createEnvFile: true,
      owner: s.owner,
      repository: s.repository,
      sourceType: s.sourceType,
      branch: s.branch,
      buildPath: s.buildPath,
    };
  });
  const getCompose = mock(async (id: string) => {
    const s = byId.get(id) as FakeService;
    return {
      composeId: id,
      name: s.name,
      env: envTextOf(s.envNames),
      createEnvFile: true,
      owner: s.owner,
      repository: s.repository,
      sourceType: s.sourceType,
      branch: s.branch,
      composePath: s.composePath,
    };
  });
  const client: DiscoveryDokployClient = { listProjects, getApplication, getCompose } as unknown as DiscoveryDokployClient;
  return { client, listProjects, getApplication, getCompose };
}

// ── Capy ─────────────────────────────────────────────────────────────────────

export interface FakeProject {
  readonly id: string;
  readonly name: string;
  /** Repo links (`path` is `.` for the repo root). Empty: the project has no repo link. */
  readonly repos: ReadonlyArray<{ readonly owner: string; readonly name: string; readonly path: string }>;
  /** Variable NAMES per Capy branch. */
  readonly branches: Readonly<Record<string, readonly string[]>>;
}

export function capyFake(projects: readonly FakeProject[]) {
  const links: OrgRepoLink[] = projects.flatMap((p) =>
    p.repos.map((r) => ({
      project_id: p.id,
      project_name: p.name,
      host: 'github.com',
      owner: r.owner,
      name: r.name,
      path: r.path,
      github_repo_id: 1,
      last_seen_at: '2026-10-01T00:00:00Z',
    })),
  );
  const names = [...new Set(projects.flatMap((p) => Object.values(p.branches).flat()))];
  const rows: SecretIndexRow[] = names.flatMap((name) =>
    projects.map((p) => ({
      name,
      value_hash: `${SENTINEL_CAPY}-${name}-${p.id}`,
      locations: Object.entries(p.branches)
        .filter(([, vars]) => vars.includes(name))
        .map(([branch]) => ({ project_id: p.id, project_name: p.name, branch, protected: false, service: null })),
      users: [{ user_id: 'user_1', email: 'someone@example.com' }],
    })),
  ).filter((row) => row.locations.length > 0);
  const getOrgRepos = mock(async (_orgId: string) => ({ org_id: 'org_1', repos: links }));
  const getSecretIndex = mock(async (_orgId: string) => ({ org_id: 'org_1', rows, skipped: [] }));
  return { client: { getOrgRepos, getSecretIndex }, getOrgRepos, getSecretIndex };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface FakeRepo {
  readonly defaultBranch: string;
  readonly branches: readonly string[];
  /** Files on the default branch, by repo-relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Methods that fail for this repo. */
  readonly failing?: readonly (keyof GithubApi)[];
}

const keyOf = (r: RepoRef): string => `${r.owner}/${r.name}`.toLowerCase();
const okResult = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failure = (): ApiResult<never> => ({ ok: false, kind: 'REQUEST_FAILED' });

export function githubFake(repos: Readonly<Record<string, FakeRepo>>) {
  const spec = (r: RepoRef): FakeRepo | undefined => repos[keyOf(r)];
  const fails = (r: RepoRef, method: keyof GithubApi): boolean => spec(r)?.failing?.includes(method) === true;
  const getRepo = mock(async (r: RepoRef) => (spec(r) ? okResult({ defaultBranch: (spec(r) as FakeRepo).defaultBranch }) : ({ ok: false, kind: 'NOT_FOUND' } as const)));
  const getDefaultBranches = mock(async (rs: readonly RepoRef[]) => okResult(rs.map((r) => spec(r)?.defaultBranch ?? null)));
  const listBranches = mock(async (r: RepoRef) => (fails(r, 'listBranches') || !spec(r) ? failure() : okResult([...(spec(r) as FakeRepo).branches])));
  const getBranchHead = mock(async (r: RepoRef, _b: string) =>
    fails(r, 'getBranchHead') ? failure() : okResult({ commitSha: `head-${keyOf(r)}`, treeSha: `tree-${keyOf(r)}` }),
  );
  const getFile = mock(async (r: RepoRef, path: string, _ref: string) =>
    fails(r, 'getFile') ? failure() : okResult((spec(r)?.files?.[path] ?? null) as string | null),
  );
  const createBlob = mock(async (r: RepoRef, content: string) =>
    fails(r, 'createBlob') ? failure() : okResult({ sha: `blob-${createHash('sha1').update(content).digest('hex')}` }),
  );
  const createTree = mock(async (r: RepoRef, _params: unknown) => (fails(r, 'createTree') ? failure() : okResult({ sha: `newtree-${keyOf(r)}` })));
  const createCommit = mock(async (r: RepoRef, _params: unknown) => (fails(r, 'createCommit') ? failure() : okResult({ sha: `newcommit-${keyOf(r)}` })));
  const createRef = mock(async (r: RepoRef, branch: string, _sha: string) => (fails(r, 'createRef') ? failure() : okResult({ ref: `refs/heads/${branch}` })));
  const createPull = mock(async (r: RepoRef, _params: unknown) =>
    fails(r, 'createPull') ? failure() : okResult({ url: `https://github.com/${r.owner}/${r.name}/pull/1` }),
  );
  const api = { getRepo, getDefaultBranches, listBranches, getBranchHead, getFile, createBlob, createTree, createCommit, createRef, createPull } as unknown as GithubApi;
  return { api, getRepo, getDefaultBranches, listBranches, getBranchHead, getFile, createBlob, createTree, createCommit, createRef, createPull };
}

export type GithubMocks = ReturnType<typeof githubFake>;

/** What a fake GitHub was asked to write: per repo, the PR's commit (paths + parsed contents), its title and body. */
export function writtenBy(gh: GithubMocks) {
  const contentBySha = new Map(gh.createBlob.mock.calls.map(([, content]) => [`blob-${createHash('sha1').update(content as string).digest('hex')}`, content as string] as const));
  const treeCalls = gh.createTree.mock.calls.map(([repo, params]) => {
    const p = params as { entries?: ReadonlyArray<{ path: string; blobSha: string }>; path?: string; blobSha?: string };
    const entries = p.entries ?? [{ path: p.path as string, blobSha: p.blobSha as string }];
    return { repo: keyOf(repo as RepoRef), files: Object.fromEntries(entries.map((e) => [e.path, contentBySha.get(e.blobSha) as string])) as Record<string, string> };
  });
  return {
    commits: treeCalls,
    pulls: gh.createPull.mock.calls.map(([repo, params]) => ({ repo: keyOf(repo as RepoRef), ...(params as { title: string; body: string; head: string; base: string }) })),
    commitMessages: gh.createCommit.mock.calls.map(([, params]) => (params as { message: string }).message),
  };
}

// ── The shared fixture ───────────────────────────────────────────────────────

export const P_SOLO = 'proj_solo';
export const P_API = 'proj_api';
export const P_WEB = 'proj_web';
export const P_TWIN1 = 'proj_twin1';
export const P_TWIN2 = 'proj_twin2';
export const P_NOBR = 'proj_nobr';
export const P_WEAK = 'proj_weak';
export const P_CONF = 'proj_conf';
export const P_NOLINK = 'proj_nolink';

export const PROJECTS: readonly FakeProject[] = [
  { id: P_SOLO, name: 'solo-app', repos: [{ owner: 'acme', name: 'solo', path: '.' }], branches: { production: ['A', 'B', 'C', 'D'] } },
  {
    id: P_API,
    name: 'backend-api',
    repos: [{ owner: 'acme', name: 'backend', path: 'api' }],
    branches: { production: ['DATABASE_URL', 'REDIS_URL', 'API_KEY', 'JWT_SECRET'], staging: ['DATABASE_URL', 'REDIS_URL', 'API_KEY'] },
  },
  {
    id: P_WEB,
    name: 'backend-web',
    repos: [{ owner: 'acme', name: 'backend', path: 'web' }],
    branches: { production: ['DATABASE_URL', 'SESSION_SECRET', 'NEXT_PUBLIC_URL'] },
  },
  { id: P_TWIN1, name: 'twin-one', repos: [{ owner: 'acme', name: 'twin', path: '.' }], branches: { production: ['T1', 'T2'] } },
  { id: P_TWIN2, name: 'twin-two', repos: [{ owner: 'acme', name: 'twin', path: '.' }], branches: { production: ['T1', 'T2'] } },
  { id: P_NOBR, name: 'no-branch', repos: [{ owner: 'acme', name: 'nobr', path: '.' }], branches: { production: ['N1'] } },
  {
    id: P_WEAK,
    name: 'weak-overlap',
    repos: [{ owner: 'acme', name: 'weak', path: '.' }],
    branches: { production: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9', 'X10'] },
  },
  { id: P_CONF, name: 'configured', repos: [{ owner: 'acme', name: 'conf', path: '.' }], branches: { production: ['C1', 'C2'] } },
  { id: P_NOLINK, name: 'no-link-project', repos: [], branches: { production: ['Z1'] } },
];

export const SERVICES: readonly FakeService[] = [
  { id: 'cmp_solo', kind: 'compose', name: 'solo', environment: 'production', owner: 'acme', repository: 'solo', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['A', 'B', 'C', 'D'] },
  {
    id: 'cmp_api',
    kind: 'compose',
    name: 'api',
    environment: 'production',
    owner: 'acme',
    repository: 'backend',
    sourceType: 'github',
    branch: 'main',
    composePath: 'api/docker-compose.yml',
    envNames: ['DATABASE_URL', 'REDIS_URL', 'API_KEY', 'JWT_SECRET', 'ONLY_IN_SERVICE'],
  },
  {
    id: 'app_api_stg',
    kind: 'application',
    name: 'api-staging',
    environment: 'staging',
    owner: 'acme',
    repository: 'backend',
    sourceType: 'github',
    branch: 'staging',
    buildPath: '/api',
    envNames: ['DATABASE_URL', 'REDIS_URL', 'API_KEY'],
  },
  {
    id: 'cmp_web',
    kind: 'compose',
    name: 'web',
    environment: 'production',
    owner: 'acme',
    repository: 'backend',
    sourceType: 'github',
    branch: 'main',
    composePath: 'web/docker-compose.yml',
    envNames: ['DATABASE_URL', 'SESSION_SECRET', 'NEXT_PUBLIC_URL'],
  },
  { id: 'cmp_raw', kind: 'compose', name: 'raw-image', environment: 'production', sourceType: 'raw', envNames: ['R1'] },
  { id: 'cmp_nolink', kind: 'compose', name: 'unlinked', environment: 'production', owner: 'acme', repository: 'unlinked', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['U1'] },
  { id: 'cmp_twin', kind: 'compose', name: 'twin', environment: 'production', owner: 'acme', repository: 'twin', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['T1', 'T2'] },
  { id: 'cmp_nomatch', kind: 'compose', name: 'other-folder', environment: 'production', owner: 'acme', repository: 'backend', sourceType: 'github', branch: 'main', composePath: 'other/docker-compose.yml', envNames: ['O1'] },
  { id: 'cmp_feature', kind: 'compose', name: 'feature', environment: 'preview', owner: 'acme', repository: 'nobr', sourceType: 'github', branch: 'feature-x', composePath: 'docker-compose.yml', envNames: ['N1'] },
  { id: 'cmp_weak', kind: 'compose', name: 'weak', environment: 'production', owner: 'acme', repository: 'weak', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['X1', 'Y1', 'Y2', 'Y3'] },
  { id: 'cmp_conf', kind: 'compose', name: 'conf', environment: 'production', owner: 'acme', repository: 'conf', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['C1', 'C2'] },
  { id: 'cmp_conf_other', kind: 'compose', name: 'conf-other', environment: 'production', owner: 'acme', repository: 'conf', sourceType: 'github', branch: 'main', composePath: 'docker-compose.yml', envNames: ['C1'] },
];

const target = (name: string, kind: string, branch: string, options: Record<string, unknown>) => ({
  name,
  kind,
  branch,
  vars: ['X'],
  options,
  mode: 'ci',
  gitBaseBranch: 'main',
});

/** A deploy.json that already holds a non-Dokploy target (the merge must leave it exactly as it is). */
export const EXISTING_API_DEPLOY = JSON.stringify({ version: '1', targets: { 'ssm-prod': target('ssm-prod', 'aws-ssm', 'production', { prefix: '/app' }) } }, null, 2) + '\n';

/** A deploy.json that already holds the Dokploy target for `cmp_conf` on `production`. */
export const EXISTING_CONF_DEPLOY =
  JSON.stringify({ version: '1', targets: { 'dokploy-production': target('dokploy-production', 'dokploy', 'production', { baseUrl: BASE_URL, composeId: 'cmp_conf' }) } }, null, 2) + '\n';

export const GITHUB_REPOS: Readonly<Record<string, FakeRepo>> = {
  'acme/solo': { defaultBranch: 'main', branches: ['main', 'develop'] },
  'acme/backend': { defaultBranch: 'main', branches: ['main', 'staging', 'develop'], files: { 'api/.capy/deploy.json': EXISTING_API_DEPLOY } },
  'acme/twin': { defaultBranch: 'main', branches: ['main'] },
  'acme/nobr': { defaultBranch: 'main', branches: ['main', 'feature-x'] },
  'acme/weak': { defaultBranch: 'main', branches: ['main'] },
  'acme/conf': { defaultBranch: 'main', branches: ['main'], files: { '.capy/deploy.json': EXISTING_CONF_DEPLOY } },
};

// ── The io ───────────────────────────────────────────────────────────────────

export interface WorldOptions {
  readonly services?: readonly FakeService[];
  readonly projects?: readonly FakeProject[];
  readonly repos?: Readonly<Record<string, FakeRepo>>;
  /** Plan files by path. */
  readonly files?: Readonly<Record<string, string>>;
  readonly io?: Partial<DeployDiscoverIo>;
}

export function makeWorld(options: WorldOptions = {}) {
  const dokploy = dokployFake(options.services ?? SERVICES);
  const capy = capyFake(options.projects ?? PROJECTS);
  const github = githubFake(options.repos ?? GITHUB_REPOS);
  const progress = mock((_line: string) => undefined);
  const getConnectorSecret = mock(async (_name: string, _opts: unknown) => TOKEN as string | null);
  const files = options.files ?? {};
  const io: DeployDiscoverIo = {
    devMode: false,
    env: {},
    savedBaseUrl: () => undefined,
    readFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error('no such file');
      return text;
    },
    context: async () => ({ ok: true, orgId: 'org_1', client: capy.client as never }),
    getConnectorSecret: getConnectorSecret as never,
    dokploy: () => dokploy.client,
    github: () => github.api,
    branchName: () => 'capy/dokploy-targets-test-0000',
    progress,
    ...options.io,
  };
  return { io, dokploy, capy, github, progress, getConnectorSecret };
}

export const planFile = (entries: readonly unknown[]): string => JSON.stringify({ version: 1, entries });

export const ENTRY_SOLO = { project_id: P_SOLO, branch: 'production', service_id: 'cmp_solo', git_branch: 'main', vars: ['D', 'A', 'B', 'C'] };
export const ENTRY_API = { project_id: P_API, branch: 'production', service_id: 'cmp_api', git_branch: 'main', vars: ['DATABASE_URL', 'REDIS_URL', 'API_KEY', 'JWT_SECRET'] };
export const ENTRY_API_STG = { project_id: P_API, branch: 'staging', service_id: 'app_api_stg', git_branch: 'staging', vars: ['DATABASE_URL', 'API_KEY'] };
export const ENTRY_WEB = { project_id: P_WEB, branch: 'production', service_id: 'cmp_web', git_branch: 'main', vars: ['SESSION_SECRET', 'DATABASE_URL', 'NEXT_PUBLIC_URL'] };
