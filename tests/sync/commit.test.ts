/**
 * The shared upload (src/sync/commit.ts): what every write uses once bare `capy` has made the folder and Capy agree.
 * It decides nothing about who is right. The properties, asserted on an in-memory server (tests/helpers/fakeCapyServer.ts)
 * by decrypting its latest:
 *   - only the change moves: every other variable keeps the server's ciphertext line byte for byte, and another
 *     branch's blob and keep entries are exactly as they were;
 *   - the upload names the keep it was built from (`base_keep_hash`); a server that moved refuses it (409
 *     `SECRETS_STALE_BASE`) and nothing is written;
 *   - a keep-only change (a deploy record) re-sends the blob as stored and goes again once if the server moved;
 *   - a folder commit leaves keep.lock's branch slice and `.env` equal to the server's.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import { rmSync } from 'fs';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import {
  applyChanges,
  changesToMatch,
  commitFolder,
  retryOnceOnStale,
  snapshotFrom,
  uploadChanges,
  uploadChangesRereading,
  uploadKeepOnly,
  readSnapshot,
} from '../../src/sync/commit';
import { hashValue } from '../../src/sync/compareSecrets';
import { SyncEngine } from '../../src/sync/syncEngine';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import { fakeCapyServer, pushOf, seedServer, serverHash, serverLine, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const DEV = 'development';
const STG = 'staging';

const SEED = seedServer({ projectKey: KEY, values: { [DEV]: { X: 'x-1', Y: 'y-1', KEEP: 'k-1' }, [STG]: { X: 'x-stg', Y: 'y-stg' } } });

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

function world(opts: Parameters<typeof fakeCapyServer>[0] = {}) {
  const server = fakeCapyServer({ initial: SEED, ...opts });
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: SEED.keep as KeepFile, env: { X: 'x-1', Y: 'y-1', KEEP: 'k-1' }, client: server.client });
  made(folder);
  return { server, folder, before: server.state() };
}

const upload = (w: ReturnType<typeof world>, changes: Parameters<typeof uploadChanges>[0]['changes']) =>
  uploadChanges({ client: w.server.client, projectId: 'proj', branch: DEV, projectKey: KEY, startKeep: w.folder.ctx.keep, changes });

describe('applyChanges (pure)', () => {
  const snapshot = snapshotFrom(
    { env_content: ['A=capy:r1:AAAA', 'B=capy:r2:BBBB'].join('\n'), keep_file: undefined },
    DEV,
    KEY,
    { parseEnvContent: (c: string) => Object.fromEntries(c.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])), decryptValue: () => { throw new Error('not ours'); } },
  );

  test('a line this key cannot decrypt is kept verbatim, whatever else changes', () => {
    const applied = applyChanges({ latest: snapshot.entries, changes: { set: { C: 'new' }, remove: [] }, encryptLine: (n, v) => `capy:rC:${n}${v.length}` });
    expect(applied.lines).toEqual({ A: 'capy:r1:AAAA', B: 'capy:r2:BBBB', C: 'capy:rC:C3' });
    expect(applied.written).toEqual({ C: 'new' });
    expect(applied.env).toEqual({ C: 'new' });
  });

  test('removing a name drops its line and nothing else; removing one the server lacks is a no-op', () => {
    const applied = applyChanges({ latest: snapshot.entries, changes: { set: {}, remove: ['A', 'NOPE'] }, encryptLine: () => 'x' });
    expect(Object.keys(applied.lines)).toEqual(['B']);
    expect(applied.removed).toEqual(['A']);
  });
});

describe('changesToMatch', () => {
  test('is the change that makes Capy hold exactly the folder: what differs is set, what the folder lacks is removed', () => {
    const w = world();
    return readSnapshot(w.server.client, 'proj', DEV, KEY).then((latest) => {
      expect(changesToMatch(latest.entries, { X: 'x-1', Y: 'y-NEW', Z: 'z-NEW' })).toEqual({ set: { Y: 'y-NEW', Z: 'z-NEW' }, remove: ['KEEP'] });
      expect(changesToMatch(latest.entries, { X: 'x-1', Y: 'y-1', KEEP: 'k-1' })).toEqual({ set: {}, remove: [] });
    });
  });
});

describe('uploadChanges', () => {
  test('changes only its own name; every other line is the server\'s ciphertext byte for byte; the other branch is untouched', async () => {
    const w = world();
    const uploaded = await upload(w, { set: { Y: 'y-2' }, remove: [] });
    expect(uploaded.written).toEqual(['Y']);
    const after = w.server.state();
    expect(serverValues(after, DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-2', KEEP: 'k-1' });
    expect(serverLine(after, DEV, 'X')).toBe(serverLine(w.before, DEV, 'X'));
    expect(serverLine(after, DEV, 'KEEP')).toBe(serverLine(w.before, DEV, 'KEEP'));
    expect(serverValues(after, STG, KEY)).toEqual({ X: 'x-stg', Y: 'y-stg' });
    expect(serverHash(after, STG, 'Y')).toBe(hashValue('y-stg'));
  });

  test('names the keep it was built from: base_keep_hash is the branch hash of the keep it read', async () => {
    const w = world();
    await upload(w, { set: { Y: 'y-2' }, remove: [] });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(1);
    expect(w.server.pushSecrets.mock.calls[0][5]).toBe(SyncEngine.computeKeepHash(w.before.keep as KeepFile, DEV));
  });

  test('a server that moved since the read refuses it: SECRETS_STALE_BASE, and what a teammate saved is still there', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1' } });
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    const err = (await upload(w, { set: { Y: 'y-2' }, remove: [] }).catch((e: unknown) => e)) as CapyError;
    expect(err).toBeInstanceOf(CapyError);
    expect(err.code).toBe(ERROR_CODES.SECRETS_STALE_BASE);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1' });
  });

  test('uploadChangesRereading goes again from a fresh read, once: the teammate\'s X survives and Y lands', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1' } });
    const w = world({ racing: (n) => (n === 1 ? [teammate] : []) });
    await uploadChangesRereading({ client: w.server.client, projectId: 'proj', branch: DEV, projectKey: KEY, startKeep: w.folder.ctx.keep, changes: { set: { Y: 'y-2' }, remove: [] } });
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-TEAMMATE', Y: 'y-2', KEEP: 'k-1' });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(2);
  });

  test('a second stale refusal is thrown as it is', async () => {
    const a = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-A', Y: 'y-1', KEEP: 'k-1' } });
    const b = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-B', Y: 'y-1', KEEP: 'k-1' } });
    const w = world({ racing: (n) => (n === 1 ? [a] : n === 2 ? [b] : []) });
    await expect(uploadChangesRereading({ client: w.server.client, projectId: 'proj', branch: DEV, projectKey: KEY, startKeep: w.folder.ctx.keep, changes: { set: { Y: 'y-2' }, remove: [] } })).rejects.toMatchObject({
      code: ERROR_CODES.SECRETS_STALE_BASE,
    });
  });
});

describe('retryOnceOnStale', () => {
  const stale = () => new CapyError('stale', ERROR_CODES.SECRETS_STALE_BASE);

  test('runs the attempt once when it succeeds; goes again after `between` says to; stops (undefined) when it says not to', async () => {
    const ok = mock(async () => 'done');
    expect(await retryOnceOnStale(ok, async () => true)).toBe('done');
    expect(ok).toHaveBeenCalledTimes(1);

    const flaky = mock(async () => {
      if (flaky.mock.calls.length === 1) throw stale();
      return 'second';
    });
    expect(await retryOnceOnStale(flaky, async () => true)).toBe('second');

    const never = mock(async (): Promise<string> => {
      throw stale();
    });
    expect(await retryOnceOnStale(never, async () => false)).toBeUndefined();
    expect(never).toHaveBeenCalledTimes(1);
  });

  test('a second stale refusal, and any other error, are thrown', async () => {
    const always = mock(async (): Promise<string> => {
      throw stale();
    });
    await expect(retryOnceOnStale(always, async () => true)).rejects.toMatchObject({ code: ERROR_CODES.SECRETS_STALE_BASE });
    expect(always).toHaveBeenCalledTimes(2);
    await expect(retryOnceOnStale(async () => Promise.reject(new Error('boom')), async () => true)).rejects.toThrow('boom');
  });
});

describe('uploadKeepOnly (a deploy record, a connector entry: no value moves)', () => {
  const addNote = (keep: KeepFile): KeepFile => ({
    ...keep,
    variables: { ...keep.variables, X: keep.variables.X.map((e) => (e.branch === DEV ? { ...e, targets: [{ provider: 'dokploy', target: 't1' }] } : e)) },
  });
  const clientOf = (server: ReturnType<typeof fakeCapyServer>) => ({
    getLatestSecrets: async (_p: string, branch: string) => {
      const state = server.state();
      const hash = SyncEngine.computeKeepHash(state.keep as KeepFile, branch);
      return { env_file: state.blobs[hash] ?? '', keep_hash: hash, keep_file: JSON.stringify(state.keep) };
    },
    pushSecrets: server.pushSecrets,
  });

  test('re-sends the blob exactly as the server holds it and names the keep it read', async () => {
    const w = world();
    const done = await uploadKeepOnly(clientOf(w.server), 'proj', DEV, addNote);
    expect(done).toMatchObject({ ok: true, pushed: true });
    const after = w.server.state();
    expect(serverLine(after, DEV, 'X')).toBe(serverLine(w.before, DEV, 'X'));
    expect(serverValues(after, DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-1', KEEP: 'k-1' });
    expect(w.server.pushSecrets.mock.calls[0][5]).toBe(SyncEngine.computeKeepHash(w.before.keep as KeepFile, DEV));
  });

  test('nothing to change: nothing is pushed', async () => {
    const w = world();
    expect(await uploadKeepOnly(clientOf(w.server), 'proj', DEV, (k) => k)).toMatchObject({ ok: true, pushed: false });
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a server that moved in between: read again and go once more, on top of what a teammate saved', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1' } });
    const w = world({ racing: () => [] });
    // The race: the teammate saves between this writer's read and its push (the read count is the writer's, so arm it on the first push).
    const raced = {
      getLatestSecrets: clientOf(w.server).getLatestSecrets,
      pushSecrets: mock(async (...args: Parameters<typeof w.server.pushSecrets>) => {
        if (raced.pushSecrets.mock.calls.length === 1) w.server.tape(teammate);
        return w.server.pushSecrets(...args);
      }),
    };
    const done = await uploadKeepOnly(raced, 'proj', DEV, addNote);
    expect(done).toMatchObject({ ok: true, pushed: true });
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-TEAMMATE');
    expect(w.server.state().keep?.variables.X.find((e) => e.branch === DEV)).toMatchObject({ targets: [{ provider: 'dokploy', target: 't1' }] });
  });

  test('a failure is a code, never a throw', async () => {
    const down = { getLatestSecrets: async () => Promise.reject(new CapyError('down', ERROR_CODES.NETWORK_ERROR)), pushSecrets: async () => ({}) };
    expect(await uploadKeepOnly(down, 'proj', DEV, addNote)).toEqual({ ok: false, code: ERROR_CODES.NETWORK_ERROR });
  });
});

describe('commitFolder: the folder after a commit is the server\'s latest plus the change', () => {
  test('.env and keep.lock\'s branch slice equal the server; the other branch\'s pins did not move', async () => {
    const teammate = pushOf({ projectKey: KEY, branch: DEV, values: { X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1', SERVER_ONLY: 's' } });
    // The folder agreed with Capy (bare `capy` ran); here Capy is the SEED plus a later teammate save the folder has now pulled.
    const synced = fakeCapyServer({ initial: SEED });
    synced.tape(teammate);
    const folder = makeFolder({
      projectKey: KEY,
      branch: DEV,
      keep: synced.state().keep as KeepFile,
      env: { X: 'x-TEAMMATE', Y: 'y-1', KEEP: 'k-1', SERVER_ONLY: 's' },
      client: synced.client,
    });
    made(folder);
    const done = await commitFolder(folder.ctx, { set: { Z: 'z-new' }, remove: ['KEEP'] });
    expect(done.uploaded).toBe(true);
    const after = synced.state();
    expect(serverValues(after, DEV, KEY)).toEqual({ X: 'x-TEAMMATE', Y: 'y-1', SERVER_ONLY: 's', Z: 'z-new' });
    expect(folder.env()).toEqual(serverValues(after, DEV, KEY));
    expect(folder.pin('Z')).toBe(hashValue('z-new'));
    expect(folder.pin('KEEP')).toBeUndefined();
    expect(serverValues(after, STG, KEY)).toEqual({ X: 'x-stg', Y: 'y-stg' });
  });
});
