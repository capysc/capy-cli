/**
 * `capy secrets deploy` after a project's files moved (src/commands/repoLinksFollowGit.ts): the
 * `.capy/deploy.json` lookup and the keep.lock PR follow the base branch's own files. A stored
 * folder the default branch does not carry (while another does) is not read, a folder holding
 * another project's keep.lock is never read or written, a PR base the move has not reached is
 * written at the folder it does carry (or skipped, never scaffolded), and no row is ever removed,
 * so the move can reach each git branch at its own time. GitHub, Dokploy and the service are injected.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { SKIP_CODES, deployLocationsOf, planBatchDeploy, runBatchDeploy, targetRefOf } from '../../src/deploy/batchDeploy';
import { runSecretsDeploy, type SecretsDeployIo, type SecretsDeployOpts } from '../../src/commands/secretsDeployCommand';
import { planJsonOf } from '../../src/commands/secretsDeployText';
import { ERROR_CODES } from '../../src/types/index';
import type { TargetConfig } from '../../src/deploy/adapter';
import type { OrgRepoLink } from '../../src/service/serviceClient';
import {
  LINKS,
  NAME,
  dokployTarget,
  fakeAdapter,
  fakeGithub,
  fakeService,
  githubKeepFor,
  indexRows,
  makeEnv,
  standardRepos,
  type RepoFixture,
} from '../helpers/batchDeployWorld';

const OLD = 'backend/deployment';
const NEW = 'backend';
/** Only the moved project's locations: the other repo is not what these tests are about. */
const request = { names: [NAME], locations: deployLocationsOf(indexRows()[0]).filter((l) => l.project_id === 'pA') };

const NEW_LINK = LINKS.find((l) => l.project_id === 'pA') as OrgRepoLink;
const OLD_LINK: OrgRepoLink = { ...NEW_LINK, path: OLD };
const STORED: readonly OrgRepoLink[] = [OLD_LINK, ...LINKS];

const deployJson = (targets: readonly TargetConfig[]): string =>
  JSON.stringify({ version: '1', targets: Object.fromEntries(targets.map((t) => [t.name, t])) });
const TARGETS = [dokployTarget('api', { vars: ['API_KEY'] })];

/** The standard world with mono's `main` files given by repo path (solo is untouched). */
function withMonoMain(mainFiles: Readonly<Record<string, string>>, extraBranches: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): readonly RepoFixture[] {
  const [, solo] = standardRepos();
  return [{ owner: 'Acme', name: 'mono', defaultBranch: 'main', files: { main: mainFiles, ...extraBranches } }, solo];
}

const keepOfA = githubKeepFor('pA', 'production');
const AFTER_MOVE = withMonoMain({ [`${NEW}/.capy/deploy.json`]: deployJson(TARGETS), [`${NEW}/keep.lock`]: keepOfA });
const BEFORE_MOVE = withMonoMain({ [`${OLD}/.capy/deploy.json`]: deployJson(TARGETS), [`${OLD}/keep.lock`]: keepOfA });
const NO_KEEP_LOCK = withMonoMain({ [`${NEW}/.capy/deploy.json`]: deployJson(TARGETS) });
const BOTH = withMonoMain({
  [`${NEW}/.capy/deploy.json`]: deployJson(TARGETS),
  [`${NEW}/keep.lock`]: keepOfA,
  [`${OLD}/.capy/deploy.json`]: deployJson([dokployTarget('old-api', { vars: ['API_KEY'] })]),
  [`${OLD}/keep.lock`]: keepOfA,
});
const OLD_IS_ANOTHERS = withMonoMain({
  [`${NEW}/.capy/deploy.json`]: deployJson(TARGETS),
  [`${NEW}/keep.lock`]: keepOfA,
  [`${OLD}/.capy/deploy.json`]: deployJson([dokployTarget('theirs', { vars: ['API_KEY'] })]),
  [`${OLD}/keep.lock`]: githubKeepFor('pB', 'staging'),
});

const deployJsonReads = (github: ReturnType<typeof fakeGithub>): readonly string[] =>
  github.getFile.mock.calls.map((c) => `${c[1]}@${c[2]}`).filter((r) => r.includes('deploy.json')).toSorted();

describe('the deploy.json lookup follows git', () => {
  test('after the move: only the folder git has is read and planned; the old row is not a target', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`)).toEqual([`api@${NEW}`]);
    expect(deployJsonReads(github).filter((r) => r.startsWith('backend'))).toEqual([`${NEW}/.capy/deploy.json@main`]);
  });

  test('the output of the plan is the very output a project with only the new row gets', async () => {
    const moved = await planBatchDeploy(fakeGithub(AFTER_MOVE), request, STORED);
    const never = await planBatchDeploy(fakeGithub(AFTER_MOVE), request, LINKS);

    expect(planJsonOf(moved)).toEqual(planJsonOf(never));
    expect(moved.targets.map(targetRefOf)).toEqual(never.targets.map(targetRefOf));
  });

  test('before the move reaches the default branch: the old folder is read and planned, and the new folder is not', async () => {
    const plan = await planBatchDeploy(fakeGithub(BEFORE_MOVE), request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`)).toEqual([`api@${OLD}`]);
  });

  test('neither folder has a keep.lock: both are read as today', async () => {
    const github = fakeGithub(NO_KEEP_LOCK);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(deployJsonReads(github).filter((r) => r.startsWith('backend'))).toEqual([`${NEW}/.capy/deploy.json@main`, `${OLD}/.capy/deploy.json@main`].toSorted());
    expect(plan.targets.map((t) => t.path)).toEqual([NEW]);
  });

  test('both folders have a keep.lock: both are read', async () => {
    const plan = await planBatchDeploy(fakeGithub(BOTH), request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`).toSorted()).toEqual([`api@${NEW}`, `old-api@${OLD}`].toSorted());
  });

  test('a folder holding another project\'s keep.lock is never read for a deploy.json', async () => {
    const github = fakeGithub(OLD_IS_ANOTHERS);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(plan.targets.map((t) => t.config.name)).toEqual(['api']);
    expect(deployJsonReads(github)).not.toContain(`${OLD}/.capy/deploy.json@main`);
  });

  test('a project with one stored row and no keep.lock at all is planned exactly as before', async () => {
    const plan = await planBatchDeploy(fakeGithub(NO_KEEP_LOCK), request, LINKS);

    expect(plan.targets.map((t) => t.path)).toEqual([NEW]);
    expect(plan.targets.every((t) => t.alt_paths === undefined)).toBe(true);
  });
});

describe('a PR base is judged by its own files', () => {
  const develop = (files: Readonly<Record<string, string>>) => ({ develop: files });
  const apiOnDevelop = [dokployTarget('api', { vars: ['API_KEY'], gitBaseBranch: 'develop' })];
  const mainWithApiOnDevelop = { [`${NEW}/.capy/deploy.json`]: deployJson(apiOnDevelop), [`${NEW}/keep.lock`]: keepOfA };

  async function deliver(repos: readonly RepoFixture[], links: readonly OrgRepoLink[] = STORED) {
    const service = fakeService();
    const github = fakeGithub(repos);
    const adapter = fakeAdapter();
    const { env } = makeEnv(service, github, adapter);
    const plan = await planBatchDeploy(github, request, links);
    const result = await runBatchDeploy(plan, env);
    const apiPaths = github.createTree.mock.calls.map((c) => (c[1] as { path?: string }).path);
    return { plan, result, github, adapter, apiPaths };
  }

  test('the move has landed on main but not on the branch the PR goes to: the PR writes the old folder', async () => {
    const { plan, result, apiPaths } = await deliver(withMonoMain(mainWithApiOnDevelop, develop({ [`${OLD}/keep.lock`]: keepOfA })));

    expect(plan.targets.find((t) => t.config.name === 'api')?.alt_paths).toEqual([OLD]);
    expect(apiPaths).toContain(`${OLD}/keep.lock`);
    expect(apiPaths).not.toContain(`${NEW}/keep.lock`);
    expect(result.targets.find((t) => t.target.target === 'api')?.kind).toBe('delivered');
  });

  test('the branch the PR goes to has the move: the PR writes the new folder', async () => {
    const { apiPaths } = await deliver(withMonoMain(mainWithApiOnDevelop, develop({ [`${NEW}/keep.lock`]: keepOfA })));

    expect(apiPaths).toContain(`${NEW}/keep.lock`);
    expect(apiPaths).not.toContain(`${OLD}/keep.lock`);
  });

  test('no folder has the file on that branch: it is written where the plan says, as before', async () => {
    const { apiPaths } = await deliver(withMonoMain(mainWithApiOnDevelop, develop({ 'README.md': 'x' })));

    expect(apiPaths).toContain(`${NEW}/keep.lock`);
  });

  test('the default branch lags (the move is only on the PR base): every run writes the new folder there, never the old one', async () => {
    const mainOld = { [`${OLD}/.capy/deploy.json`]: deployJson(apiOnDevelop), [`${OLD}/keep.lock`]: keepOfA };
    const runs = await Promise.all([0, 1].map(() => deliver(withMonoMain(mainOld, develop({ [`${NEW}/keep.lock`]: keepOfA })))));

    expect(runs.map((r) => r.plan.targets.find((t) => t.config.name === 'api')?.path)).toEqual([OLD, OLD]);
    expect(runs.map((r) => r.apiPaths)).toEqual([[`${NEW}/keep.lock`], [`${NEW}/keep.lock`]]);
    expect(runs.map((r) => r.result.targets.find((t) => t.target.target === 'api')?.kind)).toEqual(['delivered', 'delivered']);
  });

  test('the default branch leads (the move is only on main): every run writes the old folder on the PR base, never the new one', async () => {
    const runs = await Promise.all([0, 1].map(() => deliver(withMonoMain(mainWithApiOnDevelop, develop({ [`${OLD}/keep.lock`]: keepOfA })))));

    expect(runs.map((r) => r.apiPaths)).toEqual([[`${OLD}/keep.lock`], [`${OLD}/keep.lock`]]);
  });

  test('a PR base that has the project in several other stored folders and not at the planned one: skipped with a code, nothing pushed, nothing created', async () => {
    const legacy: OrgRepoLink = { ...NEW_LINK, path: 'legacy' };
    const { result, github, adapter, apiPaths } = await deliver(
      withMonoMain(mainWithApiOnDevelop, develop({ [`${OLD}/keep.lock`]: keepOfA, 'legacy/keep.lock': keepOfA })),
      [OLD_LINK, NEW_LINK, legacy, ...LINKS.filter((l) => l.project_id !== 'pA')],
    );

    expect(result.targets.find((t) => t.target.target === 'api')).toMatchObject({ kind: 'skipped', code: SKIP_CODES.KEEP_LOCK_NOT_ON_BASE });
    expect(SKIP_CODES.KEEP_LOCK_NOT_ON_BASE).toBe(ERROR_CODES.KEEP_LOCK_NOT_ON_BASE);
    expect(apiPaths).toEqual([]);
    expect(github.createBlob.mock.calls).toHaveLength(0);
    expect(adapter.deploy.mock.calls.map(([c]) => c.name)).not.toContain('api');
  });

  test('an other stored folder that cannot be read on the PR base: the target fails with the read-failure code before anything is pushed or created', async () => {
    const repos = withMonoMain(mainWithApiOnDevelop, develop({ [`${OLD}/keep.lock`]: keepOfA }));
    const service = fakeService();
    const github = fakeGithub(repos);
    const original = github.getFile.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    // The one read of the old folder on `develop` answers 502; every other read is the fixture's.
    github.getFile.mockImplementation((async (repo: unknown, path: string, ref: string) =>
      path === `${OLD}/keep.lock` && ref === 'develop' ? { ok: false, kind: 'REQUEST_FAILED', status: 502 } : original(repo, path, ref)) as never);
    const adapter = fakeAdapter();
    const { env } = makeEnv(service, github, adapter);
    const plan = await planBatchDeploy(github, request, STORED);

    const result = await runBatchDeploy(plan, env);

    expect(result.targets.find((t) => t.target.target === 'api')).toMatchObject({ kind: 'failed', code: ERROR_CODES.KEEP_PR_READ_FAILED, stage: 'github', values_pushed: false });
    expect(adapter.deploy.mock.calls.map(([c]) => c.name)).not.toContain('api');
    expect(github.createTree.mock.calls).toHaveLength(0);
    expect(github.createPull.mock.calls.filter((c) => (c[1] as { base: string }).base === 'develop')).toHaveLength(0);
  });

  test('the planned folder holds another project\'s keep.lock on that branch and there is nowhere else: nothing is pushed, with a code', async () => {
    const service = fakeService();
    const github = fakeGithub(withMonoMain(mainWithApiOnDevelop, develop({ [`${NEW}/keep.lock`]: githubKeepFor('pB', 'staging') })));
    const adapter = fakeAdapter();
    const { env } = makeEnv(service, github, adapter);
    const plan = await planBatchDeploy(github, request, [NEW_LINK, ...LINKS.filter((l) => l.project_id !== 'pA')]);

    const result = await runBatchDeploy(plan, env);

    const api = result.targets.find((t) => t.target.target === 'api');
    expect(api).toMatchObject({ kind: 'failed', code: ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH });
    expect(github.createPull.mock.calls.filter((c) => (c[1] as { base: string }).base === 'develop')).toHaveLength(0);
    expect(adapter.deploy.mock.calls.map(([c]) => c.name)).not.toContain('api');
  });
});

describe('another project\'s keep.lock at a project\'s only stored path', () => {
  const only = [OLD_LINK, ...LINKS.filter((l) => l.project_id !== 'pA')];
  const world = withMonoMain({ [`${OLD}/.capy/deploy.json`]: deployJson(TARGETS), [`${OLD}/keep.lock`]: githubKeepFor('pB', 'staging') });

  test('the plan skips the locations with KEEP_LOCK_PROJECT_MISMATCH, not with a missing-target code, and reads no deploy.json there', async () => {
    const github = fakeGithub(world);
    const plan = await planBatchDeploy(github, request, only);

    expect(plan.targets).toEqual([]);
    expect(plan.skipped.map((k) => k.code)).toEqual([SKIP_CODES.KEEP_LOCK_PROJECT_MISMATCH, SKIP_CODES.KEEP_LOCK_PROJECT_MISMATCH]);
    expect(SKIP_CODES.KEEP_LOCK_PROJECT_MISMATCH).toBe(ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH);
    expect(deployJsonReads(github).filter((r) => r.startsWith('backend'))).toEqual([]);
  });

  test('a project with its own folder next to the foreign one is planned as usual', async () => {
    const both = withMonoMain({ [`${NEW}/.capy/deploy.json`]: deployJson(TARGETS), [`${NEW}/keep.lock`]: keepOfA, [`${OLD}/keep.lock`]: githubKeepFor('pB', 'staging') });
    const plan = await planBatchDeploy(fakeGithub(both), request, STORED);

    expect(plan.targets.map((t) => t.path)).toEqual([NEW]);
    expect(plan.skipped.map((k) => k.code)).not.toContain(SKIP_CODES.KEEP_LOCK_PROJECT_MISMATCH);
  });

  describe('through the command', () => {
    const io = (): SecretsDeployIo => {
      const { env } = makeEnv(fakeService(), fakeGithub(world), fakeAdapter());
      return {
        orgId: 'org1',
        client: {
          getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
          getOrgRepos: async () => ({ org_id: 'org1', repos: [...only] }),
        },
        env,
      };
    };
    const runIt = async (opts: SecretsDeployOpts) => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});
      const outcome = await runSecretsDeploy([NAME], { json: true, ...opts }, io()).then(
        (returned) => ({ returned, exited: false }),
        () => ({ returned: undefined, exited: true }),
      );
      const stdout = logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
      return { ...outcome, body: JSON.parse(stdout) };
    };

    test('a dry run lists the skip with the code', async () => {
      const out = await runIt({ dryRun: true });

      expect(out.body.skipped.filter((k: { project: string }) => k.project === 'mono-backend').map((k: { code: string }) => k.code)).toEqual([
        ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH,
        ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH,
      ]);
    });

    test('a real run refuses with nothing to deploy, and the plan it shows carries the same skips', async () => {
      const exclude = ['solo-server:staging'];
      const out = await runIt({ confirm: 'deadbeefdeadbeef', exclude });

      expect(out.exited).toBe(true);
      expect(out.body.code).toBe(ERROR_CODES.DEPLOY_NOTHING_TO_DEPLOY);
      expect(out.body.plan.skipped.map((k: { code: string }) => k.code)).toContain(ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH);
    });
  });
});

describe('capy secrets deploy: the plan after a move', () => {
  class ExitSignal extends Error {
    constructor(public readonly code: number | undefined) {
      super('exit');
    }
  }

  async function capture(fn: () => Promise<number>) {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await fn().then(
      (returned) => ({ returned, thrown: null as unknown }),
      (thrown: unknown) => ({ returned: undefined, thrown }),
    );
    const stdout = logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    if (outcome.thrown !== null && !(outcome.thrown instanceof ExitSignal)) throw outcome.thrown;
    return { returned: outcome.returned, stdout };
  }

  function rig(repos: readonly RepoFixture[], links: readonly OrgRepoLink[]) {
    const { env } = makeEnv(fakeService(), fakeGithub(repos), fakeAdapter());
    const io: SecretsDeployIo = {
      orgId: 'org1',
      client: {
        getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
        getOrgRepos: async () => ({ org_id: 'org1', repos: [...links] }),
      },
      env,
    };
    return io;
  }
  const run = (io: SecretsDeployIo, opts: SecretsDeployOpts) => capture(() => runSecretsDeploy([NAME], { json: true, ...opts }, io));

  test('the dry-run plan does not list the other stored folder, and is the very plan a project with only the new row gets', async () => {
    const moved = JSON.parse((await run(rig(AFTER_MOVE, STORED), { dryRun: true })).stdout);
    const never = JSON.parse((await run(rig(AFTER_MOVE, LINKS), { dryRun: true })).stdout);

    expect(moved.targets.map((t: { path: string }) => t.path)).not.toContain(OLD);
    expect(moved.plan_id).toBe(never.plan_id);
    expect(moved).toEqual(never);
  });

  test('a real run after the move deploys the new folder, run after run, with every row still stored', async () => {
    const io = rig(AFTER_MOVE, STORED);
    const planId = JSON.parse((await run(io, { dryRun: true })).stdout).plan_id as string;

    const first = await run(io, { confirm: planId });
    const second = await run(io, { confirm: planId });

    expect([first.returned, second.returned]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
  });
});
