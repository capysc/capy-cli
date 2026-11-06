/**
 * A fake world for `capy deploy vercel --discover` tests (CAP-696): a Vercel
 * account (teams, projects, environments), the Capy repo links and secret NAME
 * index, and GitHub. Everything is an in-memory fake; nothing touches the
 * network, `gh` or a real service. The Capy and GitHub fakes are
 * `tests/helpers/deployDiscoverWorld.ts`'s own.
 *
 * SENTINEL VALUES are planted in every Vercel env record (as the list's
 * `value` and as the per-id decrypted value) and in every Capy index row. The
 * command must never print, write or send any of them, and must never call the
 * per-id value route or ask for `decrypt`.
 */
import { mock } from 'bun:test';
import { createVercelClient } from '../../src/deploy/vercelApi';
import type { DeployVercelDiscoverIo } from '../../src/commands/deployDiscover/vercel';
import { FakeProject, FakeRepo, capyFake, githubFake } from './deployDiscoverWorld';
import { FakeVercelData, RawEnv, callsOf, fakeVercelFetch, project } from './fakeVercel';

export const SENTINEL_VERCEL = 'SENTINEL-VERCEL-VALUE-5d0c8e17';
export const VERCEL_TOKEN = 'vercel-token-for-this-test-only';

const rawEnv = (id: string, key: string, over: Partial<RawEnv> = {}): RawEnv => ({
  id,
  key,
  type: 'plain',
  target: ['production'],
  listValue: SENTINEL_VERCEL,
  ...over,
});

// ── Capy ─────────────────────────────────────────────────────────────────────

export const P_SHOP = 'proj_shop';
export const P_MWEB = 'proj_mweb';
export const P_MADMIN = 'proj_madmin';
export const P_DUO = 'proj_duo';
export const P_CONF = 'proj_conf';
export const P_PERSONAL = 'proj_personal';
export const P_DEVONLY = 'proj_devonly';

export const PROJECTS: readonly FakeProject[] = [
  {
    id: P_SHOP,
    name: 'shop',
    repos: [{ owner: 'acme', name: 'shop', path: '.' }],
    branches: {
      production: ['DB_URL', 'API_KEY', 'STRIPE_KEY'],
      preview: ['DB_URL', 'API_KEY'],
      staging: ['DB_URL'],
      'feature-x': ['DB_URL'],
    },
  },
  { id: P_MWEB, name: 'mono-web', repos: [{ owner: 'acme', name: 'mono', path: 'apps/web' }], branches: { production: ['WEB_KEY', 'WEB_OTHER'] } },
  { id: P_MADMIN, name: 'mono-admin', repos: [{ owner: 'acme', name: 'mono', path: 'apps/admin' }], branches: { production: ['ADM_KEY'] } },
  { id: P_DUO, name: 'duo', repos: [{ owner: 'acme', name: 'duo', path: '.' }], branches: { production: ['DUO_KEY'] } },
  { id: P_CONF, name: 'configured', repos: [{ owner: 'acme', name: 'conf', path: '.' }], branches: { production: ['C1'] } },
  { id: P_PERSONAL, name: 'personal', repos: [{ owner: 'acme', name: 'personal', path: '.' }], branches: { production: ['PKEY'] } },
  { id: P_DEVONLY, name: 'devonly', repos: [{ owner: 'acme', name: 'devonly', path: '.' }], branches: { development: ['DEV_KEY'] } },
];

// ── Vercel ───────────────────────────────────────────────────────────────────

export const TEAM = { id: 'team_1', slug: 'acme-team', name: 'Acme' };

const link = (repo: string, productionBranch: string | undefined = 'main') => ({ type: 'github', org: 'acme', repo, ...(productionBranch ? { productionBranch } : {}) });

export const VERCEL_DATA: FakeVercelData = {
  teams: [TEAM],
  pageSize: 3,
  projects: {
    team_1: [
      project('prj_shop', 'shop-web', { link: link('shop') }),
      project('prj_mweb', 'mono-web', { rootDirectory: 'apps/web', link: link('mono') }),
      project('prj_madm', 'mono-admin', { rootDirectory: 'apps/admin', link: link('mono') }),
      project('prj_a', 'duo-a', { rootDirectory: 'apps/a', link: link('duo') }),
      project('prj_b', 'duo-b', { rootDirectory: 'apps/b', link: link('duo') }),
      project('prj_nolink', 'nolink', { link: null }),
      project('prj_dev', 'dev-only', { link: link('devonly') }),
      project('prj_cfg', 'configured', { link: link('conf') }),
    ],
    personal: [project('prj_personal', 'personal-site', { link: link('personal', 'trunk') })],
  },
  custom: { prj_shop: [{ id: 'env_stg', slug: 'staging' }] },
  envs: {
    prj_shop: [
      rawEnv('e1', 'DB_URL', { target: ['production', 'preview', 'development'] }),
      rawEnv('e2', 'API_KEY', { type: 'encrypted', target: ['production', 'preview'] }),
      rawEnv('e3', 'STRIPE_KEY', { type: 'sensitive', target: ['production'], listValue: undefined }),
      rawEnv('e4', 'VERCEL_URL', { type: 'system', target: ['production', 'preview'] }),
      rawEnv('e5', 'DB_URL', { target: ['preview'], gitBranch: 'feature-x' }),
      rawEnv('e6', 'DB_URL', { target: [], customEnvironmentIds: ['env_stg'] }),
    ],
    prj_mweb: [rawEnv('m1', 'WEB_KEY'), rawEnv('m2', 'WEB_OTHER')],
    prj_madm: [rawEnv('m3', 'ADM_KEY')],
    prj_a: [rawEnv('d1', 'DUO_KEY')],
    prj_b: [rawEnv('d2', 'DUO_KEY')],
    prj_nolink: [rawEnv('n1', 'N1')],
    prj_dev: [rawEnv('v1', 'DEV_KEY', { target: ['development'] })],
    prj_cfg: [rawEnv('c1', 'C1')],
    prj_personal: [rawEnv('p1', 'PKEY')],
  },
  values: Object.fromEntries(
    ['e1', 'e2', 'e3', 'e5', 'e6', 'm1', 'm2', 'm3', 'd1', 'd2', 'n1', 'v1', 'c1', 'p1'].map((id) => [id, SENTINEL_VERCEL]),
  ),
};

/** The ids a service gets: `<project id>:<environment>`. */
export const SVC = {
  shopProd: 'prj_shop:production',
  shopPreview: 'prj_shop:preview',
  shopPreviewFeature: 'prj_shop:preview@feature-x',
  shopStaging: 'prj_shop:custom:staging',
  mwebProd: 'prj_mweb:production',
  madmProd: 'prj_madm:production',
  aProd: 'prj_a:production',
  bProd: 'prj_b:production',
  devOnly: 'prj_dev:development',
  cfgProd: 'prj_cfg:production',
  personalProd: 'prj_personal:production',
} as const;

// ── GitHub ───────────────────────────────────────────────────────────────────

const target = (name: string, kind: string, branch: string, options: Record<string, unknown>) => ({
  name,
  kind,
  branch,
  vars: ['X'],
  options,
  mode: 'ci',
  gitBaseBranch: 'main',
});

/** A deploy.json that already holds a non-Vercel target (the merge must leave it exactly as it is). */
export const EXISTING_MONO_DEPLOY =
  JSON.stringify({ version: '1', targets: { 'ssm-prod': target('ssm-prod', 'aws-ssm', 'production', { prefix: '/app' }) } }, null, 2) + '\n';

/** A deploy.json that already holds the Vercel target for `prj_cfg` on production. */
export const EXISTING_CONF_DEPLOY =
  JSON.stringify(
    { version: '1', targets: { 'vercel-production': target('vercel-production', 'vercel', 'production', { projectDir: '.', vercelEnv: 'production', projectId: 'prj_cfg', teamId: 'team_1' }) } },
    null,
    2,
  ) + '\n';

export const GITHUB_REPOS: Readonly<Record<string, FakeRepo>> = {
  'acme/shop': { defaultBranch: 'main', branches: ['main', 'develop', 'feature-x'] },
  'acme/mono': { defaultBranch: 'main', branches: ['main'], files: { 'apps/web/.capy/deploy.json': EXISTING_MONO_DEPLOY } },
  'acme/duo': { defaultBranch: 'main', branches: ['main'] },
  'acme/conf': { defaultBranch: 'main', branches: ['main'], files: { '.capy/deploy.json': EXISTING_CONF_DEPLOY } },
  'acme/personal': { defaultBranch: 'trunk', branches: ['trunk'] },
  'acme/devonly': { defaultBranch: 'main', branches: ['main'] },
};

// ── The io ───────────────────────────────────────────────────────────────────

export interface VercelWorldOptions {
  readonly data?: FakeVercelData;
  readonly projects?: readonly FakeProject[];
  readonly repos?: Readonly<Record<string, FakeRepo>>;
  /** Plan files by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** What the system store answers for the token (`null`: none). */
  readonly token?: string | null;
  /** The token the fake Vercel accepts; anything else is a 401. */
  readonly acceptedToken?: string;
  readonly io?: Partial<DeployVercelDiscoverIo>;
}

const json = (body: unknown, status: number) => ({ status, ok: false, headers: { get: () => null }, text: async () => JSON.stringify(body) });

export function makeVercelWorld(options: VercelWorldOptions = {}) {
  const capy = capyFake(options.projects ?? PROJECTS);
  const github = githubFake(options.repos ?? GITHUB_REPOS);
  const progress = mock((_line: string) => undefined);
  const getSecret = mock(async (_name: string, _opts: unknown) => (options.token === undefined ? VERCEL_TOKEN : options.token) as string | null);
  const accepted = options.acceptedToken ?? VERCEL_TOKEN;
  const inner = fakeVercelFetch(options.data ?? VERCEL_DATA);
  const fetchMock = mock(async (url: string, init: { method: 'GET'; headers: Record<string, string> }) =>
    init.headers.Authorization === `Bearer ${accepted}` ? inner(url, init as never) : json({ error: { code: 'forbidden', message: 'no' } }, 401),
  );
  const files = options.files ?? {};
  const io: DeployVercelDiscoverIo = {
    devMode: false,
    env: {},
    readFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error('no such file');
      return text;
    },
    context: async () => ({ ok: true, orgId: 'org_1', client: capy.client as never }),
    getSecret: getSecret as never,
    vercel: (token) => createVercelClient(token, { fetch: fetchMock as never, sleep: async () => {}, dropValues: true }),
    github: () => github.api,
    branchName: () => 'capy/vercel-targets-test-0000',
    progress,
    ...options.io,
  };
  return { io, capy, github, progress, getSecret, fetchMock, vercelCalls: () => callsOf(fetchMock) };
}

export type VercelWorld = ReturnType<typeof makeVercelWorld>;

export const planFile = (entries: readonly unknown[]): string => JSON.stringify({ version: 1, entries });

export const ENTRY_SHOP = { project_id: P_SHOP, branch: 'production', service_id: SVC.shopProd, git_branch: 'main', vars: ['STRIPE_KEY', 'DB_URL', 'API_KEY'] };
export const ENTRY_SHOP_PREVIEW = { project_id: P_SHOP, branch: 'preview', service_id: SVC.shopPreview, git_branch: 'main', vars: ['DB_URL', 'API_KEY'] };
export const ENTRY_SHOP_FEATURE = { project_id: P_SHOP, branch: 'feature-x', service_id: SVC.shopPreviewFeature, git_branch: 'main', vars: ['DB_URL'] };
export const ENTRY_SHOP_STAGING = { project_id: P_SHOP, branch: 'staging', service_id: SVC.shopStaging, git_branch: 'main', vars: ['DB_URL'] };
export const ENTRY_MWEB = { project_id: P_MWEB, branch: 'production', service_id: SVC.mwebProd, git_branch: 'main', vars: ['WEB_KEY'] };
export const ENTRY_MADMIN = { project_id: P_MADMIN, branch: 'production', service_id: SVC.madmProd, git_branch: 'main', vars: ['ADM_KEY'] };
export const ENTRY_DUO_A = { project_id: P_DUO, branch: 'production', service_id: SVC.aProd, git_branch: 'main', vars: ['DUO_KEY'] };
export const ENTRY_DUO_B = { project_id: P_DUO, branch: 'production', service_id: SVC.bProd, git_branch: 'main', vars: ['DUO_KEY'] };
export const ENTRY_PERSONAL = { project_id: P_PERSONAL, branch: 'production', service_id: SVC.personalProd, git_branch: 'trunk', vars: ['PKEY'] };
export const ENTRY_CFG = { project_id: P_CONF, branch: 'production', service_id: SVC.cfgProd, git_branch: 'main', vars: ['C1'] };
