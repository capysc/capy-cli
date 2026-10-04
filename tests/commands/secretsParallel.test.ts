/**
 * `capy secrets` runs in parallel (CAP-698): location pushes LOCATION_CONCURRENCY (6) at a
 * time, PRs PR_CONCURRENCY (4) at a time (the steps inside one repo stay in order),
 * results in INPUT order, progress counting finished items, pacing off the service's
 * rate-limit headers, and a bounded wait-and-retry when a rate limit says no. Fakes
 * only (tests/helpers/secretsWorld.ts): no service, no `gh`, no network. "In flight"
 * is read back from event logs recorded by `mock`s, so no test keeps a mutable counter.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  LOCATION_CONCURRENCY,
  PR_CONCURRENCY,
  runSecretSet,
  type RunProgress,
  type SetLocation,
  type SetRequest,
} from '../../src/commands/secretsSet';
import { renderSecretSetConfirmation } from '../../src/commands/secretsSetText';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { createGhApi, type GhRunner } from '../../src/deploy/githubApi';
import { RETRY_MAX_ATTEMPTS } from '../../src/utils/backoff';
import { PACING_RESERVE } from '../../src/utils/pool';
import {
  NAME,
  PROJECT_NAMES,
  SENTINEL,
  fakeGithub,
  fakeService,
  makeEnv,
  manyLocs,
  manyRepos,
  type Loc,
} from '../helpers/secretsWorld';

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const asLocation = (l: Loc): SetLocation => ({ project_id: l.project, project_name: PROJECT_NAMES[l.project], branch: l.branch, protected: l.protected === true });
const requestFor = (locs: readonly Loc[], over: Partial<SetRequest> = {}): SetRequest => ({
  name: NAME,
  value: SENTINEL,
  locations: locs.map(asLocation),
  repos: [],
  bases: {},
  ...over,
});
const keyOf = (l: { project: string; branch: string }): string => `${l.project}/${l.branch}`;

/** The most `+` not yet closed by a `-` at any point of the log. */
const maxOpen = (events: readonly string[]): number =>
  events.reduce(
    (acc, e) => {
      const open = acc.open + (e.startsWith('+') ? 1 : -1);
      return { open, max: Math.max(acc.max, open) };
    },
    { open: 0, max: 0 },
  ).max;

type Delay = (key: string) => number;
const ZERO: Delay = () => 0;

/** The fake service with latency per call and an event log: `+key` when a location's first call starts, `-key` when its push is done. */
function gaugedService(locs: readonly Loc[], delayOf: Delay = ZERO) {
  const base = fakeService({ locs });
  const log = mock((_event: string) => undefined);
  const getDecryptData = mock(async (projectId: string, branch?: string, keepHash?: string, latest?: boolean, onRate?: unknown) => {
    log(`+${projectId}/${branch}`);
    await sleepMs(delayOf(`${projectId}/${branch}`));
    return (base.getDecryptData as (...a: unknown[]) => Promise<unknown>)(projectId, branch, keepHash, latest, onRate) as ReturnType<typeof base.getDecryptData>;
  });
  const pushSecrets = mock(async (projectId: string, keep: string, blob: string, branch: string, _onRate?: unknown) => {
    await sleepMs(delayOf(`${projectId}/${branch}`));
    const pushed = await base.pushSecrets(projectId, keep, blob, branch);
    log(`-${projectId}/${branch}`);
    return pushed;
  });
  return { getDecryptData, pushSecrets, log, events: () => log.mock.calls.map((c) => c[0]) };
}

describe('location pushes: bounded concurrency', () => {
  test('the exported constants are 6 for locations and 4 for PRs', () => {
    expect(LOCATION_CONCURRENCY).toBe(6);
    expect(PR_CONCURRENCY).toBe(4);
  });

  test('with enough locations exactly 6 are in flight, never more', async () => {
    const locs = manyLocs(20);
    const service = gaugedService(locs, () => 8);
    const result = await runSecretSet(requestFor(locs), makeEnv(service as never, undefined));
    expect(result.updated).toHaveLength(20);
    expect(result.failed).toEqual([]);
    expect(maxOpen(service.events())).toBe(LOCATION_CONCURRENCY);
  });

  test('with fewer locations than the limit they all start at once', async () => {
    const locs = manyLocs(4);
    const service = gaugedService(locs, () => 8);
    await runSecretSet(requestFor(locs), makeEnv(service as never, undefined));
    expect(maxOpen(service.events())).toBe(4);
  });

  test('15 locations with latency run about 3x faster or better than one at a time', async () => {
    const locs = manyLocs(15);
    const latency = 20; // a read and a push per location
    const sequentialMs = locs.length * 2 * latency;
    const service = gaugedService(locs, () => latency);
    const t0 = performance.now();
    const result = await runSecretSet(requestFor(locs), makeEnv(service as never, undefined));
    const took = performance.now() - t0;
    expect(result.updated).toHaveLength(15);
    expect(took).toBeLessThan(sequentialMs / 3);
  });

  test('results stay in INPUT order when the locations finish in a shuffled order', async () => {
    const locs = manyLocs(12);
    // The first locations are the slowest: they finish last.
    const slow: Delay = (key) => 5 + 3 * (locs.length - locs.findIndex((l) => keyOf(l) === key));
    const service = gaugedService(locs, slow);
    const result = await runSecretSet(requestFor(locs), makeEnv(service as never, undefined));
    const finishOrder = service.events().filter((e) => e.startsWith('-')).map((e) => e.slice(1));
    expect(finishOrder).not.toEqual(locs.map(keyOf)); // completion really was shuffled
    expect(result.updated.map((l) => `${l.project}/${l.branch}`)).toEqual(locs.map((l) => `${PROJECT_NAMES[l.project]}/${l.branch}`));
  });

  test('failed and unchanged locations also come back in input order', async () => {
    const locs = manyLocs(12);
    const service = fakeService({
      locs: locs.map((l, i) => (i % 4 === 1 ? { ...l, value: SENTINEL } : l)),
      failPush: { [keyOf(locs[2])]: ERROR_CODES.PERMISSION_DENIED, [keyOf(locs[7])]: ERROR_CODES.SERVICE_ERROR },
    });
    const result = await runSecretSet(requestFor(locs), makeEnv(service, undefined));
    expect(result.unchanged.map((l) => l.branch)).toEqual(['br1', 'br5', 'br9']);
    expect(result.failed.map((f) => (f.kind === 'location' ? `${f.branch}:${f.code}` : ''))).toEqual([`br2:${ERROR_CODES.PERMISSION_DENIED}`, `br7:${ERROR_CODES.SERVICE_ERROR}`]);
    expect(result.updated.map((l) => l.branch)).toEqual(['br0', 'br3', 'br4', 'br6', 'br8', 'br10', 'br11']);
  });

  test('progress counts FINISHED items, one event per finish, and the in-flight number stays under 6', async () => {
    const locs = manyLocs(14);
    const onProgress = mock((_p: RunProgress) => undefined);
    await runSecretSet(requestFor(locs), makeEnv(gaugedService(locs, () => 3) as never, undefined), { onProgress });
    const events = onProgress.mock.calls.map((c) => c[0]).filter((e) => e.phase === 'pushing');
    expect(events.map((e) => e.done)).toEqual(Array.from({ length: 15 }, (_, i) => i)); // 0 at the start, then 1..14
    expect(Math.max(...events.map((e) => e.inFlight))).toBe(5); // counted after each finish: 6 were running, one just ended
    expect(events.every((e) => e.total === 14)).toBe(true);
    expect(events.at(-1)).toMatchObject({ done: 14, inFlight: 0 });
  });
});

/** A fake GitHub that logs `+repo:method` / `-repo:method` around every call, with a delay per repo. */
function gaugedGithub(repos: ReturnType<typeof manyRepos>, delayOf: (repo: string) => number = () => 4) {
  const inner = fakeGithub(repos.fixtures);
  const log = mock((_e: string) => undefined);
  const methods = ['getBranchHead', 'getFile', 'createBlob', 'createTree', 'createCommit', 'createRef', 'createPull'] as const;
  const wrapped = Object.fromEntries(
    methods.map((m) => [
      m,
      async (repo: { name: string }, ...rest: unknown[]) => {
        log(`+${repo.name}:${m}`);
        await sleepMs(delayOf(repo.name));
        const answer = await (inner[m] as (...a: unknown[]) => Promise<unknown>)(repo, ...rest);
        log(`-${repo.name}:${m}`);
        return answer;
      },
    ]),
  );
  return { api: { ...inner, ...wrapped } as unknown as typeof inner, events: () => log.mock.calls.map((c) => c[0]) };
}

/** How many repos are mid-way (their first call started, their last not yet ended) at the busiest moment. */
const maxReposOpen = (events: readonly string[], names: readonly string[]): number => {
  const span = (name: string) => ({
    from: events.findIndex((e) => e.startsWith(`+${name}:`)),
    to: events.findLastIndex((e) => e.startsWith(`-${name}:`)),
  });
  const spans = names.map(span);
  return Math.max(...events.map((_, i) => spans.filter((s) => s.from <= i && i <= s.to).length));
};

describe('PRs: bounded concurrency, steps within a repo in order', () => {
  const onePush = [asLocation({ project: 'pC', branch: 'br0' })];

  test('with enough repos exactly 4 PRs are in flight, never more', async () => {
    const repos = manyRepos(10);
    const github = gaugedGithub(repos);
    const result = await runSecretSet(
      requestFor([], { locations: onePush, repos: repos.targets, bases: repos.bases }),
      makeEnv(fakeService({ locs: [{ project: 'pC', branch: 'br0' }] }), github.api),
    );
    expect(result.prs).toHaveLength(10);
    expect(maxReposOpen(github.events(), repos.targets.map((t) => t.name))).toBe(PR_CONCURRENCY);
  });

  test('inside each repo the calls are strictly one after the other, in the same order for every repo', async () => {
    const repos = manyRepos(6);
    const github = gaugedGithub(repos, (repo) => 2 + (repo.length % 3));
    await runSecretSet(
      requestFor([], { locations: onePush, repos: repos.targets, bases: repos.bases }),
      makeEnv(fakeService({ locs: [{ project: 'pC', branch: 'br0' }] }), github.api),
    );
    const sequences = repos.targets.map((t) => github.events().filter((e) => e.slice(1).startsWith(`${t.name}:`)).map((e) => `${e[0]}${e.split(':')[1]}`));
    const oneRepo = sequences[0];
    expect(oneRepo.length).toBeGreaterThan(8);
    // strictly alternating start / end of ONE call at a time
    expect(oneRepo.every((e, i) => e.startsWith(i % 2 === 0 ? '+' : '-'))).toBe(true);
    expect(oneRepo.at(-2)).toBe('+createPull');
    sequences.forEach((s) => expect(s).toEqual(oneRepo));
  });

  test('PRs come back in INPUT order when the repos finish in a shuffled order', async () => {
    const repos = manyRepos(8);
    // repo1 is the slowest, repo8 the fastest.
    const github = gaugedGithub(repos, (repo) => 4 + 3 * (9 - Number(repo.replace('repo', ''))));
    const result = await runSecretSet(
      requestFor([], { locations: onePush, repos: repos.targets, bases: repos.bases }),
      makeEnv(fakeService({ locs: [{ project: 'pC', branch: 'br0' }] }), github.api),
    );
    const firstDone = github.events().find((e) => e.startsWith('-') && e.endsWith(':createPull'));
    expect(firstDone).not.toBe('-repo1:createPull'); // completion really was shuffled
    expect(result.prs.map((p) => p.repo)).toEqual(repos.targets.map((t) => `Acme/${t.name}`));
    expect(renderSecretSetConfirmation(result).indexOf('Acme/repo1')).toBeLessThan(renderSecretSetConfirmation(result).indexOf('Acme/repo8'));
  });

  test('PR progress counts finished repos', async () => {
    const repos = manyRepos(6);
    const onProgress = mock((_p: RunProgress) => undefined);
    await runSecretSet(
      requestFor([], { locations: onePush, repos: repos.targets, bases: repos.bases }),
      makeEnv(fakeService({ locs: [{ project: 'pC', branch: 'br0' }] }), gaugedGithub(repos).api),
      { onProgress },
    );
    const prs = onProgress.mock.calls.map((c) => c[0]).filter((e) => e.phase === 'prs');
    expect(prs.map((e) => e.done)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Math.max(...prs.map((e) => e.inFlight))).toBe(3); // 4 were running, one just ended
  });
});

// ── Capy 429 ────────────────────────────────────────────────────────────────

const rateLimited = (retryAfterMs?: number): CapyError =>
  new CapyError('Too many requests.', ERROR_CODES.RATE_LIMITED, { status: 429, ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }) });

/** The fake service where reads (or pushes) of one location answer 429 for the first `times` calls (all of them when `Infinity`). */
function limitedService(locs: readonly Loc[], target: Loc, over: 'read' | 'push', times: number, retryAfterMs?: number) {
  const base = fakeService({ locs });
  const reads = mock(async (...a: Parameters<typeof base.getDecryptData>) => {
    const attempts = reads.mock.calls.filter((c) => c[0] === target.project && c[1] === target.branch).length;
    if (over === 'read' && a[0] === target.project && a[1] === target.branch && attempts <= times) throw rateLimited(retryAfterMs);
    return base.getDecryptData(...a);
  });
  const pushes = mock(async (...a: Parameters<typeof base.pushSecrets>) => {
    const attempts = pushes.mock.calls.filter((c) => c[0] === target.project && c[3] === target.branch).length;
    if (over === 'push' && a[0] === target.project && a[3] === target.branch && attempts <= times) throw rateLimited(retryAfterMs);
    return base.pushSecrets(...a);
  });
  return { getDecryptData: reads, pushSecrets: pushes };
}

const instantSleep = () => mock(async (_ms: number) => undefined);

describe('Capy 429: wait and retry, then fail only that item with RATE_LIMITED', () => {
  const locs = manyLocs(8);
  const target = locs[3];

  test('a 429 then success: the location is updated, after waiting what the server asked', async () => {
    const service = limitedService(locs, target, 'read', 2, 1500);
    const sleep = instantSleep();
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(service as never, undefined), sleep });
    expect(result.failed).toEqual([]);
    expect(result.updated).toHaveLength(8);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1500, 1500]);
    expect(service.getDecryptData.mock.calls.filter((c) => c[1] === target.branch)).toHaveLength(3);
  });

  test('without a hint the wait grows 2s, 4s, 8s', async () => {
    const service = limitedService(locs, target, 'push', 3);
    const sleep = instantSleep();
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(service as never, undefined), sleep });
    expect(result.updated).toHaveLength(8);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  test('a read that stays limited: that location fails with RATE_LIMITED after the bounded attempts, the others are untouched', async () => {
    const service = limitedService(locs, target, 'read', Infinity);
    const sleep = instantSleep();
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(service as never, undefined), sleep });
    expect(RETRY_MAX_ATTEMPTS).toBe(4);
    expect(service.getDecryptData.mock.calls.filter((c) => c[1] === target.branch)).toHaveLength(RETRY_MAX_ATTEMPTS);
    expect(sleep.mock.calls).toHaveLength(RETRY_MAX_ATTEMPTS - 1);
    expect(result.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES[target.project], branch: target.branch, protected: false, code: 'RATE_LIMITED' }]);
    expect(result.updated).toHaveLength(7);
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
  });

  test('a push that stays limited fails only that location', async () => {
    const service = limitedService(locs, target, 'push', Infinity, 100);
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(service as never, undefined), sleep: instantSleep() });
    expect(result.failed.map((f) => (f.kind === 'location' ? f.code : f.kind))).toEqual(['RATE_LIMITED']);
    expect(service.pushSecrets.mock.calls.filter((c) => c[3] === target.branch)).toHaveLength(RETRY_MAX_ATTEMPTS);
    expect(result.updated).toHaveLength(7);
  });

  test('a long server hint is capped, never waited out in full', async () => {
    const service = limitedService(locs, target, 'read', 1, 10 * 60_000);
    const sleep = instantSleep();
    await runSecretSet(requestFor(locs), { ...makeEnv(service as never, undefined), sleep });
    expect(sleep.mock.calls[0][0]).toBe(60_000);
  });

  test('a 429 is recognised by its CODE, not its message: another code with the same words is not retried', async () => {
    const base = fakeService({ locs });
    const reads = mock(async (...a: Parameters<typeof base.getDecryptData>) => {
      if (a[1] === target.branch) throw new CapyError('Too many requests.', ERROR_CODES.SERVICE_ERROR);
      return base.getDecryptData(...a);
    });
    const sleep = instantSleep();
    const result = await runSecretSet(requestFor(locs), { ...makeEnv({ ...base, getDecryptData: reads } as never, undefined), sleep });
    expect(reads.mock.calls.filter((c) => c[1] === target.branch)).toHaveLength(1);
    expect(sleep.mock.calls).toHaveLength(0);
    expect(result.failed.map((f) => (f.kind === 'location' ? f.code : ''))).toEqual([ERROR_CODES.SERVICE_ERROR]);
  });
});

// ── Pacing from the RateLimit headers ───────────────────────────────────────

describe('pacing: stop starting pushes when the window is nearly used up, until it resets', () => {
  const locs = manyLocs(12);
  const RESET_AT = 6000;

  /** A world with a fake clock: it reads 1000 until the run first waits, then 6000 (the window has reset). */
  function pacedWorld(remainingBeforeReset: number) {
    const base = fakeService({ locs });
    const log = mock((_e: string) => undefined);
    const sleep = mock(async (ms: number) => {
      log(`sleep:${ms}`);
    });
    const now = (): number => (log.mock.calls.some((c) => c[0].startsWith('sleep:')) ? RESET_AT : 1000);
    const report = (onRate: unknown) =>
      (onRate as ((r: { remaining: number; resetAt: number }) => void) | undefined)?.({ remaining: now() < RESET_AT ? remainingBeforeReset : 99, resetAt: RESET_AT });
    const getDecryptData = mock(async (projectId: string, branch?: string, keepHash?: string, latest?: boolean, onRate?: unknown) => {
      log(`start:${branch}`);
      report(onRate);
      await sleepMs(3);
      return base.getDecryptData(projectId, branch);
    });
    const pushSecrets = mock(async (projectId: string, keep: string, blob: string, branch: string, onRate?: unknown) => {
      report(onRate);
      await sleepMs(3);
      return base.pushSecrets(projectId, keep, blob, branch);
    });
    return { service: { getDecryptData, pushSecrets }, sleep, now, events: () => log.mock.calls.map((c) => c[0]) };
  }

  test('the reserve is a small constant', () => {
    expect(PACING_RESERVE).toBe(5);
  });

  test('remaining at the reserve: no new location starts until the reset (the 5 s the headers said), then the rest go', async () => {
    const world = pacedWorld(PACING_RESERVE - 2);
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(world.service as never, undefined), sleep: world.sleep, now: world.now });
    expect(result.updated).toHaveLength(12);
    const events = world.events();
    const firstSleep = events.findIndex((e) => e.startsWith('sleep:'));
    expect(firstSleep).toBeGreaterThan(-1);
    expect(events[firstSleep]).toBe('sleep:5000'); // resetAt - now
    const startsBefore = events.slice(0, firstSleep).filter((e) => e.startsWith('start:'));
    expect(startsBefore).toHaveLength(LOCATION_CONCURRENCY); // the first window of 6 only
    expect(events.slice(firstSleep).filter((e) => e.startsWith('start:'))).toHaveLength(6); // the rest, after the reset
  });

  test('plenty remaining: no waiting at all', async () => {
    const world = pacedWorld(99);
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(world.service as never, undefined), sleep: world.sleep, now: world.now });
    expect(result.updated).toHaveLength(12);
    expect(world.sleep.mock.calls).toHaveLength(0);
  });

  test('a stop during the pause starts nothing and lists the rest as cancelled', async () => {
    const world = pacedWorld(0);
    const stop = new AbortController();
    const sleepThenStop = mock(async (_ms: number) => {
      stop.abort();
    });
    const result = await runSecretSet(requestFor(locs), { ...makeEnv(world.service as never, undefined), sleep: sleepThenStop, now: () => 1000 }, { stopPushes: stop.signal });
    expect(result.updated).toHaveLength(6);
    expect(result.cancelled).toHaveLength(6);
  });
});

// ── Cancel with concurrency ─────────────────────────────────────────────────

describe('cancel with several in flight', () => {
  test('every running push finishes, none starts after, `cancelled` is exactly the never-started ones, in input order', async () => {
    const locs = manyLocs(16);
    const stop = new AbortController();
    const service = gaugedService(locs, () => 10);
    const stopLater = mock(async (...a: Parameters<typeof service.getDecryptData>) => {
      if (service.getDecryptData.mock.calls.length === 4) stop.abort(); // while 4 of the 6 have started and none finished
      return service.getDecryptData(...a);
    });
    const onStopping = mock((_s: { phase: string; inFlight: number }) => undefined);
    const result = await runSecretSet(
      requestFor(locs),
      makeEnv({ getDecryptData: stopLater, pushSecrets: service.pushSecrets } as never, undefined),
      { stopPushes: stop.signal, onStopping },
    );
    const started = service.events().filter((e) => e.startsWith('+')).map((e) => e.slice(1));
    expect(started).toHaveLength(6);
    expect(result.updated).toHaveLength(6);
    expect(service.events().filter((e) => e.startsWith('-'))).toHaveLength(6); // all finished
    expect(result.cancelled).toEqual(locs.slice(6).map((l) => ({ kind: 'location', project: PROJECT_NAMES[l.project], branch: l.branch, protected: false })));
    expect(onStopping.mock.calls[0][0]).toEqual({ phase: 'pushing', inFlight: 6 });
    expect(onStopping.mock.calls).toHaveLength(1);
  });

  test('a second stop request while waiting changes nothing: the running ones are still waited for', async () => {
    const locs = manyLocs(10);
    const stop = new AbortController();
    const service = gaugedService(locs, () => 10);
    const stopTwice = mock(async (...a: Parameters<typeof service.getDecryptData>) => {
      if (service.getDecryptData.mock.calls.length === 2) {
        stop.abort();
        stop.abort();
      }
      return service.getDecryptData(...a);
    });
    const result = await runSecretSet(requestFor(locs), makeEnv({ getDecryptData: stopTwice, pushSecrets: service.pushSecrets } as never, undefined), { stopPushes: stop.signal });
    expect(result.updated).toHaveLength(6);
    expect(result.cancelled).toHaveLength(4);
  });
});

// ── GitHub secondary limits ─────────────────────────────────────────────────

describe('GitHub rate limits', () => {
  const included = (status: number, headers: Readonly<Record<string, string>>, body = '{"default_branch":"main"}'): string =>
    `HTTP/2.0 ${status} X\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`;
  const runnerOf = (answers: (n: number) => string): { run: GhRunner; calls: () => number } => {
    const run = mock(async () => ({ spawned: true, status: 0, stdout: answers(run.mock.calls.length) }));
    return { run: run as unknown as GhRunner, calls: () => run.mock.calls.length };
  };

  test('429 then success: retried after the wait GitHub asked for', async () => {
    const r = runnerOf((n) => (n === 1 ? included(429, { 'retry-after': '3' }) : included(200, {})));
    const sleep = instantSleep();
    const got = await createGhApi(r.run, sleep).getRepo({ owner: 'a', name: 'b' });
    expect(got).toEqual({ ok: true, value: { defaultBranch: 'main' } });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000]);
  });

  test('403 with retry-after is a secondary limit: retried; still limited after the bounded attempts is RATE_LIMITED', async () => {
    const r = runnerOf(() => included(403, { 'retry-after': '2' }));
    const sleep = instantSleep();
    const got = await createGhApi(r.run, sleep).getRepo({ owner: 'a', name: 'b' });
    expect(got).toMatchObject({ ok: false, kind: 'RATE_LIMITED', status: 403 });
    expect(r.calls()).toBe(RETRY_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000, 2000]);
  });

  test('403 with x-ratelimit-remaining: 0 is a limit too, backing off 2s, 4s, 8s when no wait is given', async () => {
    const r = runnerOf(() => included(403, { 'x-ratelimit-remaining': '0' }));
    const sleep = instantSleep();
    const got = await createGhApi(r.run, sleep).getRepo({ owner: 'a', name: 'b' });
    expect(got).toMatchObject({ ok: false, kind: 'RATE_LIMITED' });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  test('a plain 403 (permission) is not a limit: one call, no waiting', async () => {
    const r = runnerOf(() => included(403, { 'x-ratelimit-remaining': '4999' }));
    const sleep = instantSleep();
    const got = await createGhApi(r.run, sleep).getRepo({ owner: 'a', name: 'b' });
    expect(got).toMatchObject({ ok: false, kind: 'REQUEST_FAILED', status: 403 });
    expect(r.calls()).toBe(1);
    expect(sleep.mock.calls).toHaveLength(0);
  });

  test('a body that SAYS "rate limit" on a 500 is not a limit: only status and headers decide', async () => {
    const r = runnerOf(() => included(500, {}, '{"message":"API rate limit exceeded; secondary rate limit"}'));
    const got = await createGhApi(r.run, instantSleep()).getRepo({ owner: 'a', name: 'b' });
    expect(got).toMatchObject({ ok: false, kind: 'REQUEST_FAILED', status: 500 });
    expect(r.calls()).toBe(1);
  });

  test('a repo GitHub keeps limiting fails with GITHUB_RATE_LIMITED; the other repos still get their PR', async () => {
    const repos = manyRepos(5);
    const inner = fakeGithub(repos.fixtures);
    const github = {
      ...inner,
      createPull: mock(async (repo: { name: string }, ...rest: unknown[]) =>
        repo.name === 'repo3'
          ? { ok: false as const, kind: 'RATE_LIMITED' as const, status: 403 }
          : (inner.createPull as (...a: unknown[]) => unknown)(repo, ...rest),
      ),
    };
    const result = await runSecretSet(
      requestFor([], { locations: [asLocation({ project: 'pC', branch: 'br0' })], repos: repos.targets, bases: repos.bases }),
      makeEnv(fakeService({ locs: [{ project: 'pC', branch: 'br0' }] }), github as never),
    );
    expect(result.failed).toEqual([{ kind: 'repo', repo: 'Acme/repo3', code: 'GITHUB_RATE_LIMITED' }]);
    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/repo1', 'Acme/repo2', 'Acme/repo4', 'Acme/repo5']);
    expect(ERROR_CODES.GITHUB_RATE_LIMITED).toBe('GITHUB_RATE_LIMITED');
    expect(renderSecretSetConfirmation(result)).toContain('GITHUB_RATE_LIMITED');
  });
});
