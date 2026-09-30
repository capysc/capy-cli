/**
 * Superseded deploy-token revocation wiring (validator fix-first, CAP-679
 * follow-up item 2) — driven through the REAL `deployCommand()`/`deployRemove()`
 * in DIRECT mode, with a mocked ServiceClient/adapter fetch. Asserts the
 * PROPERTY (which ids `revokeDeployToken` is called with, and how many
 * times), never the shape of some intermediate object.
 *
 * CAP-682: Dokploy no longer mints a deploy token at all (plain-value
 * delivery — `needsDeployToken: false`), so it is currently the ONLY real
 * adapter this file's REAL-`deployCommand()` vehicle can drive, and it can
 * no longer produce a FRESH `deploy_id` to supersede. What it still proves,
 * and what the tests below were adapted to show:
 *   - a Dokploy target whose keep.lock still carries a PRE-MIGRATION
 *     `deploy_id` (from before this org's Dokploy target used plain-value
 *     delivery) gets that stale id superseded — and, in direct mode,
 *     revoked — by the very next deploy, even though that deploy itself
 *     mints nothing new. This is the generic "no untracked tokens" wiring
 *     (`targetsGate.ts#upsertTargetElement`) working exactly as it did
 *     before, driven off a delivery whose OWN `deployId` is simply always
 *     `undefined` now.
 *   - `mintDeployToken` itself is never called for a Dokploy deploy.
 *   - `capy deploy targets-remove` still revokes every id — current or
 *     superseded — it finds recorded in keep.lock, regardless of whether
 *     the adapter that recorded them still mints tokens at all (the LAST
 *     test: two pre-recorded `superseded_deploy_ids` plus the current one).
 *
 * CAP-687 (validator fix-first): `pushKeepTransform` no longer builds the
 * pushed env blob from local `.env` at all — it fetches the server's OWN
 * current snapshot for the branch (`getLatestSecrets`) and re-sends that
 * blob unchanged, after verifying its `keep_hash` matches the local keep's
 * branch entries. The mocked `ServiceClient` below fakes that snapshot by
 * reading + hashing `ROOT/keep.lock` itself (via the REAL `SyncEngine`, not
 * mocked here) — always "in sync", since this file is about the REVOKE
 * WIRING, not the drift guard (see `deployCiTargetsRecord.test.ts` for
 * that). No crypto mocking is needed any more: `pushKeepTransform` never
 * touches `resolveProjectKey`/`Encryptor`/`deriveResourceId`, and this
 * fixture's `.env` is plain (unencrypted), so `decryptCurrentBranch` never
 * needs them either.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SyncEngine } from '../../src/sync/syncEngine';
import { ProjectManager } from '../../src/core/projectManager';

/** Sentinel filename (see the mocked `getLatestSecrets` below) — its mere presence next to `ROOT/keep.lock` models a stale local keep.lock. */
const STALE_KEEP_MARKER = '.simulate-stale-keep';

/**
 * When present, the mocked `getLatestSecrets` below hashes THIS file's
 * content as "the server's real snapshot" instead of deriving one from
 * whatever sits on disk locally — an independent ground truth, so a test
 * can model "the server already has these pins" without that just being
 * the same local read the code under test also makes (which would always
 * trivially agree with itself). See the two "working copy vs tracked file"
 * tests below.
 */
const SERVER_SNAPSHOT_OVERRIDE = '.simulate-server-snapshot';

// Declared before the mocks below (which close over it) — a `const` at
// module scope is fully initialized before any test() callback runs, so the
// mocked `ServiceClient` class reading it at call time is safe even though
// this line executes before the class body below does.
const ROOT = join(tmpdir(), `capy-deploy-revoke-wiring-${process.pid}-${Date.now()}`);

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

const revokeDeployTokenMock = mock(async (_id: string) => ({}));
const pushSecretsMock = mock(async (_projectId: string, keepFileJson: string, _envBlob: string, _branch: string) => ({
  keep_hash: 'h'.repeat(16),
  keep_file: keepFileJson, // echo back exactly what was pushed — SyncEngine.adoptServerKeep trusts it as the new state
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async revokeDeployToken(id: string) {
      return revokeDeployTokenMock(id);
    }
    async pushSecrets(projectId: string, keepFileJson: string, envBlob: string, branch: string) {
      return pushSecretsMock(projectId, keepFileJson, envBlob, branch);
    }
    // Fakes "the server agrees with local" by reading local keep.lock the
    // SAME way the real code under test does (`ProjectManager.readKeepFile`
    // — the untracked working copy when one exists, else the tracked
    // file), and hashing it the same way the real server would, so
    // `pushKeepTransform`'s (and `resolveFreshSnapshot`'s) drift guard
    // always proceeds. A test that wants to model a STALE local keep.lock
    // instead drops the sentinel file `STALE_KEEP_MARKER` (below) next to
    // it — its mere presence, not its content, flips this to return a hash
    // that can never match the local file's real one. `SERVER_SNAPSHOT_OVERRIDE`
    // (also below) models an independent server snapshot instead of
    // deriving one from the local read at all.
    async getLatestSecrets(_projectId: string, branch: string) {
      const overridePath = join(ROOT, SERVER_SNAPSHOT_OVERRIDE);
      const keep = existsSync(overridePath)
        ? JSON.parse(readFileSync(overridePath, 'utf-8'))
        : new ProjectManager(ROOT).readKeepFile();
      if (!keep) throw new Error('test fixture has no keep.lock to read');
      const realHash = SyncEngine.computeKeepHash(keep, branch);
      return {
        env_file: 'STUB_ENV_FILE',
        keep_hash: existsSync(join(ROOT, STALE_KEEP_MARKER)) ? `stale-${realHash}` : realHash,
        keep_file: JSON.stringify(keep),
      };
    }
  },
}));

/**
 * CAP-682: `mintDeployToken` is mocked here purely to prove it is NEVER
 * called for a Dokploy deploy anymore — see the assertion in the first
 * test below. No test in this file calls `mintNext`/relies on its return
 * value; Dokploy's delivery no longer produces a `deployId` at all.
 */
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
});

import { deployCommand, deployRemove } from '../../src/commands/deployCommand';
import { mergeManagedValuesBlock } from '../../src/deploy/dokployApi';

const APP_ID = 'app_revoke_test';
/** An active line for STRIPE_KEY already outside the block — gets COMMENTED once Capy delivers it. */
const RAW_ENV = 'STRIPE_KEY=stale\n';
/** `.env`'s own plaintext value for STRIPE_KEY (see `setUp`) — a fake, non-secret test value. */
const DECRYPTED_STRIPE_KEY = 'whatever';

function mergedEnv(env: string | null): string {
  const merged = mergeManagedValuesBlock(env, [{ name: 'STRIPE_KEY', value: DECRYPTED_STRIPE_KEY }]);
  if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
  return merged.env;
}

/**
 * `deploy.json` + keep.lock with STRIPE_KEY's entry already recording a
 * PRIOR (direct-mode) delivery to (dokploy, dokploy-direct) via `deploy_id:
 * 'dep_prior'` — the id a successful new deploy should supersede and then
 * revoke. `priorSuperseded` lets a test seed an ALREADY-superseded id too,
 * to prove `targets-remove` revokes both current and superseded together.
 */
function setUp(opts: { mode?: 'ci' | 'direct'; priorSuperseded?: string[]; gitBaseBranch?: string } = {}): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.capy'), { recursive: true });
  writeFileSync(
    join(ROOT, 'keep.lock'),
    JSON.stringify({
      version: '3.0',
      org_id: 'org_1',
      project_id: 'proj_1',
      project_name: 'demo',
      variables: {
        STRIPE_KEY: [
          {
            resource_id: 'r-1',
            branch: 'production',
            value_hash: 'h',
            targets: [
              {
                provider: 'dokploy',
                target: 'dokploy-direct',
                deployed_value_hash: 'h',
                deployed_at: '2026-01-01T00:00:00.000Z',
                deploy_id: 'dep_prior',
                ...(opts.priorSuperseded?.length ? { superseded_deploy_ids: opts.priorSuperseded } : {}),
              },
            ],
          },
        ],
      },
    }),
  );
  writeFileSync(join(ROOT, '.env'), 'STRIPE_KEY=whatever\n');
  writeFileSync(
    join(ROOT, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'dokploy-direct': {
          name: 'dokploy-direct',
          kind: 'dokploy',
          branch: 'production',
          vars: ['STRIPE_KEY'],
          mode: opts.mode ?? 'direct',
          // CAP-682: CI mode now preflights autoDeploy/tracked-branch —
          // must match `dokployFetchMock`'s `branch: 'main'` fixture.
          ...(opts.mode === 'ci' ? { gitBaseBranch: opts.gitBaseBranch ?? 'main' } : {}),
          options: {
            baseUrl: 'https://dokploy.example.com',
            applicationId: APP_ID,
            tokenEnv: 'MY_REVOKE_TEST_TOKEN',
          },
        },
      },
    }),
  );
}

function tearDown(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/** Scripted Dokploy fetch, exactly like `deployDokploySystemStoreToken.test.ts`'s own: preflight read, deploy's fresh read, post-write verify read; then the write itself. `failWrite` scripts `application.saveEnvironment` to fail (proving "deploy failed → no revoke"). */
/**
 * Full happy-path Application sequence: preflight read, deploy's fresh read,
 * write, post-write verify read, baseline `deployment.all` (empty), trigger,
 * one poll `deployment.all` that's already `done` (see
 * `pollDeployment`/adapters/dokploy.ts: a 'done' status on the FIRST poll
 * read returns immediately — no sleep, no second read needed).
 * `opts.realDeploy` scripts the trigger+poll steps too; omit it for
 * `--no-deploy` (which the adapter skips BEFORE ever reaching them).
 */
function dokployFetchMock(opts: { failWrite?: boolean; realDeploy?: boolean } = {}) {
  const expectedMergedEnv = mergedEnv(RAW_ENV);
  const reads = [RAW_ENV, RAW_ENV, expectedMergedEnv][Symbol.iterator]();
  const deploymentReads = [
    [] as const,
    [{ deploymentId: 'dep_triggered', status: 'done' as const, createdAt: '2026-01-01T00:00:00.000Z' }],
  ][Symbol.iterator]();
  return mock(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.saveEnvironment')) {
      if (opts.failWrite) {
        return { status: 500, ok: false, text: async () => JSON.stringify({ message: 'boom' }) };
      }
      return { status: 200, ok: true, text: async () => 'true' };
    }
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
            // CAP-682 CI preflight: harmless for direct mode, required for
            // the CI-mode test below.
            autoDeploy: true,
            branch: 'main',
          }),
      };
    }
    if (opts.realDeploy && u.pathname.endsWith('deployment.all')) {
      const next = deploymentReads.next();
      if (next.done) throw new Error('unscripted extra deployment.all read');
      return { status: 200, ok: true, text: async () => JSON.stringify(next.value) };
    }
    if (opts.realDeploy && u.pathname.endsWith('application.deploy')) {
      return { status: 200, ok: true, text: async () => 'true' };
    }
    throw new Error(`unscripted Dokploy request: ${init.method} ${url}`);
  });
}

async function withEnv<T>(vars: Readonly<Record<string, string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Runs deployCommand with console + fetch captured/scripted; always restores both. */
async function runScriptedDeploy(
  fetchMock: ReturnType<typeof dokployFetchMock>,
  options: Parameters<typeof deployCommand>[1] = { yes: true },
  errorMock: ReturnType<typeof mock> = mock((..._a: unknown[]) => {}),
): Promise<number> {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation(errorMock as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  try {
    return await deployCommand('dokploy-direct', options, ROOT);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

/** Same shape as `runScriptedDeploy`, for `deployRemove` instead. */
async function runScriptedRemove(
  fetchMock: ReturnType<typeof mock>,
  errorMock: ReturnType<typeof mock> = mock((..._a: unknown[]) => {}),
): Promise<number> {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation(errorMock as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  try {
    return await deployRemove('dokploy-direct', ROOT, {});
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

describe('capy deploy — superseded deploy-token revocation wiring (validator fix-first)', () => {
  afterEach(() => tearDown());

  test('a successful direct-mode deploy revokes the PRE-MIGRATION deploy_id it superseded, without minting a new one', async () => {
    setUp({ mode: 'direct' });
    revokeDeployTokenMock.mockClear();

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock({ realDeploy: true })),
    );
    expect(code).toBe(0);

    // CAP-682: Dokploy never mints a deploy token at all.
    expect(mintDeployTokenMock).not.toHaveBeenCalled();
    // The property: revoked with EXACTLY the pre-migration id this delivery
    // superseded (its own `deployId` is always `undefined` now) — never
    // zero, never more, never the wrong id.
    expect(revokeDeployTokenMock).toHaveBeenCalledTimes(1);
    expect(revokeDeployTokenMock.mock.calls.map((c) => c[0])).toEqual(['dep_prior']);
  }, 30_000);

  test('--no-deploy: never revokes — the predecessor may still be the one actually running', async () => {
    setUp({ mode: 'direct' });
    revokeDeployTokenMock.mockClear();

    // --no-deploy still writes the config (that's the point — the target is
    // verified and the plain values land on the platform) but skips the
    // trigger+poll steps entirely (`ctx.noDeploy` short-circuits BEFORE the
    // `deployment.all` baseline read — see adapters/dokploy.ts). The fetch
    // mock never scripts `deployment.all`/`application.deploy`; it would
    // throw if called, proving the actual redeploy trigger never happens.
    const fetchMock = dokployFetchMock();

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(fetchMock, { yes: true, noDeploy: true }),
    );
    expect(code).toBe(0);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  }, 30_000);

  test('a FAILED adapter deploy never revokes', async () => {
    setUp({ mode: 'direct' });
    revokeDeployTokenMock.mockClear();

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock({ failWrite: true })),
    );
    expect(code).toBe(1);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  }, 30_000);

  test('CI mode never revokes — recordDeployTargets/revoke are direct-mode only', async () => {
    setUp({ mode: 'ci' });
    revokeDeployTokenMock.mockClear();

    // CI mode's own gate would decrypt via decryptCurrentBranch — no git
    // repo here means `gitOk` is false, so the gate is skipped entirely and
    // this runs the old, ungated CI path straight through (mirrors every
    // OTHER `mode: 'ci'` test in deployDokploySystemStoreToken.test.ts,
    // none of which git-init their ROOT either).
    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock()),
    );
    expect(code).toBe(0);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  }, 30_000);

  test('targets-remove revokes BOTH the current id and every already-superseded id', async () => {
    setUp({ mode: 'direct', priorSuperseded: ['dep_older_1', 'dep_older_2'] });
    revokeDeployTokenMock.mockClear();

    const fetchMock = mock(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('application.one')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              applicationId: APP_ID,
              name: 'demo-app',
              env: 'NODE_ENV=production', // no Capy block — onRemove reports nothing_to_remove, offer.ok stays true
              buildArgs: null,
              buildSecrets: null,
              createEnvFile: true,
            }),
        };
      }
      throw new Error(`unscripted request: ${url}`);
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
    try {
      const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () => deployRemove('dokploy-direct', ROOT, {}));
      expect(code).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(new Set(revokeDeployTokenMock.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['dep_prior', 'dep_older_1', 'dep_older_2']),
    );
    expect(revokeDeployTokenMock).toHaveBeenCalledTimes(3);
  }, 30_000);

  // ── "No untracked tokens" pre-checks (CAP-687 follow-up) ─────────────────
  // A stale local keep.lock must refuse BEFORE minting or delivering
  // anything — not discover the staleness only AFTER something was already
  // minted or revoked with nothing left to record it against.

  test('direct mode: a stale local keep.lock refuses to mint/deliver anything, with a coded error', async () => {
    setUp({ mode: 'direct' });
    writeFileSync(join(ROOT, STALE_KEEP_MARKER), '');
    revokeDeployTokenMock.mockClear();
    pushSecretsMock.mockClear();
    mintDeployTokenMock.mockClear();

    // Scripted for a full real deploy — proves the refusal happens before
    // ANY of it, not just before whichever step happens to be reached first.
    const fetchMock = dokployFetchMock({ realDeploy: true });
    const errorMock = mock((..._a: unknown[]) => {});

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(fetchMock, { yes: true }, errorMock),
    );

    expect(code).toBe(1);
    expect(mintDeployTokenMock).not.toHaveBeenCalled();
    expect(pushSecretsMock).not.toHaveBeenCalled();
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
    // Only the preflight read happened — no delivery
    // (`application.saveEnvironment`), no trigger, no poll.
    expect(fetchMock.mock.calls.every((c) => !(c[0] as string).includes('saveEnvironment'))).toBe(true);
    expect(fetchMock.mock.calls.every((c) => !(c[0] as string).includes('deployment'))).toBe(true);

    const warnings = errorMock.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).toContain('DEPLOY_STALE_KEEP');
  }, 30_000);

  test('targets-remove: a stale local keep.lock refuses to strip or revoke anything, with a coded error', async () => {
    setUp({ mode: 'direct' });
    writeFileSync(join(ROOT, STALE_KEEP_MARKER), '');
    revokeDeployTokenMock.mockClear();
    pushSecretsMock.mockClear();

    const fetchMock = mock(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('application.one')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              applicationId: APP_ID,
              name: 'demo-app',
              env: 'NODE_ENV=production', // no Capy block — onRemove reports nothing_to_remove, offer.ok stays true
              buildArgs: null,
              buildSecrets: null,
              createEnvFile: true,
            }),
        };
      }
      throw new Error(`unscripted request: ${url}`);
    });
    const errorMock = mock((..._a: unknown[]) => {});

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () => runScriptedRemove(fetchMock, errorMock));

    // Refused as a whole: nothing stripped, nothing revoked, and the target
    // stays in .capy/deploy.json — removing it would orphan its keep.lock
    // records, since the strip path needs the target to find them.
    expect(code).toBe(1);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
    expect(pushSecretsMock).not.toHaveBeenCalled();
    const deployJson = JSON.parse(readFileSync(join(ROOT, '.capy', 'deploy.json'), 'utf-8'));
    expect(Object.keys(deployJson.targets)).toContain('dokploy-direct');

    const warnings = errorMock.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).toContain('DEPLOY_STALE_KEEP');
  }, 30_000);

  // ── The freshness check must read the untracked working copy
  //    (.capy/keep.lock), not the tracked file frozen at project init ──────
  //
  // The tracked `keep.lock` `setUp()` writes is never rewritten again after
  // it is first created — every regular flow (sync/push/rotate/connect/
  // edit) only ever updates the untracked working copy at
  // `.capy/keep.lock`. If the freshness check read the tracked file
  // directly instead of going through `ProjectManager.readKeepFile()`'s
  // working-copy-first resolution, a repo that had ever synced a new
  // variable after init would look "stale" forever, even though the
  // working copy is exactly what the server has — and deploy/revoke would
  // refuse permanently. These two tests reproduce both directions with a
  // real temp repo and a real `FileManager`: the server snapshot below is
  // independent of either local file (`SERVER_SNAPSHOT_OVERRIDE`), so it
  // can't just agree with whatever the code under test happens to read.
  const noCapyBlockFetchMock = () =>
    mock(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('application.one')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              applicationId: APP_ID,
              name: 'demo-app',
              env: 'NODE_ENV=production', // no Capy block — onRemove reports nothing_to_remove, offer.ok stays true
              buildArgs: null,
              buildSecrets: null,
              createEnvFile: true,
            }),
        };
      }
      throw new Error(`unscripted request: ${url}`);
    });

  /** The tracked keep.lock's exact STRIPE_KEY entry, plus one extra (name, hash) pair — used to build both the "fresh working copy" and "independent server snapshot" fixtures below without duplicating the base shape. */
  function keepWithExtraVar(name: string, hash: string): Record<string, unknown> {
    const tracked = JSON.parse(readFileSync(join(ROOT, 'keep.lock'), 'utf-8'));
    return {
      ...tracked,
      variables: {
        ...tracked.variables,
        [name]: [{ resource_id: `r-${name}`, branch: 'production', value_hash: hash }],
      },
    };
  }

  test('working copy has fresh pins the tracked file lacks, and the server already agrees with the working copy: targets-remove proceeds (not refused)', async () => {
    setUp({ mode: 'direct' });
    revokeDeployTokenMock.mockClear();
    pushSecretsMock.mockClear();

    // A regular sync/push after init added NEW_VAR — written only to the
    // working copy, exactly like every real post-init write. The tracked
    // file (from setUp()) never gets touched again.
    const freshKeep = keepWithExtraVar('NEW_VAR', 'fresh-hash');
    writeFileSync(join(ROOT, '.capy', 'keep.lock'), JSON.stringify(freshKeep));
    // The server's real snapshot already has NEW_VAR too (that's what the
    // earlier push produced) — modeled independently of either local file.
    writeFileSync(join(ROOT, SERVER_SNAPSHOT_OVERRIDE), JSON.stringify(freshKeep));

    const errorMock = mock((..._a: unknown[]) => {});
    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedRemove(noCapyBlockFetchMock(), errorMock),
    );

    expect(code).toBe(0);
    expect(revokeDeployTokenMock).toHaveBeenCalledTimes(1);
    expect(pushSecretsMock).toHaveBeenCalledTimes(1);
    const warnings = errorMock.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).not.toContain('DEPLOY_STALE_KEEP');
  }, 30_000);

  test('working copy is itself stale vs a server that has moved further ahead: targets-remove refuses, with a coded error', async () => {
    setUp({ mode: 'direct' });
    revokeDeployTokenMock.mockClear();
    pushSecretsMock.mockClear();

    // The working copy caught up to NEW_VAR...
    const workingKeep = keepWithExtraVar('NEW_VAR', 'fresh-hash');
    writeFileSync(join(ROOT, '.capy', 'keep.lock'), JSON.stringify(workingKeep));
    // ...but the server has since moved on to an EVEN NEWER pin the working
    // copy was never told about — a genuine staleness the working-copy-
    // first read must still catch.
    const tracked = JSON.parse(readFileSync(join(ROOT, 'keep.lock'), 'utf-8'));
    const serverKeep = {
      ...tracked,
      variables: {
        ...tracked.variables,
        NEW_VAR: [{ resource_id: 'r-NEW_VAR', branch: 'production', value_hash: 'fresh-hash' }],
        EVEN_NEWER_VAR: [{ resource_id: 'r-EVEN_NEWER_VAR', branch: 'production', value_hash: 'newer-hash' }],
      },
    };
    writeFileSync(join(ROOT, SERVER_SNAPSHOT_OVERRIDE), JSON.stringify(serverKeep));

    const errorMock = mock((..._a: unknown[]) => {});
    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedRemove(noCapyBlockFetchMock(), errorMock),
    );

    expect(code).toBe(1);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
    expect(pushSecretsMock).not.toHaveBeenCalled();
    const warnings = errorMock.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnings).toContain('DEPLOY_STALE_KEEP');
  }, 30_000);
});
