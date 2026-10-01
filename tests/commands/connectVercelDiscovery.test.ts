/**
 * `capy connect vercel --discover` (CAP-696).
 *
 * Covers: matching each Vercel project to a local repo by git `origin` and to
 * a folder by `rootDirectory` (null/''/'./x/'/'/x' all normalized), every
 * unmatched reason, collisions handled like Dokploy's, the `--environment`
 * filter, a plan that holds no value, the dry-run JSON (pure, names only, no
 * value anywhere), the coded refusals, and — through the REAL sequencer, a
 * REAL `FileManager` and real git repos — that a real run pushes each branch
 * exactly Vercel's set for that environment and ends in the local discovery
 * commit (never pushed).
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { buildVercelDiscoveryPlan, matchVercelProject } from '../../src/commands/connectors/vercelDiscovery';
import { findCandidateReposResult, type DiscoveryContext } from '../../src/commands/connectors/dokployDiscovery';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { FileManager } from '../../src/files/fileManager';
import { resolveProjectKey, wrapAndSaveMasterKey } from '../../src/crypto/keyResolver';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { ConnectOpts, ConnectorModule } from '../../src/commands/connectors/registry';
import { createVercelClient, type VercelFetchLike, type VercelProject } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, git, initRepo, withExitCodeRestored, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const SECRET = {
  aProd: 'a-prod-SENT-11aa',
  sharedProd: 'shared-prod-SENT-22bb',
  bStage: 'b-stage-SENT-33cc',
  sharedStage: 'shared-stage-SENT-44dd',
  hidden: 'hidden-SENT-55ee',
} as const;
const ALL_SECRETS = Object.values(SECRET);

const e = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

const WEB_ENVS: ReadonlyArray<RawEnv> = [
  e({ id: 'w1', key: 'A', type: 'plain', listValue: SECRET.aProd }),
  e({ id: 'w2', key: 'SHARED', type: 'encrypted', listValue: 'opaque' }),
  e({ id: 'w3', key: 'B', type: 'encrypted', target: [], customEnvironmentIds: ['c_stage'], listValue: 'opaque' }),
  e({ id: 'w4', key: 'SHARED', type: 'encrypted', target: [], customEnvironmentIds: ['c_stage'], listValue: 'opaque' }),
  e({ id: 'w5', key: 'HIDDEN', type: 'sensitive' }),
  e({ id: 'w6', key: 'BRANCHY', type: 'encrypted', target: ['preview'], gitBranch: 'dev', listValue: 'opaque' }),
  e({ id: 'w7', key: 'P', type: 'plain', target: ['preview'], listValue: 'preview-plain-SENT-66ff' }),
];
const WEB_VALUES: Record<string, string> = { w2: SECRET.sharedProd, w3: SECRET.bStage, w4: SECRET.sharedStage, w5: SECRET.hidden };

const gh = (org: string, repo: string) => ({ type: 'github', org, repo, productionBranch: 'main' });

// ── matchVercelProject ──────────────────────────────────────────────────────

describe('matchVercelProject — repo by origin, folder by rootDirectory, every unmatched reason', () => {
  const repos = [{ repoDir: '/r/widgets', remote: { host: 'github.com', owner: 'acme', repo: 'widgets' } }];
  const asProject = (raw: Record<string, unknown>): VercelProject => {
    const link = raw.link as Record<string, unknown> | undefined;
    return {
      id: raw.id as string,
      name: raw.name as string,
      rootDirectory: (raw.rootDirectory as string | null) ?? null,
      link: !link ? null : link.type === 'github' ? { kind: 'github', org: link.org as string, repo: link.repo as string, productionBranch: link.productionBranch as string } : { kind: 'unsupported', type: String(link.type) },
    };
  };
  const exists = (_r: string, folder: string) => folder === '' || folder === 'apps/web';

  test('root project: matched, folder is the repo root', () => {
    const r = matchVercelProject(asProject(project('p1', 'web')), repos, exists);
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') expect([r.value.repoDir, r.value.folder, r.value.productionBranch]).toEqual(['/r/widgets', '', 'main']);
  });

  test('rootDirectory is normalized: "apps/web", "./apps/web/", "/apps/web" are the same folder; "" and "." are the root', () => {
    const folders = ['apps/web', './apps/web/', '/apps/web', 'apps\\web'].map((rd) => {
      const r = matchVercelProject(asProject(project('p', 'x', { rootDirectory: rd })), repos, exists);
      return r.kind === 'matched' ? r.value.folder : `unmatched:${r.value.reason}`;
    });
    expect(folders).toEqual(['apps/web', 'apps/web', 'apps/web', 'apps/web']);
    const roots = ['', '.'].map((rd) => {
      const r = matchVercelProject(asProject(project('p', 'x', { rootDirectory: rd })), repos, exists);
      return r.kind === 'matched' ? r.value.folder : 'unmatched';
    });
    expect(roots).toEqual(['', '']);
  });

  test('origin match is case-insensitive', () => {
    const r = matchVercelProject(asProject(project('p', 'x', { link: gh('ACME', 'Widgets') })), repos, exists);
    expect(r.kind).toBe('matched');
  });

  test.each([
    ['no link at all', { link: null }, 'no_git_link'],
    ['a gitlab link', { link: { type: 'gitlab', projectId: 5 } }, 'unsupported_git_provider'],
    ['a bitbucket link', { link: { type: 'bitbucket' } }, 'unsupported_git_provider'],
    ['a github repo that is not cloned here', { link: gh('acme', 'other') }, 'no_remote_match'],
    ['a rootDirectory that does not exist locally', { rootDirectory: 'apps/ghost' }, 'root_directory_missing'],
  ] as const)('%s → %s', (_label, over, reason) => {
    const r = matchVercelProject(asProject(project('p', 'x', over as never)), repos, exists);
    expect(r.kind).toBe('unmatched');
    if (r.kind === 'unmatched') expect(r.value.reason).toBe(reason);
  });
});

// ── buildVercelDiscoveryPlan against real repos ─────────────────────────────

const noPeek = { peekLocalKeep: () => null, listServerBranches: async () => [] as ReadonlyArray<{ name: string }> };

const planData = (over: Partial<FakeVercelData> = {}): FakeVercelData => ({
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: {
    team_acme: [
      project('prj_web', 'web'),
      project('prj_app', 'app', { rootDirectory: 'apps/web' }),
      project('prj_ghost', 'ghost', { rootDirectory: 'apps/ghost' }),
      project('prj_nolink', 'nolink', { link: null }),
      project('prj_lab', 'lab', { link: { type: 'gitlab', projectId: 1 } }),
      project('prj_other', 'other', { link: gh('someone', 'else') }),
      project('prj_empty', 'empty', { rootDirectory: 'apps/empty' }),
    ],
  },
  envs: {
    prj_web: WEB_ENVS,
    prj_app: [e({ id: 'a1', key: 'APP_ONLY', type: 'plain', listValue: 'app-plain-SENT-77aa' })],
    prj_ghost: [e({ id: 'g1', key: 'G', type: 'plain', listValue: 'x' })],
    prj_empty: [],
  },
  custom: { prj_web: [{ id: 'c_stage', slug: 'staging' }] },
  values: WEB_VALUES,
  ...over,
});

async function inRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withTempDir('capy-vercel-discover', async (root) => {
    initRepo(root, 'git@github.com:acme/widgets.git');
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    mkdirSync(join(root, 'apps/empty'), { recursive: true });
    return fn(root);
  });
}

describe('buildVercelDiscoveryPlan', () => {
  test('folders, environments, counts, and every unmatched reason', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(planData()) });
      const scan = findCandidateReposResult(root);
      const plan = await buildVercelDiscoveryPlan(client, 'team_acme', scan.repos, noPeek);

      expect(plan.folders.map((f) => [f.folder || '.', f.projectName])).toEqual([['.', 'web'], ['apps/web', 'app']]);
      const web = plan.folders[0];
      // production, preview, then the custom one — keyed by name; `staging` is a custom environment slug
      expect(Object.fromEntries(web.environments.map((env) => [env.environmentName, [env.variableCount, env.skippedCount]]))).toEqual({
        production: [2, 1], // A, SHARED; HIDDEN skipped
        preview: [1, 1], //   P; BRANCHY skipped
        staging: [2, 0], //   B, SHARED
      });
      expect(web.environments.every((env) => env.serviceId === 'prj_web' && env.serviceKind === 'vercel')).toBe(true);
      expect(plan.unmatched.map((u) => [u.serviceId, u.reason]).toSorted()).toEqual(
        [
          ['prj_ghost', 'root_directory_missing'],
          ['prj_nolink', 'no_git_link'],
          ['prj_lab', 'unsupported_git_provider'],
          ['prj_other', 'no_remote_match'],
          ['prj_empty', 'no_variables'],
        ].toSorted(),
      );
      expect(plan.allEnvironmentNames).toEqual(['preview', 'production', 'staging']);
      expect(plan.collisions).toEqual([]);
    });
  });

  test('the plan lists skipped names with reasons (and the scoped branch) — and holds no value at all', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(planData()) });
      const plan = await buildVercelDiscoveryPlan(client, 'team_acme', findCandidateReposResult(root).repos, noPeek);
      const web = plan.folders[0];
      expect(web.environments.find((env) => env.environmentName === 'production')!.skipped).toEqual([{ name: 'HIDDEN', code: 'sensitive_unreadable' }]);
      expect(web.environments.find((env) => env.environmentName === 'preview')!.skipped).toEqual([{ name: 'BRANCHY', code: 'git_branch_scoped', gitBranch: 'dev' }]);
      const serialized = JSON.stringify(plan);
      [...ALL_SECRETS, 'preview-plain-SENT-66ff', 'app-plain-SENT-77aa'].forEach((v) => expect(serialized).not.toContain(v));
    });
  });

  test('the plan reads only env LISTS — no per-id value request is made while planning', async () => {
    await inRepo(async (root) => {
      const fetchMock = mock(fakeVercelFetch(planData()));
      await buildVercelDiscoveryPlan(createVercelClient('tok', { fetch: fetchMock }), 'team_acme', findCandidateReposResult(root).repos, noPeek);
      expect(callsOf(fetchMock).some((c) => /\/v1\/projects\/[^/]+\/env\//.test(c.url))).toBe(false);
      expect(callsOf(fetchMock).every((c) => c.method === 'GET')).toBe(true);
    });
  });

  test('--environment filters before collision detection, and a folder left with nothing drops out', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(planData()) });
      const plan = await buildVercelDiscoveryPlan(client, 'team_acme', findCandidateReposResult(root).repos, noPeek, ['staging']);
      expect(plan.folders.map((f) => f.projectName)).toEqual(['web']);
      expect(plan.folders[0].environments.map((env) => env.environmentName)).toEqual(['staging']);
      expect(plan.environmentFilter).toEqual(['staging']);
      expect(plan.allEnvironmentNames).toEqual(['preview', 'production', 'staging']);
    });
  });

  test('two projects on the same repo + folder + environment are a collision, naming both', async () => {
    await inRepo(async (root) => {
      const data = planData({
        projects: { team_acme: [project('prj_a', 'alpha'), project('prj_b', 'beta')] },
        envs: { prj_a: [e({ id: 'x1', key: 'K', type: 'plain', listValue: 'v' })], prj_b: [e({ id: 'y1', key: 'K', type: 'plain', listValue: 'v' })] },
        custom: {},
      });
      const plan = await buildVercelDiscoveryPlan(createVercelClient('tok', { fetch: fakeVercelFetch(data) }), 'team_acme', findCandidateReposResult(root).repos, noPeek);
      expect(plan.collisions.length).toBe(1);
      expect(plan.collisions[0]).toMatchObject({ folder: '', environmentName: 'production' });
      expect(plan.collisions[0].candidates.map((c) => c.serviceId).toSorted()).toEqual(['prj_a', 'prj_b']);
    });
  });

  test('an initialized folder previews checkout vs checkout -b from the server\'s branches; a new project previews no auto-overwrite on its first step', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(planData()) });
      const repos = findCandidateReposResult(root).repos;
      const fresh = await buildVercelDiscoveryPlan(client, 'team_acme', repos, noPeek);
      const freshWeb = fresh.folders[0];
      // order: staging, preview, production — staging is first in a brand-new project
      expect(freshWeb.initialized).toBe(false);
      expect(Object.fromEntries(freshWeb.environments.map((env) => [env.environmentName, env.willAutoOverwrite]))).toEqual({ staging: false, preview: true, production: true });

      const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'proj_x', project_name: 'widgets', variables: {} };
      const existing = await buildVercelDiscoveryPlan(client, 'team_acme', repos, { peekLocalKeep: () => keep, listServerBranches: async () => [{ name: 'production' }] });
      const web = existing.folders[0];
      expect(Object.fromEntries(web.environments.map((env) => [env.environmentName, env.branchExists]))).toEqual({ staging: false, preview: false, production: true });
    });
  });
});

// ── connector.discover / ConnectCommand.executeDiscovery ────────────────────

const fakeDiscoveryCtx = (over: Record<string, unknown> = {}): DiscoveryContext => ({
  orgId: 'org_v',
  userId: 'user_v',
  authService: {} as unknown as DiscoveryContext['authService'],
  serviceClient: {
    listBranches: async () => [],
    listProjects: async () => [],
    ...over,
  } as unknown as DiscoveryContext['serviceClient'],
});

const discoverOpts = (over: Partial<ConnectOpts> = {}): ConnectOpts => ({ nonTty: true, tokenEnv: 'T', ...over });

const connectorFor = (root: string, data: FakeVercelData, extra: Partial<Parameters<typeof createVercelConnector>[0]> = {}) => {
  const fetchMock = mock(fakeVercelFetch(data));
  const connector = createVercelConnector({ fetch: fetchMock as unknown as VercelFetchLike, env: { T: 'tok_fake' }, cwd: root, sleep: async () => {}, ...extra });
  return { connector, fetchMock };
};

describe('connector.discover --dry-run', () => {
  test('--json: ONE pure JSON object — folders with repo/folder/project name+id/environments/skipped-by-reason, plus unmatched, collisions, unreadableRepos; no value anywhere; nothing written', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const { connector, fetchMock } = connectorFor(root, planData());
        const command = new ConnectCommand(false);
        const run = await captureConsole(() => command['executeDiscovery'](connector, 'vercel', fakeDiscoveryCtx(), discoverOpts({ dryRun: true, json: true })));
        expect(run.stdout.length).toBe(1);
        const out = JSON.parse(run.stdout[0]);
        expect(out).toMatchObject({ ok: true, provider: 'vercel', dryRun: true, cancelled: false });
        expect(out.plan.team).toEqual({ id: 'team_acme', slug: 'acme' });

        const web = out.plan.folders.find((f: { vercelProjectId: string }) => f.vercelProjectId === 'prj_web');
        expect(web).toMatchObject({ repoDir: root, folder: '.', vercelProject: 'web', vercelProjectId: 'prj_web', initialized: false });
        const prod = web.environments.find((env: { branch: string }) => env.branch === 'production');
        expect(prod).toMatchObject({ variableCount: 2, skippedCount: 1, skipped: { sensitive_unreadable: [{ name: 'HIDDEN' }] } });
        const preview = web.environments.find((env: { branch: string }) => env.branch === 'preview');
        expect(preview.skipped).toEqual({ git_branch_scoped: [{ name: 'BRANCHY', gitBranch: 'dev' }] });

        expect(out.plan.unmatched.map((u: { vercelProjectId: string; reason: string }) => [u.vercelProjectId, u.reason]).toSorted()).toEqual(
          [['prj_ghost', 'root_directory_missing'], ['prj_nolink', 'no_git_link'], ['prj_lab', 'unsupported_git_provider'], ['prj_other', 'no_remote_match'], ['prj_empty', 'no_variables']].toSorted(),
        );
        expect(out.plan.collisions).toEqual([]);
        expect(out.plan.unreadableRepos).toEqual([]);
        // the local discovery commit is previewed, never made
        expect(out.commits[0]).toMatchObject({ ok: true, dryRun: true });
        expect(out.commits[0].branch).toMatch(/^capy\/vercel-import-\d{8}-\d{4}$/);

        // the property: not one value on any surface
        const everything = [...run.stdout, ...run.stderr].join('\n');
        [...ALL_SECRETS, 'preview-plain-SENT-66ff', 'app-plain-SENT-77aa', 'tok_fake'].forEach((v) => expect(everything).not.toContain(v));
        // read-only, no per-id value requests, nothing written to the repo
        expect(callsOf(fetchMock).every((c) => c.method === 'GET')).toBe(true);
        expect(callsOf(fetchMock).some((c) => /\/v1\/projects\/[^/]+\/env\//.test(c.url))).toBe(false);
        expect(git(root, ['status', '--porcelain']).trim()).toBe('');
        expect(existsSync(join(root, 'keep.lock'))).toBe(false);
      }),
    );
  });

  test('human output names Vercel projects and reasons, never a value', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const { connector } = connectorFor(root, planData());
        const run = await captureConsole(() => new ConnectCommand(false)['executeDiscovery'](connector, 'vercel', fakeDiscoveryCtx(), discoverOpts({ dryRun: true })));
        const text = run.stdout.join('\n');
        expect(text).toContain('Dry run');
        expect(text).toContain('web');
        expect(text).toContain('skipped sensitive_unreadable: HIDDEN');
        expect(text).toContain('skipped git_branch_scoped: BRANCHY (dev)');
        expect(text).toContain('root_directory_missing');
        expect(text).not.toContain('Dokploy');
        ALL_SECRETS.forEach((v) => expect(text).not.toContain(v));
      }),
    );
  });
});

describe('connector.discover — refusals carry codes', () => {
  test('no token: VERCEL_TOKEN_MISSING, zero requests', async () => {
    await inRepo(async (root) => {
      const { connector, fetchMock } = connectorFor(root, planData(), { env: {} });
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ dryRun: true }));
      expect(out.ok).toBe(false);
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_TOKEN_MISSING);
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });

  test('several teams, non-interactive: VERCEL_TEAM_REQUIRED; --team picks one', async () => {
    await inRepo(async (root) => {
      const data = planData({ teams: [{ id: 'team_acme', slug: 'acme' }, { id: 'team_beta', slug: 'beta' }] });
      const { connector } = connectorFor(root, data);
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ dryRun: true }));
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_TEAM_REQUIRED);
      const ok = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ dryRun: true, team: 'acme' }));
      expect(ok.ok).toBe(true);
    });
  });

  test('--environment naming nothing the plan has: VERCEL_ENVIRONMENT_NOT_FOUND, listing what exists', async () => {
    await inRepo(async (root) => {
      const { connector } = connectorFor(root, planData());
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ dryRun: true, environment: 'qa' }));
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND);
      expect((out as { message: string }).message).toContain('staging');
    });
  });

  test('a collision with no --project hint and no TTY: VERCEL_MAPPING_COLLISION, zero writes; with --project <name> the named one wins', async () => {
    await inRepo(async (root) => {
      const data = planData({
        projects: { team_acme: [project('prj_a', 'alpha'), project('prj_b', 'beta')] },
        envs: { prj_a: [e({ id: 'x1', key: 'K', type: 'plain', listValue: 'va' })], prj_b: [e({ id: 'y1', key: 'K', type: 'plain', listValue: 'vb' })] },
        custom: {},
      });
      const { connector } = connectorFor(root, data);
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ yes: true }));
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_MAPPING_COLLISION);
      expect(existsSync(join(root, 'keep.lock'))).toBe(false);
    });
  });

  test('with --project <name> the named project wins the collision and is the one imported', async () => {
    await withIsolatedGlobalDir(() =>
      inRepo(async (root) => {
        const orgId = 'org_v_hint';
        const userId = 'user_v_hint';
        const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
        await wrapAndSaveMasterKey(randomBytes(32), orgId, userId, keyOps);
        writeFileSync(join(root, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: orgId, project_id: 'proj_hint', project_name: 'widgets', variables: {} }));
        const data = planData({
          projects: { team_acme: [project('prj_a', 'alpha'), project('prj_b', 'beta')] },
          envs: { prj_a: [e({ id: 'x1', key: 'K', type: 'plain', listValue: 'va' })], prj_b: [e({ id: 'y1', key: 'K', type: 'plain', listValue: 'vb' })] },
          custom: {},
        });
        const ctx = {
          ...fakeDiscoveryCtx({
            coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
            wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
            createBranch: async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }),
            getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
          }),
          orgId,
          userId,
        } as DiscoveryContext;
        const { connector } = connectorFor(root, data);
        const out = await connector.discover!(ctx, discoverOpts({ yes: true, noPush: true, project: 'beta' }));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const applied = (out.applied ?? []).filter((f) => f.ok);
        expect(applied.map((f) => f.ok && f.environments.map((env) => env.outcome.imported.map((i) => i.value)))).toEqual([[['vb']]]);
      }),
    );
  });

  test('a real run non-interactively without --yes: VERCEL_CONFIRMATION_REQUIRED, zero writes', async () => {
    await inRepo(async (root) => {
      const { connector } = connectorFor(root, planData());
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts());
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_CONFIRMATION_REQUIRED);
      expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    });
  });
});

// ── a real run: sequencer + FileManager + real git ──────────────────────────

describe('connector.discover — a real run, end to end', () => {
  const E2E_ENVS: ReadonlyArray<RawEnv> = [
    e({ id: 'p1', key: 'A', type: 'plain', listValue: SECRET.aProd }),
    e({ id: 'p2', key: 'SHARED', type: 'encrypted', listValue: 'opaque' }),
    e({ id: 's1', key: 'B', type: 'encrypted', target: [], customEnvironmentIds: ['c_stage'], listValue: 'opaque' }),
    e({ id: 's2', key: 'SHARED', type: 'encrypted', target: [], customEnvironmentIds: ['c_stage'], listValue: 'opaque' }),
    e({ id: 'h1', key: 'HIDDEN', type: 'sensitive' }),
  ];
  const e2eData = (): FakeVercelData => ({
    teams: [{ id: 'team_acme', slug: 'acme' }],
    projects: { team_acme: [project('prj_web', 'web')] },
    envs: { prj_web: E2E_ENVS },
    custom: { prj_web: [{ id: 'c_stage', slug: 'staging' }] },
    values: { p2: SECRET.sharedProd, s1: SECRET.bStage, s2: SECRET.sharedStage, h1: SECRET.hidden },
  });

  test('--yes: staging then production; each branch is pushed EXACTLY its Vercel environment\'s set (decrypt-verified), the discovery commit is local on its own branch, nothing is pushed to git, and no value is printed', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const orgId = 'org_v_e2e';
          const userId = 'user_v_e2e';
          const projectId = 'proj_v_e2e';
          const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
          await wrapAndSaveMasterKey(randomBytes(32), orgId, userId, keyOps);
          const projectKey = await resolveProjectKey(orgId, projectId, userId, keyOps);

          // An existing project whose folder is already committed and clean.
          const keep: KeepFile = { version: '3.0', org_id: orgId, project_id: projectId, project_name: 'widgets', variables: {} };
          writeFileSync(join(root, 'keep.lock'), JSON.stringify(keep));
          // `capy`'s own init also writes the ignore rules; a clean, committed pair is what a real initialized repo looks like.
          new FileManager(root).ensureCapyGitignore();
          git(root, ['add', 'keep.lock', '.gitignore']);
          git(root, ['commit', '-q', '-m', 'add keep.lock']);
          const mainHead = git(root, ['rev-parse', 'HEAD']).trim();
          const mainBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

          const pushSecrets = mock(async (_p: string, _keep: string, _env: string, _branch: string) => ({ keep_hash: 'h'.repeat(16) }));
          const ctx = fakeDiscoveryCtx({
            coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
            wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
            createBranch: async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }),
            getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
            pushSecrets,
          });
          const ctxWithIds = { ...ctx, orgId, userId } as DiscoveryContext;

          const { connector, fetchMock } = connectorFor(root, e2eData());
          const run = await captureConsole(() => connector.discover!(ctxWithIds, discoverOpts({ yes: true })));
          const outcome = run.result;
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const folder = outcome.applied?.[0];
          expect(folder?.ok).toBe(true);
          if (!folder?.ok) return;
          expect(folder.environments.map((env) => env.environmentName)).toEqual(['staging', 'production']);
          expect(folder.activeBranch).toBe('production');

          // every push, decrypted with the project key: branch → name/value set
          const fm = new FileManager(root);
          const pushed = Object.fromEntries(
            pushSecrets.mock.calls.map(([, , envBlob, branch]) => [
              branch,
              Object.fromEntries(Object.entries(fm.parseEnvContent(envBlob)).map(([k, v]) => [k, fm.decryptValue(v, projectKey)])),
            ]),
          );
          expect(pushed.staging).toEqual({ B: SECRET.bStage, SHARED: SECRET.sharedStage });
          // production was created from staging, then overwritten with ITS set: nothing of staging's B survives
          expect(pushed.production).toEqual({ A: SECRET.aProd, SHARED: SECRET.sharedProd });
          expect(fm.readEncryptedEnvFile(projectKey)).toEqual({ A: SECRET.aProd, SHARED: SECRET.sharedProd });

          // each imported entry's connector metadata names the project, team and environment
          const stagingEntry = folder.environments.find((env) => env.environmentName === 'staging')!.outcome.imported.find((i) => i.varName === 'B')!.entry;
          expect(stagingEntry).toMatchObject({ provider: 'vercel', vercel_project_id: 'prj_web', vercel_project: 'web', team_id: 'team_acme', environment: 'staging', env_id: 's1' });
          expect(outcome.applied?.[0].ok && (outcome.applied[0].environments[1].outcome.skipped)).toEqual([{ name: 'HIDDEN', code: 'sensitive_unreadable' }]);

          // the local discovery commit: its own branch, the Vercel message, never pushed
          expect(outcome.commits?.[0]).toMatchObject({ ok: true, dryRun: false });
          const commit = outcome.commits?.[0];
          if (commit?.ok && !commit.dryRun) {
            expect(commit.branch).toMatch(/^capy\/vercel-import-/);
            expect(git(root, ['log', '-1', '--format=%s', commit.branch]).trim()).toBe('chore(capy): import Vercel environments');
          }
          expect(git(root, ['rev-parse', mainBranch]).trim()).toBe(mainHead);
          expect(git(root, ['remote']).trim()).toBe('origin'); // a remote exists, and nothing pushed to it: this run has no push step for git at all

          // no deploy target is created non-interactively (Dokploy discovery doesn't either)
          expect(existsSync(join(root, '.capy', 'deploy.json'))).toBe(false);

          // read-only on Vercel; values only ever read via the per-id route
          expect(callsOf(fetchMock).every((c) => c.method === 'GET')).toBe(true);
          const printed = [...run.stdout, ...run.stderr].join('\n');
          ALL_SECRETS.forEach((v) => expect(printed).not.toContain(v));
          // the working tree has the `.env` ciphertext only
          expect(readFileSync(join(root, '.env'), 'utf-8')).not.toContain(SECRET.aProd);
        }),
      ),
    );
  }, 30_000);
});
