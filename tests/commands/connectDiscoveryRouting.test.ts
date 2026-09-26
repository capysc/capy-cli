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
 */
import { mock, describe, test, expect, spyOn, afterAll } from 'bun:test';
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

afterAll(() => mock.restore());

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ConnectCommand } from '../../src/commands/connectCommand';
import type { ConnectOpts } from '../../src/commands/connectors/registry';

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
    const exitCodes: Array<number | undefined> = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      process.chdir(ROOT);
      const cmd = new ConnectCommand(false);
      await cmd
        .execute('dokploy', { nonTty: true, baseUrl: 'https://d', application: 'app_1', tokenEnv: 'T' } as ConnectOpts)
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          if (!m.startsWith('__exit_')) throw err;
        });
      // Proves the detector actually works: the single-service path (no
      // `--discover`) DOES hit `resolveContext()`'s "no keep.lock" exit —
      // the routing test above is catching a REAL ordering, not a fixture
      // that would pass no matter what.
      expect(exitCodes).toEqual([1]);
    } finally {
      process.chdir(originalCwd);
      exitSpy.mockRestore();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});
