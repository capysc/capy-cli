/**
 * Stopping a `capy secrets` edit (engine, actions and the agent command): a stop is
 * checked BETWEEN items, so EVERY push or PR call already running finishes, none
 * is started, and the rest is reported as cancelled. Before the first push a stop
 * changes nothing. Progress is reported as items complete. Fakes only
 * (tests/helpers/secretsWorld.ts). Pushes run 6 at a time and PRs 4 at a time, so the
 * stop tests that need something left over use 10 locations / 6 repos.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  runSecretSet,
  type RunProgress,
  type RepoTarget,
  type SetLocation,
  type SetRequest,
} from '../../src/commands/secretsSet';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { renderSecretSetConfirmation, stoppingAfter } from '../../src/commands/secretsSetText';
import { runSecretsSet, withSigintControl, type SecretsSetIo } from '../../src/commands/secretsSetCommand';
import { ERROR_CODES } from '../../src/types/index';
import {
  LINKS,
  LOCATIONS,
  NAME,
  PROJECT_NAMES,
  SENTINEL,
  everythingSentTo,
  fakeGithub,
  fakeService,
  indexRows,
  makeEnv,
  manyLocs,
  manyRepos,
  standardRepos,
} from '../helpers/secretsWorld';

const loc = (project: 'pA' | 'pB' | 'pC' | 'pD', branch: string, isProtected = false): SetLocation => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  branch,
  protected: isProtected,
});

const FIVE: readonly SetLocation[] = [
  loc('pA', 'production', true),
  loc('pA', 'staging'),
  loc('pB', 'production', true),
  loc('pC', 'development'),
  loc('pD', 'development'),
];
const MONO: RepoTarget = {
  host: 'github.com',
  owner: 'Acme',
  name: 'mono',
  files: [
    { project_id: 'pA', project_name: PROJECT_NAMES.pA, path: 'backend' },
    { project_id: 'pB', project_name: PROJECT_NAMES.pB, path: 'frontend' },
  ],
};
const SOLO: RepoTarget = { host: 'github.com', owner: 'Acme', name: 'solo', files: [{ project_id: 'pC', project_name: PROJECT_NAMES.pC, path: '.' }] };

const request = (over: Partial<SetRequest> = {}): SetRequest => ({ name: NAME, value: SENTINEL, locations: FIVE, repos: [MONO, SOLO], bases: { 'github.com/acme/mono': 'main', 'github.com/acme/solo': 'trunk' }, ...over });

const TEN = manyLocs(10);
const TEN_SET: readonly SetLocation[] = TEN.map((l) => loc(l.project, l.branch, l.protected === true));
const TEN_REQUEST = (over: Partial<SetRequest> = {}): SetRequest => request({ locations: TEN_SET, ...over });

/** A service whose Nth push (1-based) calls `during` while it is in flight, then completes normally. */
function servicePushing(during: (n: number) => void | Promise<void>, locs?: readonly (typeof TEN)[number][]) {
  const base = fakeService(locs === undefined ? {} : { locs });
  const calls = mock((..._a: unknown[]) => undefined);
  const pushSecrets = mock(async (...args: Parameters<typeof base.pushSecrets>) => {
    calls(...args);
    await during(calls.mock.calls.length);
    return base.pushSecrets(...args);
  });
  return { ...base, pushSecrets, pushes: calls };
}

const progressOf = (events: readonly RunProgress[]) => events.map((e) => `${e.phase} ${e.done}/${e.total}`);

describe('stopping the pushes', () => {
  test('stopped before the first push: nothing is pushed, nothing is opened, every location is cancelled', async () => {
    const service = fakeService();
    const github = fakeGithub(standardRepos());
    const stop = new AbortController();
    stop.abort();
    const result = await runSecretSet(request(), makeEnv(service, github), { stopPushes: stop.signal });
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
    expect(service.getDecryptData.mock.calls).toHaveLength(0);
    expect(github.createPull.mock.calls).toHaveLength(0);
    expect(github.getRepo.mock.calls).toHaveLength(0);
    expect(result.updated).toEqual([]);
    expect(result.prs).toEqual([]);
    expect(result.cancelled).toHaveLength(5);
    expect(renderSecretSetConfirmation(result)).toBe('Cancelled. Nothing was changed.\n\nCancelled:\n' + FIVE.map((l) => `  ${l.project_name} · ${l.branch}`).join('\n'));
  });

  test('a stop with 6 pushes in flight: all 6 FINISH, none is started after, `cancelled` is exactly the 4 never started', async () => {
    const stop = new AbortController();
    const service = servicePushing((n) => (n === 2 ? stop.abort() : undefined), TEN);
    const github = fakeGithub(standardRepos(TEN));
    const onStopping = mock((_s: { phase: string; inFlight: number }) => undefined);
    const result = await runSecretSet(TEN_REQUEST(), makeEnv(service as never, github), { stopPushes: stop.signal, onStopping });
    expect(service.pushes.mock.calls).toHaveLength(6); // exactly the in-flight ones finished
    expect(result.updated.map((l) => `${l.project}/${l.branch}`)).toEqual(TEN.slice(0, 6).map((l) => `${PROJECT_NAMES[l.project]}/${l.branch}`));
    expect(result.cancelled).toEqual(TEN.slice(6).map((l) => ({ kind: 'location', project: PROJECT_NAMES[l.project], branch: l.branch, protected: false })));
    expect(result.failed).toEqual([]);
    expect(onStopping.mock.calls.map((c) => c[0])).toEqual([{ phase: 'pushing', inFlight: 6 }]);
  });

  test('PRs are still opened for what WAS pushed, and for nothing else', async () => {
    const stop = new AbortController();
    const service = servicePushing((n) => (n === 2 ? stop.abort() : undefined), TEN);
    const github = fakeGithub(standardRepos(TEN));
    const result = await runSecretSet(TEN_REQUEST(), makeEnv(service as never, github), { stopPushes: stop.signal });
    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/mono']); // solo's project (pC) was never pushed
    expect(result.prs[0].locations).toHaveLength(6);
    expect(github.createPull.mock.calls).toHaveLength(1);
    const text = renderSecretSetConfirmation(result);
    expect(text.split('\n')[0]).toBe(`✓ ${NAME} updated in 6 of 10 locations (cancelled).`);
    expect(text).toContain('https://github.com/Acme/mono/pull/4');
    expect(text).toContain('Cancelled:\n  ' + `${PROJECT_NAMES.pC} · br6`);
    expect(text).not.toContain('Acme/solo');
  });

  test('a stop never leaks the value', async () => {
    const stop = new AbortController();
    const service = servicePushing((n) => (n === 1 ? stop.abort() : undefined), TEN);
    const github = fakeGithub(standardRepos(TEN));
    const result = await runSecretSet(TEN_REQUEST(), makeEnv(service as never, github), { stopPushes: stop.signal });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(renderSecretSetConfirmation(result)).not.toContain(SENTINEL);
    expect(everythingSentTo(github.createBlob, github.createPull, github.createCommit)).not.toContain(SENTINEL);
  });
});

describe('stopping the PRs', () => {
  test('a stop with 4 PR calls in flight: all 4 finish, the other 2 repos get none and are listed as cancelled', async () => {
    const stop = new AbortController();
    const service = fakeService();
    const repos = manyRepos(6);
    const github = fakeGithub(repos.fixtures);
    const createPull = github.createPull;
    const hooked = {
      ...github,
      createPull: mock(async (...args: Parameters<typeof createPull>) => {
        stop.abort();
        return createPull(...args);
      }),
    };
    const onStopping = mock((_s: { phase: string; inFlight: number }) => undefined);
    const result = await runSecretSet(
      request({ locations: [loc('pC', 'development')], repos: repos.targets, bases: repos.bases }),
      makeEnv(service, hooked as never),
      { stopPrs: stop.signal, onStopping },
    );
    expect(result.updated).toHaveLength(1);
    expect(hooked.createPull.mock.calls).toHaveLength(4);
    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/repo1', 'Acme/repo2', 'Acme/repo3', 'Acme/repo4']);
    expect(result.cancelled).toEqual([{ kind: 'repo', repo: 'Acme/repo5' }, { kind: 'repo', repo: 'Acme/repo6' }]);
    expect(onStopping.mock.calls.map((c) => c[0])).toEqual([{ phase: 'prs', inFlight: 4 }]);
  });

  test('a stop during the first PR call (2 repos, both already running): both finish and nothing is cancelled', async () => {
    const stop = new AbortController();
    const service = fakeService();
    const github = fakeGithub(standardRepos());
    const createPull = github.createPull;
    const hooked = {
      ...github,
      createPull: mock(async (...args: Parameters<typeof createPull>) => {
        stop.abort();
        return createPull(...args);
      }),
    };
    const result = await runSecretSet(request(), makeEnv(service, hooked as never), { stopPrs: stop.signal });
    expect(result.updated).toHaveLength(5); // every location was pushed
    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/mono', 'Acme/solo']);
    expect(hooked.createPull.mock.calls).toHaveLength(2);
    expect(result.cancelled).toBeUndefined();
    expect(renderSecretSetConfirmation(result).split('\n')[0]).toBe(`✓ ${NAME} updated in 5 locations.`);
  });
});

describe('progress', () => {
  test('pushing then PRs, counted as each item FINISHES (with how many are running)', async () => {
    const onProgress = mock((_p: RunProgress) => undefined);
    await runSecretSet(request(), makeEnv(fakeService(), fakeGithub(standardRepos())), { onProgress });
    expect(progressOf(onProgress.mock.calls.map((c) => c[0]))).toEqual([
      'pushing 0/5', 'pushing 1/5', 'pushing 2/5', 'pushing 3/5', 'pushing 4/5', 'pushing 5/5',
      'prs 0/2', 'prs 1/2', 'prs 2/2',
    ]);
    const events = onProgress.mock.calls.map((c) => c[0]);
    expect(events[0]).toMatchObject({ phase: 'pushing', done: 0, inFlight: 0 });
    expect(events[5]).toMatchObject({ phase: 'pushing', done: 5, inFlight: 0 });
    expect(events.filter((e) => e.phase === 'pushing').map((e) => e.inFlight)).toEqual([0, 4, 3, 2, 1, 0]); // 5 start at once; the first to finish sees 4 left
  });

  test('the PR total is the repos that will get a PR, not every selected repo', async () => {
    const onProgress = mock((_p: RunProgress) => undefined);
    await runSecretSet(request({ locations: [loc('pC', 'development')] }), makeEnv(fakeService(), fakeGithub(standardRepos())), { onProgress });
    expect(onProgress.mock.calls.map((c) => c[0]).filter((e) => e.phase === 'prs').map((e) => e.total)).toEqual([1, 1]);
  });
});

describe('the TUI actions: cancel(phase)', () => {
  const links = LINKS;
  const makeActions = (env: ReturnType<typeof makeEnv>, dryRun = false) =>
    createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...links] }) }, 'org1', env, dryRun);

  test('cancel(planning) kills the default-branch read at once: it returns no bases, and nothing was ever pushed', async () => {
    const service = fakeService();
    const base = fakeGithub(standardRepos());
    const github = {
      ...base,
      // A read that stalls until its signal aborts, like the real runner killing a hung gh.
      getDefaultBranches: mock(
        (_repos: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise((resolve) => opts?.signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'REQUEST_FAILED' }), { once: true })),
      ),
    };
    const env = makeEnv(service, github as never);
    const actions = makeActions(env);
    const reading = actions.loadBases([MONO, SOLO]);
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    actions.cancel('planning');
    expect(await reading).toEqual({});
    expect(Date.now() - t0).toBeLessThan(500);
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
    expect(github.getRepo.mock.calls).toHaveLength(0); // no per-repo fallback after a cancel
  });

  test('cancel(pushing) while a push is in flight: it finishes, no other starts, progress reaches the caller, the result lists cancelled', async () => {
    const deferred = Promise.withResolvers<ReturnType<typeof makeActions>>();
    const service = servicePushing(async (n) => {
      if (n === 2) (await deferred.promise).cancel('pushing'); // the stop arrives while the 6 pushes are in flight
    }, TEN);
    const env = makeEnv(service as never, fakeGithub(standardRepos(TEN)));
    const actions = makeActions(env);
    deferred.resolve(actions);
    const onProgress = mock((_p: RunProgress) => undefined);
    const finished = await actions.run(TEN_REQUEST(), onProgress);
    expect(finished.ok && 'result' in finished).toBe(true);
    const result = finished.ok && 'result' in finished ? finished.result : undefined;
    expect(service.pushes.mock.calls).toHaveLength(6);
    expect(result?.updated).toHaveLength(6);
    expect(result?.cancelled).toHaveLength(4);
    const events = onProgress.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e.phase === 'pushing').at(-1)).toMatchObject({ done: 6, inFlight: 0, total: 10 });
    expect(events.find((e) => e.phase === 'pushing' && e.done === 0 && e.inFlight === 6)).toBeDefined(); // the stop was reported with 6 in flight
  });

  test('cancel(prs) stops after the PRs in flight', async () => {
    const deferred = Promise.withResolvers<ReturnType<typeof makeActions>>();
    const base = fakeGithub(manyRepos(6).fixtures);
    const github = {
      ...base,
      createPull: mock(async (...a: Parameters<typeof base.createPull>) => {
        (await deferred.promise).cancel('prs');
        return base.createPull(...a);
      }),
    };
    const actions = makeActions(makeEnv(fakeService(), github as never));
    deferred.resolve(actions);
    const repos = manyRepos(6);
    const finished = await actions.run(request({ locations: [loc('pC', 'development')], repos: repos.targets, bases: repos.bases }));
    const result = finished.ok && 'result' in finished ? finished.result : undefined;
    expect(github.createPull.mock.calls).toHaveLength(4);
    expect(result?.cancelled).toEqual([{ kind: 'repo', repo: 'Acme/repo5' }, { kind: 'repo', repo: 'Acme/repo6' }]);
  });

  test('a cancel with nothing running does nothing; a later run is not affected by an earlier planning cancel', async () => {
    const actions = makeActions(makeEnv(fakeService(), fakeGithub(standardRepos())));
    actions.cancel('planning');
    actions.cancel('pushing');
    const finished = await actions.run(request({ locations: [loc('pC', 'development')], repos: [] }));
    const result = finished.ok && 'result' in finished ? finished.result : undefined;
    expect(result?.updated).toHaveLength(1);
    expect(result?.cancelled).toBeUndefined();
  });
});

// ── the agent command: SIGINT ───────────────────────────────────────────────

describe('capy secrets set: SIGINT', () => {
  class ExitSignal extends Error {}
  async function capture(fn: () => Promise<number>) {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new ExitSignal('exit');
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const returned = await fn().catch((e: unknown) => (e instanceof ExitSignal ? undefined : Promise.reject(e)));
    const out = { returned, stdout: logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n'), stderr: errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
    [exitSpy, logSpy, errSpy].forEach((x) => x.mockRestore());
    return out;
  }

  function ioWith(service: ReturnType<typeof servicePushing>, stdin = `${SENTINEL}\n`): SecretsSetIo {
    const env = makeEnv(service as never, fakeGithub(standardRepos(TEN)));
    return {
      orgId: 'org1',
      client: { getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(TEN), skipped: [] }), getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) },
      env,
      stdinIsTTY: false,
      readStdin: async () => ({ ok: true as const, value: stdin.replace(/\n$/, '') }),
      peekStdin: async () => undefined,
    };
  }

  const planIdFor = async (io: SecretsSetIo): Promise<string> => {
    const out = await capture(() => runSecretsSet(NAME, { json: true, dryRun: true }, io));
    return (JSON.parse(out.stdout) as { plan_id: string }).plan_id;
  };

  test('SIGINT with 6 pushes in flight: all finish, the rest is `cancelled` in the JSON, ok false, code SECRETS_PARTIAL, exit 1, no value anywhere', async () => {
    const service = servicePushing((n) => {
      if (n === 2) process.emit('SIGINT');
    }, TEN);
    const io = ioWith(service);
    const planId = await planIdFor(io);
    service.pushes.mockClear();
    const out = await capture(() => withSigintControl((control) => runSecretsSet(NAME, { json: true, confirm: planId }, { ...io, control })));
    expect(out.returned).toBe(1);
    expect(service.pushes.mock.calls).toHaveLength(6);
    const body = JSON.parse(out.stdout) as Record<string, any>;
    expect(body).toMatchObject({ ok: false, code: ERROR_CODES.SECRETS_PARTIAL, plan_id: planId });
    expect(body.updated).toHaveLength(6);
    expect(body.cancelled).toHaveLength(4);
    expect(body.cancelled[0]).toEqual({ kind: 'location', project: PROJECT_NAMES.pC, branch: 'br6', protected: false });
    expect(body.failed).toEqual([]);
    expect(out.stdout + out.stderr).not.toContain(SENTINEL);
  });

  test('the first SIGINT is announced once on stderr in human mode; a second one also stops the PRs; the handler is removed afterwards', async () => {
    const before = process.listenerCount('SIGINT');
    const announce = mock(() => undefined);
    const service = servicePushing((n) => {
      if (n === 2) {
        process.emit('SIGINT');
        process.emit('SIGINT'); // impatient: stop the PRs too
      }
    }, TEN);
    const io = ioWith(service);
    const planId = await planIdFor(io);
    const out = await capture(() =>
      withSigintControl((control) => runSecretsSet(NAME, { json: true, confirm: planId }, { ...io, control }), announce),
    );
    expect(announce.mock.calls).toHaveLength(1);
    const body = JSON.parse(out.stdout) as Record<string, any>;
    expect(body.prs).toEqual([]); // the second SIGINT skipped the PR for what was pushed
    expect(body.cancelled.filter((c: { kind: string }) => c.kind === 'repo')).toEqual([{ kind: 'repo', repo: 'Acme/mono' }]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  test('human mode prints the confirmation for what happened, with the cancelled list, and says how many it is waiting for', async () => {
    const service = servicePushing((n) => {
      if (n === 1) process.emit('SIGINT');
    }, TEN);
    const io = ioWith(service);
    const planId = await planIdFor(io);
    const out = await capture(() => withSigintControl((control) => runSecretsSet(NAME, { confirm: planId }, { ...io, control })));
    expect(out.returned).toBe(1);
    expect(out.stdout).toContain(`✓ ${NAME} updated in 6 of 10 locations (cancelled).`);
    expect(out.stdout).toContain('Cancelled:');
    expect(out.stderr).toContain(stoppingAfter(6));
    expect(stoppingAfter(6)).toBe('Stopping after the 6 in progress…');
  });

  test('no SIGINT: exactly the old result, no `cancelled` key', async () => {
    const service = servicePushing(() => undefined, TEN);
    const io = ioWith(service);
    const planId = await planIdFor(io);
    const out = await capture(() => withSigintControl((control) => runSecretsSet(NAME, { json: true, confirm: planId }, { ...io, control })));
    expect(out.returned).toBe(0);
    expect(JSON.parse(out.stdout).cancelled).toBeUndefined();
  });
});
