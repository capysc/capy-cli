/**
 * A REAL `deployCommand()` run against a Dokploy CI-mode target, proving the
 * org system store wiring (CAP-664) end to end — not just the adapter in
 * isolation (see `tests/deploy/dokploy.test.ts` and
 * `tests/deploy/dokployApiKey.test.ts` for that). Same pattern as
 * `deployDokployWarningOnce.test.ts`: auth + the deploy-token mint are
 * mocked so this never touches the real Capy service.
 *
 * `mock.module('../../src/system/systemStore', ...)` is set up FRESH inside
 * each test (not once at module scope) so every scenario gets its own
 * `getConnectorSecret` behavior with no shared mutable state of our own —
 * bun's mock registry (and its spy functions' own `.mock.calls`) hold all of
 * it; this file only ever READS those, via `.map`/`.every`/`.some`, never
 * pushes into anything itself.
 *
 * mock.module is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';

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
afterEach(() => mock.restore());

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deployCommand, deployRemove } from '../../src/commands/deployCommand';
import { splitManagedBlock, mergeManagedBlock } from '../../src/deploy/dokployApi';

const ROOT = join(tmpdir(), `capy-deploy-dokploy-store-token-${process.pid}-${Date.now()}`);
const ROOT_NO_KEEP = join(tmpdir(), `capy-deploy-dokploy-store-token-no-keep-${process.pid}-${Date.now()}`);
const APP_ID = 'app_test';
const RAW_ENV = 'STRIPE_KEY=stale\n';

function mergedEnv(env: string | null, pair: { secretsBlob: string; projectKey: string }): string {
  const split = splitManagedBlock(env);
  if ('code' in split) throw new Error('unexpected problem');
  return mergeManagedBlock(split, pair);
}

const EXPECTED_MERGED_ENV = mergedEnv(RAW_ENV, { secretsBlob: 'BLOB_VALUE', projectKey: 'KEY_VALUE' });

function setUp(targetOptions: Record<string, unknown>): void {
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
          options: { baseUrl: 'https://dokploy.example.com', applicationId: APP_ID, ...targetOptions },
        },
      },
    }),
  );
}

function tearDown(): void {
  rmSync(ROOT, { recursive: true, force: true });
}

/**
 * NO keep.lock anywhere — proves `deployRemove` doesn't need
 * `readKeep(cwd)?.orgId` to reach the org system store: `orgId` is a hint
 * `resolveDokployApiKeyOnce` passes through when it has one, but
 * `getConnectorSecret` → `openSystemStore` resolves the org itself
 * (`resolveOrgContext`) when it doesn't.
 */
function setUpNoKeepLock(targetOptions: Record<string, unknown>): void {
  rmSync(ROOT_NO_KEEP, { recursive: true, force: true });
  mkdirSync(join(ROOT_NO_KEEP, '.capy'), { recursive: true });
  writeFileSync(
    join(ROOT_NO_KEEP, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'dokploy-ci': {
          name: 'dokploy-ci',
          kind: 'dokploy',
          branch: 'production',
          vars: ['STRIPE_KEY'],
          mode: 'ci',
          options: { baseUrl: 'https://dokploy.example.com', applicationId: APP_ID, ...targetOptions },
        },
      },
    }),
  );
}

function tearDownNoKeepLock(): void {
  rmSync(ROOT_NO_KEEP, { recursive: true, force: true });
}

/**
 * The REAL `deployCommand()` path reads `process.env` directly for the
 * Dokploy token (no injectable `env` dep at that layer — see
 * `resolveDokployApiKeyOnce` in `deployCommand.ts`), so proving env-var
 * behavior through a real run means mutating it, the same reason
 * `deployDokployWarningOnce.test.ts` does. Centralized to this one
 * save/restore instead of one per test: every var named in `vars` is set (or
 * deleted, for `undefined`) before `fn`, and put back to exactly what it was
 * before, even if `fn` throws.
 */
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

/**
 * Fakes a real TTY on stdin — `bun test` never has one — so a test can
 * prove `--web`/`--yes`/`--dry-run` suppress the store's prompt EVEN THOUGH
 * a real terminal is present, not merely because there is no terminal to
 * begin with. Same technique `tests/commands/connectDokploy.test.ts` uses.
 */
async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
  }
}

/**
 * A fake system store mirroring the REAL `getConnectorSecret`'s
 * interactive-gated contract (`system/systemStore.ts`): an existing `entry`
 * is returned with no prompt; a missing one is prompted for (and saved)
 * ONLY when `opts.interactive` is true, exactly like the real store. Built
 * from two bun spies (`promptFn`/`writeFn`) so "zero prompt calls" / "zero
 * store writes" are read off THEM — bun's own accumulator — never a counter
 * this file owns.
 */
function fakeSystemStore(entry: string | null) {
  const promptFn = mock(async () => 'prompted-value');
  const writeFn = mock(async (_value: string) => {});
  const getConnectorSecret = mock(async (_name: string, opts: { interactive: boolean }) => {
    if (entry !== null) return entry;
    if (!opts.interactive) return null;
    const value = await promptFn();
    await writeFn(value);
    return value;
  });
  return { getConnectorSecret, promptFn, writeFn };
}

/**
 * `application.one` is read exactly 3 times in a SUCCESSFUL CI-mode deploy
 * (preflight, deploy's fresh read, deploy's post-write verify) — RAW_ENV for
 * the first two, the merged env once the write has landed. A fixed-sequence
 * iterator (same idea `tests/deploy/dokploy.test.ts`'s own `scripted()`
 * helper and `deployDokployWarningOnce.test.ts` use) hands back each read in
 * order — no mutable variable of our own, only the iterator's own built-in
 * cursor advances. A refusal never reaches most of these reads at all, which
 * is exactly what "zero Dokploy requests" tests below assert via the spy's
 * own call count instead.
 */
function dokployFetchMock() {
  const reads = [RAW_ENV, RAW_ENV, EXPECTED_MERGED_ENV][Symbol.iterator]();
  return mock(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.saveEnvironment')) {
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
  });
}

interface DeployRunResult {
  code: number;
  lines: readonly string[];
  /** Every Dokploy request's `x-api-key` header, in call order — read off the spy, never accumulated by us. */
  seenApiKeys: readonly string[];
  requestCount: number;
}

/**
 * Runs the deploy with console + fetch captured; always restores both.
 * `logMock`/`errMock` are bun spies — their `.mock.calls` is bun's OWN
 * accumulator, never ours, so reading `lines` afterward is a pure `.map`
 * over calls that already happened, not a push into something we own.
 */
async function runScriptedDeploy(
  options: Parameters<typeof deployCommand>[1] = { yes: true },
): Promise<DeployRunResult> {
  const logMock = mock((..._a: unknown[]) => {});
  const errMock = mock((..._a: unknown[]) => {});
  const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
  const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);
  const fetchMock = dokployFetchMock();
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  try {
    const code = await deployCommand('dokploy-ci', options, ROOT);
    return {
      code,
      lines: [...logMock.mock.calls, ...errMock.mock.calls].map((args) => args.map(String).join(' ')),
      seenApiKeys: fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers['x-api-key']),
      requestCount: fetchMock.mock.calls.length,
    };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

describe('capy deploy dokploy — org system store token resolution (CAP-664)', () => {
  test('a system-store entry is resolved ONCE and reused across preflight + deploy; never printed', async () => {
    setUp({});
    const SENTINEL = 'sk_capy_e2e_never_leak_7a1';
    const getConnectorSecret = mock(async () => SENTINEL);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code, lines, seenApiKeys, requestCount } = await runScriptedDeploy();
      expect(code).toBe(0);
      // Resolved once for the whole command, reused by every adapter call
      // that needed it (preflight, deploy) — never asked twice.
      expect(getConnectorSecret).toHaveBeenCalledTimes(1);
      expect(requestCount).toBeGreaterThan(0);
      expect(seenApiKeys.every((k) => k === SENTINEL)).toBe(true);
      expect(lines.some((l) => l.includes(SENTINEL))).toBe(false);
    } finally {
      tearDown();
    }
  }, 30_000);

  test('missing everywhere + non-interactive: refused, zero Dokploy requests', async () => {
    setUp({});
    const getConnectorSecret = mock(async () => null);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code, requestCount } = await withEnv({ DOKPLOY_API_KEY: undefined }, runScriptedDeploy);
      expect(code).toBe(1);
      expect(requestCount).toBe(0);
    } finally {
      tearDown();
    }
  }, 30_000);

  test('a non-admin store refusal with no env fallback: refused, zero Dokploy requests', async () => {
    setUp({});
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code, lines, requestCount } = await withEnv({ DOKPLOY_API_KEY: undefined }, runScriptedDeploy);
      expect(code).toBe(1);
      expect(requestCount).toBe(0);
      expect(lines.some((l) => l.toLowerCase().includes('admin'))).toBe(true);
    } finally {
      tearDown();
    }
  }, 30_000);

  test('a non-admin store refusal still falls back to the default env var when it is set', async () => {
    setUp({});
    const getConnectorSecret = mock(async () => {
      throw { code: 'SYSTEM_STORE_ADMIN_ONLY' };
    });
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code, seenApiKeys } = await withEnv({ DOKPLOY_API_KEY: 'env-fallback-token' }, runScriptedDeploy);
      expect(code).toBe(0);
      expect(seenApiKeys.every((k) => k === 'env-fallback-token')).toBe(true);
    } finally {
      tearDown();
    }
  }, 30_000);

  test('an explicit tokenEnv on the target, set in env, wins outright — the store is never called', async () => {
    setUp({ tokenEnv: 'MY_DOKPLOY_TOKEN_STORE_TEST' });
    const getConnectorSecret = mock(async () => 'store-token-should-not-be-used');
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code, seenApiKeys } = await withEnv(
        { MY_DOKPLOY_TOKEN_STORE_TEST: 'explicit-env-token' },
        runScriptedDeploy,
      );
      expect(code).toBe(0);
      expect(seenApiKeys.every((k) => k === 'explicit-env-token')).toBe(true);
      expect(getConnectorSecret).not.toHaveBeenCalled();
    } finally {
      tearDown();
    }
  }, 30_000);

  test('capy deploy targets-remove reaches the org system store even from a cwd with no keep.lock', async () => {
    setUpNoKeepLock({});
    const { getConnectorSecret } = fakeSystemStore('resolved-without-keep-lock');
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

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
              env: 'NODE_ENV=production', // no Capy block — onRemove reports nothing_to_remove
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
      const code = await deployRemove('dokploy-ci', ROOT_NO_KEEP, {});
      expect(code).toBe(0);
      // `orgId` passed down from `deployRemove` was `undefined` here (no
      // keep.lock at all in this cwd) — the store was still reached, which
      // can only be `getConnectorSecret`'s OWN org resolution
      // (`openSystemStore` → `resolveOrgContext`) doing the work, not a
      // keep.lock this cwd never had.
      expect(getConnectorSecret).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      tearDownNoKeepLock();
    }
  }, 30_000);

  test('--dry-run: an empty store makes zero prompt calls and zero store writes, and reports the coded refusal', async () => {
    setUp({});
    const { getConnectorSecret, promptFn, writeFn } = fakeSystemStore(null);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      // A real TTY, so the ONLY thing that can be suppressing the prompt is
      // `--dry-run` itself — proving the flag, not the absence of a terminal.
      const { code, requestCount } = await withTTY(() =>
        withEnv({ DOKPLOY_API_KEY: undefined }, () => runScriptedDeploy({ yes: false, dryRun: true })),
      );
      expect(code).toBe(1);
      expect(requestCount).toBe(0);
      expect(promptFn).not.toHaveBeenCalled();
      expect(writeFn).not.toHaveBeenCalled();
    } finally {
      tearDown();
    }
  }, 30_000);

  test('a malformed target makes zero prompt calls — and zero store contact at all', async () => {
    // baseUrl is not a URL: `dokployConnectionProblem` fails before
    // `resolveDokployApiKeyOnce` ever calls the store.
    setUp({ baseUrl: 'not a url' });
    const { getConnectorSecret, promptFn, writeFn } = fakeSystemStore(null);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code } = await withTTY(() => withEnv({ DOKPLOY_API_KEY: undefined }, () => runScriptedDeploy()));
      expect(code).toBe(1);
      expect(getConnectorSecret).not.toHaveBeenCalled();
      expect(promptFn).not.toHaveBeenCalled();
      expect(writeFn).not.toHaveBeenCalled();
    } finally {
      tearDown();
    }
  }, 30_000);

  test('--web: a real TTY does not let the store prompt — refused, coded, zero prompt calls', async () => {
    setUp({});
    const { getConnectorSecret, promptFn } = fakeSystemStore(null);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code } = await withTTY(() =>
        withEnv({ DOKPLOY_API_KEY: undefined }, async () => ({
          code: await deployCommand('dokploy-ci', { yes: true, web: true }, ROOT),
        })),
      );
      expect(code).toBe(1);
      expect(promptFn).not.toHaveBeenCalled();
    } finally {
      tearDown();
    }
  }, 30_000);

  test('--yes: a real TTY does not let the store prompt — refused, coded, zero prompt calls', async () => {
    setUp({});
    const { getConnectorSecret, promptFn } = fakeSystemStore(null);
    mock.module('../../src/system/systemStore', () => ({ getConnectorSecret }));

    try {
      const { code } = await withTTY(() =>
        withEnv({ DOKPLOY_API_KEY: undefined }, async () => ({
          code: await deployCommand('dokploy-ci', { yes: true }, ROOT),
        })),
      );
      expect(code).toBe(1);
      expect(promptFn).not.toHaveBeenCalled();
    } finally {
      tearDown();
    }
  }, 30_000);

  // "The resolve-once property through the --edit re-preflight loop" —
  // NOT driven here. That loop only runs when `!options.yes && !options.dryRun`,
  // and its confirm/edit prompt is `ui/keypressConfirm.ts`: it reads ONE raw
  // keypress directly off `process.stdin` with no injectable override, and
  // calls `stdin.setRawMode(true)` whenever `stdin.isTTY` is true — faking
  // `isTTY` (as `withTTY` above does) would make it call `setRawMode` on a
  // stream that isn't actually a TTY-backed one, which throws rather than
  // accepting scripted keystrokes. There is no lower-level seam to script
  // "press e" the way `withTTY` scripts "a terminal is present" for a
  // boolean check.
  //
  // The property holds by construction instead: `deployCommand()` calls
  // `resolveDokployApiKeyOnce` exactly ONCE, before the confirm loop even
  // starts, and stores the result in `adapterCallCtx` — a plain `const`
  // spread into BOTH the initial `preflight()` call and the edit loop's
  // `recheck` `preflight()` call (`src/commands/deployCommand.ts`, the
  // `case 'edit':` branch). Nothing between those two calls re-invokes the
  // resolver; there is only the one call site in the whole function. The
  // "resolved once, reused by preflight + deploy" test above already proves
  // that ONE resolution serves two different adapter calls in a single run
  // — the edit loop's `recheck` is a third call to the exact same adapter
  // method, fed the exact same already-resolved value by the exact same
  // mechanism, not a different code path.
});
