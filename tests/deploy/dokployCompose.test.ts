/**
 * Dokploy Compose target (CAP-679; plaintext delivery per CAP-682).
 *
 * Mirrors `dokploy.test.ts`'s scripted-request style, but for
 * `compose.one`/`compose.saveEnvironment`/`compose.redeploy`/
 * `deployment.allByCompose` instead of the Application endpoints. The
 * Application path itself is covered separately in `dokploy.test.ts`.
 */
import { describe, test, expect } from 'bun:test';
import {
  createDokployAdapter,
  createDokployClient,
  dokployVersionAtLeast,
  envKeys,
  mergeManagedValuesBlock,
  optionsProblem,
  CAPY_OFF_MARKER,
  DokployDeployment,
  FetchLike,
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
/** Fake, non-secret test values only. */
const VALUES = { DATABASE_URL: 'postgres://example-not-real/db', STRIPE_KEY: 'sk_test_not_real_456' };
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

/** A "clean CI preflight" compose: auto-deploy on, tracking the PR base, no watch-path filter. */
const ciReadyCompose = (overrides: Record<string, unknown> = {}) =>
  compose({ autoDeploy: true, branch: 'main', ...overrides });

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
  env: VALUES,
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

/** `mergeManagedValuesBlock`, unwrapped — the production merge, for test fixtures. */
function mergedEnv(env: string, values: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
  { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
]): string {
  const merged = mergeManagedValuesBlock(env, values);
  if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
  return merged.env;
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

  test('composeType stack on an old Dokploy version warns, never refuses (CAP-682: reworded for plain values)', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), json: '0.30.1' },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings?.[0]).toMatchObject({ code: 'DOKPLOY_STACK_QUOTES' });
    expect(r.warnings?.[0].message).toContain('0.30.1');
    // CAP-682: no more "capy run strips a quote layer" mitigation promise —
    // Capy's own values are plain now and hit the same bug as everything else.
    expect(r.warnings?.[0].message).toContain('plain values');
    expect(r.warnings?.[0].message).not.toContain('_SECRETS_BLOB');
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

  // CAP-679 follow-up: an unreadable version used to be silently treated as
  // "not old" (no warning at all) — that was guessing. It now warns with its
  // OWN distinct code instead, so the risk is never hidden. DOKPLOY_VERSION_UNKNOWN's
  // own wording is UNCHANGED by CAP-682 (spec: "DOKPLOY_VERSION_UNKNOWN unchanged").
  test('an unknown/unparseable version warns with DOKPLOY_VERSION_UNKNOWN, never treated as old', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), json: { nonsense: true } },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings?.[0]).toMatchObject({ code: 'DOKPLOY_VERSION_UNKNOWN' });
  });

  test('a network/API failure reading the version also warns with DOKPLOY_VERSION_UNKNOWN', async () => {
    const s = scripted([
      readCompose(compose({ composeType: 'stack' })),
      { expect: get('settings.getDokployVersion', {}), status: 500, json: { message: 'boom' } },
    ]);
    const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings?.[0]).toMatchObject({ code: 'DOKPLOY_VERSION_UNKNOWN' });
  });

  // ── CI preflight (CAP-682) — same checks as the Application path ───────
  describe('CI mode', () => {
    const ciComposeTarget = (overrides: Partial<TargetConfig> = {}) =>
      composeTarget({ mode: 'ci', gitBaseBranch: 'main', ...overrides });

    test('direct-mode compose targets skip these checks entirely', async () => {
      const s = scripted([readCompose(compose({ autoDeploy: false }))]);
      const r = await adapterWith(s.fetch).preflight(composeTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });

    test('a clean CI-ready compose passes', async () => {
      const s = scripted([readCompose(ciReadyCompose())]);
      const r = await adapterWith(s.fetch).preflight(ciComposeTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
      expect(s.done()).toBe(true);
    });

    test('auto-deploy off refuses with DOKPLOY_AUTODEPLOY_OFF', async () => {
      const s = scripted([readCompose(ciReadyCompose({ autoDeploy: false }))]);
      const r = await adapterWith(s.fetch).preflight(ciComposeTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_AUTODEPLOY_OFF');
    });

    test('a tracked branch that differs from the PR base refuses with DOKPLOY_BRANCH_MISMATCH', async () => {
      const s = scripted([readCompose(ciReadyCompose({ branch: 'staging' }))]);
      const r = await adapterWith(s.fetch).preflight(ciComposeTarget({ gitBaseBranch: 'main' }), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_BRANCH_MISMATCH');
    });

    test('watch paths that exclude keep.lock refuse with DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP', async () => {
      const s = scripted([readCompose(ciReadyCompose({ watchPaths: ['docker/**'] }))]);
      const r = await adapterWith(s.fetch).preflight(ciComposeTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP');
    });

    test('watch paths that DO cover keep.lock pass', async () => {
      const s = scripted([readCompose(ciReadyCompose({ watchPaths: ['keep.lock'] }))]);
      const r = await adapterWith(s.fetch).preflight(ciComposeTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });
  });
});

// ── Deploy: happy path, byte-exact merge, --no-deploy, CI secretsOnly ───────

describe('dokploy compose — deploy', () => {
  const expectedEnv = mergedEnv(RAW_ENV);

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

  test('read → merge → write → verify → (direct mode) baseline → redeploy → poll to success', async () => {
    const s = scripted([
      readCompose(),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      listComposeDeployments([OLD]),
      redeployTrigger,
      listComposeDeployments([OLD]), // not yet recorded
      listComposeDeployments([deployment('dep_new', 'running', '2026-09-22T00:00:00.000Z'), OLD]),
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z'), OLD]),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget({ mode: 'direct' }), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((st) => [st.label, st.status])).toEqual([
      ['dokploy compose', 'ok'],
      ['compose.saveEnvironment', 'ok'],
      ['compose.redeploy', 'ok'],
      ['deployment', 'ok'],
    ]);
    // No more capy-run/revoke language — no deploy token was minted.
    expect(r.epilogue).toContain('No `capy run` step needed');
    expect(r.epilogue).toContain('capy deploy targets-remove backend-preview');
    expect(r.epilogue).not.toContain('revoke');
  });

  test('never sends compose.deploy or freshVolumes — only compose.redeploy', async () => {
    const s = scripted([
      readCompose(),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      listComposeDeployments([]),
      redeployTrigger,
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget({ mode: 'direct' }), ctx());
    expect(r.ok).toBe(true);
    // `s.done()` proves every request matched a SCRIPTED step in order — a
    // `compose.deploy` call, or `freshVolumes` in the redeploy body, would
    // have failed `redeployTrigger`'s own strict `toEqual` above (an exact
    // match on `{ composeId, title }`, so a stray extra field fails it too).
    expect(s.done()).toBe(true);
  });

  test('byte-exact preservation: comments and ${{project.X}} refs untouched, only Capy names change', async () => {
    const s = scripted([
      readCompose(),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      listComposeDeployments([]),
      redeployTrigger,
      listComposeDeployments([deployment('dep_new', 'done', '2026-09-22T00:00:00.000Z')]),
    ]);
    await adapterWith(s.fetch).deploy(composeTarget({ mode: 'direct' }), ctx());
    expect(expectedEnv).toContain('# a comment');
    expect(expectedEnv).toContain('API_URL=${{project.API_URL}}');
    expect(envKeys(expectedEnv.split('\n'))).toEqual(['NODE_ENV', 'API_URL', 'PORT', 'DATABASE_URL', 'STRIPE_KEY']);
    expect(expectedEnv).toContain(VALUES.DATABASE_URL);
    expect(expectedEnv).toContain(VALUES.STRIPE_KEY);
  });

  test('createEnvFile: false at deploy time refuses before any write', async () => {
    const s = scripted([readCompose(compose({ createEnvFile: false }))]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('Create Env File');
    expect(r.steps[r.steps.length - 1].code).toBe('DOKPLOY_ENV_FILE_DISABLED');
  });

  test('a var missing from the decrypted branch fails before any request', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch).deploy(composeTarget(), ctx({ env: { DATABASE_URL: VALUES.DATABASE_URL } }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('missing in branch preview: STRIPE_KEY');
  });

  test('--no-deploy writes and verifies, but never calls compose.redeploy or lists deployments', async () => {
    const s = scripted([readCompose(), saveWith(expectedEnv), readCompose(compose({ env: expectedEnv }))]);
    const r = await adapterWith(s.fetch).deploy(composeTarget({ mode: 'direct' }), ctx({ noDeploy: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((st) => st.label)).toEqual(['dokploy compose', 'compose.saveEnvironment', 'compose.redeploy']);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ status: 'skip', detail: '--no-deploy' });
  });

  test('CI mode (secretsOnly) writes and verifies, but NEVER calls compose.redeploy or lists deployments', async () => {
    const s = scripted([readCompose(), saveWith(expectedEnv), readCompose(compose({ env: expectedEnv }))]);
    const r = await adapterWith(s.fetch).deploy(composeTarget({ mode: 'ci', gitBaseBranch: 'main' }), ctx({ secretsOnly: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ status: 'skip' });
    expect(r.steps[r.steps.length - 1].detail).toContain('CI mode');
    expect(r.steps[r.steps.length - 1].detail).toContain("Dokploy’s own auto-deploy");
  });

  test('write verify mismatch fails loudly rather than trusting the write', async () => {
    const s = scripted([
      readCompose(),
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
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      listComposeDeployments([OLD]),
      redeployTrigger,
      listComposeDeployments([
        deployment('dep_new', 'error', '2026-09-22T00:00:00.000Z', { errorMessage: 'compose up failed' }),
        OLD,
      ]),
      { expect: get('deployment.readLogs', { deploymentId: 'dep_new' }), json: 'pulling image\nERROR: service failed' },
    ]);
    const r = await adapterWith(s.fetch).deploy(composeTarget({ mode: 'direct' }), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    const last = r.steps[r.steps.length - 1];
    expect(last).toMatchObject({ label: 'deployment', status: 'fail' });
    expect(last.detail).toContain('error (dep_new) — compose up failed');
    expect(r.epilogue).toContain('ERROR: service failed');
  });

  test('never logs the compose env body or a delivered value, even on failure', async () => {
    const s = scripted([
      readCompose(),
      saveWith(expectedEnv),
      readCompose(compose({ env: expectedEnv })),
      listComposeDeployments([OLD]),
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
      expect(l).not.toContain(VALUES.DATABASE_URL);
      expect(l).not.toContain(VALUES.STRIPE_KEY);
      expect(l).not.toContain(RAW_ENV);
    }).deploy(composeTarget({ mode: 'direct' }), ctx());
  });
});

// ── Remove: strip + redeploy ────────────────────────────────────────────────

describe('dokploy compose — remove', () => {
  const managedEnv = mergedEnv(RAW_ENV);

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

  test('also un-comments a shadowed line, restoring it byte-exact', async () => {
    const shadowedRaw = 'STRIPE_KEY=stale\n' + RAW_ENV;
    const shadowedMerged = mergedEnv(shadowedRaw);
    expect(shadowedMerged.split('\n')).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=stale`);
    const s = scripted([
      readCompose(compose({ env: shadowedMerged })),
      {
        expect: post('compose.saveEnvironment', (body) => expect(body).toEqual({ composeId: COMPOSE_ID, env: shadowedRaw, createEnvFile: true })),
        json: true,
      },
      readCompose(compose({ env: shadowedRaw })),
      { expect: post('compose.redeploy', () => {}), json: true },
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(composeTarget(), removeCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
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

// Sanity: the three new CAP-682 CI-preflight codes and the value-shape code
// are real, registered ERROR_CODES — never bespoke strings.
test('CAP-682 error codes are registered in ERROR_CODES', () => {
  expect(ERROR_CODES.DOKPLOY_AUTODEPLOY_OFF).toBe('DOKPLOY_AUTODEPLOY_OFF');
  expect(ERROR_CODES.DOKPLOY_BRANCH_MISMATCH).toBe('DOKPLOY_BRANCH_MISMATCH');
  expect(ERROR_CODES.DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP).toBe('DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP');
  expect(ERROR_CODES.DOKPLOY_VALUE_UNREPRESENTABLE).toBe('DOKPLOY_VALUE_UNREPRESENTABLE');
});

/** `createDokployClient` used directly, unscripted-adapter, to prove the raw client also reads the new fields. */
test('createDokployClient.getCompose reads the CAP-682 CI preflight fields', async () => {
  const s = scripted([readCompose(compose({ autoDeploy: true, customGitBranch: 'main', watchPaths: ['keep.lock'] }))]);
  const got = await createDokployClient(BASE, TOKEN, s.fetch).getCompose(COMPOSE_ID);
  expect(got.autoDeploy).toBe(true);
  expect(got.customGitBranch).toBe('main');
  expect(got.watchPaths).toEqual(['keep.lock']);
});
