import { describe, test, expect, mock } from 'bun:test';
import {
  apiBase,
  createDokployAdapter,
  createDokployClient,
  envKeys,
  envProblems,
  envWarnings,
  mergeManagedValuesBlock,
  optionsProblem,
  baseUrlProblem,
  tokenEnvProblem,
  DokployDeployment,
  DokploySystemStoreCallOptions,
  FetchLike,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
  CAPY_OFF_MARKER,
} from '../../src/deploy/adapters/dokploy';
import { DeployContext, RemoveOfferContext, TargetConfig } from '../../src/deploy/adapter';
import { getAdapter } from '../../src/deploy/registry';

// ── Scripted Dokploy ───────────────────────────────────────────────────────
//
// Each test lists the exact requests it expects, in order, with the response
// to each. A request the script does not expect fails the call; `done()` says
// whether every scripted request was made.

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
const APP_ID = 'app_123';
/** Delivered plain values for the default `target()` (vars: DATABASE_URL, STRIPE_KEY) — fake, non-secret test values only. */
const VALUES = { DATABASE_URL: 'postgres://example-not-real/db', STRIPE_KEY: 'sk_test_not_real_123' };

function scripted(steps: readonly Step[]): { fetch: FetchLike; done: () => boolean } {
  const it = steps[Symbol.iterator]();
  const fetchImpl: FetchLike = async (url, init) => {
    const next = it.next();
    if (next.done) throw new Error(`unscripted request: ${init.method} ${url}`);
    const u = new URL(url);
    next.value.expect({
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const status = next.value.status ?? 200;
    const text = JSON.stringify(next.value.json ?? null);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { fetch: fetchImpl, done: () => it.next().done === true };
}

const app = (overrides: Record<string, unknown> = {}) => ({
  applicationId: APP_ID,
  name: 'web',
  appName: 'web-abc',
  env: 'NODE_ENV=production\n# a comment\nPORT=3000',
  buildArgs: 'NPM_TOKEN=build-only',
  buildSecrets: 'SENTRY_AUTH=build-secret',
  createEnvFile: false,
  ...overrides,
});

/** A "clean CI preflight" application: auto-deploy on, tracking the PR base, no watch-path filter. */
const ciReadyApp = (overrides: Record<string, unknown> = {}) =>
  app({ autoDeploy: true, branch: 'main', ...overrides });

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
  expect(r.headers['content-type']).toBe('application/json');
  check(r.body ?? {});
};

const readApp = (json: unknown = app()): Step => ({
  expect: get('application.one', { applicationId: APP_ID }),
  json,
});

const listDeployments = (json: readonly DokployDeployment[]): Step => ({
  expect: get('deployment.all', { applicationId: APP_ID }),
  json,
});

const target = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'dokploy-prod',
  kind: 'dokploy',
  branch: 'production',
  vars: ['DATABASE_URL', 'STRIPE_KEY'],
  options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'DOKPLOY_API_KEY' },
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

/** A clock that moves forward by `step` ms every time it is read. */
function ticking(step: number): () => number {
  const clock = multiplesOf(step);
  return () => clock.next().value;
}

function adapterWith(fetchImpl: FetchLike, env: Record<string, string> = { DOKPLOY_API_KEY: TOKEN }, now = ticking(1)) {
  return createDokployAdapter({
    fetch: fetchImpl,
    env,
    sleep: async () => {},
    now,
    log: () => {},
  });
}

const deployment = (id: string, status: DokployDeployment['status'], createdAt: string, extra = {}) => ({
  deploymentId: id,
  status,
  createdAt,
  ...extra,
});

const OLD = deployment('dep_old', 'done', '2026-09-01T00:00:00.000Z');

// ── Registry ───────────────────────────────────────────────────────────────

describe('dokploy — registry', () => {
  test('is a registered adapter that ships plain values, CI mode by default (CAP-682)', () => {
    const a = getAdapter('dokploy');
    expect(a?.label).toBe('Dokploy');
    expect(a?.needsDeployToken).toBe(false);
    expect(a?.varKind).toBe('runtime');
    expect(a?.defaultMode).toBe('ci');
    expect(a?.ciOnly).toBeFalsy();
    expect(a?.requires.binaries).toEqual([]);
  });
});

// ── Request construction ───────────────────────────────────────────────────

describe('dokploy — client', () => {
  test('apiBase appends /api once, with or without a trailing slash', () => {
    expect(apiBase('https://d.example.com')).toBe('https://d.example.com/api');
    expect(apiBase('https://d.example.com/')).toBe('https://d.example.com/api');
    expect(apiBase('https://d.example.com/api')).toBe('https://d.example.com/api');
    expect(apiBase('https://d.example.com/api/')).toBe('https://d.example.com/api');
  });

  test('saveEnvironment sends all five fields Dokploy requires', async () => {
    const s = scripted([
      {
        expect: post('application.saveEnvironment', (body) =>
          expect(body).toEqual({
            applicationId: APP_ID,
            env: 'A=1',
            buildArgs: null,
            buildSecrets: 'S=2',
            createEnvFile: true,
          }),
        ),
        json: true,
      },
    ]);
    await createDokployClient(BASE, TOKEN, s.fetch).saveEnvironment({
      applicationId: APP_ID,
      env: 'A=1',
      buildArgs: null,
      buildSecrets: 'S=2',
      createEnvFile: true,
    });
    expect(s.done()).toBe(true);
  });

  test('deploy sends the application id and a title', async () => {
    const s = scripted([
      {
        expect: post('application.deploy', (body) =>
          expect(body).toEqual({ applicationId: APP_ID, title: 'capy deploy x' }),
        ),
        json: true,
      },
    ]);
    await createDokployClient(BASE, TOKEN, s.fetch).deploy(APP_ID, 'capy deploy x');
    expect(s.done()).toBe(true);
  });

  test('readLogs returns the log text', async () => {
    const s = scripted([
      { expect: get('deployment.readLogs', { deploymentId: 'dep_1' }), json: 'line 1\nline 2' },
    ]);
    expect(await createDokployClient(BASE, TOKEN, s.fetch).readLogs('dep_1')).toBe('line 1\nline 2');
  });

  test('an application.one answer for another application is refused', async () => {
    const s = scripted([readApp(app({ applicationId: 'someone_else' }))]);
    await expect(createDokployClient(BASE, TOKEN, s.fetch).getApplication(APP_ID)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  test('HTTP status maps to a typed error code', async () => {
    const codes = await Promise.all(
      [401, 403, 404, 400, 500].map((status) =>
        createDokployClient(BASE, TOKEN, scripted([{ expect: () => {}, status }]).fetch)
          .getApplication(APP_ID)
          .catch((e) => e.code),
      ),
    );
    expect(codes).toEqual(['unauthorized', 'unauthorized', 'not_found', 'bad_request', 'server_error']);
  });

  test('a network failure is "unreachable", not a crash', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(createDokployClient(BASE, TOKEN, failing).getApplication(APP_ID)).rejects.toMatchObject({
      code: 'unreachable',
    });
  });

  test('getApplication reads the CAP-682 CI preflight fields (autoDeploy, customGitBranch, watchPaths)', async () => {
    const s = scripted([
      readApp(app({ autoDeploy: true, customGitBranch: 'main', watchPaths: ['keep.lock', 'src/**'] })),
    ]);
    const got = await createDokployClient(BASE, TOKEN, s.fetch).getApplication(APP_ID);
    expect(got.autoDeploy).toBe(true);
    expect(got.customGitBranch).toBe('main');
    expect(got.watchPaths).toEqual(['keep.lock', 'src/**']);
  });

  test('getApplication defaults the CI preflight fields to null when Dokploy omits them', async () => {
    const s = scripted([readApp(app())]);
    const got = await createDokployClient(BASE, TOKEN, s.fetch).getApplication(APP_ID);
    expect(got.autoDeploy).toBeNull();
    expect(got.customGitBranch).toBeNull();
    expect(got.watchPaths).toBeNull();
  });
});

// ── Env merge (reserved-name primitives, unchanged by CAP-682) ─────────────

describe('dokploy — env merge (reserved names)', () => {
  test('envKeys reads KEY= and export KEY= lines, skipping comments and blanks', () => {
    expect(envKeys(['A=1', 'export B=2', '# C=3', '', '  D = 4', 'not a line'])).toEqual(['A', 'B', 'D']);
  });

  test('the new-name runtime pair Capy no longer writes for Dokploy is still refused outside the block', () => {
    expect(envProblems(`${RUNTIME_PAIR[0]}=old\n${RUNTIME_PAIR[1]}=old`)).toEqual({
      code: 'reserved_outside_block',
      names: [...RUNTIME_PAIR],
    });
    expect(envProblems(`export ${RUNTIME_PAIR[1]}=old`)?.code).toBe('reserved_outside_block');
  });

  test('the old-name runtime pair is also refused', () => {
    expect(envProblems(`${OLD_RUNTIME_PAIR[0]}=old\n${OLD_RUNTIME_PAIR[1]}=old`)).toEqual({
      code: 'reserved_outside_block',
      names: [...OLD_RUNTIME_PAIR],
    });
  });

  test('an edited or duplicated block is refused rather than guessed at', () => {
    expect(envProblems(`${MANAGED_BEGIN}\n${RUNTIME_PAIR[0]}=x`)?.code).toBe('malformed_block');
    expect(envProblems(`${MANAGED_END}\n${MANAGED_BEGIN}`)?.code).toBe('malformed_block');
  });

  // `envWarnings`/`DOKPLOY_SHADOWED_VAR` is UNCHANGED as a pure function
  // (kept for back-compat — see dokployApi.ts's own doc) but CAP-682's
  // adapter no longer CALLS it: a shadow is now resolved by commenting the
  // outside line out, not warned about. See the "preflight"/"deploy"
  // describe blocks below for the behavior that replaced it.
  test('envWarnings itself is untouched — still flags a shadowed selected var', () => {
    expect(
      envWarnings('STRIPE_KEY=stale\nDATABASE_URL=stale\nPORT=1', ['STRIPE_KEY', 'DATABASE_URL', 'X']),
    ).toEqual({ code: 'DOKPLOY_SHADOWED_VAR', names: ['DATABASE_URL', 'STRIPE_KEY'] });
  });
});

// ── Preflight ──────────────────────────────────────────────────────────────

describe('dokploy — preflight', () => {
  const noNetwork = scripted([]);

  test('config errors fail before any request', async () => {
    const a = adapterWith(noNetwork.fetch);
    const cases: Array<[Partial<TargetConfig>, RegExp]> = [
      [{ options: { applicationId: APP_ID, tokenEnv: 'T' } }, /baseUrl: required/],
      [{ options: { baseUrl: 'http://dokploy.example.com', applicationId: APP_ID, tokenEnv: 'T' } }, /https/],
      [{ options: { baseUrl: 'not a url', applicationId: APP_ID, tokenEnv: 'T' } }, /not a URL/],
      [{ options: { baseUrl: BASE, tokenEnv: 'T' } }, /applicationId: required/],
      [{ options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: '1BAD' } }, /tokenEnv/],
      [{ options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'T', timeoutSeconds: -5 } }, /timeoutSeconds/],
      [{ vars: [] }, /no vars/],
    ];
    const results = await Promise.all(cases.map(([t]) => a.preflight(target(t), { cwd: '/tmp' })));
    results.forEach((r, i) => {
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(cases[i][1]);
    });
    expect(noNetwork.done()).toBe(true);
  });

  test('http is allowed for a local Dokploy only', () => {
    expect(baseUrlProblem('http://localhost:3000')).toBeNull();
    expect(baseUrlProblem('http://127.0.0.1:3000')).toBeNull();
    expect(baseUrlProblem('http://dokploy.lan')).toBe('must start with https://');
    expect(tokenEnvProblem('DOKPLOY_API_KEY')).toBeNull();
  });

  test('a missing token variable fails before any request, naming the variable', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch, {}).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('$DOKPLOY_API_KEY is not set');
    expect(s.done()).toBe(true);
  });

  test('the token is read from the configured variable, never from the target', async () => {
    const s = scripted([readApp()]);
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'MY_DOKPLOY' } });
    const r = await adapterWith(s.fetch, { MY_DOKPLOY: TOKEN }).preflight(t, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(t)).not.toContain(TOKEN);
  });

  test('a rejected token is reported as an auth failure', async () => {
    const r = await adapterWith(scripted([{ ...readApp(), status: 401 }]).fetch).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('rejected the API token in $DOKPLOY_API_KEY');
  });

  test('an unknown application is reported as not found', async () => {
    const r = await adapterWith(scripted([{ ...readApp(), status: 404 }]).fetch).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`no Dokploy application ${APP_ID}`);
  });

  test('a reserved name outside the block still fails preflight after one read and no write', async () => {
    const s = scripted([readApp(app({ env: `${RUNTIME_PAIR[0]}=stale` }))]);
    const r = await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(RUNTIME_PAIR[0]);
    expect(s.done()).toBe(true);
  });

  // CAP-682: a selected var also set as a plain value outside the block is no
  // longer a preflight WARNING — it is silently resolvable (the deploy will
  // comment that line out), so preflight just passes clean, direct mode.
  test('a selected variable shadowed outside the block passes preflight with NO warning (it will be commented, not shadowed)', async () => {
    const s = scripted([readApp(app({ env: 'DATABASE_URL=stale' }))]);
    const r = await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings ?? []).toEqual([]);
    expect(s.done()).toBe(true);
  });

  test('a clean application passes, direct mode', async () => {
    const s = scripted([readApp()]);
    expect(await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' })).toEqual({ ok: true });
    expect(s.done()).toBe(true);
  });

  // ── CI preflight (CAP-682) ────────────────────────────────────────────
  describe('CI mode', () => {
    const ciTarget = (overrides: Partial<TargetConfig> = {}) =>
      target({ mode: 'ci', gitBaseBranch: 'main', ...overrides });

    test('direct-mode targets are never subject to any of these checks, even with autoDeploy off', async () => {
      const s = scripted([readApp(app({ autoDeploy: false }))]);
      const r = await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });

    test('a clean CI-ready application passes', async () => {
      const s = scripted([readApp(ciReadyApp())]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
      expect(s.done()).toBe(true);
    });

    test('auto-deploy off refuses with DOKPLOY_AUTODEPLOY_OFF', async () => {
      const s = scripted([readApp(ciReadyApp({ autoDeploy: false }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_AUTODEPLOY_OFF');
    });

    test('autoDeploy null (Dokploy never returned it) refuses the same way as false', async () => {
      const s = scripted([readApp(app({ branch: 'main' }))]); // no autoDeploy field at all
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_AUTODEPLOY_OFF');
    });

    test('a tracked branch that differs from the PR base refuses with DOKPLOY_BRANCH_MISMATCH', async () => {
      const s = scripted([readApp(ciReadyApp({ branch: 'develop' }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget({ gitBaseBranch: 'main' }), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_BRANCH_MISMATCH');
      expect(r.reason).toContain('develop');
      expect(r.reason).toContain('main');
    });

    test('customGitBranch is read too, for a custom git source with no `branch` field', async () => {
      const s = scripted([readApp(app({ autoDeploy: true, branch: undefined, customGitBranch: 'main' }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });

    test('no tracked branch at all (e.g. a docker-image source) refuses with DOKPLOY_BRANCH_MISMATCH, never a false pass', async () => {
      const s = scripted([readApp(app({ autoDeploy: true }))]); // no branch, no customGitBranch
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_BRANCH_MISMATCH');
    });

    test('watch paths that exclude keep.lock refuse with DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP', async () => {
      const s = scripted([readApp(ciReadyApp({ watchPaths: ['src/**', 'package.json'] }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP');
      expect(r.reason).toContain('keep.lock');
    });

    test('watch paths that DO cover keep.lock pass', async () => {
      const s = scripted([readApp(ciReadyApp({ watchPaths: ['keep.lock', 'src/**'] }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });

    test('an empty/null watch-paths list means "watches everything" — no refusal', async () => {
      const s = scripted([readApp(ciReadyApp({ watchPaths: [] }))]);
      const r = await adapterWith(s.fetch).preflight(ciTarget(), { cwd: '/tmp' });
      expect(r.ok).toBe(true);
    });
  });
});

// ── Deploy ─────────────────────────────────────────────────────────────────

describe('dokploy — deploy', () => {
  const expectedEnv = (() => {
    const merged = mergeManagedValuesBlock('NODE_ENV=production\n# a comment\nPORT=3000', [
      { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
      { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
    ]);
    if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
    return merged.env;
  })();

  const saveWith = (env: string): Step => ({
    expect: post('application.saveEnvironment', (body) =>
      expect(body).toEqual({
        applicationId: APP_ID,
        env,
        buildArgs: 'NPM_TOKEN=build-only',
        buildSecrets: 'SENTRY_AUTH=build-secret',
        createEnvFile: false,
      }),
    ),
    json: true,
  });

  const trigger: Step = {
    expect: post('application.deploy', (body) =>
      expect(body).toEqual({ applicationId: APP_ID, title: 'capy deploy dokploy-prod' }),
    ),
    json: true,
  };

  test('delivers plain values, keeps build fields, triggers, and reports success from polling (direct mode)', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([OLD]),
      trigger,
      listDeployments([OLD]), // queued, not recorded yet
      listDeployments([deployment('dep_new', 'running', '2026-09-21T00:00:00.000Z'), OLD]),
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z'), OLD]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.map((st) => [st.label, st.status])).toEqual([
      ['dokploy application', 'ok'],
      ['application.saveEnvironment', 'ok'],
      ['application.deploy', 'ok'],
      ['deployment', 'ok'],
    ]);
    expect(r.steps[1].detail).toContain('2 var(s) written plaintext');
    expect(r.steps[2].detail).toBe('accepted');
    expect(r.steps[3].detail).toContain('succeeded (dep_new)');
    // No more capy-run/revoke language — no deploy token was minted.
    expect(r.epilogue).toContain('No `capy run` step needed');
    expect(r.epilogue).toContain('capy deploy targets-remove dokploy-prod');
    expect(r.epilogue).not.toContain('capy run --');
    expect(r.epilogue).not.toContain('revoke');
  });

  test('values reach Dokploy in plaintext — that is the whole point of CAP-682, not a leak', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(r.ok).toBe(true);
    expect(expectedEnv).toContain(VALUES.DATABASE_URL);
    expect(expectedEnv).toContain(VALUES.STRIPE_KEY);
    expect(envKeys(expectedEnv.split('\n'))).toEqual(['NODE_ENV', 'PORT', 'DATABASE_URL', 'STRIPE_KEY']);
  });

  test('a var missing from the decrypted branch fails before any request', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ env: { DATABASE_URL: VALUES.DATABASE_URL } }));
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('missing in branch production: STRIPE_KEY');
    expect(s.done()).toBe(true);
  });

  test('a failed deployment is reported with its log', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([OLD]),
      trigger,
      listDeployments([
        deployment('dep_new', 'error', '2026-09-21T00:00:00.000Z', { errorMessage: 'Build failed' }),
        OLD,
      ]),
      {
        expect: get('deployment.readLogs', { deploymentId: 'dep_new' }),
        json: 'step 1\nnpm ERR! missing script: start',
      },
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    const last = r.steps[r.steps.length - 1];
    expect(last).toMatchObject({ label: 'deployment', status: 'fail' });
    expect(last.detail).toContain('error (dep_new) — Build failed');
    expect(r.epilogue).toContain('npm ERR! missing script: start');
  });

  test('a cancelled deployment is a failure', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'cancelled', '2026-09-21T00:00:00.000Z')]),
      { expect: get('deployment.readLogs', { deploymentId: 'dep_new' }), json: '' },
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('cancelled');
  });

  test('a deployment still running at the deadline is not called a success', async () => {
    const running = listDeployments([deployment('dep_new', 'running', '2026-09-21T00:00:00.000Z')]);
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      running,
      running,
      running,
    ]);
    const t = target({
      options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'DOKPLOY_API_KEY', timeoutSeconds: 1 },
    });
    // Each clock read advances 400ms: the deadline passes on the third poll.
    const r = await adapterWith(s.fetch, { DOKPLOY_API_KEY: TOKEN }, ticking(400)).deploy(t, ctx());
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('still running after 1s (dep_new)');
  });

  test('no deployment recorded by the deadline is reported as such', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([OLD]),
      trigger,
      listDeployments([OLD]),
      listDeployments([OLD]),
      listDeployments([OLD]),
    ]);
    const t = target({
      options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: 'DOKPLOY_API_KEY', timeoutSeconds: 1 },
    });
    const r = await adapterWith(s.fetch, { DOKPLOY_API_KEY: TOKEN }, ticking(400)).deploy(t, ctx());
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('recorded no new deployment');
  });

  test('a concurrent edit between write and re-read stops the deploy before the trigger', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: 'SOMEONE_ELSE=wrote-this' })),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('not what Capy wrote');
  });

  test('a reserved name that appeared after preflight stops the deploy before any write', async () => {
    const s = scripted([readApp(app({ env: `${RUNTIME_PAIR[0]}=stale` }))]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ label: 'env merge', status: 'fail' });
  });

  // CAP-682: a selected var also active outside the block is now COMMENTED
  // OUT (not left untouched with a warning) — the platform never sees two
  // definitions of the same name.
  test('a selected variable shadowed outside the block is commented out, not warned about', async () => {
    const merged = mergeManagedValuesBlock('STRIPE_KEY=stale', [
      { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
      { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
    ]);
    if (!merged.ok) throw new Error('unexpected');
    const shadowedEnv = merged.env;
    const s = scripted([
      readApp(app({ env: 'STRIPE_KEY=stale' })),
      saveWith(shadowedEnv),
      readApp(app({ env: shadowedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.warnings ?? []).toEqual([]);
    // the old outside line is commented, never deleted
    expect(shadowedEnv.split('\n')).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=stale`);
    expect(shadowedEnv).not.toContain('\nSTRIPE_KEY=stale\n');
    // Capy's own block carries the live value
    // a plain-characters value is written bare (no quotes)
    expect(shadowedEnv.split('\n')).toContain(`STRIPE_KEY=${VALUES.STRIPE_KEY}`);
  });

  test('an existing Capy block is replaced, not duplicated', async () => {
    const previousMerged = mergeManagedValuesBlock('NODE_ENV=production\n# a comment\nPORT=3000', [
      { name: 'DATABASE_URL', value: 'old-value' },
      { name: 'STRIPE_KEY', value: 'old-key' },
    ]);
    if (!previousMerged.ok) throw new Error('unexpected');
    const s = scripted([
      readApp(app({ env: previousMerged.env })),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(expectedEnv.split('\n').filter((l) => l === MANAGED_BEGIN)).toHaveLength(1);
  });

  test('CI mode writes plain values and NEVER calls application.deploy — merging the PR is the deploy signal', async () => {
    const s = scripted([readApp(), saveWith(expectedEnv), readApp(app({ env: expectedEnv }))]);
    const r = await adapterWith(s.fetch).deploy(target({ mode: 'ci' }), ctx({ secretsOnly: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ label: 'application.deploy', status: 'skip' });
    expect(r.epilogue).toContain('No `capy run` step needed');
  });

  test('--no-deploy writes plain values and skips the trigger, same as CI mode structurally', async () => {
    const s = scripted([readApp(), saveWith(expectedEnv), readApp(app({ env: expectedEnv }))]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ noDeploy: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ label: 'application.deploy', status: 'skip', detail: '--no-deploy' });
  });

  test('direct mode (no secretsOnly) DOES call application.deploy and polls to a real outcome', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target({ mode: 'direct' }), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps.some((st) => st.label === 'application.deploy' && st.status === 'ok')).toBe(true);
  });

  test('a dry run makes no request', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(s.done()).toBe(true);
  });

  test('a write rejected by Dokploy is reported and nothing is triggered', async () => {
    const s = scripted([readApp(), { ...saveWith(expectedEnv), status: 403 }]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('rejected the API token');
  });

  test('no deploy token is ever asked for — DeployContext.deployToken is never read', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    // ctx() never sets `deployToken` at all — a deploy still succeeds,
    // proving the adapter never requires one (CAP-682: needsDeployToken is
    // false for Dokploy).
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(r.ok).toBe(true);
  });
});

// ── Remove (onRemove) ──────────────────────────────────────────────────────
//
// `capy deploy remove <target>` always removes the LOCAL target config; for
// a Dokploy target it also OFFERS (yes/no, default no) to strip the Capy
// block from the Dokploy Application env AND un-comment whatever Capy
// commented (CAP-682) — a byte-exact restore, not just a block strip.

describe('dokploy — remove', () => {
  const removedEnv = (() => {
    const merged = mergeManagedValuesBlock('NODE_ENV=production\n# a comment\nPORT=3000', [
      { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
      { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
    ]);
    if (!merged.ok) throw new Error('unexpected');
    return merged.env;
  })();
  const strippedEnv = 'NODE_ENV=production\n# a comment\nPORT=3000';

  const neverAsked = async (): Promise<boolean> => {
    throw new Error('confirm must not be called');
  };

  const confirmCtx = (interactive: boolean, answer: boolean): RemoveOfferContext => ({
    cwd: '/tmp',
    interactive,
    confirm: async () => answer,
  });

  test('yes: strips the block, keeps build fields, and verifies the write', async () => {
    const s = scripted([
      readApp(app({ env: removedEnv })),
      {
        expect: post('application.saveEnvironment', (body) =>
          expect(body).toEqual({
            applicationId: APP_ID,
            env: strippedEnv,
            buildArgs: 'NPM_TOKEN=build-only',
            buildSecrets: 'SENTRY_AUTH=build-secret',
            createEnvFile: false,
          }),
        ),
        json: true,
      },
      readApp(app({ env: strippedEnv })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r).toEqual({ ok: true, code: 'stripped', detail: expect.stringContaining('Removed') });
  });

  test('yes: also un-comments a line Capy had commented for a shadowed var', async () => {
    const beforeRemoval = mergeManagedValuesBlock('STRIPE_KEY=stale', [
      { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
      { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
    ]);
    if (!beforeRemoval.ok) throw new Error('unexpected');
    const s = scripted([
      readApp(app({ env: beforeRemoval.env })),
      {
        expect: post('application.saveEnvironment', (body) => expect(body.env).toBe('STRIPE_KEY=stale')),
        json: true,
      },
      readApp(app({ env: 'STRIPE_KEY=stale' })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
  });

  test('no: declines and leaves the environment untouched', async () => {
    const s = scripted([readApp(app({ env: removedEnv }))]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, false));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('declined');
    expect(r?.manualHint).toContain(MANAGED_BEGIN);
  });

  test('non-TTY: never asks, never strips', async () => {
    const s = scripted([readApp(app({ env: removedEnv }))]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), {
      cwd: '/tmp',
      interactive: false,
      confirm: neverAsked,
    });
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('non_interactive');
  });

  test('no Capy block found: nothing to remove, no prompt needed', async () => {
    const s = scripted([readApp(app({ env: 'NODE_ENV=production' }))]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), {
      cwd: '/tmp',
      interactive: true,
      confirm: neverAsked,
    });
    expect(s.done()).toBe(true);
    expect(r).toEqual({ ok: true, code: 'nothing_to_remove', detail: expect.any(String) });
  });

  test('a block deleted BY HAND, leaving stray "# capy:off " lines behind, is still offered for cleanup — never reported as nothing_to_remove', async () => {
    // Simulates someone deleting just the begin/end markers + block content
    // in the Dokploy dashboard, by hand, leaving the commented lines Capy
    // added sitting there — ordinary comments to Dokploy, so nothing else
    // would ever clean them up. `splitManagedBlock` sees `hadBlock: false`
    // here (no markers at all), but there IS still work to do.
    const strayEnv = `${CAPY_OFF_MARKER}STRIPE_KEY=stale\nNODE_ENV=production\n`;
    const restoredEnv = 'STRIPE_KEY=stale\nNODE_ENV=production\n';
    const s = scripted([
      readApp(app({ env: strayEnv })),
      {
        expect: post('application.saveEnvironment', (body) =>
          expect(body).toEqual({
            applicationId: APP_ID,
            env: restoredEnv,
            buildArgs: 'NPM_TOKEN=build-only',
            buildSecrets: 'SENTRY_AUTH=build-secret',
            createEnvFile: false,
          }),
        ),
        json: true,
      },
      readApp(app({ env: restoredEnv })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r).toEqual({ ok: true, code: 'stripped', detail: expect.stringContaining('Un-commented') });
  });

  test('a block deleted by hand with NO stray marked lines left behind really is nothing to remove', async () => {
    const s = scripted([readApp(app({ env: 'NODE_ENV=production\nSTRIPE_KEY=whatever\n' }))]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), {
      cwd: '/tmp',
      interactive: true,
      confirm: neverAsked,
    });
    expect(s.done()).toBe(true);
    expect(r).toEqual({ ok: true, code: 'nothing_to_remove', detail: expect.any(String) });
  });

  test('a malformed block is refused rather than guessed at, with no prompt', async () => {
    const s = scripted([readApp(app({ env: `${MANAGED_BEGIN}\nA=1` }))]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), {
      cwd: '/tmp',
      interactive: true,
      confirm: neverAsked,
    });
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('malformed_block');
  });

  test('a read-back mismatch after stripping is a typed error, not a silent success', async () => {
    const s = scripted([
      readApp(app({ env: removedEnv })),
      { expect: post('application.saveEnvironment', () => {}), json: true },
      readApp(app({ env: 'SOMEONE_ELSE=wrote-this' })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(false);
    expect(r?.code).toBe('verify_mismatch');
  });

  test('no token: cannot check, so nothing is stripped', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch, {}).onRemove?.(target(), {
      cwd: '/tmp',
      interactive: true,
      confirm: neverAsked,
    });
    expect(s.done()).toBe(true);
    expect(r?.code).toBe('no_token');
  });

  test('migration: an env still holding an OLD blob-style Capy block is replaced cleanly on removal', async () => {
    // Simulates a leftover block from the pre-CAP-682 design (e.g.
    // SlideSpeak's backend-preview): the block content is the old pair, but
    // `splitManagedBlock`/`removeManagedValuesBlock` don't care what is
    // INSIDE the block — they cut the whole thing out by its markers either
    // way, so migration needs no special code path.
    const oldBlobEnv = [
      'NODE_ENV=production',
      MANAGED_BEGIN,
      '_SECRETS_BLOB=old-blob-value',
      '_PROJECT_KEY=' + 'ab'.repeat(32),
      MANAGED_END,
    ].join('\n');
    const s = scripted([
      readApp(app({ env: oldBlobEnv })),
      { expect: post('application.saveEnvironment', (body) => expect(body.env).toBe('NODE_ENV=production')), json: true },
      readApp(app({ env: 'NODE_ENV=production' })),
    ]);
    const r = await adapterWith(s.fetch).onRemove?.(target(), confirmCtx(true, true));
    expect(s.done()).toBe(true);
    expect(r?.ok).toBe(true);
  });
});

// ── System store token resolution (CAP-664) ─────────────────────────────────
//
// The org system store's `_TARGET_DOKPLOY_API_KEY` entry (CAP-679 follow-up
// — deploy's OWN direction, separate from import's `_CONNECTOR_DOKPLOY_API_KEY`)
// is a SECOND source in front of the env var this file's other tests
// exercise throughout — see `dokployApi.ts#resolveDokployApiKey`. Every test above
// still passes unmodified: an adapter built with `createDokployAdapter` and
// no `getConnectorSecret` dep, called with no `ctx.resolvedApiKey`, resolves
// env-only exactly as before. These tests cover the two NEW paths: a caller
// (`deployCommand.ts`) pre-resolving once and threading it through
// `ctx.resolvedApiKey`, and the adapter's own fallback reaching an injected
// store.

describe('dokploy — system store token resolution', () => {
  const noNetwork = scripted([]);
  const expectedEnv = (() => {
    const merged = mergeManagedValuesBlock('NODE_ENV=production\n# a comment\nPORT=3000', [
      { name: 'DATABASE_URL', value: VALUES.DATABASE_URL },
      { name: 'STRIPE_KEY', value: VALUES.STRIPE_KEY },
    ]);
    if (!merged.ok) throw new Error('unexpected');
    return merged.env;
  })();
  const saveWith = (env: string): Step => ({
    expect: post('application.saveEnvironment', (body) =>
      expect(body).toEqual({
        applicationId: APP_ID,
        env,
        buildArgs: 'NPM_TOKEN=build-only',
        buildSecrets: 'SENTRY_AUTH=build-secret',
        createEnvFile: false,
      }),
    ),
    json: true,
  });
  const neverAskedHere = async (): Promise<boolean> => {
    throw new Error('confirm must not be called');
  };

  test('preflight: a pre-resolved ctx.resolvedApiKey wins outright, even with no env and no tokenEnv', async () => {
    const s = scripted([readApp()]);
    // env is EMPTY and the target has no tokenEnv at all — only the
    // pre-resolved value could possibly satisfy this call.
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    const r = await adapterWith(s.fetch, {}).preflight(t, {
      cwd: '/tmp',
      resolvedApiKey: { ok: true, value: TOKEN, source: 'system' },
    });
    expect(r.ok).toBe(true);
    expect(s.done()).toBe(true);
  });

  test('deploy: the SAME pre-resolved ctx.resolvedApiKey is reused, no store or env involved', async () => {
    const s = scripted([readApp(), saveWith(expectedEnv), readApp(app({ env: expectedEnv }))]);
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    const r = await adapterWith(s.fetch, {}).deploy(
      t,
      ctx({ secretsOnly: true, resolvedApiKey: { ok: true, value: TOKEN, source: 'system' } }),
    );
    expect(r.ok).toBe(true);
    expect(s.done()).toBe(true);
  });

  test('onRemove: a pre-resolved ctx.resolvedApiKey is honored too', async () => {
    // No Capy block in this env — a real read happens (proving the token
    // WAS usable) and onRemove reports there's nothing to strip.
    const s = scripted([readApp(app({ env: 'NODE_ENV=production' }))]);
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    const r = await adapterWith(s.fetch, {}).onRemove?.(t, {
      cwd: '/tmp',
      interactive: true,
      confirm: neverAskedHere,
      resolvedApiKey: { ok: true, value: TOKEN, source: 'system' },
    });
    expect(s.done()).toBe(true);
    expect(r).toEqual({ ok: true, code: 'nothing_to_remove', detail: expect.any(String) });
  });

  test('preflight: no ctx.resolvedApiKey and no explicit-env match falls through to an injected store, called exactly once', async () => {
    const getConnectorSecret = mock(async (name: string, opts: DokploySystemStoreCallOptions) => {
      // CAP-679 follow-up: the adapter (deploy's own direction) asks for
      // `_TARGET_DOKPLOY_API_KEY`, never the import-side connector key.
      expect(name).toBe('_TARGET_DOKPLOY_API_KEY');
      expect(opts.interactive).toBe(false);
      return TOKEN;
    });
    const s = scripted([readApp()]);
    // target() defaults tokenEnv to DOKPLOY_API_KEY, but env is empty here —
    // the explicit-env step fails, so resolution must fall to the store.
    const a = createDokployAdapter({ fetch: s.fetch, env: {}, getConnectorSecret });
    const r = await a.preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(s.done()).toBe(true);
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
  });

  test('a target with NO tokenEnv at all resolves through the store', async () => {
    const getConnectorSecret = mock(async () => TOKEN);
    const s = scripted([readApp()]);
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    const a = createDokployAdapter({ fetch: s.fetch, env: {}, getConnectorSecret });
    const r = await a.preflight(t, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
  });

  test('preflight: a non-admin store refusal with no env fallback names SYSTEM_STORE_ADMIN_ONLY, zero requests', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const a = createDokployAdapter({ fetch: noNetwork.fetch, env: {}, getConnectorSecret });
    const r = await a.preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('admin');
    expect(noNetwork.done()).toBe(true);
  });

  test('deploy: the same non-admin refusal fails before any request', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const a = createDokployAdapter({ fetch: noNetwork.fetch, env: {}, getConnectorSecret });
    const r = await a.deploy(target(), ctx());
    expect(r.ok).toBe(false);
    expect(r.steps[r.steps.length - 1].detail).toContain('admin');
    expect(noNetwork.done()).toBe(true);
  });

  test('a non-admin refusal still falls back to the default env var when it is set', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const s = scripted([readApp()]);
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    const a = createDokployAdapter({ fetch: s.fetch, env: { DOKPLOY_API_KEY: TOKEN }, getConnectorSecret });
    const r = await a.preflight(t, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(s.done()).toBe(true);
  });

  test('a target with no tokenEnv passes config-shape validation (tokenEnv is optional)', () => {
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID } });
    expect(optionsProblem(t)).toBeNull();
  });

  test('an invalid tokenEnv FORMAT is still rejected when one is present', () => {
    const t = target({ options: { baseUrl: BASE, applicationId: APP_ID, tokenEnv: '1BAD' } });
    expect(optionsProblem(t)?.reason).toContain('tokenEnv');
  });
});
