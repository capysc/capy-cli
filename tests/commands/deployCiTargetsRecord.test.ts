/**
 * Server-side deploy-target recording (CAP-687), driven through the REAL
 * `deployCommand()` against a REAL git repo + bare origin — same vehicle as
 * `deployCiChangeGate.test.ts`.
 *
 * Bug 1 (CI mode never recorded at all): `capy deploy` only ever recorded a
 * target's delivery into the SERVER's stored keep.lock in DIRECT mode
 * (`recordDeployTargets`). CI mode folds the delivery into the PR's OWN
 * keep.lock (`buildFinalCiKeep`), but that PR has to be reviewed and merged
 * before it reaches the base branch — and `capy secrets` reads the server's
 * stored keep.lock, never an open PR. So every CI-mode target (aws-ssm,
 * Vercel) never showed up in `capy secrets` at all. Fixed by
 * `recordDeployTargetsCi`, CI mode's counterpart to `recordDeployTargets`.
 *
 * Bug 2 (validator fix-first, found reviewing bug 1's fix — drift): EVERY
 * `pushKeepTransform` caller (direct-mode recording, CI-mode recording,
 * revocation, `targets-remove`) used to build the pushed env blob by
 * decrypting the LOCAL `.env` and re-encrypting it fresh. A keep-only write
 * like "record this target" is not a value edit, so nothing about the
 * branch's secret values should ever change as a side effect of one — but a
 * local `.env` can hold unpushed edits, or a variable that was never synced
 * at all, and the server's `keep_hash` covers only `name:resource_id:
 * value_hash` — never blob content — so rebuilding the blob from local
 * `.env` could silently overwrite the team's stored blob UNDER AN UNCHANGED
 * HASH: the next teammate to pull decrypts the same pin to a different
 * value, with no signal anything drifted. Fixed by never reading local
 * `.env` in `pushKeepTransform` at all: it fetches the server's OWN current
 * snapshot for the branch (`ServiceClient#getLatestSecrets`) and re-sends
 * that blob UNCHANGED, after verifying the hash it came under matches the
 * local keep's branch entries.
 *
 * The properties under test (never the shape of some intermediate object):
 *   - a successful CI delivery calls `pushSecrets` exactly once, with a
 *     keep file whose entries carry the target's delivery record, and the
 *     env blob is the server's OWN blob passed through unchanged;
 *   - an unpushed local `.env` edit, and a variable that was never synced at
 *     all, NEVER appear in what gets pushed — in CI mode AND direct mode
 *     (the drift bug lived in the SHARED `pushKeepTransform`);
 *   - the user's local keep.lock / `.env` / git tree are BYTE-IDENTICAL
 *     before and after a CI-mode run (asserted directly, not inferred from
 *     an absence of git-status noise);
 *   - a dry run never pushes;
 *   - a failed delivery never pushes;
 *   - the server push itself failing warns with a CODED message but still
 *     reports the deploy as succeeded (the delivery already happened) — and
 *     the PR still opens (CI mode).
 *
 * No crypto mocking needed: `pushKeepTransform` no longer touches
 * `resolveProjectKey`/`Encryptor`/`deriveResourceId` at all (it never
 * decrypts or re-encrypts anything — see its own doc), and this fixture's
 * `.env` is plain (unencrypted), so `decryptCurrentBranch` (the ADAPTER's
 * own read, delivering to Dokploy — unrelated to the bug fixed here) never
 * needs them either.
 *
 * The mocked `ServiceClient#getLatestSecrets` fakes "the server's current
 * snapshot" by reading a small JSON file this test writes per branch
 * (`serverSnapshotsPath`) — a deliberately SEPARATE source from the repo's
 * own keep.lock/`.env`, so a test can set up a snapshot that agrees with
 * local keep.lock (same hash) while local `.env` has drifted ahead
 * unpushed, exactly like the real bug. `gh` is mocked unavailable so
 * `createPr` takes its manual-instructions path (`ok: true`, no real GitHub
 * call) — deterministic regardless of this machine's `gh` install.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SyncEngine } from '../../src/sync/syncEngine';

// Declared before the mocks below (which close over them) — every binding
// here is fully initialized before any test() callback runs, so the mocked
// `ServiceClient` class reading them at call time is safe even though this
// line executes before the class body below does.
const TMP = join(tmpdir(), `capy-deploy-ci-targets-record-${process.pid}`);
const REPO = join(TMP, 'repo');
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
    // Fakes "the server's current snapshot for this branch" — reads the
    // per-branch fixture `writeServerSnapshot` (below) wrote, NEVER the
    // repo's own `.env`. Returns null (→ pushKeepTransform's coded "no
    // snapshot yet" warning) when nothing was written for this branch.
    async getLatestSecrets(_projectId: string, branch: string) {
      if (!existsSync(SERVER_SNAPSHOTS_PATH)) return null;
      const snapshots = JSON.parse(readFileSync(SERVER_SNAPSHOTS_PATH, 'utf-8')) as Record<
        string,
        { keepFile: string; envFile: string }
      >;
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

import { spawnSync } from 'child_process';
import { deployCommand } from '../../src/commands/deployCommand';
import { hashValue } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';
import { mergeManagedValuesBlock } from '../../src/deploy/dokployApi';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const APP_ID = 'app_ci_record_test';
const ORIGIN = join(TMP, 'origin.git');
const STRIPE_KEY_VALUE = 'same-value';
const RAW_APP_ENV = 'NODE_ENV=production';
/** The server's own stored blob — an opaque stand-in. Never derived from `.env`, so any test that sees this exact string back out of `pushSecrets` knows the push carried the server's blob unchanged, not a locally-rebuilt one. */
const SERVER_ENV_FILE = 'STRIPE_KEY=SERVER_STORED_BLOB_UNCHANGED';

/**
 * keep.lock with STRIPE_KEY already synced on `main` at the CURRENT value,
 * but with NO `targets` entry for either target yet — a first-ever delivery,
 * which `deliveryWorthGating` treats as a real change ("first-ever delivery
 * to this target") regardless of the value itself having already synced.
 */
function baseKeep(): KeepFile {
  return {
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
  } as unknown as KeepFile;
}

/**
 * Writes the fixture's "server truth" for `branch` — read back by the
 * mocked `getLatestSecrets` above. Defaults to exactly `baseKeep()` / a
 * fresh opaque blob, i.e. "local and server fully agree" (every test except
 * the drift ones wants this). A drift test overrides `envFile` (and leaves
 * `keepFile` matching local keep.lock) to model an unpushed local `.env`
 * edit: same keep hash, different already-stored blob.
 */
function writeServerSnapshot(branch: string, overrides: { keep?: KeepFile; envFile?: string } = {}): void {
  const existing = existsSync(SERVER_SNAPSHOTS_PATH)
    ? (JSON.parse(readFileSync(SERVER_SNAPSHOTS_PATH, 'utf-8')) as Record<string, { keepFile: string; envFile: string }>)
    : {};
  const next = {
    ...existing,
    [branch]: {
      keepFile: JSON.stringify(overrides.keep ?? baseKeep()),
      envFile: overrides.envFile ?? SERVER_ENV_FILE,
    },
  };
  writeFileSync(SERVER_SNAPSHOTS_PATH, JSON.stringify(next));
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
  writeFileSync(join(REPO, 'keep.lock'), serializeKeep(baseKeep()));
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
        'dokploy-direct': {
          name: 'dokploy-direct',
          kind: 'dokploy',
          branch: 'main',
          vars: ['STRIPE_KEY'],
          mode: 'direct',
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

  // Default "server truth": exactly what local keep.lock/`.env` already
  // agree on — every test except the drift ones wants this.
  writeServerSnapshot('main');
}

function tearDownRepo(): void {
  rmSync(TMP, { recursive: true, force: true });
}

/**
 * Scripted Dokploy fetch: preflight read, deploy's own fresh read, the
 * write itself, post-write verify read — the same shape as
 * `deployCiChangeGate.test.ts`'s own (CI mode and direct-mode `--no-deploy`
 * are both `secretsOnly`-equivalent here: neither ever reaches a
 * deployment trigger/poll, so this never needs to script one).
 * `stripeKeyValue` lets a drift test script Dokploy receiving the LOCAL
 * (correctly current, if unpushed) value — that delivery is legitimate;
 * only the separate push to Capy's own server must never see it.
 */
function dokployFetchMock(opts: { failWrite?: boolean; stripeKeyValue?: string } = {}) {
  const value = opts.stripeKeyValue ?? STRIPE_KEY_VALUE;
  const merged = mergeManagedValuesBlock(RAW_APP_ENV, [{ name: 'STRIPE_KEY', value }]);
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

describe('capy deploy — server-side target recording (CAP-687)', () => {
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
   * Runs `deployCommand(targetName, ...)` with console + fetch captured,
   * always restoring both — same shape as
   * `deployRevokeWiring.test.ts#runScriptedDeploy`. `errorMock`, when given,
   * becomes `console.error`'s implementation — its own `.mock.calls` (read
   * by the caller AFTER this returns, once the spy is torn down) is how the
   * "coded warning" test below inspects what was printed, without this
   * helper accumulating anything of its own.
   */
  async function runScriptedDeploy(
    targetName: string,
    fetchMock: ReturnType<typeof mock>,
    options: Parameters<typeof deployCommand>[1],
    errorMock: ReturnType<typeof mock> = mock((..._a: unknown[]) => {}),
  ): Promise<number> {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
    const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(errorMock as never);
    try {
      return await withTestEnv(() => deployCommand(targetName, options, REPO));
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

    const code = await runScriptedDeploy('dokploy-ci', dokployFetchMock(), { yes: true });

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
    // The keep entry's own pin is untouched — only `targets` changed.
    expect(pushedKeep.variables.STRIPE_KEY[0].value_hash).toBe(hashValue(STRIPE_KEY_VALUE));

    // Re-sends the SERVER's OWN blob UNCHANGED — never rebuilt from local
    // `.env`.
    expect(envBlob).toBe(SERVER_ENV_FILE);

    // The user's local keep.lock, `.env`, and git tree are BYTE-IDENTICAL —
    // CI mode never touches them.
    const after = snapshotWorkingTree();
    expect(after.keepLock).toBe(before.keepLock);
    expect(after.env).toBe(before.env);
    expect(after.headSha).toBe(before.headSha);
    expect(after.status).toBe('');
    expect(after.stash).toBe('');
  }, 30_000);

  test('CI mode: an unpushed local `.env` edit and a never-synced variable never leak into the server push', async () => {
    setUpRepo();
    process.chdir(REPO);
    // Drift: the server's stored blob/keep still agree with local keep.lock
    // (same hash — nobody has pushed since), but local `.env` has moved on:
    // an EDITED value for the tracked var, plus a variable that was never
    // synced (and never will be — it's not in `target.vars`/keep.lock).
    writeServerSnapshot('main'); // server truth == local keep.lock, untouched blob
    writeFileSync(join(REPO, '.env'), 'STRIPE_KEY=new-unpushed-value\nUNPUSHED_OTHER=stray\n');

    // Dokploy itself legitimately receives the CURRENT (unpushed) value —
    // that delivery is correct and not what this test is about.
    const code = await runScriptedDeploy(
      'dokploy-ci',
      dokployFetchMock({ stripeKeyValue: 'new-unpushed-value' }),
      { yes: true },
    );

    expect(code).toBe(0);
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);
    const [, keepFileJson, envBlob] = pushSecretsMock.mock.calls[0];

    // The property: the push to CAPY's OWN server carries the SERVER's
    // already-stored blob, byte-identical — never the edited value, and
    // never the never-synced variable.
    expect(envBlob).toBe(SERVER_ENV_FILE);
    expect(envBlob).not.toContain('new-unpushed-value');
    expect(envBlob).not.toContain('UNPUSHED_OTHER');
    expect(envBlob).not.toContain('stray');

    // The keep entry's own pin is untouched too — still the OLD synced
    // value's hash, not the unpushed edit's.
    const pushedKeep = JSON.parse(keepFileJson);
    expect(pushedKeep.variables.STRIPE_KEY[0].value_hash).toBe(hashValue(STRIPE_KEY_VALUE));
    // The delivery record itself is honest about what Dokploy actually
    // received (the unpushed value) — that's target metadata, not a value
    // push, and recording it accurately is correct, not a drift.
    expect(pushedKeep.variables.STRIPE_KEY[0].targets[0].deployed_value_hash).toBe(hashValue('new-unpushed-value'));
  }, 30_000);

  test('direct mode: an unpushed local `.env` edit and a never-synced variable never leak into the server push', async () => {
    setUpRepo();
    process.chdir(REPO);
    writeServerSnapshot('main');
    writeFileSync(join(REPO, '.env'), 'STRIPE_KEY=new-unpushed-value\nUNPUSHED_OTHER=stray\n');

    // `--no-deploy`: writes the config (recordDeployTargets still runs) but
    // skips the trigger+poll steps, same shape as
    // `deployRevokeWiring.test.ts`'s own `--no-deploy` test.
    const code = await runScriptedDeploy(
      'dokploy-direct',
      dokployFetchMock({ stripeKeyValue: 'new-unpushed-value' }),
      { yes: true, noDeploy: true },
    );

    expect(code).toBe(0);
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);
    const [, keepFileJson, envBlob] = pushSecretsMock.mock.calls[0];

    expect(envBlob).toBe(SERVER_ENV_FILE);
    expect(envBlob).not.toContain('new-unpushed-value');
    expect(envBlob).not.toContain('UNPUSHED_OTHER');
    expect(envBlob).not.toContain('stray');

    const pushedKeep = JSON.parse(keepFileJson);
    expect(pushedKeep.variables.STRIPE_KEY[0].value_hash).toBe(hashValue(STRIPE_KEY_VALUE));
    expect(pushedKeep.variables.STRIPE_KEY[0].targets[0]).toMatchObject({
      provider: 'dokploy',
      target: 'dokploy-direct',
      deployed: false, // --no-deploy
      deployed_value_hash: hashValue('new-unpushed-value'),
    });
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

    const code = await runScriptedDeploy('dokploy-ci', fetchMock, { yes: true, dryRun: true });

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

    const code = await runScriptedDeploy('dokploy-ci', dokployFetchMock({ failWrite: true }), { yes: true });

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
    const code = await runScriptedDeploy('dokploy-ci', dokployFetchMock(), { yes: true }, errorMock);

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
