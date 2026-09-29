/**
 * Superseded deploy-token revocation wiring (validator fix-first, CAP-679
 * follow-up item 2) — driven through the REAL `deployCommand()`/`deployRemove()`
 * in DIRECT mode, with a mocked ServiceClient/adapter fetch. Asserts the
 * PROPERTY (which ids `revokeDeployToken` is called with, and how many
 * times), never the shape of some intermediate object.
 *
 * Every crypto/key-resolution dependency `pushKeepTransform` touches
 * (`resolveProjectKey`, `Encryptor`, `deriveResourceId`) is mocked to a
 * trivial fake — this file is about the REVOKE WIRING, not real crypto,
 * which is already covered elsewhere (`tests/crypto/*`, `tests/system/systemStore.test.ts`).
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

/** Default fixture — individual tests override the deployId via `mockImplementationOnce` (bun's own reconfiguration API, not a mutable var this file owns). */
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

/** Queues one mint result with the given deployId — a thin wrapper over `mockImplementationOnce` so every test reads the same one-liner. */
function mintNext(deployId: string): void {
  mintDeployTokenMock.mockImplementationOnce(async () => ({
    secretsBlob: 'BLOB_VALUE',
    projectKey: 'KEY_VALUE',
    deployId,
    secretCount: 1,
    blobBytes: 4,
    valueHashes: { STRIPE_KEY: 'hv' },
  }));
}

afterEach(() => mock.restore());

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deployCommand, deployRemove } from '../../src/commands/deployCommand';
import { splitManagedBlock, mergeManagedBlock } from '../../src/deploy/dokployApi';

const ROOT = join(tmpdir(), `capy-deploy-revoke-wiring-${process.pid}-${Date.now()}`);
const APP_ID = 'app_revoke_test';
const RAW_ENV = 'STRIPE_KEY=stale\n';

function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

/**
 * `deploy.json` + keep.lock with STRIPE_KEY's entry already recording a
 * PRIOR (direct-mode) delivery to (dokploy, dokploy-direct) via `deploy_id:
 * 'dep_prior'` — the id a successful new deploy should supersede and then
 * revoke. `priorSuperseded` lets a test seed an ALREADY-superseded id too,
 * to prove `targets-remove` revokes both current and superseded together.
 */
function setUp(opts: { mode?: 'ci' | 'direct'; priorSuperseded?: string[] } = {}): void {
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
function dokployFetchMock(
  newPair: { secretsBlob: string; projectKey: string },
  opts: { failWrite?: boolean; realDeploy?: boolean } = {},
) {
  const expectedMergedEnv = mergedEnv(RAW_ENV, newPair);
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
): Promise<number> {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  try {
    return await deployCommand('dokploy-direct', options, ROOT);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

const NEW_PAIR = { secretsBlob: 'BLOB_VALUE', projectKey: 'KEY_VALUE' };

describe('capy deploy — superseded deploy-token revocation wiring (validator fix-first)', () => {
  afterEach(() => tearDown());

  test('a successful REAL direct-mode deploy revokes exactly the superseded id(s)', async () => {
    setUp({ mode: 'direct' });
    mintNext('dep_new');
    revokeDeployTokenMock.mockClear();

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock(NEW_PAIR, { realDeploy: true })),
    );
    expect(code).toBe(0);

    // The property: revoked with EXACTLY the id the fresh deploy superseded
    // — never zero, never more, never the wrong id.
    expect(revokeDeployTokenMock).toHaveBeenCalledTimes(1);
    expect(revokeDeployTokenMock.mock.calls.map((c) => c[0])).toEqual(['dep_prior']);
  }, 30_000);

  test('--no-deploy: never revokes — the predecessor may still be the one actually running', async () => {
    setUp({ mode: 'direct' });
    mintNext('dep_pending');
    revokeDeployTokenMock.mockClear();

    // --no-deploy still writes the config (that's the point — the target is
    // verified and the runtime pair lands on the platform) but skips the
    // trigger+poll steps entirely (`ctx.noDeploy` short-circuits BEFORE the
    // `deployment.all` baseline read — see adapters/dokploy.ts). The fetch
    // mock never scripts `deployment.all`/`application.deploy`; it would
    // throw if called, proving the actual redeploy trigger never happens.
    const fetchMock = dokployFetchMock(NEW_PAIR);

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(fetchMock, { yes: true, noDeploy: true }),
    );
    expect(code).toBe(0);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  }, 30_000);

  test('a FAILED adapter deploy never revokes', async () => {
    setUp({ mode: 'direct' });
    mintNext('dep_new');
    revokeDeployTokenMock.mockClear();

    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock(NEW_PAIR, { failWrite: true })),
    );
    expect(code).toBe(1);
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  }, 30_000);

  test('CI mode never revokes — recordDeployTargets/revoke are direct-mode only', async () => {
    setUp({ mode: 'ci' });
    mintNext('dep_new');
    revokeDeployTokenMock.mockClear();

    // CI mode's own gate would decrypt via decryptCurrentBranch — no git
    // repo here means `gitOk` is false, so the gate is skipped entirely and
    // this runs the old, ungated CI path straight through (mirrors every
    // OTHER `mode: 'ci'` test in deployDokploySystemStoreToken.test.ts,
    // none of which git-init their ROOT either).
    const code = await withEnv({ MY_REVOKE_TEST_TOKEN: 'dk_token' }, () =>
      runScriptedDeploy(dokployFetchMock(NEW_PAIR)),
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
});
