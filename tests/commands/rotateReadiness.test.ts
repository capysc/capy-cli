import { describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateRepositoryContext, inspectRotateReadiness, inspectRotateDeployment, readRotateDeploymentTargets, inspectRotateCapy, inspectRotateWorkOS, wranglerCanInspectWithoutRefresh, type CapyProbeDependencies, type WorkOSProbeDependencies, type RotateReadinessProbes } from '../../src/commands/rotateReadiness';

import { TEAM_ENVIRONMENTS_QUERY } from '../../src/commands/connectors/workos';

const good = { code: 'READY', ready: true, detail: 'Ready' } as const;
const probes: RotateReadinessProbes = {
  repository: async () => good,
  capy: async () => [good],
  workos: async () => [good],
  deployment: async () => ({ checks: [good], choices: [] }),
};
describe('rotate prerequisites before a browser exists', () => {
  test('all applicable probes must succeed; unavailable auth is actionable', async () => {
    const result = await inspectRotateReadiness({ ...probes, workos: async () => [{
      code: 'ROTATE_WORKOS_AUTH_REQUIRED', ready: false, detail: 'Sign in', remedy: 'workos auth login',
    }] });
    expect(result.ready).toBe(false);
    expect(result.checks.find(check => !check.ready)?.remedy).toBe('workos auth login');
    expect(await inspectRotateReadiness(probes)).toMatchObject({ ready: true, command: 'rotate' });
  });
  test('missing repository never tries account custody', async () => {
    const result = await inspectRotateReadiness({ ...probes,
      repository: async () => ({ ...good, ready: false }),
      capy: async () => { throw new Error('must not inspect project custody without project'); },
    });
    expect(result.ready).toBe(false);
  });
  test('local-only rotation does not probe any deployment tool', async () => {
    expect(await inspectRotateDeployment({ noPush: true, cwd: '/not/a/project' })).toEqual({ checks: [], choices: [] });
  });
  test('rotate and sync without deployment configuration never probes deployment tools', async () => {
    const command = mock(() => { throw new Error('must not probe an unrequested deployment'); });
    expect(await inspectRotateDeployment({ cwd: '/not/a/project' }, { command })).toEqual({ checks: [], choices: [] });
    expect(command).not.toHaveBeenCalled();
  });
  test('deployment discovery leaves gitignore and filesystem unchanged and requires selection', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rotate-readiness-'));
    try {
      mkdirSync(join(cwd, '.capy'));
      writeFileSync(join(cwd, '.gitignore'), '.capy/\n');
      const targets = Object.fromEntries(['a', 'b'].map(name => [name, {
        name, kind: 'vercel', branch: 'development', vars: ['KEY'], options: {},
      }]));
      writeFileSync(join(cwd, '.capy', 'deploy.json'), JSON.stringify({ version: '1', targets }));
      expect(readRotateDeploymentTargets(cwd)).toHaveLength(2);
      expect(await inspectRotateDeployment({ cwd })).toMatchObject({
        checks: [{ code: 'ROTATE_DEPLOYMENT_SELECTION_REQUIRED', ready: false }],
        choices: [{ name: 'a', kind: 'vercel' }, { name: 'b', kind: 'vercel' }],
      });
      expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toBe('.capy/\n');
      expect(readdirSync(join(cwd, '.capy'))).toEqual(['deploy.json']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

const now = 1_800_000_000_000;
const capyContext = { orgId: 'org_1', projectId: 'project_1', branch: 'development', userHint: 'user_1' };
const capySession = { user_id: 'user_1', sessions: { org_1: { access_token: 'synthetic-capy-token', expires_at: now + 120_000 } } };
const capyProbes = (): CapyProbeDependencies => ({
  loadSession: () => capySession,
  assertAuthority: () => undefined,
  fetch: async () => new Response(JSON.stringify({ branches: [{ name: 'development' }] })),
  verifyCustody: async () => undefined,
  now: () => now,
});

describe('concrete Capy readiness probe', () => {
  test('caller mismatch refuses before authority, network or custody inspection', async () => {
    const unused = () => { throw new Error('must not inspect a different account'); };
    const result = await inspectRotateCapy(capyContext, { expectedUserId: 'another_user' }, {
      ...capyProbes(), assertAuthority: unused, fetch: unused, verifyCustody: unused,
    });
    expect(result).toMatchObject([{ code: 'ROTATE_CAPY_IDENTITY_MISMATCH', ready: false }]);
  });
  test('matching caller requires authenticated branch access and checks custody with the selected identity', async () => {
    const request = mock(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ branches: [{ name: 'development' }] })));
    const custody = mock(async (_org: string, _user: string, _token: string, _api: string) => undefined);
    const result = await inspectRotateCapy(capyContext, { expectedUserId: 'user_1' }, { ...capyProbes(), fetch: request, verifyCustody: custody });
    expect(result.every(row => row.ready)).toBe(true);
    expect(String(request.mock.calls[0][0])).toEndWith('/projects/project_1/branches');
    expect(request.mock.calls[0][1]?.headers).toEqual({ authorization: 'Bearer synthetic-capy-token' });
    expect(custody.mock.calls[0].slice(0, 3)).toEqual(['org_1', 'user_1', 'synthetic-capy-token']);
    expect(JSON.stringify(result)).not.toContain('synthetic-capy-token');
  });
  test('expired session never reaches network; wrong branch never reaches custody', async () => {
    const network = mock(async () => new Response('{}'));
    expect(await inspectRotateCapy(capyContext, {}, { ...capyProbes(), loadSession: () => ({ ...capySession, sessions: { org_1: { ...capySession.sessions.org_1, expires_at: now } } }), fetch: network })).toMatchObject([{ code: 'ROTATE_CAPY_AUTH', ready: false }]);
    expect(network).not.toHaveBeenCalled();
    const custody = mock(async () => undefined);
    expect(await inspectRotateCapy(capyContext, {}, { ...capyProbes(), fetch: async () => new Response(JSON.stringify({ branches: [{ name: 'other' }] })), verifyCustody: custody })).toMatchObject([{ code: 'ROTATE_CAPY_ACCESS', ready: false }]);
    expect(custody).not.toHaveBeenCalled();
  });
});

const workosProbes = (): WorkOSProbeDependencies => ({
  command: () => ({ status: 0, stdout: 'version' }),
  credentials: () => ({ accessToken: 'synthetic-workos-token', expiresAt: now + 120_000, refreshToken: 'never-consumed' }),
  post: async () => ({ data: { currentTeam: { projectsV2: [] } } }),
  now: () => now,
});
describe('concrete WorkOS account probe', () => {
  test('reuses the verified teamProjectsV2 document and does not expose account payloads', async () => {
    const post = mock(async (_url: string, _token: string, _body: Readonly<Record<string, unknown>>) => ({ data: { currentTeam: { projectsV2: [] } } }));
    const result = await inspectRotateWorkOS('/synthetic', { ...workosProbes(), post });
    expect(post.mock.calls[0]).toEqual(['https://api.workos.com/graphql', 'synthetic-workos-token', { operationName: 'teamProjectsV2', query: TEAM_ENVIRONMENTS_QUERY }]);
    expect(result).toMatchObject([{ code: 'ROTATE_WORKOS_AUTH', ready: true }]);
    expect(JSON.stringify(result)).not.toContain('synthetic-workos-token');
  });
  test('expired token refuses without refreshing, querying or logging in', async () => {
    const command = mock(() => ({ status: 0, stdout: 'version' }));
    const post = mock(async () => ({}));
    expect(await inspectRotateWorkOS('/synthetic', { ...workosProbes(), command, post, credentials: () => ({ accessToken: 'expired', expiresAt: now }) })).toMatchObject([{ code: 'ROTATE_WORKOS_AUTH_REQUIRED', ready: false }]);
    expect(command).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  test.each([{ data: { currentTeam: null } }, { data: { currentTeam: { id: 'unverified-old-shape' } } }, { errors: [{ extensions: { code: 'FORBIDDEN' } }] }])('rejects missing or refused authoritative account response %p', async (response) => {
    expect(await inspectRotateWorkOS('/synthetic', { ...workosProbes(), post: async () => response })).toMatchObject([{ code: 'ROTATE_WORKOS_AUTH', ready: false }]);
  });
});

const withTarget = async (target: Readonly<{ kind: string; mode?: 'direct' | 'ci' }>, run: (cwd: string) => Promise<void>): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), 'rotate-target-probe-'));
  try {
    mkdirSync(join(cwd, '.capy'));
    writeFileSync(join(cwd, '.capy', 'deploy.json'), JSON.stringify({ version: '1', targets: { target: { name: 'target', branch: 'development', vars: ['KEY'], options: {}, ...target } } }));
    await run(cwd);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
};
describe('concrete deployment probes', () => {
  test('Wrangler exit zero with loggedOut or non-JSON output never means authenticated', async () => {
    for (const stdout of ['You are not authenticated.', JSON.stringify({ loggedIn: false }), '{}']) {
      await withTarget({ kind: 'cf-worker', mode: 'direct' }, async cwd => {
        const command = mock((_binary: string, _args: readonly string[], _cwd: string) => ({ status: 0, stdout }));
        const result = await inspectRotateDeployment({ cwd }, { command, wranglerFresh: () => true });
        expect(result.checks.find(row => row.code === 'ROTATE_DEPLOYMENT_AUTH')?.ready).toBe(false);
        expect(command.mock.calls[1][1]).toEqual(['whoami', '--json']);
      });
    }
  });
  test('Wrangler fresh OAuth JSON succeeds, but unproven freshness never launches whoami', async () => {
    await withTarget({ kind: 'cf-pages', mode: 'direct' }, async cwd => {
      const command = mock(() => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [] }) }));
      expect((await inspectRotateDeployment({ cwd }, { command, wranglerFresh: () => true })).checks.every(row => row.ready)).toBe(true);
      const versionOnly = mock(() => ({ status: 0, stdout: 'version' }));
      expect((await inspectRotateDeployment({ cwd }, { command: versionOnly, wranglerFresh: () => false })).checks).toMatchObject([{ ready: true }, { code: 'ROTATE_DEPLOYMENT_AUTH_INSPECTION_UNAVAILABLE', ready: false }]);
      expect(versionOnly).toHaveBeenCalledTimes(1);
    });
  });
  test('dev skips a saved direct target but still checks CI target and GitHub', async () => {
    await withTarget({ kind: 'cf-worker', mode: 'direct' }, async cwd => {
      expect(await inspectRotateDeployment({ cwd, devMode: true }, { command: () => { throw new Error('dev cannot probe skipped direct deployment'); } })).toMatchObject({ checks: [] });
    });
    await withTarget({ kind: 'vercel', mode: 'ci' }, async cwd => {
      const command = mock((_binary: string, _args: readonly string[], _cwd: string) => ({ status: 0, stdout: 'synthetic-user' }));
      expect((await inspectRotateDeployment({ cwd, devMode: true }, { command })).checks.every(row => row.ready)).toBe(true);
      expect(command.mock.calls.map(([binary, args]) => [binary, args])).toEqual([['vercel', ['--version']], ['vercel', ['whoami']], ['gh', ['auth', 'status']]]);
    });
  });
  test('unknown target or unsupported adapter refuses without probing', async () => {
    await withTarget({ kind: 'fly' }, async cwd => {
      const command = mock(() => { throw new Error('unsupported provider must not run'); });
      expect((await inspectRotateDeployment({ cwd }, { command })).checks[0].code).toBe('ROTATE_DEPLOYMENT_UNSUPPORTED');
      expect((await inspectRotateDeployment({ cwd, deployTarget: 'missing' }, { command })).checks[0].code).toBe('ROTATE_DEPLOYMENT_TARGET_UNKNOWN');
      expect(command).not.toHaveBeenCalled();
    });
  });
});

describe('Wrangler readonly freshness metadata', () => {
  test('uses current legacy/XDG storage precedence, refuses stale/unreadable expiry, and leaves files unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'rotate-wrangler-metadata-'));
    try {
      const xdg = join(home, 'xdg');
      mkdirSync(join(xdg, '.wrangler', 'config'), { recursive: true });
      const fresh = `oauth_token = "synthetic-never-sent"\nexpiration_time = "${new Date(now + 120_000).toISOString()}"\n`;
      writeFileSync(join(xdg, '.wrangler', 'config', 'default.toml'), fresh);
      const opts = { home, platform: 'linux' as const, environment: { XDG_CONFIG_HOME: xdg }, now };
      expect(wranglerCanInspectWithoutRefresh(opts)).toBe(true);
      mkdirSync(join(home, '.wrangler', 'config'), { recursive: true });
      const legacyPath = join(home, '.wrangler', 'config', 'default.toml');
      const stale = `expiration_time = "${new Date(now).toISOString()}"\n`;
      writeFileSync(legacyPath, stale);
      expect(wranglerCanInspectWithoutRefresh(opts)).toBe(false);
      expect(readFileSync(legacyPath, 'utf8')).toBe(stale);
      writeFileSync(legacyPath, fresh);
      expect(wranglerCanInspectWithoutRefresh(opts)).toBe(true);
      writeFileSync(join(home, '.wrangler', 'config', 'default.enc'), 'opaque-synthetic-ciphertext');
      expect(wranglerCanInspectWithoutRefresh(opts)).toBe(false);
      rmSync(join(home, '.wrangler', 'config', 'default.enc'));
      writeFileSync(legacyPath, 'expiration_time = "not-a-date"');
      expect(wranglerCanInspectWithoutRefresh(opts)).toBe(false);
      expect(wranglerCanInspectWithoutRefresh({ ...opts, environment: { CLOUDFLARE_API_TOKEN: 'synthetic-env-token' } })).toBe(true);
      expect(readdirSync(join(xdg, '.wrangler', 'config'))).toEqual(['default.toml']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});


describe('rotation repository attribution without a local manifest', () => {
  const sync = { last_sync: '2026-09-14', synced_variables: ['WORKOS_API_KEY'], user_id: 'user_1',
    org_id: 'org_1', project_id: 'project_1', project_name: 'default', sync_mode: 'free' as const,
    keep_hash: { development: 'remote-hash' } };
  test('completed free sync supplies attribution without keep.lock', () => {
    expect(rotateRepositoryContext(null, sync, 'development')).toEqual(capyContext);
  });
  test('incomplete or non-free metadata cannot substitute for a manifest', () => {
    expect(rotateRepositoryContext(null, { ...sync, keep_hash: undefined }, 'development')).toBeNull();
    expect(rotateRepositoryContext(null, { ...sync, sync_mode: 'paid' }, 'development')).toBeNull();
    expect(rotateRepositoryContext(null, sync, 'other')).toBeNull();
    expect(rotateRepositoryContext(null, null, 'development')).toBeNull();
  });
  test('existing manifest attribution retains precedence', () => {
    expect(rotateRepositoryContext({ version: '3.0', org_id: 'paid_org', project_id: 'paid_project',
      project_name: 'paid', variables: {} }, sync, 'feature')).toEqual({
      orgId: 'paid_org', projectId: 'paid_project', branch: 'feature', userHint: 'user_1',
    });
  });
});
