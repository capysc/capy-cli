/**
 * `capy secrets deploy NAME...` (agent mode, CAP-704): selection, the plan and `plan_id`,
 * `--confirm`, the result shape, a dry run that changes nothing, and no value ever in the
 * output. The service, GitHub, Dokploy and the key unlock are all injected: no network, no `gh`.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { ERROR_CODES } from '../../src/types/index';
import { deployPlanIdOf, runSecretsDeploy, type SecretsDeployIo, type SecretsDeployOpts } from '../../src/commands/secretsDeployCommand';
import { rowIdOf } from '../../src/commands/secretsRowId';
import { EXIT_NEEDS_INPUT } from '../../src/ui/interactive';
import { DRY_RUN_COMMANDS } from '../../src/core/cliHelpDoc';
import {
  LINKS,
  NAME,
  VALUES,
  everythingSentTo,
  fakeAdapter,
  fakeGithub,
  fakeService,
  hashOf,
  indexRows,
  makeEnv,
  standardRepos,
  type AdapterScript,
} from '../helpers/batchDeployWorld';
import type { SecretIndexRow } from '../../src/service/serviceClient';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode: number | undefined;
  readonly returned: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `fn`, capturing stdout/stderr and the exit code; `process.exit` never really exits. */
async function capture(fn: () => Promise<number>): Promise<Captured> {
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
  return {
    exitCode: exits.length > 0 ? (exits[exits.length - 1][0] as number | undefined) : undefined,
    returned: outcome.returned,
    stdout,
    stderr,
  };
}

function rig(over: { rows?: SecretIndexRow[]; adapter?: AdapterScript; control?: SecretsDeployIo['control'] } = {}) {
  const service = fakeService();
  const github = fakeGithub(standardRepos());
  const adapter = fakeAdapter(over.adapter);
  const { env, openKeys } = makeEnv(service, github, adapter);
  const rows = over.rows ?? indexRows();
  const io: SecretsDeployIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows, skipped: [] }),
      getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }),
    },
    env,
    control: over.control,
  };
  return { io, service, github, adapter, openKeys };
}

const noWrites = (r: ReturnType<typeof rig>) => {
  expect(r.openKeys.mock.calls).toHaveLength(0);
  expect(r.service.getDecryptData.mock.calls).toHaveLength(0);
  expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  expect(r.adapter.preflight.mock.calls).toHaveLength(0);
  expect(r.adapter.deploy.mock.calls).toHaveLength(0);
  expect(r.github.createBlob.mock.calls).toHaveLength(0);
  expect(r.github.createRef.mock.calls).toHaveLength(0);
  expect(r.github.createPull.mock.calls).toHaveLength(0);
};

const json = (c: Captured) => JSON.parse(c.stdout);
const run = (r: ReturnType<typeof rig>, opts: SecretsDeployOpts, names: readonly string[] = [NAME]) =>
  capture(() => runSecretsDeploy(names, { json: true, ...opts }, r.io));

/** Two rows of NAME: the usual value, and a different one on mono-backend/staging. */
const TWO_ROWS: SecretIndexRow[] = (() => {
  const [first] = indexRows();
  const other = { ...first, value_hash: 'f'.repeat(16), locations: [first.locations[1]] };
  return [{ ...first, locations: [first.locations[0], first.locations[2]] }, other];
})();
const rowIds = (rows: readonly SecretIndexRow[]) => rows.map((r) => rowIdOf(r.name, r.value_hash));

describe('selecting rows', () => {
  test('several rows and neither --row nor --all-rows: SECRET_AMBIGUOUS, exit 3, candidates in `unanswered`, nothing done', async () => {
    const r = rig({ rows: TWO_ROWS });
    const out = await run(r, {});
    expect(out.exitCode).toBe(EXIT_NEEDS_INPUT);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, code: ERROR_CODES.SECRET_AMBIGUOUS });
    expect(body.unanswered[0].flag).toBe('--row');
    expect(body.unanswered[0].candidates.map((c: { row_id: string }) => c.row_id).toSorted()).toEqual([...rowIds(TWO_ROWS)].toSorted());
    noWrites(r);
  });

  test('--all-rows takes every row; --row takes one; an unknown --row is SECRET_NOT_FOUND', async () => {
    const all = await run(rig({ rows: TWO_ROWS }), { allRows: true, dryRun: true });
    expect(json(all).targets.map((t: { target: string }) => t.target)).toEqual(['api', 'worker', 'site']);

    const [mono] = rowIds(TWO_ROWS);
    const one = await run(rig({ rows: TWO_ROWS }), { row: [mono], dryRun: true });
    expect(json(one).ok).toBe(true);

    const unknown = await run(rig({ rows: TWO_ROWS }), { row: ['000000000000'] });
    expect(json(unknown)).toMatchObject({ ok: false, code: ERROR_CODES.SECRET_NOT_FOUND });
  });

  test('--row and --all-rows together are refused; an unknown name is SECRET_NOT_FOUND; a bad name is INVALID_FORMAT', async () => {
    expect(json(await run(rig(), { row: ['x'], allRows: true })).code).toBe(ERROR_CODES.INVALID_FORMAT);
    expect(json(await run(rig(), {}, ['NO_SUCH_NAME'])).code).toBe(ERROR_CODES.SECRET_NOT_FOUND);
    expect(json(await run(rig(), {}, ['not a name'])).code).toBe(ERROR_CODES.INVALID_FORMAT);
  });

  test('--exclude drops a location; naming one that is not selected is refused', async () => {
    const r = rig();
    const out = await run(r, { dryRun: true, exclude: ['solo-server:staging'] });
    expect(json(out).targets.map((t: { target: string }) => t.target)).toEqual(['api', 'worker']);
    expect(json(await run(rig(), { exclude: ['nope:nothing'] })).code).toBe(ERROR_CODES.INVALID_FORMAT);
  });
});

describe('--dry-run: the plan, and nothing changes', () => {
  test('prints a JSON plan with a plan_id, the targets with their var counts, and the skips with codes', async () => {
    const r = rig();
    const out = await run(r, { dryRun: true });
    expect(out.returned).toBe(0);
    const body = json(out);
    expect(body).toMatchObject({ ok: true, dry_run: true, names: [NAME] });
    expect(body.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.targets).toEqual([
      { project: 'mono-backend', branch: 'production', target: 'api', provider: 'dokploy', repo: 'Acme/mono', path: 'backend', base: 'main', vars: 2 },
      { project: 'mono-backend', branch: 'production', target: 'worker', provider: 'dokploy', repo: 'Acme/mono', path: 'backend', base: 'main', vars: 1 },
      { project: 'solo-server', branch: 'staging', target: 'site', provider: 'dokploy', repo: 'Acme/solo', path: '.', base: 'staging', vars: 1 },
    ]);
    expect(body.skipped.map((s: { code: string }) => s.code).toSorted()).toEqual(
      ['NOT_CI_MODE', 'NOT_DOKPLOY', 'NO_TARGET', 'TARGET_NOT_ON_DEFAULT_BRANCH'].toSorted(),
    );
  });

  test('changes nothing: no unlock, no decrypt, no Dokploy call, no server write, no GitHub write', async () => {
    const r = rig();
    await run(r, { dryRun: true });
    noWrites(r);
  });

  test('stdout is pure JSON and stderr says nothing', async () => {
    const out = await run(rig(), { dryRun: true });
    expect(() => JSON.parse(out.stdout)).not.toThrow();
    expect(out.stderr).toBe('');
  });

  test('plan_id is stable for the same selection and moves when the plan moves', async () => {
    const a = json(await run(rig(), { dryRun: true })).plan_id;
    const b = json(await run(rig(), { dryRun: true })).plan_id;
    const c = json(await run(rig(), { dryRun: true, exclude: ['solo-server:staging'] })).plan_id;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  test('the plan_id is order-free and carries no value hash', () => {
    const plan = { targets: [], skipped: [], read_failed: [] };
    const one = deployPlanIdOf(['A', 'B'], [{ row_id: 'r1', project: 'p', branch: 'b' }, { row_id: 'r2', project: 'q', branch: 'b' }], plan);
    const two = deployPlanIdOf(['B', 'A'], [{ row_id: 'r2', project: 'q', branch: 'b' }, { row_id: 'r1', project: 'p', branch: 'b' }], plan);
    expect(one).toBe(two);
    expect(one.includes(hashOf('API_KEY'))).toBe(false);
  });

  test('without --json it prints the plan as text', async () => {
    const r = rig();
    const out = await capture(() => runSecretsDeploy([NAME], { dryRun: true }, r.io));
    expect(out.stdout).toMatch(/^Plan [0-9a-f]{16}/);
    expect(out.stdout).toContain('mono-backend · production');
    expect(out.stdout).toContain('skipped NOT_DOKPLOY');
    noWrites(r);
  });

  test('the command is listed as one that honours --dry-run', () => {
    expect(DRY_RUN_COMMANDS.has('secrets deploy')).toBe(true);
  });
});

describe('a real run needs --confirm <plan_id>', () => {
  test('without it: PLAN_CONFIRM_REQUIRED, exit 3, the plan and the id to confirm; nothing done', async () => {
    const r = rig();
    const planId = json(await run(rig(), { dryRun: true })).plan_id;
    const out = await run(r, {});
    expect(out.exitCode).toBe(EXIT_NEEDS_INPUT);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, code: ERROR_CODES.PLAN_CONFIRM_REQUIRED, plan_id: planId });
    expect(body.unanswered).toEqual([{ id: 'confirm', flag: '--confirm', value: planId }]);
    expect(body.plan.targets).toHaveLength(3);
    noWrites(r);
  });

  test('a plan that moved: PLAN_CHANGED, exit 1, nothing done', async () => {
    const r = rig();
    const out = await run(r, { confirm: '0123456789abcdef' });
    expect(out.exitCode).toBe(1);
    expect(json(out)).toMatchObject({ ok: false, code: ERROR_CODES.PLAN_CHANGED });
    noWrites(r);
  });

  test('nothing to deploy: DEPLOY_NOTHING_TO_DEPLOY with the plan (the location has no target), nothing done', async () => {
    const r = rig();
    const out = await run(r, { exclude: ['mono-backend:production', 'solo-server:staging'] });
    expect(out.exitCode).toBe(1);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, code: ERROR_CODES.DEPLOY_NOTHING_TO_DEPLOY });
    expect(body.plan.skipped).toEqual([{ project: 'mono-backend', branch: 'staging', target: null, provider: null, code: 'NO_TARGET' }]);
    noWrites(r);
  });

  test('the dry-run -> confirm round trip deploys exactly the planned targets and reports their PRs', async () => {
    const planId = json(await run(rig(), { dryRun: true })).plan_id;
    const r = rig();
    const out = await run(r, { confirm: planId });

    expect(out.returned).toBe(0);
    expect(out.stderr).toBe('');
    const body = json(out);
    expect(body).toMatchObject({ ok: true, plan_id: planId, names: [NAME], failed: [], cancelled: [] });
    expect(body.delivered.map((d: { target: string; base: string }) => `${d.target}@${d.base}`)).toEqual(['api@main', 'worker@main', 'site@staging']);
    expect(body.delivered.every((d: { pr_url: string; recorded: boolean }) => d.pr_url.startsWith('https://github.com/') && d.recorded)).toBe(true);
    expect(r.adapter.deploy.mock.calls.map(([c]) => c.name)).toEqual(['api', 'worker', 'site']);
    expect(r.github.createPull.mock.calls).toHaveLength(3);
    expect(r.openKeys.mock.calls).toHaveLength(1);
  });

  test('a target that fails: ok false, DEPLOY_BATCH_PARTIAL, exit status 1, the failure is a code, the others are delivered', async () => {
    const planId = json(await run(rig(), { dryRun: true })).plan_id;
    const r = rig({
      adapter: { preflight: (config) => (config.name === 'worker' ? { ok: false, code: ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF, reason: 'r' } : { ok: true }) },
    });
    const out = await run(r, { confirm: planId });
    expect(out.returned).toBe(1);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, code: ERROR_CODES.DEPLOY_BATCH_PARTIAL });
    expect(body.failed).toEqual([
      { project: 'mono-backend', branch: 'production', target: 'worker', provider: 'dokploy', repo: 'Acme/mono', path: 'backend', code: ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF, stage: 'preflight', values_pushed: false },
    ]);
    expect(body.delivered.map((d: { target: string }) => d.target)).toEqual(['api', 'site']);
  });

  test('a stop (Ctrl+C) before the pushes: nothing runs, everything is reported cancelled, exit status 1', async () => {
    const planId = json(await run(rig(), { dryRun: true })).plan_id;
    const stop = new AbortController();
    stop.abort();
    const r = rig({ control: { pushes: stop.signal } });
    const out = await run(r, { confirm: planId });
    expect(out.returned).toBe(1);
    const body = json(out);
    expect(body.code).toBe(ERROR_CODES.DEPLOY_BATCH_PARTIAL);
    expect(body.cancelled.map((c: { target: string; stage: string }) => `${c.target}:${c.stage}`)).toEqual(['api:push', 'worker:push', 'site:push']);
    expect(r.adapter.deploy.mock.calls).toHaveLength(0);
  });

  test('without --json: the confirmation reads like the multi-edit\'s, and a skipped target is listed', async () => {
    const planId = json(await run(rig(), { dryRun: true })).plan_id;
    const r = rig();
    const out = await capture(() => runSecretsDeploy([NAME], { confirm: planId }, r.io));
    expect(out.stdout).toContain('✓ 3 targets deployed.');
    expect(out.stdout).toContain('Review and merge to deploy:');
    expect(out.stdout).toContain('Acme/mono · api');
    expect(out.stdout).toContain('Skipped');
    expect(out.stdout).toContain('The new values are already in Dokploy.');
  });
});

describe('no value in any output', () => {
  test('refusals, plans and results never carry a value, a value hash, or a plan built from one', async () => {
    const planRun = await run(rig(), { dryRun: true });
    const planId = json(planRun).plan_id;
    const r = rig();
    const real = await run(r, { confirm: planId });
    const noConfirm = await run(rig(), {});
    const everything = [planRun.stdout, planRun.stderr, real.stdout, real.stderr, noConfirm.stdout, noConfirm.stderr].join('\n');
    const leaks = [...Object.values(VALUES), ...Object.keys(VALUES).map(hashOf)].filter((v) => everything.includes(v));
    expect(leaks).toEqual([]);
    // What was written elsewhere carries no plaintext either.
    const written = everythingSentTo(r.github.createBlob, r.github.createCommit, r.github.createPull, r.service.pushSecrets);
    expect(Object.values(VALUES).filter((v) => written.includes(v))).toEqual([]);
  });
});
