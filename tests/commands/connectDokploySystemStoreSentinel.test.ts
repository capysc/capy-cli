/**
 * `capy connect dokploy --json` end to end, driving the REAL
 * `createDokployConnector` (not a hand-built stand-in for its output shape,
 * per `connectDokploy.test.ts`'s own convention — see its "connectCommand
 * import output" block) through the REAL `ConnectCommand.executeImport`,
 * with the org system store's `getConnectorSecret` returning a sentinel API
 * token. Proves the token never lands on any output surface OR in any file
 * this run writes — `.env`/keep.lock (via `writeImportedAndSync`) and
 * `.capy/deploy.json` (via the deploy-target offer, `maybeOfferDeployTarget`
 * → `upsertTarget`).
 *
 * The token is deliberately DIFFERENT from the imported app variable's
 * value, so a pass here can't be an accident of both sentinels happening to
 * be the same string.
 *
 * No `mock.module()` — every dependency is injected directly into
 * `createDokployConnector`'s own `deps` — so this file runs in the normal
 * batch, same as `connectImportJsonPurity.test.ts`.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { createDokployConnector } from '../../src/commands/connectors/dokploy';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { DokploySystemStoreCallOptions, FetchLike } from '../../src/deploy/dokployApi';
import type { KeepFile } from '../../src/types/index';

const TOKEN_SENTINEL = 'sk_store_token_never_leak_4d2';
const APP_VALUE_SENTINEL = 'app-env-value-not-the-token';

/** Fakes a real TTY — needed for the interactive deploy-target offer to even ask. */
async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
  }
}

/** A ctx whose `fileManager.writeKeepFile` writes to real disk — same pattern as `connectImportJsonPurity.test.ts`. */
function fakeCtx(dir: string): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return {
    pm: { readSyncState: () => null },
    fileManager: {
      writeKeepFile: (k: KeepFile) => writeFileSync(join(dir, 'keep.lock'), JSON.stringify(k)),
      writeEncryptedEnvFile: () => {},
      writeSyncState: () => {},
    },
    serviceClient: {
      // No real server round trip: omitting `keep_file` makes `adoptServerKeep`
      // fall back to the locally-merged keep (see its own doc).
      pushSecrets: async () => ({ keep_hash: 'h'.repeat(16) }),
    },
    orgId: 'o',
    projectId: 'p',
    branch: 'development',
    userId: 'u',
    projectKey: 'test-project-key',
    keep,
    localPlaintext: {},
  } as unknown as ResolvedContext;
}

/** `GET application.one` only — read-only, matches the real Dokploy import contract. */
function scriptedFetch(): FetchLike {
  return (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('application.one')) {
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            applicationId: 'app_1',
            env: `APP_VAR=${APP_VALUE_SENTINEL}`,
            buildArgs: null,
            buildSecrets: null,
            createEnvFile: true,
          }),
      };
    }
    throw new Error(`unscripted Dokploy request: ${url}`);
  }) as unknown as FetchLike;
}

describe('capy connect dokploy — system store token never appears in output or files (CAP-664)', () => {
  test('the sentinel is on none of: console.log, console.error, process.stdout.write, keep.lock, or .capy/deploy.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-connect-dokploy-store-sentinel-'));

    const logMock = mock((..._a: unknown[]) => {});
    const errMock = mock((..._a: unknown[]) => {});
    const stdoutMock = mock((..._a: unknown[]) => true);
    const logSpy = spyOn(console, 'log').mockImplementation(logMock as never);
    const errSpy = spyOn(console, 'error').mockImplementation(errMock as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(stdoutMock as never);

    const getConnectorSecret = mock(
      async (_name: string, _opts: DokploySystemStoreCallOptions) => TOKEN_SENTINEL,
    );

    try {
      const connector = createDokployConnector({
        fetch: scriptedFetch(),
        env: {},
        cwd: dir,
        getConnectorSecret,
        selectVars: async (candidates: readonly string[]) => candidates,
        // Say yes to the deploy-target offer, so `.capy/deploy.json` gets
        // written too (the offer only fires when something was imported).
        confirm: async () => true,
      });

      const command = new ConnectCommand(false);
      await withTTY(() =>
        (command as unknown as { executeImport: Function }).executeImport(
          connector,
          'dokploy',
          fakeCtx(dir),
          {
            json: true,
            noPush: false,
            nonTty: false,
            baseUrl: 'https://dokploy.example.com',
            application: 'app_1',
          } as ConnectOpts,
        ),
      );

      const allOutput = [
        ...logMock.mock.calls.map((a) => a.map(String).join(' ')),
        ...errMock.mock.calls.map((a) => a.map(String).join(' ')),
        ...stdoutMock.mock.calls.map((a) => String(a[0])),
      ].join('\n');
      expect(allOutput).not.toContain(TOKEN_SENTINEL);
      // Sanity: the run actually produced SOMETHING (the capture isn't
      // just empty) — the `--json` line names the application id.
      expect(allOutput).toContain('app_1');

      const keepLockPath = join(dir, 'keep.lock');
      expect(existsSync(keepLockPath)).toBe(true);
      expect(readFileSync(keepLockPath, 'utf-8')).not.toContain(TOKEN_SENTINEL);

      const deployJsonPath = join(dir, '.capy', 'deploy.json');
      expect(existsSync(deployJsonPath)).toBe(true);
      const deployJson = readFileSync(deployJsonPath, 'utf-8');
      expect(deployJson).not.toContain(TOKEN_SENTINEL);
      // The saved target stores the app's connection details — never the
      // token — so `applicationId` legitimately appears; the token must not.
      expect(deployJson).toContain('app_1');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      stdoutSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
