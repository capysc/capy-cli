/**
 * A REAL `deployCommand()` run against a Dokploy CI-mode target whose live env holds a value changed outside Capy
 * (CAP-717, docs/conflict-resolution.md "Platform values"). Same vehicle as deployDokploySystemStoreToken.test.ts:
 * scripted Dokploy over `fetch`, mocked auth and Capy server; bare `capy` (a deploy's first step) is stubbed in
 * agreement, so the only difference here is the PLATFORM one.
 *
 * The properties: off a terminal the deploy stops BEFORE anything is written (exit 3, the payload alone on
 * stdout, Dokploy saw only reads); a rerun with `--resolve NAME@TARGET=local --conflict <id>` delivers Capy's value
 * and comments the outside line out; `remote` keeps the platform's value: nothing written and no delivery
 * recorded; a moved service is STALE.
 *
 * mock.module is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';
import { stubbedGate } from '../helpers/gateMock';

mock.module('../../src/sync/gate', () => stubbedGate());

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
const pushSecretsMock = mock(async (_p: string, keepFileJson: string) => ({ keep_hash: 'h'.repeat(16), keep_file: keepFileJson }));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async getDecryptData() {
      return agreeingDecryptData(JSON.parse(readFileSync(join(ROOT, 'keep.lock'), 'utf-8')), 'production');
    }
    async getLatestSecrets(_p: string, branch: string) {
      const keep = JSON.parse(readFileSync(join(ROOT, 'keep.lock'), 'utf-8'));
      return { env_file: 'STUB', keep_hash: SyncEngine.computeKeepHash(keep, branch), keep_file: JSON.stringify(keep) };
    }
    async pushSecrets(...args: [string, string]) {
      return pushSecretsMock(...args);
    }
  },
}));
mock.module('../../src/crypto/keyResolver', () => fixedKeyResolver());
const mintDeployTokenMock = mock(async () => ({ secretsBlob: 'B', projectKey: 'K', deployId: 'd', secretCount: 1 }));
mock.module('../../src/commands/deployTokenCommand', () => ({ mintDeployToken: mintDeployTokenMock }));
afterEach(() => {
  mock.restore();
  pushSecretsMock.mockClear();
});

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { agreeingDecryptData, fixedKeyResolver } from '../helpers/deployServer';
import { SyncEngine } from '../../src/sync/syncEngine';
import { deployCommand } from '../../src/commands/deployCommand';
import { CAPY_OFF_MARKER, mergeManagedValuesBlock } from '../../src/deploy/dokployApi';
import { hashValue } from '../../src/sync/compareSecrets';

const ROOT = join(tmpdir(), `capy-deploy-target-conflict-${process.pid}-${Date.now()}`);
const APP_ID = 'app_target_conflict';
const TOKEN_ENV = 'TARGET_CONFLICT_TEST_TOKEN';
const DELIVERED = 'delivered-by-capy';
const OUTSIDE = 'edited-on-the-service';
const RAW_ENV = `NODE_ENV=production\nSTRIPE_KEY=${OUTSIDE}\n`;

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
      variables: { STRIPE_KEY: [{ resource_id: 'r-1', branch: 'production', value_hash: hashValue(DELIVERED) }] },
    }),
  );
  writeFileSync(join(ROOT, '.env'), `STRIPE_KEY=${DELIVERED}\n`);
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
          gitBaseBranch: 'main',
          options: { baseUrl: 'https://dokploy.example.com', applicationId: APP_ID, tokenEnv: TOKEN_ENV },
        },
      },
    }),
  );
}

const MERGED = (() => {
  const merged = mergeManagedValuesBlock(RAW_ENV, [{ name: 'STRIPE_KEY', value: DELIVERED }]);
  if (!merged.ok) throw new Error('fixture');
  return merged.env;
})();

/** `application.one` reads from `reads`, in order; `saveEnvironment` accepted (and recorded by the mock's own calls). */
function dokployFetch(reads: readonly string[]) {
  const it = reads[Symbol.iterator]();
  return mock(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('application.saveEnvironment')) return { status: 200, ok: true, text: async () => 'true' };
    if (path.endsWith('application.one')) {
      const next = it.next();
      if (next.done) throw new Error('unscripted extra application.one read');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ applicationId: APP_ID, name: 'demo-app', env: next.value, buildArgs: null, buildSecrets: null, createEnvFile: true, autoDeploy: true, branch: 'main' }),
      };
    }
    throw new Error(`unscripted Dokploy request: ${path}`);
  });
}

async function run(fetchMock: ReturnType<typeof dokployFetch>, options: Parameters<typeof deployCommand>[1] = { yes: true }) {
  const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
  const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  const saved = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = 'dk_test_token';
  try {
    const code = await deployCommand('dokploy-ci', options, ROOT);
    return { code, stdout: logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n'), stderr: errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n') };
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = saved;
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

const writes = (f: ReturnType<typeof dokployFetch>) => f.mock.calls.filter((c) => String(c[0]).endsWith('saveEnvironment'));

describe('capy deploy: a Dokploy value changed outside Capy', () => {
  test('off a terminal: exit 3, the payload alone on stdout, and Dokploy was only READ', async () => {
    setUp();
    const f = dokployFetch([RAW_ENV, RAW_ENV]); // preflight, the comparison
    const out = await run(f);
    expect(out.code).toBe(3);
    const payload = JSON.parse(out.stdout) as { ok: boolean; code: string; conflict_id: string; conflicts: Array<Record<string, unknown>> };
    expect(payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(payload.conflict_id).toMatch(/^c_[0-9a-f]{12}$/);
    expect(payload.conflicts).toEqual([
      { name: 'STRIPE_KEY', target: 'dokploy-ci', pinned: null, local: hashValue(DELIVERED), remote: hashValue(OUTSIDE) },
    ]);
    expect(`${out.stdout}${out.stderr}`).not.toContain(OUTSIDE);
    expect(`${out.stdout}${out.stderr}`).not.toContain(DELIVERED);
    expect(writes(f)).toHaveLength(0);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    rmSync(ROOT, { recursive: true, force: true });
  }, 30_000);

  test('local: delivered, the outside line commented out as `# capy:off`', async () => {
    setUp();
    const first = JSON.parse((await run(dokployFetch([RAW_ENV, RAW_ENV]))).stdout) as { conflict_id: string };
    // preflight, the comparison, deploy's fresh read, the read-back.
    const f = dokployFetch([RAW_ENV, RAW_ENV, RAW_ENV, MERGED]);
    const out = await run(f, { yes: true, conflictFlags: { resolve: ['STRIPE_KEY@dokploy-ci=local'], conflict: first.conflict_id } });
    expect(out.code).toBe(0);
    expect(writes(f)).toHaveLength(1);
    expect(JSON.parse(String(writes(f)[0][1].body)).env).toContain(`${CAPY_OFF_MARKER}STRIPE_KEY=${OUTSIDE}`);
    rmSync(ROOT, { recursive: true, force: true });
  }, 30_000);

  test('remote: nothing is written to the service and no delivery is recorded', async () => {
    setUp();
    const first = JSON.parse((await run(dokployFetch([RAW_ENV, RAW_ENV]))).stdout) as { conflict_id: string };
    const f = dokployFetch([RAW_ENV, RAW_ENV]); // the variable was the only one: the run ends after the comparison
    const out = await run(f, { yes: true, conflictFlags: { resolve: ['STRIPE_KEY@dokploy-ci=remote'], conflict: first.conflict_id } });
    expect(out.code).toBe(0);
    expect(writes(f)).toHaveLength(0);
    expect(pushSecretsMock).not.toHaveBeenCalled();
    rmSync(ROOT, { recursive: true, force: true });
  }, 30_000);

  test('the service moved after the conflict was seen: STALE, a new id, nothing written', async () => {
    setUp();
    const first = JSON.parse((await run(dokployFetch([RAW_ENV, RAW_ENV]))).stdout) as { conflict_id: string };
    const moved = `NODE_ENV=production\nSTRIPE_KEY=edited-again\n`;
    const f = dokployFetch([moved, moved]);
    const out = await run(f, { yes: true, conflictFlags: { resolve: ['STRIPE_KEY@dokploy-ci=local'], conflict: first.conflict_id } });
    expect(out.code).toBe(3);
    const payload = JSON.parse(out.stdout) as { code: string; conflict_id: string };
    expect(payload.code).toBe('SECRETS_CONFLICT_STALE');
    expect(payload.conflict_id).not.toBe(first.conflict_id);
    expect(writes(f)).toHaveLength(0);
    rmSync(ROOT, { recursive: true, force: true });
  }, 30_000);

  test('--dry-run reports the same conflict_id and writes nothing', async () => {
    setUp();
    const real = JSON.parse((await run(dokployFetch([RAW_ENV, RAW_ENV]))).stdout) as { conflict_id: string };
    const f = dokployFetch([RAW_ENV, RAW_ENV]);
    const out = await run(f, { yes: true, dryRun: true });
    expect(out.code).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: real.conflict_id });
    expect(writes(f)).toHaveLength(0);
    rmSync(ROOT, { recursive: true, force: true });
  }, 30_000);
});
