/**
 * `capy connect dokploy --discover` MUST reach discovery from a directory
 * with no keep.lock — an uninitialized clone, or a parent folder of repos —
 * without ever calling `resolveContext()`, which exits `process` with "No
 * keep.lock found" outside an already-initialized project.
 *
 * `ConnectCommand.execute()` resolves discovery's OWN, lighter context
 * (`resolveDiscoveryContext` → `resolveOrgContext`) BEFORE the `effective.
 * discover && mod.discover` check falls through to the ordinary
 * `resolveContext()` call. Proving that ordering end to end needs
 * `resolveOrgContext` to resolve WITHOUT a real cached session or a live
 * OAuth flow — `mock.module()` on `core/orgContext.ts` is the only way to
 * get that hermetically, which is why this one file needs isolation (see
 * `tests/run-tests.sh`'s `ISOLATED_FILES`) while the rest of the discovery
 * suite (`connectDokployDiscovery.test.ts`) does not.
 *
 * The property under test: `execute()` reaches `mod.discover(...)` (proven
 * by a normal RETURN — some coded key-resolution refusal, reached only from
 * inside `discover()`, well past the routing check; the exact code doesn't
 * matter here) with `process.exit` never called — the tell for
 * "`resolveContext` ran and exited", which it always does on a missing
 * keep.lock, never returning at all. The fake org context's `serviceClient`
 * is an empty object on purpose: any attempt to reach the org system store
 * for the key throws LOCALLY (a missing method), so this makes zero real
 * network calls either way.
 *
 * Discovery hands the system store an explicit `orgId`, and on that path
 * `openSystemStoreContext` builds its OWN `AuthService` rather than using
 * the fake context above. Left real, that service refreshes against the
 * live API and then falls through to a loopback OAuth login — binding
 * 127.0.0.1:19420-19424 and waiting five minutes for a browser. Both of its
 * entry points are stubbed to a coded `no_session` failure for this whole
 * file, so the store refuses with `AUTH_FAILED` instantly and locally.
 */
import { mock, describe, test, expect, spyOn, afterAll } from 'bun:test';
import { withEnv, withTty } from '../helpers/processState';
import { join } from 'node:path';

const FAKE_ORG_CONTEXT = {
  orgId: 'org_routing_test',
  userId: 'user_routing_test',
  userEmail: 'routing-test@example.com',
  authService: {},
  serviceClient: {},
};

// Registered BEFORE `connectCommand.ts` (or anything it imports) is ever
// loaded — `resolveOrgContext` never touches a cached session file or a
// real OAuth flow in this process.
mock.module(join(import.meta.dir, '../../src/core/orgContext.ts'), () => ({
  resolveOrgContext: async () => FAKE_ORG_CONTEXT,
}));

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AuthService } from '../../src/auth/authService';
import { ConnectCommand } from '../../src/commands/connectCommand';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { AuthResult } from '../../src/types/index';

/** Thrown by the `process.exit` stub so the test can tell "exited" apart from any other error by type. */
class ProcessExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const NO_SESSION: AuthResult = { success: false, error: 'No valid session available', error_code: 'no_session' };
const silentAuthSpy = spyOn(AuthService.prototype, 'authenticateSilent').mockResolvedValue(NO_SESSION);
const interactiveAuthSpy = spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(NO_SESSION);

afterAll(() => {
  silentAuthSpy.mockRestore();
  interactiveAuthSpy.mockRestore();
  mock.restore();
});

describe('ConnectCommand.execute() --discover routing (isolated: mock.module on resolveOrgContext)', () => {
  test('discover:true, dryRun:true from a dir with NO keep.lock reaches discovery — never calls resolveContext / process.exit', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-routing-'));
    const originalCwd = process.cwd();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) should not have been called — resolveContext must never run for --discover`);
    }) as never);
    // The coded refusal below sets `process.exitCode = 1` (correct for the
    // real CLI), but that is a process-wide global this test run does not
    // own — left set, it makes the WHOLE `bun test` process for this file
    // exit 1 later even though every assertion here passes (same footgun
    // `connectDokploy.test.ts`'s own refusal-path test guards against).
    const savedExitCode = process.exitCode;
    try {
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
      process.chdir(ROOT);

      const cmd = new ConnectCommand(false);
      const result = await cmd.execute('dokploy', {
        discover: true,
        dryRun: true,
        nonTty: true,
        baseUrl: 'https://dokploy.example.com',
        tokenEnv: 'CAPY_DISCOVERY_ROUTING_TEST_MISSING_TOKEN', // deliberately unset — refuses before any Dokploy request
      } as ConnectOpts);

      // Reached `discover()` (past the routing check, resolving the
      // LIGHTER `DiscoveryContext` — never `resolveContext()`, which would
      // have exited on the missing keep.lock long before token resolution).
      expect(result).toEqual({ linked: false });
    } finally {
      process.chdir(originalCwd);
      exitSpy.mockRestore();
      process.exitCode = savedExitCode ?? 0;
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('sanity check: the SAME missing-keep.lock directory, WITHOUT --discover, does exit via resolveContext', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-routing-sanity-'));
    const originalCwd = process.cwd();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitCalled(code);
    }) as never);
    try {
      process.chdir(ROOT);
      const cmd = new ConnectCommand(false);
      await cmd
        .execute('dokploy', { nonTty: true, baseUrl: 'https://d', application: 'app_1', tokenEnv: 'T' } as ConnectOpts)
        .catch((err: unknown) => {
          if (!(err instanceof ProcessExitCalled)) throw err;
        });
      // Proves the detector actually works: the single-service path (no
      // `--discover`) DOES hit `resolveContext()`'s "no keep.lock" exit —
      // the routing test above is catching a REAL ordering, not a fixture
      // that would pass no matter what.
      expect(exitSpy.mock.calls.map(([code]) => code)).toEqual([1]);
    } finally {
      process.chdir(originalCwd);
      exitSpy.mockRestore();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── CAP-703: --discover ALWAYS prints JSON and never prompts, in a terminal or not ──

describe('ConnectCommand.execute() --discover is always JSON and never prompts (CAP-703)', () => {
  test('a real TTY and no base URL: no prompt — one JSON refusal on stdout, nothing prose on stderr', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-json-tty-'));
    const originalCwd = process.cwd();
    const savedExitCode = process.exitCode;
    const logMock = mock((..._a: unknown[]) => {});
    const errMock = mock((..._a: unknown[]) => {});
    const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
    const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);
    try {
      process.chdir(ROOT);
      const result = await withTty({ stdin: true }, () => new ConnectCommand(false).execute('dokploy', { discover: true } as ConnectOpts));
      expect(result).toEqual({ linked: false });
      expect(logMock).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(logMock.mock.calls[0][0]));
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('DOKPLOY_SETTINGS_MISSING');
      expect(errMock).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
      process.exitCode = savedExitCode ?? 0;
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('a real TTY, a dry run that reaches Dokploy: stdout is exactly one JSON document (what --json prints)', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-json-dry-'));
    const originalCwd = process.cwd();
    const logMock = mock((..._a: unknown[]) => {});
    const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      const body = String(url).includes('project.all') ? [] : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as never);
    try {
      process.chdir(ROOT);
      // The token comes from an environment variable that is already set (any will do: fetch is stubbed above).
      await withEnv({ CAPY_DISCOVER_JSON_TEST_TOKEN: 'token-for-this-test-only' }, () =>
        withTty({ stdin: true }, () =>
          new ConnectCommand(false).execute('dokploy', {
            discover: true,
            dryRun: true,
            baseUrl: 'https://dokploy.example.com',
            tokenEnv: 'CAPY_DISCOVER_JSON_TEST_TOKEN',
          } as ConnectOpts),
        ),
      );
      expect(logMock).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(logMock.mock.calls[0][0]));
      expect(parsed).toMatchObject({ ok: true, provider: 'dokploy', dryRun: true, cancelled: false });
      expect(parsed.plan.folders).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});
