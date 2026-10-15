/**
 * Batch deploy (CAP-704, src/deploy/batchDeploy.ts): the Dokploy CI deploy of many
 * targets with no project folder. Config comes from the default branch's
 * `.capy/deploy.json` through the GitHub API, values from one unlock, the record is built
 * from the server's keep, the PR goes through the GitHub API. Everything external is
 * injected (tests/helpers/batchDeployWorld.ts): no network, no `gh`, no git. What the engine
 * did is read back from `mock` call logs, so no test keeps a mutable counter.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  BATCH_DEPLOY_CONCURRENCY,
  SKIP_CODES,
  batchSucceeded,
  deployLocationsOf,
  deployTarget,
  planBatchDeploy,
  pushTarget,
  runBatchDeploy,
  type BatchPlan,
  type BatchProgress,
} from '../../src/deploy/batchDeploy';
import { createDokployAdapter } from '../../src/deploy/adapters/dokploy';
import { buildDeployPrBody } from '../../src/deploy/deployPrBody';
import { renderBatchResult, resultJsonOf } from '../../src/commands/secretsDeployText';
import { CapyError, ERROR_CODES, KeepFile } from '../../src/types/index';
import {
  KEYS,
  LEGACY_RECORD,
  LINKS,
  NAME,
  VALUES,
  batchTarget,
  dokployTarget,
  everythingSentTo,
  fakeAdapter,
  fakeGithub,
  fakeService,
  hashOf,
  indexRows,
  makeEnv,
  standardRepos,
  type WorldOpts,
} from '../helpers/batchDeployWorld';

const request = { names: [NAME], locations: deployLocationsOf(indexRows()[0]) };

function world(opts: WorldOpts = {}, adapter = fakeAdapter(), serviceOpts: Parameters<typeof fakeService>[0] = {}) {
  const service = fakeService(serviceOpts);
  const github = fakeGithub(standardRepos(opts));
  const { env, openKeys } = makeEnv(service, github, adapter);
  return { service, github, adapter, env, openKeys };
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The most `+` not yet closed by a `-` at any point of the log. */
const maxOpen = (events: readonly string[]): number =>
  events.reduce(
    (acc, e) => {
      const open = acc.open + (e.startsWith('+') ? 1 : -1);
      return { open, max: Math.max(acc.max, open) };
    },
    { open: 0, max: 0 },
  ).max;

const skipPairs = (plan: BatchPlan) => plan.skipped.map((s) => `${s.project}/${s.branch}/${s.target ?? '-'}:${s.code}`).toSorted();

describe('the plan: which targets would be deployed', () => {
  test('reads each project\'s deploy.json from the repo DEFAULT branch only, and an unmerged target does not count', async () => {
    const { github } = world();
    const plan = await planBatchDeploy(github, request, LINKS);

    const reads = github.getFile.mock.calls.filter((c) => String(c[1]).endsWith('deploy.json'));
    expect(reads.map((c) => `${c[0].name}:${c[1]}@${c[2]}`).toSorted()).toEqual(['mono:backend/.capy/deploy.json@main', 'solo:.capy/deploy.json@trunk']);
    // `unmerged` is only on mono's `develop`: Capy knows it delivered there, but it is not a target.
    expect(plan.targets.map((t) => t.config.name)).not.toContain('unmerged');
    expect(skipPairs(plan)).toContain(`mono-backend/production/unmerged:${SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH}`);
  });

  test('Dokploy CI targets are planned; other providers, direct mode and locations with no target are skipped with codes', async () => {
    const { github } = world();
    const plan = await planBatchDeploy(github, request, LINKS);

    expect(plan.targets.map((t) => `${t.project_name}/${t.branch}/${t.config.name}`)).toEqual([
      'mono-backend/production/api',
      'mono-backend/production/worker',
      'solo-server/staging/site',
    ]);
    expect(skipPairs(plan)).toEqual([
      `mono-backend/production/cf:${SKIP_CODES.NOT_DOKPLOY}`,
      `mono-backend/production/direct:${SKIP_CODES.NOT_CI_MODE}`,
      `mono-backend/production/unmerged:${SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH}`,
      `mono-backend/staging/-:${SKIP_CODES.NO_TARGET}`,
    ]);
    expect(plan.read_failed).toEqual([]);
  });

  test('a target is deployed from the target\'s PR base: its gitBaseBranch, else the repo\'s default branch', async () => {
    const { github } = world({ monoTargets: [dokployTarget('nobase', { gitBaseBranch: undefined })] });
    const plan = await planBatchDeploy(github, request, LINKS);
    const bases = Object.fromEntries(plan.targets.map((t) => [t.config.name, t.base]));
    expect(bases).toEqual({ nobase: 'main', site: 'staging' });
  });

  test('a target that ships none of the selected names is not planned', async () => {
    const { github } = world();
    const plan = await planBatchDeploy(github, { ...request, names: ['DB_URL'] }, LINKS);
    expect(plan.targets.map((t) => t.config.name)).toEqual(['api']); // `worker` and `site` ship API_KEY only
  });

  test('two rows reaching the same target make it one target', async () => {
    const { github } = world();
    const twice = { names: [NAME, 'DB_URL'], locations: [...request.locations, ...request.locations] };
    const plan = await planBatchDeploy(github, twice, LINKS);
    expect(plan.targets.map((t) => t.config.name)).toEqual(['api', 'worker', 'site']);
  });

  test('a repo whose deploy.json cannot be read is reported with a code and its locations are not decided', async () => {
    const { github } = world({ monoFail: ['getFile'] });
    const plan = await planBatchDeploy(github, request, LINKS);
    expect(plan.read_failed).toEqual([{ repo: 'Acme/mono', code: ERROR_CODES.KEEP_PR_READ_FAILED }]);
    expect(plan.targets.map((t) => t.config.name)).toEqual(['site']);
    expect(skipPairs(plan).filter((s) => s.startsWith('mono-backend'))).toEqual([]);
  });

  test('no gh: a code, nothing planned', async () => {
    const plan = await planBatchDeploy(undefined, request, LINKS);
    expect(plan.targets).toEqual([]);
    expect(plan.read_failed).toEqual([{ repo: 'github.com', code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE }]);
  });

  test('a location whose project has no repo link has no target (or only ones Capy knows from before)', async () => {
    const { github } = world();
    const plan = await planBatchDeploy(github, request, []);
    expect(plan.targets).toEqual([]);
    expect(skipPairs(plan)).toEqual([
      `mono-backend/production/api:${SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH}`,
      `mono-backend/production/unmerged:${SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH}`,
      `mono-backend/staging/-:${SKIP_CODES.NO_TARGET}`,
      `solo-server/staging/site:${SKIP_CODES.TARGET_NOT_ON_DEFAULT_BRANCH}`,
    ]);
  });

  test('planning reads only: it writes nothing and unlocks nothing', async () => {
    const { github, service, adapter, openKeys } = world();
    await planBatchDeploy(github, request, LINKS);
    expect(openKeys.mock.calls).toHaveLength(0);
    expect(service.getDecryptData.mock.calls).toHaveLength(0);
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
    expect(adapter.deploy.mock.calls).toHaveLength(0);
    expect(github.createBlob.mock.calls).toHaveLength(0);
    expect(github.createPull.mock.calls).toHaveLength(0);
  });
});

describe('a run: values, preflight, record and PR', () => {
  const plannedWorld = async (opts: WorldOpts = {}, adapter = fakeAdapter(), serviceOpts: Parameters<typeof fakeService>[0] = {}) => {
    const w = world(opts, adapter, serviceOpts);
    const plan = await planBatchDeploy(w.github, request, LINKS);
    return { ...w, plan };
  };

  test('one unlock for the whole run, and each target\'s own variables (and only those) reach the adapter, decrypted', async () => {
    const { plan, env, openKeys, adapter, service } = await plannedWorld();
    const result = await runBatchDeploy(plan, env);

    expect(openKeys.mock.calls).toHaveLength(1);
    expect(service.getDecryptData.mock.calls.map((c) => `${c[0]}/${c[1]}`).toSorted()).toEqual(['pA/production', 'pA/production', 'pB/staging']);
    const sent = Object.fromEntries(adapter.deploy.mock.calls.map(([config, ctx]) => [config.name, ctx.env]));
    expect(sent).toEqual({
      api: { API_KEY: VALUES.API_KEY, DB_URL: VALUES.DB_URL },
      worker: { API_KEY: VALUES.API_KEY },
      site: { API_KEY: VALUES.API_KEY },
    });
    // CI mode: secrets only. Capy never triggers a deploy; merging the PR does.
    expect(adapter.deploy.mock.calls.every(([, ctx]) => ctx.secretsOnly === true && ctx.noDeploy === false && ctx.dryRun === false)).toBe(true);
    expect(result.targets.map((t) => t.kind)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(batchSucceeded(result)).toBe(true);
  });

  test('preflight is given keep.lock\'s repo-relative path, per target, and runs before anything is decrypted', async () => {
    const { plan, env, adapter, service } = await plannedWorld();
    await runBatchDeploy(plan, env);

    const paths = Object.fromEntries(adapter.preflight.mock.calls.map(([config, ctx]) => [config.name, (ctx as { keepLockPath: string }).keepLockPath]));
    expect(paths).toEqual({ api: 'backend/keep.lock', worker: 'backend/keep.lock', site: 'keep.lock' });
    // A refused preflight never reads or decrypts a value.
    const refusing = fakeAdapter({ preflight: () => ({ ok: false, code: ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF, reason: 'r' }) });
    const w = await plannedWorld({}, refusing);
    const out = await runBatchDeploy(w.plan, w.env);
    expect(w.service.getDecryptData.mock.calls).toHaveLength(0);
    expect(refusing.deploy.mock.calls).toHaveLength(0);
    expect(out.targets.every((t) => t.kind === 'failed' && t.stage === 'preflight' && t.code === ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF && !t.values_pushed)).toBe(true);
    expect(service.getDecryptData.mock.calls.length).toBeGreaterThan(0);
  });

  test('the REAL Dokploy preflight uses the passed keep.lock path, not the working directory', async () => {
    const appJson = (watchPaths: readonly string[]) => ({
      applicationId: 'app-api',
      name: 'demo',
      env: 'NODE_ENV=production',
      buildArgs: null,
      buildSecrets: null,
      createEnvFile: true,
      autoDeploy: true,
      branch: 'main',
      watchPaths,
    });
    const fetchFor = (watchPaths: readonly string[]) =>
      mock(async (url: string) => {
        if (!new URL(url).pathname.endsWith('application.one')) throw new Error('unscripted request');
        return { status: 200, ok: true, text: async () => JSON.stringify(appJson(watchPaths)) };
      });
    const preflight = async (watchPaths: readonly string[]) => {
      const adapter = createDokployAdapter({ fetch: fetchFor(watchPaths) as never, log: () => undefined });
      return adapter.preflight(dokployTarget('api'), {
        cwd: process.cwd(), // not a project folder: only the passed path can say where keep.lock is
        keepLockPath: 'backend/keep.lock',
        resolvedApiKey: { ok: true, value: 'dk', source: 'env' },
        interactive: false,
      });
    };
    expect((await preflight(['backend/**'])).ok).toBe(true);
    const refused = await preflight(['frontend/**']);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe(ERROR_CODES.DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP);
  });

  test('the record is built from the SERVER\'s keep: another target\'s record survives, the blob is re-sent unchanged, and a branch gets ONE write', async () => {
    const { plan, env, service } = await plannedWorld();
    await runBatchDeploy(plan, env);

    const writes = service.pushSecrets.mock.calls.map((c) => `${c[0]}/${c[3]}`).toSorted();
    expect(writes).toEqual(['pA/production', 'pB/staging']); // api and worker share pA/production: one write, no lost update
    const [, keepJson, blob] = service.pushSecrets.mock.calls.find((c) => c[0] === 'pA/production'.split('/')[0] && c[3] === 'production') as string[];
    const keep = JSON.parse(keepJson) as KeepFile;
    const apiKey = keep.variables.API_KEY[0] as unknown as { targets: Array<{ target: string; deployed_value_hash: string }> };
    expect(apiKey.targets.map((t) => t.target).toSorted()).toEqual(['api', 'legacy', 'worker']);
    expect(apiKey.targets.find((t) => t.target === 'legacy')).toEqual(LEGACY_RECORD);
    expect(apiKey.targets.find((t) => t.target === 'api')?.deployed_value_hash).toBe(hashOf('API_KEY'));
    const dbUrl = keep.variables.DB_URL[0] as unknown as { targets: Array<{ target: string }> };
    expect(dbUrl.targets.map((t) => t.target)).toEqual(['api']); // `worker` does not ship DB_URL
    expect(blob).toBe(service.blobs['pA/production']);
    // The pin itself is untouched: only `targets` changed.
    expect(keep.variables.API_KEY[0].value_hash).toBe(hashOf('API_KEY'));
  });

  test('one PR per target, through the GitHub API, on the target\'s base, with the deploy PR\'s own title and body', async () => {
    const { plan, env, github } = await plannedWorld();
    await runBatchDeploy(plan, env);

    expect(github.createPull.mock.calls).toHaveLength(3);
    const pulls = github.createPull.mock.calls.map(([repo, params]) => ({ repo: repo.name, ...params }));
    const api = pulls.find((p) => p.title === 'deploy: api → production (dokploy)');
    const site = pulls.find((p) => p.title === 'deploy: site → staging (dokploy)');
    expect(api?.repo).toBe('mono');
    expect(api?.base).toBe('main');
    expect(api?.body).toBe(buildDeployPrBody(dokployTarget('api')));
    expect(site?.repo).toBe('solo');
    expect(site?.base).toBe('staging'); // gitBaseBranch, not the repo's default branch `trunk`
    expect(site?.body).toBe(buildDeployPrBody(dokployTarget('site', { branch: 'staging', gitBaseBranch: 'staging', vars: ['API_KEY'] })));
    // The keep.lock each PR carries is the base's own with this delivery folded in.
    const blobs = github.createBlob.mock.calls.map((c) => JSON.parse(String(c[1])) as KeepFile);
    const apiBlob = blobs.find((k) => k.variables.API_KEY[0].targets?.some((t) => t.target === 'api')) as KeepFile;
    expect(apiBlob.variables.API_KEY[0].targets?.map((t) => t.target)).toEqual(['api']);
    expect(apiBlob.variables.API_KEY[0].targets?.[0].deployed_value_hash).toBe(hashOf('API_KEY'));
    expect(apiBlob.variables.DB_URL[0].targets?.[0].deployed_value_hash).toBe(hashOf('DB_URL'));
  });

  test('every PR is read from the target\'s base, and the delivered result carries its URL', async () => {
    const { plan, env, github } = await plannedWorld();
    const result = await runBatchDeploy(plan, env);
    const keepReads = github.getFile.mock.calls.filter((c) => String(c[1]).endsWith('keep.lock')).map((c) => `${c[0].name}:${c[1]}@${c[2]}`);
    expect(keepReads).toContain('solo:keep.lock@staging');
    expect(keepReads).toContain('mono:backend/keep.lock@main');
    const urls = result.targets.map((t) => (t.kind === 'delivered' ? t.pr_url : null));
    expect(urls.every((u) => typeof u === 'string' && u.startsWith('https://github.com/'))).toBe(true);
    expect(result.targets.every((t) => t.kind === 'delivered' && t.recorded)).toBe(true);
  });

  test('a target whose keep.lock on the base already records these values is skipped NOTHING_TO_DEPLOY: no push, no record, no PR', async () => {
    const { plan, env, adapter, service, github } = await plannedWorld({ recordedOnMain: ['api', 'worker'] });
    const result = await runBatchDeploy(plan, env);

    expect(result.targets.map((t) => (t.kind === 'skipped' ? t.code : t.kind))).toEqual([SKIP_CODES.NOTHING_TO_DEPLOY, SKIP_CODES.NOTHING_TO_DEPLOY, 'delivered']);
    expect(adapter.deploy.mock.calls.map(([c]) => c.name)).toEqual(['site']);
    expect(service.pushSecrets.mock.calls.map((c) => c[0])).toEqual(['pB']);
    expect(github.createPull.mock.calls).toHaveLength(1);
  });

  test('a run that changes nothing is a success', async () => {
    const { plan, env } = await plannedWorld({ recordedOnMain: ['api', 'worker'] });
    const only = { ...plan, targets: plan.targets.filter((t) => t.config.name !== 'site') };
    const result = await runBatchDeploy(only, env);
    expect(batchSucceeded(result)).toBe(true);
  });

  test('failures are codes and one never blocks another', async () => {
    const adapter = fakeAdapter({
      deploy: (config) => (config.name === 'worker' ? { ok: false, steps: [{ label: 'application.saveEnvironment', status: 'fail', detail: 'x' }] } : { ok: true, steps: [] }),
    });
    const w = await plannedWorld({}, adapter);
    const result = await runBatchDeploy(w.plan, w.env);

    expect(result.targets.map((t) => t.kind)).toEqual(['delivered', 'failed', 'delivered']);
    const failed = result.targets[1];
    expect(failed).toMatchObject({ kind: 'failed', code: ERROR_CODES.DEPLOY_PUSH_FAILED, stage: 'push', values_pushed: false });
    expect(batchSucceeded(result)).toBe(false);
    // The failed target is not recorded and has no PR.
    const keep = JSON.parse(String(w.service.pushSecrets.mock.calls.find((c) => c[0] === 'pA')?.[1])) as KeepFile;
    expect(keep.variables.API_KEY[0].targets?.map((t) => t.target).toSorted()).toEqual(['api', 'legacy']);
    expect(w.github.createPull.mock.calls).toHaveLength(2);
  });

  test('a variable missing from the Capy branch is left out and named, like capy deploy; the rest are delivered', async () => {
    const w = await plannedWorld({}, fakeAdapter(), { vars: ['API_KEY'] }); // DB_URL is not in any branch
    const result = await runBatchDeploy(w.plan, w.env);
    expect(result.targets[0]).toMatchObject({ kind: 'delivered', missing_vars: ['DB_URL'] });
    const apiCall = w.adapter.deploy.mock.calls.find(([c]) => c.name === 'api');
    expect(apiCall?.[0].vars).toEqual(['API_KEY']);
    expect(Object.keys(apiCall?.[1].env ?? {})).toEqual(['API_KEY']);
    expect(w.adapter.deploy.mock.calls.map(([c]) => c.name).toSorted()).toEqual(['api', 'site', 'worker']);
    expect(renderBatchResult(result)).toContain('Not in Capy, left out: DB_URL');
  });

  test('a PR base that does not exist fails BEFORE the push: nothing reaches Dokploy', async () => {
    const w = world();
    const result = await deployTarget(w.env, async (p) => KEYS[p as 'pA'], { forTarget: () => undefined }, batchTarget('pA', dokployTarget('api', { gitBaseBranch: 'gone' })));
    expect(result).toMatchObject({ kind: 'failed', code: ERROR_CODES.KEEP_PR_BASE_UNRESOLVED, stage: 'github', values_pushed: false });
    expect(w.adapter.deploy.mock.calls).toHaveLength(0);
    expect(w.service.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('no gh: every target fails KEEP_PR_GH_UNAVAILABLE and nothing is pushed', async () => {
    const w = await plannedWorld();
    const result = await runBatchDeploy(w.plan, { ...w.env, github: () => undefined });
    expect(result.targets.every((t) => t.kind === 'failed' && t.code === ERROR_CODES.KEEP_PR_GH_UNAVAILABLE)).toBe(true);
    expect(w.adapter.deploy.mock.calls).toHaveLength(0);
  });

  test('a PR that fails after the push is `failed` with values_pushed, and the record was still made', async () => {
    const w = await plannedWorld({ soloFail: ['createPull'] });
    const result = await runBatchDeploy(w.plan, w.env);
    expect(result.targets[2]).toMatchObject({ kind: 'failed', code: ERROR_CODES.KEEP_PR_CREATE_FAILED, stage: 'pr', values_pushed: true });
    expect(w.service.pushSecrets.mock.calls.map((c) => c[0]).toSorted()).toEqual(['pA', 'pB']);
  });

  test('a record the server refuses is reported on the delivered target, and the PR is still opened', async () => {
    const w = await plannedWorld({}, fakeAdapter(), { failPush: { 'pA/production': ERROR_CODES.SERVICE_ERROR } });
    const result = await runBatchDeploy(w.plan, w.env);
    expect(result.targets[0]).toMatchObject({ kind: 'delivered', recorded: false, record_code: ERROR_CODES.SERVICE_ERROR });
    expect(result.targets[1]).toMatchObject({ kind: 'delivered', recorded: false });
    expect(result.targets[2]).toMatchObject({ kind: 'delivered', recorded: true });
    expect(w.github.createPull.mock.calls).toHaveLength(3);
  });

  test('the record uses the server\'s keep: a server with no keep for the branch is a coded record failure, never a keep rebuilt from anything local', async () => {
    const w = await plannedWorld({}, fakeAdapter(), { failLatest: { 'pB/staging': ERROR_CODES.SERVICE_ERROR } });
    const result = await runBatchDeploy(w.plan, w.env);
    expect(result.targets[2]).toMatchObject({ kind: 'delivered', recorded: false, record_code: ERROR_CODES.SERVICE_ERROR });
    expect(w.service.pushSecrets.mock.calls.map((c) => c[0])).toEqual(['pA']);
  });

  test('a key that cannot be opened fails every target with its code', async () => {
    const w = await plannedWorld();
    const broken = { ...w.env, openKeys: () => async () => { throw new CapyError('locked', ERROR_CODES.PERMISSION_DENIED); } };
    const result = await runBatchDeploy(w.plan, broken);
    expect(result.targets.every((t) => t.kind === 'failed' && t.code === ERROR_CODES.PERMISSION_DENIED && t.stage === 'values')).toBe(true);
  });
});

describe('one target, whole', () => {
  test('deployTarget needs no checkout: it pushes, records and opens the PR by itself', async () => {
    const w = world();
    const result = await deployTarget(w.env, async (p) => KEYS[p as 'pA'], { forTarget: () => undefined }, batchTarget('pA', dokployTarget('api')));
    expect(result).toMatchObject({ kind: 'delivered', recorded: true, base: 'main', target: { target: 'api', repo: 'Acme/mono', project: 'mono-backend' } });
    expect(w.adapter.deploy.mock.calls).toHaveLength(1);
    expect(w.service.pushSecrets.mock.calls).toHaveLength(1);
    expect(w.github.createPull.mock.calls).toHaveLength(1);
  });

  test('pushTarget alone changes nothing on the server and opens nothing', async () => {
    const w = world();
    const pushed = await pushTarget(w.env, async (p) => KEYS[p as 'pA'], { forTarget: () => undefined }, batchTarget('pA', dokployTarget('api')));
    expect(pushed.result.kind).toBe('pushed');
    expect(w.service.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.github.createPull.mock.calls).toHaveLength(0);
  });
});

describe('many targets: concurrency, order, progress, stop', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => batchTarget('pA', dokployTarget(`t${String(i).padStart(2, '0')}`, { vars: ['API_KEY'] })));
  const planOf = (targets: ReturnType<typeof many>): BatchPlan => ({ targets, skipped: [], read_failed: [] });

  /** An adapter that takes `delayOf(name)` ms and logs `+name` / `-name`. */
  const gauged = (delayOf: (name: string) => number) => {
    const log = mock((_e: string) => undefined);
    const adapter = fakeAdapter({
      deploy: async (config) => {
        log(`+${config.name}`);
        await sleepMs(delayOf(config.name));
        log(`-${config.name}`);
        return { ok: true, steps: [] };
      },
    });
    return { adapter, events: () => log.mock.calls.map((c) => c[0]) };
  };

  test('the bound is a named constant, 4, and no more than 4 targets are pushed at once', async () => {
    expect(BATCH_DEPLOY_CONCURRENCY).toBe(4);
    const { adapter, events } = gauged(() => 8);
    const w = world({}, adapter);
    const result = await runBatchDeploy(planOf(many(10)), w.env);
    expect(result.targets).toHaveLength(10);
    expect(maxOpen(events())).toBe(BATCH_DEPLOY_CONCURRENCY);
    // Ten targets of one project and branch: still ONE unlock and ONE record write.
    expect(w.openKeys.mock.calls).toHaveLength(1);
    expect(w.service.pushSecrets.mock.calls).toHaveLength(1);
  });

  test('results come back in INPUT order when targets finish in a shuffled order', async () => {
    const targets = many(8);
    const { adapter, events } = gauged((name) => 5 + 3 * (targets.length - targets.findIndex((t) => t.config.name === name)));
    const w = world({}, adapter);
    const result = await runBatchDeploy(planOf(targets), w.env);
    const finishOrder = events().filter((e) => e.startsWith('-')).map((e) => e.slice(1));
    expect(finishOrder).not.toEqual(targets.map((t) => t.config.name)); // completion really was shuffled
    expect(result.targets.map((t) => t.target.target)).toEqual(targets.map((t) => t.config.name));
  });

  test('progress: pushing counts finished targets, then recording, then PRs', async () => {
    const onProgress = mock((_p: BatchProgress) => undefined);
    const w = world();
    await runBatchDeploy(planOf(many(5)), w.env, { onProgress });
    const events = onProgress.mock.calls.map((c) => c[0]);
    const pushing = events.filter((e) => e.phase === 'pushing');
    expect(pushing.map((e) => e.done)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pushing.every((e) => e.total === 5 && e.inFlight <= BATCH_DEPLOY_CONCURRENCY)).toBe(true);
    const phases = events.map((e) => e.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    expect(phases).toEqual(['pushing', 'recording', 'prs']);
    expect(events.filter((e) => e.phase === 'prs').at(-1)).toMatchObject({ done: 5, total: 5, inFlight: 0 });
  });

  test('a stop of the pushes starts no further target, waits for those in flight, and still records and opens their PRs', async () => {
    const stop = new AbortController();
    const adapter = fakeAdapter({
      deploy: async (config) => {
        if (config.name === 't00') stop.abort();
        await sleepMs(10);
        return { ok: true, steps: [] };
      },
    });
    const onStopping = mock((_s: unknown) => undefined);
    const w = world({}, adapter);
    const result = await runBatchDeploy(planOf(many(10)), w.env, { stopPushes: stop.signal, onStopping });

    expect(result.targets.map((t) => t.kind)).toEqual([...Array(4).fill('delivered'), ...Array(6).fill('cancelled')]);
    expect(result.targets.slice(4).every((t) => t.kind === 'cancelled' && t.stage === 'push' && !t.values_pushed)).toBe(true);
    expect(adapter.deploy.mock.calls).toHaveLength(4);
    expect(w.service.pushSecrets.mock.calls).toHaveLength(1);
    expect(w.github.createPull.mock.calls).toHaveLength(4);
    expect(onStopping.mock.calls[0][0]).toEqual({ phase: 'pushing', inFlight: 4 });
    expect(batchSucceeded(result)).toBe(false);
  });

  test('a stop before the run starts opens no key, pushes nothing and reports everything cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    const w = world();
    const result = await runBatchDeploy(planOf(many(3)), w.env, { stopPushes: stop.signal });
    expect(result.targets.every((t) => t.kind === 'cancelled' && t.stage === 'push')).toBe(true);
    expect(w.openKeys.mock.calls).toHaveLength(0);
    expect(w.adapter.deploy.mock.calls).toHaveLength(0);
  });

  test('a stop of the PRs opens none, but what was pushed stays recorded and is reported as cancelled with its values already in Dokploy', async () => {
    const stop = new AbortController();
    stop.abort();
    const w = world();
    const result = await runBatchDeploy(planOf(many(3)), w.env, { stopPrs: stop.signal });
    expect(result.targets.every((t) => t.kind === 'cancelled' && t.stage === 'pr' && t.values_pushed)).toBe(true);
    expect(w.adapter.deploy.mock.calls).toHaveLength(3);
    expect(w.service.pushSecrets.mock.calls).toHaveLength(1);
    expect(w.github.createPull.mock.calls).toHaveLength(0);
  });

  test('two targets in one repo are two PRs (one Dokploy service is one target)', async () => {
    const w = world();
    await runBatchDeploy(planOf(many(2)), w.env);
    expect(w.github.createPull.mock.calls.map(([r]) => r.name)).toEqual(['mono', 'mono']);
  });
});

describe('no secret ever appears in anything the run reports or writes', () => {
  test('result, text, JSON, the GitHub writes and the server record carry no value', async () => {
    const w = world();
    const plan = await planBatchDeploy(w.github, request, LINKS);
    const result = await runBatchDeploy(plan, w.env);
    const everything = [
      JSON.stringify(result),
      renderBatchResult(result),
      JSON.stringify(resultJsonOf(result)),
      everythingSentTo(w.github.createBlob, w.github.createTree, w.github.createCommit, w.github.createRef, w.github.createPull),
      // The server record carries the keep and the server's own (encrypted) blob.
      everythingSentTo(w.service.pushSecrets),
    ].join('\n');
    expect(Object.values(VALUES).filter((v) => everything.includes(v))).toEqual([]);
  });

  test('a failure carries a code, never a value', async () => {
    const adapter = fakeAdapter({ deploy: () => ({ ok: false, steps: [{ label: 'x', status: 'fail', detail: `rejected ${VALUES.API_KEY}` }] }) });
    const w = world({}, adapter);
    const plan = await planBatchDeploy(w.github, request, LINKS);
    const result = await runBatchDeploy(plan, w.env);
    const everything = JSON.stringify(result) + renderBatchResult(result) + JSON.stringify(resultJsonOf(result));
    expect(everything.includes(VALUES.API_KEY)).toBe(false);
    expect(everything).toContain(ERROR_CODES.DEPLOY_PUSH_FAILED);
  });
});
