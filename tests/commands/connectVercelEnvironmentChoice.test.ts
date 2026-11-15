/**
 * `capy connect vercel --discover --import-environment <environment>[=<branch>]`:
 * which Vercel environments are imported, and which Capy branch each lands on.
 *
 * Covers: the option's own checks (each refusal with its code, before any
 * request, nothing written); the plan (only the named environments, the chosen
 * branch, collisions and ordering by branch, kept names judged on that
 * branch); no option = the plan and report exactly as before; a dry run equal
 * to the real run; a real run through the real sequencer, FileManager and git
 * (rows, placeholders, skips and the discovery commit all on the chosen
 * branch); a branch that already exists; and the option in `capy help --json`.
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { buildVercelDiscoveryPlan } from '../../src/commands/connectors/vercelDiscovery';
import { optionConflict, parseEnvironmentChoices } from '../../src/commands/connectors/vercelEnvironmentMap';
import { loadProvider, listProviders } from '../../src/commands/connectors/registry';
import { findCandidateReposResult, type DiscoveryContext } from '../../src/commands/connectors/dokployDiscovery';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { FileManager } from '../../src/files/fileManager';
import { resolveProjectKey, wrapAndSaveMasterKey } from '../../src/crypto/keyResolver';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import { createVercelClient, type VercelFetchLike } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, git, initRepo, withExitCodeRestored, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const SECRET = {
  prodA: 'prod-a-SENT-11aa',
  prodShared: 'prod-shared-SENT-22bb',
  hidden: 'hidden-SENT-33cc',
  previewP: 'preview-p-SENT-44dd',
  devD: 'dev-d-SENT-55ee',
} as const;
const ALL_SECRETS = Object.values(SECRET);

const e = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

// production: A, SHARED (+ HIDDEN, unreadable). preview: P (+ BRANCHY, scoped to one git branch). development: D.
const ENVS: ReadonlyArray<RawEnv> = [
  e({ id: 'p1', key: 'A', type: 'plain', listValue: SECRET.prodA }),
  e({ id: 'p2', key: 'SHARED', type: 'encrypted', listValue: 'opaque' }),
  e({ id: 'p3', key: 'HIDDEN', type: 'sensitive' }),
  e({ id: 'v1', key: 'P', type: 'plain', target: ['preview'], listValue: SECRET.previewP }),
  e({ id: 'v2', key: 'BRANCHY', type: 'encrypted', target: ['preview'], gitBranch: 'dev', listValue: 'opaque' }),
  e({ id: 'd1', key: 'D', type: 'plain', target: ['development'], listValue: SECRET.devD }),
];

const data = (): FakeVercelData => ({
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: ENVS },
  custom: { prj_web: [] },
  values: { p2: SECRET.prodShared },
});

const noPeek = { peekLocalKeep: () => null, listServerBranches: async () => [] as ReadonlyArray<{ name: string }> };

async function inRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withTempDir('capy-vercel-envchoice', async (root) => {
    initRepo(root, 'git@github.com:acme/widgets.git');
    return fn(root);
  });
}

const fakeDiscoveryCtx = (over: Record<string, unknown> = {}): DiscoveryContext => ({
  orgId: 'org_v',
  userId: 'user_v',
  authService: {} as unknown as DiscoveryContext['authService'],
  serviceClient: { listBranches: async () => [], listProjects: async () => [], ...over } as unknown as DiscoveryContext['serviceClient'],
});

const discoverOpts = (over: Partial<ConnectOpts> = {}): ConnectOpts => ({ nonTty: true, tokenEnv: 'T', ...over });

const connectorFor = (root: string, d: FakeVercelData) => {
  const fetchMock = mock(fakeVercelFetch(d));
  const connector = createVercelConnector({
    fetch: fetchMock as unknown as VercelFetchLike,
    env: { T: 'tok_fake' },
    cwd: root,
    sleep: async () => {},
    syncFolder: async () => ({ ok: true }),
  });
  return { connector, fetchMock };
};

const dryRunJson = async (root: string, over: Partial<ConnectOpts>, ctx: DiscoveryContext = fakeDiscoveryCtx()) => {
  const { connector } = connectorFor(root, data());
  const run = await captureConsole(() => new ConnectCommand(false)['executeDiscovery'](connector, 'vercel', ctx, discoverOpts({ dryRun: true, json: true, ...over })));
  return { run, out: JSON.parse(run.stdout[0]) };
};

type PlanEnv = { branch: string; environment?: string; variableCount: number; skipped: Record<string, unknown>; branchExists?: boolean; willAutoOverwrite: boolean };
const envsOf = (out: { plan: { folders: Array<{ environments: PlanEnv[] }> } }): PlanEnv[] => out.plan.folders[0].environments;

// ── the option's own text ───────────────────────────────────────────────────

describe('parseEnvironmentChoices — each refusal has its code', () => {
  test('a bare name lands on a branch of the same name; name=branch renames; the first = splits', () => {
    expect(parseEnvironmentChoices(['production', 'preview=staging'])).toEqual({
      ok: true,
      choices: [
        { environment: 'production', branch: 'production' },
        { environment: 'preview', branch: 'staging' },
      ],
    });
    expect(parseEnvironmentChoices([])).toEqual({ ok: true, choices: [] });
  });

  test('whitespace around the environment, the = and the branch is trimmed; environment names stay case-sensitive', () => {
    expect(parseEnvironmentChoices([' preview = staging ', '  production  '])).toEqual({
      ok: true,
      choices: [
        { environment: 'preview', branch: 'staging' },
        { environment: 'production', branch: 'production' },
      ],
    });
    // `Preview` and `preview` are two different environment names, so this is not an environment named twice
    expect(parseEnvironmentChoices(['Preview=a', 'preview=b'])).toEqual({
      ok: true,
      choices: [
        { environment: 'Preview', branch: 'a' },
        { environment: 'preview', branch: 'b' },
      ],
    });
  });

  test.each([
    ['the same environment twice', ['preview=staging', 'preview'], ERROR_CODES.VERCEL_ENVIRONMENT_DUPLICATE],
    ['the same environment twice, renamed both times', ['preview=a', 'preview=b'], ERROR_CODES.VERCEL_ENVIRONMENT_DUPLICATE],
    ['two environments on the same branch', ['preview=staging', 'development=staging'], ERROR_CODES.VERCEL_BRANCH_DUPLICATE],
    ['two branches that differ only by case', ['preview=Staging', 'production=staging'], ERROR_CODES.VERCEL_BRANCH_DUPLICATE],
    ['a rename onto another named environment\'s own branch', ['preview=production', 'production'], ERROR_CODES.VERCEL_BRANCH_DUPLICATE],
    ['a branch that starts with a symbol', ['preview=-staging'], ERROR_CODES.BRANCH_NAME_INVALID],
    ['a branch with ..', ['preview=a..b'], ERROR_CODES.BRANCH_NAME_INVALID],
    ['an empty branch after =', ['preview='], ERROR_CODES.BRANCH_NAME_INVALID],
    ['a branch with a space', ['preview=my branch'], ERROR_CODES.BRANCH_NAME_INVALID],
    ['no environment name', ['=staging'], ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND],
  ] as const)('%s', (_label, specs, code) => {
    const parsed = parseEnvironmentChoices(specs);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe(code);
  });

  test('with --environment too: VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE; alone, or with nothing chosen, no conflict', () => {
    const choices = [{ environment: 'preview', branch: 'staging' }];
    expect(optionConflict(choices, 'preview')?.code).toBe(ERROR_CODES.VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE);
    expect(optionConflict(choices, undefined)).toBeNull();
    expect(optionConflict([], 'preview')).toBeNull();
  });
});

describe('connector — refusals change nothing and ask Vercel nothing the option\'s own text decides', () => {
  const refusals = [
    ['an environment named twice', { importEnvironments: ['preview', 'preview=staging'] }, ERROR_CODES.VERCEL_ENVIRONMENT_DUPLICATE],
    ['two environments on one branch', { importEnvironments: ['preview=staging', 'development=staging'] }, ERROR_CODES.VERCEL_BRANCH_DUPLICATE],
    ['an invalid branch name', { importEnvironments: ['preview=-no'] }, ERROR_CODES.BRANCH_NAME_INVALID],
    ['together with --environment', { importEnvironments: ['preview'], environment: 'preview' }, ERROR_CODES.VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE],
  ] as const;

  test.each(refusals)('%s: the code, zero requests, nothing written (even with --yes)', async (_label, over, code) => {
    await inRepo(async (root) => {
      const { connector, fetchMock } = connectorFor(root, data());
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ yes: true, ...over }));
      expect(out.ok).toBe(false);
      expect((out as { code: string }).code).toBe(code);
      expect(fetchMock.mock.calls.length).toBe(0);
      expect(git(root, ['status', '--porcelain']).trim()).toBe('');
      expect(existsSync(join(root, 'keep.lock'))).toBe(false);
    });
  });

  test('an environment Vercel does not have: VERCEL_ENVIRONMENT_NOT_FOUND, listing what exists; only reads happened; nothing written', async () => {
    await inRepo(async (root) => {
      const { connector, fetchMock } = connectorFor(root, data());
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ yes: true, importEnvironments: ['qa=staging', 'production'] }));
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND);
      expect((out as { message: string }).message).toContain('qa');
      expect((out as { message: string }).message).toContain('preview');
      expect(callsOf(fetchMock).every((c) => c.method === 'GET')).toBe(true);
      expect(git(root, ['status', '--porcelain']).trim()).toBe('');
      expect(existsSync(join(root, 'keep.lock'))).toBe(false);
    });
  });

  test('a single import (no --discover) refuses the option: VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE, zero requests', async () => {
    await inRepo(async (root) => {
      const { connector, fetchMock } = connectorFor(root, data());
      const out = await connector.import!({} as unknown as ResolvedContext, discoverOpts({ importEnvironments: ['preview=staging'], project: 'web' }));
      expect(out.ok).toBe(false);
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE);
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });
});

describe('connector — names are trimmed, environment names are case-sensitive', () => {
  test('" preview = staging " plans preview on staging', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const { out } = await dryRunJson(root, { importEnvironments: [' preview = staging '] });
        expect(envsOf(out).map((x) => [x.branch, x.environment])).toEqual([['staging', 'preview']]);
      }),
    );
  });

  test('"Preview" is not "preview": VERCEL_ENVIRONMENT_NOT_FOUND, listing the names that exist', async () => {
    await inRepo(async (root) => {
      const { connector } = connectorFor(root, data());
      const out = await connector.discover!(fakeDiscoveryCtx(), discoverOpts({ yes: true, importEnvironments: ['Preview=staging'] }));
      expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND);
      expect((out as { message: string }).message).toContain('preview');
      expect(existsSync(join(root, 'keep.lock'))).toBe(false);
    });
  });
});

describe('connectors that do not take --import-environment refuse it, before any request', () => {
  test('only the Vercel connector accepts it', async () => {
    const accepting = await Promise.all(listProviders().map(async (p) => [p.name, (await loadProvider(p.name)).acceptsImportEnvironments === true] as const));
    expect(accepting.filter(([, yes]) => yes).map(([name]) => name)).toEqual(['vercel']);
  });

  test.each([['dokploy'], ['stripe']])('%s: CONNECTOR_OPTION_NOT_APPLICABLE as JSON, exit code 1, zero requests, nothing written', async (provider) => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
          throw new Error('no request may be made');
        });
        try {
          const run = await captureConsole(() =>
            new ConnectCommand(false).execute(provider, { discover: true, yes: true, json: true, nonTty: true, importEnvironments: ['staging'] }),
          );
          expect(run.result).toEqual({ linked: false });
          expect(run.stdout.length).toBe(1);
          expect(JSON.parse(run.stdout[0])).toMatchObject({ ok: false, code: ERROR_CODES.CONNECTOR_OPTION_NOT_APPLICABLE });
          expect(process.exitCode).toBe(1);
          expect(fetchSpy.mock.calls.length).toBe(0);
          expect(git(root, ['status', '--porcelain']).trim()).toBe('');
          expect(existsSync(join(root, 'keep.lock'))).toBe(false);
        } finally {
          fetchSpy.mockRestore();
        }
      }),
    );
  });
});

// ── the plan ────────────────────────────────────────────────────────────────

describe('buildVercelDiscoveryPlan with a chosen mapping', () => {
  test('only the named environments are planned, each on its chosen branch; the others are left out', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(data()) });
      const plan = await buildVercelDiscoveryPlan(client, 'team_acme', findCandidateReposResult(root).repos, noPeek, undefined, undefined, [
        { environment: 'preview', branch: 'staging' },
        { environment: 'production', branch: 'production' },
      ]);
      const envs = plan.folders[0].environments;
      expect(envs.map((x) => [x.environmentName, x.branchName]).toSorted()).toEqual([
        ['preview', 'staging'],
        ['production', undefined],
      ]);
      expect(plan.environmentBranches).toEqual([
        { environment: 'preview', branch: 'staging' },
        { environment: 'production', branch: 'production' },
      ]);
      expect(plan.environmentFilter).toBeUndefined();
      expect(plan.allEnvironmentNames).toEqual(['development', 'preview', 'production']);
    });
  });

  test('a name Vercel will not return is "kept" when the CHOSEN branch already holds a value, not when the environment\'s own name does', async () => {
    await inRepo(async (root) => {
      const client = createVercelClient('tok', { fetch: fakeVercelFetch(data()) });
      const keepOn = (branch: string): KeepFile => ({
        version: '3.0',
        org_id: 'o',
        project_id: 'proj_x',
        project_name: 'widgets',
        variables: { HIDDEN: [{ resource_id: 'r', branch, value_hash: 'hash-of-a-real-value' }] },
      });
      const planWith = async (keep: KeepFile) =>
        buildVercelDiscoveryPlan(
          client,
          'team_acme',
          findCandidateReposResult(root).repos,
          { peekLocalKeep: () => keep, listServerBranches: async () => [{ name: 'live' }] },
          undefined,
          undefined,
          [{ environment: 'production', branch: 'live' }],
        );
      const onChosen = (await planWith(keepOn('live'))).folders[0].environments[0];
      expect(onChosen.kept).toEqual([{ name: 'HIDDEN', code: 'CAPY_VALUE_KEPT', reason: 'sensitive_unreadable' }]);
      expect(onChosen.branchExists).toBe(true);
      const onOwnName = (await planWith(keepOn('production'))).folders[0].environments[0];
      expect(onOwnName.kept).toBeUndefined();
      expect(onOwnName.skipped).toEqual([{ name: 'HIDDEN', code: 'sensitive_unreadable' }]);
    });
  });

  test('two projects whose chosen environments land on the same folder + branch collide on the BRANCH', async () => {
    await inRepo(async (root) => {
      const two: FakeVercelData = {
        teams: [{ id: 'team_acme', slug: 'acme' }],
        projects: { team_acme: [project('prj_a', 'alpha'), project('prj_b', 'beta')] },
        envs: {
          prj_a: [e({ id: 'x1', key: 'K', type: 'plain', target: ['preview'], listValue: 'va' })],
          prj_b: [e({ id: 'y1', key: 'K', type: 'plain', target: ['production'], listValue: 'vb' })],
        },
        custom: {},
      };
      const plan = await buildVercelDiscoveryPlan(createVercelClient('tok', { fetch: fakeVercelFetch(two) }), 'team_acme', findCandidateReposResult(root).repos, noPeek, undefined, undefined, [
        { environment: 'preview', branch: 'live' },
        { environment: 'production', branch: 'live' },
      ]);
      expect(plan.collisions.map((c) => c.environmentName)).toEqual(['live']);
      expect(plan.collisions[0].candidates.map((c) => c.serviceId).toSorted()).toEqual(['prj_a', 'prj_b']);
    });
  });
});

// ── no option: unchanged ────────────────────────────────────────────────────

describe('no --import-environment: today\'s plan and report, field for field', () => {
  test('every environment, same names, none of the new fields; an empty option list is the same as none', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const none = await dryRunJson(root, {});
        const empty = await dryRunJson(root, { importEnvironments: [] });
        expect(empty.run.stdout).toEqual(none.run.stdout);
        expect(envsOf(none.out).map((x) => x.branch).toSorted()).toEqual(['development', 'preview', 'production']);
        expect(none.run.stdout[0]).not.toContain('environmentBranches');
        expect(envsOf(none.out).every((x) => !('environment' in x))).toBe(true);
        expect(none.out.plan.environmentBranches).toBeUndefined();
      }),
    );
  });

  test('naming an environment by itself is the same plan as --environment <it>', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const viaFilter = await dryRunJson(root, { environment: 'production' });
        const viaChoice = await dryRunJson(root, { importEnvironments: ['production'] });
        expect(envsOf(viaChoice.out)).toEqual(envsOf(viaFilter.out));
      }),
    );
  });
});

// ── dry run ─────────────────────────────────────────────────────────────────

describe('--dry-run with the option', () => {
  test('names the environment each renamed branch comes from, in JSON and in the human preview; reads only; writes nothing; no value anywhere', async () => {
    await withExitCodeRestored(() =>
      inRepo(async (root) => {
        const choice = { importEnvironments: ['preview=staging', 'production'] };
        const { run, out } = await dryRunJson(root, choice);
        expect(run.stdout.length).toBe(1);
        expect(out.plan.environmentBranches).toEqual([
          { environment: 'preview', branch: 'staging' },
          { environment: 'production', branch: 'production' },
        ]);
        const envs = envsOf(out).toSorted((a, b) => a.branch.localeCompare(b.branch));
        expect(envs.map((x) => [x.branch, x.environment])).toEqual([
          ['production', undefined],
          ['staging', 'preview'],
        ]);
        expect(envs[1]).toMatchObject({ variableCount: 1, skipped: { git_branch_scoped: [{ name: 'BRANCHY', gitBranch: 'dev' }] } });
        expect(envs[0]).toMatchObject({ variableCount: 2, skipped: { sensitive_unreadable: [{ name: 'HIDDEN' }] } });
        // no development environment, no preview branch
        expect(envs.some((x) => x.branch === 'development' || x.branch === 'preview')).toBe(false);

        const { connector, fetchMock } = connectorFor(root, data());
        const human = await captureConsole(() => new ConnectCommand(false)['executeDiscovery'](connector, 'vercel', fakeDiscoveryCtx(), discoverOpts({ dryRun: true, ...choice })));
        const text = human.stdout.join('\n');
        expect(text).toContain('checkout -b staging (preview): 1 var(s), 1 skipped');
        expect(text).toContain('checkout -b production: 2 var(s), 1 skipped');
        expect(text).not.toContain('development');
        expect(callsOf(fetchMock).every((c) => c.method === 'GET')).toBe(true);
        expect(git(root, ['status', '--porcelain']).trim()).toBe('');
        expect(existsSync(join(root, 'keep.lock'))).toBe(false);
        ALL_SECRETS.forEach((v) => expect([...run.stdout, ...text].join('\n')).not.toContain(v));
      }),
    );
  });
});

// ── a real run ──────────────────────────────────────────────────────────────

/** An initialized, committed, clean repo and the fake service the real sequencer talks to; `serverBranches` are the branches Capy already has. */
async function prepareRealRun(root: string, orgId: string, serverBranches: readonly string[]) {
  const userId = `${orgId}_user`;
  const projectId = `${orgId}_proj`;
  const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
  await wrapAndSaveMasterKey(randomBytes(32), orgId, userId, keyOps);
  const projectKey = await resolveProjectKey(orgId, projectId, userId, keyOps);
  const keep: KeepFile = { version: '3.0', org_id: orgId, project_id: projectId, project_name: 'widgets', variables: {} };
  writeFileSync(join(root, 'keep.lock'), JSON.stringify(keep));
  new FileManager(root).ensureCapyGitignore();
  git(root, ['add', 'keep.lock', '.gitignore']);
  git(root, ['commit', '-q', '-m', 'add keep.lock']);
  const pushSecrets = mock(async (_p: string, _keep: string, _env: string, _branch: string) => ({ keep_hash: 'h'.repeat(16) }));
  const createBranch = mock(async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }));
  const ctx = {
    ...fakeDiscoveryCtx({
      listBranches: async () => serverBranches.map((name) => ({ name })),
      coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
      wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
      createBranch,
      getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
      pushSecrets,
    }),
    orgId,
    userId,
  } as DiscoveryContext;
  return { ctx, pushSecrets, createBranch, projectKey };
}

describe('a real run with the option', () => {
  const choice = ['preview=staging', 'production'];

  test('preview lands on staging everywhere: branches created, pushes, keep.lock rows, skips, placeholders, the commit; development and preview never appear; the dry run said the same', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx, pushSecrets, createBranch, projectKey } = await prepareRealRun(root, 'org_v_envchoice', []);

          const dry = await dryRunJson(root, { importEnvironments: choice }, ctx);

          const { connector } = connectorFor(root, data());
          const run = await captureConsole(() => connector.discover!(ctx, discoverOpts({ yes: true, importEnvironments: choice })));
          const outcome = run.result;
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const folder = outcome.applied?.[0];
          expect(folder?.ok).toBe(true);
          if (!folder?.ok) return;

          // dry run = real run: same branches, from the same environments; the run itself goes staging first, production last
          expect(folder.environments.map((x) => [x.branchName ?? x.environmentName, x.environmentName])).toEqual([
            ['staging', 'preview'],
            ['production', 'production'],
          ]);
          expect(folder.environments.map((x) => [x.branchName ?? x.environmentName, x.environmentName]).toSorted()).toEqual(
            envsOf(dry.out).map((x) => [x.branch, x.environment ?? x.branch]).toSorted(),
          );
          expect(folder.activeBranch).toBe('production');
          expect(createBranch.mock.calls.map((c) => c[1])).toEqual(['staging', 'production']);

          // pushes: staging holds preview's set, production holds production's; development's D reaches neither
          const fm = new FileManager(root);
          const pushed = Object.fromEntries(
            pushSecrets.mock.calls.map(([, , envBlob, branch]) => [
              branch,
              Object.fromEntries(Object.entries(fm.parseEnvContent(envBlob)).map(([k, v]) => [k, fm.decryptValue(v, projectKey)])),
            ]),
          );
          expect(Object.keys(pushed).toSorted()).toEqual(['production', 'staging']);
          expect(pushed.staging).toEqual({ P: SECRET.previewP });
          expect(pushed.production).toEqual({ A: SECRET.prodA, SHARED: SECRET.prodShared });

          // the report: the skip is on staging's step, the placeholder on production's
          const staging = folder.environments.find((x) => x.branchName === 'staging')!;
          expect(staging.environmentName).toBe('preview');
          expect(staging.outcome.skipped).toEqual([{ name: 'BRANCHY', code: 'git_branch_scoped', gitBranch: 'dev' }]);
          expect(staging.outcome.placeholders ?? []).toEqual([]);
          expect(staging.branchCreated).toBe(true);
          // each row still says which Vercel environment it came from
          expect(staging.outcome.imported.find((i) => i.varName === 'P')!.entry).toMatchObject({ provider: 'vercel', environment: 'preview' });
          const production = folder.environments.find((x) => x.environmentName === 'production')!;
          expect(production.branchName).toBeUndefined();
          expect(production.outcome.placeholders).toEqual([{ name: 'HIDDEN', code: 'sensitive_unreadable', provider: 'vercel' }]);

          // keep.lock rows: on staging and production, none on preview or development
          const keep = JSON.parse(readFileSync(join(root, 'keep.lock'), 'utf-8')) as KeepFile;
          const rowBranches = (name: string) => (keep.variables[name] ?? []).map((row) => row.branch).toSorted();
          expect(rowBranches('P')).toEqual(['staging']);
          expect(rowBranches('A')).toEqual(['production']);
          expect(rowBranches('HIDDEN')).toEqual(['production']);
          expect(rowBranches('D')).toEqual([]);
          const allBranches = new Set(Object.values(keep.variables).flatMap((rows) => rows.map((row) => row.branch)));
          expect(allBranches.has('preview')).toBe(false);
          expect(allBranches.has('development')).toBe(false);

          // the discovery commit: the previewed branch and files are the real ones
          const dryCommit = dry.out.commits[0];
          const commit = outcome.commits?.[0];
          expect(commit).toMatchObject({ ok: true, dryRun: false });
          if (commit?.ok && !commit.dryRun) {
            expect([...commit.committedFiles].toSorted()).toEqual([...dryCommit.wouldCommitFiles].toSorted());
            expect(commit.branch).toMatch(/^capy\/vercel-import-/);
          }

          ALL_SECRETS.forEach((v) => expect([...run.stdout, ...run.stderr].join('\n')).not.toContain(v));
          expect(readFileSync(join(root, '.env'), 'utf-8')).not.toContain(SECRET.previewP);
        }),
      ),
    );
  }, 30_000);

  test('the applied --json report carries the chosen branch and, for a renamed one, the environment', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx } = await prepareRealRun(root, 'org_v_envchoice_report', []);
          const { connector } = connectorFor(root, data());
          const run = await captureConsole(() => new ConnectCommand(false)['executeDiscovery'](connector, 'vercel', ctx, discoverOpts({ yes: true, json: true, importEnvironments: choice })));
          const out = JSON.parse(run.stdout[0]);
          expect(out.applied[0].environments.map((x: { branch: string; environment?: string }) => [x.branch, x.environment])).toEqual([
            ['staging', 'preview'],
            ['production', undefined],
          ]);
          expect(out.applied[0].environments[0].skipped).toEqual([{ name: 'BRANCHY', code: 'git_branch_scoped', gitBranch: 'dev' }]);
          expect(out.applied[0].activeBranch).toBe('production');
        }),
      ),
    );
  }, 30_000);

  test('a branch that already exists in the project is checked out and imported into like any import: not created, no auto-overwrite, and the plan says so', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx, createBranch } = await prepareRealRun(root, 'org_v_envchoice_exists', ['staging']);
          const dry = await dryRunJson(root, { importEnvironments: ['preview=staging'] }, ctx);
          expect(envsOf(dry.out)[0]).toMatchObject({ branch: 'staging', environment: 'preview', branchExists: true, willAutoOverwrite: false });

          const { connector } = connectorFor(root, data());
          const outcome = await connector.discover!(ctx, discoverOpts({ yes: true, importEnvironments: ['preview=staging'] }));
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const folder = outcome.applied?.[0];
          expect(folder?.ok).toBe(true);
          if (!folder?.ok) return;
          expect(createBranch.mock.calls.length).toBe(0);
          expect(folder.environments.map((x) => [x.branchName, x.branchCreated, x.overwrote])).toEqual([['staging', false, false]]);
          expect(folder.environments[0].outcome.imported.map((i) => i.varName)).toEqual(['P']);
          expect(folder.activeBranch).toBe('staging');
        }),
      ),
    );
  }, 30_000);
});

describe('a real run: what is read, what is kept, where placeholders land', () => {
  const idsFetched = (fetchMock: { mock: { calls: ReadonlyArray<readonly unknown[]> } }): readonly string[] =>
    callsOf(fetchMock)
      .map((c) => /\/env\/([^/?]+)/.exec(c.url)?.[1])
      .filter((id): id is string => id !== undefined);

  test('an environment that is not named never has its encrypted value fetched; a named one does', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx } = await prepareRealRun(root, 'org_v_envchoice_fetch', []);
          const first = connectorFor(root, data());
          await first.connector.discover!(ctx, discoverOpts({ yes: true, importEnvironments: ['production=live'] }));
          // production's encrypted SHARED (p2) is read; preview's and development's records are not
          expect(idsFetched(first.fetchMock)).toContain('p2');
          expect(idsFetched(first.fetchMock).filter((id) => ['v1', 'v2', 'd1'].includes(id))).toEqual([]);
        }),
      ),
    );
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx } = await prepareRealRun(root, 'org_v_envchoice_fetch2', []);
          const second = connectorFor(root, data());
          await second.connector.discover!(ctx, discoverOpts({ yes: true, importEnvironments: ['preview=staging'] }));
          // production's records (A, encrypted SHARED, sensitive HIDDEN) and development's are never asked for
          expect(idsFetched(second.fetchMock).filter((id) => ['p1', 'p2', 'p3', 'd1'].includes(id))).toEqual([]);
        }),
      ),
    );
  }, 30_000);

  test('a differing value on an existing mapped branch is skipped and the existing value is kept', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const orgId = 'org_v_envchoice_keepold';
          const { ctx, projectKey } = await prepareRealRun(root, orgId, ['staging']);
          // the existing `staging` branch already holds P with another value, as the service would hand it over
          const scratch = mkdtempSync(join(tmpdir(), 'capy-envchoice-seed-'));
          const keep: KeepFile = { version: '3.0', org_id: orgId, project_id: `${orgId}_proj`, project_name: 'widgets', variables: {} };
          new FileManager(scratch).writeEncryptedEnvFile({ P: 'old-P-SENT-99zz' }, projectKey, undefined, keep, 'staging');
          const envContent = readFileSync(join(scratch, '.env'), 'utf-8');
          const withExisting = {
            ...ctx,
            serviceClient: {
              ...ctx.serviceClient,
              getDecryptData: async () => ({ env_content: envContent, keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
            },
          } as DiscoveryContext;

          const { connector } = connectorFor(root, data());
          const outcome = await connector.discover!(withExisting, discoverOpts({ yes: true, importEnvironments: ['preview=staging'] }));
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const folder = outcome.applied?.[0];
          if (!folder?.ok) throw new Error('folder not applied');
          const step = folder.environments[0];
          expect([step.branchName, step.branchCreated, step.overwrote]).toEqual(['staging', false, false]);
          expect(step.outcome.imported).toEqual([]);
          expect(step.outcome.skipped).toEqual(expect.arrayContaining([{ name: 'P', code: 'IMPORT_CONFLICT_SKIPPED' }]));
          expect(new FileManager(root).readEncryptedEnvFile(projectKey)).toEqual({ P: 'old-P-SENT-99zz' });
        }),
      ),
    );
  }, 30_000);

  test('a placeholder for an unreadable value in a renamed environment lands on the renamed branch only', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        inRepo(async (root) => {
          const { ctx } = await prepareRealRun(root, 'org_v_envchoice_placeholder', []);
          const withHidden: FakeVercelData = { ...data(), envs: { prj_web: [...ENVS, e({ id: 'v3', key: 'PH', type: 'sensitive', target: ['preview'] })] } };
          const { connector } = connectorFor(root, withHidden);
          const outcome = await connector.discover!(ctx, discoverOpts({ yes: true, importEnvironments: ['preview=staging'] }));
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const folder = outcome.applied?.[0];
          if (!folder?.ok) throw new Error('folder not applied');
          expect(folder.environments[0].branchName).toBe('staging');
          expect(folder.environments[0].outcome.placeholders).toEqual([{ name: 'PH', code: 'sensitive_unreadable', provider: 'vercel' }]);
          const keep = JSON.parse(readFileSync(join(root, 'keep.lock'), 'utf-8')) as KeepFile;
          expect((keep.variables.PH ?? []).map((row) => [row.branch, row.placeholder?.provider])).toEqual([['staging', 'vercel']]);
        }),
      ),
    );
  }, 30_000);
});

// ── help ────────────────────────────────────────────────────────────────────

describe('capy help --json', () => {
  const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');
  const doc = (() => {
    const r = spawnSync(process.execPath, ['run', ENTRY, 'help', '--json'], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent-capy-home' } });
    return JSON.parse(r.stdout) as { commands: Array<{ path: string; options: Array<{ long: string; description: string }> }>; errorCodes: string[] };
  })();

  test('connect lists --import-environment, and the new codes are listed', () => {
    const connect = doc.commands.find((c) => c.path === 'connect')!;
    const option = connect.options.find((o) => o.long === '--import-environment');
    expect(option).toBeDefined();
    expect(option!.description).toContain('vercel');
    ['VERCEL_ENVIRONMENT_DUPLICATE', 'VERCEL_BRANCH_DUPLICATE', 'VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE', 'CONNECTOR_OPTION_NOT_APPLICABLE'].forEach((code) => expect(doc.errorCodes).toContain(code));
  });

  test('--environment is still there, unchanged in meaning', () => {
    const connect = doc.commands.find((c) => c.path === 'connect')!;
    expect(connect.options.find((o) => o.long === '--environment')!.description).toContain('restrict the plan to these environment names');
  });
});
