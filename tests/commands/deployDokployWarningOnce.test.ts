/**
 * Regression test for a warning triple-print bug: a real `capy deploy` could
 * print one Dokploy warning line THREE times — once from `deployCommand.ts`'s
 * preflight-warnings loop, once from the adapter's own internal `log()` call
 * inside `deploy()`, and once from `renderResult`'s `result.warnings` loop.
 * The fix keeps exactly the first of those. This drives a REAL
 * `deployCommand()` run — not just the adapter in isolation — with a
 * scripted Dokploy backend and asserts the warning line appears exactly once
 * across everything printed.
 *
 * CAP-682 changed WHICH warning this test uses as its vehicle:
 * `DOKPLOY_SHADOWED_VAR` no longer fires at all — a selected var also active
 * outside the block is now COMMENTED OUT by the deploy itself, not warned
 * about (see `tests/deploy/dokploy.test.ts`'s "shadowed outside the block"
 * tests for that new behavior). The dedup regression this file guards
 * against is still real for the warning that DOES survive CAP-682 unchanged
 * — `DOKPLOY_STACK_QUOTES` (a Compose `composeType: 'stack'` target on an
 * old Dokploy version) — so this file now uses that instead, on a Compose
 * target.
 *
 * Auth + the deploy-token mint are mocked (see deployDokploySystemStoreToken.test.ts
 * for the same pattern) so this never touches the real Capy service.
 * `mintDeployToken` is asserted never called — CAP-682: Dokploy mints no
 * deploy token at all.
 * mock.module is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, afterAll, mock, spyOn } from 'bun:test';

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
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
  },
}));
const mintDeployTokenMock = mock(async () => ({
  secretsBlob: 'BLOB_VALUE',
  projectKey: 'KEY_VALUE',
  deployId: 'deploy_1',
  secretCount: 1,
}));
mock.module('../../src/commands/deployTokenCommand', () => ({
  mintDeployToken: mintDeployTokenMock,
}));
afterAll(() => mock.restore());

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deployCommand } from '../../src/commands/deployCommand';
import { mergeManagedValuesBlock } from '../../src/deploy/dokployApi';

const ROOT = join(tmpdir(), `capy-deploy-dokploy-warn-once-${process.pid}-${Date.now()}`);
const COMPOSE_ID = 'compose_test';
const TOKEN_ENV = 'DOKPLOY_API_KEY_WARN_ONCE_TEST';
const RAW_ENV = 'NODE_ENV=production\n';
/** `.env`'s own plaintext value for STRIPE_KEY (see `setUp`) — a fake, non-secret test value. */
const DECRYPTED_STRIPE_KEY = 'whatever';

function mergedEnv(env: string | null): string {
  const merged = mergeManagedValuesBlock(env, [{ name: 'STRIPE_KEY', value: DECRYPTED_STRIPE_KEY }]);
  if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
  return merged.env;
}

const EXPECTED_MERGED_ENV = mergedEnv(RAW_ENV);

function setUp(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, '.capy'), { recursive: true });
  writeFileSync(
    join(ROOT, 'keep.lock'),
    JSON.stringify({
      version: '3.0',
      org_id: 'org_1',
      project_id: 'proj_1',
      project_name: 'demo',
      variables: { STRIPE_KEY: [{ resource_id: 'r-1', branch: 'production', value_hash: 'h' }] },
    }),
  );
  writeFileSync(join(ROOT, '.env'), `STRIPE_KEY=${DECRYPTED_STRIPE_KEY}\n`);
  writeFileSync(
    join(ROOT, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'dokploy-ci': {
          name: 'dokploy-ci',
          kind: 'dokploy',
          branch: 'production',
          vars: ['STRIPE_KEY'],
          mode: 'ci',
          // CAP-682: CI mode preflights autoDeploy/tracked-branch — must
          // match `scriptedDokployFetch`'s `branch: 'main'` fixture.
          gitBaseBranch: 'main',
          options: { baseUrl: 'https://dokploy.example.com', composeId: COMPOSE_ID, tokenEnv: TOKEN_ENV },
        },
      },
    }),
  );
}

function tearDown(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/**
 * `compose.one` is read exactly 3 times in CI mode (preflight, deploy's
 * fresh read, deploy's post-write verify) — RAW_ENV for the first two,
 * EXPECTED_MERGED_ENV once the write has landed. `settings.getDokployVersion`
 * is read once, in preflight, to decide the `DOKPLOY_STACK_QUOTES` warning.
 * A fixed-sequence iterator (the same idea `tests/deploy/dokploy.test.ts`'s
 * own `scripted()` helper uses) hands back each read in order with no
 * mutable variable of our own — only the iterator's own built-in cursor
 * advances.
 */
function scriptedDokployFetch(): typeof fetch {
  const reads = [RAW_ENV, RAW_ENV, EXPECTED_MERGED_ENV][Symbol.iterator]();
  const impl = (async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('compose.saveEnvironment')) {
      const body = JSON.parse(init.body ?? '{}');
      if (body.env !== EXPECTED_MERGED_ENV) {
        throw new Error(`unexpected saveEnvironment body: ${body.env}`);
      }
      return { status: 200, ok: true, text: async () => 'true' };
    }
    if (u.pathname.endsWith('compose.one')) {
      const next = reads.next();
      if (next.done) throw new Error('unscripted extra compose.one read');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            composeId: COMPOSE_ID,
            name: 'demo-compose',
            env: next.value,
            createEnvFile: true,
            composeType: 'stack',
            autoDeploy: true,
            branch: 'main',
          }),
      };
    }
    if (u.pathname.endsWith('settings.getDokployVersion')) {
      return { status: 200, ok: true, text: async () => JSON.stringify('0.30.1') };
    }
    throw new Error(`unscripted Dokploy request: ${init.method} ${url}`);
  }) as unknown as typeof fetch;
  return impl;
}

/** Runs the deploy with console + fetch captured/scripted; always restores both. */
async function runScriptedDeploy(): Promise<{ code: number; lines: readonly string[] }> {
  const lines: string[] = [];
  const record = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  const logSpy = spyOn(console, 'log').mockImplementation(record as never);
  const errSpy = spyOn(console, 'error').mockImplementation(record as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(scriptedDokployFetch() as never);
  try {
    const code = await deployCommand('dokploy-ci', { yes: true }, ROOT);
    return { code, lines };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

describe('capy deploy — a Dokploy warning prints exactly once', () => {
  test('a real (mocked-backend) CI-mode deploy prints the DOKPLOY_STACK_QUOTES warning exactly once', async () => {
    setUp();
    const savedToken = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = 'dk_test_token';

    try {
      const { code, lines } = await runScriptedDeploy();
      expect(code).toBe(0);
      const occurrences = lines.filter((l) => l.includes('arrive at the container wrapped in literal')).length;
      expect(occurrences).toBe(1);
      // CAP-682: no deploy token is minted for Dokploy.
      expect(mintDeployTokenMock).not.toHaveBeenCalled();
    } finally {
      if (savedToken === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = savedToken;
      tearDown();
    }
  }, 30_000);
});
