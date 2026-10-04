/**
 * `capy secrets set NAME` (agent mode): selection, the plan and `plan_id`,
 * `--confirm`, the stdin rules, the result shape and the value never leaking.
 * The service, GitHub and stdin are all injected: no network, no `gh`.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import {
  planIdOf,
  runSecretsSet,
  type SecretsSetIo,
  type SecretsSetOpts,
} from '../../src/commands/secretsSetCommand';
import { rowIdOf } from '../../src/commands/secretsRowId';
import { MAX_PIPED_BYTES, readPipedValue } from '../../src/commands/pipedValue';
import { EXIT_NEEDS_INPUT } from '../../src/ui/interactive';
import {
  KEYS,
  LINKS,
  LOCATIONS,
  NAME,
  OLD_VALUE,
  PROJECT_NAMES,
  SENTINEL,
  everythingSentTo,
  fakeGithub,
  fakeService,
  indexRows,
  makeEnv,
  standardRepos,
  type Loc,
} from '../helpers/secretsWorld';
import { FileManager } from '../../src/files/fileManager';

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

function rig(over: { locs?: readonly Loc[]; stdin?: string | Buffer | null; stdinIsTTY?: boolean; links?: typeof LINKS; reposError?: CapyError } = {}) {
  const locs = over.locs ?? LOCATIONS;
  const service = fakeService({ locs });
  const github = fakeGithub(standardRepos(locs));
  const env = makeEnv(service, github);
  const source = (): Readable => Readable.from(over.stdin === null || over.stdin === undefined ? [] : [over.stdin]);
  const io: SecretsSetIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(locs), skipped: [] }),
      getOrgRepos: async () => {
        if (over.reposError) throw over.reposError;
        return { org_id: 'org1', repos: [...(over.links ?? LINKS)] };
      },
    },
    env,
    stdinIsTTY: over.stdinIsTTY === true,
    readStdin: () => readPipedValue(source(), MAX_PIPED_BYTES),
    peekStdin: async () => (over.stdin === undefined || over.stdin === null ? undefined : readPipedValue(source(), MAX_PIPED_BYTES)),
  };
  return { io, service, github, env };
}

const noWrites = (r: ReturnType<typeof rig>) => {
  expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  expect(r.github.createBlob.mock.calls).toHaveLength(0);
  expect(r.github.createRef.mock.calls).toHaveLength(0);
  expect(r.github.createPull.mock.calls).toHaveLength(0);
};

const json = (c: Captured) => JSON.parse(c.stdout);
const run = (r: ReturnType<typeof rig>, opts: SecretsSetOpts, name = NAME) => capture(() => runSecretsSet(name, { json: true, ...opts }, r.io));

/** Two rows of NAME: the old value in most places, a different one on solo-server. */
const TWO_ROWS: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, value: 'a-different-value' } : l));
const rowIds = (locs: readonly Loc[]) => indexRows(locs).map((r) => rowIdOf(r.name, r.value_hash));

describe('selecting rows', () => {
  test('several rows and neither --row nor --all-rows: SECRET_AMBIGUOUS, exit 3, candidates in `unanswered`', async () => {
    const r = rig({ locs: TWO_ROWS });
    const out = await run(r, {});
    expect(out.exitCode).toBe(EXIT_NEEDS_INPUT);
    const body = json(out);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(ERROR_CODES.SECRET_AMBIGUOUS);
    expect(body.unanswered).toHaveLength(1);
    expect(body.unanswered[0]).toMatchObject({ id: 'row', flag: '--row', alternative: '--all-rows' });
    const candidates = body.unanswered[0].candidates;
    expect(candidates.map((c: { row_id: string }) => c.row_id)).toEqual(rowIds(TWO_ROWS));
    expect(Object.keys(candidates[0]).sort()).toEqual(['last_changed', 'locations', 'row_id']);
    expect(candidates[1].locations).toEqual([{ project: PROJECT_NAMES.pC, branch: 'development', protected: false }]);
    expect(candidates[0].locations[0]).toEqual({ project: PROJECT_NAMES.pA, branch: 'production', protected: true });
    noWrites(r);
  });

  test('--row picks a row; --row is repeatable; --all-rows takes every row', async () => {
    const r = rig({ locs: TWO_ROWS });
    const [first, second] = rowIds(TWO_ROWS);
    const one = json(await run(r, { row: [second], noPr: true, dryRun: true }));
    expect(one.locations.map((l: { project: string }) => l.project)).toEqual([PROJECT_NAMES.pC]);
    const both = json(await run(r, { row: [first, second], noPr: true, dryRun: true }));
    expect(both.locations).toHaveLength(5);
    const all = json(await run(r, { allRows: true, noPr: true, dryRun: true }));
    expect(all.locations).toHaveLength(5);
    expect(all.plan_id).toBe(both.plan_id);
  });

  test('--row with --all-rows, an unknown --row and an unknown name are refused with codes', async () => {
    const r = rig({ locs: TWO_ROWS });
    expect(json(await run(r, { row: ['x'], allRows: true })).code).toBe(ERROR_CODES.INVALID_FORMAT);
    const unknownRow = await run(r, { row: ['nope00000000'] });
    expect(json(unknownRow).code).toBe(ERROR_CODES.SECRET_NOT_FOUND);
    expect(json(await run(r, {}, 'NO_SUCH_NAME')).code).toBe(ERROR_CODES.SECRET_NOT_FOUND);
    expect(json(await run(r, {}, 'not a name')).code).toBe(ERROR_CODES.INVALID_FORMAT);
    noWrites(r);
  });

  test('a single row needs no flag', async () => {
    const r = rig();
    const plan = json(await run(r, { dryRun: true }));
    expect(plan.locations).toHaveLength(5);
  });

  test('--exclude drops locations; one that matches nothing is refused', async () => {
    const r = rig();
    const plan = json(await run(r, { dryRun: true, exclude: [`${PROJECT_NAMES.pA}:production`, `${PROJECT_NAMES.pD}:development`] }));
    expect(plan.locations.map((l: { project: string; branch: string }) => `${l.project}:${l.branch}`)).toEqual([
      `${PROJECT_NAMES.pA}:staging`,
      `${PROJECT_NAMES.pB}:production`,
      `${PROJECT_NAMES.pC}:development`,
    ]);
    expect(json(await run(r, { dryRun: true, exclude: ['nope:nope'] })).code).toBe(ERROR_CODES.INVALID_FORMAT);
    const everything = LOCATIONS.map((l) => `${PROJECT_NAMES[l.project]}:${l.branch}`);
    const none = await run(r, { dryRun: true, exclude: everything });
    expect(json(none).code).toBe(ERROR_CODES.SECRETS_NOTHING_SELECTED);
  });
});

describe('the dry run', () => {
  test('prints the full plan, needs no stdin, and writes nothing at all', async () => {
    const r = rig();
    const out = await run(r, { dryRun: true });
    expect(out.exitCode).toBeUndefined();
    expect(out.returned).toBe(0);
    const plan = json(out);
    expect(Object.keys(plan).sort()).toEqual(['dry_run', 'locations', 'name', 'not_linked', 'ok', 'plan_id', 'prs']);
    expect(plan).toMatchObject({ ok: true, dry_run: true, name: NAME, not_linked: [PROJECT_NAMES.pD] });
    expect(plan.locations[0]).toEqual({ project: PROJECT_NAMES.pA, branch: 'production', protected: true, action: 'update' });
    expect(plan.prs).toEqual([
      { repo: 'Acme/mono', base: 'main', keep_lock_paths: ['backend/keep.lock', 'frontend/keep.lock'], keep_lock_diverged: false },
      { repo: 'Acme/solo', base: 'trunk', keep_lock_paths: ['keep.lock'], keep_lock_diverged: false },
    ]);
    noWrites(r);
  });

  test('a piped value makes `unchanged` computable; without one every location says `update`', async () => {
    const r = rig({ stdin: `${OLD_VALUE}\n` });
    const plan = json(await run(r, { dryRun: true }));
    expect(plan.locations.every((l: { action: string }) => l.action === 'unchanged')).toBe(true);
    const fresh = json(await run(rig({ stdin: `${SENTINEL}\n` }), { dryRun: true }));
    expect(fresh.locations.every((l: { action: string }) => l.action === 'update')).toBe(true);
  });

  test('--no-pr removes every PR; --no-pr-for removes one repo; a typo is refused', async () => {
    const r = rig();
    expect(json(await run(r, { dryRun: true, noPr: true })).prs).toEqual([]);
    const some = json(await run(r, { dryRun: true, noPrFor: ['acme/MONO'] }));
    expect(some.prs.map((p: { repo: string }) => p.repo)).toEqual(['Acme/solo']);
    expect(json(await run(r, { dryRun: true, noPrFor: ['acme/nothing'] })).code).toBe(ERROR_CODES.INVALID_FORMAT);
  });

  test('keep_lock_diverged shows in the plan when GitHub disagrees about other variables', async () => {
    const diverged: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, githubOtherHash: 'ffffffffffffffff' } : l));
    const service = fakeService({ locs: LOCATIONS });
    const github = fakeGithub(standardRepos(diverged));
    const base = rig();
    const r = { ...base, io: { ...base.io, env: makeEnv(service, github) } };
    const plan = json(await capture(() => runSecretsSet(NAME, { json: true, dryRun: true }, r.io)));
    expect(plan.prs.find((p: { repo: string }) => p.repo === 'Acme/solo').keep_lock_diverged).toBe(true);
  });

  test('human mode prints a readable plan on stdout', async () => {
    const r = rig();
    const out = await capture(() => runSecretsSet(NAME, { dryRun: true }, r.io));
    expect(out.stdout).toContain('Acme/mono');
    expect(out.stdout).toContain('protected');
    expect(out.stdout).toContain(PROJECT_NAMES.pD);
  });
});

describe('plan_id and --confirm', () => {
  test('a real run without --confirm is refused (exit 3) with the plan and plan_id, and writes nothing', async () => {
    const r = rig();
    const dry = json(await run(r, { dryRun: true }));
    const out = await run(r, {});
    expect(out.exitCode).toBe(EXIT_NEEDS_INPUT);
    const body = json(out);
    expect(body.code).toBe(ERROR_CODES.PLAN_CONFIRM_REQUIRED);
    expect(body.plan_id).toBe(dry.plan_id);
    expect(body.plan.locations).toHaveLength(5);
    expect(body.unanswered).toEqual([{ id: 'confirm', flag: '--confirm', value: dry.plan_id }]);
    noWrites(r);
  });

  test('a stale plan_id is PLAN_CHANGED (exit 1) and nothing is done, nothing is read from stdin', async () => {
    const r = rig({ stdin: `${SENTINEL}\n` });
    const out = await run(r, { confirm: 'deadbeefdeadbeef' });
    expect(out.exitCode).toBe(1);
    expect(json(out).code).toBe(ERROR_CODES.PLAN_CHANGED);
    expect(json(out).plan_id).toHaveLength(16);
    noWrites(r);
  });

  test('narrowing the plan after the dry run (an --exclude) changes plan_id, so the old id is refused', async () => {
    const r = rig();
    const dry = json(await run(r, { dryRun: true }));
    const out = await run(r, { confirm: dry.plan_id, exclude: [`${PROJECT_NAMES.pA}:staging`] });
    expect(json(out).code).toBe(ERROR_CODES.PLAN_CHANGED);
    noWrites(r);
  });

  test('planIdOf: order never matters, and a different set, repo, base or path is a different id', () => {
    const l1 = { row_id: 'r1', project: 'a', branch: 'x' };
    const l2 = { row_id: 'r1', project: 'b', branch: 'y' };
    const p1 = { repo: 'O/n', base: 'main', keep_lock_paths: ['a/keep.lock', 'b/keep.lock'] };
    const id = planIdOf(NAME, [l1, l2], [p1]);
    expect(planIdOf(NAME, [l2, l1], [{ ...p1, keep_lock_paths: ['b/keep.lock', 'a/keep.lock'] }])).toBe(id);
    expect(planIdOf(NAME, [l1], [p1])).not.toBe(id);
    expect(planIdOf(NAME, [l1, l2], [{ ...p1, base: 'dev' }])).not.toBe(id);
    expect(planIdOf(NAME, [l1, l2], [])).not.toBe(id);
    expect(planIdOf(NAME, [{ ...l1, row_id: 'r2' }, l2], [p1])).not.toBe(id);
  });
});

describe('a confirmed run', () => {
  async function confirmed(over: Parameters<typeof rig>[0], opts: SecretsSetOpts = {}) {
    const r = rig(over);
    const plan = json(await run(r, { ...opts, dryRun: true }));
    return { r, planId: plan.plan_id as string };
  }

  test('pushes every location, opens the PRs and reports the exact JSON shape; exit 0', async () => {
    const { r, planId } = await confirmed({ stdin: `${SENTINEL}\n` });
    const out = await run(r, { confirm: planId });
    expect(out.returned).toBe(0);
    const result = json(out);
    expect(Object.keys(result).sort()).toEqual(['failed', 'name', 'no_pr', 'not_linked', 'ok', 'plan_id', 'prs', 'unchanged', 'updated']);
    expect(result).toMatchObject({ ok: true, name: NAME, plan_id: planId, unchanged: [], failed: [], not_linked: [PROJECT_NAMES.pD] });
    expect(result.updated).toHaveLength(5);
    expect(result.prs.map((p: { repo: string; url: string; base: string }) => [p.repo, p.url, p.base])).toEqual([
      ['Acme/mono', 'https://github.com/Acme/mono/pull/4', 'main'],
      ['Acme/solo', 'https://github.com/Acme/solo/pull/4', 'trunk'],
    ]);
    expect(result.prs[0].locations).toHaveLength(3);
    expect(r.service.pushSecrets.mock.calls).toHaveLength(5);
    expect(r.github.createPull.mock.calls).toHaveLength(2);
    // The trailing newline was stripped: what was stored is exactly the value.
    const call = r.service.pushSecrets.mock.calls.find((c) => c[0] === 'pC') as unknown[];
    const line = String(call[2]).split('\n').find((l) => l.startsWith(`${NAME}=`)) as string;
    expect(new FileManager().decryptValue(line.slice(NAME.length + 1), KEYS.pC)).toBe(SENTINEL);
  });

  test('--no-pr: values pushed, no GitHub call at all', async () => {
    const { r, planId } = await confirmed({ stdin: `${SENTINEL}\n` }, { noPr: true });
    const out = await run(r, { confirm: planId, noPr: true });
    expect(json(out).prs).toEqual([]);
    expect(r.service.pushSecrets.mock.calls).toHaveLength(5);
    expect(r.github.getRepo.mock.calls).toHaveLength(0);
    expect(r.github.createPull.mock.calls).toHaveLength(0);
  });

  test('a partial failure is ok:false with SECRETS_PARTIAL and exit 1, and lists every failure with a code', async () => {
    const r = rig({ stdin: `${SENTINEL}\n` });
    const service = fakeService({ failPush: { 'pA/staging': ERROR_CODES.SERVICE_ERROR } });
    const github = fakeGithub(standardRepos().map((x) => (x.name === 'solo' ? { ...x, fail: ['createPull'] } : x)));
    const io = { ...r.io, env: makeEnv(service, github) };
    const planId = json(await capture(() => runSecretsSet(NAME, { json: true, dryRun: true }, io))).plan_id;
    const out = await capture(() => runSecretsSet(NAME, { json: true, confirm: planId }, io));
    expect(out.returned).toBe(1);
    const result = json(out);
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.SECRETS_PARTIAL });
    expect(result.failed).toEqual([
      { kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.SERVICE_ERROR },
      { kind: 'repo', repo: 'Acme/solo', code: ERROR_CODES.KEEP_PR_CREATE_FAILED },
    ]);
    expect(result.prs.map((p: { repo: string }) => p.repo)).toEqual(['Acme/mono']);
  });

  test('human mode prints the approved confirmation on stdout', async () => {
    const { r, planId } = await confirmed({ stdin: `${SENTINEL}\n` });
    const out = await capture(() => runSecretsSet(NAME, { confirm: planId }, r.io));
    expect(out.stdout).toContain(`✓ ${NAME} updated in 5 locations.`);
    expect(out.stdout).toContain("Pull requests (merge each to update that repo's keep.lock):");
    expect(out.stdout).toContain('  Acme/mono\n    https://github.com/Acme/mono/pull/4');
  });
});

describe('the stdin rules (pipedValue.ts, unchanged)', () => {
  const refusalFor = async (over: Parameters<typeof rig>[0]) => {
    const r = rig(over);
    const planId = json(await run(r, { dryRun: true })).plan_id as string;
    const out = await run(r, { confirm: planId });
    noWrites(r);
    return json(out);
  };

  test('a terminal on stdin, or an empty pipe: STDIN_EMPTY', async () => {
    expect((await refusalFor({ stdinIsTTY: true })).code).toBe(ERROR_CODES.STDIN_EMPTY);
    expect((await refusalFor({ stdin: '' })).code).toBe(ERROR_CODES.STDIN_EMPTY);
    expect((await refusalFor({ stdin: '\n' })).code).toBe(ERROR_CODES.STDIN_EMPTY);
  });

  test('over 1 MiB: STDIN_TOO_LARGE; a NUL byte: INVALID_FORMAT', async () => {
    expect((await refusalFor({ stdin: 'x'.repeat(MAX_PIPED_BYTES + 1) })).code).toBe(ERROR_CODES.STDIN_TOO_LARGE);
    expect((await refusalFor({ stdin: 'ab\u0000cd' })).code).toBe(ERROR_CODES.INVALID_FORMAT);
  });

  test('exactly one trailing line ending is removed, nothing else', async () => {
    const r = rig({ stdin: `  ${SENTINEL}  \n\n` });
    const planId = json(await run(r, { dryRun: true })).plan_id as string;
    await run(r, { confirm: planId });
    const call = r.service.pushSecrets.mock.calls.find((c) => c[0] === 'pC') as unknown[];
    const line = String(call[2]).split('\n').find((l) => l.startsWith(`${NAME}=`)) as string;
    expect(new FileManager().decryptValue(line.slice(NAME.length + 1), KEYS.pC)).toBe(`  ${SENTINEL}  \n`);
  });
});

describe('the value never leaks', () => {
  /** Every surface a run writes to, for a given scenario. */
  async function everything(scenario: (r: ReturnType<typeof rig>) => Promise<Captured[]>): Promise<string> {
    const r = rig({ stdin: `${SENTINEL}\n` });
    const outs = await scenario(r);
    const printed = outs.map((o) => `${o.stdout}\n${o.stderr}`).join('\n');
    const sent = everythingSentTo(r.github.getRepo, r.github.getFile, r.github.createBlob, r.github.createTree, r.github.createCommit, r.github.createRef, r.github.createPull);
    return `${printed}\n${sent}\n${everythingSentTo(r.service.pushSecrets)}`;
  }
  const planOf = async (r: ReturnType<typeof rig>, opts: SecretsSetOpts = {}) => json(await run(r, { ...opts, dryRun: true })).plan_id as string;

  test('dry run, success, partial failure, and every refusal, in --json and human mode', async () => {
    const text = await everything(async (r) => {
      const id = await planOf(r);
      return [
        await run(r, { dryRun: true }),
        await capture(() => runSecretsSet(NAME, { dryRun: true }, r.io)),
        await run(r, {}), // PLAN_CONFIRM_REQUIRED
        await run(r, { confirm: 'stale' }), // PLAN_CHANGED
        await capture(() => runSecretsSet(NAME, {}, r.io)),
        await run(r, { row: ['nope'] }),
        await run(r, { exclude: ['nope'] }),
        await run(r, { confirm: id }), // success
        await capture(() => runSecretsSet(NAME, { confirm: id }, r.io)), // human success
      ];
    });
    expect(text).not.toContain(SENTINEL);
  });

  test('a refusal of the stdin itself never echoes it', async () => {
    const r = rig({ stdin: `${SENTINEL}${'\u0000'}` });
    const id = await planOf(r);
    const out = await run(r, { confirm: id });
    expect(`${out.stdout}${out.stderr}`).not.toContain(SENTINEL);
  });

  test('a partial failure never echoes it', async () => {
    const r = rig({ stdin: `${SENTINEL}\n` });
    const service = fakeService({ failPush: { 'pA/staging': ERROR_CODES.SERVICE_ERROR }, failRead: { 'pB/production': ERROR_CODES.PERMISSION_DENIED } });
    const io = { ...r.io, env: makeEnv(service, fakeGithub(standardRepos().map((x) => ({ ...x, fail: ['createRef'] })))) };
    const id = json(await capture(() => runSecretsSet(NAME, { json: true, dryRun: true }, io))).plan_id;
    const out = await capture(() => runSecretsSet(NAME, { json: true, confirm: id }, io));
    expect(out.returned).toBe(1);
    expect(`${out.stdout}${out.stderr}`).not.toContain(SENTINEL);
  });
});

describe('repo links the service does not have (REPO_LINKS_UNSUPPORTED)', () => {
  const unsupported = () => new CapyError('no such route', ERROR_CODES.REPO_LINKS_UNSUPPORTED, { status: 404 });

  test('the dry run is a plan, not a crash: no PRs, every project not linked, and the reason is a structured field', async () => {
    const r = rig({ reposError: unsupported() });
    const out = await run(r, { dryRun: true });
    expect(out.exitCode).toBeUndefined();
    const plan = json(out);
    expect(plan).toMatchObject({ ok: true, dry_run: true, prs: [], repos_unavailable: ERROR_CODES.REPO_LINKS_UNSUPPORTED });
    expect(plan.not_linked.sort()).toEqual(Object.values(PROJECT_NAMES).sort());
    expect(plan.locations).toHaveLength(5);
    noWrites(r);
  });

  test('a confirmed run still pushes every location and opens no PR; the reason is in the result', async () => {
    const r = rig({ reposError: unsupported(), stdin: `${SENTINEL}\n` });
    const planId = json(await run(r, { dryRun: true })).plan_id as string;
    const out = await run(r, { confirm: planId });
    expect(out.returned).toBe(0);
    expect(json(out)).toMatchObject({ ok: true, prs: [], repos_unavailable: ERROR_CODES.REPO_LINKS_UNSUPPORTED });
    expect(r.service.pushSecrets.mock.calls).toHaveLength(5);
    expect(r.github.createPull.mock.calls).toHaveLength(0);
  });

  test('human dry run says so on one line', async () => {
    const out = await capture(() => runSecretsSet(NAME, { dryRun: true }, rig({ reposError: unsupported() }).io));
    expect(out.stdout).toContain(`Repo links unavailable (${ERROR_CODES.REPO_LINKS_UNSUPPORTED}).`);
  });

  test('any other failure of the repo list is still a refusal with its own code', async () => {
    const r = rig({ reposError: new CapyError('nope', ERROR_CODES.PERMISSION_DENIED) });
    const out = await run(r, { dryRun: true });
    expect(out.exitCode).toBe(1);
    expect(json(out).code).toBe(ERROR_CODES.PERMISSION_DENIED);
  });

  test('with --no-pr the repo list is never asked for, so nothing is unavailable', async () => {
    const out = await run(rig({ reposError: unsupported() }), { dryRun: true, noPr: true });
    expect(json(out).repos_unavailable).toBeUndefined();
  });
});
