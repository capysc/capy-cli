/**
 * A Vercel token problem stops a run with the real reason and the next step.
 *
 *   - 401 stays `VERCEL_AUTH_FAILED` (the token is invalid or expired).
 *   - 403 is `VERCEL_NO_ACCESS` and names what the token could not access: the
 *     team list, a project, or a project's environment variables.
 *   - Both carry the token page and two numbered steps (`link` + `remedy`).
 *   - At a terminal the steps end "(or press enter to continue)": Enter asks
 *     for a new token (saved over the old one) and runs again from the token
 *     step; one press is one retry, so a token that fails again shows the steps
 *     again and waits again. Anywhere else nothing waits.
 *   - `--discover` needs a token scoped to the whole team.
 *
 * Fake tokens only. No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { createVercelClient, type VercelFetchLike } from '../../src/deploy/vercelApi';
import { runDeployVercelDiscover } from '../../src/commands/deployDiscover/vercel';
import { ERROR_CODES, CapyError, type KeepFile } from '../../src/types/index';
import type { ConnectOpts, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import { callsOf, fakeVercelFetch, project, type FakeVercelData } from '../helpers/fakeVercel';
import { makeVercelWorld } from '../helpers/deployDiscoverVercelWorld';
import { describeVercelFailure } from '../../src/deploy/vercelTargetApi';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { captureConsole, withExitCodeRestored, withTTY } from '../helpers/testSandbox';

const PAGE = 'https://vercel.com/account/settings/tokens';
const STEP_1 = `1) Create a token with team access at ${PAGE}`;
const STEP_2 = '2) Run capy system set _CONNECTOR_VERCEL_TOKEN';
const STEP_2_ENTER = `${STEP_2} (or press enter to continue)`;
const OLD_TOKEN = 'tok_old_fake_value';
const NEW_TOKEN = 'tok_new_fake_value';

const DATA: FakeVercelData = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: [{ id: 'env_1', key: 'PLAIN_PROD', type: 'plain', target: ['production'], listValue: 'v-1' }] },
  custom: { prj_web: [] },
};

const ctxWith = (): ResolvedContext =>
  ({
    keep: { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} } as KeepFile,
    branch: 'production',
    orgId: 'org_1',
    localPlaintext: {},
  }) as unknown as ResolvedContext;

const denied = { status: 403, ok: false, headers: { get: () => null }, text: async () => '{}' };

/** The fake Vercel, except that every path matching `deny` answers 403. */
const denying = (deny: RegExp): VercelFetchLike => {
  const inner = fakeVercelFetch(DATA);
  return (async (url: string, init: never) => (deny.test(new URL(url).pathname) ? denied : inner(url, init))) as VercelFetchLike;
};

/** Accepts only `accepted` as the bearer token; any other token is `status`. */
const acceptingOnly = (accepted: string, status: 401 | 403): VercelFetchLike => {
  const inner = fakeVercelFetch(DATA);
  return (async (url: string, init: { headers: Record<string, string> }) =>
    init.headers.Authorization === `Bearer ${accepted}` ? inner(url, init as never) : { ...denied, status }) as VercelFetchLike;
};

const BASE: ConnectOpts = { nonTty: true, project: 'web', tokenEnv: 'T' };
const failure = (o: ImportOutcome): Extract<ImportOutcome, { ok: false }> => {
  if (o.ok) throw new Error('expected a refusal');
  return o;
};

describe('a token problem names the reason and carries the two steps', () => {
  test('401 stays VERCEL_AUTH_FAILED: same code and message as before, plus the link and the two steps', async () => {
    const connector = createVercelConnector({ fetch: acceptingOnly('other', 401), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const out = failure(await connector.import!(ctxWith(), BASE));
    expect(out.code).toBe(ERROR_CODES.VERCEL_AUTH_FAILED);
    expect(out.message).toBe('Vercel rejected the token (HTTP 401).');
    expect(out.link?.url).toBe(PAGE);
    expect(out.remedy).toBe(`${STEP_1}\n${STEP_2}`);
  });

  test('403 on the team list: VERCEL_NO_ACCESS naming the team list', async () => {
    const connector = createVercelConnector({ fetch: denying(/^\/v2\/teams$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const out = failure(await connector.import!(ctxWith(), BASE));
    expect(out.code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(out.message).toBe('Vercel denied access to the team list (HTTP 403).');
    expect(out.link?.url).toBe(PAGE);
    expect(out.remedy).toBe(`${STEP_1}\n${STEP_2}`);
  });

  test('403 on the project: VERCEL_NO_ACCESS naming the project', async () => {
    const connector = createVercelConnector({ fetch: denying(/^\/v9\/projects\/web$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const out = failure(await connector.import!(ctxWith(), BASE));
    expect(out.code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(out.message).toBe('Vercel denied access to project web (HTTP 403).');
    expect(out.remedy).toBe(`${STEP_1}\n${STEP_2}`);
  });

  test("403 on the project's environment variables: VERCEL_NO_ACCESS naming them, for the list and for a value", async () => {
    const list = createVercelConnector({ fetch: denying(/^\/v10\/projects\/prj_web\/env$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const listed = failure(await list.import!(ctxWith(), BASE));
    expect(listed.code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(listed.message).toBe('Vercel denied access to the environment variables of project prj_web (HTTP 403).');

    const withEncrypted: FakeVercelData = { ...DATA, envs: { prj_web: [{ id: 'env_2', key: 'ENC', type: 'encrypted', target: ['production'], listValue: 'opaque' }] } };
    const inner = fakeVercelFetch(withEncrypted);
    const valueDenied = (async (url: string, init: never) => (/\/v1\/projects\//.test(url) ? denied : inner(url, init))) as VercelFetchLike;
    const value = createVercelConnector({ fetch: valueDenied, env: { T: OLD_TOKEN }, sleep: async () => {} });
    const read = failure(await value.import!(ctxWith(), BASE));
    expect(read.code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(read.message).toBe('Vercel denied access to the environment variables of project prj_web (HTTP 403).');
  });

  test('a 500 is still VERCEL_API_ERROR, with no steps', async () => {
    const down: VercelFetchLike = async () => ({ status: 500, ok: false, text: async () => '{}' });
    const connector = createVercelConnector({ fetch: down, env: { T: OLD_TOKEN }, sleep: async () => {} });
    const out = failure(await connector.import!(ctxWith(), BASE));
    expect(out.code).toBe(ERROR_CODES.VERCEL_API_ERROR);
    expect(out.remedy).toBeUndefined();
  });

  test('--discover: a 403 on the team list or the project list says discovery needs a token scoped to the whole team', async () => {
    const teamsDenied = createVercelConnector({ fetch: denying(/^\/v2\/teams$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const a = await teamsDenied.discover!({ orgId: 'o', userId: 'u', authService: {}, serviceClient: {} } as never, { nonTty: true, discover: true, tokenEnv: 'T' });
    expect(a).toMatchObject({
      ok: false,
      code: ERROR_CODES.VERCEL_NO_ACCESS,
      message: 'Vercel denied access to the team list (HTTP 403). Discovery needs a token scoped to the whole team.',
    });

    const projectsDenied = createVercelConnector({ fetch: denying(/^\/v10\/projects$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const b = await projectsDenied.discover!(
      { orgId: 'o', userId: 'u', authService: {}, serviceClient: { listBranches: async () => [] } } as never,
      { nonTty: true, discover: true, tokenEnv: 'T', yes: true },
    );
    expect(b).toMatchObject({
      ok: false,
      code: ERROR_CODES.VERCEL_NO_ACCESS,
      message: 'Vercel denied access to the project list (HTTP 403). Discovery needs a token scoped to the whole team.',
    });
    expect((b as { remedy?: string }).remedy).toBe(`${STEP_1}\n${STEP_2}`);
  });

  test('capy deploy vercel --discover: a 403 uses the same code, the whole-team message, and the steps', async () => {
    const world = makeVercelWorld({
      io: { vercel: (token) => createVercelClient(token, { fetch: (async () => denied) as never, sleep: async () => {}, dropValues: true }) },
    });
    const result = await runDeployVercelDiscover({}, world.io);
    expect(result.exitCode).toBe(1);
    expect(result.body).toMatchObject({
      ok: false,
      code: ERROR_CODES.VERCEL_NO_ACCESS,
      error: 'Vercel denied access to the team list (HTTP 403). Discovery needs a token scoped to the whole team.',
      link: { url: PAGE },
      remedy: `${STEP_1}\n${STEP_2}`,
    });
  });

  test('capy deploy vercel --discover: a 401 stays VERCEL_AUTH_FAILED', async () => {
    const world = makeVercelWorld({ acceptedToken: 'something-else' });
    const result = await runDeployVercelDiscover({}, world.io);
    expect(result.body).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_AUTH_FAILED, remedy: `${STEP_1}\n${STEP_2}` });
  });
});

describe('at a terminal: Enter replaces the token and runs again', () => {
  /** A connector whose store hands out `OLD_TOKEN` then `tokens`, one per read, and a Vercel that accepts only `accepted`. */
  function interactive(args: { accepted: string; status?: 401 | 403; reads: readonly string[]; presses: readonly boolean[]; replaced?: string | null }) {
    const reads = mock(async (_n: string, _o: unknown) => null as string | null);
    args.reads.slice(0, -1).forEach((t) => reads.mockResolvedValueOnce(t));
    reads.mockResolvedValue(args.reads[args.reads.length - 1]);
    const presses = mock(async () => false);
    args.presses.forEach((p) => presses.mockResolvedValueOnce(p));
    const replace = mock(async (_n: string, _o: unknown) => (args.replaced === undefined ? NEW_TOKEN : args.replaced));
    const fetchMock = mock(acceptingOnly(args.accepted, args.status ?? 403));
    const connector = createVercelConnector({
      fetch: fetchMock as unknown as VercelFetchLike,
      env: {},
      sleep: async () => {},
      getConnectorSecret: reads,
      replaceConnectorSecret: replace,
      waitForEnter: presses,
      selectVars: async (names) => names,
      confirm: async () => false,
    });
    return { connector, reads, presses, replace, fetchMock };
  }
  const run = (connector: ReturnType<typeof createVercelConnector>, over: Partial<ConnectOpts> = {}) =>
    withTTY(() => captureConsole(() => connector.import!(ctxWith(), { nonTty: false, project: 'web', ...over })));

  test('the reason, then the two steps in order with the link and the press-enter clause, then waits', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN], presses: [false] });
    const { result, stderr } = await run(t.connector);
    const text = stderr.join('\n');
    expect(failure(result).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(text).toContain('Vercel denied access to the team list (HTTP 403).');
    expect(text.indexOf(STEP_1)).toBeGreaterThan(text.indexOf('Vercel denied access'));
    expect(text.indexOf(STEP_2_ENTER)).toBeGreaterThan(text.indexOf(STEP_1));
    expect(text).toContain(PAGE);
    expect(t.presses).toHaveBeenCalledTimes(1);
  });

  test('Enter → hidden prompt for a new token → saved → run again with it, and the run succeeds', async () => {
    const t = interactive({ accepted: NEW_TOKEN, reads: [OLD_TOKEN, NEW_TOKEN], presses: [true] });
    const { result, stderr } = await run(t.connector);
    expect(result.ok).toBe(true);
    expect(t.presses).toHaveBeenCalledTimes(1);
    expect(t.replace).toHaveBeenCalledTimes(1);
    expect(t.replace.mock.calls[0][0]).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(t.replace.mock.calls[0][1]).toMatchObject({ orgId: 'org_1', interactive: true });
    const bearers = callsOf(t.fetchMock).map((c) => c.authorization);
    expect(bearers[0]).toBe(`Bearer ${OLD_TOKEN}`);
    expect(bearers[bearers.length - 1]).toBe(`Bearer ${NEW_TOKEN}`);
    expect(stderr.join('\n')).not.toContain(NEW_TOKEN);
  });

  test('Enter → the new token fails too → the steps are shown again and it waits again; no loop without another press', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN, NEW_TOKEN], presses: [true, false] });
    const { result, stderr } = await run(t.connector);
    expect(failure(result).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(t.presses).toHaveBeenCalledTimes(2);
    expect(t.replace).toHaveBeenCalledTimes(1);
    expect(stderr.filter((l) => l.includes(STEP_2_ENTER))).toHaveLength(2);
    expect(stderr.filter((l) => l.includes('Vercel denied access to the team list')).length).toBe(2);
  });

  test('every press is one more retry: two presses, two replacements', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN, 'tok_b', 'tok_c'], presses: [true, true, false] });
    await run(t.connector);
    expect(t.presses).toHaveBeenCalledTimes(3);
    expect(t.replace).toHaveBeenCalledTimes(2);
  });

  test('a 401 offers the same Enter', async () => {
    const t = interactive({ accepted: NEW_TOKEN, status: 401, reads: [OLD_TOKEN, NEW_TOKEN], presses: [true] });
    const { result, stderr } = await run(t.connector);
    expect(result.ok).toBe(true);
    expect(stderr.join('\n')).toContain('Vercel rejected the token (HTTP 401).');
    expect(stderr.join('\n')).toContain(STEP_2_ENTER);
  });

  test('abort (Ctrl-C): the same coded refusal, nothing replaced', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN], presses: [false] });
    const { result } = await run(t.connector);
    expect(failure(result)).toMatchObject({ code: ERROR_CODES.VERCEL_NO_ACCESS, link: { url: PAGE }, remedy: `${STEP_1}\n${STEP_2}` });
    expect(t.replace).not.toHaveBeenCalled();
  });

  test('an empty answer at the new-token prompt stops with a refusal and does not retry', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN], presses: [true], replaced: null });
    const { result } = await run(t.connector);
    expect(failure(result).code).toBe(ERROR_CODES.VERCEL_TOKEN_MISSING);
    expect(callsOf(t.fetchMock).every((c) => c.authorization === `Bearer ${OLD_TOKEN}`)).toBe(true);
  });

  test("a non-admin: the store's own coded refusal is returned, not silence", async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN], presses: [true] });
    const refusing = createVercelConnector({
      fetch: t.fetchMock as unknown as VercelFetchLike,
      env: {},
      getConnectorSecret: t.reads,
      waitForEnter: t.presses,
      replaceConnectorSecret: async () => {
        throw new CapyError('owners/admins only', ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY);
      },
    });
    const { result } = await run(refusing);
    expect(failure(result)).toMatchObject({ code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY, message: 'owners/admins only' });
  });

  test('--discover offers the same Enter and retries the whole discovery', async () => {
    const t = interactive({ accepted: 'never', reads: [OLD_TOKEN], presses: [false] });
    const { result, stderr } = await withTTY(() =>
      captureConsole(() =>
        t.connector.discover!({ orgId: 'o', userId: 'u', authService: {}, serviceClient: {} } as never, { nonTty: false, discover: true }),
      ),
    );
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_NO_ACCESS });
    expect(stderr.join('\n')).toContain('Discovery needs a token scoped to the whole team.');
    expect(stderr.join('\n')).toContain(STEP_2_ENTER);
    expect(t.presses).toHaveBeenCalledTimes(1);
  });
});

describe('anywhere else: nothing waits, and the steps have no press-enter clause', () => {
  const never = mock(async () => true);
  const replace = mock(async () => NEW_TOKEN);
  const withDeps = (env: Record<string, string>) =>
    createVercelConnector({
      fetch: acceptingOnly('never', 403),
      env,
      sleep: async () => {},
      getConnectorSecret: async () => OLD_TOKEN,
      replaceConnectorSecret: replace,
      waitForEnter: never,
    });

  test('--non-tty', async () => {
    const { result, stderr } = await captureConsole(() => withDeps({}).import!(ctxWith(), { nonTty: true, project: 'web' }));
    expect(failure(result).remedy).toBe(`${STEP_1}\n${STEP_2}`);
    expect(failure(result).remedy).not.toContain('press enter');
    expect(stderr).toEqual([]);
    expect(never).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test('--json and --dry-run at a terminal', async () => {
    const json = await withTTY(() => captureConsole(() => withDeps({}).import!(ctxWith(), { nonTty: false, project: 'web', json: true })));
    const dry = await withTTY(() => captureConsole(() => withDeps({}).import!(ctxWith(), { nonTty: false, project: 'web', dryRun: true })));
    expect(failure(json.result).remedy).toBe(`${STEP_1}\n${STEP_2}`);
    expect(failure(dry.result).remedy).toBe(`${STEP_1}\n${STEP_2}`);
    expect([...json.stderr, ...dry.stderr]).toEqual([]);
    expect(never).not.toHaveBeenCalled();
  });

  test('a token that came from the environment, not the store, is not replaceable here', async () => {
    const connector = createVercelConnector({
      fetch: acceptingOnly('never', 403),
      env: { T: OLD_TOKEN },
      sleep: async () => {},
      replaceConnectorSecret: replace,
      waitForEnter: never,
    });
    const { result } = await withTTY(() => captureConsole(() => connector.import!(ctxWith(), { nonTty: false, project: 'web', tokenEnv: 'T' })));
    expect(failure(result).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('the same steps, printed', () => {
  test('connect: JSON carries the link and the two steps in `remedy`; the terminal prints one indented line per step', async () => {
    const connector = createVercelConnector({ fetch: denying(/^\/v2\/teams$/), env: { T: OLD_TOKEN }, sleep: async () => {} });
    const opts: ConnectOpts = { nonTty: true, project: 'web', tokenEnv: 'T' };
    const json = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false)['executeImport'](connector, 'vercel', ctxWith(), { ...opts, json: true })));
    expect(JSON.parse(json.stdout[0])).toMatchObject({
      ok: false,
      code: ERROR_CODES.VERCEL_NO_ACCESS,
      link: { url: PAGE },
      remedy: `${STEP_1}\n${STEP_2}`,
    });
    const human = await withExitCodeRestored(() => captureConsole(() => new ConnectCommand(false)['executeImport'](connector, 'vercel', ctxWith(), { ...opts, json: false })));
    expect(human.stderr.join('\n')).toContain(`  ${STEP_1}\n  ${STEP_2}`);
  });

  test('deploy: a 403 on the deploy token names the deploy-side secret in step 2 and carries the link', () => {
    const described = describeVercelFailure(ERROR_CODES.VERCEL_NO_ACCESS, 403);
    expect(described.reason).toBe('the Vercel token has no access to this project (HTTP 403)');
    expect(described.link?.url).toBe(PAGE);
    expect(described.remedy).toBe(`${STEP_1}\n2) Run capy system set _TARGET_VERCEL_TOKEN`);
  });
});
