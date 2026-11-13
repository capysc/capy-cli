/**
 * `capy connect vercel --team <slug|id>` with a token that may not read the
 * whole team list.
 *
 * A token scoped to one team (or below it) gets HTTP 403 from `GET /v2/teams`
 * while it can still read that team's project and its variables. A run that
 * names its team therefore looks that one team up (`GET /v2/teams/{idOrSlug}`)
 * and never lists every team; when Vercel refuses even the one team, the named
 * project is asked for under it and the team is the account that owns it.
 *
 * Covers: no team-list request when `--team` is given; the single-team lookup;
 * the project fallback by slug and by id; a genuine project denial still
 * reported as such; an unknown team; team discovery kept when no team is
 * named; and dry runs for both environments reaching the value reads with
 * readable values and placeholders reported apart.
 *
 * Every Vercel call goes through the scripted fake (GET only). No
 * `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { ConnectOpts, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';

// ── fixtures (every value is a fake sentinel) ───────────────────────────────

const V = {
  prodOnly: 'prod-only-SENT-11aa',
  shared: 'shared-SENT-22bb',
  previewOnly: 'preview-only-SENT-33cc',
  sensitive: 'sensitive-SENT-must-never-be-read',
} as const;

const env = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

const ENVS: ReadonlyArray<RawEnv> = [
  env({ id: 'env_1', key: 'PROD_ONLY', type: 'encrypted', listValue: 'opaque' }),
  env({ id: 'env_2', key: 'SHARED', type: 'encrypted', target: ['production', 'preview'], listValue: 'opaque' }),
  env({ id: 'env_3', key: 'PREVIEW_ONLY', type: 'encrypted', target: ['preview'], listValue: 'opaque' }),
  env({ id: 'env_4', key: 'SENS_PROD', type: 'sensitive' }),
  env({ id: 'env_5', key: 'SENS_PREVIEW', type: 'sensitive', target: ['preview'] }),
];

/** Two teams, so nothing is picked by "the token's only team"; a token that may not list them. */
const DATA: FakeVercelData = {
  teams: [
    { id: 'team_acme', slug: 'acme' },
    { id: 'team_beta', slug: 'beta' },
  ],
  teamsStatus: 403,
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: ENVS },
  values: { env_1: V.prodOnly, env_2: V.shared, env_3: V.previewOnly, env_4: V.sensitive, env_5: V.sensitive },
};

const BASE_OPTS: ConnectOpts = { nonTty: true, project: 'web', tokenEnv: 'T' };

function ctxWith(branch: string): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return { keep, branch, orgId: 'org_1', localPlaintext: {} } as unknown as ResolvedContext;
}

function makeConnector(data: FakeVercelData = DATA) {
  const fetchMock = mock(fakeVercelFetch(data));
  const connector = createVercelConnector({ fetch: fetchMock as unknown as VercelFetchLike, env: { T: 'tok_fake_value' }, sleep: async () => {} });
  return { connector, fetchMock };
}

const okOutcome = (o: ImportOutcome): Extract<ImportOutcome, { ok: true }> => {
  if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`);
  return o;
};

const paths = (fetchMock: Parameters<typeof callsOf>[0]): readonly string[] => callsOf(fetchMock).map((c) => new URL(c.url).pathname);

/** Every request after the team was settled: the project, its environments, its variables. */
const projectCalls = (fetchMock: Parameters<typeof callsOf>[0]) =>
  callsOf(fetchMock).filter((c) => new URL(c.url).pathname.startsWith('/v') && !new URL(c.url).pathname.startsWith('/v2/teams'));

// ── 1. a named team reaches the project without the team list ───────────────

describe('vercel import --team: one team, never the whole list', () => {
  test('a token that may not list teams: --team <slug> looks up that one team, and every project request is scoped to it', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'acme', dryRun: true }));
    expect(paths(fetchMock)).not.toContain('/v2/teams');
    expect(paths(fetchMock)[0]).toBe('/v2/teams/acme');
    expect(projectCalls(fetchMock).every((c) => new URL(c.url).searchParams.get('teamId') === 'team_acme')).toBe(true);
    expect(out.source).toMatchObject({ projectId: 'prj_web', teamId: 'team_acme', environment: 'production' });
  });

  test('--team <id> is looked up the same way', async () => {
    const { connector, fetchMock } = makeConnector();
    okOutcome(await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'team_acme', dryRun: true }));
    expect(paths(fetchMock)).not.toContain('/v2/teams');
    expect(paths(fetchMock)[0]).toBe('/v2/teams/team_acme');
  });

  test('Vercel refuses even the one team: the project is asked for under the slug, and the team is the account that owns it', async () => {
    const { connector, fetchMock } = makeConnector({ ...DATA, teamStatus: { acme: 403 } });
    const out = okOutcome(await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'acme', dryRun: true }));
    const bySlug = callsOf(fetchMock).find((c) => new URL(c.url).searchParams.get('slug') === 'acme');
    expect(bySlug && new URL(bySlug.url).pathname).toBe('/v9/projects/web');
    expect(bySlug && new URL(bySlug.url).searchParams.get('teamId')).toBeNull();
    expect(out.source).toMatchObject({ projectId: 'prj_web', teamId: 'team_acme' });
    expect(paths(fetchMock)).not.toContain('/v2/teams');
  });

  test('Vercel refuses the one team named by id: the project is asked for under that id', async () => {
    const { connector, fetchMock } = makeConnector({ ...DATA, teamStatus: { team_acme: 403 } });
    const out = okOutcome(await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'team_acme', dryRun: true }));
    expect(callsOf(fetchMock).some((c) => new URL(c.url).searchParams.get('slug') !== null)).toBe(false);
    expect(out.source).toMatchObject({ projectId: 'prj_web', teamId: 'team_acme' });
  });
});

// ── 2. genuine denials are still reported, and discovery is kept ────────────

describe('vercel import --team: real refusals, and team discovery when no team is named', () => {
  test('the project itself refuses the token: VERCEL_NO_ACCESS naming the project, not the team list', async () => {
    const { connector } = makeConnector({ ...DATA, teamStatus: { acme: 403 }, projectStatus: { web: 403 } });
    const out = await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'acme', dryRun: true });
    expect(out.ok).toBe(false);
    const failure = out as { code: string; message: string; link?: { url: string } };
    expect(failure.code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect(failure.message).toContain('project web');
    expect(failure.message).not.toContain('team list');
    expect(failure.link?.url).toBeTruthy();
  });

  test('the team can be read but the project refuses: the same project denial', async () => {
    const { connector } = makeConnector({ ...DATA, projectStatus: { web: 403 } });
    const out = await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'acme', dryRun: true });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect((out as { message: string }).message).toContain('project web');
  });

  test('an unknown team: VERCEL_TEAM_NOT_FOUND, and the team list is never read', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'nope', dryRun: true });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_TEAM_NOT_FOUND);
    expect(paths(fetchMock)).toEqual(['/v2/teams/nope']);
  });

  test('a project that is not in the named team (one team refused): VERCEL_PROJECT_NOT_FOUND naming both', async () => {
    const { connector } = makeConnector({ ...DATA, teamStatus: { beta: 403 } });
    const out = await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'beta', dryRun: true });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_PROJECT_NOT_FOUND);
    expect((out as { message: string }).message).toContain('web');
    expect((out as { message: string }).message).toContain('beta');
  });

  test('no --team: the team list is still how a team is picked, and its 403 is still reported', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = await connector.import!(ctxWith('production'), { ...BASE_OPTS, dryRun: true });
    expect((out as { code: string }).code).toBe(ERROR_CODES.VERCEL_NO_ACCESS);
    expect((out as { message: string }).message).toContain('team list');
    expect(paths(fetchMock)).toEqual(['/v2/teams']);
  });
});

// ── 3. both environments' dry runs reach the variable reads ─────────────────

describe('vercel import --team --dry-run, with a token that may not list teams', () => {
  const readsOf = (fetchMock: Parameters<typeof callsOf>[0]) =>
    paths(fetchMock).filter((p) => /^\/v1\/projects\/prj_web\/env\/[^/]+$/.test(p)).map((p) => p.split('/').pop());

  test('production: reads each readable value; readable values and placeholders are reported apart', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith('production'), { ...BASE_OPTS, team: 'acme', environment: 'production', dryRun: true }));
    expect(readsOf(fetchMock).toSorted()).toEqual(['env_1', 'env_2']);
    expect(Object.fromEntries(out.imported.map((i) => [i.varName, i.value]))).toEqual({ PROD_ONLY: V.prodOnly, SHARED: V.shared });
    expect((out.placeholders ?? []).map((p) => p.name)).toEqual(['SENS_PROD']);
    // A sensitive value is never asked for.
    expect(readsOf(fetchMock)).not.toContain('env_4');
  });

  test('preview: the same, for the preview records only', async () => {
    const { connector, fetchMock } = makeConnector();
    const out = okOutcome(await connector.import!(ctxWith('preview'), { ...BASE_OPTS, team: 'acme', environment: 'preview', dryRun: true }));
    expect(readsOf(fetchMock).toSorted()).toEqual(['env_2', 'env_3']);
    expect(Object.fromEntries(out.imported.map((i) => [i.varName, i.value]))).toEqual({ SHARED: V.shared, PREVIEW_ONLY: V.previewOnly });
    expect((out.placeholders ?? []).map((p) => p.name)).toEqual(['SENS_PREVIEW']);
    expect(readsOf(fetchMock)).not.toContain('env_5');
  });
});
