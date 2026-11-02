/**
 * CAP-679: `capy deploy` refuses when the active `.env` branch disagrees
 * with the saved target's own branch — deploy reads `.env` but files the
 * result under `target.branch`. Also covers the `--no-deploy` flag's
 * presence on both `deploy` and `deploy targets-remove` help text.
 *
 * Uses the same spawned-CLI style as `deployCommand.test.ts`.
 *
 * Hermetic: every spawned CLI runs under a throwaway HOME that holds a fake
 * cached session (so `authenticate()` returns `cached` and NEVER starts the
 * loopback OAuth login on 127.0.0.1:19420-19424) and a profile pointing the
 * service at a closed loopback port (so every service call is refused
 * locally, in milliseconds, instead of reaching api.capy.sc). The paths that
 * used to "fail downstream at auth" now fail at that refused service call —
 * the branch-check assertions below never depended on which.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { withHarness, ORG_ID, PROJECT_ID, type Harness } from '../helpers/pipedHarness';
import { hashValue } from '../../src/sync/compareSecrets';

const CLI = join(__dirname, '../../dist/index.js');
const ROOT = join(tmpdir(), `capy-deploy-branch-${process.pid}-${Date.now()}`);

/** Port 9 (discard) on loopback — nothing listens there, so connections are refused at once. */
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:9';

/** Far enough ahead that the cached token never counts as expired. */
const FAKE_SESSION_EXPIRES_AT = Date.UTC(2100, 0, 1);

/** A CLI run that outlives this has hung — kill it rather than stall the suite. */
const CLI_TIMEOUT_MS = 30_000;

function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'capy-deploy-branch-home-'));
  mkdirSync(join(home, '.capy', 'auth'), { recursive: true });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: UNREACHABLE_SERVICE_URL } } }),
  );
  writeFileSync(
    join(home, '.capy', 'auth', 'session.json'),
    JSON.stringify({
      version: 2,
      user_id: 'user-test',
      user_email: 'deploy-branch-test@example.com',
      refresh_token: 'fake-refresh-token',
      organizations: [{ id: 'org-test', workos_org_id: 'org_workos_test', name: 'test' }],
      // `e30` is base64url for `{}` — a JWT-shaped token with no org_id claim.
      sessions: { 'org-test': { access_token: 'fake.e30.token', expires_at: FAKE_SESSION_EXPIRES_AT } },
    }),
  );
  return home;
}

const FAKE_HOME = makeFakeHome();

// The deploy target reads its token from DOKPLOY_API_KEY; a developer's own
// value must never reach these runs.
const { DOKPLOY_API_KEY: _ignoredDokployKey, ...inheritedEnv } = process.env;
const CLI_ENV = { ...inheritedEnv, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, CAPY_WEB_NO_OPEN: '1' };

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

function capy(args: string[], cwd: string = ROOT): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    env: CLI_ENV,
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function writeKeep(dir: string, branches: string[] = ['development', 'production']): void {
  const variables = Object.fromEntries(
    ['DATABASE_URL'].map((v) => [
      v,
      branches.map((b) => ({ resource_id: 'rid' + b[0], branch: b, value_hash: 'hhh' })),
    ]),
  );
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables }, null, 2),
  );
}

function writeDeployConfig(cwd: string, targets: any[]): void {
  mkdirSync(join(cwd, '.capy'), { recursive: true });
  const obj = { version: '1', targets: Object.fromEntries(targets.map((t) => [t.name, t])) };
  writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify(obj, null, 2));
}

const dokployTarget = (branch: string) => ({
  name: 'dokploy-target',
  kind: 'dokploy',
  branch,
  vars: ['DATABASE_URL'],
  options: { baseUrl: 'https://dokploy.example.com', applicationId: 'app_1', tokenEnv: 'DOKPLOY_API_KEY' },
});

/**
 * A project in `h` that bare `capy` (the first step of every `capy deploy`) finds in sync: `keep.lock` pins the hash of
 * every value, and `.env` holds those values. The branch checks below are `deploy`'s own, behind that first step.
 */
function syncedProject(h: Harness, opts: { header?: string; branches?: string[]; branchFile?: string | null }): void {
  const branches = opts.branches ?? ['development', 'production'];
  const variables = {
    DATABASE_URL: branches.map((b) => ({ resource_id: 'rid' + b[0], branch: b, value_hash: hashValue('x') })),
  };
  writeFileSync(join(h.project, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'test', variables }, null, 2));
  writeDeployConfig(h.project, [dokployTarget('production')]);
  writeFileSync(join(h.project, '.env'), `${opts.header === undefined ? '' : `${opts.header}\n`}DATABASE_URL=x\n`);
  if (opts.branchFile === null) rmSync(join(h.project, '.capy', 'branch'), { force: true });
  else if (opts.branchFile !== undefined) writeFileSync(join(h.project, '.capy', 'branch'), opts.branchFile);
}

describe('capy deploy — branch check (CAP-679)', () => {
  test('active branch (.env header) differs from target.branch → refused with the coded reason', async () => {
    await withHarness(async (h) => {
      syncedProject(h, { header: '# capy:branch=development', branchFile: 'development' });
      const r = await h.run(['deploy', 'dokploy-target', '--yes']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('DEPLOY_BRANCH_MISMATCH');
      expect(r.stderr).toContain('development');
      expect(r.stderr).toContain('production');
    });
  });

  test('active branch matches target.branch → passes the check (fails later, at Dokploy auth)', async () => {
    await withHarness(async (h) => {
      syncedProject(h, { header: '# capy:branch=production', branchFile: 'production' });
      const r = await h.run(['deploy', 'dokploy-target', '--yes'], undefined, undefined, { DOKPLOY_API_KEY: '' });
      expect(r.stderr).not.toContain('DEPLOY_BRANCH_MISMATCH');
      // Reaches preflight instead — no Dokploy token configured in this env.
      expect(r.stderr).toContain('preflight');
    });
  });

  test('no active-branch signal at all: bare capy, which runs first, stops with the coded NO_ACTIVE_BRANCH and the `capy checkout` hint, so the deploy never reaches its own check', async () => {
    await withHarness(async (h) => {
      // two branches on the server — nothing to pick one by: no header, no .capy/branch
      h.setBranches(PROJECT_ID, TWO_BRANCHES);
      syncedProject(h, { branchFile: null });
      const r = await h.run(['deploy', 'dokploy-target', '--yes'], undefined, undefined, { DOKPLOY_API_KEY: '' });
      expect(r.code).toBe(1);
      // The code and the way out are on stderr; stdout (a payload's place) stays empty.
      expect(r.stderr).toContain('NO_ACTIVE_BRANCH');
      expect(r.stderr).toContain('capy checkout');
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toContain('DEPLOY_BRANCH_MISMATCH');
      expect(r.stderr).not.toContain('preflight');
    });
  });

  test('...and under --json the same stop is coded JSON on stdout (capy edit NAME --json), with the hint in it', async () => {
    await withHarness(async (h) => {
      h.setBranches(PROJECT_ID, TWO_BRANCHES);
      syncedProject(h, { branchFile: null });
      const r = await h.run(['edit', 'Z', '--json'], 'a-value\n');
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout) as { ok: boolean; code: string; error: string };
      expect(out).toMatchObject({ ok: false, code: 'NO_ACTIVE_BRANCH' });
      expect(out.error).toContain('capy checkout');
    });
  });
});

const TWO_BRANCHES = [
  { id: 'b-dev', name: 'development', is_protected: false },
  { id: 'b-prod', name: 'production', is_protected: false },
] as const;

/**
 * A project in `h` for `capy deploy targets-remove`: every branch pins the hash of `x` (what `.env` holds, so bare capy,
 * which runs first, finds the folder in sync) and `production`'s entry carries the deploy record of `dokploy-target`.
 */
function targetsProject(h: Harness, opts: { header?: string; branchFile?: string | null; branches?: readonly string[]; targetsEl: Record<string, unknown> }): void {
  const branches = opts.branches ?? ['development', 'production'];
  const variables = {
    DATABASE_URL: branches.map((b) => ({
      resource_id: 'rid' + b[0],
      branch: b,
      value_hash: hashValue('x'),
      ...(b === 'production' ? { targets: [opts.targetsEl] } : {}),
    })),
  };
  writeFileSync(join(h.project, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'test', variables }, null, 2));
  writeDeployConfig(h.project, [dokployTarget('production')]);
  writeFileSync(join(h.project, '.env'), `${opts.header === undefined ? '' : `${opts.header}\n`}DATABASE_URL=x\n`);
  if (opts.branchFile === null) rmSync(join(h.project, '.capy', 'branch'), { force: true });
  else if (opts.branchFile !== undefined) writeFileSync(join(h.project, '.capy', 'branch'), opts.branchFile);
}

const DOKPLOY_RECORD = {
  provider: 'dokploy',
  target: 'dokploy-target',
  deployed_value_hash: 'hhh',
  deployed_at: '2026-09-01T00:00:00.000Z',
};

describe('capy deploy targets-remove — bare capy runs first, then never pushes a wrong-branch env blob (CAP-679)', () => {
  test('active branch differs from target.branch → refuses the keep.lock push, leaves targets untouched', async () => {
    await withHarness(async (h) => {
      targetsProject(h, { header: '# capy:branch=development', branchFile: 'development', targetsEl: DOKPLOY_RECORD });
      const before = h.keepLockText();

      const r = await h.run(['deploy', 'targets-remove', 'dokploy-target']);
      expect(r.code).toBe(0); // local removal still succeeds
      expect(r.stderr).toContain('DEPLOY_BRANCH_MISMATCH');

      const after = h.keepLockText();
      expect(after).toBe(before); // the push never happened — targets record untouched
      expect(JSON.parse(after).variables.DATABASE_URL.find((e: { branch: string }) => e.branch === 'production').targets).toHaveLength(1);
      expect(h.pushCount()).toBe(0);
    });
  });

  test('no active-branch signal at all → bare capy stops it first with NO_ACTIVE_BRANCH (exit 1): nothing removed, nothing pushed, keep.lock untouched', async () => {
    await withHarness(async (h) => {
      // Two branches on the server and in keep.lock, no header, no .capy/branch: nothing to pick one by.
      h.setBranches(PROJECT_ID, TWO_BRANCHES);
      targetsProject(h, { branchFile: null, targetsEl: DOKPLOY_RECORD });
      const before = h.keepLockText();

      const r = await h.run(['deploy', 'targets-remove', 'dokploy-target']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('NO_ACTIVE_BRANCH');
      expect(r.stderr).toContain('capy checkout');
      expect(h.keepLockText()).toBe(before);
      expect(h.pushCount()).toBe(0);
    });
  });

  test('matching active branch → the push proceeds (never refused at the branch check)', async () => {
    await withHarness(async (h) => {
      targetsProject(h, { header: '# capy:branch=production', branchFile: 'production', targetsEl: DOKPLOY_RECORD });

      const r = await h.run(['deploy', 'targets-remove', 'dokploy-target']);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain('DEPLOY_BRANCH_MISMATCH');
      expect(r.stderr).not.toContain('DEPLOY_BRANCH_UNKNOWN');
    });
  });

  test('a folder that differs from Capy is stopped before anything is removed or pushed: exit 3, the rows, and --resolve + --conflict answer it', async () => {
    await withHarness(async (h) => {
      targetsProject(h, { header: '# capy:branch=production', branchFile: 'production', targetsEl: DOKPLOY_RECORD });
      // The folder's .env holds a different value than keep.lock pins: bare capy must ask.
      writeFileSync(join(h.project, '.env'), '# capy:branch=production\nDATABASE_URL=SENTINEL-local-edit-7c1d\n');
      const before = h.keepLockText();
      const deployJson = readFileSync(join(h.project, '.capy', 'deploy.json'), 'utf-8');

      const first = await h.run(['deploy', 'targets-remove', 'dokploy-target']);
      expect(first.code).toBe(3);
      const out = JSON.parse(first.stdout) as { code: string; conflict_id: string; conflicts: { name: string }[] };
      expect(out.code).toBe('SECRETS_CONFLICT');
      expect(out.conflicts.map((c) => c.name)).toEqual(['DATABASE_URL']);
      expect(first.stdout + first.stderr).not.toContain('SENTINEL-local-edit-7c1d');
      // Nothing removed from .capy/deploy.json, keep.lock untouched, nothing pushed.
      expect(readFileSync(join(h.project, '.capy', 'deploy.json'), 'utf-8')).toBe(deployJson);
      expect(h.keepLockText()).toBe(before);
      expect(h.pushCount()).toBe(0);

      // The rerun with the answer (the flags reach bare capy through the subcommand): the folder's value is committed, then the removal goes on.
      const rerun = await h.run(['deploy', 'targets-remove', 'dokploy-target', '--resolve', 'DATABASE_URL=local', '--conflict', out.conflict_id]);
      expect(rerun.code).toBe(0);
      expect(h.pushCount()).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(readFileSync(join(h.project, '.capy', 'deploy.json'), 'utf-8')).targets['dokploy-target']).toBeUndefined();
    });
  });
});

describe('capy deploy targets-remove — token revocation gated on strip outcome (CAP-679)', () => {
  test('onRemove could not clean up the platform side (no token) → the deploy token is KEPT, not revoked', async () => {
    await withHarness(async (h) => {
      // No DOKPLOY_API_KEY anywhere → onRemove refuses with code "no_token".
      targetsProject(h, { header: '# capy:branch=production', branchFile: 'production', targetsEl: { ...DOKPLOY_RECORD, deploy_id: 'dep_test123' } });

      const r = await h.run(['deploy', 'targets-remove', 'dokploy-target'], undefined, undefined, { DOKPLOY_API_KEY: '' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('left untouched'); // the onRemove offer's own refusal (offer.ok === false)
      expect(r.stdout).toContain('keeping 1 deploy token(s)');
      expect(r.stdout).not.toContain('revoked 1 deploy token(s)');
    });
  });
});

describe('capy deploy --json — branch-mismatch as coded JSON, not only stderr prose (CAP-679)', () => {
  test('a known branch mismatch is reported as a coded `problem`, not just prose', () => {
    writeKeep(ROOT);
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(join(ROOT, '.env'), '# capy:branch=development\nDATABASE_URL=x\n');

    const r = capy(['deploy', 'dokploy-target', '--json']);
    expect(r.code).toBe(0); // --json describes the route; it never fails the process
    const parsed = JSON.parse(r.stdout);
    expect(parsed.problem).toEqual({ code: 'DEPLOY_BRANCH_MISMATCH', activeBranch: 'development', targetBranch: 'production' });
  });

  test('a matching branch has no `problem` field at all', () => {
    writeKeep(ROOT);
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(join(ROOT, '.env'), '# capy:branch=production\nDATABASE_URL=x\n');

    const r = capy(['deploy', 'dokploy-target', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.problem).toBeUndefined();
  });

  test('an unknown active branch has no `problem` field (unknown is never guessed as a mismatch)', () => {
    writeKeep(ROOT); // two branches — deriveActiveBranch cannot pick one
    writeDeployConfig(ROOT, [dokployTarget('production')]);
    writeFileSync(join(ROOT, '.env'), 'DATABASE_URL=x\n');

    const r = capy(['deploy', 'dokploy-target', '--json']);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.problem).toBeUndefined();
  });
});

describe('capy deploy — --no-deploy flag (CAP-679)', () => {
  test('is advertised on `capy deploy --help`', () => {
    const r = capy(['deploy', '--help']);
    expect((r.stdout + r.stderr)).toContain('--no-deploy');
  });

  test('is advertised on `capy deploy targets-remove --help`', () => {
    const r = capy(['deploy', 'targets-remove', '--help']);
    expect((r.stdout + r.stderr)).toContain('--no-deploy');
  });
});
