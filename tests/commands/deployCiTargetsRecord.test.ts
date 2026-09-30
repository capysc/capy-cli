/**
 * CI-mode server-side target recording (CAP-687), driven through the REAL
 * `deployCommand()` against a REAL git repo + bare origin — same vehicle as
 * `deployCiChangeGate.test.ts`.
 *
 * The bug: `capy deploy` only ever recorded a target's delivery into the
 * SERVER's stored keep.lock in DIRECT mode (`recordDeployTargets`). CI mode
 * folds the delivery into the PR's OWN keep.lock (`buildFinalCiKeep`), but
 * that PR has to be reviewed and merged before it reaches the base branch —
 * and `capy secrets` reads the server's stored keep.lock, never an open PR.
 * So every CI-mode target (aws-ssm, Vercel) never showed up in `capy
 * secrets` at all.
 *
 * The fix: `recordDeployTargetsCi` — CI mode's counterpart to
 * `recordDeployTargets` — calls the SAME `recordTargetDeliveries` transform
 * through the SAME `pushKeepTransform`, but with `writeLocal: false`: it
 * pushes to the server exactly like direct mode does, while NEVER writing
 * the local keep.lock, NEVER auto-committing, and NEVER touching `.env` or
 * the git tree — CI mode must never touch the user's working tree (see
 * `deployCommand.ts#openCiDeployPr`'s own doc for why).
 *
 * The properties under test (never the shape of some intermediate object):
 *   - a successful CI delivery calls `pushSecrets` exactly once, with a
 *     keep file whose entries carry the target's delivery record, and an
 *     env blob that re-sends the branch's CURRENT value unchanged;
 *   - the user's local keep.lock / `.env` / git tree are BYTE-IDENTICAL
 *     before and after (asserted directly, not inferred from an absence of
 *     git-status noise);
 *   - a dry run never pushes;
 *   - a failed delivery never pushes;
 *   - the server push itself failing warns with a CODED message but still
 *     reports the deploy as succeeded (the delivery already happened) — and
 *     the PR still opens.
 *
 * Every crypto/key-resolution dependency `pushKeepTransform` touches
 * (`resolveProjectKey`, `Encryptor`, `deriveResourceId`) is mocked to a
 * trivial fake, same as `deployRevokeWiring.test.ts` — this file is about
 * the RECORDING WIRING, not real crypto. `gh` is mocked unavailable so
 * `createPr` takes its manual-instructions path (`ok: true` with no real
 * GitHub call) — deterministic regardless of this machine's `gh` install.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';

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
  },
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: async () => 'a'.repeat(64),
}));
mock.module('../../src/crypto/encryptor', () => ({
  Encryptor: {
    encrypt: (v: string) => `ENC:${v}`,
    decrypt: (v: string) => v.slice(4),
  },
}));
mock.module('../../src/crypto/resourceId', () => ({
  deriveResourceId: (branch: string, name: string) => `rid-${branch}-${name}`,
}));
// `gh` unavailable → `createPr` takes its manual-instructions path (ok:
// true, no real GitHub call needed) — deterministic on any machine.
mock.module('../../src/utils/gh', () => ({
  resolveGh: () => null,
  GH_SEARCHED: ['PATH'],
}));

const mintDeployTokenMock = mock(async () => ({
  secretsBlob: 'BLOB_VALUE',
  projectKey: 'KEY_VALUE',
  deployId: 'deploy_unset',
  secretCount: 1,
  blobBytes: 4,
  valueHashes: { STRIPE_KEY: 'hv' },
}));
mock.module('../../src/commands/deployTokenCommand', () => ({
  mintDeployToken: mintDeployTokenMock,
}));

afterEach(() => {
  mock.restore();
  mintDeployTokenMock.mockClear();
  pushSecretsMock.mockClear();
});

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { deployCommand } from '../../src/commands/deployCommand';
import { hashValue } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import { mergeManagedValuesBlock } from '../../src/deploy/dokployApi';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const APP_ID = 'app_ci_record_test';
const TMP = join(tmpdir(), `capy-deploy-ci-targets-record-${process.pid}`);
const ORIGIN = join(TMP, 'origin.git');
const REPO = join(TMP, 'repo');
const STRIPE_KEY_VALUE = 'same-value';
const RAW_APP_ENV = 'NODE_ENV=production';

/**
 * keep.lock with STRIPE_KEY already synced on `main` at the CURRENT value,
 * but with NO `targets` entry for (dokploy, dokploy-ci) yet — a first-ever
 * CI delivery to this target, which `deliveryWorthGating` treats as a real
 * change ("first-ever delivery to this target") regardless of the value
 * itself having already synced.
 */
function baseKeepLock(): string {
  return serializeKeep({
    version: '3.0',
    org_id: 'org_1',
    project_id: 'proj_1',
    project_name: 'demo',
    variables: {
      STRIPE_KEY: [
        {
          resource_id: 'r-1',
          branch: 'main',
          value_hash: hashValue(STRIPE_KEY_VALUE),
        },
      ],
    },
  } as any);
}

function setUpRepo(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  git(['init', '--bare', '-b', 'main', ORIGIN], TMP);
  git(['init', '-q', '-b', 'main', REPO], TMP);
  git(['config', 'user.email', 't@e.com'], REPO);
  git(['config', 'user.name', 'T'], REPO);
  git(['config', 'commit.gpgsign', 'false'], REPO);
  git(['remote', 'add', 'origin', ORIGIN], REPO);

  mkdirSync(join(REPO, '.capy'), { recursive: true });
  writeFileSync(join(REPO, 'keep.lock'), baseKeepLock());
  writeFileSync(join(REPO, '.env'), `STRIPE_KEY=${STRIPE_KEY_VALUE}\n`);
  writeFileSync(
    join(REPO, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'dokploy-ci': {
          name: 'dokploy-ci',
          kind: 'dokploy',
          branch: 'main',
          vars: ['STRIPE_KEY'],
          mode: 'ci',
          gitBaseBranch: 'main',
          options: {
            baseUrl: 'https://dokploy.example.com',
            applicationId: APP_ID,
            tokenEnv: 'MY_CI_RECORD_TEST_TOKEN',
          },
        },
      },
    }),
  );
  git(['add', '.'], REPO);
  git(['commit', '-q', '-m', 'base'], REPO);
  git(['push', '-q', 'origin', 'main'], REPO);
}

function tearDownRepo(): void {
  rmSync(TMP, { recursive: true, force: true });
}

/**
 * Scripted Dokploy fetch: preflight read, deploy's own fresh read, the
 * write itself, post-write verify read — the same shape as
 * `deployCiChangeGate.test.ts`'s own (CI mode is always `secretsOnly`, so
 * Dokploy's own trigger+poll never runs regardless of `failWrite`).
 */
function dokployFetchMock(opts: { failWrite?: boolean } = {}) {
  const merged = mergeManagedValuesBlock(RAW_APP_ENV, [{ name: 'STRIPE_KEY', value: STRIPE_KEY_VALUE }]);
  if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
  const reads = [RAW_APP_ENV, RAW_APP_ENV, merged.env][Symbol.iterator]();
  return mock(async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.one')) {
      const next = reads.next();
      if (next.done) throw new Error('unscripted extra application.one read');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            applicationId: APP_ID,
            name: 'demo-app',
            env: next.value,
            buildArgs: null,
            buildSecrets: null,
            createEnvFile: true,
            autoDeploy: true,
            branch: 'main',
          }),
      };
    }
    if (u.pathname.endsWith('application.saveEnvironment')) {
      if (opts.failWrite) {
        return { status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) };
      }
      return { status: 200, ok: true, text: async () => 'true' };
    }
    throw new Error(`unscripted Dokploy request: ${init.method} ${url}`);
  });
}

/**
 * Snapshot of everything CI mode must never touch: keep.lock and `.env`
 * byte contents, the branch tip (no auto-commit), and git's own status for
 * exactly those two paths (scoped rather than the whole tree — reading
 * `.capy/deploy.json` unconditionally repairs a managed `.gitignore` block
 * on every `capy deploy` call, in EVERY mode; that's pre-existing behavior
 * unrelated to CAP-687, so asserting on it here would fail for reasons that
 * have nothing to do with this fix).
 */
function snapshotWorkingTree(): { keepLock: string; env: string; headSha: string; status: string; stash: string } {
  return {
    keepLock: readFileSync(join(REPO, 'keep.lock'), 'utf-8'),
    env: readFileSync(join(REPO, '.env'), 'utf-8'),
    headSha: git(['rev-parse', 'HEAD'], REPO).stdout.trim(),
    status: git(['status', '--porcelain', '--', 'keep.lock', '.env'], REPO).stdout,
    stash: git(['stash', 'list'], REPO).stdout,
  };
}

describe('capy deploy — CI-mode server-side target recording (CAP-687)', () => {
  const originalCwd = process.cwd();
  const savedToken = process.env.MY_CI_RECORD_TEST_TOKEN;

  function withTestEnv<T>(fn: () => Promise<T>): Promise<T> {
    process.env.MY_CI_RECORD_TEST_TOKEN = 'dk_test_token';
    return fn().finally(() => {
      if (savedToken === undefined) delete process.env.MY_CI_RECORD_TEST_TOKEN;
      else process.env.MY_CI_RECORD_TEST_TOKEN = savedToken;
    });
  }

  /**
   * Runs `deployCommand('dokploy-ci', ...)` with console + fetch captured,
   * always restoring both — same shape as
   * `deployRevokeWiring.test.ts#runScriptedDeploy`. `errorMock`, when given,
   * becomes `console.error`'s implementation — its own `.mock.calls` (read
   * by the caller AFTER this returns, once the spy is torn down) is how the
   * "coded warning" test below inspects what was printed, without this
   * helper accumulating anything of its own.
   */
  async function runScriptedDeploy(
    fetchMock: ReturnType<typeof mock>,
    options: Parameters<typeof deployCommand>[1],
    errorMock: ReturnType<typeof mock> = mock((..._a: unknown[]) => {}),
  ): Promise<number> {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
    const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(errorMock as never);
    try {
      return await withTestEnv(() => deployCommand('dokploy-ci', options, REPO));
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  afterEach(() => {
    process.chdir(originalCwd);
    tearDownRepo();
  });

  test('CI-mode deploy success: pushSecrets called once with the target recorded, local tree byte-identical', async () => {
    setUpRepo();
    process.chdir(REPO);
    const before = snapshotWorkingTree();

    const code = await runScriptedDeploy(dokployFetchMock(), { yes: true });

    expect(code).toBe(0);
    expect(mintDeployTokenMock).not.toHaveBeenCalled();

    // The property: pushed to the SERVER exactly once, carrying this
    // target's delivery record.
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);
    const [projectId, keepFileJson, envBlob, branch] = pushSecretsMock.mock.calls[0];
    expect(projectId).toBe('proj_1');
    expect(branch).toBe('main');
    const pushedKeep = JSON.parse(keepFileJson);
    const targets = pushedKeep.variables.STRIPE_KEY[0].targets;
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      provider: 'dokploy',
      target: 'dokploy-ci',
      deployed_value_hash: hashValue(STRIPE_KEY_VALUE),
    });
    expect(targets[0].deploy_id).toBeUndefined(); // Dokploy mints no token (CAP-682)

    // Re-sends the branch's CURRENT value UNCHANGED — never dropped, never
    // altered — through the same trivial encrypt/resourceId fakes as
    // `deployRevokeWiring.test.ts`.
    expect(envBlob).toBe(`STRIPE_KEY=capy:rid-main-STRIPE_KEY:ENC:${STRIPE_KEY_VALUE}`);

    // The user's local keep.lock, `.env`, and git tree are BYTE-IDENTICAL —
    // CI mode never touches them.
    const after = snapshotWorkingTree();
    expect(after.keepLock).toBe(before.keepLock);
    expect(after.env).toBe(before.env);
    expect(after.headSha).toBe(before.headSha);
    expect(after.status).toBe('');
    expect(after.stash).toBe('');
  }, 30_000);

  test('a dry run never pushes to the server', async () => {
    setUpRepo();
    process.chdir(REPO);
    const before = snapshotWorkingTree();

    // Only the preflight read is ever scripted — a dry run's adapter.deploy
    // makes no request at all (see tests/deploy/dokploy.test.ts's own "a dry
    // run makes no request").
    const fetchMock = mock(async (url: string, init: { method: string }) => {
      const u = new URL(url);
      if (u.pathname.endsWith('application.one')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              applicationId: APP_ID,
              name: 'demo-app',
              env: RAW_APP_ENV,
              buildArgs: null,
              buildSecrets: null,
              createEnvFile: true,
              autoDeploy: true,
              branch: 'main',
            }),
        };
      }
      throw new Error(`unscripted request during dry run: ${init.method} ${url}`);
    });

    const code = await runScriptedDeploy(fetchMock, { yes: true, dryRun: true });

    expect(code).toBe(0);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    const after = snapshotWorkingTree();
    expect(after.keepLock).toBe(before.keepLock);
    expect(after.env).toBe(before.env);
    expect(after.headSha).toBe(before.headSha);
  }, 30_000);

  test('a FAILED delivery never pushes to the server', async () => {
    setUpRepo();
    process.chdir(REPO);

    const code = await runScriptedDeploy(dokployFetchMock({ failWrite: true }), { yes: true });

    expect(code).toBe(1);
    expect(pushSecretsMock).not.toHaveBeenCalled();
  }, 30_000);

  test('the server push failing warns with a CODED message but still succeeds (delivery already happened) — PR still opens', async () => {
    setUpRepo();
    process.chdir(REPO);
    const before = snapshotWorkingTree();

    pushSecretsMock.mockImplementationOnce(async () => {
      throw new Error('service unreachable');
    });

    const errorMock = mock((..._a: unknown[]) => {});
    const code = await runScriptedDeploy(dokployFetchMock(), { yes: true }, errorMock);

    // The delivery already happened — a failed server-side record must
    // never fail the deploy, and the PR (manualHint path, `gh` mocked
    // unavailable) still opens.
    expect(code).toBe(0);
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);

    const warnings = errorMock.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).toContain('CI_DEPLOY_TARGETS_RECORD_FAILED');

    // Still never touched the local tree even on failure.
    const after = snapshotWorkingTree();
    expect(after.keepLock).toBe(before.keepLock);
    expect(after.env).toBe(before.env);
    expect(after.headSha).toBe(before.headSha);
  }, 30_000);
});
