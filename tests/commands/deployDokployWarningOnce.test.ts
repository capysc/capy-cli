/**
 * Regression test for the DOKPLOY_SHADOWED_VAR triple-print bug: a real
 * `capy deploy` used to print "<var> is also set in Dokploy..." three times —
 * once from `deployCommand.ts`'s preflight-warnings loop, once from the
 * adapter's own internal `log()` call inside `deploy()`, and once from
 * `renderResult`'s `result.warnings` loop. The fix keeps exactly the first of
 * those; this drives a REAL `deployCommand()` run — not just the adapter in
 * isolation — with a scripted Dokploy backend and asserts the warning line
 * appears exactly once across everything printed.
 *
 * Auth + the deploy-token mint are mocked (see mintDeployTokenScope.test.ts
 * for the same pattern) so this never touches the real Capy service.
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
mock.module('../../src/commands/deployTokenCommand', () => ({
  mintDeployToken: async () => ({
    secretsBlob: 'BLOB_VALUE',
    projectKey: 'KEY_VALUE',
    deployId: 'deploy_1',
    secretCount: 1,
  }),
}));
afterAll(() => mock.restore());

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deployCommand } from '../../src/commands/deployCommand';
import { splitManagedBlock, mergeManagedBlock } from '../../src/deploy/dokployApi';

const ROOT = join(tmpdir(), `capy-deploy-dokploy-warn-once-${process.pid}-${Date.now()}`);
const APP_ID = 'app_test';
const TOKEN_ENV = 'DOKPLOY_API_KEY_WARN_ONCE_TEST';
const RAW_ENV = 'STRIPE_KEY=stale\n';

function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

const EXPECTED_MERGED_ENV = mergedEnv(RAW_ENV, { secretsBlob: 'BLOB_VALUE', projectKey: 'KEY_VALUE' });

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
  writeFileSync(join(ROOT, '.env'), 'STRIPE_KEY=whatever\n');
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
          options: { baseUrl: 'https://dokploy.example.com', applicationId: APP_ID, tokenEnv: TOKEN_ENV },
        },
      },
    }),
  );
}

function tearDown(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/**
 * `application.one` is read exactly 3 times in CI mode (preflight, deploy's
 * fresh read, deploy's post-write verify) — RAW_ENV for the first two,
 * EXPECTED_MERGED_ENV once the write has landed. A fixed-sequence iterator
 * (the same idea `tests/deploy/dokploy.test.ts`'s own `scripted()` helper
 * uses) hands back each read in order with no mutable variable of our own —
 * only the iterator's own built-in cursor advances.
 */
function scriptedDokployFetch(): typeof fetch {
  const reads = [RAW_ENV, RAW_ENV, EXPECTED_MERGED_ENV][Symbol.iterator]();
  const impl = (async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.saveEnvironment')) {
      const body = JSON.parse(init.body ?? '{}');
      if (body.env !== EXPECTED_MERGED_ENV) {
        throw new Error(`unexpected saveEnvironment body: ${body.env}`);
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

describe('capy deploy — DOKPLOY_SHADOWED_VAR prints exactly once', () => {
  test('a real (mocked-backend) CI-mode deploy prints the shadow warning exactly once', async () => {
    setUp();
    const savedToken = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = 'dk_test_token';

    try {
      const { code, lines } = await runScriptedDeploy();
      expect(code).toBe(0);
      const occurrences = lines.filter((l) => l.includes('set in Dokploy too')).length;
      expect(occurrences).toBe(1);
    } finally {
      if (savedToken === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = savedToken;
      tearDown();
    }
  }, 30_000);
});
