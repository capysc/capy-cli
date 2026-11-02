/**
 * The deploy flow of the `capy secrets` TUI (CAP-704): the pure reducer, the screen's keys, the
 * rendered plan and result, the dry run that only plans, and the real driver with injected actions.
 * The service, GitHub and Dokploy are the fakes of tests/helpers/batchDeployWorld.ts (no network, no gh).
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  applyDeployCopied,
  applyDeployFinished,
  applyDeployPlanLoaded,
  applyDeployProgress,
  applyDeployValue,
  deployRunningLine,
  dryRunDeployText,
  isDeployRunning,
  renderDeploy,
  selectedPlan,
  startDeploy,
  stepDeploy,
  type DeployFlow,
} from '../../src/ui/secretsDeployFlow';
import {
  applyCopied,
  applyDeployPlan,
  applyDeployRunDone,
  applyDeployRunProgress,
  applyValueResult,
  handleKey,
  initialSecretsScreenState,
  maskSecretValue,
  pendingDeployValueEffect,
  render,
  type SecretsScreenState,
} from '../../src/ui/secretsScreen';
import { runSecretsScreen, type SecretsDeployActions } from '../../src/ui/secretsScreenDriver';
import { createDeployActionsWith } from '../../src/commands/secretsDeployActions';
import { deployLocationsOf, planBatchDeploy, restrictPlan, targetKeyOf, type BatchPlan, type BatchResult } from '../../src/deploy/batchDeploy';
import { CANCELLED_NOTHING } from '../../src/commands/secretsSetText';
import { ERROR_CODES } from '../../src/types/index';
import {
  LINKS,
  VALUES,
  everythingSentTo,
  fakeAdapter,
  fakeGithub,
  fakeService,
  indexRows,
  makeEnv,
  standardRepos,
} from '../helpers/batchDeployWorld';

const ESC = '\x1b';
const CTRL_D = '\x04';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const [row] = indexRows();

async function realPlan(): Promise<BatchPlan> {
  return planBatchDeploy(fakeGithub(standardRepos()), { names: [row.name], locations: deployLocationsOf(row) }, LINKS);
}

const EMPTY: BatchPlan = {
  targets: [],
  skipped: [{ project: 'mono-backend', branch: 'staging', target: null, provider: null, code: 'NO_TARGET' }],
  read_failed: [],
};

const RESULT: BatchResult = {
  targets: [
    {
      kind: 'delivered',
      target: { project: 'mono-backend', branch: 'production', target: 'api', provider: 'dokploy', repo: 'Acme/mono', path: 'backend', vars: 2 },
      pr_url: 'https://github.com/Acme/mono/pull/12',
      base: 'main',
      recorded: true,
    },
  ],
  skipped: [{ project: 'mono-backend', branch: 'staging', target: null, provider: null, code: 'NO_TARGET' }],
  read_failed: [],
};

describe('the flow, step by step', () => {
  test('starting reads the plan (an effect) and shows that it is reading', () => {
    const started = startDeploy(row);
    expect(started.flow.step).toBe('planning');
    expect(started.effect).toEqual({ type: 'loadDeployPlan', row });
    expect(strip(renderDeploy(started.flow, 100).lines.join('\n'))).toContain('Reading');
  });

  test('Esc while reading goes back, stops the reads, and says nothing was changed', () => {
    const step = stepDeploy(startDeploy(row).flow, ESC);
    expect(step.flow).toBeNull();
    expect(step.effect).toEqual({ type: 'cancelDeploy', phase: 'planning' });
    expect(step.note).toBe(CANCELLED_NOTHING);
  });

  test('the plan arrives: one line per target (location, target, provider, vars) and one per skipped location with its code', async () => {
    const plan = await realPlan();
    const flow = applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow;
    expect(flow.step).toBe('plan');
    const lines = strip(renderDeploy(flow, 120).lines.join('\n'));
    expect(lines).toContain('Deploy API_KEY to 3 targets');
    expect(lines).toMatch(/mono-backend · production\s+api\s+dokploy\s+2 vars/);
    expect(lines).toMatch(/mono-backend · production\s+worker\s+dokploy\s+1 var\b/);
    expect(lines).toMatch(/solo-server · staging\s+site\s+dokploy\s+1 var\b/);
    expect(lines).toMatch(/mono-backend · production\s+cf\s+cf-worker\s+skipped NOT_DOKPLOY/);
    expect(lines).toMatch(/mono-backend · production\s+direct\s+dokploy\s+skipped NOT_CI_MODE/);
    expect(lines).toMatch(/mono-backend · staging\s+—\s+—\s+skipped NO_TARGET/);
    expect(strip(renderDeploy(flow, 120).footer)).toContain('enter deploy');
  });

  test('a plan that cannot be read ends in a code, never a crash', () => {
    const flow = applyDeployPlanLoaded(startDeploy(row).flow, { ok: false, code: ERROR_CODES.SERVICE_ERROR }) as DeployFlow;
    expect(flow).toMatchObject({ step: 'done' });
    expect((flow as { text: string }).text).toContain(`(${ERROR_CODES.SERVICE_ERROR})`);
  });

  test('a late plan is dropped once the flow has moved on', () => {
    const plan: BatchPlan = EMPTY;
    expect(applyDeployPlanLoaded(null, { ok: true, plan })).toBeNull();
    const running = { step: 'running', row, plan } as DeployFlow;
    expect(applyDeployPlanLoaded(running, { ok: true, plan })).toBe(running);
  });

  test('Enter confirms and starts the run with that plan; y does nothing; Esc (or n) cancels with nothing changed', async () => {
    const plan = await realPlan();
    const planned = applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow;
    const step = stepDeploy(planned, '\r');
    expect(step.flow?.step).toBe('running');
    expect(step.effect).toEqual({ type: 'runDeploy', plan });
    for (const key of ['y', 'Y']) {
      const ignored = stepDeploy(planned, key);
      expect(ignored.flow).toBe(planned);
      expect(ignored.effect).toBeNull();
    }
    for (const key of [ESC, 'n']) {
      const step = stepDeploy(planned, key);
      expect(step.flow).toBeNull();
      expect(step.effect).toBeNull();
      expect(step.note).toBe(CANCELLED_NOTHING);
    }
    expect(stepDeploy(planned, 'x').effect).toBeNull(); // any other key does nothing
  });

  test('a plan with nothing to deploy says so, and Enter does nothing', () => {
    const planned = applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan: EMPTY }) as DeployFlow;
    const view = renderDeploy(planned, 100);
    expect(strip(view.lines.join('\n'))).toContain('Nothing to deploy.');
    expect(strip(view.lines.join('\n'))).toContain('skipped NO_TARGET');
    const step = stepDeploy(planned, '\r');
    expect(step.flow).toBe(planned);
    expect(step.effect).toBeNull();
  });

  test('--dry-run: Enter shows what would happen and starts NOTHING', async () => {
    const plan = await realPlan();
    const planned = applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow;
    const step = stepDeploy(planned, '\r', true);
    expect(step.effect).toBeNull();
    expect(step.flow).toMatchObject({ step: 'done' });
    const text = (step.flow as { text: string }).text;
    expect(text).toContain('Dry run: nothing was changed.');
    expect(text).toContain('Would deploy to 3 targets.');
    expect(text).toBe(dryRunDeployText(plan));
  });

  test('running: progress is shown per phase; Esc / Ctrl+C stop (once, then again), other keys are ignored', async () => {
    const plan = await realPlan();
    const running = stepDeploy(applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow, '\r').flow as Extract<DeployFlow, { step: 'running' }>;
    expect(isDeployRunning(running)).toBe(true);
    expect(deployRunningLine(running)).toBe('Deploying API_KEY to 3 targets…');

    const pushing = applyDeployProgress(running, { phase: 'pushing', done: 1, inFlight: 2, total: 3 }) as Extract<DeployFlow, { step: 'running' }>;
    expect(deployRunningLine(pushing)).toBe('Deploying API_KEY… 1 of 3 targets');
    expect(deployRunningLine(applyDeployProgress(pushing, { phase: 'recording', done: 0, inFlight: 1, total: 1 }) as Extract<DeployFlow, { step: 'running' }>)).toBe('Recording deliveries…');
    expect(deployRunningLine(applyDeployProgress(pushing, { phase: 'prs', done: 2, inFlight: 1, total: 3 }) as Extract<DeployFlow, { step: 'running' }>)).toBe('Opening pull requests… 2 of 3');

    expect(stepDeploy(pushing, 'x').effect).toBeNull();
    const stopped = stepDeploy(pushing, '\x03');
    expect(stopped.effect).toEqual({ type: 'cancelDeploy', phase: 'pushing' });
    const stoppedFlow = stopped.flow as Extract<DeployFlow, { step: 'running' }>;
    expect(deployRunningLine(stoppedFlow)).toBe('Stopping after the 2 in progress…');
    expect(stepDeploy(stoppedFlow, ESC).flow).toMatchObject({ stop: { phase: 'pushing', count: 2 } });
    // A stop asked for in the pushing phase does not carry into the PR phase.
    expect((applyDeployProgress(stoppedFlow, { phase: 'prs', done: 0, inFlight: 1, total: 1 }) as { stop?: unknown }).stop).toBeUndefined();
  });

  test('the result: PR links, then skipped; only Esc leaves the screen and the text is printed after it', async () => {
    const plan = await realPlan();
    const running = stepDeploy(applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow, '\r').flow as DeployFlow;
    const done = applyDeployFinished(running, { ok: true, result: RESULT }) as Extract<DeployFlow, { step: 'done' }>;
    const text = strip(done.text);
    expect(text).toContain('✓ 1 target deployed.');
    expect(text).toContain('Review and merge to deploy:');
    expect(text).toContain('https://github.com/Acme/mono/pull/12');
    expect(text.indexOf('Review and merge')).toBeLessThan(text.indexOf('Skipped'));
    expect(strip(renderDeploy(done, 120).footer)).toContain('esc exit');
    // Any other key leaves the result on screen, so the links can be selected and copied.
    for (const key of ['x', '\r', ' ', '\x03']) {
      const stays = stepDeploy(done, key);
      expect(stays.flow).toBe(done);
      expect(stays.effect).toBeNull();
      expect(stays.exitText).toBeUndefined();
    }
    const left = stepDeploy(done, ESC);
    expect(left.flow).toBeNull();
    expect(stepDeploy(done, `${ESC}${ESC}`).flow).toBeNull();
    expect(left.exitText).toBe(done.text);
    // A run that failed as a whole ends in a code.
    expect((applyDeployFinished(running, { ok: false, code: 'UNAVAILABLE' }) as { text: string }).text).toContain('(UNAVAILABLE)');
  });
});

describe('the screen: keys, footer, dry run', () => {
  const state = (dryRun = false): SecretsScreenState => initialSecretsScreenState([row], dryRun);
  const frame = (s: SecretsScreenState): string => strip(render(s, 120, 30));

  test('ctrl+d on the list starts the deploy flow for the row under the cursor; the footer names the key', () => {
    expect(frame(state())).toContain('ctrl+d deploy');
    const next = handleKey(state(), CTRL_D);
    expect(next.state.deploy?.step).toBe('planning');
    expect(next.effect).toEqual({ type: 'loadDeployPlan', row });
    expect(frame(next.state)).toContain('Reading deploy targets');
  });

  test('with a filter typed ctrl+d does nothing (the search owns the keyboard), like ctrl+e', () => {
    const typed = handleKey(state(), 'a').state;
    expect(handleKey(typed, CTRL_D).state.deploy).toBeNull();
    expect(frame(typed)).not.toContain('ctrl+d deploy');
  });

  test('in the details view `d` starts the deploy flow and the footer names it', () => {
    const popup = handleKey(state(), '\r').state;
    expect(frame(popup)).toContain('d deploy');
    const next = handleKey(popup, 'd');
    expect(next.state.deploy?.step).toBe('planning');
    expect(next.state.popup).toBeNull();
    expect(next.effect).toEqual({ type: 'loadDeployPlan', row });
  });

  test('the whole path through the screen reducer: plan, confirm, progress, result', async () => {
    const plan = await realPlan();
    const planned = applyDeployPlan(handleKey(state(), CTRL_D).state, { ok: true, plan });
    expect(frame(planned)).toContain('Deploy API_KEY to 3 targets');
    const confirmed = handleKey(planned, '\r');
    expect(confirmed.effect).toEqual({ type: 'runDeploy', plan });
    const midway = applyDeployRunProgress(confirmed.state, { phase: 'pushing', done: 1, inFlight: 1, total: 3 });
    expect(frame(midway)).toContain('1 of 3 targets');
    const finished = applyDeployRunDone(midway, { ok: true, result: RESULT });
    expect(frame(finished)).toContain('✓ 1 target deployed.');
    const stays = handleKey(finished, 'x');
    expect(stays.state.quit).toBe(false);
    expect(stays.state.deploy?.step).toBe('done');
    const left = handleKey(finished, ESC).state;
    expect(left.quit).toBe(true);
    expect(left.exitText).toContain('https://github.com/Acme/mono/pull/12');
  });

  test('Ctrl+C while the deploy runs stops it, it does not quit the screen', async () => {
    const plan = await realPlan();
    const running = handleKey(applyDeployPlan(handleKey(state(), CTRL_D).state, { ok: true, plan }), '\r').state;
    const stopped = handleKey(running, '\x03');
    expect(stopped.state.quit).toBe(false);
    expect(stopped.effect).toEqual({ type: 'cancelDeploy', phase: 'pushing' });
  });

  test('a --dry-run session: every screen carries the marker and Enter on the plan starts no run', async () => {
    const plan = await realPlan();
    const planned = applyDeployPlan(handleKey(state(true), CTRL_D).state, { ok: true, plan });
    expect(frame(planned)).toContain('DRY RUN');
    const confirmed = handleKey(planned, '\r');
    expect(confirmed.effect).toBeNull();
    expect(frame(confirmed.state)).toContain('DRY RUN');
    expect(frame(confirmed.state)).toContain('Dry run: nothing was changed.');
  });
});

describe('the driver, with injected actions', () => {
  async function drive(actions: SecretsDeployActions | undefined, keys: ReadonlyArray<string | number>, dryRun = false) {
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const done = runSecretsScreen([row], async () => ({ ok: false, code: 'NO' }), undefined, dryRun, actions);
    await wait();
    for (const k of keys) {
      if (typeof k === 'number') await wait(k);
      else {
        process.stdin.emit('data', Buffer.from(k));
        await wait();
      }
    }
    await done;
    const screen = outSpy.mock.calls.map((c) => String(c[0])).join('');
    const logged = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    outSpy.mockRestore();
    logSpy.mockRestore();
    return { screen, logged };
  }

  test('ctrl+d, wait for the plan, Enter, wait: the effects are performed and the confirmation is printed after the screen is left', async () => {
    const plan = await realPlan();
    const loadPlan = mock(async () => ({ ok: true as const, plan }));
    const run = mock(async (_plan: BatchPlan, onProgress?: Parameters<SecretsDeployActions['run']>[1]) => {
      onProgress?.({ phase: 'pushing', done: 1, inFlight: 0, total: 3 });
      return { ok: true as const, result: RESULT };
    });
    const { screen, logged } = await drive({ loadPlan, run, cancel: () => undefined }, [CTRL_D, 40, '\r', 40, ESC]);
    expect(loadPlan.mock.calls).toHaveLength(1);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][0]).toEqual(plan);
    expect(screen).toContain('Deploy API_KEY to 3 targets');
    expect(logged).toContain('✓ 1 target deployed.');
    expect(logged).toContain('https://github.com/Acme/mono/pull/12');
  });

  test('Esc on the plan cancels: nothing is run', async () => {
    const plan = await realPlan();
    const run = mock(async () => ({ ok: true as const, result: RESULT }));
    const { logged } = await drive({ loadPlan: async () => ({ ok: true, plan }), run, cancel: () => undefined }, [CTRL_D, 40, ESC, 20, '\x03']);
    expect(run.mock.calls).toHaveLength(0);
    expect(logged).toBe('');
  });

  test('with no actions wired the flow ends in a code, not a crash', async () => {
    const { logged } = await drive(undefined, [CTRL_D, 40, ESC]);
    expect(logged).toContain('UNAVAILABLE');
  });

  test('Ctrl+C while running reaches the actions as a stop of the pushes', async () => {
    const plan = await realPlan();
    const cancel = mock((_phase: string) => undefined);
    const run = mock(async () => {
      await wait(60);
      return { ok: true as const, result: RESULT };
    });
    await drive({ loadPlan: async () => ({ ok: true, plan }), run, cancel }, [CTRL_D, 40, '\r', 10, '\x03', 120, ESC]);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['pushing']);
  });
});

describe('--dry-run through the real actions: it reads, and nothing is written, unlocked or deployed', () => {
  function rig() {
    const service = fakeService();
    const github = fakeGithub(standardRepos());
    const adapter = fakeAdapter();
    const { env, openKeys } = makeEnv(service, github, adapter);
    const actions = createDeployActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', env, true);
    return { service, github, adapter, openKeys, actions };
  }

  test('the plan is read from GitHub, the screen shows what would happen, and no write call was made', async () => {
    const r = rig();
    const { screen, logged } = await (async () => {
      const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const done = runSecretsScreen([row], async () => ({ ok: false, code: 'NO' }), undefined, true, r.actions);
      await wait();
      for (const k of [CTRL_D, 60, '\r', 20, ESC]) {
        if (typeof k === 'number') await wait(k);
        else {
          process.stdin.emit('data', Buffer.from(k));
          await wait();
        }
      }
      await done;
      const out = outSpy.mock.calls.map((c) => String(c[0])).join('');
      const log = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      outSpy.mockRestore();
      logSpy.mockRestore();
      return { screen: out, logged: log };
    })();

    expect(screen).toContain('DRY RUN');
    expect(logged).toContain('Dry run: nothing was changed.');
    expect(logged).toContain('Would deploy to 3 targets.');
    expect(r.github.getFile.mock.calls.length).toBeGreaterThan(0);
    expect(r.openKeys.mock.calls).toHaveLength(0);
    expect(r.service.getDecryptData.mock.calls).toHaveLength(0);
    expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
    expect(r.adapter.preflight.mock.calls).toHaveLength(0);
    expect(r.adapter.deploy.mock.calls).toHaveLength(0);
    expect(r.github.createBlob.mock.calls).toHaveLength(0);
    expect(r.github.createPull.mock.calls).toHaveLength(0);
  });

  test('even called directly, `run` of a dry-run session refuses with DRY_RUN_UNSUPPORTED and runs nothing', async () => {
    const r = rig();
    const plan = await realPlan();
    const finished = await r.actions.run(plan);
    expect(finished).toEqual({ ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED });
    expect(r.adapter.deploy.mock.calls).toHaveLength(0);
    expect(r.openKeys.mock.calls).toHaveLength(0);
  });
});

describe('the real (non dry-run) actions run the engine', () => {
  test('loadPlan reads the plan; run deploys it; no value is in what the screen would print', async () => {
    const service = fakeService();
    const github = fakeGithub(standardRepos());
    const adapter = fakeAdapter();
    const { env } = makeEnv(service, github, adapter);
    const actions = createDeployActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', env, false);

    const loaded = await actions.loadPlan(row);
    expect(loaded.ok).toBe(true);
    const plan = (loaded as { plan: BatchPlan }).plan;
    expect(plan.targets).toHaveLength(3);
    const finished = await actions.run(plan);
    expect(finished.ok).toBe(true);
    expect(adapter.deploy.mock.calls).toHaveLength(3);
    const printed = JSON.stringify(finished) + everythingSentTo(github.createPull, github.createBlob);
    expect(Object.values(VALUES).filter((v) => printed.includes(v))).toEqual([]);
  });

  test('a service that cannot list the repos ends the plan in a code', async () => {
    const { env } = makeEnv(fakeService(), fakeGithub(standardRepos()), fakeAdapter());
    const actions = createDeployActionsWith({ getOrgRepos: async () => { throw new Error('down'); } }, 'org1', env, false);
    expect(await actions.loadPlan(row)).toEqual({ ok: false, code: ERROR_CODES.SERVICE_ERROR });
  });
});

// ── CAP-704: the value line and the choice of targets on the plan step ──────

describe('the plan step: the value, masked, and `r` to reveal', () => {
  const SECRET = VALUES.API_KEY;
  const MASKED = maskSecretValue(SECRET);
  const SPACE = ' ';
  const DOWN = `${ESC}[B`;
  const UP = `${ESC}[A`;
  type Planned = Extract<DeployFlow, { step: 'plan' }>;
  const planned = async (): Promise<Planned> =>
    applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan: await realPlan() }) as Planned;
  const withValue = (flow: DeployFlow | null): Planned => applyDeployValue(flow, row, { status: 'ok', value: SECRET }) as Planned;
  const view = (flow: DeployFlow): string => strip(renderDeploy(flow, 120).lines.join('\n'));
  const press = (flow: DeployFlow, ...keys: readonly string[]): Planned =>
    keys.reduce<DeployFlow>((f, k) => stepDeploy(f, k).flow as DeployFlow, flow) as Planned;

  test('the plan starts with the value loading, hidden; the value line sits directly under the title', async () => {
    const flow = await planned();
    expect(flow.value).toEqual({ status: 'loading' });
    expect(flow.revealed).toBe(false);
    const lines = view(flow).split('\n');
    expect(lines[0]).toContain('Deploy API_KEY to 3 targets');
    expect(lines[1]).toMatch(/^value\s+loading…/);
  });

  test('masked by default; `r` reveals it and `r` hides it again; the footer says which', async () => {
    const flow = withValue(await planned());
    expect(view(flow)).toContain(MASKED);
    expect(view(flow)).not.toContain(SECRET);
    expect(strip(renderDeploy(flow, 120).footer)).toContain('r reveal');

    const shown = press(flow, 'r');
    expect(shown.revealed).toBe(true);
    expect(view(shown)).toContain(SECRET);
    expect(strip(renderDeploy(shown, 120).footer)).toContain('r hide');

    const hidden = press(shown, 'R');
    expect(view(hidden)).toContain(MASKED);
    expect(view(hidden)).not.toContain(SECRET);
  });

  test('a value that cannot be read says so with its code', async () => {
    const flow = applyDeployValue(await planned(), row, { status: 'unavailable', code: 'HASH_MISMATCH' }) as DeployFlow;
    expect(view(flow)).toMatch(/value\s+unavailable \(HASH_MISMATCH\)/);
  });

  test('a value for another row (name or hash) is dropped; so is one that arrives after the plan step', async () => {
    const flow = await planned();
    expect(applyDeployValue(flow, { name: 'OTHER', value_hash: row.value_hash }, { status: 'ok', value: SECRET })).toBe(flow);
    expect(applyDeployValue(flow, { name: row.name, value_hash: 'old-hash' }, { status: 'ok', value: SECRET })).toBe(flow);
    const running = { step: 'running', row, plan: flow.plan } as DeployFlow;
    expect(applyDeployValue(running, row, { status: 'ok', value: SECRET })).toBe(running);
    expect(applyDeployValue(null, row, { status: 'ok', value: SECRET })).toBeNull();
  });

  test('the value never reaches the exit text, a note, or the running / dry-run / result text', async () => {
    const flow = press(withValue(await planned()), 'r');
    expect(JSON.stringify(stepDeploy(flow, ESC))).not.toContain(SECRET); // the cancel note
    expect(JSON.stringify(stepDeploy(flow, '\r', true))).not.toContain(SECRET); // the dry-run text
    const started = stepDeploy(flow, '\r'); // the run: neither its state nor its effect holds it
    expect(JSON.stringify(started)).not.toContain(SECRET);
    expect(view(started.flow as DeployFlow)).not.toContain(SECRET);
    const done = applyDeployFinished(started.flow, { ok: true, result: RESULT }) as Extract<DeployFlow, { step: 'done' }>;
    expect(done.text).not.toContain(SECRET);
    expect(JSON.stringify(stepDeploy(done, ESC))).not.toContain(SECRET); // the exit text
  });

  test('all targets start ticked; Space ticks / unticks the one under the cursor; the cursor moves with up and down', async () => {
    const flow = await planned();
    expect(flow.box.checked).toEqual([0, 1, 2]);
    const text = view(flow);
    expect(text.match(/◉/g)).toHaveLength(3);
    expect(text).not.toContain('◯');

    expect(press(flow, SPACE).box.checked).toEqual([1, 2]);
    const second = press(flow, SPACE, DOWN, SPACE);
    expect(second.box).toMatchObject({ checked: [2], active: 1 });
    expect(view(second).match(/◯/g)).toHaveLength(2);
    expect(press(second, UP, SPACE).box.checked).toEqual([0, 2]);
  });

  test('`a` clears all when all are ticked, and ticks all when any is not', async () => {
    const flow = await planned();
    const none = press(flow, 'a');
    expect(none.box.checked).toEqual([]);
    expect(press(none, 'a').box.checked).toEqual([0, 1, 2]);
    expect(press(flow, SPACE, 'a').box.checked).toEqual([0, 1, 2]);
  });

  test('nothing else types into the list: letters, digits and `/` are ignored', async () => {
    const flow = await planned();
    for (const key of ['/', 'i', '1', 'x', 'k', 'j', 'y']) {
      const step = stepDeploy(flow, key);
      expect(step.flow).toBe(flow);
      expect(step.effect).toBeNull();
    }
  });

  test('Enter deploys ONLY the ticked targets: the run gets the restricted plan', async () => {
    const flow = await planned();
    const step = stepDeploy(press(flow, SPACE), '\r'); // the first one unticked
    expect(step.effect?.type).toBe('runDeploy');
    const sent = (step.effect as Extract<NonNullable<typeof step.effect>, { type: 'runDeploy' }>).plan;
    expect(sent.targets.map((t) => t.config.name)).toEqual(['worker', 'site']);
    expect(sent).toEqual(restrictPlan(flow.plan, flow.plan.targets.slice(1).map(targetKeyOf)));
    expect(sent.skipped).toEqual(flow.plan.skipped);
    expect(step.flow).toMatchObject({ step: 'running', plan: sent });
    expect(deployRunningLine(step.flow as Extract<DeployFlow, { step: 'running' }>)).toBe('Deploying API_KEY to 2 targets…');
  });

  test('with nothing ticked Enter stays, and the footer no longer offers `enter deploy`', async () => {
    const flow = await planned();
    expect(strip(renderDeploy(flow, 120).footer)).toBe('space select · a all · r reveal · enter deploy · esc cancel');
    const none = press(flow, 'a');
    for (const dry of [false, true]) {
      const step = stepDeploy(none, '\r', dry);
      expect(step.flow).toBe(none);
      expect(step.effect).toBeNull();
    }
    expect(strip(renderDeploy(none, 120).footer)).toBe('space select · a all · r reveal · esc cancel');
  });

  test('skipped locations stay listed under the list, greyed, with no checkbox, and are never selectable', async () => {
    const flow = await planned();
    const { lines } = renderDeploy(flow, 120);
    const skipped = lines.filter((l) => strip(l).includes('skipped '));
    expect(skipped).toHaveLength(flow.plan.skipped.length);
    for (const l of skipped) {
      expect(l.startsWith(`${ESC}[90m`)).toBe(true);
      expect(l).not.toMatch(/[◉◯]/);
    }
    expect(lines.findIndex((l) => strip(l).includes('NOT_DOKPLOY'))).toBeGreaterThan(lines.findIndex((l) => strip(l).includes('solo-server')));
    // The cursor only visits the three targets, however far it goes, and ticks never name a skipped row.
    const moved = press(flow, ...Array.from({ length: 7 }, () => DOWN));
    expect(moved.box.active).toBe(1);
    expect(press(moved, SPACE, 'a').box.checked.every((i) => i < flow.plan.targets.length)).toBe(true);
  });

  test('--dry-run with a partial selection lists only the ticked targets and starts nothing', async () => {
    const flow = await planned();
    const partial = press(flow, SPACE); // the first one unticked
    const step = stepDeploy(partial, '\r', true);
    expect(step.effect).toBeNull();
    const text = (step.flow as { text: string }).text;
    expect(text).toContain('Would deploy to 2 targets.');
    expect(text).toContain('· worker');
    expect(text).toContain('· site');
    expect(text).not.toContain('· api');
    expect(text).toBe(dryRunDeployText(selectedPlan(partial)));
  });
});

describe('the plan step through the screen and the driver', () => {
  const SECRET = VALUES.API_KEY;
  const state = (dryRun = false): SecretsScreenState => initialSecretsScreenState([row], dryRun);
  const frame = (s: SecretsScreenState): string => strip(render(s, 120, 30));

  test("once the plan has loaded the value is fetched (the details view's effect) and shows masked; a result for another row is dropped", async () => {
    const plan = await realPlan();
    const started = handleKey(state(), CTRL_D).state;
    expect(pendingDeployValueEffect(started)).toBeNull(); // still reading the plan
    const planned = applyDeployPlan(started, { ok: true, plan });
    expect(pendingDeployValueEffect(planned)).toEqual({ type: 'fetchValue', row });
    const shown = applyValueResult(planned, row, { status: 'ok', value: SECRET });
    expect(frame(shown)).toContain(maskSecretValue(SECRET));
    expect(frame(shown)).not.toContain(SECRET);
    const stale = applyValueResult(planned, { name: 'OTHER', value_hash: row.value_hash }, { status: 'ok', value: SECRET });
    expect(stale.deploy).toBe(planned.deploy);
    expect(frame(handleKey(shown, 'r').state)).toContain(SECRET); // `r` reveals it, on screen
  });

  test('a plan with nothing to deploy fetches no value', () => {
    const planned = applyDeployPlan(handleKey(state(), CTRL_D).state, { ok: true, plan: EMPTY });
    expect(pendingDeployValueEffect(planned)).toBeNull();
  });

  async function drive(actions: SecretsDeployActions, decryptAt: Parameters<typeof runSecretsScreen>[1], keys: ReadonlyArray<string | number>) {
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const done = runSecretsScreen([row], decryptAt, undefined, false, actions);
    await wait();
    for (const k of keys) {
      if (typeof k === 'number') await wait(k);
      else {
        process.stdin.emit('data', Buffer.from(k));
        await wait();
      }
    }
    await done;
    const screen = outSpy.mock.calls.map((c) => String(c[0])).join('');
    const logged = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    outSpy.mockRestore();
    logSpy.mockRestore();
    return { screen, logged };
  }

  test('the value is fetched ONCE per plan and shown masked; it is on screen only after `r`; the run gets the ticked targets; the printed text never holds it', async () => {
    const plan = await realPlan();
    const decryptAt = mock(async () => ({ ok: true as const, plaintext: SECRET }));
    const run = mock(async (_plan: BatchPlan) => ({ ok: true as const, result: RESULT }));
    const actions: SecretsDeployActions = { loadPlan: async () => ({ ok: true, plan }), run, cancel: () => undefined };

    const hidden = await drive(actions, decryptAt, [CTRL_D, 40, ESC, 20, '\x03']);
    expect(hidden.screen).toContain(maskSecretValue(SECRET));
    expect(hidden.screen).not.toContain(SECRET);
    expect(decryptAt.mock.calls).toHaveLength(1);

    const revealed = await drive(actions, decryptAt, [CTRL_D, 40, 'r', ' ', '\r', 40, ESC]);
    expect(revealed.screen).toContain(SECRET); // on the screen, after `r`
    expect(revealed.logged).not.toContain(SECRET);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][0].targets.map((t) => t.config.name)).toEqual(['worker', 'site']);
    expect(decryptAt.mock.calls).toHaveLength(2); // once per opened plan, never again
  });

  test('a value that cannot be decrypted shows its code and the deploy still works', async () => {
    const plan = await realPlan();
    const run = mock(async (_plan: BatchPlan) => ({ ok: true as const, result: RESULT }));
    const { screen } = await drive({ loadPlan: async () => ({ ok: true, plan }), run, cancel: () => undefined }, async () => ({ ok: false, code: 'NO_KEY' }), [CTRL_D, 40, '\r', 40, ESC]);
    expect(screen).toContain('unavailable');
    expect(screen).toContain('NO_KEY');
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][0].targets).toHaveLength(3);
  });
});

describe('the result screen: `c` copies the PR links', () => {
  const target = (name: string) => ({ project: 'mono-backend', branch: 'production', target: name, provider: 'dokploy', repo: 'Acme/mono', path: 'backend', vars: 2 });
  const delivered = (name: string, prUrl: string | null) => ({ kind: 'delivered' as const, target: target(name), pr_url: prUrl, base: 'main', recorded: true });
  const URL_A = 'https://github.com/Acme/mono/pull/12';
  const URL_B = 'https://github.com/Acme/web/pull/7';
  // Two PRs, one target that needed none, one that failed (no link), and a repeat of the first PR.
  const WITH_PRS: BatchResult = {
    targets: [
      delivered('api', URL_A),
      delivered('worker', null),
      { kind: 'failed', target: target('cron'), code: 'UNAVAILABLE', stage: 'push', values_pushed: false },
      delivered('web', URL_B),
      delivered('api-2', URL_A),
    ],
    skipped: [],
    read_failed: [],
  };
  const NO_PRS: BatchResult = { targets: [delivered('worker', null)], skipped: [], read_failed: [] };

  const runningFlow = async (): Promise<DeployFlow> => {
    const plan = await realPlan();
    return stepDeploy(applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow, '\r').flow as DeployFlow;
  };
  async function doneWith(result: BatchResult): Promise<Extract<DeployFlow, { step: 'done' }>> {
    return applyDeployFinished(await runningFlow(), { ok: true, result }) as Extract<DeployFlow, { step: 'done' }>;
  }

  test('`c` asks for a copy of exactly the PR urls (newline-joined, once each) and keeps the screen; the footer offers it', async () => {
    const done = await doneWith(WITH_PRS);
    expect(done.prUrls).toEqual([URL_A, URL_B]);
    for (const key of ['c', 'C']) {
      const step = stepDeploy(done, key);
      expect(step.effect).toEqual({ type: 'copyToClipboard', text: `${URL_A}\n${URL_B}` });
      expect(step.flow).toBe(done);
      expect(step.exitText).toBeUndefined();
    }
    expect(strip(renderDeploy(done, 120).footer)).toBe('c copy PRs · esc exit');
  });

  test('Esc is still the only way out, and any other key still does nothing', async () => {
    const done = await doneWith(WITH_PRS);
    const left = stepDeploy(done, ESC);
    expect(left.flow).toBeNull();
    expect(left.exitText).toBe(done.text);
    for (const key of ['x', '\r', ' ', '\x03', 'q']) {
      const stays = stepDeploy(done, key);
      expect(stays.flow).toBe(done);
      expect(stays.effect).toBeNull();
    }
  });

  test('with no PR: `c` does nothing and the footer does not offer it', async () => {
    const done = await doneWith(NO_PRS);
    expect(done.prUrls).toEqual([]);
    const step = stepDeploy(done, 'c');
    expect(step.flow).toBe(done);
    expect(step.effect).toBeNull();
    expect(strip(renderDeploy(done, 120).footer)).not.toContain('copy PRs');
    expect(strip(renderDeploy(done, 120).footer)).toContain('esc exit');
    // A failed run and a dry run have no links either.
    const failed = applyDeployFinished(await runningFlow(), { ok: false, code: 'UNAVAILABLE' }) as DeployFlow;
    expect(stepDeploy(failed, 'c').effect).toBeNull();
    expect(strip(renderDeploy(failed, 120).footer)).not.toContain('copy PRs');
    const plan = await realPlan();
    const dry = stepDeploy(applyDeployPlanLoaded(startDeploy(row).flow, { ok: true, plan }) as DeployFlow, '\r', true).flow as DeployFlow;
    expect(stepDeploy(dry, 'c').effect).toBeNull();
  });

  test('the outcome is shown on the screen: copied (with the count) or could not copy; the screen stays open', async () => {
    const done = await doneWith(WITH_PRS);
    const ok = applyDeployCopied(done, true) as Extract<DeployFlow, { step: 'done' }>;
    expect(strip(renderDeploy(ok, 120).lines.join('\n'))).toContain('Copied 2 PR links');
    const bad = applyDeployCopied(done, false) as Extract<DeployFlow, { step: 'done' }>;
    expect(strip(renderDeploy(bad, 120).lines.join('\n'))).toContain('Could not copy to clipboard');
    expect(bad.step).toBe('done');
    const one = applyDeployCopied(await doneWith(RESULT), true) as DeployFlow;
    expect(strip(renderDeploy(one, 120).lines.join('\n'))).toContain('Copied 1 PR link');
    expect(strip(renderDeploy(one, 120).lines.join('\n'))).not.toContain('Copied 1 PR links');
    // The exit text is the result alone: the copy line is not part of what is printed after the screen.
    expect(stepDeploy(ok, ESC).exitText).toBe(done.text);
    // A late answer is dropped once the flow has moved on.
    expect(applyDeployCopied(null, true)).toBeNull();
  });

  test('through the screen reducer: `c` on the result gives the effect and the screen stays; the answer lands on the result', async () => {
    const plan = await realPlan();
    const planned = applyDeployPlan(handleKey(initialSecretsScreenState([row], false), CTRL_D).state, { ok: true, plan });
    const finished = applyDeployRunDone(handleKey(planned, '\r').state, { ok: true, result: WITH_PRS });
    const pressed = handleKey(finished, 'c');
    expect(pressed.effect).toEqual({ type: 'copyToClipboard', text: `${URL_A}\n${URL_B}` });
    expect(pressed.state.quit).toBe(false);
    expect(pressed.state.deploy?.step).toBe('done');
    expect(strip(render(applyCopied(pressed.state, true), 120, 30))).toContain('Copied 2 PR links');
  });

  async function driveCopy(copy: (text: string) => Promise<boolean>) {
    const plan = await realPlan();
    const actions: SecretsDeployActions = { loadPlan: async () => ({ ok: true, plan }), run: async () => ({ ok: true, result: WITH_PRS }), cancel: () => undefined };
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const finished = runSecretsScreen([row], async () => ({ ok: false, code: 'NO' }), undefined, false, actions, copy);
    await wait();
    for (const k of [CTRL_D, 40, '\r', 40, 'c', 30, ESC]) {
      if (typeof k === 'number') await wait(k);
      else {
        process.stdin.emit('data', Buffer.from(k));
        await wait();
      }
    }
    await finished;
    const screen = outSpy.mock.calls.map((c) => String(c[0])).join('');
    outSpy.mockRestore();
    logSpy.mockRestore();
    return { screen };
  }

  test('the driver performs the effect with the injected clipboard function (never the real one) and draws the outcome', async () => {
    const copy = mock(async (_text: string) => true);
    const ok = await driveCopy(copy);
    expect(copy.mock.calls.map((c) => c[0])).toEqual([`${URL_A}\n${URL_B}`]);
    expect(strip(ok.screen)).toContain('Copied 2 PR links');

    const failing = mock(async (_text: string) => false);
    expect(strip((await driveCopy(failing)).screen)).toContain('Could not copy to clipboard');
    expect(failing.mock.calls).toHaveLength(1);

    const throwing = mock(async (_text: string): Promise<boolean> => {
      throw new Error('boom');
    });
    expect(strip((await driveCopy(throwing)).screen)).toContain('Could not copy to clipboard');
  });
});
