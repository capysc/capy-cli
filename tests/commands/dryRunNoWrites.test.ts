/**
 * `capy --dry-run` changes nothing: not the folder, not Capy's own files, not the server.
 *
 * The real bare `capy` (CapyCommand.execute) runs over a real folder on disk and an in-memory Capy server
 * (tests/helpers/fakeCapyServer.ts). Only the network edge is replaced (auth, service client, key). Every file under the
 * folder and under Capy's global directory is read byte for byte before and after, so "nothing changed" covers .env,
 * keep.lock, .capy/*, .gitignore, git hooks and caches alike, not just the files a test thought to check.
 *
 * Covered:
 *   - a set-up folder in each state a sync can meet (in step, a local edit, a teammate's save, no .env, no .capy/branch):
 *     a dry run reports and writes nothing;
 *   - a folder that is not set up yet: first-time setup cannot be previewed (it creates the project on Capy), so the dry
 *     run refuses with DRY_RUN_UNSUPPORTED before anything happens.
 *
 * `mock.module()` is process-wide: this file runs on its own (tests/run-tests.sh).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { FIXED_PROJECT_KEY } from '../helpers/deployServer';
import { fakeCapyServer, seedServer } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';
import { ERROR_CODES, type KeepFile } from '../../src/types/index';

const KEY = FIXED_PROJECT_KEY;
const DEV = 'development';
const VALUES = { A: 'a-1', B: 'b-1', C: 'c-1' } as const;

const serverOf = mock((): ReturnType<typeof fakeCapyServer> | undefined => undefined);
/** Calls to anything on the service that creates or changes state (first-time setup, branch creation). */
const serviceWrites = mock((_name: string) => undefined);

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    setSessionUserId() {}
    async authenticateSilent() {
      return { success: true, user_id: 'user-b', organization_id: 'org', user_email: 'b@example.test', _auth_method: 'cached' };
    }
    async authenticate() {
      return { success: true, user_id: 'user-b', organization_id: 'org' };
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
      return serverOf()!.getDecryptData(...(args as [string, string]));
    }
    pushSecrets(...args: unknown[]) {
      return serverOf()!.pushSecrets(...(args as Parameters<ReturnType<typeof fakeCapyServer>['pushSecrets']>));
    }
    async getSecrets(_projectId: string, keepHash: string) {
      const blob = serverOf()!.state().blobs[keepHash];
      return blob === undefined ? null : { env_file: blob };
    }
    async listBranches() {
      const keep = serverOf()?.state().keep;
      return [...new Set(Object.values(keep?.variables ?? {}).flatMap((entries) => entries.map((e) => e.branch)))].map((name) => ({ name, is_protected: false }));
    }
    async listOrganizations() {
      return [{ id: 'org', name: 'Org', role: 'owner' }];
    }
    async initializeProject() {
      serviceWrites('initializeProject');
      throw new Error('a dry run must not create a project');
    }
    async createBranch() {
      serviceWrites('createBranch');
      throw new Error('a dry run must not create a branch');
    }
    async coDecrypt() {
      return { plaintext: '' };
    }
    async wrapOuterLayer() {
      return { ciphertext: '' };
    }
  },
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: async () => KEY,
  hasOrgKey: () => true,
}));
mock.module('inquirer', () => ({
  default: {
    prompt: async () => {
      throw new Error('a dry run must never prompt');
    },
  },
}));

import { CapyCommand } from '../../src/commands/capyCommand';

const globalDirName = `.capy-test-dry-run-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
const ORIGINAL_CWD = process.cwd();
const NO_SIDE_EFFECTS = { CAPY_NO_AUTOCOMMIT: '1', CAPY_WEB_NO_OPEN: '1', CAPY_NO_REPO_LINK: '1' } as const;
const savedSideEffects = Object.fromEntries(Object.keys(NO_SIDE_EFFECTS).map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
  Object.assign(process.env, NO_SIDE_EFFECTS);
});
afterAll(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
  Object.entries(savedSideEffects).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

const dirs = mock((_dir: string) => undefined);
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (getGlobalCapyDir().includes(globalDirName)) rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
  serverOf.mockReset();
  serviceWrites.mockClear();
});

/** Every file under `root`, path -> bytes (as base64), so any change, addition or removal shows. */
function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const walk = (dir: string): Array<[string, string]> =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [[relative(root, path), readFileSync(path).toString('base64')] as [string, string]];
    });
  return Object.fromEntries(walk(root));
}

/** Paths added, removed or changed between two snapshots (empty: nothing changed). */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.filter((path) => before[path] !== after[path]).map((path) => (before[path] === undefined ? `added ${path}` : after[path] === undefined ? `removed ${path}` : `changed ${path}`));
}

/**
 * `keep/<org>/<project>/<keep hash>` under Capy's global directory: a read-through cache of ciphertext fetched from
 * Capy, addressed by its hash (globalConfig.fetchSecretsWithCache). Every read fills it, `capy status` included; it
 * holds what the server already has and changes no state, so a dry run may fill it too.
 */
const isFetchCache = (path: string): boolean => path.startsWith('added keep/');

interface World {
  readonly server: ReturnType<typeof fakeCapyServer>;
  readonly folder: Folder;
  readonly seed: ReturnType<typeof seedServer>;
}

/** A set-up folder, a git repo, on `development`, plus a Capy holding `remote`. keep.lock pins `pinned` (default: `remote`). */
function world(opts: {
  readonly local?: Record<string, string>;
  readonly remote?: Record<string, string>;
  readonly pinned?: Record<string, string>;
  readonly env?: 'present' | 'missing';
  readonly branchFile?: boolean;
}): World {
  const remote = seedServer({ projectKey: KEY, values: { [DEV]: opts.remote ?? VALUES } });
  const pins = opts.pinned === undefined ? remote : seedServer({ projectKey: KEY, values: { [DEV]: opts.pinned } });
  const seed = { ...remote, blobs: { ...remote.blobs, ...pins.blobs } };
  const server = fakeCapyServer({ initial: seed });
  serverOf.mockReturnValue(server);
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: pins.keep as KeepFile, env: opts.local ?? opts.pinned ?? VALUES, client: server.client });
  dirs(folder.dir);
  execSync('git init -q', { cwd: folder.dir });
  if (opts.branchFile !== false) folder.pm.writeActiveBranch(DEV);
  if (opts.env === 'missing') rmSync(join(folder.dir, '.env'));
  process.chdir(folder.dir);
  return { server, folder, seed };
}

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super('exit');
  }
}

async function dryRun(): Promise<{ readonly exit: number | undefined; readonly stderr: string }> {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code);
  }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    // What `capy --dry-run` builds (src/index.ts): a dry run always answers by protocol, never the menu.
    const thrown = await new CapyCommand({ dryRun: true, protocol: true }).execute().then(
      () => undefined,
      (e: unknown) => e,
    );
    return { exit: thrown instanceof Exited ? thrown.code : undefined, stderr: err.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
  } finally {
    exit.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
}

async function expectNothingChanged(w: World): Promise<void> {
  const folderBefore = snapshot(w.folder.dir);
  const globalBefore = snapshot(getGlobalCapyDir());
  await dryRun();
  expect(changed(folderBefore, snapshot(w.folder.dir))).toEqual([]);
  expect(changed(globalBefore, snapshot(getGlobalCapyDir())).filter((path) => !isFetchCache(path))).toEqual([]);
  expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  expect(w.server.state()).toEqual(w.seed);
  expect(serviceWrites.mock.calls).toHaveLength(0);
}

describe('capy --dry-run on a set-up folder writes nothing', () => {
  test('the folder and Capy agree', async () => {
    await expectNothingChanged(world({}));
  });

  test('a value was edited locally (a real run would push it)', async () => {
    await expectNothingChanged(world({ local: { ...VALUES, B: 'b-local' } }));
  });

  test('a teammate saved since this folder last synced (a real run would retrieve it)', async () => {
    await expectNothingChanged(world({ pinned: VALUES, remote: { ...VALUES, C: 'c-teammate' } }));
  });

  test('the .env file is missing (a real run would retrieve the whole file)', async () => {
    await expectNothingChanged(world({ env: 'missing' }));
  });

  test('.capy/branch is missing, as in a fresh clone (a real run would write it)', async () => {
    await expectNothingChanged(world({ branchFile: false }));
  });
});

describe('capy --dry-run in a folder that is not set up yet', () => {
  test('refuses with DRY_RUN_UNSUPPORTED before creating anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-dry-run-setup-'));
    dirs(dir);
    execSync('git init -q', { cwd: dir });
    writeFileSync(join(dir, '.env'), 'APP_NAME=Laravel\nVITE_APP_NAME="${APP_NAME}"\n');
    writeFileSync(join(dir, '.gitignore'), 'vendor/\n');
    process.chdir(dir);
    const before = snapshot(dir);
    const globalBefore = snapshot(getGlobalCapyDir());

    const result = await dryRun();

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("--dry-run can't preview first-time setup");
    expect(changed(before, snapshot(dir))).toEqual([]);
    expect(changed(globalBefore, snapshot(getGlobalCapyDir()))).toEqual([]);
    expect(serviceWrites.mock.calls).toHaveLength(0);
    expect(ERROR_CODES.DRY_RUN_UNSUPPORTED).toBe('DRY_RUN_UNSUPPORTED');
  });
});
