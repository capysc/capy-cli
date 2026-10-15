/**
 * `capy secrets deploy` and target conflicts (CAP-717) + the picked-only delivery (CAP-715).
 *
 * The engine is the real one (`runSecretsDeploy` → `runBatchDeploy`); the service, GitHub and the Dokploy
 * adapter are the injected fakes of tests/helpers/batchDeployWorld.ts, with an adapter that says it reads the
 * platform's live values (`readsLiveValues`) and reports one conflict for `api`: the service's API_KEY was changed
 * outside Capy. The properties:
 *   - before anything is written every target is looked at (reading only); a conflict stops the whole run:
 *     exit 3, the payload on stdout, no push, no record, no PR, no value in the output;
 *   - a rerun with `--resolve API_KEY@api=mine|theirs --conflict <id>` delivers, or skips that variable and
 *     records nothing for it; a moved state is STALE; a partial answer gets the names still open;
 *   - only the PICKED variables are delivered, and the adapter is told to leave every other managed line alone.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import type { DeployContext, DeployResult, TargetConfig } from '../../src/deploy/adapter';
import { runSecretsDeploy, type SecretsDeployIo, type SecretsDeployOpts } from '../../src/commands/secretsDeployCommand';
import { SKIP_CODES } from '../../src/deploy/batchDeploy';
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
} from '../helpers/batchDeployWorld';

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
  return { exitCode: exits.length > 0 ? (exits[exits.length - 1][0] as number | undefined) : undefined, returned: outcome.returned, stdout, stderr };
}

/** What the service holds for `api`'s API_KEY now (fingerprint only), by the script: someone edited it outside Capy. */
const LIVE = 'deadbeefdeadbeef';
const conflictFor = (theirs: string = LIVE) => ({ kind: 'target' as const, name: NAME, target: 'api', pinned: null, yours: hashOf(NAME), theirs });

/**
 * A Dokploy adapter that compares live values: `api`'s API_KEY is in conflict until an answer is given, and an answer
 * counts only for the live value (and delivered value) it was made against, as `planTargetDelivery` does.
 * `liveAtWrite`: what the service holds when the delivery pass reads it (the comparison pass sees `theirs`).
 */
function liveAdapter(theirs: string = LIVE, liveAtWrite: string = theirs) {
  const base = fakeAdapter({
    deploy: (config: TargetConfig, ctx: DeployContext): DeployResult => {
      if (config.name !== 'api' || ctx.targetCheck === undefined) return { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }] };
      const now = ctx.dryRun ? theirs : liveAtWrite;
      const seen = ctx.targetCheck.resolutions[NAME];
      const answer = seen !== undefined && seen.theirs === now && seen.yours === hashOf(NAME) ? seen.choice : undefined;
      if (ctx.dryRun) return { ok: true, steps: [], conflicts: [conflictFor(now)] };
      if (answer === undefined) return { ok: false, steps: [{ label: 'application.saveEnvironment', status: 'fail', code: 'SECRETS_CONFLICT' }], conflicts: [conflictFor(now)] };
      return answer === 'theirs'
        ? { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }], skipped: [NAME] }
        : { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }] };
    },
  });
  return Object.assign(base, { readsLiveValues: true });
}

function rig(adapter = liveAdapter(), serviceOpts: Parameters<typeof fakeService>[0] = {}) {
  const service = fakeService(serviceOpts);
  const github = fakeGithub(standardRepos());
  const { env, openKeys } = makeEnv(service, github, adapter);
  const io: SecretsDeployIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
      getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }),
    },
    env,
  };
  return { io, service, github, adapter, openKeys };
}

const json = (c: Captured) => JSON.parse(c.stdout);
const run = (r: ReturnType<typeof rig>, opts: SecretsDeployOpts) => capture(() => runSecretsDeploy([NAME], { json: true, allRows: true, ...opts }, r.io));

/** The plan_id and conflict_id a preview reports. */
async function preview(r: ReturnType<typeof rig>) {
  const out = await run(r, { dryRun: true });
  expect(out.exitCode).toBe(3);
  return { out, planId: json(out).plan_id as string, conflictId: json(out).conflict_id as string };
}

const nothingWritten = (r: ReturnType<typeof rig>) => {
  expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  expect(r.github.createBlob.mock.calls).toHaveLength(0);
  expect(r.github.createPull.mock.calls).toHaveLength(0);
  expect(r.adapter.deploy.mock.calls.every(([, ctx]) => ctx.dryRun === true || ctx.targetCheck?.resolutions[NAME] === undefined)).toBe(true);
};

describe('capy secrets deploy: target conflicts', () => {
  test('--dry-run reports the conflict and the plan, reading only', async () => {
    const r = rig();
    const { out } = await preview(r);
    const body = json(out);
    expect(body).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true });
    expect(body.conflict_id).toMatch(/^c_[0-9a-f]{12}$/);
    expect(body.conflicts).toEqual([conflictFor()]);
    expect(body.plan).toBeDefined();
    nothingWritten(r);
    expect(everythingSentTo({ mock: { calls: [[out.stdout, out.stderr]] } })).not.toContain(VALUES.API_KEY);
  });

  test('a real run stops BEFORE anything is written when a conflict is unanswered: exit 3, the same id, no push, no record, no PR', async () => {
    const r = rig();
    const { planId, conflictId } = await preview(r);
    const out = await run(r, { confirm: planId });
    expect(out.exitCode).toBe(3);
    expect(json(out)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: conflictId });
    expect(json(out).conflicts).toEqual([conflictFor()]);
    nothingWritten(r);
    // No value anywhere in what was printed.
    Object.values(VALUES).forEach((v) => expect(`${out.stdout}${out.stderr}`).not.toContain(v));
  });

  test('mine: every target is delivered, with the answer handed to the adapter by bare name', async () => {
    const r = rig();
    const { planId, conflictId } = await preview(r);
    const out = await run(r, { confirm: planId, conflictFlags: { resolve: [`${NAME}@api=mine`], conflict: conflictId } });
    expect(out.exitCode).toBeUndefined();
    expect(json(out).ok).toBe(true);
    const api = r.adapter.deploy.mock.calls.find(([c, ctx]) => c.name === 'api' && !ctx.dryRun);
    expect(api?.[1].targetCheck?.resolutions).toEqual({ [NAME]: { choice: 'mine', theirs: LIVE, yours: hashOf(NAME) } });
    expect(r.service.pushSecrets.mock.calls.length).toBeGreaterThan(0);
    expect(r.github.createPull.mock.calls).toHaveLength(3);
  });

  test('theirs: the variable is skipped, not recorded as delivered, and the target reports KEPT_ON_PLATFORM (no PR for it)', async () => {
    const r = rig();
    const { planId, conflictId } = await preview(r);
    const out = await run(r, { confirm: planId, conflictFlags: { resolve: [`${NAME}@api=theirs`], conflict: conflictId } });
    expect(json(out).ok).toBe(true);
    expect(json(out).skipped).toContainEqual(expect.objectContaining({ target: 'api', code: SKIP_CODES.KEPT_ON_PLATFORM }));
    expect(json(out).delivered.map((d: { target: string }) => d.target).toSorted()).toEqual(['site', 'worker']);
    // The record on the Capy server has no `api` delivery for API_KEY.
    const recorded = r.service.pushSecrets.mock.calls.map((c) => JSON.parse(String(c[1])) as { variables: Record<string, Array<{ targets?: Array<{ target: string }> }>> });
    recorded.forEach((keep) => expect(keep.variables.API_KEY[0].targets?.map((t) => t.target) ?? []).not.toContain('api'));
  });

  test('the service changed again after the preview: STALE, the fresh conflict, a new id, nothing written', async () => {
    const first = rig();
    const { planId, conflictId } = await preview(first);
    const second = rig(liveAdapter('cafecafecafecafe'));
    const out = await run(second, { confirm: planId, conflictFlags: { resolve: [`${NAME}@api=mine`], conflict: conflictId } });
    expect(out.exitCode).toBe(3);
    expect(json(out)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT_STALE' });
    expect(json(out).conflict_id).not.toBe(conflictId);
    expect(json(out).conflicts).toEqual([conflictFor('cafecafecafecafe')]);
    nothingWritten(second);
  });

  test('the service moved between the comparison pass and the delivery pass: the answer does not apply, api fails with SECRETS_CONFLICT and nothing is recorded for it', async () => {
    const r = rig(liveAdapter(LIVE, 'cafecafecafecafe'));
    const { planId, conflictId } = await preview(r);
    const out = await run(r, { confirm: planId, conflictFlags: { resolve: [`${NAME}@api=mine`], conflict: conflictId } });
    const body = json(out);
    expect(body.failed).toContainEqual(expect.objectContaining({ target: 'api', code: 'SECRETS_CONFLICT' }));
    expect(body.delivered.map((d: { target: string }) => d.target)).not.toContain('api');
    const recorded = r.service.pushSecrets.mock.calls.map((c) => JSON.parse(String(c[1])) as { variables: Record<string, Array<{ targets?: Array<{ target: string }> }>> });
    recorded.forEach((keep) => expect(keep.variables.API_KEY[0].targets?.map((t) => t.target) ?? []).not.toContain('api'));
  });

  test('a conflict id without an answer for the name is a partial answer: the names still open, under the same id', async () => {
    const r = rig();
    const { planId, conflictId } = await preview(r);
    const out = await run(r, { confirm: planId, conflictFlags: { resolve: [`OTHER@api=mine`], conflict: conflictId } });
    expect(out.exitCode).toBe(3);
    expect(json(out)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', conflict_id: conflictId });
    expect(json(out).conflicts).toEqual([conflictFor()]);
    nothingWritten(r);
  });

  test('a platform without live values (no readsLiveValues) is untouched by all of this: no extra pass, no questions', async () => {
    const plain = fakeAdapter();
    const r = rig(plain as never);
    const dry = await run(r, { dryRun: true });
    expect(json(dry).ok).toBe(true);
    const planId = json(dry).plan_id as string;
    const real = await run(r, { confirm: planId });
    expect(json(real).ok).toBe(true);
    expect(plain.deploy.mock.calls.every(([, ctx]) => ctx.dryRun === false && ctx.targetCheck === undefined)).toBe(true);
  });
});
