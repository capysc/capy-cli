/**
 * A stale saved hash must not keep a folder on its branch (CAP-834, fault 1).
 *
 * State from the report: `.capy/sync-state` holds a `keep_hash` for the branch that differs from keep.lock's, while
 * every value is equal everywhere (folder, keep.lock pins, Capy). `capy checkout` refused with "unpushed changes"
 * (`findDirtyBranchIssue`, check B), and the remedy it named (`capy push`, bare `capy`) printed "Everything is up to
 * date!" without recording anything, so the folder could never leave its branch.
 *
 * Bare `capy`'s sync runs for real (`CapyCommand.runSync`) over a real folder on disk and an in-memory Capy server;
 * only the network edge is replaced. `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { FIXED_PROJECT_KEY } from '../helpers/deployServer';
import { fakeCapyServer, seedServer } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';
import { SyncEngine } from '../../src/sync/syncEngine';
import { getSyncKeepHash, setSyncKeepHash, type KeepFile } from '../../src/types/index';

const KEY = FIXED_PROJECT_KEY;
const MAIN = 'main';
const STALE = 'f'.repeat(64);

/** What `getDecryptData` does this time: answer from the fake server, or fail as if Capy were unreachable. */
const serverOf = mock((): ReturnType<typeof fakeCapyServer> | undefined => undefined);
const offline = mock((): boolean => false);

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    setSessionUserId() {}
    async authenticateSilent() {
      return { success: true, user_id: 'user-b', organization_id: 'org', user_email: 'b@example.test', _auth_method: 'cached' };
    }
    getLastRefreshFailure() {
      return null;
    }
    getToken() {
      return { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3_600_000 };
    }
    async getValidToken() {
      return 't';
    }
  },
  silentAuthFailureMessage: () => 'no session',
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    getDecryptData(...args: unknown[]) {
      if (offline()) return Promise.reject(new Error('network down'));
      return serverOf()!.getDecryptData(...(args as [string, string]));
    }
    pushSecrets(...args: unknown[]) {
      return serverOf()!.pushSecrets(...(args as Parameters<ReturnType<typeof fakeCapyServer>['pushSecrets']>));
    }
    async listBranches() {
      return [];
    }
  },
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: async () => KEY,
  hasOrgKey: () => true,
}));

import { CapyCommand } from '../../src/commands/capyCommand';
import { findDirtyBranchIssue } from '../../src/commands/checkoutCommand';

const globalDirName = `.capy-test-stale-hash-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
const ORIGINAL_CWD = process.cwd();
beforeAll(() => {
  process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
});
afterAll(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
});

const made = mock((_: Folder) => undefined);
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  made.mock.calls.forEach(([folder]) => removeFolder(folder));
  made.mockClear();
  serverOf.mockReset();
  offline.mockReset();
  offline.mockImplementation(() => false);
});

const VALUES = { API_KEY: 'sk-1', DATABASE_URL: 'postgres://db' } as const;

/** A folder on `main` equal to Capy and to its pins everywhere, whose sync-state records a stale hash for `main`. */
function stuckFolder() {
  const seed = seedServer({ projectKey: KEY, values: { [MAIN]: VALUES } });
  const server = fakeCapyServer({ initial: seed });
  serverOf.mockReturnValue(server);
  const folder = makeFolder({ git: 'tracked', projectKey: KEY, branch: MAIN, keep: seed.keep as KeepFile, env: VALUES, client: server.client });
  made(folder);
  folder.pm.writeActiveBranch(MAIN);
  folder.fileManager.writeSyncState({ last_sync: '2026-10-26T00:00:00.000Z', synced_variables: Object.keys(VALUES), keep_hash: setSyncKeepHash(null, MAIN, STALE) });
  process.chdir(folder.dir);
  return folder;
}

async function bareCapy() {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await new CapyCommand({}).runSync();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe('a stale saved hash with nothing different anywhere (CAP-834, fault 1)', () => {
  test('starting point: checkout refuses with UNPUSHED_CHANGES', () => {
    const folder = stuckFolder();
    expect(findDirtyBranchIssue(folder.pm, folder.fileManager, KEY)).toEqual({ code: 'UNPUSHED_CHANGES', branch: MAIN });
  });

  test('bare capy is up to date AND records the current hash, so checkout may switch', async () => {
    const folder = stuckFolder();

    expect(await bareCapy()).toBe('up-to-date');

    const expected = SyncEngine.computeKeepHash(folder.keep(), MAIN);
    expect(getSyncKeepHash(folder.pm.readSyncState(), MAIN)).toBe(expected);
    expect(findDirtyBranchIssue(folder.pm, folder.fileManager, KEY)).toBeNull();
  });

  test('other branches\' saved hashes are kept', async () => {
    const folder = stuckFolder();
    const state = folder.pm.readSyncState()!;
    folder.fileManager.writeSyncState({ ...state, keep_hash: setSyncKeepHash(state, 'development', 'd'.repeat(64)) });

    await bareCapy();

    expect(getSyncKeepHash(folder.pm.readSyncState(), 'development')).toBe('d'.repeat(64));
  });

  test('offline, nothing is recorded: without Capy there is no proof the pins were pushed', async () => {
    const folder = stuckFolder();
    offline.mockImplementation(() => true);

    expect(await bareCapy()).toBe('up-to-date');

    expect(getSyncKeepHash(folder.pm.readSyncState(), MAIN)).toBe(STALE);
  });

  test('a dry run records nothing', async () => {
    const folder = stuckFolder();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await new CapyCommand({ dryRun: true }).runSync()).toBe('up-to-date');
    } finally {
      log.mockRestore();
    }
    expect(getSyncKeepHash(folder.pm.readSyncState(), MAIN)).toBe(STALE);
  });
});
