/**
 * Vercel deploy target, API mode (CAP-696): a target whose options carry a
 * `projectId` writes env vars through Vercel's REST API with a token — no
 * `vercel` binary, no login, no `.vercel/project.json`.
 *
 * Every write test asserts the PROPERTY, against an in-memory Vercel
 * (`vercelApiModeFake.ts`) that applies the POSTs and PATCHes it receives:
 * "what does each environment see afterwards?", never "was this request sent".
 * `fetch` is injected, so nothing here reaches the network, and every token
 * and value is a fake.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createVercelAdapter } from '../../src/deploy/adapters/vercel';
import type { DeployAdapter, DeployContext, TargetConfig } from '../../src/deploy/adapter';
import { ERROR_CODES } from '../../src/types/index';
import { createFakeVercel, type FakeRecord, type FakeVercelOptions } from './vercelApiModeFake';

const TOKEN = 'tok_fake_value';
const PROJECT = 'prj_1';
const TEAM = 'team_1';

function rec(over: Partial<FakeRecord> & Pick<FakeRecord, 'id' | 'key' | 'value' | 'target'>): FakeRecord {
  return { type: 'encrypted', ...over };
}

function setUp(fakeOpts: FakeVercelOptions = {}) {
  const fake = createFakeVercel({ projectId: PROJECT, teamId: TEAM, token: TOKEN, ...fakeOpts });
  const sleep = mock(async (_ms: number) => {});
  const adapter: DeployAdapter = createVercelAdapter({
    fetch: fake.fetch,
    sleep,
    now: () => 1_000_000_000_000,
    env: {},
    getTargetSecret: async () => TOKEN,
  });
  return { fake, sleep, adapter };
}

function target(options: Record<string, unknown>, vars: readonly string[] = ['API_KEY']): TargetConfig {
  return {
    name: 'vercel-api',
    kind: 'vercel',
    branch: 'production',
    vars: [...vars],
    mode: 'ci',
    options: { projectDir: 'web', projectId: PROJECT, teamId: TEAM, ...options },
  };
}

function ctx(env: Record<string, string>, over: Partial<DeployContext> = {}): DeployContext {
  return { env, dryRun: false, secretsOnly: true, cwd: '/nonexistent-cwd', interactive: false, ...over };
}

describe('vercel API mode — write plan, shared records', () => {
  test('writing production NEVER changes what preview or development sees (shared record is split, not overwritten)', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old-shared', target: ['production', 'preview', 'development'] })],
    });
    const before = {
      preview: fake.seenBy('preview', 'API_KEY'),
      development: fake.seenBy('development', 'API_KEY'),
    };
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new-prod' }));

    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('new-prod');
    expect(fake.seenBy('preview', 'API_KEY')).toBe(before.preview);
    expect(fake.seenBy('development', 'API_KEY')).toBe(before.development);
    expect(fake.seenBy('preview', 'API_KEY')).toBe('old-shared');
    // The shared record is still there, now serving only the others; nothing was deleted or upserted.
    const shared = fake.records().find((r) => r.id === 'env_shared');
    expect(shared?.target).toEqual(['preview', 'development']);
    expect(shared?.value).toBe('old-shared');
    expect(fake.writeCalls().some((c) => c.method === 'DELETE')).toBe(false);
    expect(fake.calls().some((c) => c.query.upsert !== undefined)).toBe(false);
  });

  test('writing preview leaves production and development exactly as they were', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old-shared', target: ['production', 'preview', 'development'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'preview' }), ctx({ API_KEY: 'new-preview' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('preview', 'API_KEY')).toBe('new-preview');
    expect(fake.seenBy('production', 'API_KEY')).toBe('old-shared');
    expect(fake.seenBy('development', 'API_KEY')).toBe('old-shared');
  });

  test('a shared record whose value already equals ours is left alone', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'same', target: ['production', 'preview'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'same' }));
    expect(result.ok).toBe(true);
    expect(fake.writeCalls()).toEqual([]);
    expect(fake.records().map((r) => r.target)).toEqual([['production', 'preview']]);
  });

  test('if creating the replacement record fails after the split, the shared record is put back', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old-shared', target: ['production', 'preview'] })],
      failPostFor: ['API_KEY'],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(false);
    expect(result.steps[0].code).toBe(ERROR_CODES.VERCEL_API_ERROR);
    // Production did not lose its variable: the shared record serves both again.
    expect(fake.seenBy('production', 'API_KEY')).toBe('old-shared');
    expect(fake.seenBy('preview', 'API_KEY')).toBe('old-shared');
    expect(fake.records().find((r) => r.id === 'env_shared')?.target).toEqual(['production', 'preview']);
  });
});

describe('vercel API mode — write plan, other cases', () => {
  test('a record for exactly this environment gets its value edited in place (value only)', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'old', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(fake.records().map((r) => [r.id, r.value])).toEqual([['env_prod', 'new']]);
    const writes = fake.writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].body).toEqual({ value: 'new' });
  });

  test('no record yet: creates one for this environment only, as an encrypted var', async () => {
    const { fake, adapter } = setUp();
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'v1' }));
    expect(result.ok).toBe(true);
    expect(fake.records()).toHaveLength(1);
    expect(fake.records()[0]).toMatchObject({ key: 'API_KEY', value: 'v1', type: 'encrypted', target: ['production'] });
    expect(fake.seenBy('preview', 'API_KEY')).toBeUndefined();
    expect(fake.seenBy('development', 'API_KEY')).toBeUndefined();
  });

  test('value already equal: nothing is written', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'same', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'same' }));
    expect(result.ok).toBe(true);
    expect(fake.writeCalls()).toEqual([]);
  });

  test('a sensitive record stays sensitive, and is reported written-but-not-readable-back, never verified', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'old', type: 'sensitive', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(fake.records()[0]).toMatchObject({ type: 'sensitive', value: 'new' });
    // The PATCH never sends a type, so it cannot downgrade the record.
    expect(fake.writeCalls()[0].body).toEqual({ value: 'new' });
    const verify = result.steps.find((s) => s.label === 'verify Vercel env');
    expect(verify?.detail).toContain('0 verified');
    expect(verify?.detail).toContain('API_KEY');
    expect(verify?.detail).toContain('not readable back');
  });

  test('a split off a sensitive shared record creates the new record as sensitive too', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old', type: 'sensitive', target: ['production', 'preview'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    const created = fake.records().find((r) => r.id !== 'env_shared');
    expect(created).toMatchObject({ type: 'sensitive', target: ['production'], value: 'new' });
    expect(fake.seenBy('preview', 'API_KEY')).toBe('old');
  });

  test('a team that turns every new production var sensitive: the write succeeds and is reported unverified', async () => {
    const { fake, adapter } = setUp({ enforceSensitive: true });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'v1' }));
    expect(result.ok).toBe(true);
    expect(fake.records()[0].type).toBe('sensitive');
    expect(result.steps.find((s) => s.label === 'verify Vercel env')?.detail).toContain('not readable back');
  });

  test('development is allowed in API mode and is written on its own', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old', target: ['production', 'development'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'development' }), ctx({ API_KEY: 'dev-only' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('development', 'API_KEY')).toBe('dev-only');
    expect(fake.seenBy('production', 'API_KEY')).toBe('old');
  });

  test('keys that are not in config.vars are never touched, not even read back', async () => {
    const others = [
      rec({ id: 'env_other', key: 'OTHER', value: 'keep-me', target: ['production'] }),
      rec({ id: 'env_other2', key: 'ANOTHER', value: 'keep-me-too', target: ['production', 'preview'] }),
    ];
    const { fake, adapter } = setUp({
      records: [...others, rec({ id: 'env_prod', key: 'API_KEY', value: 'old', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new', OTHER: 'ignored', ANOTHER: 'ignored' }));
    expect(result.ok).toBe(true);
    expect(fake.records().filter((r) => r.key !== 'API_KEY')).toEqual(others);
    expect(fake.calls().filter((c) => c.path.includes('env_other'))).toEqual([]);
  });

  test('several vars: each is planned on its own', async () => {
    const { fake, adapter } = setUp({
      records: [
        rec({ id: 'e1', key: 'A', value: 'old-a', target: ['production'] }),
        rec({ id: 'e2', key: 'B', value: 'same-b', target: ['production'] }),
        rec({ id: 'e3', key: 'C', value: 'old-c', target: ['production', 'preview'] }),
      ],
    });
    const result = await adapter.deploy(
      target({ vercelEnv: 'production' }, ['A', 'B', 'C', 'D']),
      ctx({ A: 'new-a', B: 'same-b', C: 'new-c', D: 'new-d' }),
    );
    expect(result.ok).toBe(true);
    expect(['A', 'B', 'C', 'D'].map((k) => fake.seenBy('production', k))).toEqual(['new-a', 'same-b', 'new-c', 'new-d']);
    expect(fake.seenBy('preview', 'C')).toBe('old-c');
    expect(result.steps[0].detail).toContain('created 1, updated 1, split from a shared record 1, unchanged 1');
  });
});

describe('vercel API mode — preview scope', () => {
  test('preview with a gitBranch writes a branch-scoped record and leaves the all-branches one alone', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_all', key: 'API_KEY', value: 'for-all-branches', target: ['preview'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'preview', gitBranch: 'staging' }), ctx({ API_KEY: 'staging-value' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('preview', 'API_KEY', 'staging')).toBe('staging-value');
    expect(fake.seenBy('preview', 'API_KEY', 'some-other-branch')).toBe('for-all-branches');
    expect(fake.records().find((r) => r.id !== 'env_all')).toMatchObject({ gitBranch: 'staging', target: ['preview'] });
  });

  test('preview WITHOUT a gitBranch applies to all preview branches: the record carries no gitBranch', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_branch', key: 'API_KEY', value: 'staging-only', target: ['preview'], gitBranch: 'staging' })],
    });
    const preflight = await adapter.preflight(target({ vercelEnv: 'preview' }), { cwd: '/nonexistent-cwd' });
    expect(preflight.ok).toBe(true);
    const result = await adapter.deploy(target({ vercelEnv: 'preview' }), ctx({ API_KEY: 'everywhere' }));
    expect(result.ok).toBe(true);
    const created = fake.records().find((r) => r.id !== 'env_branch');
    expect(created?.gitBranch).toBeUndefined();
    expect(fake.writeCalls()[0].body).not.toHaveProperty('gitBranch');
    expect(fake.seenBy('preview', 'API_KEY', 'any-branch')).toBe('everywhere');
    // The branch-specific record is a different scope and keeps its own value.
    expect(fake.seenBy('preview', 'API_KEY', 'staging')).toBe('staging-only');
  });

  test('updating an existing all-branches preview record patches that record', async () => {
    const { fake, adapter } = setUp({
      records: [rec({ id: 'env_all', key: 'API_KEY', value: 'old', target: ['preview'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'preview' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(fake.records().map((r) => [r.id, r.value])).toEqual([['env_all', 'new']]);
  });
});

describe('vercel API mode — custom environments', () => {
  const customEnvs = [{ id: 'env_stg', slug: 'staging' }, { id: 'env_qa', slug: 'qa' }];

  test('a custom environment slug is resolved to its id; the record serves only that environment', async () => {
    const { fake, adapter } = setUp({ customEnvs });
    const result = await adapter.deploy(target({ vercelEnv: 'staging' }), ctx({ API_KEY: 'stg-value' }));
    expect(result.ok).toBe(true);
    const created = fake.records()[0];
    expect(created.customEnvironmentIds).toEqual(['env_stg']);
    expect(created.target).toEqual([]);
    expect(fake.seenBy('custom:env_stg', 'API_KEY')).toBe('stg-value');
    expect(fake.seenBy('production', 'API_KEY')).toBeUndefined();
  });

  test('customEnvironmentId in the options is used as given', async () => {
    const { fake, adapter } = setUp({ customEnvs });
    const result = await adapter.deploy(target({ vercelEnv: 'staging', customEnvironmentId: 'env_stg' }), ctx({ API_KEY: 'x' }));
    expect(result.ok).toBe(true);
    expect(fake.records()[0].customEnvironmentIds).toEqual(['env_stg']);
  });

  test('writing one custom environment leaves the other custom environment on a shared record untouched', async () => {
    const { fake, adapter } = setUp({
      customEnvs,
      records: [rec({ id: 'env_shared', key: 'API_KEY', value: 'old', target: [], customEnvironmentIds: ['env_stg', 'env_qa'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'staging' }), ctx({ API_KEY: 'stg-only' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('custom:env_stg', 'API_KEY')).toBe('stg-only');
    expect(fake.seenBy('custom:env_qa', 'API_KEY')).toBe('old');
  });

  test('a custom environment that does not exist is refused at preflight, before any value is sent', async () => {
    const { fake, adapter } = setUp({ customEnvs });
    const result = await adapter.preflight(target({ vercelEnv: 'nope' }), { cwd: '/nonexistent-cwd' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND);
    expect(fake.writeCalls()).toEqual([]);
  });
});

describe('vercel API mode — rate limits', () => {
  test('a 429 is waited out (retry-after, in seconds) and the write then lands', async () => {
    const { fake, adapter, sleep } = setUp({
      rateLimit: { count: 2, headers: { 'retry-after': '3' } },
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'old', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('new');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 3000]);
  });

  test('x-ratelimit-reset (epoch seconds) is used when there is no retry-after', async () => {
    // now() is fixed at 1_000_000_000_000 ms; a reset 7s later means a 7000 ms wait.
    const { adapter, sleep } = setUp({
      rateLimit: { count: 1, headers: { 'x-ratelimit-reset': String(1_000_000_000 + 7) } },
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000]);
  });

  test('429 forever: bounded retries, then a coded failure', async () => {
    const { fake, adapter, sleep } = setUp({ rateLimit: { count: 99, headers: { 'retry-after': '1' } } });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(false);
    expect(result.steps[0].code).toBe(ERROR_CODES.VERCEL_RATE_LIMITED);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fake.records()).toEqual([]);
  });

  test('a wait longer than the cap is not waited for', async () => {
    const { adapter, sleep } = setUp({ rateLimit: { count: 1, headers: { 'retry-after': '3600' } } });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(false);
    expect(result.steps[0].code).toBe(ERROR_CODES.VERCEL_RATE_LIMITED);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('vercel API mode — preflight', () => {
  const prefl = (adapter: DeployAdapter, options: Record<string, unknown> = { vercelEnv: 'production' }) =>
    adapter.preflight(target(options), { cwd: '/nonexistent-cwd' });

  test('good token, existing project: ok — with no .vercel/project.json and no project directory on disk', async () => {
    const { adapter } = setUp();
    expect((await prefl(adapter)).ok).toBe(true);
  });

  test('401 → VERCEL_TOKEN_REJECTED', async () => {
    const { adapter, fake } = setUp({ token: 'a-different-token' });
    const r = await prefl(adapter);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(ERROR_CODES.VERCEL_TOKEN_REJECTED);
    expect(fake.writeCalls()).toEqual([]);
  });

  test('403 → VERCEL_NO_ACCESS', async () => {
    const { adapter } = setUp({ projectStatus: 403 });
    expect((await prefl(adapter)).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
  });

  test('404 → VERCEL_PROJECT_NOT_FOUND', async () => {
    const { adapter } = setUp();
    const r = await prefl(adapter, { vercelEnv: 'production', projectId: 'prj_gone' });
    expect(r.code).toBe(ERROR_CODES.VERCEL_PROJECT_NOT_FOUND);
  });

  test('a dropped connection → VERCEL_NETWORK_ERROR', async () => {
    const { adapter } = setUp({ dropConnection: true });
    expect((await prefl(adapter)).code).toBe(ERROR_CODES.VERCEL_NETWORK_ERROR);
  });

  test('a failed preflight means deploy was never asked to send a value: preflight itself makes no write', async () => {
    const { adapter, fake } = setUp({ projectStatus: 403 });
    await prefl(adapter);
    expect(fake.writeCalls()).toEqual([]);
  });

  test('an empty vars list is refused', async () => {
    const { adapter } = setUp();
    const r = await adapter.preflight(target({ vercelEnv: 'production' }, []), { cwd: '/nonexistent-cwd' });
    expect(r.ok).toBe(false);
  });

  test('missing vercelEnv is a coded options refusal', async () => {
    const { adapter } = setUp();
    const r = await adapter.preflight(target({}), { cwd: '/nonexistent-cwd' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(ERROR_CODES.VERCEL_OPTIONS_INVALID);
  });
});

describe('vercel API mode — dry run', () => {
  test('zero write calls; says what it would do with names and counts, never a value', async () => {
    const { fake, adapter } = setUp({
      records: [
        rec({ id: 'e1', key: 'A', value: 'secret-a', target: ['production'] }),
        rec({ id: 'e2', key: 'C', value: 'secret-c', target: ['production', 'preview'] }),
      ],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }, ['A', 'B', 'C']), ctx({}, { dryRun: true }));
    expect(result.ok).toBe(true);
    expect(fake.writeCalls()).toEqual([]);
    const detail = result.steps[0].detail ?? '';
    expect(detail).toContain('would push 3 var(s) to production');
    expect(detail).toContain('create 1 [B]');
    expect(detail).toContain('update 1 [A]');
    expect(detail).toContain('split from a shared record 1 [C]');
    expect(detail).not.toContain('secret-a');
    expect(detail).not.toContain('secret-c');
    expect(fake.records().map((r) => r.value)).toEqual(['secret-a', 'secret-c']);
  });
});

describe('vercel API mode — read-back verification', () => {
  test('verified: values read back hash to what was sent', async () => {
    const { adapter } = setUp({
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'old', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.label === 'verify Vercel env')).toMatchObject({ status: 'ok', detail: '1 verified' });
  });

  test('mismatch: Vercel holding another value is a coded failure naming the var, never the values', async () => {
    const { adapter } = setUp({
      corruptWrites: true,
      records: [rec({ id: 'env_prod', key: 'API_KEY', value: 'old', target: ['production'] })],
    });
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'new-secret-value' }));
    expect(result.ok).toBe(false);
    const step = result.steps.find((s) => s.label === 'verify Vercel env');
    expect(step?.status).toBe('fail');
    expect(step?.code).toBe(ERROR_CODES.VERCEL_VERIFY_MISMATCH);
    expect(step?.detail).toContain('API_KEY');
    expect(JSON.stringify(result)).not.toContain('new-secret-value');
    expect(JSON.stringify(result)).not.toContain('corrupted');
  });
});

describe('vercel API mode — token handling', () => {
  test('the token is only ever sent as a bearer header, and never appears in any result', async () => {
    const { fake, adapter } = setUp();
    const result = await adapter.deploy(target({ vercelEnv: 'production' }), ctx({ API_KEY: 'v' }));
    expect(fake.calls().every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fake.calls().every((c) => !JSON.stringify(c.query).includes(TOKEN))).toBe(true);
  });

  test('a pre-resolved token from the caller wins, and the store is not asked again', async () => {
    const fake = createFakeVercel({ projectId: PROJECT, teamId: TEAM, token: TOKEN });
    const getTargetSecret = mock(async () => 'should-not-be-used');
    const adapter = createVercelAdapter({ fetch: fake.fetch, env: {}, getTargetSecret });
    const r = await adapter.preflight(target({ vercelEnv: 'production' }), {
      cwd: '/nonexistent-cwd',
      resolvedVercelToken: { ok: true, value: TOKEN, source: 'system' },
    });
    expect(r.ok).toBe(true);
    expect(getTargetSecret).not.toHaveBeenCalled();
  });

  test('a refused token resolution is a coded preflight refusal and nothing is sent to Vercel', async () => {
    const fake = createFakeVercel({ projectId: PROJECT, teamId: TEAM, token: TOKEN });
    const adapter = createVercelAdapter({ fetch: fake.fetch, env: {}, getTargetSecret: async () => null });
    const r = await adapter.preflight(target({ vercelEnv: 'production' }), { cwd: '/nonexistent-cwd' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(ERROR_CODES.VERCEL_TOKEN_MISSING);
    expect(fake.calls()).toEqual([]);
  });

  test('a system-store refusal passes its own code through', async () => {
    const fake = createFakeVercel({ projectId: PROJECT, token: TOKEN });
    const adapter = createVercelAdapter({
      fetch: fake.fetch,
      env: {},
      getTargetSecret: async () => {
        throw Object.assign(new Error('x'), { code: ERROR_CODES.VERCEL_TARGET_KEY_MISSING });
      },
    });
    const r = await adapter.preflight(target({ vercelEnv: 'production' }), { cwd: '/nonexistent-cwd' });
    expect(r.code).toBe(ERROR_CODES.VERCEL_TARGET_KEY_MISSING);
  });
});

describe('vercel — CLI path is unchanged when projectId is absent', () => {
  test('a target without projectId never touches fetch, and keeps its CLI-path refusals', async () => {
    const fetchSpy = mock(async () => new Response('{}'));
    const adapter = createVercelAdapter({ fetch: fetchSpy as never, env: {}, getTargetSecret: async () => TOKEN });
    const legacy: TargetConfig = {
      name: 'v',
      kind: 'vercel',
      branch: 'production',
      vars: ['A'],
      mode: 'ci',
      options: { projectDir: 'web', vercelEnv: 'production' },
    };
    // Not linked, no TTY: exactly the old refusal (the project dir is checked first).
    const pre = await adapter.preflight(legacy, { cwd: '/nonexistent-cwd' });
    expect(pre.ok).toBe(false);
    expect(pre.reason).toMatch(/not found/);
    const dep = await adapter.deploy(legacy, ctx({}));
    expect(dep.ok).toBe(false);
    expect(dep.steps[0].detail).toMatch(/missing in branch production: A/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('legacy dry run keeps its exact wording', async () => {
    const { adapter } = setUp();
    const legacy: TargetConfig = {
      name: 'v',
      kind: 'vercel',
      branch: 'production',
      vars: ['A', 'B'],
      mode: 'ci',
      options: { projectDir: 'web', vercelEnv: 'preview', gitBranch: 'dev' },
    };
    const r = await adapter.deploy(legacy, ctx({}, { dryRun: true }));
    expect(r.steps).toEqual([
      { label: 'set Vercel env', status: 'skip', detail: 'dry-run — would push 2 var(s) to preview · branch=dev, then open the deploy PR' },
    ]);
  });

  test('an empty or blank projectId does not switch a target into API mode', async () => {
    const fetchSpy = mock(async () => new Response('{}'));
    const adapter = createVercelAdapter({ fetch: fetchSpy as never, env: {}, getTargetSecret: async () => TOKEN });
    const r = await adapter.preflight(
      { name: 'v', kind: 'vercel', branch: 'production', vars: ['A'], mode: 'ci', options: { projectDir: 'web', vercelEnv: 'production', projectId: '  ' } },
      { cwd: '/nonexistent-cwd' },
    );
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
