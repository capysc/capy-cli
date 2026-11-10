/**
 * `capy secrets set`: a location is `updated` only when the service, read back after the push, holds what was sent,
 * and the locations of ONE project are pushed one after another.
 *
 * Why: all branches of a project share one stored file on the service, so two pushes to branches of one project that
 * overlap in time can overwrite each other while both answer success. The engine used to call a location `updated` as
 * soon as its push was answered, and it started six pushes at once whatever the projects.
 *
 * The service here is tests/helpers/secretsWorld.ts (fakeService): it remembers the pushes it accepted and answers reads from
 * them, and it can be told to answer a push and not keep it. Nothing touches a network, `gh`, git or a home directory.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { FileManager } from '../../src/files/fileManager';
import { runSecretSet, type SetEnv, type SetLocation } from '../../src/commands/secretsSet';
import { runSecretsSet, type SecretsSetIo, type SecretsSetOpts } from '../../src/commands/secretsSetCommand';
import { MAX_PIPED_BYTES, readPipedValue } from '../../src/commands/pipedValue';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { hashValue } from '../../src/deploy/keepGate';
import {
  KEYS,
  LINKS,
  LOCATIONS,
  NAME,
  OLD_VALUE,
  PROJECT_NAMES,
  SENTINEL,
  fakeGithub,
  fakeService,
  locationKey,
  overlap,
  windowsOf,
  indexRows,
  makeEnv,
  standardRepos,
  type ProjectId,
  type ServiceOpts,
} from '../helpers/secretsWorld';

const loc = (project: ProjectId, branch: string, isProtected = false): SetLocation => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  branch,
  protected: isProtected,
});

/** Two branches of one project plus two more projects: the shape of the report, scaled to the fixtures. */
const ALL: readonly SetLocation[] = [loc('pA', 'production', true), loc('pA', 'staging'), loc('pB', 'production', true), loc('pC', 'development')];

const STAGING = 'pA/staging';

const envFor = (service: ReturnType<typeof fakeService>) => {
  const github = fakeGithub(standardRepos(LOCATIONS));
  const made = makeEnv(service as never, github);
  return { ...made, client: service as unknown as SetEnv['client'] };
};

const run = (service: ReturnType<typeof fakeService>, locations: readonly SetLocation[] = ALL) =>
  runSecretSet({ name: NAME, value: SENTINEL, locations, repos: [] }, envFor(service));

/** What NAME holds at a location on the service now, decrypted with the project's key; `undefined` when the line is missing. */
async function heldValue(service: ReturnType<typeof fakeService>, l: SetLocation): Promise<string | undefined> {
  const data = await service.getDecryptData(l.project_id, l.branch);
  const line = data.env_content.split('\n').find((x) => x.startsWith(`${NAME}=`));
  return line === undefined ? undefined : new FileManager().decryptValue(line.slice(NAME.length + 1), KEYS[l.project_id as ProjectId]);
}

const label = (l: SetLocation) => `${l.project_name}/${l.branch}`;
const labelOf = (r: { readonly project: string; readonly branch: string }) => `${r.project}/${r.branch}`;

describe('read-back: what is reported updated is what the service holds', () => {
  test('control: every push kept, every location is updated, read back once each, pushed once each', async () => {
    const service = fakeService();
    const result = await run(service);
    expect(result.failed).toEqual([]);
    expect(result.updated.map(labelOf)).toEqual(ALL.map(label));
    // One plan read and one read-back per location, one push; counted before the test reads anything itself.
    expect(ALL.map((l) => service.pushesTo(locationKey(l.project_id, l.branch)))).toEqual([1, 1, 1, 1]);
    expect(ALL.map((l) => service.readsOf(locationKey(l.project_id, l.branch)))).toEqual([2, 2, 2, 2]);
    expect((await Promise.all(ALL.map((l) => heldValue(service, l)))).every((v) => v === SENTINEL)).toBe(true);
  });

  test('a push the service answers and does not keep is pushed once more; still missing: failed SECRET_NOT_PERSISTED, never updated', async () => {
    const service = fakeService({ loses: (location) => location === STAGING });
    const result = await run(service);
    expect(result.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.SECRET_NOT_PERSISTED }]);
    expect(result.updated.map(labelOf)).not.toContain(`${PROJECT_NAMES.pA}/staging`);
    // Exactly one retry: two pushes for the location that is lost, one for each other.
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(service.pushesTo('pA/production')).toBe(1);
    // The others are untouched by the failure.
    expect(result.updated.map(labelOf)).toEqual([`${PROJECT_NAMES.pA}/production`, `${PROJECT_NAMES.pB}/production`, `${PROJECT_NAMES.pC}/development`]);
    // The property: nothing reported updated reads back with anything but the new value.
    const reported = ALL.filter((l) => result.updated.map(labelOf).includes(label(l)));
    expect((await Promise.all(reported.map((l) => heldValue(service, l)))).every((v) => v === SENTINEL)).toBe(true);
  });

  test('a failed read-back leaves no cache that says the push worked', async () => {
    const service = fakeService({ loses: (location) => location === STAGING });
    const env = envFor(service);
    await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [] }, env);
    const cachedProjects = env.writeCache.mock.calls.map((c) => `${String(c[1])}`);
    expect(cachedProjects).toHaveLength(3);
    expect(env.writeCache.mock.calls.every((c) => !String(c[3]).includes(SENTINEL))).toBe(true);
  });

  test('a location that reads back correctly on the retry is updated (the first push was lost)', async () => {
    const service = fakeService({ loses: (location, n) => location === STAGING && n === 0 });
    const result = await run(service);
    expect(result.failed).toEqual([]);
    expect(result.updated.map(labelOf)).toContain(`${PROJECT_NAMES.pA}/staging`);
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(await heldValue(service, ALL[1])).toBe(SENTINEL);
  });

  test('the blob is right but the pin was wiped: pushed again with the blob line rewritten, then updated', async () => {
    const service = fakeService({ wipesPin: (location, n) => location === STAGING && n === 0 });
    const result = await run(service);
    expect(result.failed).toEqual([]);
    expect(result.updated.map(labelOf)).toContain(`${PROJECT_NAMES.pA}/staging`);
    expect(service.pushesTo(STAGING)).toBe(2);
    const heldKeep = JSON.parse((await service.getDecryptData('pA', 'staging')).keep_file) as { variables: Record<string, Array<{ branch: string; value_hash: string }>> };
    expect(heldKeep.variables[NAME].find((e) => e.branch === 'staging')?.value_hash).toBeDefined();
    expect(await heldValue(service, ALL[1])).toBe(SENTINEL);
  });

  test('the pin stays wiped on the retry too: failed SECRET_NOT_PERSISTED', async () => {
    const service = fakeService({ wipesPin: (location) => location === STAGING });
    const result = await run(service);
    expect(result.failed.map((f) => (f.kind === 'location' ? f.code : undefined))).toEqual([ERROR_CODES.SECRET_NOT_PERSISTED]);
    expect(service.pushesTo(STAGING)).toBe(2);
  });

  test('a read-back that cannot be read is failed with that read error code and is not retried', async () => {
    // Read number 0 is the plan read, number 1 is the read-back.
    const service = fakeService({
      readError: (location, n) => (location === STAGING && n === 1 ? new CapyError('x', ERROR_CODES.PERMISSION_DENIED) : undefined),
    });
    const result = await run(service);
    expect(result.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.PERMISSION_DENIED }]);
    expect(result.updated.map(labelOf)).not.toContain(`${PROJECT_NAMES.pA}/staging`);
    expect(service.pushesTo(STAGING)).toBe(1);
  });
});

describe('a removal (the answer `delete` at a location that moved) is read back too', () => {
  const MOVED = 'moved-by-someone-else-2222';
  const world: ServiceOpts['locs'] = [{ project: 'pA', branch: 'staging', value: MOVED }];
  const removeRequest = {
    name: NAME,
    value: SENTINEL,
    locations: [loc('pA', 'staging')],
    repos: [],
    shown: { [STAGING]: hashValue(OLD_VALUE) },
    answers: { [STAGING]: { choice: 'delete' as const, remote: hashValue(MOVED), local: hashValue(SENTINEL) } },
  };
  const heldPin = async (service: ReturnType<typeof fakeService>) =>
    (JSON.parse((await service.getDecryptData('pA', 'staging')).keep_file) as { variables: Record<string, Array<{ branch: string }>> }).variables[NAME]?.some((e) => e.branch === 'staging');

  test('control: the line and the pin are gone after one push: removed, read back once', async () => {
    const service = fakeService({ locs: world });
    const result = await runSecretSet(removeRequest, envFor(service));
    expect(result.failed).toEqual([]);
    expect(result.removed?.map(labelOf)).toEqual([`${PROJECT_NAMES.pA}/staging`]);
    expect(service.pushesTo(STAGING)).toBe(1);
    expect(service.readsOf(STAGING)).toBe(2);
  });

  test('the blob line is gone but the pin stayed: pushed again with the pin dropped, then removed (never "unchanged")', async () => {
    const service = fakeService({ locs: world, wipesPin: (location, n) => location === STAGING && n === 0 });
    const result = await runSecretSet(removeRequest, envFor(service));
    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.removed?.map(labelOf)).toEqual([`${PROJECT_NAMES.pA}/staging`]);
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(await heldPin(service)).toBeFalsy();
  });

  test('the pin stays on the retry too: failed SECRET_NOT_PERSISTED, never removed or unchanged', async () => {
    const service = fakeService({ locs: world, wipesPin: (location) => location === STAGING });
    const result = await runSecretSet(removeRequest, envFor(service));
    expect(result.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.SECRET_NOT_PERSISTED }]);
    expect(result.removed).toBeUndefined();
    expect(result.unchanged).toEqual([]);
    expect(service.pushesTo(STAGING)).toBe(2);
  });

  test('the push was lost: pushed once more and removed', async () => {
    const service = fakeService({ locs: world, loses: (location, n) => location === STAGING && n === 0 });
    const result = await runSecretSet(removeRequest, envFor(service));
    expect(result.removed?.map(labelOf)).toEqual([`${PROJECT_NAMES.pA}/staging`]);
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(await heldPin(service)).toBeFalsy();
  });
});

describe('KEEP_WRITE_CONFLICT: a save the service could not complete', () => {
  const conflict = () => new CapyError('the words do not matter', ERROR_CODES.KEEP_WRITE_CONFLICT);

  test('refused once: pushed once more and updated', async () => {
    const service = fakeService({ pushError: (location, n) => (location === STAGING && n === 0 ? conflict() : undefined) });
    const result = await run(service);
    expect(result.failed).toEqual([]);
    expect(result.updated.map(labelOf)).toContain(`${PROJECT_NAMES.pA}/staging`);
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(await heldValue(service, ALL[1])).toBe(SENTINEL);
  });

  test('refused twice: failed with KEEP_WRITE_CONFLICT after exactly one retry, the others untouched', async () => {
    const service = fakeService({ pushError: (location) => (location === STAGING ? conflict() : undefined) });
    const result = await run(service);
    expect(result.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.KEEP_WRITE_CONFLICT }]);
    expect(service.pushesTo(STAGING)).toBe(2);
    expect(result.updated).toHaveLength(3);
  });

  test('a refusal that is a conflict in words only (another code) is not retried', async () => {
    const service = fakeService({ pushError: (location) => (location === STAGING ? new CapyError('KEEP_WRITE_CONFLICT conflict', ERROR_CODES.SERVICE_ERROR) : undefined) });
    const result = await run(service);
    expect(result.failed.map((f) => (f.kind === 'location' ? f.code : undefined))).toEqual([ERROR_CODES.SERVICE_ERROR]);
    expect(service.pushesTo(STAGING)).toBe(1);
  });

  test('a refused push after a lost one shares the one retry: failed, not a third push', async () => {
    const service = fakeService({
      loses: (location, n) => location === STAGING && n === 0,
      pushError: (location, n) => (location === STAGING && n === 1 ? conflict() : undefined),
    });
    const result = await run(service);
    expect(result.failed.map((f) => (f.kind === 'location' ? f.code : undefined))).toEqual([ERROR_CODES.KEEP_WRITE_CONFLICT]);
    expect(service.pushesTo(STAGING)).toBe(2);
  });
});

describe('one project at a time, projects in parallel', () => {
  const MANY: readonly SetLocation[] = [
    ...['a', 'b', 'c', 'd'].map((b) => loc('pA', `a-${b}`)),
    ...['a', 'b', 'c'].map((b) => loc('pB', `b-${b}`)),
    ...['a', 'b', 'c'].map((b) => loc('pC', `c-${b}`)),
  ];
  const world: ServiceOpts['locs'] = MANY.map((l) => ({ project: l.project_id as ProjectId, branch: l.branch }));

  test('the locations of one project never overlap in time (from first read to read-back)', async () => {
    const service = fakeService({ locs: world, delayMs: () => 6 });
    const result = await run(service, MANY);
    expect(result.failed).toEqual([]);
    expect(result.updated).toHaveLength(MANY.length);
    const windows = windowsOf(service.events());
    const sameProject = windows.flatMap((a, i) => windows.slice(i + 1).filter((b) => a.location.split('/')[0] === b.location.split('/')[0]).map((b) => [a, b] as const));
    expect(sameProject.length).toBeGreaterThan(0);
    expect(sameProject.filter(([a, b]) => overlap(a, b))).toEqual([]);
  });

  test('different projects do run at the same time (the parallelism is kept)', async () => {
    const service = fakeService({ locs: world, delayMs: () => 6 });
    await run(service, MANY);
    const windows = windowsOf(service.events());
    const different = windows.flatMap((a, i) => windows.slice(i + 1).filter((b) => a.location.split('/')[0] !== b.location.split('/')[0]).map((b) => [a, b] as const));
    expect(different.some(([a, b]) => overlap(a, b))).toBe(true);
  });

  test('results stay in input order whatever the lanes finish in', async () => {
    const service = fakeService({ locs: world, delayMs: (location) => (location.startsWith('pA') ? 8 : 1) });
    const result = await run(service, MANY);
    expect(result.updated.map(labelOf)).toEqual(MANY.map(label));
  });

  test('a stop starts no further push; the one running finishes and the rest are cancelled, in input order', async () => {
    const stop = new AbortController();
    const service = fakeService({ locs: world, delayMs: () => 4 });
    const env = envFor(service);
    const started = runSecretSet({ name: NAME, value: SENTINEL, locations: MANY, repos: [] }, env, { stopPushes: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 2));
    stop.abort();
    const result = await started;
    expect((result.cancelled ?? []).length + result.updated.length).toBe(MANY.length);
    expect((result.cancelled ?? []).length).toBeGreaterThan(0);
    const names = (result.cancelled ?? []).flatMap((c) => (c.kind === 'location' ? [labelOf(c)] : []));
    expect(names).toEqual(MANY.map(label).filter((n) => names.includes(n)));
  });
});

// ── The command: exit status, JSON, and the dry run ─────────────────────────

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
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (outcome.thrown !== null && !(outcome.thrown instanceof ExitSignal)) throw outcome.thrown;
  return { returned: outcome.returned, stdout };
}

function commandRig(service: ReturnType<typeof fakeService>) {
  const github = fakeGithub(standardRepos(LOCATIONS));
  const env = { ...makeEnv(service as never, github), client: service as unknown as SetEnv['client'] };
  const io: SecretsSetIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(LOCATIONS), skipped: [] }),
      getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }),
    },
    env,
    stdinIsTTY: false,
    readStdin: () => readPipedValue(Readable.from([`${SENTINEL}\n`]), MAX_PIPED_BYTES),
    peekStdin: async () => readPipedValue(Readable.from([`${SENTINEL}\n`]), MAX_PIPED_BYTES),
  };
  const go = (opts: SecretsSetOpts) => capture(() => runSecretsSet(NAME, { json: true, noPr: true, ...opts }, io));
  return { go };
}

describe('the command', () => {
  test('a location that did not read back is ok:false SECRETS_PARTIAL, exit 1, listed in failed with its code', async () => {
    const service = fakeService({ loses: (location) => location === STAGING });
    const { go } = commandRig(service);
    const plan = JSON.parse((await go({ dryRun: true })).stdout);
    const out = await go({ confirm: plan.plan_id });
    expect(out.returned).toBe(1);
    const body = JSON.parse(out.stdout);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(ERROR_CODES.SECRETS_PARTIAL);
    expect(body.failed).toEqual([{ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.SECRET_NOT_PERSISTED }]);
    expect(body.updated.map(labelOf)).not.toContain(`${PROJECT_NAMES.pA}/staging`);
    expect(out.stdout).not.toContain(SENTINEL);
  });

  test('every push kept: ok:true, exit 0, the same JSON keys as before', async () => {
    const service = fakeService();
    const { go } = commandRig(service);
    const plan = JSON.parse((await go({ dryRun: true })).stdout);
    const out = await go({ confirm: plan.plan_id });
    expect(out.returned).toBe(0);
    const body = JSON.parse(out.stdout);
    expect(body.ok).toBe(true);
    expect(body.failed).toEqual([]);
    expect(Object.keys(body).sort()).toEqual(['failed', 'name', 'no_pr', 'not_linked', 'ok', 'plan_id', 'prs', 'unchanged', 'updated']);
  });

  test('--dry-run pushes nothing and reads each location once (the plan), with no read-back', async () => {
    const service = fakeService();
    const { go } = commandRig(service);
    const out = await go({ dryRun: true });
    expect(out.returned).toBe(0);
    expect(service.pushesTo('pA/production')).toBe(0);
    const total = LOCATIONS.map((l) => service.pushesTo(locationKey(l.project, l.branch))).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
    // Without a piped value the dry run reads once per location; never a second time.
    const reads = LOCATIONS.map((l) => service.readsOf(locationKey(l.project, l.branch)));
    expect(reads).toEqual(LOCATIONS.map(() => 1));
  });
});
