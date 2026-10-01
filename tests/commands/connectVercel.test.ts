/**
 * `capy connect vercel --project …` — the single-project import (CAP-696).
 *
 * Covers: token resolution before any request, team resolution (0/1/many),
 * the environment → Capy branch mapping (production/preview/development and a
 * custom environment's slug), one record targeting several environments, the
 * skip reasons (git-branch-scoped preview, sensitive, system, legacy secret,
 * empty value), conflicts / unchanged / `--var` / `--overwrite` / `--dry-run`,
 * the keep.lock connector metadata shape, the deploy-target offer, and — end
 * to end through the REAL `ConnectCommand.executeImport` + a REAL
 * `FileManager` — that the `.env` values equal the mocked Vercel values and
 * that no value appears on any output surface.
 *
 * Every Vercel call goes through a scripted fake that throws on any non-GET,
 * so "this connector never writes to Vercel" is proven by running it. No
 * `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVercelConnector, buildVercelConnectorEntry } from '../../src/commands/connectors/vercel';
import { listProviders, loadProvider } from '../../src/commands/connectors/registry';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { FileManager } from '../../src/files/fileManager';
import { listTargets, upsertTarget } from '../../src/deploy/config';
import { ERROR_CODES, type ConnectorMetadata, type KeepFile } from '../../src/types/index';
import type { ConnectOpts, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, withExitCodeRestored, withIsolatedGlobalDir, withTTY, withTempDir } from '../helpers/testSandbox';

// ── fixtures (every value is a fake sentinel) ───────────────────────────────

const V = {
  plainProd: 'plain-prod-SENT-1a2b',
  encAll: 'enc-all-SENT-3c4d',
  scoped: 'scoped-SENT-5e6f',
  prevAll: 'prev-all-SENT-7a8b',
  stage: 'stage-SENT-9c0d',
  sensitive: 'sensitive-SENT-must-never-be-read',
} as const;
const ALL_SENTINELS = Object.values(V);

const env = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

const ENVS: ReadonlyArray<RawEnv> = [
  env({ id: 'env_1', key: 'PLAIN_PROD', type: 'plain', listValue: V.plainProd }),
  env({ id: 'env_2', key: 'ENC_ALL', type: 'encrypted', target: ['production', 'preview', 'development'], listValue: 'opaque-ciphertext' }),
  env({ id: 'env_3', key: 'SENS', type: 'sensitive' }),
  env({ id: 'env_4', key: 'SYS', type: 'system' }),
  env({ id: 'env_5', key: 'OLD', type: 'secret' }),
  env({ id: 'env_6', key: 'SCOPED', type: 'encrypted', target: ['preview'], gitBranch: 'feature/x', listValue: 'opaque' }),
  env({ id: 'env_7', key: 'PREV_ALL', type: 'plain', target: ['preview'], listValue: V.prevAll }),
  env({ id: 'env_8', key: 'STAGE_ONLY', type: 'encrypted', target: [], customEnvironmentIds: ['env_c1'], configurationId: 'icfg_9', listValue: 'opaque' }),
  env({ id: 'env_9', key: 'EMPTY_ENC', type: 'encrypted', listValue: 'opaque' }),
];

const DATA: FakeVercelData = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: ENVS },
  custom: { prj_web: [{ id: 'env_c1', slug: 'staging' }] },
  // env_9 has NO value: Vercel returned none although the type is readable.
  values: { env_2: V.encAll, env_6: V.scoped, env_8: V.stage, env_3: V.sensitive },
};

const BASE_OPTS: ConnectOpts = { nonTty: true, project: 'web', tokenEnv: 'T' };

function ctxWith(over: Partial<ResolvedContext> & { localPlaintext?: Record<string, string> } = {}): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return { keep, branch: 'production', orgId: 'org_1', localPlaintext: {}, ...over } as unknown as ResolvedContext;
}

function makeConnector(data: FakeVercelData = DATA, extra: Partial<Parameters<typeof createVercelConnector>[0]> = {}) {
  const fetchMock = mock(fakeVercelFetch(data));
  const connector = createVercelConnector({ fetch: fetchMock as unknown as VercelFetchLike, env: { T: 'tok_fake_value' }, sleep: async () => {}, ...extra });
  return { connector, fetchMock };
}

const okOutcome = (o: ImportOutcome): Extract<ImportOutcome, { ok: true }> => {
  if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`);
  return o;
};

const valuesByName = (o: Extract<ImportOutcome, { ok: true }>): Record<string, string> =>
  Object.fromEntries(o.imported.map((i) => [i.varName, i.value]));

// ── tokens, zero requests, read-only ────────────────────────────────────────

describe('vercel import — token and request shape', () => {
  test('no token anywhere: VERCEL_TOKEN_MISSING and ZERO Vercel requests', async () => {
    const { connector, fetchMock } = makeConnector(DATA, { env: {} });
    const out = await connector.import!(ctxWith(), BASE_OPTS);
    expect(out.ok).toBe(false);
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_TOKEN_MISSING);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test('the token resolves from the org system store entry, with no prompt under --json', async () => {
    const getConnectorSecret = mock(async (_n: string, _o: { interactive: boolean }) => 'tok_from_store');
    const { connector, fetchMock } = makeConnector(DATA, { env: {}, getConnectorSecret });
    const out = await connector.import!(ctxWith(), { ...BASE_OPTS, tokenEnv: undefined, json: true });
    expect(out.ok).toBe(true);
    expect(getConnectorSecret.mock.calls[0][0]).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(getConnectorSecret.mock.calls[0][1].interactive).toBe(false);
    expect(callsOf(fetchMock)[0].authorization).toBe('Bearer tok_from_store');
  });

  test('a run only ever GETs, with the bearer token, and the token is never in a URL', async () => {
    const { connector, fetchMock } = makeConnector();
    okOutcome(await connector.import!(ctxWith(), BASE_OPTS));
    const calls = callsOf(fetchMock);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.authorization === 'Bearer tok_fake_value')).toBe(true);
    expect(calls.some((c) => c.url.includes('tok_fake_value'))).toBe(false);
  });

  test('401 → VERCEL_AUTH_FAILED; an unknown project → VERCEL_PROJECT_NOT_FOUND', async () => {
    const unauthorized: VercelFetchLike = async () => ({ status: 401, ok: false, text: async () => '{}' });
    const a = createVercelConnector({ fetch: unauthorized, env: { T: 'x' }, sleep: async () => {} });
    expect(((await a.import!(ctxWith(), BASE_OPTS)) as { code: string }).code).toBe(ERROR_CODES.VERCEL_AUTH_FAILED);

    const { connector } = makeConnector();
    const missing = await connector.import!(ctxWith(), { ...BASE_OPTS, project: 'nope' });
    expect((missing as { code: string }).code).toBe(ERROR_CODES.VERCEL_PROJECT_NOT_FOUND);
  });

  test('no --project, non-interactive: VERCEL_PROJECT_REQUIRED, and the project is never asked for', async () => {
    const { connector } = makeConnector();
    const out = await connector.import!(ctxWith(), { nonTty: true, tokenEnv: 'T' });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_PROJECT_REQUIRED);
  });
});

// ── teams ───────────────────────────────────────────────────────────────────

describe('vercel import — team resolution', () => {
  test('one team: used automatically, every project request is scoped to it', async () => {
    const { connector, fetchMock } = makeConnector();
    okOutcome(await connector.import!(ctxWith(), BASE_OPTS));
    const scoped = callsOf(fetchMock).filter((c) => !c.url.includes('/v2/teams'));
    expect(scoped.every((c) => new URL(c.url).searchParams.get('teamId') === 'team_acme')).toBe(true);
  });

  test('no teams: the personal account — no teamId on any request, and no team_id recorded', async () => {
    const { connector, fetchMock } = makeConnector({ ...DATA, teams: [], projects: { personal: [project('prj_web', 'web')] } });
    const out = okOutcome(await connector.import!(ctxWith(), BASE_OPTS));
    expect(callsOf(fetchMock).every((c) => new URL(c.url).searchParams.get('teamId') === null)).toBe(true);
    expect(out.imported[0].entry.team_id).toBeUndefined();
  });

  test('several teams, non-interactive, no --team: VERCEL_TEAM_REQUIRED listing slugs; nothing but the team list was requested', async () => {
    const { connector, fetchMock } = makeConnector({ ...DATA, teams: [{ id: 'team_acme', slug: 'acme' }, { id: 'team_beta', slug: 'beta' }] });
    const out = await connector.import!(ctxWith(), BASE_OPTS);
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_TEAM_REQUIRED);
    expect((out as { message: string }).message).toContain('acme');
    expect((out as { message: string }).message).toContain('beta');
    expect(callsOf(fetchMock).map((c) => new URL(c.url).pathname)).toEqual(['/v2/teams']);
  });

  test('several teams + --team <slug>: that team; --team nope: VERCEL_TEAM_NOT_FOUND', async () => {
    const data = { ...DATA, teams: [{ id: 'team_beta', slug: 'beta' }, { id: 'team_acme', slug: 'acme' }] };
    const { connector } = makeConnector(data);
    okOutcome(await connector.import!(ctxWith(), { ...BASE_OPTS, team: 'acme' }));
    const bad = await connector.import!(ctxWith(), { ...BASE_OPTS, team: 'nope' });
    expect((bad as { code: string }).code).toBe(ERROR_CODES.VERCEL_TEAM_NOT_FOUND);
  });

  test('several teams, interactive: asks which team', async () => {
    const pickTeam = mock(async () => 'team_acme');
    const { connector } = makeConnector({ ...DATA, teams: [{ id: 'team_beta', slug: 'beta' }, { id: 'team_acme', slug: 'acme' }] }, { pickTeam, selectVars: async (c) => c, confirm: async () => false });
    const out = await withTTY(() => connector.import!(ctxWith(), { ...BASE_OPTS, nonTty: false }));
    okOutcome(out);
    expect(pickTeam.mock.calls.length).toBe(1);
  });
});

// ── environment → branch, and what is skipped ──────────────────────────────

describe('vercel import — environment mapping and skips', () => {
  test('production (the current branch): plain from the list, encrypted from the per-id route; values equal Vercel\'s', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'production' }), BASE_OPTS));
    expect(valuesByName(out)).toEqual({ PLAIN_PROD: V.plainProd, ENC_ALL: V.encAll });
    // the sensitive value is NEVER requested, whatever the fake would answer
    expect(callsOf(fetchMock).some((c) => c.url.includes('/env/env_3'))).toBe(false);
    // plain needs no per-id request
    expect(callsOf(fetchMock).some((c) => c.url.includes('/env/env_1'))).toBe(false);
  });

  test('skipped names carry stable reasons: sensitive, system, legacy secret, empty value', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'production' }), BASE_OPTS));
    expect(Object.fromEntries(out.skipped.map((s) => [s.name, s.code]))).toEqual({
      SENS: 'sensitive_unreadable',
      SYS: 'vercel_system',
      OLD: 'legacy_secret_unreadable',
      EMPTY_ENC: 'empty_value',
    });
    expect(out.imported.map((i) => i.varName)).not.toContain('EMPTY_ENC');
  });

  test('preview: the git-branch-scoped record is NOT imported — skipped with its name and branch; the unscoped one is', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'preview' }), BASE_OPTS));
    expect(valuesByName(out)).toEqual({ ENC_ALL: V.encAll, PREV_ALL: V.prevAll });
    expect(out.skipped).toEqual([{ name: 'SCOPED', code: 'git_branch_scoped', gitBranch: 'feature/x' }]);
  });

  test('one record targeting production, preview and development counts in each', async () => {
    const { connector } = makeConnector();
    const results = await Promise.all(['production', 'preview', 'development'].map((b) => connector.import!(ctxWith({ branch: b }), BASE_OPTS)));
    expect(results.map((r) => okOutcome(r).imported.some((i) => i.varName === 'ENC_ALL' && i.value === V.encAll))).toEqual([true, true, true]);
  });

  test('a custom environment maps to its slug: --environment staging reads the record that names env_c1', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'development' }), { ...BASE_OPTS, environment: 'staging' }));
    expect(valuesByName(out)).toEqual({ STAGE_ONLY: V.stage });
    expect(out.imported[0].entry.environment).toBe('staging');
    expect(out.source).toEqual({ kind: 'vercel', projectId: 'prj_web', projectName: 'web', teamId: 'team_acme', environment: 'staging' });
  });

  test('a branch named like a custom environment picks it without --environment', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'staging' }), BASE_OPTS));
    expect(Object.keys(valuesByName(out))).toEqual(['STAGE_ONLY']);
  });

  test('current branch matches no environment and no --environment: VERCEL_ENVIRONMENT_REQUIRED', async () => {
    const { connector } = makeConnector();
    const out = await connector.import!(ctxWith({ branch: 'main' }), BASE_OPTS);
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_REQUIRED);
  });

  test('--environment that does not exist: VERCEL_ENVIRONMENT_NOT_FOUND, listing what does', async () => {
    const { connector } = makeConnector();
    const out = await connector.import!(ctxWith(), { ...BASE_OPTS, environment: 'qa' });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND);
    expect((out as { message: string }).message).toContain('staging');
  });

  test('--environment overrides the branch name: main branch, development environment', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'main' }), { ...BASE_OPTS, environment: 'development' }));
    expect(Object.keys(valuesByName(out))).toEqual(['ENC_ALL']);
  });

  test('a list that says there is a next page it cannot fetch is flagged, never imported as if complete', async () => {
    const { connector } = makeConnector({ ...DATA, envListNext: 123 });
    const out = okOutcome(await connector.import!(ctxWith(), BASE_OPTS));
    expect(out.warnings.map((w) => w.code)).toContain('VERCEL_ENV_LIST_TRUNCATED');
  });
});

// ── conflicts, --var, --overwrite, --dry-run ───────────────────────────────

describe('vercel import — conflicts, --var, --overwrite, --dry-run', () => {
  test('same local value: unchanged (and its metadata is refreshed); a different local value: kept, skipped IMPORT_CONFLICT_SKIPPED', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ localPlaintext: { PLAIN_PROD: V.plainProd, ENC_ALL: 'different-local' } }), BASE_OPTS));
    expect(out.unchanged).toEqual(['PLAIN_PROD']);
    expect(out.unchangedEntries?.map((e) => e.varName)).toEqual(['PLAIN_PROD']);
    expect(out.imported.map((i) => i.varName)).toEqual([]);
    expect(out.skipped.filter((s) => s.code === 'IMPORT_CONFLICT_SKIPPED').map((s) => s.name)).toEqual(['ENC_ALL']);
  });

  test('--var restricts the import, and the unrelated records are not even fetched', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith(), { ...BASE_OPTS, var: 'PLAIN_PROD' }));
    expect(Object.keys(valuesByName(out))).toEqual(['PLAIN_PROD']);
    expect(callsOf(fetchMock).some((c) => c.url.includes('/env/env_2'))).toBe(false);
    expect(out.skipped).toEqual([]);
  });

  test('--dry-run: no prompt, conflicts reported as wouldAsk, no unchangedEntries, no deploy target', async () => {
    const confirm = mock(async () => true);
    const { connector } = makeConnector(DATA, { confirm });
    const out = okOutcome(await connector.import!(ctxWith({ localPlaintext: { ENC_ALL: 'different-local' } }), { ...BASE_OPTS, dryRun: true }));
    expect(out.wouldAsk).toEqual(['ENC_ALL']);
    expect(out.unchangedEntries).toEqual([]);
    expect(out.deployTargetSaved).toBe(false);
    expect(confirm.mock.calls.length).toBe(0);
  });

  test('--overwrite non-interactive without --yes: VERCEL_CONFIRMATION_REQUIRED, nothing computed to write', async () => {
    const { connector } = makeConnector();
    const out = await connector.import!(ctxWith({ localPlaintext: { LOCAL_ONLY: 'x' } }), { ...BASE_OPTS, overwrite: true });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_CONFIRMATION_REQUIRED);
  });

  test('--overwrite --yes: clears local-only names, replaces differing ones, imports new ones — and never clears a name Vercel has but will not show', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(
      await connector.import!(
        ctxWith({ localPlaintext: { LOCAL_ONLY: 'x', PLAIN_PROD: 'old', SENS: 'keep-me-sensitive-in-vercel', EMPTY_ENC: 'keep-me-too' } }),
        { ...BASE_OPTS, overwrite: true, yes: true },
      ),
    );
    expect(out.cleared).toEqual(['LOCAL_ONLY']);
    expect(out.replacedNames).toEqual(['PLAIN_PROD']);
    expect(valuesByName(out)).toEqual({ PLAIN_PROD: V.plainProd, ENC_ALL: V.encAll });
  });

  test('--overwrite --dry-run needs no --yes and plans without writing', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ localPlaintext: { LOCAL_ONLY: 'x' } }), { ...BASE_OPTS, overwrite: true, dryRun: true }));
    expect(out.cleared).toEqual(['LOCAL_ONLY']);
  });

  test('--overwrite interactive: declining the confirmation writes nothing', async () => {
    const { connector } = makeConnector(DATA, { confirm: async () => false });
    const out = okOutcome(await withTTY(() => connector.import!(ctxWith({ localPlaintext: { LOCAL_ONLY: 'x' } }), { ...BASE_OPTS, nonTty: false, overwrite: true })));
    expect(out.imported).toEqual([]);
    expect(out.cleared).toEqual([]);
  });
});

// ── keep.lock connector metadata ────────────────────────────────────────────

describe('vercel import — keep.lock connector metadata', () => {
  test('each imported entry records provider, source, project, team, environment, env id, time and fingerprint', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'production' }), { ...BASE_OPTS, var: 'ENC_ALL' }));
    const entry = out.imported[0].entry as ConnectorMetadata;
    expect(entry).toMatchObject({
      provider: 'vercel',
      source: 'import',
      vercel_project_id: 'prj_web',
      vercel_project: 'web',
      team_id: 'team_acme',
      environment: 'production',
      env_id: 'env_2',
      fingerprint: `${V.encAll.slice(0, 3)}…${V.encAll.slice(-3)}`,
    });
    expect(typeof entry.imported_at).toBe('string');
    expect(typeof entry.created_at).toBe('number');
    expect(entry.configuration_id).toBeUndefined();
    // the entry never carries the value itself
    expect(JSON.stringify(entry)).not.toContain(V.encAll);
  });

  test('configuration_id is recorded when Vercel set one', async () => {
    const { connector } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith({ branch: 'staging' }), BASE_OPTS));
    expect(out.imported[0].entry.configuration_id).toBe('icfg_9');
  });

  test('buildVercelConnectorEntry is additive: no team_id for a personal project', () => {
    const entry = buildVercelConnectorEntry(
      { id: 'e', key: 'K', type: 'plain', targets: ['production'], customEnvironmentIds: [] },
      'a-long-enough-value',
      { project: { id: 'prj', name: 'p' }, environment: 'production', createdAtSec: 1, importedAt: '2026-01-01T00:00:00.000Z' },
    );
    expect('team_id' in entry).toBe(false);
  });
});

// ── deploy-target offer ─────────────────────────────────────────────────────

describe('vercel import — deploy-target offer (interactive only, like Dokploy)', () => {
  const interactiveDeps = (confirm: () => Promise<boolean>) => ({ confirm, selectVars: async (c: readonly string[]) => c });
  const importAt = (dir: string, branch: string, over: Partial<ConnectOpts> = {}, deps = interactiveDeps(async () => true)) =>
    withTTY(() => makeConnector(DATA, { ...deps, cwd: dir }).connector.import!(ctxWith({ branch }), { ...BASE_OPTS, nonTty: false, ...over }));

  test('production, interactive + yes: saves vercel-production with the imported names, CI mode, the project\'s production branch, no gitBranch', async () => {
    await withTempDir('capy-vercel-target', async (dir) => {
      const out = okOutcome(await importAt(dir, 'production'));
      expect(out.deployTargetSaved).toBe(true);
      const targets = listTargets(dir);
      expect(targets.length).toBe(1);
      expect(targets[0]).toEqual({
        name: 'vercel-production',
        kind: 'vercel',
        branch: 'production',
        vars: ['PLAIN_PROD', 'ENC_ALL'],
        mode: 'ci',
        gitBaseBranch: 'main',
        options: { projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' },
      });
      expect('gitBranch' in (targets[0].options as object)).toBe(false);
    });
  });

  test('preview: no gitBaseBranch; custom environment: customEnvironmentId is recorded', async () => {
    await withTempDir('capy-vercel-target-preview', async (dir) => {
      okOutcome(await importAt(dir, 'preview'));
      okOutcome(await importAt(dir, 'staging'));
      const byName = Object.fromEntries(listTargets(dir).map((t) => [t.name, t]));
      expect(byName['vercel-preview'].gitBaseBranch).toBeUndefined();
      expect(byName['vercel-preview'].vars).toEqual(['ENC_ALL', 'PREV_ALL']);
      expect(byName['vercel-staging'].options).toEqual({ projectDir: '.', vercelEnv: 'staging', projectId: 'prj_web', teamId: 'team_acme', customEnvironmentId: 'env_c1' });
    });
  });

  test('interactive + no: nothing saved', async () => {
    await withTempDir('capy-vercel-target-no', async (dir) => {
      const out = okOutcome(await importAt(dir, 'production', {}, interactiveDeps(async () => false)));
      expect(out.deployTargetSaved).toBe(false);
      expect(listTargets(dir)).toEqual([]);
    });
  });

  test('non-interactive, --json and --dry-run: never asked, never saved', async () => {
    await withTempDir('capy-vercel-target-quiet', async (dir) => {
      const confirm = mock(async () => true);
      const { connector } = makeConnector(DATA, { confirm, cwd: dir });
      okOutcome(await connector.import!(ctxWith(), BASE_OPTS));
      okOutcome(await withTTY(() => connector.import!(ctxWith(), { ...BASE_OPTS, nonTty: false, json: true })));
      okOutcome(await withTTY(() => connector.import!(ctxWith(), { ...BASE_OPTS, nonTty: false, dryRun: true })));
      expect(confirm.mock.calls.length).toBe(0);
      expect(listTargets(dir)).toEqual([]);
    });
  });

  test('already has a target for this project + environment: not offered again', async () => {
    await withTempDir('capy-vercel-target-existing', async (dir) => {
      upsertTarget(dir, { name: 'mine', kind: 'vercel', branch: 'production', vars: [], options: { projectId: 'prj_web', vercelEnv: 'production' } });
      const confirm = mock(async () => true);
      const out = okOutcome(await importAt(dir, 'production', {}, interactiveDeps(confirm)));
      expect(out.deployTargetSaved).toBe(false);
      expect(confirm.mock.calls.length).toBe(0);
    });
  });

  test('nothing imported: never offered', async () => {
    await withTempDir('capy-vercel-target-empty', async (dir) => {
      const confirm = mock(async () => true);
      const empty = { ...DATA, envs: { prj_web: [] } };
      const out = okOutcome(await withTTY(() => makeConnector(empty, { ...interactiveDeps(confirm), cwd: dir }).connector.import!(ctxWith(), { ...BASE_OPTS, nonTty: false })));
      expect(out.imported).toEqual([]);
      expect(confirm.mock.calls.length).toBe(0);
    });
  });
});

// ── end to end: real FileManager, real executeImport, no value on any surface ─

describe('vercel import — end to end through ConnectCommand.executeImport', () => {
  const PROJECT_KEY = 'vercel-e2e-project-key-0123456789';

  const realCtx = (dir: string, branch: string): ResolvedContext => {
    const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
    return {
      pm: { readSyncState: () => null },
      fileManager: new FileManager(dir),
      serviceClient: {
        pushSecrets: () => {
          throw new Error('must not push — these runs pass noPush');
        },
      },
      orgId: 'org_1',
      projectId: 'p',
      branch,
      userId: 'u',
      projectKey: PROJECT_KEY,
      keep,
      localPlaintext: {},
    } as unknown as ResolvedContext;
  };

  test('--json: stdout is ONE JSON object, the .env holds the mocked Vercel values (decrypt-verified), and no value is printed anywhere', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-e2e', async (dir) => {
          const { connector } = makeConnector();
          const ctx = realCtx(dir, 'production');
          const { stdout, stderr } = await captureConsole(() =>
            new ConnectCommand(false)['executeImport'](connector, 'vercel', ctx, { ...BASE_OPTS, json: true, noPush: true }),
          );

          expect(stdout.length).toBe(1);
          const parsed = JSON.parse(stdout[0]);
          expect(parsed).toMatchObject({
            ok: true,
            provider: 'vercel',
            dryRun: false,
            imported: ['PLAIN_PROD', 'ENC_ALL'],
            source: { kind: 'vercel', projectId: 'prj_web', environment: 'production' },
          });
          expect(parsed.skipped).toContainEqual({ name: 'SENS', code: 'sensitive_unreadable' });

          // the property: decrypting what landed on disk gives Vercel's values
          const decrypted = new FileManager(dir).readEncryptedEnvFile(PROJECT_KEY);
          expect(decrypted).toEqual({ PLAIN_PROD: V.plainProd, ENC_ALL: V.encAll });
          expect(readFileSync(join(dir, '.env'), 'utf-8')).toMatch(/ENC_ALL=capy:/);

          const everything = [...stdout, ...stderr].join('\n') + readFileSync(join(dir, '.env'), 'utf-8');
          ALL_SENTINELS.forEach((s) => expect(everything).not.toContain(s));
        }),
      ),
    );
  });

  test('--dry-run --json: pure JSON, nothing written to disk, no value anywhere', async () => {
    await withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-e2e-dry', async (dir) => {
          const { connector } = makeConnector();
          const { stdout, stderr } = await captureConsole(() =>
            new ConnectCommand(false)['executeImport'](connector, 'vercel', realCtx(dir, 'production'), { ...BASE_OPTS, json: true, dryRun: true }),
          );
          expect(stdout.length).toBe(1);
          expect(JSON.parse(stdout[0])).toMatchObject({ ok: true, dryRun: true, imported: ['PLAIN_PROD', 'ENC_ALL'], pushed: false });
          expect(existsSync(join(dir, '.env'))).toBe(false);
          ALL_SENTINELS.forEach((s) => expect([...stdout, ...stderr].join('\n')).not.toContain(s));
        }),
      ),
    );
  });

  test('the human output names Vercel, never Dokploy, and prints no value', async () => {
    await withIsolatedGlobalDir(() =>
      withTempDir('capy-vercel-e2e-human', async (dir) => {
        const { connector } = makeConnector();
        const { stdout } = await captureConsole(() =>
          new ConnectCommand(false)['executeImport'](connector, 'vercel', realCtx(dir, 'production'), { ...BASE_OPTS, noPush: true }),
        );
        const text = stdout.join('\n');
        expect(text).toContain('from Vercel');
        expect(text).not.toContain('Dokploy');
        ALL_SENTINELS.forEach((s) => expect(text).not.toContain(s));
      }),
    );
  });

  test('a coded refusal under --json is one JSON object with the code', async () => {
    await withExitCodeRestored(async () => {
      const { connector } = makeConnector(DATA, { env: {} });
      const { stdout } = await captureConsole(() =>
        new ConnectCommand(false)['executeImport'](connector, 'vercel', ctxWith(), { ...BASE_OPTS, json: true }),
      );
      expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_MISSING });
    });
  });
});

// ── registration ────────────────────────────────────────────────────────────

describe('vercel is a registered import connector', () => {
  test('listed beside the others, loadable, import-kind, with discover and its own discovery report', async () => {
    expect(listProviders().map((p) => p.name)).toEqual(['stripe', 'workos', 'dokploy', 'vercel']);
    const mod = await loadProvider('vercel');
    expect(mod.name).toBe('vercel');
    expect(mod.kind).toBe('import');
    expect(typeof mod.import).toBe('function');
    expect(typeof mod.discover).toBe('function');
    expect(typeof mod.reportDiscovery).toBe('function');
  });
});
