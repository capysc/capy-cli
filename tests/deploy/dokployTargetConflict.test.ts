/**
 * Platform values (CAP-717): before a Dokploy delivery writes the service's env it compares each delivered
 * name's LIVE value (remote) with what Capy last delivered (keep.lock's `deployed_value_hash`, pinned) and with
 * what it is about to deliver (local). A value changed on the platform outside Capy needs an answer:
 *   local  → Capy's value is delivered (the outside line is commented out as `# capy:off`, as always);
 *   remote → the variable is skipped: not written, its outside line not commented, no delivery recorded for it.
 *
 * The pure half (`dokployTargetConflicts`, `mergeManagedValuesBlock`'s `keep`) is tested as functions; the adapter
 * half against a scripted Dokploy that fails on any request the test did not expect, so "nothing was written" is
 * "the script has no save step". Values here are fake, non-secret strings.
 */
import { describe, test, expect } from 'bun:test';
import {
  createDokployAdapter,
  mergeManagedValuesBlock,
  CAPY_OFF_MARKER,
  MANAGED_BEGIN,
  MANAGED_END,
  type FetchLike,
} from '../../src/deploy/adapters/dokploy';
import { dokployTargetConflicts, planTargetDelivery } from '../../src/deploy/dokployApi';
import type { DeployContext, TargetConfig } from '../../src/deploy/adapter';
import { hashValue } from '../../src/sync/compareSecrets';

const h = hashValue;

describe('dokployTargetConflicts (pure)', () => {
  const values = [{ name: 'STRIPE_KEY', value: 'new-capy' }];

  test('a live value that is neither what Capy last delivered nor what it is about to deliver is a conflict (fingerprints only)', () => {
    const found = dokployTargetConflicts('STRIPE_KEY=edited-outside\n', values, { STRIPE_KEY: h('old-delivered') });
    expect(found).toEqual([{ name: 'STRIPE_KEY', pinned: h('old-delivered'), local: h('new-capy'), remote: h('edited-outside') }]);
  });

  test('first delivery (nothing recorded) onto a different existing value is a conflict, with no pinned', () => {
    expect(dokployTargetConflicts('STRIPE_KEY=already-there', values, {})).toEqual([
      { name: 'STRIPE_KEY', pinned: undefined, local: h('new-capy'), remote: h('already-there') },
    ]);
  });

  test('no conflict: not on the service, already Capy\'s value, or still what Capy last delivered', () => {
    expect(dokployTargetConflicts('NODE_ENV=production', values, {})).toEqual([]);
    expect(dokployTargetConflicts('STRIPE_KEY=new-capy', values, {})).toEqual([]);
    expect(dokployTargetConflicts('STRIPE_KEY=old-delivered', values, { STRIPE_KEY: h('old-delivered') })).toEqual([]);
    expect(dokployTargetConflicts(null, values, {})).toEqual([]);
  });

  test('remote is what the service would READ: the whole env through dotenv, inside Capy\'s block or an active line outside it', () => {
    const inBlock = `NODE_ENV=production\n${MANAGED_BEGIN}\nSTRIPE_KEY='edited in the block'\n${MANAGED_END}`;
    expect(dokployTargetConflicts(inBlock, values, { STRIPE_KEY: h('old-delivered') })[0]?.remote).toBe(h('edited in the block'));
    // A line Capy commented out is a comment: the service does not see it.
    const commented = `${CAPY_OFF_MARKER}STRIPE_KEY=hidden\nNODE_ENV=production`;
    expect(dokployTargetConflicts(commented, values, {})).toEqual([]);
  });

  test('planTargetDelivery: unanswered conflicts stop the write; answers decide what is written and skipped', () => {
    const env = 'STRIPE_KEY=edited-outside\n';
    const both = [...values, { name: 'PORT', value: '3000' }];
    const check = { pinned: { STRIPE_KEY: h('old-delivered') }, resolutions: {} };
    const open = planTargetDelivery(env, both, check);
    expect(open.kind).toBe('conflict');
    const seen = (choice: 'local' | 'remote') => ({ STRIPE_KEY: { choice, remote: h('edited-outside'), local: h('new-capy') } });
    const local = planTargetDelivery(env, both, { ...check, resolutions: seen('local') });
    expect(local).toMatchObject({ kind: 'clear', skipped: [] });
    expect(local.kind === 'clear' && local.deliver.map((v) => v.name)).toEqual(['STRIPE_KEY', 'PORT']);
    const remote = planTargetDelivery(env, both, { ...check, resolutions: seen('remote') });
    expect(remote).toMatchObject({ kind: 'clear', skipped: ['STRIPE_KEY'] });
    expect(remote.kind === 'clear' && remote.deliver.map((v) => v.name)).toEqual(['PORT']);
    // A decision applies only to the state it was made against: the live value moved, or the value being delivered did.
    const moved = planTargetDelivery('STRIPE_KEY=moved-after-the-answer\n', both, { ...check, resolutions: seen('local') });
    expect(moved.kind).toBe('conflict');
    expect(moved.kind === 'conflict' && moved.open.map((c) => c.remote)).toEqual([h('moved-after-the-answer')]);
    const otherLocal = planTargetDelivery(env, [{ name: 'STRIPE_KEY', value: 'another-capy-value' }], { ...check, resolutions: seen('remote') });
    expect(otherLocal.kind).toBe('conflict');
    // No check at all: the delivery is as it always was.
    expect(planTargetDelivery(env, both, undefined)).toMatchObject({ kind: 'clear', skipped: [], found: [] });
  });
});

describe('mergeManagedValuesBlock with `keep` (a delivery that leaves other managed lines alone)', () => {
  const AWS = "AWS_ACCESS_KEY_ID='AKIA-fake'";
  const existing = `NODE_ENV=production\n${MANAGED_BEGIN}\n${AWS}\nGEMINI_KEY=gemini-old\n${MANAGED_END}\n`;
  const merge = (env: string, values: ReadonlyArray<{ name: string; value: string }>, keep?: (n: string) => boolean) => {
    const merged = mergeManagedValuesBlock(env, values, keep === undefined ? {} : { keep });
    if (!merged.ok) throw new Error('unexpected merge problem');
    return merged.env;
  };

  test('delivering GEMINI only leaves the existing AWS line in the block byte for byte', () => {
    const next = merge(existing, [{ name: 'GEMINI_KEY', value: 'gemini-new' }], () => true);
    expect(next).toBe(`NODE_ENV=production\n${MANAGED_BEGIN}\n${AWS}\nGEMINI_KEY=gemini-new\n${MANAGED_END}\n`);
    // Without `keep` the whole block is the delivery, as it always was.
    expect(merge(existing, [{ name: 'GEMINI_KEY', value: 'gemini-new' }])).toBe(`NODE_ENV=production\n${MANAGED_BEGIN}\nGEMINI_KEY=gemini-new\n${MANAGED_END}\n`);
  });

  test('a new picked name is appended; the others, in their order, are untouched; delivering again changes nothing', () => {
    const next = merge(existing, [{ name: 'OPENAI_KEY', value: 'oa' }], () => true);
    expect(next).toBe(`NODE_ENV=production\n${MANAGED_BEGIN}\n${AWS}\nGEMINI_KEY=gemini-old\nOPENAI_KEY=oa\n${MANAGED_END}\n`);
    expect(merge(next, [{ name: 'OPENAI_KEY', value: 'oa' }], () => true)).toBe(next);
  });

  test('keeping a name the service edited by hand does not touch it, nor un-comment what Capy commented for it', () => {
    const env = `${CAPY_OFF_MARKER}AWS_ACCESS_KEY_ID=outside-old\n${MANAGED_BEGIN}\nAWS_ACCESS_KEY_ID='edited by hand'\n${MANAGED_END}`;
    const next = merge(env, [{ name: 'PORT', value: '3000' }], (name) => name === 'AWS_ACCESS_KEY_ID');
    expect(next).toBe(`${CAPY_OFF_MARKER}AWS_ACCESS_KEY_ID=outside-old\n${MANAGED_BEGIN}\nAWS_ACCESS_KEY_ID='edited by hand'\nPORT=3000\n${MANAGED_END}`);
  });

  test('CRLF framing and a multi-line quoted value survive a kept line', () => {
    const multi = `PEM='line one\nline two'`;
    const env = `A=1\r\n${MANAGED_BEGIN}\r\n${multi}\r\nB=2\r\n${MANAGED_END}\r\n`;
    const next = merge(env, [{ name: 'B', value: '3' }], () => true);
    expect(next).toBe(`A=1\r\n${MANAGED_BEGIN}\r\n${multi}\r\nB=3\r\n${MANAGED_END}\r\n`);
  });
});

// ── The adapter against a scripted Dokploy ──────────────────────────────────

const BASE = 'https://dokploy.example.com';
const TOKEN = 'dk_test_token';
const APP_ID = 'app_conflict';
const KEY = { ok: true as const, value: TOKEN, source: 'env' as const };

interface Step {
  readonly expect: (path: string, body: Record<string, unknown> | null) => void;
  readonly json?: unknown;
}

/** Fails on any request the script does not list, in order. `done()` says whether all were made. */
function scripted(steps: readonly Step[]): { fetch: FetchLike; done: () => boolean } {
  const it = steps[Symbol.iterator]();
  const fetch: FetchLike = async (url, init) => {
    const next = it.next();
    if (next.done) throw new Error(`unscripted request: ${init.method} ${url}`);
    next.value.expect(new URL(url).pathname.replace('/api/', ''), init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null);
    return { status: 200, ok: true, text: async () => JSON.stringify(next.value.json ?? null) };
  };
  return { fetch, done: () => it.next().done === true };
}

const app = (env: string) => ({
  applicationId: APP_ID,
  name: 'web',
  appName: 'web-abc',
  env,
  buildArgs: null,
  buildSecrets: null,
  createEnvFile: true,
  autoDeploy: true,
  branch: 'main',
});
const read = (env: string): Step => ({ expect: (path) => expect(path).toBe('application.one'), json: app(env) });
const save = (expectedEnv: string): Step => ({
  expect: (path, body) => {
    expect(path).toBe('application.saveEnvironment');
    expect(body?.env).toBe(expectedEnv);
  },
  json: true,
});

const target = (vars: readonly string[] = ['STRIPE_KEY']): TargetConfig => ({
  name: 'dokploy-production',
  kind: 'dokploy',
  branch: 'production',
  vars: [...vars],
  mode: 'ci',
  options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'DOKPLOY_API_KEY' },
});
const ctx = (over: Partial<DeployContext>): DeployContext => ({
  env: { STRIPE_KEY: 'new-capy', PORT: '3000' },
  dryRun: false,
  secretsOnly: true,
  cwd: '/tmp',
  resolvedApiKey: KEY,
  ...over,
});
const adapterWith = (fetch: FetchLike) => createDokployAdapter({ fetch, log: () => undefined });

const OUTSIDE = 'NODE_ENV=production\nSTRIPE_KEY=already-there\n';
/** A target check whose decisions were made against the conflict OUTSIDE shows (live 'already-there', delivering 'new-capy'). */
const check = (resolutions: Record<string, 'local' | 'remote'> = {}, pinned: Record<string, string> = {}) => ({
  pinned,
  resolutions: Object.fromEntries(Object.entries(resolutions).map(([name, choice]) => [name, { choice, remote: h('already-there'), local: h('new-capy') }])),
});

describe('the Dokploy adapter and target conflicts', () => {
  test('a first delivery onto a different value already on the service is refused with the conflict: nothing is written', async () => {
    const script = scripted([read(OUTSIDE)]); // no save step: a write would be an unscripted request
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ targetCheck: check() }));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.code).toBe('SECRETS_CONFLICT');
    expect(result.conflicts).toEqual([
      { name: 'STRIPE_KEY', target: 'dokploy-production', pinned: null, local: h('new-capy'), remote: h('already-there') },
    ]);
    expect(script.done()).toBe(true);
  });

  test('a value edited on the service since Capy last delivered it is a conflict (pinned = what Capy delivered)', async () => {
    const env = `NODE_ENV=production\n${MANAGED_BEGIN}\nSTRIPE_KEY='hand-edited'\n${MANAGED_END}`;
    const script = scripted([read(env)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ targetCheck: check({}, { STRIPE_KEY: h('old-delivered') }) }));
    expect(result.ok).toBe(false);
    expect(result.conflicts?.[0]).toMatchObject({ pinned: h('old-delivered'), local: h('new-capy'), remote: h('hand-edited') });
    expect(script.done()).toBe(true);
  });

  test('local delivers Capy\'s value and comments the outside line out as `# capy:off`, as it always did', async () => {
    const merged = mergeManagedValuesBlock(OUTSIDE, [{ name: 'STRIPE_KEY', value: 'new-capy' }]);
    if (!merged.ok) throw new Error('fixture');
    expect(merged.env).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=already-there`);
    const script = scripted([read(OUTSIDE), save(merged.env), read(merged.env)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ targetCheck: check({ STRIPE_KEY: 'local' }) }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(script.done()).toBe(true);
  });

  test('a decision made against one live value does not apply once the service holds another: conflict again, nothing written (local and remote alike)', async () => {
    const MOVED = 'NODE_ENV=production\nSTRIPE_KEY=moved-after-the-answer\n';
    // `check` binds its decisions to the live value OUTSIDE shows; the service now holds something else. No save step is scripted.
    const answeredLocal = scripted([read(MOVED)]);
    const local = await adapterWith(answeredLocal.fetch).deploy(target(), ctx({ targetCheck: check({ STRIPE_KEY: 'local' }) }));
    expect(local.ok).toBe(false);
    expect(local.steps.at(-1)?.code).toBe('SECRETS_CONFLICT');
    expect(local.conflicts).toEqual([
      { name: 'STRIPE_KEY', target: 'dokploy-production', pinned: null, local: h('new-capy'), remote: h('moved-after-the-answer') },
    ]);
    expect(answeredLocal.done()).toBe(true);

    const answeredRemote = scripted([read(MOVED)]);
    const remote = await adapterWith(answeredRemote.fetch).deploy(target(), ctx({ targetCheck: check({ STRIPE_KEY: 'remote' }) }));
    expect(remote.ok).toBe(false);
    expect(remote.skipped).toBeUndefined();
    expect(answeredRemote.done()).toBe(true);

    // The value being delivered moved after the answer (the decision saw 'new-capy'): the same.
    const changedLocal = scripted([read(OUTSIDE)]);
    const other = await adapterWith(changedLocal.fetch).deploy(target(), ctx({ env: { STRIPE_KEY: 'newer-capy', PORT: '3000' }, targetCheck: check({ STRIPE_KEY: 'local' }) }));
    expect(other.ok).toBe(false);
    expect(other.conflicts?.[0]).toMatchObject({ local: h('newer-capy'), remote: h('already-there') });
    expect(changedLocal.done()).toBe(true);
  });

  test('remote skips the variable: the service\'s env is not written at all when it was the only one, and nothing is recorded for it', async () => {
    const script = scripted([read(OUTSIDE)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ targetCheck: check({ STRIPE_KEY: 'remote' }) }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(['STRIPE_KEY']);
    expect(script.done()).toBe(true); // read only: byte-identical by construction
  });

  test('remote for one variable still delivers the others, and the kept one stays exactly as it was (outside line active, not commented)', async () => {
    const env = OUTSIDE; // PORT is not on the service yet
    const merged = mergeManagedValuesBlock(env, [{ name: 'PORT', value: '3000' }], { keep: (n) => n === 'STRIPE_KEY' });
    if (!merged.ok) throw new Error('fixture');
    expect(merged.env).toContain('STRIPE_KEY=already-there');
    expect(merged.env).not.toContain(`${CAPY_OFF_MARKER}STRIPE_KEY`);
    const script = scripted([read(env), save(merged.env), read(merged.env)]);
    const result = await adapterWith(script.fetch).deploy(target(['STRIPE_KEY', 'PORT']), ctx({ targetCheck: check({ STRIPE_KEY: 'remote' }) }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(['STRIPE_KEY']);
    expect(script.done()).toBe(true);
  });

  test('a live value equal to Capy\'s own is not a conflict, and the delivery proceeds as before', async () => {
    const env = 'STRIPE_KEY=new-capy\n';
    const merged = mergeManagedValuesBlock(env, [{ name: 'STRIPE_KEY', value: 'new-capy' }]);
    if (!merged.ok) throw new Error('fixture');
    const script = scripted([read(env), save(merged.env), read(merged.env)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ targetCheck: check() }));
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(script.done()).toBe(true);
  });

  test('without a targetCheck nothing is compared: the delivery is exactly what it was before CAP-717', async () => {
    const merged = mergeManagedValuesBlock(OUTSIDE, [{ name: 'STRIPE_KEY', value: 'new-capy' }]);
    if (!merged.ok) throw new Error('fixture');
    const script = scripted([read(OUTSIDE), save(merged.env), read(merged.env)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({}));
    expect(result.ok).toBe(true);
    expect(script.done()).toBe(true);
  });

  test('a dry run WITH a targetCheck is the preview: it reads, reports every conflict, writes nothing and refuses nothing', async () => {
    const script = scripted([read(OUTSIDE)]);
    const result = await adapterWith(script.fetch).deploy(target(), ctx({ dryRun: true, targetCheck: check() }));
    expect(result.ok).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(script.done()).toBe(true);
    // ... and a plain dry run still reads nothing at all.
    const plain = scripted([]);
    const planOnly = await adapterWith(plain.fetch).deploy(target(), ctx({ dryRun: true }));
    expect(planOnly.ok).toBe(true);
    expect(planOnly.conflicts).toBeUndefined();
  });

  test('keepOtherManaged: delivering one picked variable leaves the other managed line in the block byte for byte', async () => {
    const AWS = "AWS_ACCESS_KEY_ID='AKIA-fake'";
    const env = `NODE_ENV=production\n${MANAGED_BEGIN}\n${AWS}\nSTRIPE_KEY=old\n${MANAGED_END}`;
    const expected = `NODE_ENV=production\n${MANAGED_BEGIN}\n${AWS}\nSTRIPE_KEY=new-capy\n${MANAGED_END}`;
    const script = scripted([read(env), save(expected), read(expected)]);
    const result = await adapterWith(script.fetch).deploy(target(['STRIPE_KEY']), ctx({ keepOtherManaged: true }));
    expect(result.ok).toBe(true);
    expect(script.done()).toBe(true);
  });
});

describe('the Dokploy adapter, Compose services', () => {
  const COMPOSE_ID = 'compose_conflict';
  const composeTarget = (): TargetConfig => ({ ...target(), options: { baseUrl: BASE, composeId: COMPOSE_ID, tokenEnv: 'DOKPLOY_API_KEY' } });
  const compose = (env: string) => ({ composeId: COMPOSE_ID, name: 'stack', env, createEnvFile: true, composeType: 'docker-compose', autoDeploy: true, branch: 'main' });
  const readCompose = (env: string): Step => ({ expect: (path) => expect(path).toBe('compose.one'), json: compose(env) });
  const saveCompose = (expectedEnv: string): Step => ({
    expect: (path, body) => {
      expect(path).toBe('compose.saveEnvironment');
      expect(body?.env).toBe(expectedEnv);
    },
    json: true,
  });

  test('an unanswered conflict writes nothing; local writes; remote keeps the service\'s value', async () => {
    const refused = scripted([readCompose(OUTSIDE)]);
    const open = await adapterWith(refused.fetch).deploy(composeTarget(), ctx({ targetCheck: check() }));
    expect(open.ok).toBe(false);
    expect(open.conflicts).toHaveLength(1);
    expect(refused.done()).toBe(true);

    const merged = mergeManagedValuesBlock(OUTSIDE, [{ name: 'STRIPE_KEY', value: 'new-capy' }]);
    if (!merged.ok) throw new Error('fixture');
    const delivered = scripted([readCompose(OUTSIDE), saveCompose(merged.env), readCompose(merged.env)]);
    expect((await adapterWith(delivered.fetch).deploy(composeTarget(), ctx({ targetCheck: check({ STRIPE_KEY: 'local' }) }))).ok).toBe(true);
    expect(delivered.done()).toBe(true);

    const remote = scripted([readCompose(OUTSIDE)]);
    const kept = await adapterWith(remote.fetch).deploy(composeTarget(), ctx({ targetCheck: check({ STRIPE_KEY: 'remote' }) }));
    expect(kept).toMatchObject({ ok: true, skipped: ['STRIPE_KEY'] });
    expect(remote.done()).toBe(true);
  });
});
