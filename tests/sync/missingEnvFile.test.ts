/**
 * A Capy folder with no `.env` FILE (capy-cli, bare `capy` and every command that runs it first).
 *
 * The rule these tests pin:
 *   - Off a terminal (`--json`, `--non-tty`, an agent), a missing `.env` is "no local copy": the whole file is retrieved in
 *     one run, the way the menu's "Retrieve all pinned values" does it. Nothing is read as deleted, nothing is sent to Capy,
 *     keep.lock is not changed, and no `--resolve` is needed. If the pinned snapshot cannot be fetched, no file is written
 *     and the run ends with a code.
 *   - At a terminal NOTHING changed: the same menu, byte for byte (the tests tagged [terminal] pin it).
 *   - A file that EXISTS keeps its behaviour, even when it is empty or lost lines (the tests tagged [present] pin it): the
 *     file's existence is the signal, never its text.
 *
 * The real commands (`capy push`, bare `capy`, `capy remove`, `capy checkout`), the real gate and the real sync run over a
 * real folder on disk and an in-memory Capy server (tests/helpers/fakeCapyServer.ts). Only the network edge is replaced
 * (auth, service client, key): no real service, no network, no credentials. The server's write calls are counted
 * (`pushSecrets`), so "nothing was sent" is asserted on the calls and on the server's whole state, not on what was printed.
 *
 * `mock.module()` is process-wide: this file runs on its own: `bun test tests/sync/missingEnvFile.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { FIXED_PROJECT_KEY } from '../helpers/deployServer';
import { fakeCapyServer, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';
import { removeAndSync, type ResolvedContext } from '../../src/commands/connectors/shared';
import { ensureInSync, gateFirst, syncFolder } from '../../src/sync/gate';
import { findDirtyBranchIssue } from '../../src/commands/checkoutCommand';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';

const KEY = FIXED_PROJECT_KEY;
const OTHER_KEY = 'a-different-project-key-this-profile-does-not-hold';
const DEV = 'development';
const STAGING = 'staging';
const VALUES = { A: 'a-1', B: 'b-1', C: 'c-1' } as const;
const STAGING_VALUES = { A: 'a-stg', S: 's-stg' } as const;

const serverOf = mock((): ReturnType<typeof fakeCapyServer> | undefined => undefined);
const asked = mock((_questions: unknown) => undefined);
const answer = mock((): { action: string } => ({ action: 'skip' }));
const pickBranch = mock((): string => DEV);
/** true: Capy no longer has the snapshot a keep.lock pin names (the pinned blob cannot be fetched). */
const blobGone = mock((): boolean => false);
/** true: fetching the pinned snapshot fails (the service cannot be reached). */
const blobFails = mock((): boolean => false);

/** The branches the fake server knows (the names in its keep). */
const branchesOnServer = (): readonly string[] => {
  const keep = serverOf()?.state().keep;
  return [...new Set(Object.values(keep?.variables ?? {}).flatMap((entries) => entries.map((e) => e.branch)))];
};

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
    /** The pinned snapshot, by keep hash (what "Retrieve all pinned values" reads). */
    async getSecrets(_projectId: string, keepHash: string) {
      if (blobFails()) throw new CapyError('unreachable', ERROR_CODES.NETWORK_ERROR);
      const blob = serverOf()!.state().blobs[keepHash];
      return blob === undefined || blobGone() ? null : { env_file: blob };
    }
    async listBranches() {
      return branchesOnServer().map((name) => ({ name, is_protected: false }));
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
    prompt: async (questions: unknown) => {
      asked(questions);
      const question = (Array.isArray(questions) ? questions[0] : questions) as { name?: string };
      return question.name === 'selected' ? { selected: pickBranch() } : answer();
    },
  },
}));

import { CapyCommand } from '../../src/commands/capyCommand';
import { CheckoutCommand } from '../../src/commands/checkoutCommand';
import { PushCommand } from '../../src/commands/pushCommand';
import { RemoveCommand } from '../../src/commands/removeCommand';

const globalDirName = `.capy-test-missing-env-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
const ORIGINAL_CWD = process.cwd();
// What tests/run-tests.sh sets for every test: no commit made in this repo, no browser, no repo link reported.
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

const made = mock((_: Folder) => undefined);
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  // The keep cache is keyed by keep hash, which these worlds share: never let one test's blob serve the next.
  // Only ever this file's own throwaway global dir (checked: its name carries this process id).
  if (getGlobalCapyDir().includes(globalDirName)) rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  made.mock.calls.forEach(([folder]) => removeFolder(folder));
  made.mockClear();
  serverOf.mockReset();
  asked.mockClear();
  answer.mockReset();
  answer.mockImplementation(() => ({ action: 'skip' }));
  pickBranch.mockReset();
  pickBranch.mockImplementation(() => DEV);
  blobGone.mockReset();
  blobGone.mockImplementation(() => false);
  blobFails.mockReset();
  blobFails.mockImplementation(() => false);
});

// ── The worlds ──────────────────────────────────────────────────────────────

/** `blob` with the lines of `names` taken from `foreign` (a blob of the same branch encrypted with another key). */
function mixedBlob(blob: string, foreign: string, names: readonly string[]): string {
  const foreignLines = Object.fromEntries(foreign.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line]));
  return blob
    .split('\n')
    .map((line) => {
      const name = line.slice(0, line.indexOf('='));
      return names.includes(name) ? (foreignLines[name] ?? line) : line;
    })
    .join('\n');
}

interface World {
  readonly server: ReturnType<typeof fakeCapyServer>;
  readonly folder: Folder;
  readonly seed: ReturnType<typeof seedServer>;
}

/**
 * A folder on `development` pinned to what Capy holds, plus a Capy holding `serverValues` per branch.
 *  - `env`: 'missing' (the file is deleted), or 'present' with `local` in it (an empty `local` is a file with the header and no variables);
 *  - `branchFile`: whether `.capy/branch` names `development` (a fresh clone has no `.capy/` at all);
 *  - `serverKey`: the key Capy's values were encrypted with (a different one: this profile cannot decrypt them).
 */
function world(opts: {
  readonly env: 'missing' | 'present';
  readonly local?: Record<string, string>;
  readonly branchFile?: boolean;
  readonly serverKey?: string;
  readonly branches?: Record<string, Record<string, string>>;
  /** What keep.lock pins, when it is not what Capy holds now (a teammate saved since). */
  readonly pinned?: Record<string, Record<string, string>>;
  /** Names whose value on Capy was encrypted with a key this profile does not hold (the rest are readable). */
  readonly unreadable?: readonly string[];
}): World {
  const values = opts.branches ?? { [DEV]: VALUES, [STAGING]: STAGING_VALUES };
  const readable = seedServer({ projectKey: opts.serverKey ?? KEY, values });
  const foreign = seedServer({ projectKey: OTHER_KEY, values });
  const seed = opts.unreadable === undefined ? readable : { ...readable, blobs: Object.fromEntries(Object.entries(readable.blobs).map(([hash, blob]) => [hash, mixedBlob(blob, foreign.blobs[hash] ?? blob, opts.unreadable ?? [])])) };
  const server = fakeCapyServer({ initial: seed });
  serverOf.mockReturnValue(server);
  const pins = opts.pinned === undefined ? seed : seedServer({ projectKey: KEY, values: opts.pinned });
  // The folder's keep.lock pins `pins`; its blob is what "Retrieve all pinned values" fetches, so Capy keeps it too.
  const withPinnedBlobs = opts.pinned === undefined ? seed : { ...seed, blobs: { ...seed.blobs, ...pins.blobs } };
  const server2 = opts.pinned === undefined ? server : fakeCapyServer({ initial: withPinnedBlobs });
  serverOf.mockReturnValue(server2);
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: pins.keep as KeepFile, env: opts.local ?? VALUES, client: server2.client });
  made(folder);
  if (opts.branchFile !== false) folder.pm.writeActiveBranch(DEV);
  if (opts.env === 'missing') rmSync(join(folder.dir, '.env'));
  process.chdir(folder.dir);
  return { server: server2, folder, seed: withPinnedBlobs };
}

const envPath = (folder: Folder): string => join(folder.dir, '.env');
const branchFilePath = (folder: Folder): string => join(folder.dir, '.capy', 'branch');

/** What the process did: the exit code it was asked to end with (if any), and everything printed. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super('exit');
  }
}

interface Run<T> {
  readonly exit: number | undefined;
  readonly value: T | undefined;
  /** What was thrown that is not an exit (a coded error). */
  readonly error: { readonly code?: string; readonly payload?: Record<string, unknown> } | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

async function run<T>(work: () => Promise<T>, opts: { readonly terminal?: boolean } = {}): Promise<Run<T>> {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code);
  }) as never);
  const tty = spyOn(process.stdin, 'isTTY', 'get' as never).mockReturnValue((opts.terminal === true) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const text = (spy: typeof log): string => spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  try {
    const settled = await work().then(
      (value) => ({ value, thrown: undefined as unknown }),
      (thrown: unknown) => ({ value: undefined, thrown }),
    );
    const exited = settled.thrown instanceof Exited ? settled.thrown : undefined;
    return {
      exit: exited?.code,
      value: settled.value,
      error: settled.thrown !== undefined && exited === undefined ? (settled.thrown as Run<T>['error']) : undefined,
      stdout: text(log),
      stderr: text(err),
    };
  } finally {
    exit.mockRestore();
    tty.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
}

const menuChoices = (): readonly string[] =>
  asked.mock.calls.flatMap(([q]) => {
    const question = (Array.isArray(q) ? q[0] : q) as { name?: string; choices?: Array<{ value: string }> };
    return question.name === 'action' ? (question.choices ?? []).map((c) => c.value) : [];
  });

const jsonOf = (stdout: string): { ok?: boolean; code?: string; conflict_id?: string; conflicts?: Array<{ name: string; type: string; local: string | null; pinned: string | null; remote: string | null }> } =>
  JSON.parse(stdout);

const noWrites = (w: World): void => {
  expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  expect(w.server.state()).toEqual(w.seed);
};

/** keep.lock exactly as its bytes are on disk (the tracked file and capy's working copy), so "unchanged" means byte for byte. */
const keepBytes = (folder: Folder): readonly (string | null)[] =>
  [join(folder.dir, 'keep.lock'), join(folder.dir, '.capy', 'keep.lock')].map((path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null));

/** The property of a retrieve: `.env` exists and reads to exactly `values`, Capy got no write, keep.lock is byte for byte as it was. */
function expectRetrieved(w: World, values: Record<string, string>, keepBefore: readonly (string | null)[]): void {
  expect(existsSync(envPath(w.folder))).toBe(true);
  expect(w.folder.env()).toEqual(values);
  expect(w.folder.fileManager.readEnvMeta().branch).toBe(DEV);
  expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  expect(w.server.state()).toEqual(w.seed);
  expect(keepBytes(w.folder)).toEqual(keepBefore);
}

// ── A. `.env` deleted, `.capy/branch` still names the branch ────────────────

describe('A1. `.env` missing, `.capy/branch` set, off a terminal (--json / --non-tty): the whole file is retrieved', () => {
  test('`capy push --non-tty` retrieves `.env` (the pinned values of the branch in `.capy/branch`); no exit, no write to Capy, keep.lock byte for byte', async () => {
    const w = world({ env: 'missing' });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBeUndefined();
    expect(r.error).toBeUndefined();
    expectRetrieved(w, VALUES, keepBefore);
  });

  test('bare `capy` off a terminal (the protocol) retrieves it the same way, and prints no payload on stdout', async () => {
    const w = world({ env: 'missing' });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => new CapyCommand({ protocol: true }).execute());
    expect(r.exit).toBeUndefined();
    expect(r.stdout).toBe('');
    expectRetrieved(w, VALUES, keepBefore);
  });

  test('what an agent reads is what it read after answering every row `pinned`: the run reports `changed` (so the gate compares again), prose only on stderr, no secret value anywhere', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new CapyCommand({ protocol: true, quiet: true }).runSync());
    expect(r.value).toBe('changed');
    expect(r.stdout).toBe('');
    [...Object.values(VALUES), ...Object.values(STAGING_VALUES)].forEach((secret) => {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    });
    expect(w.folder.env()).toEqual(VALUES);
  });

  test('the next pass has nothing to report: the gate is in sync, and a second run changes nothing', async () => {
    const w = world({ env: 'missing' });
    const done = await run(() => ensureInSync({ nonTty: true }));
    expect(done.value).toBe('in-sync');
    expect(w.folder.env()).toEqual(VALUES);
    const again = await run(() => new CapyCommand({ protocol: true, quiet: true }).runSync());
    expect(again.value).toBe('up-to-date');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a teammate saved since the pin: the file gets the PINNED values, then the normal comparison reports only the rows that really differ (exit 3); nothing is sent', async () => {
    const OLD = { A: 'a-old', B: 'b-old' } as const;
    const NEWER = { A: 'a-NEW', B: 'b-old', Z: 'z-new' } as const;
    const w = world({ env: 'missing', branches: { [DEV]: NEWER, [STAGING]: STAGING_VALUES }, pinned: { [DEV]: OLD, [STAGING]: STAGING_VALUES } });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => ensureInSync({ nonTty: true }));
    expect(r.exit).toBe(3);
    expect(w.folder.env()).toEqual(OLD);
    expect(jsonOf(r.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.SECRETS_CONFLICT });
    expect(jsonOf(r.stdout).conflicts?.map((c) => c.name)).toEqual(['A', 'Z']);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(keepBytes(w.folder)).toEqual(keepBefore);
  });

  test('`--dry-run` still changes nothing: the rows are reported (exit 3) and no file is made', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new CapyCommand({ protocol: true, dryRun: true }).execute());
    expect(r.exit).toBe(3);
    expect(jsonOf(r.stdout).conflicts?.map((c) => c.name)).toEqual(['A', 'B', 'C']);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('when `--resolve` answers are given the person is deciding rows, so they are applied as before: `local` has no local value and is refused (SECRETS_RESOLVE_INVALID; as a command, exit 1); no file, nothing sent', async () => {
    const w = world({ env: 'missing' });
    const first = await run(() => new CapyCommand({ protocol: true, dryRun: true }).execute());
    const id = jsonOf(first.stdout).conflict_id;
    const flags = { resolve: ['A=local', 'B=local', 'C=local'], conflict: id };
    const sync = await run(() => new CapyCommand({ protocol: true, conflictFlags: flags }).runSync());
    expect(sync.error?.code).toBe(ERROR_CODES.SECRETS_RESOLVE_INVALID);
    const command = await run(() => new CapyCommand({ protocol: true, conflictFlags: flags }).execute());
    expect(command.exit).toBe(1);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('...and an explicit `--resolve NAME=delete` is still the one way a variable leaves Capy from this state (shown for one name, on the fake)', async () => {
    const w = world({ env: 'missing' });
    const first = await run(() => new CapyCommand({ protocol: true, dryRun: true }).execute());
    const id = jsonOf(first.stdout).conflict_id;
    const r = await run(() => new CapyCommand({ protocol: true, conflictFlags: { resolve: ['A=pinned', 'B=pinned', 'C=delete'], conflict: id } }).runSync());
    expect(r.exit).toBeUndefined();
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ A: VALUES.A, B: VALUES.B });
  });

  test('`--env-path` pointing at a file that does not exist: nothing is retrieved, the default `.env` (with its local edit and local-only variable) is left byte for byte, and the run stops as before (exit 3, SECRETS_CONFLICT); nothing is sent', async () => {
    const w = world({ env: 'present', local: { A: 'a-EDITED-HERE', B: VALUES.B, C: VALUES.C, LOCAL_ONLY: 'only-here' } });
    const before = readFileSync(envPath(w.folder), 'utf-8');
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => new CapyCommand({ protocol: true, envPath: join(w.folder.dir, 'custom.env') }).execute());
    expect(r.exit).toBe(3);
    expect(jsonOf(r.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.SECRETS_CONFLICT });
    expect(readFileSync(envPath(w.folder), 'utf-8')).toBe(before);
    expect(existsSync(join(w.folder.dir, 'custom.env'))).toBe(false);
    expect(keepBytes(w.folder)).toEqual(keepBefore);
    noWrites(w);
  });

  test('`--env-path`: the file looked at is that path. A complete file there is a local copy, so nothing is retrieved', async () => {
    const w = world({ env: 'present' });
    const custom = join(w.folder.dir, 'custom.env');
    copyFileSync(envPath(w.folder), custom);
    rmSync(envPath(w.folder));
    const r = await run(() => new CapyCommand({ protocol: true, quiet: true, envPath: custom }).runSync());
    expect(r.value).toBe('up-to-date');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });
});

describe('A2. `.env` missing, `.capy/branch` set, in a terminal', () => {
  test('[OK] bare `capy` / `capy push` offers only "Retrieve all pinned values" and "Continue working": no "commit and push local"', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('stopped');
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    expect(menuChoices()).not.toContain('commit_local');
    expect(menuChoices()).not.toContain('individual');
    noWrites(w);
    expect(existsSync(envPath(w.folder))).toBe(false);
  });

  test('[OK] `capy push` in a terminal reaches the same menu; choosing "Continue working" ends with exit 0 and nothing sent', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new PushCommand().execute({}), { terminal: true });
    expect(r.exit).toBe(0);
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    noWrites(w);
  });

  test('[OK] choosing "Retrieve all pinned values" writes `.env` from Capy, and nothing is sent', async () => {
    const w = world({ env: 'missing' });
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('changed');
    expect(w.folder.env()).toEqual(VALUES);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.server.state()).toEqual(w.seed);
  });
});

describe('A3. `capy remove NAME` with `.env` missing, `.capy/branch` set', () => {
  test('off a terminal (`--json --yes --no-pr`): `.env` is retrieved first, then ONLY B is removed: one write to Capy, A and C stay, JSON on stdout', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new RemoveCommand().execute(['B'], { yes: true, json: true, nonTty: true, pr: { noPr: true } }));
    expect(r.exit).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: ['B'], branch: DEV });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(1);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ A: VALUES.A, C: VALUES.C });
    expect(w.folder.env()).toEqual({ A: VALUES.A, C: VALUES.C });
  });

  test('[OK] in a terminal: the same retrieve-only menu, then "Continue working" ends with exit 0, nothing removed or sent', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new RemoveCommand().execute(['B'], { yes: true }), { terminal: true });
    expect(r.exit).toBe(0);
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    noWrites(w);
  });

  test('[OK] once the folder has been brought in sync (retrieve), the removal itself sends only the named name: A and C stay on Capy', async () => {
    const w = world({ env: 'missing' });
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    const ctx = { ...w.folder.ctx, keep: w.folder.keep(), localPlaintext: w.folder.env() } as unknown as ResolvedContext;
    await removeAndSync(ctx, ['B']);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ A: VALUES.A, C: VALUES.C });
  });
});

describe('A4. `capy checkout staging` with `.env` missing, `.capy/branch` set', () => {
  test('off a terminal: `.env` is retrieved first, then the switch works: staging\'s values, `.capy/branch` = staging, no "uncommitted" message, nothing sent', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new CheckoutCommand().execute(STAGING, { nonTty: true }));
    expect(r.exit).toBeUndefined();
    expect(r.stderr).not.toContain('uncommitted');
    expect(w.folder.pm.readActiveBranch()).toBe(STAGING);
    expect(w.folder.env()).toEqual(STAGING_VALUES);
    expect(w.folder.fileManager.readEnvMeta().branch).toBe(STAGING);
    noWrites(w);
  });

  test('[OK] in a terminal: the retrieve-only menu comes first; "Continue working" ends with exit 0 and the branch does not change', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => new CheckoutCommand().execute(STAGING, {}), { terminal: true });
    expect(r.exit).toBe(0);
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    expect(w.folder.pm.readActiveBranch()).toBe(DEV);
    noWrites(w);
  });

  test('[OK] in a terminal, after choosing "Retrieve all pinned values": the switch works, `.env` holds staging\'s values, nothing is sent', async () => {
    const w = world({ env: 'missing' });
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    const r = await run(() => new CheckoutCommand().execute(STAGING, {}), { terminal: true });
    expect(r.exit).toBeUndefined();
    expect(r.stderr).not.toContain('uncommitted');
    expect(w.folder.pm.readActiveBranch()).toBe(STAGING);
    expect(w.folder.env()).toEqual(STAGING_VALUES);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('[BAD] the checkout guard (the one that prints "You have uncommitted changes") reads the missing file as a deleted variable, naming the first one; it is only skipped today because the first step stops the command earlier', () => {
    const w = world({ env: 'missing' });
    expect(existsSync(envPath(w.folder))).toBe(false);
    expect(findDirtyBranchIssue(w.folder.pm, w.folder.fileManager, KEY)).toEqual({ code: 'UNCOMMITTED_CHANGES', branch: DEV, varName: 'A' });
  });
});

describe('A5. `.env` missing, `.capy/branch` set, and Capy holds values this key cannot decrypt', () => {
  test('[BAD] in a terminal the menu now DOES offer "Commit and push all local values" (there is nothing readable on Capy, so it is not read as a fresh copy)', async () => {
    const w = world({ env: 'missing', serverKey: OTHER_KEY });
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('stopped');
    expect(menuChoices()).toContain('commit_local');
    noWrites(w);
  });

  test('[OK] and choosing it sends NOTHING (no write call; Capy\'s unreadable values and keep stay exactly as they were): the push has no change to make', async () => {
    const w = world({ env: 'missing', serverKey: OTHER_KEY });
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('changed');
    noWrites(w);
  });

  test('off a terminal: nothing in the pinned snapshot can be read with this key, so NO file is written and the run ends with a code (exit 1); nothing is sent', async () => {
    const w = world({ env: 'missing', serverKey: OTHER_KEY });
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain(ERROR_CODES.DECRYPT_KEY_MISMATCH);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });
});

// ── B. A fresh clone: keep.lock, no `.env`, no `.capy/` ─────────────────────

describe('B. a fresh clone (keep.lock is there; no `.env`, and no `.capy/branch`)', () => {
  const fresh = (branches?: Record<string, Record<string, string>>): World => world({ env: 'missing', branchFile: false, ...(branches === undefined ? {} : { branches }) });

  test('[OK] in a terminal, a project with two branches: asks which branch, then offers only retrieve; choosing it writes `.env` and `.capy/branch`; nothing is sent', async () => {
    const w = fresh();
    expect(existsSync(branchFilePath(w.folder))).toBe(false);
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('changed');
    expect(asked.mock.calls.some(([q]) => ((Array.isArray(q) ? q[0] : q) as { name?: string }).name === 'selected')).toBe(true);
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    expect(w.folder.pm.readActiveBranch()).toBe(DEV);
    expect(w.folder.env()).toEqual(VALUES);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('[OK] in a terminal, a project with ONE branch: no branch question; offers only retrieve; choosing it writes `.env`', async () => {
    const w = fresh({ [DEV]: VALUES });
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(asked.mock.calls.some(([q]) => ((Array.isArray(q) ? q[0] : q) as { name?: string }).name === 'selected')).toBe(false);
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    expect(w.folder.env()).toEqual(VALUES);
    expect(existsSync(branchFilePath(w.folder))).toBe(true);
  });

  test('[OK] in a terminal, "Continue working" leaves the folder without `.env` (nothing is fetched by itself)', async () => {
    const w = fresh();
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('stopped');
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('[BAD for an agent] off a terminal, two branches: bare `capy` does NOT make `.env`; it ends with the code NO_ACTIVE_BRANCH (run `capy checkout <branch>` first); nothing is sent', async () => {
    const w = fresh();
    const r = await run(() => new CapyCommand({ protocol: true }).runSync());
    expect(r.error?.code).toBe(ERROR_CODES.NO_ACTIVE_BRANCH);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('[BAD for an agent] and `capy checkout development --non-tty` in that fresh clone is refused the same way (the first step needs a branch): exit 1, no `.env`', async () => {
    const w = fresh();
    const r = await run(() => new CheckoutCommand().execute(DEV, { nonTty: true }));
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain(ERROR_CODES.NO_ACTIVE_BRANCH);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('off a terminal, ONE branch: bare `capy` retrieves `.env` by itself (the branch is the only one, so it is chosen); no write to Capy, keep.lock byte for byte', async () => {
    const w = fresh({ [DEV]: VALUES });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => new CapyCommand({ protocol: true }).execute());
    expect(r.exit).toBeUndefined();
    expect(existsSync(branchFilePath(w.folder))).toBe(true);
    expectRetrieved(w, VALUES, keepBefore);
  });

  test('off a terminal, ONE branch: `capy checkout development --non-tty` works too (the file is retrieved first)', async () => {
    const w = fresh({ [DEV]: VALUES });
    const r = await run(() => new CheckoutCommand().execute(DEV, { nonTty: true }));
    expect(r.exit).toBeUndefined();
    expect(w.folder.env()).toEqual(VALUES);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });
});

// ── C. Contrast: the file is there with its header, every line deleted ──────

describe('C. `.env` present (header kept) but every variable line deleted', () => {
  test('[OK] in a terminal: the full menu offers "Commit and push all local values" (the deliberate delete path), "Retrieve all pinned values" and "Individually resolve"', async () => {
    const w = world({ env: 'present', local: {} });
    expect(existsSync(envPath(w.folder))).toBe(true);
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(menuChoices()).toEqual(['commit_local', 'retrieve_pinned', 'individual', 'skip']);
    noWrites(w);
  });

  test('[OK] choosing "Commit and push all local values" there really empties the branch on Capy (deliberate): this is the path that must stay', async () => {
    const w = world({ env: 'present', local: {} });
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(1);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({});
  });

  test('[OK] off a terminal it is the same report (exit 3, every variable), and sends nothing until a name is answered with delete', async () => {
    const w = world({ env: 'present', local: {} });
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBe(3);
    expect(jsonOf(r.stdout).conflicts?.map((c) => c.name)).toEqual(['A', 'B', 'C']);
    noWrites(w);
  });

  test('[OK] the checkout guard on it reads a deleted variable (unchanged today)', () => {
    const w = world({ env: 'present', local: {} });
    expect(findDirtyBranchIssue(w.folder.pm, w.folder.fileManager, KEY)).toMatchObject({ code: 'UNCOMMITTED_CHANGES', branch: DEV });
  });
});

// ── E. Every command that runs the sync gate gets the same answer ───────────

describe('E. the gate itself (what edit, add, rotate, connect, org, deploy, push, remove, checkout all run first), `.env` missing', () => {
  test('off a terminal: in sync after retrieving the file; nothing sent, keep.lock byte for byte', async () => {
    const w = world({ env: 'missing' });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => ensureInSync({ nonTty: true }));
    expect(r.value).toBe('in-sync');
    expectRetrieved(w, VALUES, keepBefore);
  });

  test('[terminal] asks (retrieve only); "Continue working" is "stopped" and the command would write nothing', async () => {
    const w = world({ env: 'missing' });
    const r = await run(() => ensureInSync({ nonTty: false }), { terminal: true });
    expect(r.value).toBe('stopped');
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    noWrites(w);
  });

  test('another folder (connect/deploy discovery syncs each checkout this way), off a terminal: that folder gets its file, ok', async () => {
    const w = world({ env: 'missing' });
    const dir = w.folder.dir;
    const keepBefore = keepBytes(w.folder);
    process.chdir(ORIGINAL_CWD);
    const r = await run(() => syncFolder(dir, { nonTty: true }));
    expect(r.value).toEqual({ ok: true });
    expectRetrieved(w, VALUES, keepBefore);
  });
});

// ── F. What a retrieve writes today ─────────────────────────────────────────

describe('F. what "Retrieve" writes when `.env` is missing (the same menu choices a fresh clone uses)', () => {
  const OLD = { A: 'a-old', B: 'b-old' } as const;
  const NEWER = { A: 'a-NEW', B: 'b-old', Z: 'z-new' } as const;
  const teammateSaved = (): World => world({ env: 'missing', branches: { [DEV]: NEWER, [STAGING]: STAGING_VALUES }, pinned: { [DEV]: OLD, [STAGING]: STAGING_VALUES } });

  test('[OK] pinned = remote: one retrieve choice, "pinned"; it writes keep.lock\'s snapshot of the branch in `.capy/branch`, headed with that branch', async () => {
    const w = world({ env: 'missing' });
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(menuChoices()).toEqual(['retrieve_pinned', 'skip']);
    expect(w.folder.env()).toEqual(VALUES);
    expect(w.folder.fileManager.readEnvMeta().branch).toBe(DEV);
  });

  test('[OK] a teammate saved since the pin: two retrieve choices, no commit', async () => {
    const w = teammateSaved();
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(menuChoices()).toEqual(['retrieve_pinned', 'retrieve_remote', 'skip']);
    noWrites(w);
  });

  test('[OK] "Retrieve all pinned values" writes the PINNED snapshot (what keep.lock names), not Capy\'s latest; keep.lock is unchanged; nothing is sent', async () => {
    const w = teammateSaved();
    const keepBefore = w.folder.keep();
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(w.folder.env()).toEqual(OLD);
    expect(w.folder.keep()).toEqual(keepBefore);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('[OK] "Retrieve all remote values" writes Capy\'s LATEST for the branch; keep.lock\'s pins follow it; nothing is sent', async () => {
    const w = teammateSaved();
    answer.mockImplementation(() => ({ action: 'retrieve_remote' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(w.folder.env()).toEqual(NEWER);
    expect(w.folder.pin('Z')).toBeDefined();
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('[BAD] if the pinned snapshot cannot be fetched, "Retrieve all pinned values" still writes a file: an EMPTY one with the header (no variables), and reports success', async () => {
    const w = world({ env: 'missing' });
    blobGone.mockImplementation(() => true);
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    const r = await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(r.value).toBe('changed');
    expect(existsSync(envPath(w.folder))).toBe(true);
    expect(w.folder.env()).toEqual({});
    expect(w.folder.fileManager.readEnvMeta().branch).toBe(DEV);
    // ...and from then on the file is PRESENT and empty, so the next run offers the deliberate-delete path.
    answer.mockImplementation(() => ({ action: 'skip' }));
    asked.mockClear();
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(menuChoices()).toContain('commit_local');
  });
});

// ── G. Off a terminal, the pinned snapshot cannot be fetched: no file, a code ────────────────────────────

describe('G. off a terminal, `.env` missing and the pinned snapshot cannot be fetched', () => {
  test('Capy has no such snapshot: NO file is written, the run ends (exit 1) with SNAPSHOT_NOT_FOUND on stderr, nothing is sent, keep.lock byte for byte', async () => {
    const w = world({ env: 'missing' });
    const keepBefore = keepBytes(w.folder);
    blobGone.mockImplementation(() => true);
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain(ERROR_CODES.SNAPSHOT_NOT_FOUND);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
    expect(keepBytes(w.folder)).toEqual(keepBefore);
  });

  test('`--json`: the code is on stdout as JSON { ok: false, code, error }, exit 1, no file', async () => {
    const w = world({ env: 'missing' });
    blobGone.mockImplementation(() => true);
    const r = await run(() => gateFirst({ nonTty: true, json: true }));
    expect(r.exit).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.SNAPSHOT_NOT_FOUND });
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('only SOME pinned values can be read with this key (B is not): NO file is written, keep.lock is byte for byte, nothing is sent, and the same code ends the run (exit 1)', async () => {
    const w = world({ env: 'missing', unreadable: ['B'] });
    const keepBefore = keepBytes(w.folder);
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain(ERROR_CODES.DECRYPT_KEY_MISMATCH);
    expect(existsSync(envPath(w.folder))).toBe(false);
    expect(keepBytes(w.folder)).toEqual(keepBefore);
    noWrites(w);
  });

  test('the service cannot be reached: the failure keeps its own code (NETWORK_ERROR), exit 1, no file', async () => {
    const w = world({ env: 'missing' });
    blobFails.mockImplementation(() => true);
    const r = await run(() => new PushCommand().execute({ nonTty: true }));
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain(ERROR_CODES.NETWORK_ERROR);
    expect(existsSync(envPath(w.folder))).toBe(false);
    noWrites(w);
  });

  test('[terminal] unchanged: the menu\'s retrieve still writes the empty file in this case (filed separately, not changed here)', async () => {
    const w = world({ env: 'missing' });
    blobGone.mockImplementation(() => true);
    answer.mockImplementation(() => ({ action: 'retrieve_pinned' }));
    await run(() => new CapyCommand().runSync(), { terminal: true });
    expect(existsSync(envPath(w.folder))).toBe(true);
    expect(w.folder.env()).toEqual({});
  });
});
