/**
 * The Oct 2 incident (CAP-712), reproduced on an in-memory server and asserted as a
 * PROPERTY: a folder pinned to an old snapshot saves something, and what someone else
 * saved since is still what the server holds afterwards. Each save path gets its own test.
 *
 * World: the server holds A's newer state for `development` (X changed, a server-only
 * variable added) and a `staging` branch. Folder B is pinned to the OLDER snapshot and its
 * `.env` still holds the old values.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { saveEdits } from '../../src/commands/editCommand';
import { removeAndSync, writeAndSync, writeImportedAndSync } from '../../src/commands/connectors/shared';
import { runSecretSet, type SetEnv, type SetRequest } from '../../src/commands/secretsSet';
import { proceedWithRemoval } from '../../src/commands/removeCommand';
import { hashValue, compareSecrets } from '../../src/sync/compareSecrets';
import { commitFolder, commitLocalValues, commitToServer, localChanges, pinnedHashes, readSnapshot } from '../../src/sync/commit';
import { SyncEngine } from '../../src/sync/syncEngine';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import { fakeCapyServer, pushOf, seedServer, serverHash, serverLine, serverValues, type FakeServerOpts } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const DEV = 'development';
const STG = 'staging';

const OLD_DEV = { X: 'x-old', Y: 'y-old', KEEP: 'k-keep' } as const;
const NEW_X = 'x-NEW-from-A';
const NEW_DEV = { X: NEW_X, Y: 'y-old', KEEP: 'k-keep', SERVER_ONLY: 'only-on-the-server' } as const;
const STAGING = { X: 'x-stg', Y: 'y-stg' } as const;

const OLD_SEED = seedServer({ projectKey: KEY, values: { [DEV]: OLD_DEV, [STG]: STAGING } });
const NEW_SEED = seedServer({ projectKey: KEY, values: { [DEV]: NEW_DEV, [STG]: STAGING } });

const stagingEntries = (keep: KeepFile | undefined) =>
  Object.fromEntries(
    Object.entries(keep?.variables ?? {})
      .map(([name, entries]) => [name, entries.filter((e) => e.branch === STG)] as const)
      .filter(([, entries]) => entries.length > 0),
  );

const globalDirName = `.capy-test-commit-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
beforeAll(() => {
  process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
});
afterAll(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
});

// The folders a test made, removed afterwards (a list of ones already created, grown only by `world`).
const made = mock((_: Folder) => undefined);
afterEach(() => made.mock.calls.forEach(([folder]) => removeFolder(folder)));

/** The server holds A's newer state; B is pinned to the older one. */
function world(opts: { env?: Record<string, string> } & Pick<FakeServerOpts, 'racing'> = {}) {
  const server = fakeCapyServer({ initial: NEW_SEED, racing: opts.racing });
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: OLD_SEED.keep as KeepFile, env: opts.env ?? OLD_DEV, client: server.client });
  made(folder);
  return { server, folder, before: server.state() };
}

const valuesOf = (server: ReturnType<typeof fakeCapyServer>, branch = DEV) => serverValues(server.state(), branch, KEY);

/** Everything the incident put at risk, asserted after a save that did not touch it. */
function expectOthersIntact(w: ReturnType<typeof world>, touched: readonly string[]): void {
  const after = w.server.state();
  const values = serverValues(after, DEV, KEY);
  // A's newer value of X and the server-only variable survive, and so does everything else B did not touch.
  Object.entries(NEW_DEV)
    .filter(([name]) => !touched.includes(name))
    .forEach(([name, value]) => expect(values[name]).toBe(value));
  // ... down to the very ciphertext line the server holds.
  Object.keys(NEW_DEV)
    .filter((name) => !touched.includes(name))
    .forEach((name) => expect(serverLine(after, DEV, name)).toBe(serverLine(w.before, DEV, name)));
  // Another branch's keep entries and blob are exactly as they were.
  expect(stagingEntries(after.keep)).toEqual(stagingEntries(w.before.keep));
  expect(serverValues(after, STG, KEY)).toEqual(STAGING);
}

const folderParts = (f: Folder) => ({ ...f.ctx });
const noLog = { record: mock((_: unknown) => undefined) } as never;

describe('Oct 2: a folder pinned to an old snapshot saves — what others saved since survives', () => {
  test('capy edit (TUI save) of a DIFFERENT variable', async () => {
    const w = world();
    await saveEdits(folderParts(w.folder), w.folder.ctx.keep, { Y: 'y-B' }, noLog);
    expect(valuesOf(w.server).Y).toBe('y-B');
    expectOthersIntact(w, ['Y']);
    // The folder now holds the server's state: A's X, the server-only variable, and B's own save.
    expect(w.folder.env()).toMatchObject({ X: NEW_X, Y: 'y-B', SERVER_ONLY: NEW_DEV.SERVER_ONLY });
    expect(w.folder.pin('X')).toBe(hashValue(NEW_X));
  });

  test('capy add Z', async () => {
    const w = world();
    await writeAndSync(w.folder.ctx as never, 'Z', 'z-value', { push: true });
    expect(valuesOf(w.server).Z).toBe('z-value');
    expectOthersIntact(w, []);
    expect(w.folder.env().Z).toBe('z-value');
  });

  test('capy remove Y', async () => {
    const w = world();
    await removeAndSync(w.folder.ctx as never, ['Y']);
    expect(valuesOf(w.server).Y).toBeUndefined();
    expectOthersIntact(w, ['Y']);
    expect(serverHash(w.server.state(), DEV, 'Y')).toBeUndefined();
    // Y's entry on the other branch stays.
    expect(serverHash(w.server.state(), STG, 'Y')).toBe(hashValue(STAGING.Y));
    expect(w.folder.env().Y).toBeUndefined();
  });

  test('capy remove Y, human mode: the removal command itself', async () => {
    const w = world();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await proceedWithRemoval(w.folder.ctx as never, ['Y'], { json: false, cwd: w.folder.dir, pr: { noPr: true } });
    } finally {
      log.mockRestore();
    }
    expect(valuesOf(w.server).Y).toBeUndefined();
    expectOthersIntact(w, ['Y']);
  });

  test('capy edit X (piped): a conflict, and NOTHING is uploaded', async () => {
    const w = world();
    const err = (await writeAndSync(w.folder.ctx as never, 'X', 'x-from-B', { push: true }).catch((e: unknown) => e)) as CapyError;
    expect(err).toBeInstanceOf(CapyError);
    expect(err.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(err.details).toEqual({ names: ['X'] });
    // Names, never values.
    expect(`${err.message} ${JSON.stringify(err.details)}`).not.toContain('x-from-B');
    expect(`${err.message} ${JSON.stringify(err.details)}`).not.toContain(NEW_X);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.server.state()).toEqual(w.before);
    // ... and the folder is untouched.
    expect(w.folder.env().X).toBe(OLD_DEV.X);
    expect(w.folder.pin('X')).toBe(hashValue(OLD_DEV.X));
  });

  test('capy edit X (piped) from a folder that is NOT behind: saves', async () => {
    const server = fakeCapyServer({ initial: NEW_SEED });
    const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: NEW_SEED.keep as KeepFile, env: NEW_DEV, client: server.client });
    made(folder);
    await writeAndSync(folder.ctx as never, 'X', 'x-from-B', { push: true });
    expect(serverValues(server.state(), DEV, KEY)).toEqual({ ...NEW_DEV, X: 'x-from-B' });
  });

  test('bare capy: commit local values after changing Y', async () => {
    const w = world({ env: { ...OLD_DEV, Y: 'y-B' } });
    const seen = await readSnapshot(w.server.client, 'proj', DEV, KEY);
    const remoteHashes = Object.fromEntries(Object.entries(seen.entries).map(([name, e]) => [name, e.hash]));
    const { changed } = await commitLocalValues(w.folder.ctx, { pinned: pinnedHashes(w.folder.ctx.keep, DEV), remoteHashes, seen });
    expect(changed).toBe(1);
    expect(valuesOf(w.server).Y).toBe('y-B');
    expectOthersIntact(w, ['Y']);
    // The folder's untouched X is now A's.
    expect(w.folder.env().X).toBe(NEW_X);
  });

  test('bare capy: B also changed X, the table showed A\'s X next to it, and B committed local: B\'s X is the answer', async () => {
    const w = world({ env: { ...OLD_DEV, X: 'x-from-B' } });
    const seen = await readSnapshot(w.server.client, 'proj', DEV, KEY);
    const remoteHashes = Object.fromEntries(Object.entries(seen.entries).map(([name, e]) => [name, e.hash]));
    await commitLocalValues(w.folder.ctx, { pinned: pinnedHashes(w.folder.ctx.keep, DEV), remoteHashes, seen });
    expect(valuesOf(w.server).X).toBe('x-from-B');
    expectOthersIntact(w, ['X']);
  });

  test('bare capy: someone saves while the table is up — the push is refused, re-planned from the new latest, and succeeds', async () => {
    const w = world({ env: { ...OLD_DEV, Y: 'y-B' } });
    const seen = await readSnapshot(w.server.client, 'proj', DEV, KEY);
    const remoteHashes = Object.fromEntries(Object.entries(seen.entries).map(([name, e]) => [name, e.hash]));
    // C saves a new variable while B reads the table.
    w.server.tape(pushOf({ projectKey: KEY, branch: DEV, values: { ...NEW_DEV, LATE: 'late' } }));
    await commitLocalValues(w.folder.ctx, { pinned: pinnedHashes(w.folder.ctx.keep, DEV), remoteHashes, seen });
    expect(valuesOf(w.server)).toEqual({ ...NEW_DEV, LATE: 'late', Y: 'y-B' });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(2);
  });

  test('capy push: pushes the folder\'s edits, not the whole env it still holds from the old snapshot', async () => {
    const w = world({ env: { ...OLD_DEV, Y: 'y-B', LOCAL_NEW: 'ln' } });
    const changes = localChanges(w.folder.ctx.localPlaintext, pinnedHashes(w.folder.ctx.keep, DEV), { removals: false });
    expect(changes).toEqual({ set: { Y: 'y-B', LOCAL_NEW: 'ln' }, remove: [] });
    await commitFolder(w.folder.ctx, changes);
    expect(valuesOf(w.server)).toEqual({ ...NEW_DEV, Y: 'y-B', LOCAL_NEW: 'ln' });
    expectOthersIntact(w, ['Y']);
  });

  test('capy secrets set Y', async () => {
    const w = world();
    const env: SetEnv = {
      client: w.server.client as SetEnv['client'],
      orgId: 'org',
      openKeys: () => async () => KEY,
      writeCache: () => undefined,
      github: () => undefined,
      branchName: () => 'capy/test',
    };
    const req: SetRequest = {
      name: 'Y',
      value: 'y-set',
      locations: [{ project_id: 'proj', project_name: 'demo', branch: DEV, protected: false }],
      repos: [],
    };
    const result = await runSecretSet(req, env);
    expect(result.failed).toEqual([]);
    expect(valuesOf(w.server).Y).toBe('y-set');
    expectOthersIntact(w, ['Y']);
  });

  test('capy connect import: many variables in one write, the rest of the server untouched', async () => {
    const w = world();
    await writeImportedAndSync(
      w.folder.ctx as never,
      [
        { varName: 'IMPORTED_1', value: 'i1', entry: { provider: 'dokploy' } as never },
        { varName: 'IMPORTED_2', value: 'i2', entry: { provider: 'dokploy' } as never },
      ],
      { push: true },
    );
    expect(valuesOf(w.server)).toEqual({ ...NEW_DEV, IMPORTED_1: 'i1', IMPORTED_2: 'i2' });
    expectOthersIntact(w, []);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(1);
    // The connector marker rides on the new entries only.
    const keep = w.server.state().keep as KeepFile;
    expect(keep.variables.IMPORTED_1.find((e) => e.branch === DEV)?.connector).toEqual({ provider: 'dokploy' });
    expect(keep.variables.X.find((e) => e.branch === DEV)?.connector).toBeUndefined();
  });

  test('a save of the value the server already holds uploads nothing, and still syncs the folder', async () => {
    const w = world();
    await writeAndSync(w.folder.ctx as never, 'Y', OLD_DEV.Y, { push: true });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.folder.env().X).toBe(NEW_X);
  });
});

describe('uncommitted local edits stay edits', () => {
  test('a new local variable and an edited one survive another variable\'s save, un-pinned', async () => {
    const w = world({ env: { ...OLD_DEV, LOCAL_NEW: 'ln', KEEP: 'k-edited' } });
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(w.folder.env()).toMatchObject({ LOCAL_NEW: 'ln', KEEP: 'k-edited', Y: 'y-B', X: NEW_X });
    // Never uploaded.
    expect(valuesOf(w.server).LOCAL_NEW).toBeUndefined();
    expect(valuesOf(w.server).KEEP).toBe(OLD_DEV.KEEP);
    expect(w.folder.pin('LOCAL_NEW')).toBeUndefined();
  });

  test('a local edit of a variable the server ALSO changed is still a conflict for the next bare `capy` (its pin does not move)', async () => {
    const w = world({ env: { ...OLD_DEV, X: 'x-edited-by-B' } });
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(w.folder.env().X).toBe('x-edited-by-B');
    expect(w.folder.pin('X')).toBe(hashValue(OLD_DEV.X));
    const local = { ...w.folder.env() };
    const remote = valuesOf(w.server);
    const hashes = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, hashValue(v)]));
    const { diffs } = compareSecrets(pinnedHashes(w.folder.keep(), DEV), hashes(local), hashes(remote));
    expect(diffs.find((d) => d.variable === 'X')).toMatchObject({ pinned: hashValue(OLD_DEV.X), local: hashValue('x-edited-by-B'), remote: hashValue(NEW_X) });
  });

  test('capy remove carries no one\'s unrelated edit along: it removes Y, uploads nothing else, and the edit stays in .env', async () => {
    const w = world({ env: { ...OLD_DEV, LOCAL_NEW: 'ln', KEEP: 'k-edited' } });
    await removeAndSync(w.folder.ctx as never, ['Y']);
    expect(valuesOf(w.server)).toEqual({ X: NEW_X, KEEP: OLD_DEV.KEEP, SERVER_ONLY: NEW_DEV.SERVER_ONLY });
    expect(w.folder.env()).toMatchObject({ LOCAL_NEW: 'ln', KEEP: 'k-edited' });
  });

  test('capy remove --json of a variable the server changed: a coded refusal naming it, exit 1, nothing uploaded', async () => {
    const w = world();
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const out = spyOn(console, 'log').mockImplementation(() => {});
    const result = await proceedWithRemoval(w.folder.ctx as never, ['X'], { json: true, cwd: w.folder.dir }).catch((e: unknown) => e);
    const printed = out.mock.calls.map((c) => String(c[0])).join('\n');
    exit.mockRestore();
    out.mockRestore();
    expect((result as Error).message).toBe('exit 1');
    expect(JSON.parse(printed)).toEqual({ ok: false, code: ERROR_CODES.SECRETS_CONFLICT, error: expect.any(String), names: ['X'] });
    expect(printed).not.toContain(NEW_X);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a local value that already equals the server\'s new value is not an edit: the pin moves', async () => {
    const w = world({ env: { ...OLD_DEV, X: NEW_X } });
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(w.folder.pin('X')).toBe(hashValue(NEW_X));
  });
});

describe('stale base: the server moved between the read and the push', () => {
  const w1 = pushOf({ projectKey: KEY, branch: DEV, values: { ...NEW_DEV, W1: 'w1' } });
  const w2 = pushOf({ projectKey: KEY, branch: DEV, values: { ...NEW_DEV, W1: 'w1', W2: 'w2' } });

  test('409 -> one re-read -> success, on top of what landed in between', async () => {
    const w = world({ racing: (n) => (n === 1 ? [w1] : []) });
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(valuesOf(w.server)).toEqual({ ...NEW_DEV, W1: 'w1', Y: 'y-B' });
    expect(w.server.getDecryptData.mock.calls).toHaveLength(2);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(2);
    // The second push was built from the keep that was latest at the second read.
    const [, , , , , firstBase] = w.server.pushSecrets.mock.calls[0];
    const [, , , , , secondBase] = w.server.pushSecrets.mock.calls[1];
    expect(firstBase).not.toBe(secondBase);
    expect(w.folder.env().W1).toBe('w1');
  });

  test('capy secrets set: the push names its base, and a stale base is read again once', async () => {
    const w = world({ racing: (n) => (n === 1 ? [w1] : []) });
    const env: SetEnv = {
      client: w.server.client as SetEnv['client'],
      orgId: 'org',
      openKeys: () => async () => KEY,
      writeCache: () => undefined,
      github: () => undefined,
      branchName: () => 'capy/test',
    };
    const req: SetRequest = {
      name: 'Y',
      value: 'y-set',
      locations: [{ project_id: 'proj', project_name: 'demo', branch: DEV, protected: false }],
      repos: [],
    };
    const result = await runSecretSet(req, env);
    expect(result.failed).toEqual([]);
    expect(valuesOf(w.server)).toEqual({ ...NEW_DEV, W1: 'w1', Y: 'y-set' });
    expect(w.server.getDecryptData.mock.calls).toHaveLength(2);
    expect(w.server.pushSecrets.mock.calls.map((c) => c[5])).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  test('refused again: stops with the coded error, uploads nothing, folder untouched', async () => {
    const w = world({ racing: (n) => (n === 1 ? [w1] : n === 2 ? [w2] : []) });
    const err = (await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true }).catch((e: unknown) => e)) as CapyError;
    expect(err.code).toBe(ERROR_CODES.SECRETS_STALE_BASE);
    expect(w.server.getDecryptData.mock.calls).toHaveLength(2);
    expect(w.server.pushSecrets.mock.calls).toHaveLength(2);
    expect(valuesOf(w.server).Y).toBe(OLD_DEV.Y);
    expect(w.folder.env()).toEqual(OLD_DEV);
  });

  test('the re-plan finds a conflict: SECRETS_CONFLICT, nothing uploaded', async () => {
    const racing = pushOf({ projectKey: KEY, branch: DEV, values: { ...NEW_DEV, Y: 'y-from-C' } });
    const w = world({ racing: (n) => (n === 1 ? [racing] : []) });
    const err = (await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true }).catch((e: unknown) => e)) as CapyError;
    expect(err.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(err.details).toEqual({ names: ['Y'] });
    expect(valuesOf(w.server).Y).toBe('y-from-C');
  });

  test('a resolution answers the value the user saw, not a newer one', async () => {
    const mine = { set: { X: 'x-mine' }, remove: [] };
    const answered = world();
    await commitFolder(answered.folder.ctx, mine, { resolutions: { X: 'mine' } });
    expect(valuesOf(answered.server).X).toBe('x-mine');

    const third = pushOf({ projectKey: KEY, branch: DEV, values: { ...NEW_DEV, X: 'x-from-C' } });
    const raced = world({ racing: (n) => (n === 1 ? [third] : []) });
    const err = (await commitFolder(raced.folder.ctx, mine, { resolutions: { X: 'mine' } }).catch((e: unknown) => e)) as CapyError;
    expect(err.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(valuesOf(raced.server).X).toBe('x-from-C');
  });
});

describe('the commit path', () => {
  test('a server with no keep yet: the first save creates it and sends no base', async () => {
    const server = fakeCapyServer();
    const keep: KeepFile = { version: '3.0', org_id: 'org', project_id: 'proj', project_name: 'demo', variables: {} };
    const committed = await commitToServer({ client: server.client, projectId: 'proj', branch: DEV, projectKey: KEY, startKeep: keep, changes: { set: { A: 'a' }, remove: [] } });
    expect(committed.result?.keep_hash).toBeDefined();
    expect(serverValues(server.state(), DEV, KEY)).toEqual({ A: 'a' });
    expect(server.pushSecrets.mock.calls[0][5]).toBeUndefined();
  });

  test('every push after a read names the keep it was built from', async () => {
    const w = world();
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(w.server.pushSecrets.mock.calls[0][5]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the keep that is uploaded is the server\'s, plus this branch\'s changed names only', async () => {
    const w = world();
    await writeAndSync(w.folder.ctx as never, 'Y', 'y-B', { push: true });
    const uploaded = JSON.parse(w.server.pushSecrets.mock.calls[0][1] as string) as KeepFile;
    expect(uploaded.variables.SERVER_ONLY).toBeDefined();
    expect(uploaded.variables.X.find((e) => e.branch === DEV)?.value_hash).toBe(hashValue(NEW_X));
    expect(stagingEntries(uploaded)).toEqual(stagingEntries(w.before.keep));
  });

  test('local-only mode commits the working copy without a server', async () => {
    const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: OLD_SEED.keep as KeepFile, env: { ...OLD_DEV, Y: 'y-local' }, client: undefined });
    made(folder);
    const committed = await commitFolder(folder.ctx, { set: { N: 'n' }, remove: [] });
    expect(committed.uploaded).toBe(false);
    expect(folder.env()).toEqual({ ...OLD_DEV, Y: 'y-local', N: 'n' });
    // The whole working copy is what local-only mode commits: every name is pinned to its value.
    expect(folder.pin('Y')).toBe(hashValue('y-local'));
    expect(folder.pin('N')).toBe(hashValue('n'));
  });

  test('a line this profile cannot decrypt is left on the server exactly as it is', async () => {
    const sealedLine = `capy:rid-sealed:${Encryptor.encrypt('for-someone-else', Encryptor.generateKey())}`;
    const base = seedServer({ projectKey: KEY, values: { [DEV]: OLD_DEV } });
    const baseKeep = base.keep as KeepFile;
    const keep: KeepFile = {
      ...baseKeep,
      variables: { ...baseKeep.variables, SEALED: [{ resource_id: 'rid-sealed', branch: DEV, value_hash: 'h-sealed' }] },
    };
    const blob = `${base.blobs[SyncEngine.computeKeepHash(baseKeep, DEV)]}\nSEALED=${sealedLine}`;
    const server = fakeCapyServer({ initial: { keep, blobs: { [SyncEngine.computeKeepHash(keep, DEV)]: blob } } });
    const folder = makeFolder({ projectKey: KEY, branch: DEV, keep, env: OLD_DEV, client: server.client });
    made(folder);
    await writeAndSync(folder.ctx as never, 'Y', 'y-B', { push: true });
    expect(serverLine(server.state(), DEV, 'SEALED')).toBe(`SEALED=${sealedLine}`);
    expect(serverValues(server.state(), DEV, KEY)).toEqual({ ...OLD_DEV, Y: 'y-B' });
    expect(serverHash(server.state(), DEV, 'SEALED')).toBe('h-sealed');
  });
});
