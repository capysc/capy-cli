/**
 * CI-mode change gate, driven through the REAL `deployCommand()` against a
 * REAL git repo + bare origin (validator fix-first, CAP-679 follow-up
 * item 1: "no CI churn").
 *
 * The property under test: an UNCHANGED CI-mode redeploy must push NOTHING
 * to the platform, open NO PR, and leave keep.lock byte-identical on the
 * base branch — deciding "did anything change" must happen BEFORE anything
 * is written (see `deployCommand.ts#resolveCiGateOutcome` and
 * `targetsGate.ts#deliveryWorthGating`).
 *
 * CAP-682: Dokploy no longer mints a deploy token at all (plain-value
 * delivery), so the ORIGINAL bug this file guarded against — a freshly
 * minted `deploy_id` being folded into the "changed?" decision, which
 * `upsertTargetElement`'s "no untracked tokens" fix (CAP-679) would treat as
 * a real change on EVERY CI run regardless of the secret VALUE — can no
 * longer happen via Dokploy specifically (it never mints anything to fold
 * in). The two tests below were adapted to prove the property that still
 * applies to Dokploy's own plain-value write:
 *   - unchanged → the gate stops the run before ANY Dokploy write.
 *   - a STALE target (secretsScreen's `*` marker) still proceeds to a real
 *     write, rather than getting stuck "unchanged" forever.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 *
 * Only the UNCHANGED case is driven all the way to a PR attempt here. The
 * CHANGED case (a PR gets opened) is covered instead by:
 * `targetsGate.test.ts#deliveryWorthGating` (the decision itself, every
 * branch), and `deployFlow.test.ts`'s "bump a var → PR branch..." e2e test
 * (the worktree/push mechanics) — going through the REAL `deployCommand()`
 * for the changed case would also need a real `gh pr create` to succeed,
 * which fails against this test's throwaway local origin (no actual GitHub
 * repo behind it) for reasons unrelated to the property being tested.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

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

/** CAP-682: mocked purely to prove it is NEVER called — Dokploy mints no deploy token at all. */
const mintDeployTokenMock = mock(async () => ({
  secretsBlob: 'BLOB_VALUE',
  projectKey: 'KEY_VALUE',
  deployId: 'deploy_fresh',
  secretCount: 1,
  blobBytes: 4,
  valueHashes: { STRIPE_KEY: 'unused-by-this-mock' },
}));
mock.module('../../src/commands/deployTokenCommand', () => ({
  mintDeployToken: mintDeployTokenMock,
}));

afterEach(() => mock.restore());

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

const APP_ID = 'app_gate_test';
const TMP = join(tmpdir(), `capy-deploy-ci-gate-${process.pid}`);
const ORIGIN = join(TMP, 'origin.git');
const REPO = join(TMP, 'repo');

/**
 * keep.lock with one variable entry that ALREADY records a prior delivery
 * to (dokploy, dokploy-ci) — the "unchanged" scenario needs this target to
 * have delivered before, with a deploy_id from that prior run, so
 * `deliveryWorthGating` (value-hash + pending only, never deploy_id) has
 * something to compare against and correctly says "nothing changed".
 *
 * `deployedValueHash` defaults to `valueHash` (already delivered, current).
 * Passing a DIFFERENT one models a STALE target — the synced value is
 * already current (`entry.value_hash === valueHash`) but this target never
 * caught up (`target.deployed_value_hash` is still the old one) — the
 * secretsScreen `*` marker, and the re-validation regression this file's
 * "stale target" test guards.
 */
function baseKeepLock(valueHash: string, deployedValueHash: string = valueHash): string {
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
          value_hash: valueHash,
          targets: [
            {
              provider: 'dokploy',
              target: 'dokploy-ci',
              deployed_value_hash: deployedValueHash,
              deployed_at: '2026-01-01T00:00:00.000Z',
              deploy_id: 'deploy_prior',
            },
          ],
        },
      ],
    },
  } as any);
}

const RAW_APP_ENV = 'NODE_ENV=production';

/**
 * Scripted Dokploy fetch. `allowWrite: false` (the UNCHANGED case) only ever
 * scripts `application.one` — preflight's read, no write — and throws
 * loudly on any other call, proving the gate stopped the run before Dokploy
 * saw a write. `allowWrite: true` (the STALE case) additionally scripts a
 * full write cycle: fresh read, `application.saveEnvironment`, and the
 * post-write verify read.
 */
function dokployFetchMock(opts: { allowWrite?: boolean; stripeKeyValue?: string } = {}) {
  const value = opts.stripeKeyValue ?? 'same-value';
  const merged = mergeManagedValuesBlock(RAW_APP_ENV, [{ name: 'STRIPE_KEY', value }]);
  if (!merged.ok) throw new Error('unexpected merge problem in test fixture');
  const reads = [RAW_APP_ENV, RAW_APP_ENV, merged.env][Symbol.iterator]();
  return mock(async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.one')) {
      const next = opts.allowWrite ? reads.next() : { done: false, value: RAW_APP_ENV };
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
            // CAP-682 CI preflight: auto-deploy on, tracking `main` — matches
            // this file's `gitBaseBranch: 'main'` target fixture.
            autoDeploy: true,
            branch: 'main',
          }),
      };
    }
    if (opts.allowWrite && u.pathname.endsWith('application.saveEnvironment')) {
      return { status: 200, ok: true, text: async () => 'true' };
    }
    throw new Error(`unscripted Dokploy request in the UNCHANGED case: ${init.method} ${url}`);
  });
}

/** `deployedValue` defaults to `stripeKeyValue` (already delivered, current) — pass a different value to model a stale target (see `baseKeepLock`'s doc). */
function setUpRepo(stripeKeyValue: string, deployedValue: string = stripeKeyValue): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  git(['init', '--bare', '-b', 'main', ORIGIN], TMP);
  git(['init', '-q', '-b', 'main', REPO], TMP);
  git(['config', 'user.email', 't@e.com'], REPO);
  git(['config', 'user.name', 'T'], REPO);
  git(['config', 'commit.gpgsign', 'false'], REPO);
  git(['remote', 'add', 'origin', ORIGIN], REPO);

  mkdirSync(join(REPO, '.capy'), { recursive: true });
  writeFileSync(join(REPO, 'keep.lock'), baseKeepLock(hashValue(stripeKeyValue), hashValue(deployedValue)));
  writeFileSync(join(REPO, '.env'), `STRIPE_KEY=${stripeKeyValue}\n`);
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
            tokenEnv: 'MY_GATE_TEST_TOKEN', // bypasses the org system store entirely
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

describe('capy deploy — CI mode change gate (validator fix-first: no CI churn)', () => {
  const originalCwd = process.cwd();
  const savedToken = process.env.MY_GATE_TEST_TOKEN;

  beforeEach(() => {
    process.env.MY_GATE_TEST_TOKEN = 'dk_test_token';
    mintDeployTokenMock.mockClear();
    setUpRepo('same-value');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedToken === undefined) delete process.env.MY_GATE_TEST_TOKEN;
    else process.env.MY_GATE_TEST_TOKEN = savedToken;
    tearDownRepo();
  });

  test('CI mode, unchanged values → no write, no push, no PR, keep.lock byte-identical', async () => {
    process.chdir(REPO);

    const beforeKeepLock = readFileSync(join(REPO, 'keep.lock'), 'utf-8');
    const beforeOriginContent = git(['show', 'origin/main:keep.lock'], REPO).stdout;

    const fetchMock = dokployFetchMock();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
    const logMock = mock((..._a: unknown[]) => {});
    const errMock = mock((..._a: unknown[]) => {});
    const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
    const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);

    try {
      const code = await deployCommand('dokploy-ci', { yes: true }, REPO);
      expect(code).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // No token minted at all.
    expect(mintDeployTokenMock).not.toHaveBeenCalled();
    // Dokploy saw ONLY the preflight read — never a write (the scripted fetch
    // throws on anything else, so a nonzero call count with no throw means
    // every call was the one scripted `application.one` read).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('application.one');

    // No PR branch pushed to origin.
    const branches = git(['ls-remote', '--heads', ORIGIN], REPO).stdout;
    expect(branches).not.toContain('capy-deploy-');
    // No local temp branch or stash left behind either.
    expect(git(['branch', '--list', 'capy-deploy-*'], REPO).stdout.trim()).toBe('');
    expect(git(['stash', 'list'], REPO).stdout.trim()).toBe('');

    // keep.lock is byte-identical, both locally and on origin/main.
    const afterKeepLock = readFileSync(join(REPO, 'keep.lock'), 'utf-8');
    expect(afterKeepLock).toBe(beforeKeepLock);
    const afterOriginContent = git(['show', 'origin/main:keep.lock'], REPO).stdout;
    expect(afterOriginContent).toBe(beforeOriginContent);
  }, 30_000);

  // ── Re-validation regression: a STALE target (secretsScreen's `*` marker
  // — the synced value is current, but this target's OWN deployed_value_hash
  // is for an older value it never caught up on) must still gate "proceed",
  // or it stays stale forever. ──
  test('a stale target (synced value unchanged, deployed_value_hash old) still proceeds — writes plain values, never stuck "unchanged" forever', async () => {
    // Overrides this describe's `beforeEach` fixture: same synced value as
    // always, but the target's OWN deployed_value_hash is for a DIFFERENT,
    // older value — exactly what the secretsScreen `*` marker represents.
    setUpRepo('same-value', 'older-value');
    process.chdir(REPO);
    mintDeployTokenMock.mockClear();

    const fetchMock = dokployFetchMock({ allowWrite: true, stripeKeyValue: 'same-value' });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
    const logSpy = spyOn(console, 'log').mockImplementation((() => {}) as never);
    const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);

    try {
      // Not asserting the final exit code: this run may still fail later at
      // a real `gh pr create` against this test's throwaway local origin
      // (see the top-of-file note) — a concern unrelated to the gate
      // property under test here, which is that the write is ATTEMPTED at
      // all rather than the gate reporting "unchanged" forever.
      await deployCommand('dokploy-ci', { yes: true }, REPO);
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // CAP-682: the gate proceeding means a real write was attempted — never
    // a mint (Dokploy mints nothing at all now).
    expect(mintDeployTokenMock).not.toHaveBeenCalled();
    const paths = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => p.includes('application.saveEnvironment'))).toBe(true);
  }, 30_000);
});
