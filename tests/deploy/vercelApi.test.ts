/**
 * `deploy/vercelApi.ts` — the READ-ONLY Vercel client and the env-record
 * primitives behind `capy connect vercel` (CAP-696).
 *
 * Every test drives a scripted `fetch`; nothing here touches the network. The
 * fake (`tests/helpers/fakeVercel.ts`) throws on any non-GET, so "the client
 * never writes" is proven by running real calls through it, not by reading
 * the source.
 */
import { describe, test, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_VERCEL_TOKEN_ENV,
  VERCEL_CONNECTOR_SECRET_NAME,
  VERCEL_TARGET_SECRET_NAME,
  VercelApiError,
  buildEnvironmentPlans,
  createVercelClient,
  groupSkipped,
  mapVercelApiError,
  parseGitLink,
  rateLimitWaitMs,
  resolveEnvValues,
  resolveTeam,
  resolveVercelToken,
  vercelSecretsMayPrompt,
  type VercelEnvRecord,
  type VercelFetchLike,
} from '../../src/deploy/vercelApi';
import { ERROR_CODES } from '../../src/types/index';
import { callsOf, fakeVercelFetch, project, type RawEnv } from '../helpers/fakeVercel';

const TOKEN = 'vcl_fake_token_do_not_leak_8d2f';

const rec = (over: Partial<VercelEnvRecord> & { id: string; key: string }): VercelEnvRecord => ({
  type: 'encrypted',
  targets: ['production'],
  customEnvironmentIds: [],
  ...over,
});

describe('names', () => {
  test('the system store entry names the deploy side will also use', () => {
    expect(VERCEL_CONNECTOR_SECRET_NAME).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(VERCEL_TARGET_SECRET_NAME).toBe('_TARGET_VERCEL_TOKEN');
    expect(DEFAULT_VERCEL_TOKEN_ENV).toBe('VERCEL_TOKEN');
  });
});

describe('createVercelClient — read-only, bearer auth, team scope', () => {
  test('exposes no method that could write', () => {
    const client = createVercelClient(TOKEN, { fetch: fakeVercelFetch({ projects: {}, envs: {} }) });
    expect(Object.keys(client).toSorted()).toEqual(
      ['getEnvValue', 'getProject', 'listCustomEnvironments', 'listEnvs', 'listProjects', 'listTeams'].toSorted(),
    );
  });

  test('the source contains no write verb at all', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/deploy/vercelApi.ts'), 'utf-8');
    expect(src).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/);
  });

  test('a full read pass makes only GETs, each with the bearer token, and scopes by teamId', async () => {
    const data = {
      teams: [{ id: 'team_1', slug: 'acme' }],
      projects: { team_1: [project('prj_1', 'web')] },
      envs: { prj_1: [{ id: 'env_1', key: 'A', type: 'plain', target: ['production'], listValue: 'a-value' } as RawEnv] },
      custom: { prj_1: [{ id: 'env_c1', slug: 'staging' }] },
      values: { env_1: 'a-value' },
    };
    const fetchMock = mock(fakeVercelFetch(data));
    const client = createVercelClient(TOKEN, { fetch: fetchMock });
    await client.listTeams();
    await client.listProjects('team_1');
    await client.getProject('web', 'team_1');
    await client.listCustomEnvironments('prj_1', 'team_1');
    await client.listEnvs('prj_1', 'team_1');
    await client.getEnvValue('prj_1', 'env_1', 'team_1');
    const calls = callsOf(fetchMock);
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // team scope on every request after the team list itself
    expect(calls.slice(1).every((c) => new URL(c.url).searchParams.get('teamId') === 'team_1')).toBe(true);
    // the token is a header, never part of any URL
    expect(calls.some((c) => c.url.includes(TOKEN))).toBe(false);
  });

  test('endpoint paths and versions match the docs', async () => {
    const data = {
      teams: [],
      projects: { personal: [project('prj_1', 'web')] },
      envs: { prj_1: [{ id: 'env_1', key: 'A', type: 'plain', target: 'production', listValue: 'v' } as RawEnv] },
      values: { env_1: 'v' },
    };
    const fetchMock = mock(fakeVercelFetch(data));
    const client = createVercelClient(TOKEN, { fetch: fetchMock });
    await client.listTeams();
    await client.listProjects();
    await client.getProject('prj_1');
    await client.listCustomEnvironments('prj_1');
    await client.listEnvs('prj_1');
    await client.getEnvValue('prj_1', 'env_1');
    expect(callsOf(fetchMock).map((c) => new URL(c.url).pathname)).toEqual([
      '/v2/teams',
      '/v10/projects',
      '/v9/projects/prj_1',
      '/v9/projects/prj_1/custom-environments',
      '/v10/projects/prj_1/env',
      '/v1/projects/prj_1/env/env_1',
    ]);
  });

  test('a redirect is refused rather than followed (the bearer token must not go to another host)', async () => {
    const fetchMock = mock(async () => ({ status: 200, ok: true, text: async () => '{"teams":[]}' }));
    await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike }).listTeams();
    expect(fetchMock.mock.calls.map(([, init]) => (init as { redirect?: string }).redirect)).toEqual(['error']);
  });
});

describe('pagination', () => {
  test('projects: follows pagination.next via `from` until it is null', async () => {
    const all = Array.from({ length: 5 }, (_, i) => project(`prj_${i}`, `p${i}`));
    const fetchMock = mock(fakeVercelFetch({ projects: { personal: all }, envs: {}, pageSize: 2 }));
    const client = createVercelClient(TOKEN, { fetch: fetchMock });
    const projects = await client.listProjects();
    const calls = callsOf(fetchMock);
    expect(projects.map((p) => p.id)).toEqual(['prj_0', 'prj_1', 'prj_2', 'prj_3', 'prj_4']);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => new URL(c.url).searchParams.get('from'))).toEqual([null, '2', '4']);
    expect(calls.every((c) => new URL(c.url).searchParams.get('limit') === '100')).toBe(true);
  });

  test('projects: a server that ignores the continuation cannot loop us forever', async () => {
    const page = { projects: [project('prj_a', 'a')], pagination: { count: 1, next: 123, prev: null } };
    const fetchMock = mock(async () => ({ status: 200, ok: true, text: async () => JSON.stringify(page) }));
    const projects = await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike }).listProjects();
    expect(projects.map((p) => p.id)).toEqual(['prj_a']);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test('projects: a bare-array response (the documented alternative shape) is read too', async () => {
    const fetchImpl: VercelFetchLike = async () => ({ status: 200, ok: true, text: async () => JSON.stringify([project('prj_1', 'a')]) });
    const projects = await createVercelClient(TOKEN, { fetch: fetchImpl }).listProjects();
    expect(projects.map((p) => p.name)).toEqual(['a']);
  });

  test('teams: follows pagination.next via `until`', async () => {
    const reply = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
    const fetchMock = mock()
      .mockResolvedValueOnce(reply({ teams: [{ id: 't1', slug: 'one' }], pagination: { count: 1, next: 1700, prev: null } }))
      .mockResolvedValueOnce(reply({ teams: [{ id: 't2', slug: 'two' }], pagination: { count: 1, next: null, prev: null } }));
    const teams = await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike }).listTeams();
    expect(teams.map((t) => t.slug)).toEqual(['one', 'two']);
    expect(new URL(callsOf(fetchMock)[1].url).searchParams.get('until')).toBe('1700');
  });
});

describe('rate limits — 429', () => {
  const limited = (headers: Record<string, string>) => ({
    status: 429,
    ok: false,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
  });
  const okTeams = { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"teams":[]}' };
  const waitsOf = (sleep: { mock: { calls: ReadonlyArray<readonly unknown[]> } }) => sleep.mock.calls.map(([ms]) => ms);

  test('waits per Retry-After, then succeeds', async () => {
    const fetchMock = mock().mockResolvedValueOnce(limited({ 'retry-after': '2' })).mockResolvedValueOnce(okTeams);
    const sleep = mock(async (_ms: number) => {});
    const teams = await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike, sleep }).listTeams();
    expect(teams).toEqual([]);
    expect(waitsOf(sleep)).toEqual([2000]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test('waits per X-RateLimit-Reset (epoch seconds) when there is no Retry-After', async () => {
    const fetchMock = mock().mockResolvedValueOnce(limited({ 'x-ratelimit-reset': '1700000005' })).mockResolvedValueOnce(okTeams);
    const sleep = mock(async (_ms: number) => {});
    await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike, sleep, now: () => 1_700_000_000_000 }).listTeams();
    expect(waitsOf(sleep)).toEqual([5000]);
  });

  test('rateLimitWaitMs: header precedence, body fallback, short default', () => {
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });
    expect(rateLimitWaitMs(h({ 'retry-after': '3', 'x-ratelimit-reset': '9999999999' }), '', 0)).toBe(3000);
    expect(rateLimitWaitMs(h({ 'x-ratelimit-reset': '10' }), '', 4000)).toBe(6000);
    expect(rateLimitWaitMs(h({}), JSON.stringify({ error: { limit: { resetMs: 9000 } } }), 4000)).toBe(5000);
    expect(rateLimitWaitMs(h({}), 'not json', 0)).toBe(1000);
    expect(rateLimitWaitMs(undefined, '', 0)).toBe(1000);
  });

  test('keeps answering 429: bounded retries, then a coded refusal', async () => {
    const fetchMock = mock(async () => limited({ 'retry-after': '1' }));
    const sleep = mock(async (_ms: number) => {});
    const err = await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike, sleep, maxRetries: 3 })
      .listTeams()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelApiError);
    expect((err as VercelApiError).code).toBe('rate_limited');
    expect(fetchMock.mock.calls.length).toBe(4); // first try + 3 retries
    expect(waitsOf(sleep)).toEqual([1000, 1000, 1000]);
    expect(mapVercelApiError(err).code).toBe(ERROR_CODES.VERCEL_RATE_LIMITED);
  });

  test('a requested wait longer than the cap is refused without sleeping', async () => {
    const fetchMock = mock(async () => limited({ 'retry-after': '604800' })); // 7 days
    const sleep = mock(async (_ms: number) => {});
    const err = await createVercelClient(TOKEN, { fetch: fetchMock as unknown as VercelFetchLike, sleep }).listTeams().catch((e: unknown) => e);
    expect(mapVercelApiError(err).code).toBe(ERROR_CODES.VERCEL_RATE_LIMITED);
    expect(sleep.mock.calls.length).toBe(0);
  });
});

describe('errors map to stable codes and never carry the token', () => {
  const status = (s: number): VercelFetchLike => async () => ({ status: s, ok: false, text: async () => JSON.stringify({ error: { message: TOKEN } }) });

  test('401/403 → VERCEL_AUTH_FAILED', async () => {
    for (const s of [401, 403]) {
      const err = await createVercelClient(TOKEN, { fetch: status(s) }).listTeams().catch((e: unknown) => e);
      expect(mapVercelApiError(err).code).toBe(ERROR_CODES.VERCEL_AUTH_FAILED);
    }
  });

  test('404 → not_found; 500 → VERCEL_API_ERROR; neither message contains the token', async () => {
    const nf = await createVercelClient(TOKEN, { fetch: status(404) }).getProject('x').catch((e: unknown) => e);
    expect((nf as VercelApiError).code).toBe('not_found');
    const se = await createVercelClient(TOKEN, { fetch: status(500) }).listTeams().catch((e: unknown) => e);
    expect(mapVercelApiError(se).code).toBe(ERROR_CODES.VERCEL_API_ERROR);
    expect((nf as Error).message).not.toContain(TOKEN);
    expect(mapVercelApiError(se).message).not.toContain(TOKEN);
  });

  test('a network failure and a non-JSON body are VERCEL_API_ERROR, token never echoed', async () => {
    const down: VercelFetchLike = async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    };
    const e1 = await createVercelClient(TOKEN, { fetch: down }).listTeams().catch((e: unknown) => e);
    expect(mapVercelApiError(e1).code).toBe(ERROR_CODES.VERCEL_API_ERROR);
    expect((e1 as Error).message).not.toContain(TOKEN);
    const html: VercelFetchLike = async () => ({ status: 200, ok: true, text: async () => '<html>' });
    const e2 = await createVercelClient(TOKEN, { fetch: html }).listTeams().catch((e: unknown) => e);
    expect(mapVercelApiError(e2).code).toBe(ERROR_CODES.VERCEL_API_ERROR);
  });
});

describe('resolveTeam — 0 / 1 / many', () => {
  const teams = [
    { id: 'team_a', slug: 'alpha' },
    { id: 'team_b', slug: 'beta' },
  ];

  test('no teams: the personal account (no teamId)', async () => {
    expect(await resolveTeam([], undefined, null)).toEqual({ ok: true, teamId: undefined });
  });

  test('exactly one team: used without asking', async () => {
    expect(await resolveTeam([teams[0]], undefined, null)).toEqual({ ok: true, teamId: 'team_a', teamSlug: 'alpha' });
  });

  test('several, non-interactive: VERCEL_TEAM_REQUIRED listing the slugs', async () => {
    const r = await resolveTeam(teams, undefined, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(ERROR_CODES.VERCEL_TEAM_REQUIRED);
    expect(r.message).toContain('alpha');
    expect(r.message).toContain('beta');
  });

  test('several, interactive: the picked team', async () => {
    expect(await resolveTeam(teams, undefined, async () => 'team_b')).toEqual({ ok: true, teamId: 'team_b', teamSlug: 'beta' });
  });

  test('--team by slug or by id; an unknown one is VERCEL_TEAM_NOT_FOUND', async () => {
    expect(await resolveTeam(teams, 'beta', null)).toEqual({ ok: true, teamId: 'team_b', teamSlug: 'beta' });
    expect(await resolveTeam(teams, 'team_a', null)).toEqual({ ok: true, teamId: 'team_a', teamSlug: 'alpha' });
    const r = await resolveTeam(teams, 'gamma', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ERROR_CODES.VERCEL_TEAM_NOT_FOUND);
  });
});

describe('project links', () => {
  test('github link → org/repo/productionBranch', () => {
    expect(parseGitLink({ type: 'github', org: 'acme', repo: 'widgets', productionBranch: 'main' })).toEqual({
      kind: 'github',
      org: 'acme',
      repo: 'widgets',
      productionBranch: 'main',
    });
  });

  test('gitlab / bitbucket / anything else is carried as unsupported (reported, never guessed)', () => {
    expect(parseGitLink({ type: 'gitlab', projectId: 5 })).toEqual({ kind: 'unsupported', type: 'gitlab' });
    expect(parseGitLink({ type: 'bitbucket', slug: 'x' })).toEqual({ kind: 'unsupported', type: 'bitbucket' });
  });

  test('no link at all is null', () => {
    expect(parseGitLink(undefined)).toBeNull();
    expect(parseGitLink(null)).toBeNull();
  });
});

describe('buildEnvironmentPlans — type → skip mapping, scoping, targets', () => {
  const plan = (envs: readonly VercelEnvRecord[], custom: ReadonlyArray<{ id: string; slug: string }> = []) =>
    buildEnvironmentPlans(envs, custom);
  const byName = (plans: ReturnType<typeof plan>, name: string) => plans.find((p) => p.environment.name === name);

  test('plain and encrypted are importable; sensitive, system, legacy secret each skip with their own reason', () => {
    const p = plan([
      rec({ id: '1', key: 'PLAIN', type: 'plain' }),
      rec({ id: '2', key: 'ENC', type: 'encrypted' }),
      rec({ id: '3', key: 'SENS', type: 'sensitive' }),
      rec({ id: '4', key: 'SYS', type: 'system' }),
      rec({ id: '5', key: 'OLD', type: 'secret' }),
      rec({ id: '6', key: 'WEIRD', type: 'quantum' }),
    ]);
    const prod = byName(p, 'production')!;
    expect(prod.importable.map((r) => r.key)).toEqual(['PLAIN', 'ENC']);
    expect(Object.fromEntries(prod.skipped.map((s) => [s.name, s.reason]))).toEqual({
      SENS: 'sensitive_unreadable',
      SYS: 'vercel_system',
      OLD: 'legacy_secret_unreadable',
      WEIRD: 'unsupported_type',
    });
  });

  test('a preview record scoped to a git branch is skipped (git_branch_scoped, name + branch); an unscoped one is imported', () => {
    const p = plan([
      rec({ id: '1', key: 'SCOPED', targets: ['preview'], gitBranch: 'feature/x' }),
      rec({ id: '2', key: 'ALL_BRANCHES', targets: ['preview'] }),
    ]);
    const preview = byName(p, 'preview')!;
    expect(preview.importable.map((r) => r.key)).toEqual(['ALL_BRANCHES']);
    expect(preview.skipped).toEqual([{ name: 'SCOPED', reason: 'git_branch_scoped', gitBranch: 'feature/x' }]);
  });

  test('one record targeting several environments counts in each', () => {
    const p = plan([rec({ id: '1', key: 'SHARED', targets: ['production', 'preview', 'development'] })]);
    expect(p.map((x) => x.environment.name)).toEqual(['production', 'preview', 'development']);
    expect(p.every((x) => x.importable.map((r) => r.key).join() === 'SHARED')).toBe(true);
  });

  test('a target given as a bare string works (the docs allow string or array)', () => {
    const p = plan([rec({ id: '1', key: 'ONE', targets: ['development'] })]);
    expect(byName(p, 'development')!.importable.length).toBe(1);
    expect(byName(p, 'production')).toBeUndefined();
  });

  test('custom environments map to their slug via customEnvironmentIds', () => {
    const p = plan(
      [rec({ id: '1', key: 'FOR_STAGING', targets: [], customEnvironmentIds: ['env_c1'] }), rec({ id: '2', key: 'BOTH', targets: ['production'], customEnvironmentIds: ['env_c1'] })],
      [{ id: 'env_c1', slug: 'staging' }],
    );
    const staging = byName(p, 'staging')!;
    expect(staging.environment).toEqual({ name: 'staging', kind: 'custom', customEnvironmentId: 'env_c1' });
    expect(staging.importable.map((r) => r.key)).toEqual(['FOR_STAGING', 'BOTH']);
    expect(byName(p, 'production')!.importable.map((r) => r.key)).toEqual(['BOTH']);
  });

  test('a git-branch scope only matters in preview', () => {
    const p = plan([rec({ id: '1', key: 'K', targets: ['production'], gitBranch: 'main' })]);
    expect(byName(p, 'production')!.importable.length).toBe(1);
  });

  test('the same name twice in one environment: first wins, the other is reported duplicate_key', () => {
    const p = plan([rec({ id: '1', key: 'DUP' }), rec({ id: '2', key: 'DUP' })]);
    const prod = byName(p, 'production')!;
    expect(prod.importable.map((r) => r.id)).toEqual(['1']);
    expect(prod.skipped).toEqual([{ name: 'DUP', reason: 'duplicate_key' }]);
  });

  test('groupSkipped groups names by reason, branch kept for scoped ones', () => {
    expect(
      groupSkipped([
        { name: 'A', reason: 'sensitive_unreadable' },
        { name: 'B', reason: 'git_branch_scoped', gitBranch: 'dev' },
        { name: 'C', reason: 'sensitive_unreadable' },
      ]),
    ).toEqual({
      git_branch_scoped: [{ name: 'B', gitBranch: 'dev' }],
      sensitive_unreadable: [{ name: 'A' }, { name: 'C' }],
    });
  });
});

describe('resolveEnvValues', () => {
  test('plain uses the list value (no extra request); encrypted comes from the per-id route', async () => {
    const getEnvValue = mock(async (_p: string, envId: string, _t?: string) => `decrypted-${envId}`);
    const client = { getEnvValue };
    const r = await resolveEnvValues(client, 'prj', undefined, [
      rec({ id: 'e1', key: 'P', type: 'plain', value: 'plain-value' }),
      rec({ id: 'e2', key: 'E', type: 'encrypted', value: 'ciphertext-from-list' }),
    ]);
    expect(getEnvValue.mock.calls.map(([, envId]) => envId)).toEqual(['e2']);
    expect(r.entries.map((e) => [e.record.key, e.value])).toEqual([
      ['P', 'plain-value'],
      ['E', 'decrypted-e2'],
    ]);
    expect(r.empty).toEqual([]);
  });

  test('an empty or absent value although typed readable is skipped as empty_value, never imported as ""', async () => {
    const client = { getEnvValue: async (_p: string, envId: string) => (envId === 'e1' ? '' : undefined) };
    const r = await resolveEnvValues(client, 'prj', undefined, [
      rec({ id: 'e1', key: 'EMPTY', type: 'encrypted' }),
      rec({ id: 'e2', key: 'ABSENT', type: 'encrypted' }),
      rec({ id: 'e3', key: 'PLAIN_EMPTY', type: 'plain', value: '' }),
    ]);
    expect(r.entries).toEqual([]);
    expect(r.empty.map((s) => [s.name, s.reason])).toEqual([
      ['EMPTY', 'empty_value'],
      ['ABSENT', 'empty_value'],
      ['PLAIN_EMPTY', 'empty_value'],
    ]);
  });
});

describe('resolveVercelToken', () => {
  const base = { env: {} as Record<string, string | undefined>, interactive: false };

  test('an explicit --token-env that is set wins, with zero store traffic', async () => {
    const getConnectorSecret = mock(async (_n: string, _o: unknown) => 'from-store');
    const r = await resolveVercelToken({
      ...base,
      tokenEnv: 'MY_VERCEL',
      env: { MY_VERCEL: 'from-env', VERCEL_TOKEN: 'other' },
      getConnectorSecret,
    });
    expect(r).toEqual({ ok: true, value: 'from-env', source: 'env' });
    expect(getConnectorSecret.mock.calls.length).toBe(0);
  });

  test('then the system store entry _CONNECTOR_VERCEL_TOKEN', async () => {
    const getConnectorSecret = mock(async (_n: string, _o: unknown) => 'from-store');
    const r = await resolveVercelToken({ ...base, env: { VERCEL_TOKEN: 'fallback' }, getConnectorSecret });
    expect(r).toEqual({ ok: true, value: 'from-store', source: 'system' });
    expect(getConnectorSecret.mock.calls.map(([n]) => n)).toEqual(['_CONNECTOR_VERCEL_TOKEN']);
  });

  test('then $VERCEL_TOKEN', async () => {
    expect(await resolveVercelToken({ ...base, env: { VERCEL_TOKEN: 'fallback' } })).toEqual({ ok: true, value: 'fallback', source: 'env' });
  });

  test('nothing anywhere: VERCEL_TOKEN_MISSING', async () => {
    expect(await resolveVercelToken(base)).toEqual({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING });
  });

  test('a store refusal carries the store\'s own code (never its message)', async () => {
    const r = await resolveVercelToken({
      ...base,
      getConnectorSecret: async () => {
        throw Object.assign(new Error('admins only, honest'), { code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
      },
    });
    expect(r).toEqual({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
  });

  test('the store is told whether it may prompt, and a hidden prompt is suppressed under --json/--dry-run/--web', async () => {
    const getConnectorSecret = mock(async (_n: string, _o: { interactive: boolean }) => null);
    await resolveVercelToken({ ...base, interactive: true, getConnectorSecret });
    expect(getConnectorSecret.mock.calls.map(([, o]) => o.interactive)).toEqual([true]);
    expect(vercelSecretsMayPrompt(true, false)).toBe(true);
    expect(vercelSecretsMayPrompt(true, true)).toBe(false);
    expect(vercelSecretsMayPrompt(false, false)).toBe(false);
  });
});
