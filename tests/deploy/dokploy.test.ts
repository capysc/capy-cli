import { describe, test, expect, mock } from 'bun:test';
import {
  apiBase,
  createDokployAdapter,
  createDokployClient,
  envKeys,
  envProblems,
  envWarnings,
  mergeManagedBlock,
  optionsProblem,
  splitManagedBlock,
  stripManagedBlock,
  baseUrlProblem,
  tokenEnvProblem,
  DokployDeployment,
  DokploySystemStoreCallOptions,
  FetchLike,
  MANAGED_BEGIN,
  MANAGED_END,
  OLD_RUNTIME_PAIR,
  RUNTIME_PAIR,
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
const PAIR = { secretsBlob: 'QkxPQg==', projectKey: 'ab'.repeat(32), deployId: 'cd'.repeat(32) };

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
  test('is a registered adapter that ships the capy run pair', () => {
    const a = getAdapter('dokploy');
    expect(a?.label).toBe('Dokploy');
    expect(a?.needsDeployToken).toBe(true);
    expect(a?.varKind).toBe('runtime');
    expect(a?.defaultMode).toBe('direct');
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
});

// ── Env merge ──────────────────────────────────────────────────────────────

/** `splitManagedBlock` + `mergeManagedBlock` in one step — the production flow. */
function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

/** `splitManagedBlock` + `stripManagedBlock` in one step — the revert side. */
function stripEnv(env: string | null): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return stripManagedBlock(split);
}

const PAIR_B = { secretsBlob: 'TkVX', projectKey: 'ef'.repeat(32) };

describe('dokploy — env merge', () => {
  test('envKeys reads KEY= and export KEY= lines, skipping comments and blanks', () => {
    expect(envKeys(['A=1', 'export B=2', '# C=3', '', '  D = 4', 'not a line'])).toEqual(['A', 'B', 'D']);
  });

  test('first write appends the block and keeps every other line verbatim', () => {
    const split = splitManagedBlock('NODE_ENV=production\n# note\nPORT=3000');
    expect('code' in split).toBe(false);
    if ('code' in split) return;
    expect(split.hadBlock).toBe(false);
    expect(mergeManagedBlock(split, PAIR)).toBe(
      [
        'NODE_ENV=production',
        '# note',
        'PORT=3000',
        MANAGED_BEGIN,
        `_SECRETS_BLOB=${PAIR.secretsBlob}`,
        `_PROJECT_KEY=${PAIR.projectKey}`,
        MANAGED_END,
      ].join('\n'),
    );
  });

  test('an empty Dokploy env gets just the block', () => {
    expect(mergedEnv(null, PAIR).split('\n')[0]).toBe(MANAGED_BEGIN);
  });

  test('a later write replaces the block in place, not a second copy', () => {
    const first = mergedEnv('A=1', PAIR);
    const withUserEdit = `${first}\nB=2`;
    const split = splitManagedBlock(withUserEdit);
    if ('code' in split) throw new Error('unexpected problem');
    expect(split.hadBlock).toBe(true);
    const second = mergeManagedBlock(split, PAIR_B);
    expect(second.split('\n').filter((l) => l === MANAGED_BEGIN)).toHaveLength(1);
    expect(second).toContain('A=1');
    expect(second).toContain('B=2');
    expect(second).toContain('_SECRETS_BLOB=TkVX');
    expect(second).not.toContain(PAIR.secretsBlob);
  });

  test('the runtime pair inside Capy\'s block is not a collision', () => {
    expect(envProblems(mergedEnv('A=1', PAIR))).toBeNull();
  });

  // Changed: `envProblems` no longer takes a `selectedVars` argument — that
  // check moved to `envWarnings` (rule 3 is now a warning, not a refusal).
  test('the new-name runtime pair Capy did not write is refused', () => {
    expect(envProblems(`${RUNTIME_PAIR[0]}=old\n${RUNTIME_PAIR[1]}=old`)).toEqual({
      code: 'reserved_outside_block',
      names: [...RUNTIME_PAIR],
    });
    expect(envProblems(`export ${RUNTIME_PAIR[1]}=old`)?.code).toBe('reserved_outside_block');
  });

  // New: rule 2 must also cover the pair the adapter USED to write, so an
  // old-name leftover from a prior deploy is never silently adopted as Capy's.
  test('the old-name runtime pair Capy no longer writes is also refused', () => {
    expect(envProblems(`${OLD_RUNTIME_PAIR[0]}=old\n${OLD_RUNTIME_PAIR[1]}=old`)).toEqual({
      code: 'reserved_outside_block',
      names: [...OLD_RUNTIME_PAIR],
    });
    expect(envProblems(`export ${OLD_RUNTIME_PAIR[1]}=old`)?.code).toBe('reserved_outside_block');
  });

  // Changed: was `envProblems(..., selectedVars)` returning a
  // `selected_var_override` refusal. Rule 3 now warns instead of refusing —
  // `capy run`'s new pair lets the decrypted value win, so a stale
  // dashboard value is shadowed rather than dangerous.
  test('a selected variable also set in Dokploy is a warning, not a refusal', () => {
    expect(envProblems('STRIPE_KEY=stale\nDATABASE_URL=stale\nPORT=1')).toBeNull();
    expect(
      envWarnings('STRIPE_KEY=stale\nDATABASE_URL=stale\nPORT=1', ['STRIPE_KEY', 'DATABASE_URL', 'X']),
    ).toEqual({
      code: 'DOKPLOY_SHADOWED_VAR',
      names: ['DATABASE_URL', 'STRIPE_KEY'],
    });
  });

  test('an unselected variable in Dokploy is left alone', () => {
    expect(envProblems('PORT=3000')).toBeNull();
    expect(envWarnings('PORT=3000', ['DATABASE_URL'])).toBeNull();
  });

  test('an edited or duplicated block is refused rather than guessed at', () => {
    expect(envProblems(`${MANAGED_BEGIN}\n${RUNTIME_PAIR[0]}=x`)?.code).toBe('malformed_block');
    expect(envProblems(`${MANAGED_END}\n${MANAGED_BEGIN}`)?.code).toBe('malformed_block');
    const twice = `${mergedEnv(null, PAIR)}\n${mergedEnv(null, PAIR)}`;
    expect(envProblems(twice)?.code).toBe('malformed_block');
  });

  test('stripManagedBlock is the exact revert of a first write', () => {
    const outside = 'NODE_ENV=production\n# note\nPORT=3000';
    expect(stripEnv(mergedEnv(outside, PAIR))).toBe(outside);
  });

  // ── Reversibility: strip(merge(x)) === x, byte for byte ────────────────
  //
  // Capy only ever adds its own block. Everything outside it — every line's
  // own terminator, the trailing-newline state, however many trailing blank
  // lines were already there — comes back exactly as it was before Capy's
  // first write, whether the block was written once or replaced several
  // times since.
  describe('reversibility: byte for byte', () => {
    const CASES: ReadonlyArray<[string, string | null]> = [
      ['empty string', ''],
      ['null (Dokploy has no env yet)', null],
      ['just a newline', '\n'],
      ['LF, no trailing newline', 'A=1\nB=2'],
      ['LF, with a trailing newline', 'A=1\nB=2\n'],
      ['CRLF, no trailing newline', 'A=1\r\nB=2'],
      ['CRLF, with a trailing newline', 'A=1\r\nB=2\r\n'],
      ['mixed LF and CRLF', 'A=1\r\nB=2\nC=3\r\n'],
      ['multiple trailing blank lines', 'A=1\n\n\n'],
      ['a comment', '# hello\nA=1\n'],
      ['a shadowed var', 'STRIPE_KEY=stale\nPORT=3000\n'],
      ['a single line, no newline at all', 'A=1'],
    ];

    for (const [label, x] of CASES) {
      test(`${label}: strip(merge(x)) === x`, () => {
        expect(stripEnv(mergedEnv(x, PAIR))).toBe(x ?? '');
      });

      test(`${label}: strip(merge(merge(x, pairA), pairB)) === x`, () => {
        const once = mergedEnv(x, PAIR);
        const twice = mergedEnv(once, PAIR_B);
        expect(stripEnv(twice)).toBe(x ?? '');
      });
    }

    test('an empty env and a null env produce byte-identical first writes', () => {
      expect(mergedEnv('', PAIR)).toBe(mergedEnv(null, PAIR));
    });

    test('a first write uses the dominant line ending, separator only as needed', () => {
      expect(mergedEnv('A=1\r\nB=2\r\n', PAIR)).toContain(`A=1\r\nB=2\r\n\r\n${MANAGED_BEGIN}`);
      expect(mergedEnv('A=1\nB=2\n', PAIR)).toContain(`A=1\nB=2\n\n${MANAGED_BEGIN}`);
      // No existing content at all: no separator, just the block.
      expect(mergedEnv('', PAIR).startsWith(MANAGED_BEGIN)).toBe(true);
    });

    test("a replace reuses the block's own line ending, never the outside content's", () => {
      const firstCrlf = mergedEnv('A=1\r\n', PAIR); // block first written against a CRLF env
      // Hand-edit outside the block afterwards, in LF — must not change how a
      // later replace joins the block's own 4 lines.
      const withLfLineAdded = firstCrlf.replace('A=1\r\n\r\n', 'A=1\r\n\r\nC=3\n');
      const split = splitManagedBlock(withLfLineAdded);
      if ('code' in split) throw new Error('unexpected problem');
      expect(split.blockEol).toBe('\r\n');
      const replaced = mergeManagedBlock(split, PAIR_B);
      expect(replaced).toContain(`${MANAGED_BEGIN}\r\n`);
      expect(replaced).toContain('A=1\r\n\r\nC=3\n');
    });
  });

  // ── Collision detection + import candidates: CRLF-safe ─────────────────

  test('collision detection sees a reserved name even on a CRLF-terminated line', () => {
    expect(envProblems(`${RUNTIME_PAIR[0]}=old\r\n${RUNTIME_PAIR[1]}=old\r\n`)).toEqual({
      code: 'reserved_outside_block',
      names: [...RUNTIME_PAIR],
    });
  });

  test('a shadowed-var warning is found on a CRLF-terminated line, and the name carries no \\r', () => {
    const warning = envWarnings('STRIPE_KEY=stale\r\nPORT=1\r\n', ['STRIPE_KEY']);
    expect(warning).toEqual({ code: 'DOKPLOY_SHADOWED_VAR', names: ['STRIPE_KEY'] });
    expect(warning?.names.some((n) => n.includes('\r'))).toBe(false);
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

  // Changed: rule 3 (a selected var shadowed outside the block) used to fail
  // preflight. It is now a warning — preflight still passes, and reports it
  // as structured `warnings` for the terminal/--json to print.
  test('a selected variable shadowed outside the block passes preflight with a warning', async () => {
    const s = scripted([readApp(app({ env: 'DATABASE_URL=stale' }))]);
    const r = await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      { code: 'DOKPLOY_SHADOWED_VAR', names: ['DATABASE_URL'], message: expect.stringContaining('DATABASE_URL') },
    ]);
    expect(s.done()).toBe(true);
  });

  test('a clean application passes', async () => {
    const s = scripted([readApp()]);
    expect(await adapterWith(s.fetch).preflight(target(), { cwd: '/tmp' })).toEqual({ ok: true });
    expect(s.done()).toBe(true);
  });
});

// ── Deploy ─────────────────────────────────────────────────────────────────

describe('dokploy — deploy', () => {
  const expectedEnv = mergedEnv('NODE_ENV=production\n# a comment\nPORT=3000', PAIR);

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

  test('delivers the pair, keeps build fields, triggers, and reports success from polling', async () => {
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
    expect(r.steps[1].detail).toContain('added');
    expect(r.steps[2].detail).toBe('accepted');
    expect(r.steps[3].detail).toContain('succeeded (dep_new)');
    expect(r.epilogue).toContain('capy run -- <your start command>');
    expect(r.epilogue).toContain(`capy deploy revoke ${PAIR.deployId}`);
  });

  test('only the runtime pair reaches Dokploy — never an individual secret', async () => {
    const s = scripted([
      readApp(),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(
      target(),
      ctx({ env: { DATABASE_URL: 'postgres://plaintext' } }),
    );
    expect(r.ok).toBe(true);
    expect(expectedEnv).not.toContain('postgres://plaintext');
    expect(envKeys(expectedEnv.split('\n'))).toEqual(['NODE_ENV', 'PORT', ...RUNTIME_PAIR]);
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

  // Changed: this used to be `envProblems`'s `selected_var_override` refusal
  // (stopped before any write). Rule 3 is now a warning: the deploy proceeds,
  // the shadowed line outside the block is carried through byte-for-byte
  // (never touched), and the shadow is reported as structured `warnings`.
  test('a selected variable shadowed outside the block warns and proceeds, leaving that line untouched', async () => {
    const shadowedEnv = mergedEnv('STRIPE_KEY=stale', PAIR);
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
    expect(r.warnings).toEqual([
      { code: 'DOKPLOY_SHADOWED_VAR', names: ['STRIPE_KEY'], message: expect.stringContaining('STRIPE_KEY') },
    ]);
    // the shadowed line rode through the write byte-for-byte, untouched
    expect(shadowedEnv.split('\n')).toContain('STRIPE_KEY=stale');
  });

  test('an existing Capy block is replaced, not duplicated', async () => {
    const previous = mergedEnv('NODE_ENV=production\n# a comment\nPORT=3000', {
      secretsBlob: 'T0xE',
      projectKey: '00'.repeat(32),
    });
    const s = scripted([
      readApp(app({ env: previous })),
      saveWith(expectedEnv),
      readApp(app({ env: expectedEnv })),
      listDeployments([]),
      trigger,
      listDeployments([deployment('dep_new', 'done', '2026-09-21T00:00:00.000Z')]),
    ]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx());
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[1].detail).toContain('replaced');
  });

  test('CI mode writes the pair and leaves the deploy to the pipeline', async () => {
    const s = scripted([readApp(), saveWith(expectedEnv), readApp(app({ env: expectedEnv }))]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ secretsOnly: true }));
    expect(s.done()).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ label: 'application.deploy', status: 'skip' });
  });

  test('a dry run makes no request', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ dryRun: true, deployToken: undefined }));
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

  test('no minted pair means no request', async () => {
    const s = scripted([]);
    const r = await adapterWith(s.fetch).deploy(target(), ctx({ deployToken: undefined }));
    expect(r.ok).toBe(false);
    expect(s.done()).toBe(true);
  });
});

// ── Remove (onRemove) ──────────────────────────────────────────────────────
//
// `capy deploy remove <target>` always removes the LOCAL target config; for
// a Dokploy target it also OFFERS (yes/no, default no) to strip the Capy
// block from the Dokploy Application env. `onRemove` is the hook that does
// the offering — deployCommand.ts only wires the terminal confirm.

describe('dokploy — remove', () => {
  const removedEnv = mergedEnv('NODE_ENV=production\n# a comment\nPORT=3000', PAIR);
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
});

// ── System store token resolution (CAP-664) ─────────────────────────────────
//
// The org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry is a SECOND
// source in front of the env var this file's other tests exercise
// throughout — see `dokployApi.ts#resolveDokployApiKey`. Every test above
// still passes unmodified: an adapter built with `createDokployAdapter` and
// no `getConnectorSecret` dep, called with no `ctx.resolvedApiKey`, resolves
// env-only exactly as before. These tests cover the two NEW paths: a caller
// (`deployCommand.ts`) pre-resolving once and threading it through
// `ctx.resolvedApiKey`, and the adapter's own fallback reaching an injected
// store.

describe('dokploy — system store token resolution', () => {
  const noNetwork = scripted([]);
  const expectedEnv = mergedEnv('NODE_ENV=production\n# a comment\nPORT=3000', PAIR);
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
      expect(name).toBe('_CONNECTOR_DOKPLOY_API_KEY');
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
