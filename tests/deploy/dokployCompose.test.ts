/**
 * Dokploy Compose target (CAP-679).
 *
 * Mirrors `dokploy.test.ts`'s scripted-request style, but for
 * `compose.one`/`compose.saveEnvironment`/`compose.redeploy`/
 * `deployment.allByCompose` instead of the Application endpoints. The
 * Application path itself is untouched — see `dokploy.test.ts` for its
 * coverage, unchanged.
 */
import { describe, test, expect } from 'bun:test';
import {
  createDokployAdapter,
  createDokployClient,
  dokployVersionAtLeast,
  envKeys,
  mergeManagedBlock,
  optionsProblem,
  splitManagedBlock,
  DokployDeployment,
  FetchLike,
  RUNTIME_PAIR,
} from '../../src/deploy/adapters/dokploy';
import { DeployContext, RemoveOfferContext, TargetConfig } from '../../src/deploy/adapter';
import { ERROR_CODES } from '../../src/types/index';

// ── Scripted Dokploy (same shape as dokploy.test.ts) ────────────────────────

interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

interface Step {
  expect: (r: Req) => void;
  status?: number;
  json?: unknown;
}

const BASE = 'https://dokploy.example.com';
const TOKEN = 'dk_test_token';
const COMPOSE_ID = 'compose_abc';
const PAIR = { secretsBlob: 'Q09NUE9TRQ==', projectKey: 'cd'.repeat(32), deployId: 'ef'.repeat(32) };
const RAW_ENV = 'NODE_ENV=production\n# a comment\nAPI_URL=${{project.API_URL}}\nPORT=3000';

/**
 * A request the script does not expect (wrong path, or one call too many)
 * throws immediately — so e.g. a stray `compose.deploy` call in place of the
 * scripted `compose.redeploy` step fails LOUDLY here, at the mismatched
 * `expect()`, rather than needing a separate call-log to notice.
 */
function scripted(steps: readonly Step[]): { fetch: FetchLike; done: () => boolean } {
  const it = steps[Symbol.iterator]();
  const fetchImpl: FetchLike = async (url, init) => {
    const next = it.next();
    if (next.done) throw new Error(`unscripted request: ${init.method} ${url}`);
    const u = new URL(url);
    const req: Req = {
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    };
    next.value.expect(req);
    const status = next.value.status ?? 200;
    const text = JSON.stringify(next.value.json ?? null);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { fetch: fetchImpl, done: () => it.next().done === true };
}

const compose = (overrides: Record<string, unknown> = {}) => ({
  composeId: COMPOSE_ID,
  name: 'backend-preview',
  appName: 'backend-preview-xyz',
  env: RAW_ENV,
  createEnvFile: true,
  composeType: 'docker-compose',
  ...overrides,
});

const get = (path: string, query: Record<string, string>) => (r: Req) => {
  expect(r.method).toBe('GET');
  expect(r.path).toBe(`/api/${path}`);
  expect(r.query).toEqual(query);
  expect(r.headers['x-api-key']).toBe(TOKEN);
};

const post = (path: string, check: (body: Record<string, unknown>) => void) => (r: Req) => {
  expect(r.method).toBe('POST');
  expect(r.path).toBe(`/api/${path}`);
  expect(r.headers['x-api-key']).toBe(TOKEN);
  check(r.body ?? {});
};

const readCompose = (json: unknown = compose()): Step => ({
  expect: get('compose.one', { composeId: COMPOSE_ID }),
  json,
});

const listComposeDeployments = (json: readonly DokployDeployment[]): Step => ({
  expect: get('deployment.allByCompose', { composeId: COMPOSE_ID }),
  json,
});

const deployment = (id: string, status: DokployDeployment['status'], createdAt: string, extra = {}) => ({
  deploymentId: id,
  status,
  createdAt,
  ...extra,
});

const OLD = deployment('dep_old', 'done', '2026-09-01T00:00:00.000Z');

const composeTarget = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'backend-preview',
  kind: 'dokploy',
  branch: 'preview',
  vars: ['DATABASE_URL', 'STRIPE_KEY'],
  options: { baseUrl: BASE, composeId: COMPOSE_ID, tokenEnv: 'DOKPLOY_API_KEY' },
  ...overrides,
});

const ctx = (overrides: Partial<DeployContext> = {}): DeployContext => ({
  env: {},
  deployToken: PAIR,
  dryRun: false,
  cwd: '/tmp',
  ...overrides,
});

function* multiplesOf(step: number, from: number = step): Generator<number, never> {
  yield from;
  return yield* multiplesOf(step, from + step);
}
function ticking(step: number): () => number {
  const clock = multiplesOf(step);
  return () => clock.next().value;
}

function adapterWith(fetchImpl: FetchLike, env: Record<string, string> = { DOKPLOY_API_KEY: TOKEN }, log: (l: string) => void = () => {}) {
  return createDokployAdapter({ fetch: fetchImpl, env, sleep: async () => {}, now: ticking(1), log });
}

/** `splitManagedBlock` + `mergeManagedBlock` in one step — the production merge. */
function mergedEnv(env: string, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

// ── Config shape ─────────────────────────────────────────────────────────────

describe('dokploy compose — config shape', () => {
  test('composeId alone is a valid target', () => {
    expect(optionsProblem(composeTarget())).toBeNull();
  });

  test('applicationId + composeId together is refused', () => {
    const r = optionsProblem(composeTarget({ options: { baseUrl: BASE, applicationId: 'app_1', composeId: COMPOSE_ID, tokenEnv: 'T' } }));
    expect(r?.ok).toBe(false);
    expect(r?.reason).toContain('exactly one');
  });

  test('neither applicationId nor composeId is refused (back-compat wording)', () => {
    const r = optionsProblem(composeTarget({ options: { baseUrl: BASE, tokenEnv: 'T' } }));
    expect(r?.ok).toBe(false);
    expect(r?.reason).toMatch(/applicationId: required/);
  });
});

// ── Preflight ──────────────────────────────────────────────────────────────

describe('dokploy compose — preflight', () => {
  test('happy path: read-only, no writes, no warnings', async () => {
    const s = scripted([readCompose()]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.warnings ?? []).toEqual([]);
  });

  test('createEnvFile: false is refused with the coded reason', async () => {
    const s = scripted([readCompose(compose({ createEnvFile: false }))]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Create Env File');
    expect(r.hint).toBeTruthy();
    // CAP-679 fix-first review: the refusal must be branchable on a stable
    // code, never on `reason`'s prose (Rule 5).
    expect(r.code).toBe('DOKPLOY_ENV_FILE_DISABLED');
  });

  test('an edited/duplicated block is refused, same rule as Applications', async () => {
    const s = scripted([
      readCompose(compose({ env: 'A=1\n# capy:managed:begin — written by `capy deploy`, do not edit\nX=1\n' })),
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Capy block');
  });

  test('composeType stack on an old Dokploy version warns, never refuses', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), json: '0.30.1' },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings?.[0]).toMatchObject({ code: 'DOKPLOY_STACK_ENV_FILE_QUOTING' });
    expect(r.warnings?.[0].message).toContain('0.30.1');
  });

  test('composeType stack on a fixed Dokploy version — no warning', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), json: 'v0.30.3' },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings ?? []).toEqual([]);
  });

  test('composeType docker-compose never checks the version at all', async () => {
    const s = scripted([readCompose(compose({ composeType: 'docker-compose' }))]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(s.done()).toBe(true); // no settings.getDokployVersion call scripted or made
    expect(r.ok).toBe(true);
  });

  test('an unknown/unparseable version is never treated as old', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), json: { nonsense: true } },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings ?? []).toEqual([]);
  });
});

// ── Deploy: happy path, byte-exact merge, --no-deploy, CI secretsOnly ───────

describe('dokploy compose — deploy', () => {
  const expectedEnv = mergedEnv(RAW_ENV, PAIR);

  const saveWith = (env: string): Step => ({
    expect: post('compose.saveEnvironment', (body) =>
      expect(body).toEqual({ composeId: COMPOSE_ID, env, createEnvFile: true }),
    ),
    json: true,
  });

  const redeployTrigger: Step = {
    expect: post('compose.redeploy', (body) =>
      expect(body).toEqual({ composeId: COMPOSE_ID, title: 'capy deploy backend-preview' }),
    ),
    json: true,
  };

  test('read → baseline → write → verify → redeploy → poll to success', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      redeployTrigger,
      listComposeDeployments([OLD]), // not yet recorded
      listComposeDeployments([deployment('dep_new', 'running', '2026-09-22T00:00:00.000Z'), OLD]),
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z'), OLD]),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((st) => [st.label, st.status])).toEqual([
      ['dokploy compose', 'ok'],
      ['compose.saveEnvironment', 'ok'],
      ['compose.redeploy', 'ok'],
      ['deployment', 'ok'],
    ]);
    expect(r.epilogue).toContain(`capy deploy revoke ${PAIR.deployId}`);
  });

  test('never sends compose.deploy or freshVolumes — only compose.redeploy', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      redeployTrigger,
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(r.ok).toBe(true);
    // `s.done()` proves every request matched a SCRIPTED step in order — a
    // `compose.deploy` call, or `freshVolumes` in the redeploy body, would
    // have failed `redeployTrigger`'s own strict `toEqual` above (an exact
    // match on `{ composeId, title }`, so a stray extra field fails it too).
    expect(s.done()).toBe(true);
  });

  test('byte-exact preservation: comments and ${{project.X}} refs, and only Capy names change', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      redeployTrigger,
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z')]),
    ]);
    await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(expectedEnv).toContain('# a comment');
    expect(expectedEnv).toContain('API_URL=${{project.API_URL}}');
    expect(envKeys(expectedEnv.split('\n'))).toEqual(['NODE_ENV', 'API_URL', 'PORT', ...RUNTIME_PAIR]);
  });

  test('createEnvFile: false at deploy time refuses before any write', async () => {
    const s = scripted([readCompose(compose({ createEnvFile: false }))]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('Create Env File');
    expect(r.steps[r.steps.length - 1].code).toBe('DOKPLOY_ENV_FILE_DISABLED');
  });

  test('--no-deploy writes and verifies, but never calls compose.redeploy', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx({ noDeploy: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((st) => st.label)).toEqual(['dokploy compose', 'compose.saveEnvironment', 'compose.redeploy']);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ status: 'skip', detail: '--no-deploy' });
  });

  test('CI mode (secretsOnly) writes and verifies, but never calls compose.redeploy', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx({ secretsOnly: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ status: 'skip' });
    expect(r.steps[r.steps.length - 1].detail).toContain('CI mode');
  });

  test('write verify mismatch fails loudly rather than trusting the write', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: 'SOMETHING=else' })), // a concurrent dashboard edit landed
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('not what Capy wrote');
  });

  test('a failed redeploy is reported with its log', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      redeployTrigger,
      listComposeDeployments([
        deployment('dep_new', 'error', '2026-09-22T00:00:00.000Z', { errorMessage: 'compose up failed' }),
        OLD,
      ]),
      { expect: get('deployment.readLogs', { deploymentId: 'dep_new' }), json: 'pulling image\nERROR: service failed' },
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    const last = r.steps[r.steps.length - 1];
    expect(last).toMatchObject({ label: 'deployment', status: 'fail' });
    expect(last.detail).toContain('error (dep_new) — compose up failed');
    expect(r.epilogue).toContain('ERROR: service failed');
  });

  test('never logs the compose env body, even on failure', async () => {
    const s = scripted([
      readCompose(),
      listComposeDeployments([OLD]),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      redeployTrigger,
      listComposeDeployments([
        deployment('dep_new', 'error', '2026-09-22T00:00:00.000Z', { errorMessage: 'boom' }),
        OLD,
      ]),
      { expect: get('deployment.readLogs', { deploymentId: 'dep_new' }), json: 'log line' },
    ]);
    // Asserted AS each line is emitted (no accumulator array needed) — a
    // violation fails the exact call that produced it.
    await adapterWith(s.fetch, { DOKPLOY_API_KEY: TOKEN }, (l) => {
      expect(l).not.toContain(PAIR.secretsBlob);
      expect(l).not.toContain(RAW_ENV);
    }).deploy(composeTarget(), ctx());
  });
});

// ── Remove: strip + redeploy ────────────────────────────────────────────────

describe('dokploy compose — remove', () => {
  const managedEnv = mergedEnv(RAW_ENV, PAIR);

  const removeCtx = (interactive: boolean, answer: boolean, noDeploy = false): RemoveOfferContext => ({
    cwd: '/tmp',
    interactive,
    confirm: async () => answer,
    noDeploy,
  });

  test('strips the block and redeploys by default', async () => {
    const s = scripted([
      readCompose(compose({ env: managedEnv })),
      {
        expect: post('compose.saveEnvironment', (body) => expect(body).toEqual({ composeId: COMPOSE_ID, env: RAW_ENV, createEnvFile: true })),
        json: true,
      },
      readCompose(compose({ env: RAW_ENV })),
      {
        expect: post('compose.redeploy', (body) => expect(body).toEqual({ composeId: COMPOSE_ID, title: 'capy deploy remove backend-preview' })),
        json: true,
      },
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(composeTarget(), removeCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
    expect(r?.code).toBe('stripped');
    expect(r?.detail).toContain('redeployed');
  });

  test('--no-deploy strips but never redeploys', async () => {
    const s = scripted([
      readCompose(compose({ env: managedEnv })),
      {
        expect: post('compose.saveEnvironment', (body) => expect(body).toEqual({ composeId: COMPOSE_ID, env: RAW_ENV, createEnvFile: true })),
        json: true,
      },
      readCompose(compose({ env: RAW_ENV })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(composeTarget(), removeCtx(true, true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
    expect(r?.detail).toContain('not redeployed');
  });

  test('no block present — nothing to remove, no writes', async () => {
    const s = scripted([readCompose(compose({ env: RAW_ENV }))]);
    const r = await adapterWith(s.fetch).onRemove?.(composeTarget(), removeCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
    expect(r?.code).toBe('nothing_to_remove');
  });

  test('declined confirm leaves the environment untouched', async () => {
    const s = scripted([readCompose(compose({ env: managedEnv }))]);
    const r = await adapterWith(s.fetch).onRemove?.(composeTarget(), removeCtx(true, false));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('declined');
  });

  test('non-interactive never prompts and leaves the environment untouched', async () => {
    const s = scripted([readCompose(compose({ env: managedEnv }))]);
    const r = await adapterWith(s.fetch).onRemove?.(
      composeTarget(),
      { cwd: '/tmp', interactive: false, confirm: async () => { throw new Error('must not be called'); } },
    );
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('non_interactive');
  });
});

// ── Version comparison ──────────────────────────────────────────────────────

describe('dokployVersionAtLeast', () => {
  test('handles a leading v and bare dotted versions the same way', () => {
    expect(dokployVersionAtLeast('v0.30.3', '0.30.3')).toBe(true);
    expect(dokployVersionAtLeast('0.30.3', 'v0.30.3')).toBe(true);
  });
  test('numeric comparison, not lexicographic (0.30.10 >= 0.30.3)', () => {
    expect(dokployVersionAtLeast('0.30.10', '0.30.3')).toBe(true);
    expect(dokployVersionAtLeast('0.30.2', '0.30.3')).toBe(false);
  });
  test('missing patch segment reads as 0', () => {
    expect(dokployVersionAtLeast('0.31', '0.30.3')).toBe(true);
    expect(dokployVersionAtLeast('0.30', '0.30.3')).toBe(false);
  });
  test('equal versions compare as at-least', () => {
    expect(dokployVersionAtLeast('0.30.3', '0.30.3')).toBe(true);
  });
});

// Sanity: DOKPLOY_ENV_FILE_DISABLED is a real coded error, not a bespoke string.
test('DOKPLOY_ENV_FILE_DISABLED is registered in ERROR_CODES', () => {
  expect(ERROR_CODES.DOKPLOY_ENV_FILE_DISABLED).toBe('DOKPLOY_ENV_FILE_DISABLED');
});
