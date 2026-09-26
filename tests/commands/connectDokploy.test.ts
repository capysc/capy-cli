/**
 * `capy connect dokploy` — the PULL half of CAP-662 (parent CAP-657).
 *
 * Covers: settings resolution (flags/saved-target/ambiguous/missing), the
 * import itself (request shape, token-missing short-circuit, error mapping,
 * reference-value skip, conflict handling, selection, keep.lock metadata,
 * deploy-target offer), the JSON/terminal output shape with no secret value
 * anywhere, and `capy rotate`'s refusal on a dokploy-managed var before any
 * network call.
 *
 * Every network-touching test injects its own `fetch` via
 * `DokployConnectorDeps` rather than mocking a module — this file needs no
 * `mock.module()` and does not have to run in `run-tests.sh`'s isolated list.
 */
import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDokployConnector,
  mapImportApiError,
  resolveDokploySettings,
  type DokploySettingsDeps,
} from '../../src/commands/connectors/dokploy';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import { writeImportedAndSync } from '../../src/commands/connectors/shared';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { DokployApiError } from '../../src/deploy/dokployApi';
import type { DokploySystemStoreCallOptions, FetchLike } from '../../src/deploy/dokployApi';
import { TargetConfig } from '../../src/deploy/adapter';
import { listTargets, upsertTarget } from '../../src/deploy/config';
import type { ConnectOpts, ConnectorModule, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';

// ── test helpers ─────────────────────────────────────────────────────────────

const DOKPLOY_TARGET = (over: Partial<TargetConfig> = {}): TargetConfig => ({
  name: 'dokploy',
  kind: 'dokploy',
  branch: 'development',
  vars: [],
  options: { baseUrl: 'https://dokploy.example.com', applicationId: 'app_1', tokenEnv: 'DOKPLOY_API_KEY' },
  ...over,
});

const BASE_OPTS: ConnectOpts = { nonTty: true };

function ctxWith(over: Partial<ResolvedContext> & { localPlaintext?: Record<string, string> } = {}): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return { keep, branch: 'development', localPlaintext: {}, ...over } as unknown as ResolvedContext;
}

interface FakeCall {
  method: string;
  url: string;
}

/**
 * A `FetchLike` scripted to answer `application.one` with the given env,
 * echoing back whatever `applicationId` the request actually asked for (read
 * off the query string) so the response always matches the request —
 * `createDokployClient.getApplication` refuses a mismatch as `bad_response`.
 */
function fakeFetch(opts: { env: string | null; status?: number; calls: FakeCall[] }): FetchLike {
  const { env, status = 200, calls } = opts;
  return (async (url: string, init: { method: string }) => {
    calls.push({ method: init.method, url });
    if (status !== 200) {
      return { status, ok: false, text: async () => JSON.stringify({ message: 'error' }) };
    }
    const applicationId = new URL(url).searchParams.get('applicationId') ?? 'app_1';
    return {
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          applicationId,
          name: 'demo-app',
          env,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: true,
        }),
    };
  }) as FetchLike;
}

/** Never called — for the "zero requests" assertions. */
const unreachableFetch: FetchLike = (async () => {
  throw new Error('fetch should not have been called');
}) as FetchLike;

/**
 * `isInteractive()` also requires a real `process.stdin.isTTY`, which
 * `bun test` never has — `nonTty: false` alone is not enough to exercise the
 * interactive branch here, exactly like `tests/ui/resolveTableNonTty.test.ts`
 * has to fake the opposite direction.
 */
async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
  }
}

// ── resolveDokploySettings ───────────────────────────────────────────────────

describe('resolveDokploySettings', () => {
  const deps: DokploySettingsDeps = {
    pickTarget: async () => {
      throw new Error('pickTarget should not be called in this test');
    },
    askSettings: async () => {
      throw new Error('askSettings should not be called in this test');
    },
  };

  test('flags win outright, tokenEnv defaulted', async () => {
    const opts: ConnectOpts = { baseUrl: 'https://d.example.com', application: 'app_x' };
    const r = await resolveDokploySettings(opts, [], true, deps);
    expect(r).toEqual({ ok: true, baseUrl: 'https://d.example.com', applicationId: 'app_x', tokenEnv: 'DOKPLOY_API_KEY' });
  });

  test('flags win even with saved targets present', async () => {
    const opts: ConnectOpts = { baseUrl: 'https://d.example.com', application: 'app_x', tokenEnv: 'MY_TOKEN' };
    const r = await resolveDokploySettings(opts, [DOKPLOY_TARGET()], true, deps);
    expect(r).toEqual({ ok: true, baseUrl: 'https://d.example.com', applicationId: 'app_x', tokenEnv: 'MY_TOKEN' });
  });

  test('the lone saved target is used when no flags are given', async () => {
    const r = await resolveDokploySettings({}, [DOKPLOY_TARGET()], true, deps);
    expect(r).toEqual({
      ok: true,
      baseUrl: 'https://dokploy.example.com',
      applicationId: 'app_1',
      tokenEnv: 'DOKPLOY_API_KEY',
    });
  });

  test('--token-env overrides the saved target independently', async () => {
    const r = await resolveDokploySettings({ tokenEnv: 'OTHER_TOKEN' }, [DOKPLOY_TARGET()], true, deps);
    expect((r as { tokenEnv: string }).tokenEnv).toBe('OTHER_TOKEN');
  });

  test('several targets, non-interactive: refuses DOKPLOY_TARGET_AMBIGUOUS', async () => {
    const targets = [DOKPLOY_TARGET({ name: 'a' }), DOKPLOY_TARGET({ name: 'b' })];
    const r = await resolveDokploySettings({}, targets, false, deps);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('DOKPLOY_TARGET_AMBIGUOUS');
  });

  test('several targets, interactive: asks which one', async () => {
    const targets = [DOKPLOY_TARGET({ name: 'a', options: { baseUrl: 'https://a', applicationId: 'app_a', tokenEnv: 'T' } }), DOKPLOY_TARGET({ name: 'b' })];
    const r = await resolveDokploySettings({}, targets, true, { ...deps, pickTarget: async () => 'a' });
    expect(r).toEqual({ ok: true, baseUrl: 'https://a', applicationId: 'app_a', tokenEnv: 'T' });
  });

  test('no targets, non-interactive: refuses DOKPLOY_SETTINGS_MISSING', async () => {
    const r = await resolveDokploySettings({}, [], false, deps);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('DOKPLOY_SETTINGS_MISSING');
  });

  test('no targets, interactive: asks for base URL + application id', async () => {
    const r = await resolveDokploySettings({}, [], true, {
      ...deps,
      askSettings: async () => ({ baseUrl: 'https://asked.example.com', applicationId: 'app_asked' }),
    });
    expect(r).toEqual({
      ok: true,
      baseUrl: 'https://asked.example.com',
      applicationId: 'app_asked',
      tokenEnv: 'DOKPLOY_API_KEY',
    });
  });
});

// ── mapImportApiError ─────────────────────────────────────────────────────────

describe('mapImportApiError', () => {
  test('401/403 → DOKPLOY_AUTH_FAILED', () => {
    expect(mapImportApiError(new DokployApiError('unauthorized', 401, 'x'), 'app_1').code).toBe('DOKPLOY_AUTH_FAILED');
    expect(mapImportApiError(new DokployApiError('unauthorized', 403, 'x'), 'app_1').code).toBe('DOKPLOY_AUTH_FAILED');
  });

  test('404 → DOKPLOY_APP_NOT_FOUND', () => {
    expect(mapImportApiError(new DokployApiError('not_found', 404, 'x'), 'app_1').code).toBe('DOKPLOY_APP_NOT_FOUND');
  });

  test('anything else → a generic DOKPLOY_API_ERROR', () => {
    expect(mapImportApiError(new DokployApiError('server_error', 500, 'x'), 'app_1').code).toBe('DOKPLOY_API_ERROR');
    expect(mapImportApiError(new Error('boom'), 'app_1').code).toBe('DOKPLOY_API_ERROR');
  });
});

// ── createDokployConnector().import() ────────────────────────────────────────

describe('dokploy import — token + request shape', () => {
  test('missing token: zero requests, coded refusal', async () => {
    const connector = createDokployConnector({ fetch: unreachableFetch, env: {} });
    const outcome = await connector.import!(
      ctxWith(),
      { ...BASE_OPTS, baseUrl: 'https://d.example.com', application: 'app_1', tokenEnv: 'MISSING_TOKEN' },
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: string }).code).toBe('DOKPLOY_TOKEN_MISSING');
  });

  test('only ever GETs application.one — never a write to Dokploy', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls }),
      env: { TOK: 'secret-token' },
    });
    await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
      tokenEnv: 'TOK',
    });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('application.one');
  });

  test('the token is sent as x-api-key, read from the configured var name only', async () => {
    const calls: FakeCall[] = [];
    let sawHeader: string | undefined;
    const fetchImpl: FetchLike = (async (url: string, init: { headers: Record<string, string> }) => {
      sawHeader = init.headers['x-api-key'];
      calls.push({ method: 'GET', url });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ applicationId: 'app_1', env: null, buildArgs: null, buildSecrets: null, createEnvFile: true }),
      };
    }) as FetchLike;
    const connector = createDokployConnector({ fetch: fetchImpl, env: { CUSTOM_TOKEN_VAR: 'tok_abc' } });
    await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
      tokenEnv: 'CUSTOM_TOKEN_VAR',
    });
    expect(sawHeader).toBe('tok_abc');
  });

  test('401 → DOKPLOY_AUTH_FAILED, 404 → DOKPLOY_APP_NOT_FOUND', async () => {
    const calls: FakeCall[] = [];
    const unauthorized = createDokployConnector({ fetch: fakeFetch({ env: null, status: 401, calls }), env: { T: 'x' } });
    const r1 = await unauthorized.import!(ctxWith(), { ...BASE_OPTS, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect((r1 as { code: string }).code).toBe('DOKPLOY_AUTH_FAILED');

    const notFound = createDokployConnector({ fetch: fakeFetch({ env: null, status: 404, calls }), env: { T: 'x' } });
    const r2 = await notFound.import!(ctxWith(), { ...BASE_OPTS, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect((r2 as { code: string }).code).toBe('DOKPLOY_APP_NOT_FOUND');
  });
});

describe('dokploy import — selection and skipping', () => {
  const env = ['DATABASE_URL=postgres://x', 'REF=${{project.OTHER}}', 'PORT=3000'].join('\n');

  test('a reference value is skipped and named, not imported as a literal string', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(ctxWith(), { ...BASE_OPTS, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.imported.map((e) => e.varName).sort()).toEqual(['DATABASE_URL', 'PORT']);
    expect(outcome.warnings).toEqual(
      expect.arrayContaining([{ code: 'DOKPLOY_REFERENCE_VALUE', names: ['REF'] }]),
    );
  });

  test('runtime pairs and the Capy block never appear as candidates', async () => {
    const withPairs = [
      '_SECRETS_BLOB=x',
      '_PROJECT_KEY=y',
      'SECRETS_BLOB=x',
      'PROJECT_KEY=y',
      'REAL_VAR=z',
    ].join('\n');
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env: withPairs, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(ctxWith(), { ...BASE_OPTS, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.imported.map((e) => e.varName)).toEqual(['REAL_VAR']);
  });

  test('--var restricts the import to exactly the requested names (comma-separated)', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d',
      application: 'a',
      tokenEnv: 'T',
      var: 'PORT, DATABASE_URL',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.imported.map((e) => e.varName).sort()).toEqual(['DATABASE_URL', 'PORT']);
  });

  test('non-TTY with no restriction imports everything importable', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(ctxWith(), { nonTty: true, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.imported.map((e) => e.varName).sort()).toEqual(['DATABASE_URL', 'PORT']);
  });

  test('interactive: the checkbox picker\'s selection is respected', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env, calls }),
      env: { T: 'x' },
      selectVars: async () => ['PORT'],
      // Not under test here — declined so this test stays about selection,
      // not the deploy-target offer (covered in its own describe block).
      confirm: async () => false,
    });
    const outcome = await withTTY(() => connector.import!(ctxWith(), { nonTty: false, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.imported.map((e) => e.varName)).toEqual(['PORT']);
  });
});

describe('dokploy import — conflicts and unchanged', () => {
  const env = 'DATABASE_URL=postgres://new\nPORT=3000';
  // Isolates the one test below whose `confirm` can resolve `true`: with the
  // real cwd as the default, an accepted deploy-target offer would write an
  // ACTUAL `.capy/deploy.json` into this checkout (caught the hard way — see
  // the "dokploy import — deploy-target offer" block for the pattern this
  // mirrors).
  const ROOT = mkdtempSync(join(tmpdir(), 'capy-dokploy-conflicts-'));
  afterEach(() => {
    if (existsSync(join(ROOT, '.capy'))) rmSync(join(ROOT, '.capy'), { recursive: true, force: true });
  });

  test('same value locally → unchanged, no-op', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(
      ctxWith({ localPlaintext: { PORT: '3000' } }),
      { nonTty: true, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.unchanged).toEqual(['PORT']);
    expect(outcome.imported.map((e) => e.varName)).not.toContain('PORT');
  });

  test('different value, non-TTY: keeps the local value, reports IMPORT_CONFLICT_SKIPPED', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env, calls }), env: { T: 'x' } });
    const outcome = await connector.import!(
      ctxWith({ localPlaintext: { PORT: '8080' } }),
      { nonTty: true, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skipped).toEqual(expect.arrayContaining([{ name: 'PORT', code: 'IMPORT_CONFLICT_SKIPPED' }]));
    expect(outcome.imported.map((e) => e.varName)).not.toContain('PORT');
  });

  test('different value, interactive + confirm=true: replaces with the Dokploy value', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env, calls }),
      env: { T: 'x' },
      cwd: ROOT,
      confirm: async () => true,
      selectVars: async (c: readonly string[]) => c,
    });
    const outcome = await withTTY(() =>
      connector.import!(
        ctxWith({ localPlaintext: { PORT: '8080' } }),
        { nonTty: false, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' },
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const port = outcome.imported.find((e) => e.varName === 'PORT');
    expect(port?.value).toBe('3000');
  });

  test('different value, interactive + confirm=false: keeps local, reports skipped', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env, calls }),
      env: { T: 'x' },
      confirm: async () => false,
      selectVars: async (c: readonly string[]) => c,
    });
    const outcome = await withTTY(() =>
      connector.import!(
        ctxWith({ localPlaintext: { PORT: '8080' } }),
        { nonTty: false, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' },
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skipped).toEqual(expect.arrayContaining([{ name: 'PORT', code: 'IMPORT_CONFLICT_SKIPPED' }]));
  });
});

describe('dokploy import — keep.lock metadata + warnings', () => {
  test('every imported var carries provider, application_id and imported_at', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls }),
      env: { T: 'x' },
      now: () => new Date('2026-09-23T00:00:00.000Z'),
    });
    const outcome = await connector.import!(ctxWith(), { nonTty: true, baseUrl: 'https://d', application: 'app_xyz', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entry = outcome.imported[0].entry as ConnectorMetadata;
    expect(entry.provider).toBe('dokploy');
    expect(entry.application_id).toBe('app_xyz');
    expect(entry.imported_at).toBe('2026-09-23T00:00:00.000Z');
    expect(entry.fingerprint).toBeTruthy();
  });

  test('a successful import warns DOKPLOY_PLAINTEXT_REMAINS with names only', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env: 'SECRET=abc123', calls }), env: { T: 'x' } });
    const outcome = await connector.import!(ctxWith(), { nonTty: true, baseUrl: 'https://d', application: 'a', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const warning = outcome.warnings.find((w) => w.code === 'DOKPLOY_PLAINTEXT_REMAINS');
    expect(warning?.names).toEqual(['SECRET']);
    expect(JSON.stringify(outcome.warnings)).not.toContain('abc123');
  });
});

describe('dokploy import — deploy-target offer', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'capy-dokploy-import-'));

  afterEach(() => {
    if (existsSync(join(ROOT, '.capy'))) rmSync(join(ROOT, '.capy'), { recursive: true, force: true });
  });

  test('non-interactive: never asks, never saves', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({ fetch: fakeFetch({ env: 'A=1', calls }), env: { T: 'x' }, cwd: ROOT });
    const outcome = await connector.import!(ctxWith(), { nonTty: true, baseUrl: 'https://d', application: 'app_new', tokenEnv: 'T' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deployTargetSaved).toBe(false);
    expect(listTargets(ROOT)).toEqual([]);
  });

  test('interactive + yes: saves a target with the imported names', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls }),
      env: { T: 'x' },
      cwd: ROOT,
      confirm: async () => true,
      selectVars: async (c: readonly string[]) => c,
    });
    const outcome = await withTTY(() => connector.import!(ctxWith(), { nonTty: false, baseUrl: 'https://d', application: 'app_yes', tokenEnv: 'T' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deployTargetSaved).toBe(true);
    const targets = listTargets(ROOT);
    expect(targets.length).toBe(1);
    expect(targets[0].kind).toBe('dokploy');
    expect(targets[0].vars).toEqual(['A']);
    expect((targets[0].options as { applicationId: string }).applicationId).toBe('app_yes');
  });

  test('interactive + no: nothing saved', async () => {
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls }),
      env: { T: 'x' },
      cwd: ROOT,
      confirm: async () => false,
      selectVars: async (c: readonly string[]) => c,
    });
    const outcome = await withTTY(() => connector.import!(ctxWith(), { nonTty: false, baseUrl: 'https://d', application: 'app_no', tokenEnv: 'T' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deployTargetSaved).toBe(false);
    expect(listTargets(ROOT)).toEqual([]);
  });

  test('already has a target for this application: not offered again', async () => {
    upsertTarget(ROOT, DOKPLOY_TARGET({ options: { baseUrl: 'https://d', applicationId: 'app_existing', tokenEnv: 'T' } }));
    let confirmCalled = false;
    const calls: FakeCall[] = [];
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls }),
      env: { T: 'x' },
      cwd: ROOT,
      selectVars: async (c: readonly string[]) => c,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const outcome = await withTTY(() => connector.import!(ctxWith(), { nonTty: false, baseUrl: 'https://d', application: 'app_existing', tokenEnv: 'T' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deployTargetSaved).toBe(false);
    expect(confirmCalled).toBe(false);
  });

  test('nothing imported: never offered', async () => {
    const calls: FakeCall[] = [];
    let confirmCalled = false;
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: null, calls }),
      env: { T: 'x' },
      cwd: ROOT,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const outcome = await withTTY(() => connector.import!(ctxWith(), { nonTty: false, baseUrl: 'https://d', application: 'app_empty', tokenEnv: 'T' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.deployTargetSaved).toBe(false);
    expect(confirmCalled).toBe(false);
  });
});

// ── writeImportedAndSync (no-push path — mirrors writeAndSync's own shape) ──

describe('writeImportedAndSync', () => {
  test('no-push: attaches every entry\'s connector and writes the merged env locally', async () => {
    const writes: Array<{ env: Record<string, string>; keep: KeepFile }> = [];
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    const ctx = {
      pm: { readSyncState: () => null },
      fileManager: {
        writeKeepFile: (k: KeepFile) => writes.push({ env: {}, keep: k }),
        writeEncryptedEnvFile: (env: Record<string, string>) => writes.push({ env, keep }),
      },
      serviceClient: {
        pushSecrets: () => {
          throw new Error('must not push when opts.push is false');
        },
      },
      orgId: 'o',
      projectId: 'p',
      branch: 'development',
      userId: 'u',
      projectKey: 'k',
      keep,
      localPlaintext: { EXISTING: 'unchanged' },
    } as unknown as ResolvedContext;

    const entryA: ConnectorMetadata = {
      provider: 'dokploy',
      source: 'import',
      created_at: 1,
      fingerprint: 'a…a',
      application_id: 'app_1',
      imported_at: '2026-01-01T00:00:00.000Z',
    };
    await writeImportedAndSync(ctx, [{ varName: 'NEW_VAR', value: 'new-value', entry: entryA }], { push: false });

    const keepWrite = writes.find((w) => Object.keys(w.keep.variables).length > 0);
    expect(keepWrite?.keep.variables.NEW_VAR?.[0]?.connector?.provider).toBe('dokploy');
    const envWrite = writes.find((w) => Object.keys(w.env).length > 0);
    expect(envWrite?.env).toEqual({ EXISTING: 'unchanged', NEW_VAR: 'new-value' });
  });

  test('an empty entry list is a no-op', async () => {
    const ctx = { fileManager: { writeKeepFile: () => { throw new Error('should not be called'); } } } as unknown as ResolvedContext;
    await writeImportedAndSync(ctx, [], { push: false });
  });
});

// ── connectCommand JSON/terminal output: no secret value anywhere ───────────
//
// The previous version of this test asserted on a hand-built object mirroring
// what `executeImport` builds — it could only ever catch a leak in the
// TEST's own re-implementation, never a real one in the product code. These
// drive the actual `ConnectCommand.executeImport` path (the method
// `execute()` routes every import-kind connector through) with a sentinel
// value standing in for a real secret, spy on every console/stdio surface,
// and assert the sentinel is on none of them. `executeImport` is private —
// reached here the same way `execute()` reaches it, via bracket-notation on
// the instance, since there is no lighter public entry point that avoids a
// full `resolveContext()` (real auth, real keep.lock, real key resolution).

describe('connectCommand import output — no secret value on any output surface', () => {
  const SENTINEL = 'sentinel-super-secret-9f8e7d6c5b4a';

  function fakeImportModule(outcome: ImportOutcome): ConnectorModule {
    return {
      name: 'dokploy',
      description: 'test double',
      kind: 'import',
      connect: async () => {
        throw new Error('connect() must not be called for an import-kind connector');
      },
      rotate: async () => {
        throw new Error('rotate() must not be called for an import-kind connector');
      },
      import: async () => outcome,
    };
  }

  function fakeCtx(): ResolvedContext {
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    return {
      pm: { readSyncState: () => null },
      fileManager: {
        writeKeepFile: () => {},
        writeEncryptedEnvFile: () => {},
      },
      serviceClient: {
        pushSecrets: () => {
          throw new Error('must not push — every test here passes noPush: true');
        },
      },
      orgId: 'o',
      projectId: 'p',
      branch: 'development',
      userId: 'u',
      projectKey: 'k',
      keep,
      localPlaintext: {},
    } as unknown as ResolvedContext;
  }

  const successOutcome = (): ImportOutcome => ({
    ok: true,
    applicationId: 'app_1',
    imported: [
      {
        varName: 'API_KEY',
        value: SENTINEL,
        entry: { provider: 'dokploy', source: 'import', created_at: 1, fingerprint: 'x…y' } as ConnectorMetadata,
      },
    ],
    unchanged: [],
    skipped: [],
    warnings: [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: ['API_KEY'] }],
    deployTargetSaved: false,
  });

  /**
   * Spies `console.log`/`console.error` — the only two surfaces anything on
   * this path ever writes through (neither `executeImport` nor
   * `autoCommitKeep` calls `process.stdout`/`stderr.write` directly) — and
   * returns everything captured so far plus a restore fn.
   *
   * Deliberately does NOT also spy `process.stdout.write`/`process.stderr.write`:
   * doing so intercepts bun's OWN test-runner output too (it writes there
   * directly, bypassing `console.*`), which left this file exiting 1 despite
   * reporting 0 failures — caught by running it standalone and bisecting.
   */
  function captureAllOutput(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const record = (...a: unknown[]) => void chunks.push(a.map(String).join(' '));
    const logSpy = spyOn(console, 'log').mockImplementation(record as never);
    const errSpy = spyOn(console, 'error').mockImplementation(record as never);
    return {
      text: () => chunks.join('\n'),
      restore: () => {
        logSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  test('--json success: the sentinel never reaches any output surface', async () => {
    const command = new ConnectCommand(false);
    const cap = captureAllOutput();
    try {
      await (command as unknown as { executeImport: Function }).executeImport(
        fakeImportModule(successOutcome()),
        'dokploy',
        fakeCtx(),
        { json: true, noPush: true } as ConnectOpts,
      );
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SENTINEL);
  });

  test('terminal success: the sentinel never reaches any output surface', async () => {
    const command = new ConnectCommand(false);
    const cap = captureAllOutput();
    try {
      await (command as unknown as { executeImport: Function }).executeImport(
        fakeImportModule(successOutcome()),
        'dokploy',
        fakeCtx(),
        { noPush: true } as ConnectOpts,
      );
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SENTINEL);
  });

  test('a refusal path: no sentinel anywhere, and the refusal is still visible (the capture itself works)', async () => {
    const command = new ConnectCommand(false);
    const cap = captureAllOutput();
    const refusal: ImportOutcome = { ok: false, code: 'DOKPLOY_API_ERROR', message: 'Dokploy rejected the request.' };
    // A real refusal sets `process.exitCode = 1` (see `executeImport` in
    // connectCommand.ts) — correct for the CLI, but `process.exitCode` is a
    // process-wide global this test run does not own. Left set, it makes the
    // WHOLE `bun test` process exit 1 later even though every assertion here
    // passes — confirmed with a minimal repro (setting it back to `undefined`
    // is NOT enough for bun to treat the run as clean again; it has to be
    // reset to `0` explicitly). Save/restore it like any other host global
    // this suite touches (e.g. `process.env`).
    const savedExitCode = process.exitCode;
    try {
      await (command as unknown as { executeImport: Function }).executeImport(
        fakeImportModule(refusal),
        'dokploy',
        fakeCtx(),
        { json: true } as ConnectOpts,
      );
    } finally {
      cap.restore();
      process.exitCode = savedExitCode ?? 0;
    }
    expect(cap.text()).not.toContain(SENTINEL);
    // Proves the capture harness is not vacuously passing — it really did
    // observe what the command printed.
    expect(cap.text()).toContain('DOKPLOY_API_ERROR');
  });
});

// ── capy rotate refuses on a dokploy-managed var, before any network call ──
//
// Plain terminal (`web` unset, `nonTty: true`): `planAndRotate` skips its
// deploy-target setup step entirely on that combination (neither `web` nor
// `isTTY`, see rotateCommand.ts) and calls `rotateMany` directly, which is
// where CAP-662's refusal lives — the earliest point this fixture can reach
// it without also driving an unrelated interactive deploy-target wizard that
// `--web`'s equivalent path would open first (out of this brief's zone).
describe('capy rotate refuses on a dokploy-managed var', () => {
  const TEST_DIR = mkdtempSync(join(tmpdir(), 'capy-rotate-dokploy-'));
  const ORIGINAL_CWD = process.cwd();

  const dokployConnectorEntry: ConnectorMetadata = {
    provider: 'dokploy',
    source: 'import',
    created_at: 1700000000,
    fingerprint: 'a…z',
    application_id: 'app_1',
    imported_at: '2026-01-01T00:00:00.000Z',
  };

  function writeFixture() {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      variables: {
        IMPORTED_VAR: [
          { resource_id: 'r-1', branch: 'development', value_hash: 'h-1', connector: dokployConnectorEntry },
        ],
      },
    };
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
    mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.capy', 'branch'), 'development', 'utf-8');
  }

  beforeEach(() => {
    writeFixture();
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('refuses, exits non-zero, makes zero network calls', async () => {
    let exitCode: number | undefined;
    let out = '';
    const record = (...args: unknown[]) => {
      out += args.map(String).join(' ') + '\n';
    };
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(record as never);
    const errSpy = spyOn(console, 'error').mockImplementation(record as never);
    const fetchSpy = spyOn(globalThis, 'fetch');

    try {
      const { RotateCommand } = await import('../../src/commands/rotateCommand');
      await new RotateCommand(false)
        .execute('IMPORTED_VAR', { nonTty: true } as never)
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          if (!m.startsWith('__exit_')) throw err;
        });
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    // The terminal renders `error.message` (no raw code — see
    // `errorScreen.ts`'s `renderGeneric`), so this checks the one fragment
    // that is actually ours: "import-only". The decision itself is coded
    // (`ERROR_CODES.ROTATE_NOT_SUPPORTED_IMPORTED`, asserted structurally
    // above via `mapImportApiError`/`resolveDokploySettings` and by the
    // `mod.kind === 'import'` branch in rotateCommand.ts itself); this test's
    // job is the OUTCOME — refuses, exits 1, touches no network.
    expect(out).toContain('import-only');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);
});

// ── capy rotate's link-first picker excludes import connectors ─────────────
//
// A different bug from the one above: `IMPORTED_VAR` there was ALREADY
// dokploy-managed, so `rotateMany`'s precheck catches it. Here the variable
// has NO connector yet, so `capy rotate` routes it through
// `promoteAndConnect`'s "which integration owns this?" picker — and that
// picker used to offer `dokploy` too. Picking it ran a real import and only
// THEN refused with `ROTATE_NOT_SUPPORTED_IMPORTED`, after `connect.execute()`
// had already done its work. The fix excludes any connector whose module
// `kind === 'import'` from every one of the picker's three surfaces (browser,
// terminal, non-interactive `--provider`/auto-pick), keyed off `kind` — never
// off the string `'dokploy'` (cardinal Rule 4) — plus an explicit early
// refusal for a named import provider before `connect.execute()` (or any
// network call) ever runs.
//
// Real `listProviders`/`loadProvider` throughout (stripe, workos, dokploy):
// this is the actual registry a picker would show, not a stand-in for it.
describe("capy rotate's link-first picker excludes import connectors", () => {
  const TEST_DIR = mkdtempSync(join(tmpdir(), 'capy-rotate-promote-dokploy-'));
  const ORIGINAL_CWD = process.cwd();

  function writeFixture() {
    // Recreated on every test: the previous test's `afterEach` below removes
    // the whole directory, and this describe block (unlike the single-test
    // one above) runs more than one test against it.
    mkdirSync(TEST_DIR, { recursive: true });
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'demo',
      // No connector on this entry: unmanaged, so `capy rotate` has to ask
      // which integration owns it before it can rotate anything.
      variables: {
        UNMANAGED_VAR: [{ resource_id: 'r-1', branch: 'development', value_hash: 'h-1' }],
      },
    };
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep), 'utf-8');
    mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.capy', 'branch'), 'development', 'utf-8');
  }

  beforeEach(() => {
    writeFixture();
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("the picker's choices do not include dokploy (or any import connector)", async () => {
    // No `--provider`, non-interactive, and MORE than one linkable provider
    // remains (stripe, workos) — so `promoteAndConnect` refuses rather than
    // guessing, and names the candidates it actually offered. `dokploy` IS
    // registered (three providers exist), so its absence here is the filter
    // working, not a fixture that never included it.
    let out = '';
    const record = (...args: unknown[]) => {
      out += args.map(String).join(' ') + '\n';
    };
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(record as never);

    try {
      const { RotateCommand } = await import('../../src/commands/rotateCommand');
      await new RotateCommand(false)
        .execute('UNMANAGED_VAR', { nonTty: true } as never)
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          if (!m.startsWith('__exit_')) throw err;
        });
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(out).toContain('stripe');
    expect(out).toContain('workos');
    expect(out).not.toContain('dokploy');
  }, 30_000);

  test('an explicitly named import provider is refused before any network call', async () => {
    let exitCode: number | undefined;
    let out = '';
    const record = (...args: unknown[]) => {
      out += args.map(String).join(' ') + '\n';
    };
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(record as never);
    const errSpy = spyOn(console, 'error').mockImplementation(record as never);
    const fetchSpy = spyOn(globalThis, 'fetch');

    try {
      const { RotateCommand } = await import('../../src/commands/rotateCommand');
      await new RotateCommand(false)
        .execute('UNMANAGED_VAR', { nonTty: true, provider: 'dokploy' } as never)
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          if (!m.startsWith('__exit_')) throw err;
        });
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    // Same coded refusal as the already-managed case above — asserted here
    // via the one fragment that is actually ours ("import-only"), same as
    // that test. The point of THIS test is that it never reached the network:
    // no Dokploy `application.one` call, because the refusal happens before
    // `connect.execute()` (and its import) ever runs.
    expect(out).toContain('import-only');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);
});

// ── System store token resolution (CAP-664) ─────────────────────────────────
//
// `resolveDokployApiKey` sits in front of the plain env-var lookup every
// test above exercises. `DokployConnectorDeps.getConnectorSecret` defaults
// to a no-op (see the connector module's own doc), so every test above is
// unaffected — these tests cover the store path via explicit injection.

describe('dokploy import — system store token resolution', () => {
  test('a system-store entry is used when no tokenEnv resolves from env, before any Dokploy request', async () => {
    // A bun spy, not a variable of our own: `fetchMock.mock.calls` is bun's
    // own accumulator, read afterward rather than pushed into by us.
    const fetchMock = mock(async (_url: string, _init: { headers: Record<string, string> }) => ({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({ applicationId: 'app_1', env: null, buildArgs: null, buildSecrets: null, createEnvFile: true }),
    }));

    const getConnectorSecret = mock(async (name: string, opts: DokploySystemStoreCallOptions) => {
      expect(name).toBe('_CONNECTOR_DOKPLOY_API_KEY');
      expect(opts.orgId).toBe('org_test');
      return 'store-token';
    });
    const connector = createDokployConnector({ fetch: fetchMock as unknown as FetchLike, env: {}, getConnectorSecret });
    const outcome = await connector.import!(ctxWith({ orgId: 'org_test' }), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
      // No tokenEnv flag at all — the store is the only source.
    });
    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('store-token');
    expect(getConnectorSecret).toHaveBeenCalledTimes(1);
  });

  test('an explicit --token-env that IS set wins outright — the store is never called', async () => {
    const getConnectorSecret = mock(async () => 'store-token');
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: null, calls: [] }),
      env: { TOK: 'env-token' },
      getConnectorSecret,
    });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
      tokenEnv: 'TOK',
    });
    expect(outcome.ok).toBe(true);
    expect(getConnectorSecret).not.toHaveBeenCalled();
  });

  test('missing everywhere: zero Dokploy requests, coded refusal from the store', async () => {
    const getConnectorSecret = mock(async () => null);
    const connector = createDokployConnector({ fetch: unreachableFetch, env: {}, getConnectorSecret });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: string }).code).toBe('DOKPLOY_TOKEN_MISSING');
  });

  test('a non-admin store refusal with no env fallback: coded refusal, zero requests', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const connector = createDokployConnector({ fetch: unreachableFetch, env: {}, getConnectorSecret });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: string }).code).toBe('SYSTEM_STORE_ADMIN_ONLY');
  });

  test('a non-admin store refusal still falls back to the default env var when it is set', async () => {
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: null, calls: [] }),
      env: { DOKPLOY_API_KEY: 'legacy-value' },
      getConnectorSecret,
    });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
    });
    expect(outcome.ok).toBe(true);
  });

  test('a sentinel store value never appears in the --json outcome', async () => {
    const SENTINEL = 'sk_never_leak_this_9f3';
    const getConnectorSecret = mock(async () => SENTINEL);
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls: [] }),
      env: {},
      getConnectorSecret,
    });
    const outcome = await connector.import!(ctxWith(), {
      ...BASE_OPTS,
      baseUrl: 'https://d.example.com',
      application: 'app_1',
      json: true,
    });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  /**
   * Mirrors the REAL `getConnectorSecret`'s interactive-gated contract
   * (`system/systemStore.ts`): an existing entry returns with no prompt; a
   * missing one prompts (and saves) ONLY when `opts.interactive` is true.
   * `promptFn` is a bun spy — "zero prompt calls" is read off IT, never a
   * counter this file owns.
   */
  function fakeSystemStore(entry: string | null) {
    const promptFn = mock(async () => 'prompted-value');
    const getConnectorSecret = mock(async (_name: string, opts: { interactive: boolean }) => {
      if (entry !== null) return entry;
      if (!opts.interactive) return null;
      return promptFn();
    });
    return { getConnectorSecret, promptFn };
  }

  test('--web: a real TTY does not let the store prompt — refused, zero prompt calls', async () => {
    const { getConnectorSecret, promptFn } = fakeSystemStore(null);
    const connector = createDokployConnector({ fetch: unreachableFetch, env: {}, getConnectorSecret });
    const outcome = await withTTY(() =>
      connector.import!(ctxWith(), {
        ...BASE_OPTS,
        nonTty: false,
        web: true,
        baseUrl: 'https://d.example.com',
        application: 'app_1',
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(promptFn).not.toHaveBeenCalled();
  });

  test('--json: a real TTY does not let the store prompt — refused, zero prompt calls', async () => {
    const { getConnectorSecret, promptFn } = fakeSystemStore(null);
    const connector = createDokployConnector({ fetch: unreachableFetch, env: {}, getConnectorSecret });
    const outcome = await withTTY(() =>
      connector.import!(ctxWith(), {
        ...BASE_OPTS,
        nonTty: false,
        json: true,
        baseUrl: 'https://d.example.com',
        application: 'app_1',
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(promptFn).not.toHaveBeenCalled();
  });

  test('neither --web nor --json: a real TTY DOES let the store prompt (sanity check for the two tests above)', async () => {
    const { getConnectorSecret, promptFn } = fakeSystemStore(null);
    const connector = createDokployConnector({
      fetch: fakeFetch({ env: 'A=1', calls: [] }),
      env: {},
      getConnectorSecret,
      // Avoid REAL inquirer prompts (var selection, deploy-target offer)
      // under the faked TTY — irrelevant to what this test proves (the
      // SECRET prompt).
      selectVars: async (c: readonly string[]) => c,
      confirm: async () => false,
    });
    const outcome = await withTTY(() =>
      connector.import!(ctxWith(), {
        ...BASE_OPTS,
        nonTty: false,
        baseUrl: 'https://d.example.com',
        application: 'app_1',
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(promptFn).toHaveBeenCalledTimes(1);
  });
});
