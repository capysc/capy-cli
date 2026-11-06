/**
 * Deploying to Vercel with placeholders (names with no value in Capy yet) and sensitive Vercel values.
 *
 * Properties, asserted on an in-memory Vercel (`vercelApiModeFake.ts`): "what does Vercel hold afterwards?"
 *   - a placeholder is never written: Vercel keeps its own value, and the deploy reports it as kept (not "missing in branch");
 *     a var that is truly missing still fails;
 *   - replacing a value Vercel holds as `sensitive` (Capy cannot read it, so cannot tell whether it differs) needs a yes the
 *     FIRST time for a target: a person at a terminal, or `--replace-sensitive`; otherwise a coded refusal naming the
 *     vars and nothing is written. The delivery that follows is the record that it was confirmed: later deploys do not ask;
 *   - a dry run says so without writing anything.
 * The CLI-mode (binary) path leaves placeholders alone too. Every token and value is a fake.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createVercelAdapter } from '../../src/deploy/adapters/vercel';
import type { DeployAdapter, DeployContext, TargetConfig } from '../../src/deploy/adapter';
import { deliveredBefore, deliveryFor } from '../../src/deploy/deliveryRecord';
import { recordTargetDeliveries } from '../../src/deploy/targetsGate';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import { createFakeVercel, type FakeRecord, type FakeVercelOptions } from './vercelApiModeFake';

const TOKEN = 'tok_fake_value';
const PROJECT = 'prj_1';
const TEAM = 'team_1';

const rec = (over: Partial<FakeRecord> & Pick<FakeRecord, 'id' | 'key' | 'value' | 'target'>): FakeRecord => ({ type: 'encrypted', ...over });

function setUp(fakeOpts: FakeVercelOptions = {}) {
  const fake = createFakeVercel({ projectId: PROJECT, teamId: TEAM, token: TOKEN, ...fakeOpts });
  const adapter: DeployAdapter = createVercelAdapter({
    fetch: fake.fetch,
    sleep: mock(async (_ms: number) => {}),
    now: () => 1_000_000_000_000,
    env: {},
    getTargetSecret: async () => TOKEN,
  });
  return { fake, adapter };
}

const target = (vars: readonly string[], options: Record<string, unknown> = {}): TargetConfig => ({
  name: 'vercel-api',
  kind: 'vercel',
  branch: 'production',
  vars: [...vars],
  mode: 'ci',
  options: { projectDir: 'web', projectId: PROJECT, teamId: TEAM, vercelEnv: 'production', ...options },
});

const ctx = (env: Record<string, string>, over: Partial<DeployContext> = {}): DeployContext => ({
  env,
  dryRun: false,
  secretsOnly: true,
  cwd: '/nonexistent-cwd',
  interactive: false,
  ...over,
});

const SENSITIVE = rec({ id: 'env_sens', key: 'API_KEY', value: 'vercel-only', type: 'sensitive', target: ['production'] });

describe('a placeholder is never written', () => {
  test('Vercel keeps its value, the other var is written, and the deploy reports the placeholder as kept', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE, rec({ id: 'env_db', key: 'DB_URL', value: 'old-db', target: ['production'] })] });
    const result = await adapter.deploy(target(['API_KEY', 'DB_URL']), ctx({ DB_URL: 'new-db' }, { placeholders: ['API_KEY'] }));

    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('vercel-only');
    expect(fake.seenBy('production', 'DB_URL')).toBe('new-db');
    expect(fake.writeCalls().every((c) => !c.path.includes('env_sens'))).toBe(true);
    expect(result.skipped).toEqual(['API_KEY']);
    const kept = result.steps.find((s) => s.label === 'kept Vercel value');
    expect(kept?.detail).toContain('API_KEY');
    expect(result.steps.find((s) => s.label === 'set Vercel env')?.detail).toContain('1 var(s) pushed');
    expect(JSON.stringify(result)).not.toContain('vercel-only');
  });

  test('a var that is truly missing still fails the deploy, and nothing is written', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY', 'GONE']), ctx({}, { placeholders: ['API_KEY'] }));
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('missing in branch production: GONE');
    expect(result.steps[0].detail).not.toContain('API_KEY');
    expect(fake.writeCalls()).toEqual([]);
  });

  test('a target of nothing but placeholders asks Vercel nothing at all', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({}, { placeholders: ['API_KEY'] }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(['API_KEY']);
    expect(fake.calls()).toEqual([]);
  });

  test('a name that has a value in the env is written even if it is also listed as a placeholder', async () => {
    const { fake, adapter } = setUp({ records: [rec({ id: 'e', key: 'API_KEY', value: 'old', target: ['production'] })] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'now-real' }, { placeholders: ['API_KEY'] }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('now-real');
    expect(result.skipped).toBeUndefined();
  });

  test('the CLI-mode path (no projectId) leaves a placeholder alone and still fails on a truly missing var', async () => {
    const { adapter } = setUp();
    const legacy: TargetConfig = { name: 'v', kind: 'vercel', branch: 'production', vars: ['API_KEY'], options: { projectDir: 'web', vercelEnv: 'production' } };
    const kept = await adapter.deploy(legacy, ctx({}, { placeholders: ['API_KEY'] }));
    expect(kept.ok).toBe(true);
    expect(kept.skipped).toEqual(['API_KEY']);
    expect(kept.steps.find((s) => s.label === 'kept Vercel value')?.detail).toContain('API_KEY');

    const missing = await adapter.deploy({ ...legacy, vars: ['API_KEY', 'GONE'] }, ctx({}, { placeholders: ['API_KEY'] }));
    expect(missing.ok).toBe(false);
    expect(missing.steps[0].detail).toContain('missing in branch production: GONE');
  });
});

describe('replacing a value Vercel holds as sensitive', () => {
  test('off a terminal, without the flag: a coded refusal naming the vars; nothing is written', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'new' }));
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ status: 'fail', code: ERROR_CODES.VERCEL_SENSITIVE_REPLACE_UNCONFIRMED });
    expect(result.steps[0].detail).toContain('API_KEY');
    expect(fake.writeCalls()).toEqual([]);
    expect(fake.seenBy('production', 'API_KEY')).toBe('vercel-only');
  });

  test('with the flag: it proceeds', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'new' }, { sensitiveReplace: { delivered: [], allowed: true } }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('new');
  });

  test('at a terminal it asks once, naming the vars; yes proceeds, no writes nothing', async () => {
    const yes = mock(async (_names: readonly string[]) => true);
    const a = setUp({ records: [SENSITIVE] });
    const ok = await a.adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'new' }, { sensitiveReplace: { delivered: [], allowed: false, ask: yes } }));
    expect(ok.ok).toBe(true);
    expect(yes.mock.calls).toEqual([[['API_KEY']]]);
    expect(a.fake.seenBy('production', 'API_KEY')).toBe('new');

    const no = mock(async (_names: readonly string[]) => false);
    const b = setUp({ records: [SENSITIVE] });
    const refused = await b.adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'new' }, { sensitiveReplace: { delivered: [], allowed: false, ask: no } }));
    expect(refused.ok).toBe(false);
    expect(refused.steps[0]).toMatchObject({ code: ERROR_CODES.VERCEL_SENSITIVE_REPLACE_UNCONFIRMED });
    expect(b.fake.writeCalls()).toEqual([]);
  });

  test('a var this target delivered before is not asked about again', async () => {
    const ask = mock(async (_names: readonly string[]) => false);
    const { fake, adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'newer' }, { sensitiveReplace: { delivered: ['API_KEY'], allowed: false, ask } }));
    expect(result.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(fake.seenBy('production', 'API_KEY')).toBe('newer');
  });

  test('only the sensitive vars are asked about; a readable record is replaced as it always was', async () => {
    const ask = mock(async (_names: readonly string[]) => true);
    const { adapter } = setUp({ records: [SENSITIVE, rec({ id: 'env_db', key: 'DB_URL', value: 'old', target: ['production'] })] });
    const result = await adapter.deploy(target(['API_KEY', 'DB_URL']), ctx({ API_KEY: 'a', DB_URL: 'b' }, { sensitiveReplace: { delivered: [], allowed: false, ask } }));
    expect(result.ok).toBe(true);
    expect(ask.mock.calls).toEqual([[['API_KEY']]]);
  });

  test('a split off a sensitive shared record counts as replacing a sensitive value', async () => {
    const shared = rec({ id: 'env_shared', key: 'API_KEY', value: 'old', type: 'sensitive', target: ['production', 'preview'] });
    const { fake, adapter } = setUp({ records: [shared] });
    const refused = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'new' }));
    expect(refused.ok).toBe(false);
    expect(fake.writeCalls()).toEqual([]);
    expect(fake.seenBy('preview', 'API_KEY')).toBe('old');
  });

  test('a var with no record on Vercel yet is created without asking', async () => {
    const { fake, adapter } = setUp();
    const result = await adapter.deploy(target(['API_KEY']), ctx({ API_KEY: 'first' }));
    expect(result.ok).toBe(true);
    expect(fake.seenBy('production', 'API_KEY')).toBe('first');
  });
});

describe('dry run', () => {
  test('says which sensitive values would need confirmation and which placeholders are kept; writes nothing', async () => {
    const { fake, adapter } = setUp({ records: [SENSITIVE, rec({ id: 'env_keep', key: 'KEPT', value: 'v', type: 'sensitive', target: ['production'] })] });
    const result = await adapter.deploy(target(['API_KEY', 'KEPT']), ctx({}, { dryRun: true, placeholders: ['KEPT'] }));
    expect(result.ok).toBe(true);
    expect(fake.writeCalls()).toEqual([]);
    expect(result.steps.find((s) => s.label === 'replace sensitive value')?.detail).toBe('would replace a sensitive value (needs confirmation): API_KEY');
    expect(result.steps.find((s) => s.label === 'kept Vercel value')?.detail).toContain('KEPT');
    expect(result.steps[0].detail).toContain('would push 1 var(s)');
  });

  test('a sensitive var delivered before is not listed as needing confirmation', async () => {
    const { adapter } = setUp({ records: [SENSITIVE] });
    const result = await adapter.deploy(target(['API_KEY']), ctx({}, { dryRun: true, sensitiveReplace: { delivered: ['API_KEY'], allowed: false } }));
    expect(result.steps.find((s) => s.label === 'replace sensitive value')).toBeUndefined();
  });
});

describe('the record that a replacement was confirmed is the delivery that followed it', () => {
  const delivery = (over: Record<string, unknown>) => ({ provider: 'vercel', target: 'vercel-api', ...over });
  const keepWith = (entry: Record<string, unknown>): KeepFile => ({
    version: '3.0',
    org_id: 'o',
    project_id: 'p',
    project_name: 'demo',
    variables: { API_KEY: [{ resource_id: 'r', branch: 'production', value_hash: 'h', ...entry }] } as KeepFile['variables'],
  });
  const t = { name: 'vercel-api', branch: 'production', vars: ['API_KEY', 'OTHER'] };
  const adapter = { id: 'vercel' };

  test('a delivery with a value hash on this branch and target counts', () => {
    expect(deliveredBefore(keepWith({ targets: [delivery({ deployed_value_hash: 'abc' })] }), t, adapter)).toEqual(['API_KEY']);
  });

  test('end to end: a keep with no delivery asks; the same keep after the delivery is recorded does not', () => {
    const before = keepWith({});
    const { delivery, values } = deliveryFor({ ...t, kind: 'vercel', options: {} } as TargetConfig, adapter, undefined, false, { API_KEY: 'abc' });
    const after = recordTargetDeliveries(before, 'production', delivery, '2026-11-02T00:00:00.000Z', values);
    expect(deliveredBefore(before, t, adapter)).toEqual([]);
    expect(deliveredBefore(after, t, adapter)).toEqual(['API_KEY']);
  });

  test('a target that is only configured (no push yet), another target, another provider or another branch do not', () => {
    expect(deliveredBefore(keepWith({ targets: [delivery({})] }), t, adapter)).toEqual([]);
    expect(deliveredBefore(keepWith({ targets: [delivery({ target: 'other', deployed_value_hash: 'abc' })] }), t, adapter)).toEqual([]);
    expect(deliveredBefore(keepWith({ targets: [delivery({ provider: 'dokploy', deployed_value_hash: 'abc' })] }), t, adapter)).toEqual([]);
    expect(deliveredBefore(keepWith({ targets: [delivery({ deployed_value_hash: 'abc' })] }), { ...t, branch: 'preview' }, adapter)).toEqual([]);
    expect(deliveredBefore(null, t, adapter)).toEqual([]);
  });
});
