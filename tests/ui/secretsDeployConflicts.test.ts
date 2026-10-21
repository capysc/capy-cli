/**
 * The `capy secrets` batch deploy and Dokploy target conflicts (CAP-714), with the real actions and engine over the
 * fakes of tests/helpers/batchDeployWorld.ts. The service's `api` target reports one conflict: its API_KEY was changed
 * outside Capy (`liveAdapter`, the same script tests/commands/secretsDeployConflicts.test.ts uses for the CLI).
 *
 *   - the conflict is found BEFORE anything is delivered and nothing is written until it is decided;
 *   - local delivers Capy's value, remote delivers nothing for that variable and records nothing for it;
 *   - a decision made against a live value that has since changed is not applied: the conflict comes back;
 *   - cancelling the conflicts step leaves everything as it was.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { createDeployActionsWith, decideFrom } from '../../src/commands/secretsDeployActions';
import { runSecretsScreen } from '../../src/ui/secretsScreenDriver';
import { applyDeployFinished, renderDeploy, stepDeploy, startDeploy, type DeployFlow } from '../../src/ui/secretsDeployFlow';
import { SKIP_CODES, type BatchPlan } from '../../src/deploy/batchDeploy';
import type { DeployContext, DeployResult, TargetConfig } from '../../src/deploy/adapter';
import { conflictRefusalFor, type TargetConflict } from '../../src/sync/conflicts';
import { CANCELLED_NOTHING } from '../../src/commands/secretsSetText';
import { ERROR_CODES } from '../../src/types/index';
import { LINKS, NAME, VALUES, everythingSentTo, fakeAdapter, fakeGithub, fakeService, hashOf, indexRows, makeEnv, standardRepos } from '../helpers/batchDeployWorld';

const ESC = '\x1b';
const CTRL_D = '\x04';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const [row] = indexRows();
const LIVE = 'deadbeefdeadbeef';
const MOVED_AGAIN = 'cafecafecafecafe';

const conflictFor = (remote: string = LIVE): TargetConflict => ({ name: NAME, target: 'api', pinned: null, local: hashOf(NAME), remote });
const decision = (choice: 'local' | 'remote', remote: string = LIVE) => ({ 'API_KEY@api': { choice, remote, local: hashOf(NAME) } });

/** What a Dokploy service that compares live values does: `api`'s API_KEY is in conflict until answered, and an answer counts only for the live value it was made against. */
const liveScript =
  (remote: string, liveAtWrite: string = remote) =>
  (config: TargetConfig, ctx: DeployContext): DeployResult => {
    if (config.name !== 'api' || ctx.targetCheck === undefined) return { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }] };
    const now = ctx.dryRun ? remote : liveAtWrite;
    const seen = ctx.targetCheck.resolutions[NAME];
    const answer = seen !== undefined && seen.remote === now && seen.local === hashOf(NAME) ? seen.choice : undefined;
    if (ctx.dryRun) return { ok: true, steps: [], conflicts: [conflictFor(now)] };
    if (answer === undefined) return { ok: false, steps: [{ label: 'application.saveEnvironment', status: 'fail', code: 'SECRETS_CONFLICT' }], conflicts: [conflictFor(now)] };
    return answer === 'remote'
      ? { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }], skipped: [NAME] }
      : { ok: true, steps: [{ label: 'application.saveEnvironment', status: 'ok' }] };
  };

const liveAdapter = (remote: string = LIVE, liveAtWrite: string = remote) => Object.assign(fakeAdapter({ deploy: liveScript(remote, liveAtWrite) }), { readsLiveValues: true });

/** A service whose `api` value is LIVE for the first comparison and MOVED_AGAIN from the second on: someone changed it while the person was deciding. */
function movingAdapter() {
  const adapter: ReturnType<typeof liveAdapter> = Object.assign(
    fakeAdapter({
      deploy: (config: TargetConfig, ctx: DeployContext): DeployResult => {
        // The call being answered is already in the log.
        const comparisons = adapter.deploy.mock.calls.filter(([c, x]) => c.name === 'api' && x.dryRun === true).length;
        return liveScript(comparisons > 1 ? MOVED_AGAIN : LIVE)(config, ctx);
      },
    }),
    { readsLiveValues: true },
  );
  return adapter;
}

function rig(adapter = liveAdapter()) {
  const service = fakeService();
  const github = fakeGithub(standardRepos());
  const { env } = makeEnv(service, github, adapter);
  const actions = createDeployActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', env, false);
  return { service, github, adapter, actions };
}

async function planned(r: ReturnType<typeof rig>): Promise<BatchPlan> {
  const loaded = await r.actions.loadPlan(row);
  if (!loaded.ok) throw new Error('no plan');
  return loaded.plan;
}

/** Nothing was delivered: no delivery call reached the adapter, no record, no PR. */
const nothingWritten = (r: ReturnType<typeof rig>): void => {
  expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  expect(r.github.createBlob.mock.calls).toHaveLength(0);
  expect(r.github.createPull.mock.calls).toHaveLength(0);
  expect(r.adapter.deploy.mock.calls.every(([, ctx]) => ctx.dryRun === true)).toBe(true);
};

describe('the real actions: found before anything is delivered', () => {
  test('an undecided conflict comes back as a conflict; nothing is delivered, recorded or opened', async () => {
    const r = rig();
    const finished = await r.actions.run(await planned(r));
    expect(finished).toEqual({ ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: [conflictFor()] });
    nothingWritten(r);
    // Fingerprints and names only.
    Object.values(VALUES).forEach((v) => expect(JSON.stringify(finished)).not.toContain(v));
  });

  test('local: every target is delivered, the answer handed to the adapter bound to the live value it was made against', async () => {
    const r = rig();
    const finished = await r.actions.run(await planned(r), undefined, decision('local'));
    expect(finished.ok).toBe(true);
    const api = r.adapter.deploy.mock.calls.find(([c, ctx]) => c.name === 'api' && !ctx.dryRun);
    expect(api?.[1].targetCheck?.resolutions).toEqual({ [NAME]: { choice: 'local', remote: LIVE, local: hashOf(NAME) } });
    expect(r.github.createPull.mock.calls).toHaveLength(3);
  });

  test('remote: that variable is not delivered and not recorded for api (the target reports it kept on the platform)', async () => {
    const r = rig();
    const finished = await r.actions.run(await planned(r), undefined, decision('remote'));
    if (!finished.ok) throw new Error('expected a result');
    expect(finished.result.targets.find((t) => t.kind === 'skipped')).toMatchObject({ kind: 'skipped', code: SKIP_CODES.KEPT_ON_PLATFORM, target: { target: 'api' } });
    expect(finished.result.targets.filter((t) => t.kind === 'delivered').map((t) => t.target.target).toSorted()).toEqual(['site', 'worker']);
    const recorded = r.service.pushSecrets.mock.calls.map((c) => JSON.parse(String(c[1])) as { variables: Record<string, Array<{ targets?: Array<{ target: string }> }>> });
    recorded.forEach((keep) => expect(keep.variables.API_KEY[0].targets?.map((t) => t.target) ?? []).not.toContain('api'));
  });

  test('the live value changed after the decision: the decision is NOT applied, the new conflict comes back, nothing is delivered', async () => {
    const r = rig(liveAdapter(MOVED_AGAIN));
    const finished = await r.actions.run(await planned(r), undefined, decision('local', LIVE));
    expect(finished).toEqual({ ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: [conflictFor(MOVED_AGAIN)] });
    nothingWritten(r);
  });

  test('a decision for another delivered value is not applied either', async () => {
    const r = rig();
    const finished = await r.actions.run(await planned(r), undefined, { 'API_KEY@api': { choice: 'local', remote: LIVE, local: 'someotherhash0000' } });
    expect(finished.ok).toBe(false);
    nothingWritten(r);
  });

  test('a platform that cannot be read back has nothing to compare: the run is as before', async () => {
    const r = rig(fakeAdapter() as never);
    const finished = await r.actions.run(await planned(r));
    expect(finished.ok).toBe(true);
    expect(r.adapter.deploy.mock.calls.every(([, ctx]) => ctx.dryRun !== true)).toBe(true);
  });
});

describe('decideFrom (pure)', () => {
  const scope = { project: 'mono-backend', branch: 'production', serverKeepHash: 'k', conflicts: [conflictFor()] };

  test('every conflict decided against what it holds now: the decisions, by NAME@TARGET', () => {
    expect(decideFrom(decision('remote'))([scope])).toEqual({ 'API_KEY@api': 'remote' });
  });
  test('an undecided or moved conflict is a refusal (nothing written) listing them', () => {
    expect(() => decideFrom(undefined)([scope])).toThrow();
    const thrown = (() => {
      try {
        decideFrom(decision('local', 'old'))([scope]);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toMatchObject({ code: ERROR_CODES.SECRETS_CONFLICT });
    expect((thrown as { payload: { conflicts: unknown[] } }).payload.conflicts).toEqual([conflictFor()]);
    expect(conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, [scope]).payload.conflicts).toEqual([conflictFor()]);
  });
});

describe('the flow step', () => {
  const running = (): DeployFlow => ({ step: 'running', row, plan: { targets: [], skipped: [], read_failed: [] } });
  const atConflicts = (): DeployFlow =>
    applyDeployFinished(running(), { ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: [conflictFor()] }) as DeployFlow;
  const view = (flow: DeployFlow): string => strip(renderDeploy(flow, 120).lines.join('\n'));

  test('a run that comes back with conflicts shows each by target and name, never a value', () => {
    const flow = atConflicts();
    expect(flow.step).toBe('conflicts');
    expect(view(flow)).toContain('API_KEY');
    expect(view(flow)).toContain('api · API_KEY · changed outside Capy');
    expect(view(flow)).not.toContain(LIVE);
    expect(strip(renderDeploy(flow, 120).footer)).toContain('l local');
    expect(strip(renderDeploy(flow, 120).footer)).toContain('r remote');
  });

  test('Enter does nothing until decided; then it runs again with the decision bound to the fingerprints', () => {
    const flow = atConflicts();
    expect(stepDeploy(flow, '\r').effect).toBeNull();
    expect(strip(renderDeploy(flow, 120).footer)).not.toContain('enter continue');
    const decided = stepDeploy(flow, 'l').flow as DeployFlow;
    expect(strip(renderDeploy(decided, 120).footer)).toContain('enter continue');
    const again = stepDeploy(decided, '\r');
    expect(again.flow?.step).toBe('running');
    expect(again.effect).toMatchObject({ type: 'runDeploy', decisions: decision('local') });
  });

  test('Esc leaves with nothing written: no effect, the cancelled note', () => {
    const left = stepDeploy(stepDeploy(atConflicts(), 'l').flow as DeployFlow, ESC);
    expect(left.flow).toBeNull();
    expect(left.effect).toBeNull();
    expect(left.note).toBe(CANCELLED_NOTHING);
  });

  test('coming back with the live value moved again drops that decision', () => {
    const decided = stepDeploy(stepDeploy(atConflicts(), 'l').flow as DeployFlow, '\r').flow as DeployFlow;
    const back = applyDeployFinished(decided, { ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: [conflictFor(MOVED_AGAIN)] }) as Extract<DeployFlow, { step: 'conflicts' }>;
    expect(back.step).toBe('conflicts');
    expect(back.choices).toEqual({});
    expect(stepDeploy(back, '\r').effect).toBeNull();
    // Unmoved: the decision stands.
    const same = applyDeployFinished(decided, { ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: [conflictFor()] }) as Extract<DeployFlow, { step: 'conflicts' }>;
    expect(same.choices).toEqual({ 'API_KEY@api': 'local' });
  });

  test('a plain failure is still the failure line', () => {
    const done = applyDeployFinished(running(), { ok: false, code: ERROR_CODES.SERVICE_ERROR }) as DeployFlow;
    expect(done.step).toBe('done');
    expect(startDeploy(row).flow.step).toBe('planning');
  });
});

describe('the whole TUI: Ctrl+D, Enter, then the conflict', () => {
  async function session(keys: readonly string[], adapter = liveAdapter()) {
    const r = rig(adapter);
    const out = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const lastFrame = (): string => strip(String(out.mock.calls[out.mock.calls.length - 1]?.[0] ?? ''));
    const done = runSecretsScreen([row], async () => ({ ok: false, code: 'NO' }), undefined, false, r.actions);
    await wait();
    const send = async (key: string) => {
      process.stdin.emit('data', Buffer.from(key));
      await wait(40);
    };
    await send(CTRL_D);
    await wait(100);
    await send('\r');
    await wait(200);
    const atConflicts = lastFrame();
    const deliveredBeforeDeciding = r.adapter.deploy.mock.calls.filter(([, ctx]) => ctx.dryRun !== true).length;
    for (const key of keys) await send(key);
    await wait(200);
    const afterwards = lastFrame();
    await send(ESC);
    await send('\x03');
    await done;
    const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    out.mockRestore();
    log.mockRestore();
    return { r, atConflicts, deliveredBeforeDeciding, afterwards, logged };
  }

  test('the conflict is shown first, with nothing delivered; Esc cancels and still nothing is', async () => {
    const s = await session([ESC]);
    expect(s.atConflicts).toContain('changed outside Capy in 1 place');
    expect(s.atConflicts).toContain('api · API_KEY');
    expect(s.deliveredBeforeDeciding).toBe(0);
    nothingWritten(s.r);
  });

  test('local, Enter: delivered', async () => {
    const s = await session(['l', '\r']);
    expect(s.r.github.createPull.mock.calls).toHaveLength(3);
    expect(s.r.adapter.deploy.mock.calls.some(([c, ctx]) => c.name === 'api' && !ctx.dryRun)).toBe(true);
    expect(everythingSentTo(s.r.github.createPull)).not.toContain(VALUES.API_KEY);
  });

  test('remote, Enter: api is skipped (kept on the platform), the others are delivered', async () => {
    const s = await session(['r', '\r']);
    expect(s.r.github.createPull.mock.calls).toHaveLength(2);
    expect(`${s.logged}\n${s.afterwards}`).toContain(SKIP_CODES.KEPT_ON_PLATFORM);
  });

  test('the live value moves after the decision: the conflict is shown again and nothing is delivered', async () => {
    const s = await session(['l', '\r'], movingAdapter());
    expect(s.afterwards).toContain('changed outside Capy in 1 place');
    // It was compared twice (before the decision and after it), and the second time it had moved.
    expect(s.r.adapter.deploy.mock.calls.filter(([c, x]) => c.name === 'api' && x.dryRun === true)).toHaveLength(2);
    nothingWritten(s.r);
  });
});
