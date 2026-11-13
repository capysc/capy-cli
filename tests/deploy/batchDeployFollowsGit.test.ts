/**
 * `capy secrets deploy` after a project's files moved (src/commands/repoLinksFollowGit.ts): the
 * `.capy/deploy.json` lookup and the keep.lock PR follow the base branch's own files. A stored
 * folder the default branch does not carry (while another does) is not read, a folder holding
 * another project's keep.lock is never read or written, a PR base the move has not reached is
 * written at the folder it does carry, and a stale link is forgotten only after a real run,
 * best effort and silently. GitHub, Dokploy and the service are injected.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { deployLocationsOf, planBatchDeploy, runBatchDeploy, targetRefOf } from '../../src/deploy/batchDeploy';
import { runSecretsDeploy, type SecretsDeployIo, type SecretsDeployOpts } from '../../src/commands/secretsDeployCommand';
import { planJsonOf } from '../../src/commands/secretsDeployText';
import { CapyError, ERROR_CODES } from '../../src/types/index';
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
  test('after the move: only the folder git has is read and planned; the old row is reported stale, not as a target', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`)).toEqual([`api@${NEW}`]);
    expect(deployJsonReads(github).filter((r) => r.startsWith('backend'))).toEqual([`${NEW}/.capy/deploy.json@main`]);
    expect(plan.stale_links).toEqual([OLD_LINK]);
  });

  test('the output of the plan is the very output a project with only the new row gets', async () => {
    const moved = await planBatchDeploy(fakeGithub(AFTER_MOVE), request, STORED);
    const never = await planBatchDeploy(fakeGithub(AFTER_MOVE), request, LINKS);

    expect(planJsonOf(moved)).toEqual(planJsonOf(never));
    expect(moved.targets.map(targetRefOf)).toEqual(never.targets.map(targetRefOf));
    expect(JSON.stringify(planJsonOf(moved))).not.toContain('stale');
  });

  test('before the move reaches the default branch: the old folder is read and planned, and the new row is stale', async () => {
    const plan = await planBatchDeploy(fakeGithub(BEFORE_MOVE), request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`)).toEqual([`api@${OLD}`]);
    expect(plan.stale_links).toEqual([NEW_LINK]);
  });

  test('neither folder has a keep.lock: both are read as today and nothing is stale', async () => {
    const github = fakeGithub(NO_KEEP_LOCK);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(deployJsonReads(github).filter((r) => r.startsWith('backend'))).toEqual([`${NEW}/.capy/deploy.json@main`, `${OLD}/.capy/deploy.json@main`].toSorted());
    expect(plan.stale_links).toBeUndefined();
    expect(plan.targets.map((t) => t.path)).toEqual([NEW]);
  });

  test('both folders have a keep.lock: both are read, nothing is stale', async () => {
    const plan = await planBatchDeploy(fakeGithub(BOTH), request, STORED);

    expect(plan.targets.map((t) => `${t.config.name}@${t.path}`).toSorted()).toEqual([`api@${NEW}`, `old-api@${OLD}`].toSorted());
    expect(plan.stale_links).toBeUndefined();
  });

  test('a folder holding another project\'s keep.lock is never read for a deploy.json, and never stale', async () => {
    const github = fakeGithub(OLD_IS_ANOTHERS);
    const plan = await planBatchDeploy(github, request, STORED);

    expect(plan.targets.map((t) => t.config.name)).toEqual(['api']);
    expect(deployJsonReads(github)).not.toContain(`${OLD}/.capy/deploy.json@main`);
    expect(plan.stale_links).toBeUndefined();
  });

  test('a project with one stored row and no keep.lock at all is planned exactly as before', async () => {
    const plan = await planBatchDeploy(fakeGithub(NO_KEEP_LOCK), request, LINKS);

    expect(plan.targets.map((t) => t.path)).toEqual([NEW]);
    expect(plan.stale_links).toBeUndefined();
    expect(plan.targets.every((t) => t.alt_paths === undefined)).toBe(true);
  });
});

describe('a PR base is judged by its own files', () => {
  const develop = (files: Readonly<Record<string, string>>) => ({ develop: files });
  const apiOnDevelop = [dokployTarget('api', { vars: ['API_KEY'], gitBaseBranch: 'develop' })];
  const mainWithApiOnDevelop = { [`${NEW}/.capy/deploy.json`]: deployJson(apiOnDevelop), [`${NEW}/keep.lock`]: keepOfA };

  async function deliver(repos: readonly RepoFixture[]) {
    const service = fakeService();
    const github = fakeGithub(repos);
    const adapter = fakeAdapter();
    const { env } = makeEnv(service, github, adapter);
    const plan = await planBatchDeploy(github, request, STORED);
    const result = await runBatchDeploy(plan, env);
    const apiPaths = github.createTree.mock.calls.map((c) => (c[1] as { path?: string }).path);
    return { plan, result, github, apiPaths };
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

describe('capy secrets deploy: forgetting the stale link', () => {
  type DeleteFn = NonNullable<SecretsDeployIo['client']['deleteProjectRepo']>;

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
    const stderr = errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
    const exits = exitSpy.mock.calls;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (outcome.thrown !== null && !(outcome.thrown instanceof ExitSignal)) throw outcome.thrown;
    return { returned: outcome.returned, exitCode: exits.length > 0 ? exits[exits.length - 1][0] : undefined, stdout, stderr };
  }

  function rig(repos: readonly RepoFixture[], links: readonly OrgRepoLink[], deleteProjectRepo: DeleteFn | 'absent') {
    const service = fakeService();
    const github = fakeGithub(repos);
    const { env } = makeEnv(service, github, fakeAdapter());
    const fallback = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
    const chosen = deleteProjectRepo === 'absent' ? undefined : deleteProjectRepo;
    const io: SecretsDeployIo = {
      orgId: 'org1',
      client: {
        getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
        getOrgRepos: async () => ({ org_id: 'org1', repos: [...links] }),
        ...(chosen === undefined ? {} : { deleteProjectRepo: chosen }),
      },
      env,
    };
    return { io, deleted: chosen ?? fallback };
  }
  const run = (r: ReturnType<typeof rig>, opts: SecretsDeployOpts) => capture(() => runSecretsDeploy([NAME], { json: true, ...opts }, r.io));

  test('a real run forgets the stale row once; the dry run, a refused confirm and a clean project forget nothing', async () => {
    const del = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
    const r = rig(AFTER_MOVE, STORED, del);
    const planId = JSON.parse((await run(r, { dryRun: true })).stdout).plan_id as string;
    expect(del.mock.calls).toHaveLength(0);

    await run(r, { confirm: 'deadbeefdeadbeef' });
    expect(del.mock.calls).toHaveLength(0);

    const out = await run(r, { confirm: planId });
    expect(out.returned).toBe(0);
    expect(del.mock.calls.map((c) => c.slice(0, 3))).toEqual([['org1', 'pA', { host: 'github.com', owner: 'Acme', name: 'mono', path: OLD }]]);

    const clean = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
    const cleanRig = rig(AFTER_MOVE, LINKS, clean);
    await run(cleanRig, { confirm: JSON.parse((await run(cleanRig, { dryRun: true })).stdout).plan_id });
    expect(clean.mock.calls).toHaveLength(0);
  });

  test('a delete that fails changes neither the output nor the exit code', async () => {
    const quiet = rig(AFTER_MOVE, STORED, 'absent');
    const failing = rig(AFTER_MOVE, STORED, async () => {
      throw new CapyError('not allowed', ERROR_CODES.PERMISSION_DENIED);
    });
    const planId = JSON.parse((await run(quiet, { dryRun: true })).stdout).plan_id as string;

    const a = await run(quiet, { confirm: planId });
    const b = await run(failing, { confirm: planId });

    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
    expect([b.returned, b.exitCode]).toEqual([a.returned, a.exitCode]);
    expect(a.returned).toBe(0);
  });

  test('the dry-run plan does not list the stale folder, and its plan_id is the one a project with only the new row gets', async () => {
    const moved = JSON.parse((await run(rig(AFTER_MOVE, STORED, 'absent'), { dryRun: true })).stdout);
    const never = JSON.parse((await run(rig(AFTER_MOVE, LINKS, 'absent'), { dryRun: true })).stdout);

    expect(moved.targets.map((t: { path: string }) => t.path)).not.toContain(OLD);
    expect(moved.plan_id).toBe(never.plan_id);
    expect(moved).toEqual(never);
  });
});
