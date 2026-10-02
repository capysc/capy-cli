/**
 * `capy deploy`'s Vercel target setup (API mode, modeled on Dokploy's one
 * question): the link/name question, the live check, the name-back, the
 * environment questions, and exactly what gets saved.
 *
 * Drives `resolveVercelSetup` with injected questions (`deps.prompt`), an
 * in-memory Vercel (`fakeVercelFetch`: GET only — a stray write fails the test)
 * and an injected token source. No `mock.module()`: this file runs in the
 * normal batch. The real system store is covered in
 * `vercelSetupTokenStore.test.ts`.
 */
import { describe, test, expect, mock } from 'bun:test';
import { parseVercelProjectInput, resolveVercelSetup, type SetupPrompt, type VercelSetupDeps } from '../../src/deploy/vercelSetup';
import { ERROR_CODES } from '../../src/types/index';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { callsOf, fakeVercelFetch, project, type FakeVercelData } from '../helpers/fakeVercel';
import { captureConsole } from '../helpers/testSandbox';

const TOKEN = 'vcp_FAKE_SETUP_TOKEN_9f3';
const PAGE = 'https://vercel.com/account/settings/tokens';
const CREATE = `Create a token at ${PAGE}. Set Scope to the team that owns the project`;

const ONE_TEAM: FakeVercelData = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')], personal: [project('prj_mine', 'mine')] },
  envs: {},
  custom: { prj_web: [{ id: 'c_stage', slug: 'staging' }] },
};

const TWO_TEAMS: FakeVercelData = {
  ...ONE_TEAM,
  teams: [{ id: 'team_acme', slug: 'acme' }, { id: 'team_beta', slug: 'beta' }],
  projects: { team_acme: [project('prj_web', 'web')], team_beta: [project('prj_other', 'web')] },
};

type Script = Readonly<Record<string, ReadonlyArray<unknown>>>;

/**
 * A scripted asker: the Nth time a question named `X` is asked it answers
 * `script.X[N]`. The count is read off the mock's own call record.
 */
function scripted(script: Script) {
  const prompt = mock(async (questions: ReadonlyArray<Record<string, unknown>>) => {
    const name = String(questions[0].name);
    const askedBefore = prompt.mock.calls.filter(([qs]) => String(qs[0].name) === name).length - 1;
    const answers = script[name] ?? [];
    if (askedBefore >= answers.length) throw new Error(`unscripted question: ${name} (#${askedBefore + 1})`);
    return { [name]: answers[askedBefore] };
  });
  const questionsNamed = (name: string) => prompt.mock.calls.map(([qs]) => qs[0]).filter((q) => q.name === name);
  return { prompt: prompt as unknown as SetupPrompt, questionsNamed, count: (name: string) => questionsNamed(name).length };
}

const withToken = (data: FakeVercelData, over: Partial<VercelSetupDeps> = {}) => {
  const fetchMock = mock(fakeVercelFetch(data));
  const getSecret = mock(async (_name: string, _opts: unknown) => TOKEN as string | null);
  const deps: VercelSetupDeps = { fetch: fetchMock as unknown as VercelFetchLike, env: {}, getSecret: getSecret as never, ...over };
  return { deps, fetchMock, getSecret };
};

const run = (existing: Record<string, string>, script: Script, deps: VercelSetupDeps, flags = {}) => {
  const asker = scripted(script);
  return captureConsole(() => resolveVercelSetup(existing, 'org_1', flags, { ...deps, prompt: asker.prompt })).then((out) => ({ ...out, asker }));
};

const text = (o: { stdout: readonly string[]; stderr: readonly string[] }) => [...o.stdout, ...o.stderr].join('\n');

describe('parseVercelProjectInput — a dashboard link or a name, nothing else', () => {
  test.each([
    ['https://vercel.com/acme/web', 'acme', 'web'],
    ['https://vercel.com/acme/web/', 'acme', 'web'],
    ['https://vercel.com/acme/web/settings/environment-variables', 'acme', 'web'],
    ['https://vercel.com/acme/web?tab=x#frag', 'acme', 'web'],
    ['https://www.vercel.com/acme/web', 'acme', 'web'],
    ['vercel.com/acme/web', 'acme', 'web'],
    ['  https://vercel.com/acme/web  ', 'acme', 'web'],
  ])('%s → team %s, project %s', (answer, team, name) => {
    expect(parseVercelProjectInput(answer)).toEqual({ ok: true, input: { kind: 'link', team, project: name } });
  });

  test.each([['web'], ['my-app.v2'], ['prj_AbC123']])('a bare name or id: %s', (answer) => {
    expect(parseVercelProjectInput(answer)).toEqual({ ok: true, input: { kind: 'name', project: answer } });
  });

  test.each([
    ['http://vercel.com/acme/web'],
    ['https://example.com/acme/web'],
    ['https://vercel.com/acme'],
    ['https://vercel.com/'],
    ['https://vercel.com/account/settings/tokens'],
    ['https://vercel.com/new/acme'],
    ['acme/web'],
    ['has a space'],
  ])('refused with the coded VERCEL_URL_INVALID: %s', (answer) => {
    const r = parseVercelProjectInput(answer);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(ERROR_CODES.VERCEL_URL_INVALID);
  });
});

describe('resolveVercelSetup — the questions, in order', () => {
  test('a dashboard link, a token, a live check, a yes, an environment: asks exactly these, with the approved wording', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(out.asker.prompt.mock.calls.map(([qs]) => qs[0].name)).toEqual(['projectUrl', 'confirmed', 'vercelEnv']);
    expect(out.asker.questionsNamed('projectUrl')[0].message).toBe('Vercel project URL (paste the dashboard link for this project, or its name):');
    expect(out.asker.questionsNamed('confirmed')[0].message).toBe('Use "web" (acme) as this target?');
  });

  test('saved options are exactly the verified project: projectDir ".", the environment, the project ID and the team ID', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(out.result).toEqual({
      options: { projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' },
      productionBranch: 'main',
    });
  });

  test('it reads only: the teams, then the one project in its team, then custom environments — GET only, the token as the bearer, never anywhere else', async () => {
    const { deps, fetchMock } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    const calls = callsOf(fetchMock);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      'GET /v2/teams?limit=100',
      'GET /v9/projects/web?teamId=team_acme',
      'GET /v9/projects/prj_web/custom-environments?teamId=team_acme',
    ]);
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(text(out)).not.toContain(TOKEN);
  });

  test('a bare name with ONE team: no team question; that team is used and named back', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['preview'], gitBranch: [''] }, deps);
    expect(out.asker.count('picked')).toBe(0);
    expect(out.asker.questionsNamed('confirmed')[0].message).toBe('Use "web" (acme) as this target?');
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'preview', projectId: 'prj_web', teamId: 'team_acme' });
  });

  test('a bare name with SEVERAL teams: asks which, lists every team, and looks the project up in the chosen one', async () => {
    const { deps, fetchMock } = withToken(TWO_TEAMS);
    const out = await run({}, { projectUrl: ['web'], picked: ['team_beta'], confirmed: [true], vercelEnv: ['production'] }, deps);
    const teamQuestion = out.asker.questionsNamed('picked')[0];
    expect((teamQuestion.choices as ReadonlyArray<{ name: string; value: string }>).map((c) => c.name)).toEqual(['acme', 'beta']);
    expect(callsOf(fetchMock).some((c) => c.url.includes('/v9/projects/web?teamId=team_beta'))).toBe(true);
    expect(out.result.options).toMatchObject({ projectId: 'prj_other', teamId: 'team_beta' });
    expect(out.asker.questionsNamed('confirmed')[0].message).toBe('Use "web" (beta) as this target?');
  });

  test('a link names its team, so several teams are never asked about', async () => {
    const { deps } = withToken(TWO_TEAMS);
    const out = await run({}, { projectUrl: ['https://vercel.com/beta/web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(out.asker.count('picked')).toBe(0);
    expect(out.result.options).toMatchObject({ projectId: 'prj_other', teamId: 'team_beta' });
  });

  test('a personal-account project (the link\'s slug is no team): looked up with no team, saved with no teamId, named back without a team', async () => {
    const { deps } = withToken({ ...ONE_TEAM, teams: [] });
    const out = await run({}, { projectUrl: ['https://vercel.com/me/mine'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'prj_mine' });
    expect(out.asker.questionsNamed('confirmed')[0].message).toBe('Use "mine" as this target?');
  });
});

describe('resolveVercelSetup — refusals and re-asks', () => {
  test('a project Vercel does not know: coded VERCEL_PROJECT_NOT_FOUND on stderr, the question is asked again, nothing is saved from the miss', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run(
      {},
      { projectUrl: ['https://vercel.com/acme/ghost', 'https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['production'] },
      deps,
    );
    expect(out.stderr.join('\n')).toContain(ERROR_CODES.VERCEL_PROJECT_NOT_FOUND);
    expect(out.asker.count('projectUrl')).toBe(2);
    expect(out.asker.count('confirmed')).toBe(1);
    expect(out.result.options).toMatchObject({ projectId: 'prj_web' });
  });

  test('"no" at "Use … as this target?" asks the first question again', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run(
      {},
      { projectUrl: ['https://vercel.com/acme/web', 'https://vercel.com/acme/web'], confirmed: [false, true], vercelEnv: ['production'] },
      deps,
    );
    expect(out.asker.count('projectUrl')).toBe(2);
    expect(out.asker.count('vercelEnv')).toBe(1);
  });

  test('something that is not a project link: coded VERCEL_URL_INVALID on stderr, asked again, no request made for it', async () => {
    const { deps, fetchMock } = withToken(ONE_TEAM);
    const out = await run(
      {},
      { projectUrl: ['https://example.com/x/y', 'web'], confirmed: [true], vercelEnv: ['production'] },
      deps,
    );
    expect(out.stderr.join('\n')).toContain(ERROR_CODES.VERCEL_URL_INVALID);
    expect(out.asker.count('projectUrl')).toBe(2);
    expect(callsOf(fetchMock).every((c) => !c.url.includes('example.com'))).toBe(true);
  });

  test('no token: says so, shows the approved instructions (with the link\'s team), saves what was typed — and sends zero requests', async () => {
    const { deps, fetchMock } = withToken(ONE_TEAM, { getSecret: (async () => null) as never });
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], vercelEnv: ['production'] }, deps);
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(text(out)).toContain('Could not verify against Vercel yet (no token) — saving as entered.');
    expect(out.stderr.join('\n')).toContain(`${CREATE} (acme).`);
    expect(out.stderr.join('\n')).toContain('Then save it: capy system set _TARGET_VERCEL_TOKEN');
    expect(out.asker.count('confirmed')).toBe(0);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'web', teamSlug: 'acme' });
  });

  test('no token and a bare name: the instructions name no team; the project is saved by name alone', async () => {
    const { deps } = withToken(ONE_TEAM, { getSecret: (async () => null) as never });
    const out = await run({}, { projectUrl: ['web'], vercelEnv: ['production'] }, deps);
    expect(out.stderr.join('\n')).toContain(`${CREATE}.`);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'web' });
  });

  test('the store refusing (not an admin, …): its own code is shown, saved as entered', async () => {
    const refusing = async () => {
      throw Object.assign(new Error('x'), { code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
    };
    const { deps } = withToken(ONE_TEAM, { getSecret: refusing as never });
    const out = await run({}, { projectUrl: ['web'], vercelEnv: ['production'] }, deps);
    expect(text(out)).toContain(`(${ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY})`);
    expect(out.result.options).toMatchObject({ projectId: 'web' });
  });

  test('a token Vercel rejects (401): the code is shown with the instructions, saved as entered', async () => {
    const unauthorized: VercelFetchLike = async () => ({ status: 401, ok: false, text: async () => '{}' });
    const { deps } = withToken(ONE_TEAM, { fetch: unauthorized });
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], vercelEnv: ['production'] }, deps);
    expect(text(out)).toContain(`(${ERROR_CODES.VERCEL_AUTH_FAILED})`);
    expect(out.stderr.join('\n')).toContain(`${CREATE} (acme).`);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'web', teamSlug: 'acme' });
    expect(text(out)).not.toContain(TOKEN);
  });

  test('any other API problem (500) after the team is known: shown with its code, saved as entered with the team ID', async () => {
    const real = fakeVercelFetch(ONE_TEAM);
    const failing: VercelFetchLike = async (url, init) =>
      new URL(url).pathname.startsWith('/v9/projects') ? { status: 500, ok: false, text: async () => '{}' } : real(url, init);
    const { deps } = withToken(ONE_TEAM, { fetch: failing });
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], vercelEnv: ['production'] }, deps);
    expect(text(out)).toContain(`(${ERROR_CODES.VERCEL_API_ERROR})`);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'web', teamId: 'team_acme' });
  });
});

describe('resolveVercelSetup — environments', () => {
  test('lists production, preview, development and the project\'s custom environments; a custom one saves its ID', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['staging'] }, deps);
    const choices = out.asker.questionsNamed('vercelEnv')[0].choices as ReadonlyArray<{ value: string }>;
    expect(choices.map((c) => c.value)).toEqual(['production', 'preview', 'development', 'staging']);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'staging', projectId: 'prj_web', teamId: 'team_acme', customEnvironmentId: 'c_stage' });
    expect(out.asker.count('gitBranch')).toBe(0);
  });

  test('preview asks for an optional git branch: a branch is saved as gitBranch', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['preview'], gitBranch: ['develop'] }, deps);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'preview', projectId: 'prj_web', teamId: 'team_acme', gitBranch: 'develop' });
    expect(out.asker.questionsNamed('gitBranch')[0].message).toBe('Git branch for Preview (leave blank for all preview branches):');
  });

  test('preview left blank means every preview branch: no gitBranch key at all', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['preview'], gitBranch: [''] }, deps);
    expect(Object.keys(out.result.options)).not.toContain('gitBranch');
  });

  test('production and development never ask for a branch', async () => {
    const { deps } = withToken(ONE_TEAM);
    const prod = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    const dev = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['development'] }, deps);
    expect(prod.asker.count('gitBranch') + dev.asker.count('gitBranch')).toBe(0);
    expect(dev.result.options).toMatchObject({ vercelEnv: 'development' });
  });

  test('custom environments that cannot be listed: shown with the code, the standard ones are still offered', async () => {
    const real = fakeVercelFetch(ONE_TEAM);
    const failing: VercelFetchLike = async (url, init) =>
      new URL(url).pathname.endsWith('/custom-environments') ? { status: 500, ok: false, text: async () => '{}' } : real(url, init);
    const { deps } = withToken(ONE_TEAM, { fetch: failing });
    const out = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(text(out)).toContain(ERROR_CODES.VERCEL_API_ERROR);
    expect((out.asker.questionsNamed('vercelEnv')[0].choices as ReadonlyArray<{ value: string }>).map((c) => c.value)).toEqual(['production', 'preview', 'development']);
  });

  test('the project\'s production branch comes back for the PR base default (absent when Vercel has no git link)', async () => {
    const { deps } = withToken(ONE_TEAM);
    const withLink = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(withLink.result.productionBranch).toBe('main');
    const noLink = withToken({ ...ONE_TEAM, projects: { team_acme: [project('prj_web', 'web', { link: null })] } });
    const without = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, noLink.deps);
    expect(without.result.productionBranch).toBeUndefined();
  });
});

describe('resolveVercelSetup — re-editing a saved target', () => {
  test('the question is prefilled with the saved project; the environment and branch defaults are the saved ones', async () => {
    const { deps } = withToken(ONE_TEAM);
    const existing = { projectDir: 'web', vercelEnv: 'preview', gitBranch: 'develop' };
    const legacy = await run(existing, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['preview'], gitBranch: ['develop'] }, deps);
    expect(legacy.asker.questionsNamed('vercelEnv')[0].default).toBe('preview');
    expect(legacy.asker.questionsNamed('gitBranch')[0].default).toBe('develop');

    const api = await run({ projectId: 'prj_web', teamId: 'team_acme', vercelEnv: 'production' }, { projectUrl: ['prj_web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(api.asker.questionsNamed('projectUrl')[0].default).toBe('prj_web');
    expect(api.asker.questionsNamed('vercelEnv')[0].default).toBe('production');
  });

  test('a legacy target (no projectId) goes through this same setup and comes out in API mode with the legacy keys gone', async () => {
    const { deps } = withToken(ONE_TEAM);
    const out = await run({ projectDir: 'web', vercelEnv: 'preview', gitBranch: 'develop' }, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(out.result.options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' });
  });
});

describe('resolveVercelSetup — the token', () => {
  test('is asked for as _TARGET_VERCEL_TOKEN through the store, interactively, naming the link\'s team for the prompt', async () => {
    const { deps, getSecret } = withToken(ONE_TEAM);
    await run({}, { projectUrl: ['https://vercel.com/acme/web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(getSecret.mock.calls.length).toBe(1);
    const [name, opts] = getSecret.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('_TARGET_VERCEL_TOKEN');
    expect(opts).toMatchObject({ interactive: true, orgId: 'org_1', helpTeam: 'acme' });
  });

  test('a dry run only reads: the store is never allowed to ask or save', async () => {
    const { deps, getSecret } = withToken(ONE_TEAM);
    await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps, { readOnly: true });
    expect(getSecret.mock.calls[0][1]).toMatchObject({ interactive: false });
  });

  test('$VERCEL_TOKEN is the last resort when the store has nothing', async () => {
    const { deps, fetchMock } = withToken(ONE_TEAM, { getSecret: (async () => null) as never, env: { VERCEL_TOKEN: 'vcp_FROM_ENV' } });
    const out = await run({}, { projectUrl: ['web'], confirmed: [true], vercelEnv: ['production'] }, deps);
    expect(callsOf(fetchMock)[0].authorization).toBe('Bearer vcp_FROM_ENV');
    expect(text(out)).not.toContain('vcp_FROM_ENV');
  });
});
