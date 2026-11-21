/**
 * Bare `capy`'s sync (the code every folder write command runs first: `CapyCommand.runSync`), against the REAL command
 * over a real folder on disk and an in-memory Capy server (tests/helpers/fakeCapyServer.ts). Only the network edge is
 * replaced (auth, the service client, the key). The menu is bare `capy`'s own; "what would you like to do" is answered
 * by a recorder.
 *
 * The properties (asserted on what the server's latest DECRYPTS to and on the folder after):
 *   - "Commit and push all local values" uploads the folder's values through the shared upload, naming the keep it read
 *     (`base_keep_hash`), and leaves the folder and Capy equal;
 *   - if the server refuses that upload as stale (409), the sync runs ONCE more from a fresh read; a second refusal is
 *     thrown (SECRETS_STALE_BASE);
 *   - retrieving (pinned or remote values) and resolving row by row only move the FOLDER: nothing is pushed;
 *   - a run that is a command's first step (`quiet`) says nothing while the folder and Capy agree;
 *   - answering by protocol (`--resolve`) applies the answers as the individual resolution, then commits so the folder
 *     and Capy agree.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { FIXED_PROJECT_KEY } from '../helpers/deployServer';
import { EMPTY_SERVER, fakeCapyServer, pushOf, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';
import { ConflictRefusal } from '../../src/sync/conflicts';
import { hashValue } from '../../src/sync/compareSecrets';
import { SyncEngine } from '../../src/sync/syncEngine';
import { ensureInSync } from '../../src/sync/gate';
import { saveEdits } from '../../src/commands/editCommand';
import { removeAndSync, writeAndSync, writeImportedAndSync, type ResolvedContext } from '../../src/commands/connectors/shared';
import { ERROR_CODES, type ConnectorMetadata, type KeepFile } from '../../src/types/index';

const KEY = FIXED_PROJECT_KEY;
const DEV = 'development';

/** The server this test talks to: one `mock` returning it, so the module mocks below can reach the per-test value. */
const serverOf = mock((): ReturnType<typeof fakeCapyServer> | undefined => undefined);
const asked = mock((_questions: unknown) => undefined);
const answer = mock((): { action?: string; choice?: string } => ({ action: 'skip' }));

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
      return serverOf()!.getDecryptData(...(args as [string, string]));
    }
    pushSecrets(...args: unknown[]) {
      return serverOf()!.pushSecrets(...(args as Parameters<ReturnType<typeof fakeCapyServer>['pushSecrets']>));
    }
    async listProjects() {
      return [{ id: 'proj', organization_id: 'org', name: 'demo' }];
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
mock.module('inquirer', () => ({
  default: {
    prompt: async (questions: unknown) => {
      asked(questions);
      return answer();
    },
  },
}));

import { CapyCommand } from '../../src/commands/capyCommand';

const globalDirName = `.capy-test-bare-${process.pid}`;
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
  asked.mockClear();
  answer.mockReset();
  answer.mockImplementation(() => ({ action: 'skip' }));
});

const OLD = { X: 'x-old', Y: 'y-old' } as const;

/** A folder pinned to OLD holding `local`, and a server holding `remote`. */
function world(local: Record<string, string>, remote: Record<string, string>, opts: Parameters<typeof fakeCapyServer>[0] = {}, git: 'tracked' | 'ignored' | 'plain' = 'tracked') {
  const seed = seedServer({ projectKey: KEY, values: { [DEV]: OLD } });
  const server = fakeCapyServer({ initial: seedServer({ projectKey: KEY, values: { [DEV]: remote } }), ...opts });
  serverOf.mockReturnValue(server);
  const folder = makeFolder({ git: git === 'plain' ? undefined : git, projectKey: KEY, branch: DEV, keep: seed.keep as KeepFile, env: local, client: server.client });
  made(folder);
  process.chdir(folder.dir);
  return { server, folder };
}

async function sync(options: ConstructorParameters<typeof CapyCommand>[0] = {}) {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await new CapyCommand(options).runSync();
    return { outcome, stdout: log.mock.calls.map((c) => c.map(String).join(' ')).join('\n'), stderr: err.mock.calls.map((c) => c.map(String).join(' ')).join('\n') };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

const choicesOffered = (): readonly string[] =>
  asked.mock.calls.flatMap(([q]) => {
    const question = (Array.isArray(q) ? q[0] : q) as { name?: string; choices?: Array<{ value: string }> };
    return question.name === 'action' ? (question.choices ?? []).map((c) => c.value) : [];
  });

describe('Commit and push all local values', () => {
  test('uploads the folder\'s values through the shared upload: Capy decrypts to them, the folder equals Capy, and the push names the keep it read', async () => {
    const w = world({ X: 'x-mine', Y: OLD.Y, Z: 'z-new' }, OLD);
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    const { outcome } = await sync();
    expect(outcome).toBe('changed');
    expect(choicesOffered()).toContain('commit_local');
    const after = w.server.state();
    expect(serverValues(after, DEV, KEY)).toEqual({ X: 'x-mine', Y: OLD.Y, Z: 'z-new' });
    expect(w.folder.env()).toEqual(serverValues(after, DEV, KEY));
    expect(w.folder.pin('X')).toBe(hashValue('x-mine'));
    expect(w.server.pushSecrets.mock.calls).toHaveLength(1);
    expect(w.server.pushSecrets.mock.calls[0][5]).toBe(SyncEngine.computeKeepHash(seedServer({ projectKey: KEY, values: { [DEV]: OLD } }).keep as KeepFile, DEV));
  });

  test('what the folder lacks goes from Capy too (the folder\'s values ARE what is committed), as bare capy always did', async () => {
    const w = world({ X: 'x-mine' }, OLD);
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    await sync();
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-mine' });
  });

  test('the server refuses it as stale (someone saved after the read): the sync runs once more from a fresh read, and the second pass commits', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: OLD.Y } });
    const w = world({ X: 'x-mine', Y: OLD.Y }, OLD, { racing: (n) => (n === 1 ? [teammate] : []) });
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    const { outcome } = await sync();
    expect(outcome).toBe('changed');
    // Two reads, two pushes (the first refused), the menu shown twice: the second time with THEIR X in the table.
    expect(w.server.pushSecrets.mock.calls).toHaveLength(2);
    expect(asked.mock.calls.filter(([q]) => (Array.isArray(q) ? q[0] : q).name === 'action')).toHaveLength(2);
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-mine');
  });

  test('a second stale refusal is thrown: SECRETS_STALE_BASE, nothing of the folder\'s reached Capy', async () => {
    const a = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-A', Y: OLD.Y } });
    const b = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-B', Y: OLD.Y } });
    const w = world({ X: 'x-mine', Y: OLD.Y }, OLD, { racing: (n) => (n === 1 ? [a] : n === 2 ? [b] : []) });
    answer.mockImplementation(() => ({ action: 'commit_local' }));
    await expect(sync()).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_STALE_BASE });
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-B');
  });
});

describe('retrieving and resolving only move the folder', () => {
  test('Retrieve all remote values: .env and keep.lock take Capy\'s; nothing is pushed', async () => {
    const w = world(OLD, { X: 'x-new', Y: OLD.Y, Z: 'z-new' });
    answer.mockImplementation(() => ({ action: 'retrieve_remote' }));
    const { outcome } = await sync();
    expect(outcome).toBe('changed');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.folder.env()).toEqual({ X: 'x-new', Y: OLD.Y, Z: 'z-new' });
    expect(w.folder.pin('X')).toBe(hashValue('x-new'));
  });

  test('Continue working: stopped, and nothing is written anywhere', async () => {
    const w = world(OLD, { X: 'x-new', Y: OLD.Y });
    const { outcome } = await sync();
    expect(outcome).toBe('stopped');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.folder.env()).toEqual(OLD);
  });
});

describe('a command\'s first step (quiet)', () => {
  test('folder and Capy agree: up-to-date, and not a word on stdout or stderr', async () => {
    world(OLD, OLD);
    const { outcome, stdout, stderr } = await sync({ quiet: true, protocol: true });
    expect(outcome).toBe('up-to-date');
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(asked).not.toHaveBeenCalled();
  });

  test('bare capy itself, not quiet, says so (unchanged)', async () => {
    world(OLD, OLD);
    const { stdout } = await sync();
    expect(stdout).toContain('Everything is up to date!');
  });

  test('off a terminal the menu is not shown: the rows are the payload (no prompt, nothing on stdout but the refusal)', async () => {
    const w = world(OLD, { X: 'x-new', Y: OLD.Y });
    await expect(sync({ protocol: true, quiet: true })).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_CONFLICT });
    expect(asked).not.toHaveBeenCalled();
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });
});

describe('answers by protocol are bare capy\'s individual resolution, committed so the folder and Capy agree', () => {
  const idOf = async (): Promise<string> => {
    const refused = await sync({ protocol: true, quiet: true }).catch((e: { payload?: { conflict_id: string } }) => e);
    return (refused as { payload: { conflict_id: string } }).payload.conflict_id;
  };

  test('remote: the folder takes Capy\'s value and nothing is pushed (Capy already holds it)', async () => {
    const w = world(OLD, { X: 'x-new', Y: OLD.Y });
    const id = await idOf();
    const { outcome } = await sync({ protocol: true, quiet: true, conflictFlags: { resolve: ['X=remote'], conflict: id } });
    expect(outcome).toBe('changed');
    expect(w.folder.env()).toEqual({ X: 'x-new', Y: OLD.Y });
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-new', Y: OLD.Y });
  });

  test('local: the folder\'s value is committed to Capy, over theirs', async () => {
    const w = world({ X: 'x-mine', Y: OLD.Y }, { X: 'x-new', Y: OLD.Y });
    const id = await idOf();
    await sync({ protocol: true, quiet: true, conflictFlags: { resolve: ['X=local'], conflict: id } });
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-mine', Y: OLD.Y });
    expect(w.folder.env()).toEqual({ X: 'x-mine', Y: OLD.Y });
  });

  test('delete: the variable goes from Capy and from the folder', async () => {
    const w = world({ X: 'x-mine', Y: OLD.Y }, { X: 'x-new', Y: OLD.Y });
    const id = await idOf();
    await sync({ protocol: true, quiet: true, conflictFlags: { resolve: ['X=delete'], conflict: id } });
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ Y: OLD.Y });
    expect(w.folder.env()).toEqual({ Y: OLD.Y });
  });

  test('--dry-run: the rows come back with dry_run even with the right answers, and nothing in the folder changes', async () => {
    const w = world(OLD, { X: 'x-new', Y: OLD.Y });
    const id = await idOf();
    const refusal = await sync({ protocol: true, quiet: true, dryRun: true, conflictFlags: { resolve: ['X=remote'], conflict: id } }).catch((e: { payload: Record<string, unknown> }) => e);
    expect((refusal as { payload: Record<string, unknown> }).payload).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT', dry_run: true, conflict_id: id });
    expect(w.folder.env()).toEqual(OLD);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });
});

describe('Oct 2: a stale folder (pinned to an old snapshot, a teammate saved a newer X) runs each writer', () => {
  // The folder is pinned to OLD and holds OLD; Capy holds a newer X and a variable only it has.
  const NEWER = { X: 'x-TEAMMATE', Y: OLD.Y, SERVER_ONLY: 'only-on-the-server' } as const;
  const noLog = { record: mock((_: unknown) => undefined) } as never;
  const connector = { provider: 'stripe', source: 'cli', created_at: 1, fingerprint: 'fp' } as unknown as ConnectorMetadata;

  /** What the person does at the table: bare capy's own menu, answered with "Retrieve all remote values". */
  async function gateRetrievingRemote() {
    answer.mockImplementation(() => ({ action: 'retrieve_remote' }));
    const tty = spyOn(process.stdin, 'isTTY', 'get' as never).mockReturnValue(true as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await ensureInSync({ nonTty: false });
    } finally {
      tty.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  }

  /** The command's context as it is AFTER the gate: the folder as bare capy left it. */
  const after = (w: ReturnType<typeof world>): ResolvedContext =>
    ({ ...w.folder.ctx, keep: w.folder.keep(), localPlaintext: w.folder.env() }) as unknown as ResolvedContext;

  /** Everything the incident put at risk, asserted after a write that touched only `touched`. */
  function expectTeammateSurvives(w: ReturnType<typeof world>, touched: readonly string[]) {
    const values = serverValues(w.server.state(), DEV, KEY);
    Object.entries(NEWER)
      .filter(([name]) => !touched.includes(name))
      .forEach(([name, value]) => expect(values[name]).toBe(value));
    expect(w.folder.env()).toEqual(values);
  }

  test('the gate shows the row, and choosing remote brings the folder to Capy before anything else is written', async () => {
    const w = world(OLD, NEWER);
    expect(await gateRetrievingRemote()).toBe('in-sync');
    expect(w.folder.env()).toEqual(NEWER);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('capy edit: the edited row lands on top; X stays the teammate\'s', async () => {
    const w = world(OLD, NEWER);
    await gateRetrievingRemote();
    const { keep: _keep, localPlaintext: _local, ...folder } = after(w);
    await saveEdits(folder as never, w.folder.keep(), { Y: 'y-edited' }, noLog);
    expect(serverValues(w.server.state(), DEV, KEY).Y).toBe('y-edited');
    expectTeammateSurvives(w, ['Y']);
  });

  test('capy add / capy rotate (a new value for one name): lands on top', async () => {
    const w = world(OLD, NEWER);
    await gateRetrievingRemote();
    await writeAndSync(after(w), 'Z', 'z-new', { push: true });
    expect(serverValues(w.server.state(), DEV, KEY).Z).toBe('z-new');
    expectTeammateSurvives(w, []);
  });

  test('capy connect (a link, no value): only the connector entry moves; no value changes', async () => {
    const w = world(OLD, NEWER);
    await gateRetrievingRemote();
    await writeAndSync(after(w), 'Y', undefined, { push: true, connector });
    expect(w.server.state().keep?.variables.Y.find((e) => e.branch === DEV)).toMatchObject({ connector });
    expectTeammateSurvives(w, []);
  });

  test('capy connect <import>: the imported names land on top', async () => {
    const w = world(OLD, NEWER);
    await gateRetrievingRemote();
    await writeImportedAndSync(after(w), [{ varName: 'IMPORTED', value: 'i-1', entry: connector }], { push: true });
    expect(serverValues(w.server.state(), DEV, KEY).IMPORTED).toBe('i-1');
    expectTeammateSurvives(w, []);
  });

  test('capy remove Y: only Y goes', async () => {
    const w = world(OLD, NEWER);
    await gateRetrievingRemote();
    await removeAndSync(after(w), ['Y']);
    expect(serverValues(w.server.state(), DEV, KEY).Y).toBeUndefined();
    expectTeammateSurvives(w, ['Y']);
  });
});

describe.each(['plain', 'ignored'] as const)('folder-only sync (%s)', (git) => {
  const setup = (local = OLD as Readonly<Record<string, string>>, remote = { ...OLD, X: 'x-theirs' }) =>
    world({ ...local }, remote, {}, git);
  const pending = async () => {
    const refusal = await sync({ protocol: true }).then(() => undefined, (error: unknown) => error);
    if (!(refusal instanceof ConflictRefusal)) throw new Error('expected a conflict');
    return refusal.payload;
  };

  test.each(['local', 'remote'] as const)('use %s and verify pins and values on Capy and in the folder', async (choice) => {
    const w = setup({ ...OLD, X: 'x-mine' });
    const conflict = await pending();
    expect(conflict.conflicts).toEqual([{
      name: 'X', project: 'demo', branch: DEV, type: 'changed', local: hashValue('x-mine'), remote: hashValue('x-theirs'), choices: ['local', 'remote'],
    }]);
    const outcome = await sync({ protocol: true, conflictFlags: { resolve: ['X=' + choice], conflict: conflict.conflict_id } });
    expect(outcome.outcome).toBe('changed');
    const expected = choice === 'local' ? 'x-mine' : 'x-theirs';
    expect(w.folder.env()).toEqual({ ...OLD, X: expected });
    expect(w.folder.pin('X')).toBe(hashValue(expected));
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual(w.folder.env());
    expect(w.server.state().keep?.variables.X[0].value_hash).toBe(hashValue(expected));
    expect(w.server.pushSecrets.mock.calls).toHaveLength(choice === 'local' ? 1 : 0);
  });

  test('a missing environment file retrieves the latest, including empty values; nothing is sent', async () => {
    const w = setup(OLD, { X: '', Y: 'new-latest' });
    w.folder.pm.writeActiveBranch(DEV);
    rmSync('.env');
    const outcome = await sync({ protocol: true });
    expect(outcome.outcome).toBe('changed');
    expect(w.folder.env()).toEqual({ X: '', Y: 'new-latest' });
    expect(w.folder.pin('Y')).toBe(hashValue('new-latest'));
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test.each(['pinned', 'delete'])('reject %s even with a current id, without touching either copy', async (invalid) => {
    const w = setup();
    const before = readFileSync('.env');
    const id = (await pending()).conflict_id;
    await expect(sync({ protocol: true, conflictFlags: { resolve: ['X=' + invalid], conflict: id } })).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_RESOLVE_INVALID });
    expect(readFileSync('.env')).toEqual(before);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a teammate saves after the decision was displayed; the old answer changes nothing', async () => {
    const w = setup({ ...OLD, X: 'my-edit' });
    const id = (await pending()).conflict_id;
    w.server.tape(pushOf({ projectKey: KEY, branch: DEV, values: { ...OLD, X: 'a-later-edit' } }));
    await expect(sync({ protocol: true, conflictFlags: { resolve: ['X=local'], conflict: id } })).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_CONFLICT_STALE });
    expect(w.folder.env().X).toBe('my-edit');
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('a-later-edit');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect((await pending()).conflict_id).not.toBe(id);
  });

  test('a save between reading and pushing invalidates the answer before updating any file', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { ...OLD, X: 'last-minute' } });
    const w = world({ ...OLD, X: 'my-edit' }, OLD, { racing: (n) => n === 2 ? [teammate] : [] }, git);
    const before = readFileSync('.env');
    const id = (await pending()).conflict_id;
    await expect(sync({ protocol: true, conflictFlags: { resolve: ['X=local'], conflict: id } })).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_CONFLICT_STALE });
    expect(readFileSync('.env')).toEqual(before);
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('last-minute');
    expect(w.folder.pm.readActiveBranch()).toBeNull();
  });

  test('cancel after one selection leaves the original folder and service untouched', async () => {
    const w = world({ X: 'my-x', Y: 'my-y' }, OLD, {}, git);
    const before = readFileSync('.env');
    answer.mockImplementationOnce(() => ({ choice: 'local' })).mockImplementationOnce(() => ({ choice: 'stop' }));
    expect((await sync()).outcome).toBe('stopped');
    const questions = asked.mock.calls.map(([qs]) => (qs as readonly { choices: readonly { value: string }[] }[])[0]);
    expect(questions).toHaveLength(2);
    expect(questions[0].choices.map((choice) => choice.value)).toEqual(['local', 'remote', 'stop']);
    expect(readFileSync('.env')).toEqual(before);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.folder.pm.readActiveBranch()).toBeNull();
  });

  test('confirmed empty on both sides clears obsolete local pins without uploading', async () => {
    const w = world({}, {}, { initial: EMPTY_SERVER }, git);
    expect((await sync({ protocol: true })).outcome).toBe('up-to-date');
    expect(w.folder.keep().variables).toEqual({});
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a mismatched environment identity is rejected before writing', async () => {
    const w = setup();
    const foreign = readFileSync('.env', 'utf8').replace('# capy:project_id=proj', '# capy:project_id=foreign');
    writeFileSync('.env', foreign);
    await expect(sync({ protocol: true })).rejects.toMatchObject({ code: ERROR_CODES.INVALID_FORMAT });
    expect(readFileSync('.env', 'utf8')).toBe(foreign);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('linked folder recovers the missing root and environment from the working identity', async () => {
    const w = setup();
    if (git === 'plain') writeFileSync('.gitignore', '/keep.lock\n');
    w.folder.pm.writeActiveBranch(DEV);
    rmSync('.env');
    rmSync('keep.lock');
    expect((await sync({ protocol: true })).outcome).toBe('changed');
    expect(JSON.parse(readFileSync('keep.lock', 'utf8')).project_id).toBe('proj');
    expect(w.folder.env()).toEqual({ ...OLD, X: 'x-theirs' });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a header is enough to recover the actual project name when both locks and remote values are missing', async () => {
    const w = world({}, {}, { initial: EMPTY_SERVER }, git);
    rmSync('keep.lock');
    rmSync('.capy/keep.lock');
    expect((await sync({ protocol: true })).outcome).toBe('up-to-date');
    expect(w.folder.keep()).toMatchObject({ org_id: 'org', project_id: 'proj', project_name: 'demo', variables: {} });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a real local deletion can be chosen explicitly', async () => {
    const w = setup({ Y: OLD.Y });
    const id = (await pending()).conflict_id;
    await sync({ protocol: true, conflictFlags: { resolve: ['X=local'], conflict: id } });
    expect(w.folder.env()).toEqual({ Y: OLD.Y });
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual(w.folder.env());
    expect(w.folder.pin('X')).toBeUndefined();
  });

  test('offline with no env file refuses the read and does not recreate or upload anything', async () => {
    const w = setup();
    w.folder.pm.writeActiveBranch(DEV);
    rmSync('.env');
    w.server.getDecryptData.mockRejectedValue(new Error('offline'));
    await expect(sync({ protocol: true })).rejects.toThrow('offline');
    expect(existsSync('.env')).toBe(false);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });
});
