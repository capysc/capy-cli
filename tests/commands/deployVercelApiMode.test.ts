/**
 * A REAL `deployCommand()` run against a Vercel target in API mode (CAP-696),
 * against a real git repo + bare origin (same vehicle as
 * `deployCiTargetsRecord.test.ts`) and an in-memory Vercel
 * (`tests/deploy/vercelApiModeFake.ts`) standing in for `fetch`.
 *
 * What it proves, end to end:
 *   - the token is asked of the org system store ONCE, by the documented name,
 *     and never printed;
 *   - a preview target with no gitBranch deploys under `--yes` (the CLI path's
 *     "missing gitBranch" refusal does not apply in API mode);
 *   - the keep.lock PR still opens, and the delivery is recorded on keep.lock
 *     (`provider: 'vercel'`, target name, `ref.projectId`, deployed hash);
 *   - a dry run reads but never writes, and records nothing;
 *   - a refused preflight / failed delivery sends no value and records nothing;
 *   - a target WITHOUT projectId never asks the store or Vercel for anything.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { SyncEngine } from '../../src/sync/syncEngine';

const TMP = join(tmpdir(), `capy-deploy-vercel-api-${process.pid}`);
const REPO = join(TMP, 'repo');
const ORIGIN = join(TMP, 'origin.git');
const SERVER_SNAPSHOTS_PATH = join(TMP, 'server-snapshots.json');

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return { success: true, user_id: 'user_1' };
    }
    async getValidToken() {
      return 'fake-session-token';
    }
  },
  silentAuthFailureMessage: () => 'auth failed',
}));

const pushSecretsMock = mock(async (_projectId: string, keepFileJson: string, _envBlob: string, _branch: string) => ({
  keep_hash: 'h'.repeat(16),
  keep_file: keepFileJson,
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async pushSecrets(projectId: string, keepFileJson: string, envBlob: string, branch: string) {
      return pushSecretsMock(projectId, keepFileJson, envBlob, branch);
    }
    async getLatestSecrets(_projectId: string, branch: string) {
      if (!existsSync(SERVER_SNAPSHOTS_PATH)) return null;
      const snapshots = JSON.parse(readFileSync(SERVER_SNAPSHOTS_PATH, 'utf-8')) as Record<string, { keepFile: string; envFile: string }>;
      const snap = snapshots[branch];
      if (!snap) return null;
      return {
        env_file: snap.envFile,
        keep_hash: SyncEngine.computeKeepHash(JSON.parse(snap.keepFile), branch),
        keep_file: snap.keepFile,
      };
    }
  },
}));
mock.module('../../src/utils/gh', () => ({
  resolveGh: () => null,
  GH_SEARCHED: ['PATH'],
}));

afterEach(() => {
  mock.restore();
  pushSecretsMock.mockClear();
});

import { deployCommand } from '../../src/commands/deployCommand';
import { hashValue } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';
import { createFakeVercel, type FakeRecord, type FakeVercelOptions } from '../deploy/vercelApiModeFake';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const TOKEN = 'tok_fake_value_never_print';
const STRIPE_VALUE = 'same-value';

function baseKeep(): KeepFile {
  return {
    version: '3.0',
    org_id: 'org_1',
    project_id: 'proj_1',
    project_name: 'demo',
    variables: {
      STRIPE_KEY: [{ resource_id: 'r-1', branch: 'main', value_hash: hashValue(STRIPE_VALUE) }],
    },
  } as unknown as KeepFile;
}

function writeServerSnapshot(branch: string): void {
  writeFileSync(
    SERVER_SNAPSHOTS_PATH,
    JSON.stringify({ [branch]: { keepFile: JSON.stringify(baseKeep()), envFile: 'STRIPE_KEY=SERVER_STORED_BLOB_UNCHANGED' } }),
  );
}

const API_OPTIONS = { projectDir: 'web', projectId: 'prj_1', teamId: 'team_1' };

function setUpRepo(targetOptions: Record<string, unknown>): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  git(['init', '--bare', '-b', 'main', ORIGIN], TMP);
  git(['init', '-q', '-b', 'main', REPO], TMP);
  git(['config', 'user.email', 't@e.com'], REPO);
  git(['config', 'user.name', 'T'], REPO);
  git(['config', 'commit.gpgsign', 'false'], REPO);
  git(['remote', 'add', 'origin', ORIGIN], REPO);
  mkdirSync(join(REPO, '.capy'), { recursive: true });
  writeFileSync(join(REPO, 'keep.lock'), serializeKeep(baseKeep()));
  writeFileSync(join(REPO, '.env'), `STRIPE_KEY=${STRIPE_VALUE}\n`);
  writeFileSync(
    join(REPO, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'vercel-api': {
          name: 'vercel-api',
          kind: 'vercel',
          branch: 'main',
          vars: ['STRIPE_KEY'],
          mode: 'ci',
          gitBaseBranch: 'main',
          options: targetOptions,
        },
      },
    }),
  );
  git(['add', '.'], REPO);
  git(['commit', '-q', '-m', 'base'], REPO);
  git(['push', '-q', 'origin', 'main'], REPO);
  writeServerSnapshot('main');
}

interface Run {
  code: number;
  lines: readonly string[];
  vercelWrites: number;
  vercelCalls: number;
  fake: ReturnType<typeof createFakeVercel>;
  storeAsks: ReadonlyArray<readonly unknown[]>;
}

/**
 * Runs the deploy with console, Vercel and the system store faked. `store`
 * is what `getDirectionalConnectorSecret` answers (the real one is mocked
 * out: this file is about the wiring, `vercelApiModeTokenStore.test.ts` is
 * about the store itself). Every count is read off bun's own spies.
 */
async function run(
  options: Parameters<typeof deployCommand>[1],
  fakeOpts: FakeVercelOptions = {},
  store: string | null = TOKEN,
): Promise<Run> {
  const fake = createFakeVercel({ projectId: 'prj_1', teamId: 'team_1', token: TOKEN, ...fakeOpts });
  const getDirectional = mock(async (..._args: unknown[]) => store);
  mock.module('../../src/system/systemStore', () => ({ getDirectionalConnectorSecret: getDirectional }));
  const logMock = mock((..._a: unknown[]) => {});
  const errMock = mock((..._a: unknown[]) => {});
  const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
  const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((input: string, init?: RequestInit) => fake.fetch(String(input), init)) as never);
  try {
    const code = await deployCommand('vercel-api', options, REPO);
    return {
      code,
      lines: [...logMock.mock.calls, ...errMock.mock.calls].map((args) => args.map(String).join(' ')),
      vercelWrites: fake.writeCalls().length,
      vercelCalls: fake.calls().length,
      fake,
      storeAsks: getDirectional.mock.calls,
    };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

function withCwd<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(REPO);
  return fn().finally(() => process.chdir(original));
}

const rec = (over: Partial<FakeRecord> & Pick<FakeRecord, 'id' | 'key' | 'value' | 'target'>): FakeRecord => ({ type: 'encrypted', ...over });

describe('capy deploy — Vercel API mode, end to end (CAP-696)', () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('preview target with NO gitBranch deploys under --yes: values land, the PR branch is pushed, the delivery is recorded', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'preview' });
    const result = await withCwd(() =>
      run(
        { yes: true },
        { records: [rec({ id: 'env_shared', key: 'STRIPE_KEY', value: 'old', target: ['production', 'preview'] })] },
      ),
    );
    expect(result.code).toBe(0);
    // Property: preview got the new value, production did not move.
    expect(result.fake.seenBy('preview', 'STRIPE_KEY')).toBe(STRIPE_VALUE);
    expect(result.fake.seenBy('production', 'STRIPE_KEY')).toBe('old');
    // The system store was asked once, for the documented name, with the connector as the fallback.
    expect(result.storeAsks).toHaveLength(1);
    const [name, fallback, opts] = result.storeAsks[0] as [string, string, Record<string, unknown>];
    expect(name).toBe('_TARGET_VERCEL_TOKEN');
    expect(fallback).toBe('_CONNECTOR_VERCEL_TOKEN');
    expect(opts).toMatchObject({ interactive: false, missingWithFallbackCode: 'VERCEL_TARGET_KEY_MISSING' });
    // Never printed.
    expect(result.lines.some((l) => l.includes(TOKEN))).toBe(false);
    // The keep.lock PR branch exists on origin: the deploy PR still opens in API mode.
    expect(git(['branch', '--list', 'capy-deploy-*'], ORIGIN).stdout).toContain('capy-deploy-');
    // Recorded on the server's keep.lock.
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);
    const pushedKeep = JSON.parse(pushSecretsMock.mock.calls[0][1]);
    const targets = pushedKeep.variables.STRIPE_KEY[0].targets;
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      provider: 'vercel',
      target: 'vercel-api',
      ref: { projectId: 'prj_1' },
      deployed_value_hash: hashValue(STRIPE_VALUE),
    });
    expect(targets[0].ref.envId).toBeUndefined();
  }, 30_000);

  test('a custom environment target records its environment id as ref.envId', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'staging', customEnvironmentId: 'env_stg' });
    const result = await withCwd(() => run({ yes: true }, { customEnvs: [{ id: 'env_stg', slug: 'staging' }] }));
    expect(result.code).toBe(0);
    expect(result.fake.seenBy('custom:env_stg', 'STRIPE_KEY')).toBe(STRIPE_VALUE);
    const targets = JSON.parse(pushSecretsMock.mock.calls[0][1]).variables.STRIPE_KEY[0].targets;
    expect(targets[0].ref).toEqual({ projectId: 'prj_1', envId: 'env_stg' });
  }, 30_000);

  test('--dry-run reads but writes nothing: no Vercel write, no push to Capy, no PR branch', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'production' });
    const result = await withCwd(() => run({ yes: true, dryRun: true }));
    expect(result.code).toBe(0);
    expect(result.vercelWrites).toBe(0);
    expect(result.fake.records()).toEqual([]);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    expect(git(['branch', '--list', 'capy-deploy-*'], ORIGIN).stdout.trim()).toBe('');
    expect(result.lines.some((l) => l.includes('would push 1 var(s) to production'))).toBe(true);
  }, 30_000);

  test('no token anywhere + no TTY: refused with the key named, zero Vercel requests, nothing recorded', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'production' });
    const result = await withCwd(() => run({ yes: true }, {}, null));
    expect(result.code).toBe(1);
    expect(result.vercelCalls).toBe(0);
    expect(result.lines.some((l) => l.includes('_TARGET_VERCEL_TOKEN'))).toBe(true);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    // The refusal says how to make a token, in the approved words (stderr).
    const text = result.lines.join('\n');
    expect(text).toContain('Create a token at https://vercel.com/account/settings/tokens. Set Scope to the team that owns the project.');
    expect(text).toContain('Then save it: capy system set _TARGET_VERCEL_TOKEN');
    expect(text).not.toContain(TOKEN);
  }, 30_000);

  test('the same refusal names the team when the saved target knows its slug', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'production', teamSlug: 'acme' });
    const result = await withCwd(() => run({ yes: true }, {}, null));
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('Set Scope to the team that owns the project (acme).');
  }, 30_000);

  test('a token Vercel rejects: refused at preflight before any value is sent, nothing recorded', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'production' });
    const result = await withCwd(() => run({ yes: true }, { token: 'a-different-token' }));
    expect(result.code).toBe(1);
    expect(result.vercelWrites).toBe(0);
    expect(pushSecretsMock).not.toHaveBeenCalled();
  }, 30_000);

  test('a failed delivery fails the run and records nothing', async () => {
    setUpRepo({ ...API_OPTIONS, vercelEnv: 'production' });
    const result = await withCwd(() => run({ yes: true }, { failPostFor: ['STRIPE_KEY'] }));
    expect(result.code).toBe(1);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    expect(git(['branch', '--list', 'capy-deploy-*'], ORIGIN).stdout.trim()).toBe('');
  }, 30_000);

  test('a target WITHOUT projectId never asks the store for a token and never calls Vercel', async () => {
    // The old path: no projectId. The project dir is absent, so its own preflight refuses — before anything else.
    setUpRepo({ projectDir: 'web', vercelEnv: 'production' });
    const result = await withCwd(() => run({ yes: true }));
    expect(result.code).toBe(1);
    expect(result.storeAsks).toHaveLength(0);
    expect(result.vercelCalls).toBe(0);
  }, 30_000);
});
