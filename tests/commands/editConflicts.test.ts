/**
 * Conflicts inside `capy edit` (CAP-714), asserted as properties on the real screen, the real loader and the real
 * commit path, against the in-memory server of tests/helpers/fakeCapyServer.ts:
 *   - the "remote" column is the server's LATEST, not the folder's pinned snapshot: a stale folder shows what the
 *     server changed as `remote`, and what both changed as `conflict`;
 *   - nothing is committed while a conflict is undecided (the server is byte-for-byte what it was);
 *   - mine writes the folder's value, theirs keeps the server's and `.env` takes it, remote rows are pulled;
 *   - the server moving between showing and committing reopens the conflict and overwrites nothing.
 *
 * World: the folder is pinned to an OLD snapshot. Since then the server changed X and Y (someone else saved).
 * In the folder: X was edited (so X is a conflict), Y is as pinned (so Y is `remote`), Z was edited and the server
 * did not touch it (`local`), W is the same everywhere (`in sync`).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { boundResolutions, buildEditRows, editLoader, saveEdits } from '../../src/commands/editCommand';
import { findConflicts, readSnapshot, snapshotFrom } from '../../src/sync/commit';
import { hashValue } from '../../src/sync/compareSecrets';
import { EditScreen, focusedOn, reclassifyRow, type EditRow, type EditState } from '../../src/ui/editScreen';
import type { KeepFile } from '../../src/types/index';
import { fakeCapyServer, pushOf, seedServer, serverValues, type FakeServerOpts } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const DEV = 'development';

const OLD = { W: 'w-same', X: 'x-old', Y: 'y-old', Z: 'z-old' } as const;
const SERVER = { W: 'w-same', X: 'x-A', Y: 'y-A', Z: 'z-old' } as const;
const FOLDER = { W: 'w-same', X: 'x-B', Y: 'y-old', Z: 'z-B' } as const;

const OLD_SEED = seedServer({ projectKey: KEY, values: { [DEV]: OLD } });
const NEW_SEED = seedServer({ projectKey: KEY, values: { [DEV]: SERVER } });

const globalDirName = `.capy-test-editconf-${process.pid}`;
const savedGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
beforeAll(() => {
  process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
});
afterAll(() => {
  rmSync(getGlobalCapyDir(), { recursive: true, force: true });
  if (savedGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
  else process.env.CAPY_GLOBAL_DIR_NAME = savedGlobalDirName;
});

const made = mock((_: Folder) => undefined);
afterEach(() => made.mock.calls.forEach(([folder]) => removeFolder(folder)));

const noLog = { record: mock((_: unknown) => undefined) };

function world(opts: Pick<FakeServerOpts, 'racing'> = {}) {
  const server = fakeCapyServer({ initial: NEW_SEED, racing: opts.racing });
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: OLD_SEED.keep as KeepFile, env: FOLDER, client: server.client });
  made(folder);
  const load = editLoader({
    pm: folder.pm,
    fileManager: folder.fileManager,
    serviceClient: server.client as never,
    localMode: false,
    keep: folder.ctx.keep,
    branch: DEV,
    orgId: folder.ctx.orgId,
    projectId: folder.ctx.projectId,
    projectKey: KEY,
    configuredTargets: [],
  });
  const parts = { ...folder.ctx };
  const ctx = {
    saveLocalEdits: (set: Record<string, string>, bound?: Parameters<typeof saveEdits>[4]) => saveEdits(parts, folder.ctx.keep, set, noLog, bound),
    reload: load,
  };
  return { server, folder, load, ctx, before: server.state() };
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B';

/** Runs the real screen on `state`; `press` sends a key chunk, `frame` is the last frame drawn (colour removed). */
function screenOn(state: EditState, ctx: ReturnType<typeof world>['ctx']) {
  const out = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const done = new EditScreen().run(state, ctx);
  const frame = (): string => strip(String(out.mock.calls[out.mock.calls.length - 1]?.[0] ?? ''));
  return {
    press: (key: string) => {
      process.stdin.emit('data', Buffer.from(key));
    },
    frame,
    /** Waits until the last frame satisfies `cond`. */
    until: async (cond: (frame: string) => boolean) => {
      for (const _ of Array.from({ length: 400 })) {
        if (cond(frame())) return frame();
        await sleep(5);
      }
      throw new Error(`the screen never showed what was expected:\n${frame()}`);
    },
    finish: async () => {
      process.stdin.emit('data', Buffer.from('\x03'));
      await done;
      out.mockRestore();
    },
  };
}

/** The frame line of a variable's row. */
const rowLine = (frame: string, key: string): string => frame.split('\n').find((l) => l.includes(` ${key} `) && l.includes('●')) ?? '';

async function open(w: ReturnType<typeof world>) {
  const loaded = await w.load();
  const state: EditState = { projectName: 'demo', branch: DEV, rows: loaded.rows, remoteAvailable: loaded.remoteAvailable, seen: loaded.seen };
  return { loaded, screen: screenOn(state, w.ctx) };
}

/** Rows are W, X, Y, Z: the cursor starts on W. */
const goTo = (screen: ReturnType<typeof screenOn>, key: 'W' | 'X' | 'Y' | 'Z') => Array.from({ length: 'WXYZ'.indexOf(key) }).forEach(() => screen.press(DOWN));

/** Edits Z to `value` and leaves the cursor on Z. */
function editZ(screen: ReturnType<typeof screenOn>, value: string): void {
  goTo(screen, 'Z');
  screen.press('e');
  screen.press(value);
  screen.press('\r');
}

describe('the rows compare against the server\'s latest, three ways', () => {
  test('a stale folder: the server\'s change is `remote`, both-changed is `conflict`, yours alone is `local`, the rest is `in sync`', async () => {
    const w = world();
    const { rows } = await w.load();
    expect(Object.fromEntries(rows.map((r) => [r.key, r.status]))).toEqual({ W: 'in sync', X: 'conflict', Y: 'remote', Z: 'local' });
  });

  test('the old behaviour is gone: Y is NOT "in sync" just because the folder\'s pinned snapshot agrees with its .env', async () => {
    const w = world();
    const { rows } = await w.load();
    // Against the pinned snapshot Y reads "y-old" on both sides.
    expect(w.folder.env().Y).toBe(OLD.Y);
    expect(rows.find((r) => r.key === 'Y')?.status).not.toBe('in sync');
  });

  test('the screen says so: the status column and the summary cells count drift and conflicts truthfully', async () => {
    const w = world();
    const { screen } = await open(w);
    const frame = screen.frame();
    expect(rowLine(frame, 'X')).toContain('conflict');
    expect(rowLine(frame, 'Y')).toContain('remote');
    expect(rowLine(frame, 'Z')).toContain('local');
    expect(rowLine(frame, 'W')).toContain('in sync');
    expect(frame).toContain('2 drift'); // Y and Z
    expect(frame).toContain('1 conflicts');
    expect(frame).toContain('need resolution');
    await screen.finish();
  });

  test('one read of the server for the first screen (the one the commit is planned against)', async () => {
    const w = world();
    await open(w).then(({ screen }) => screen.finish());
    expect(w.server.getDecryptData.mock.calls).toHaveLength(1);
  });

  test('the shown read is kept: the screen state carries it for the commit', async () => {
    const w = world();
    const { loaded } = await open(w).then(async (o) => (await o.screen.finish(), o));
    expect(loaded.seen).toBeDefined();
    expect(loaded.seen?.entries.X.plaintext).toBe(SERVER.X);
  });
});

describe('a row\'s status is the commit path\'s own test (property over every pin / yours / theirs combination)', () => {
  const values = [undefined, 'a', 'b', 'c'] as const;
  const row = (pinned: string | undefined, local: string | undefined, remote: string | undefined): EditRow => ({
    key: 'N',
    localValue: local,
    remoteValue: remote,
    status: 'unknown',
    updatedLabel: '—',
    pinnedHash: pinned === undefined ? null : hashValue(pinned),
  });

  test('`conflict` exactly when findConflicts reports the name (a value you hold, over a server value that moved and differs)', () => {
    const combos = values.flatMap((pinned) => values.flatMap((local) => values.map((remote) => ({ pinned, local, remote }))));
    expect(combos).toHaveLength(64);
    combos.forEach(({ pinned, local, remote }) => {
      const status = reclassifyRow(row(pinned, local, remote), { remoteAvailable: true });
      const latest = remote === undefined ? {} : { N: { line: 'l', plaintext: remote, hash: hashValue(remote) } };
      const contested =
        local !== undefined &&
        findConflicts({
          pinned: pinned === undefined ? {} : { N: hashValue(pinned) },
          latest,
          changes: { set: { N: local }, remove: [] },
        }).length > 0;
      // A value you changed (not just still hold from the pin) is what a conflict is about.
      const youChanged = local !== undefined && local !== pinned;
      expect(status === 'conflict', JSON.stringify({ pinned, local, remote, status })).toBe(youChanged && contested);
    });
  });

  test('the other statuses: in sync, local, remote', () => {
    const status = (pinned: string | undefined, local: string | undefined, remote: string | undefined) =>
      reclassifyRow(row(pinned, local, remote), { remoteAvailable: true });
    expect(status('a', 'a', 'a')).toBe('in sync');
    expect(status('a', 'b', 'a')).toBe('local');
    expect(status('a', 'a', 'b')).toBe('remote');
    // Both changed to the same value: nothing to do.
    expect(status('a', 'b', 'b')).toBe('in sync');
    // Both changed to different values.
    expect(status('a', 'b', 'c')).toBe('conflict');
    // The server dropped it and you edited it.
    expect(status('a', 'b', undefined)).toBe('conflict');
    // A brand-new variable on both sides, different.
    expect(status(undefined, 'b', 'c')).toBe('conflict');
  });
});

describe('boundResolutions: a decision applies only to the values it was made against', () => {
  const seen = snapshotFrom(
    { env_content: `X=capy:rid:${Encryptor.encrypt('x-A', KEY)}`, keep_file: JSON.stringify(NEW_SEED.keep) },
    DEV,
    KEY,
  );
  const decision = (choice: 'mine' | 'theirs', theirs: string | null, yours: string | null) => ({ X: { choice, theirs, yours } });

  test('kept while the server\'s value and your value are the ones decided against', () => {
    expect(boundResolutions(decision('mine', hashValue('x-A'), hashValue('x-B')), seen, { X: 'x-B' })).toEqual({ X: 'mine' });
  });
  test('dropped when the server\'s value is not the one decided against', () => {
    expect(boundResolutions(decision('mine', hashValue('x-older'), hashValue('x-B')), seen, { X: 'x-B' })).toEqual({});
  });
  test('dropped when your value is not the one decided with', () => {
    expect(boundResolutions(decision('mine', hashValue('x-A'), hashValue('x-B')), seen, { X: 'x-other' })).toEqual({});
  });
  test('dropped when there is no read to bind to', () => {
    expect(boundResolutions(decision('theirs', hashValue('x-A'), hashValue('x-B')), undefined, { X: 'x-B' })).toEqual({});
  });
});

describe('committing from the screen', () => {
  test('`c` with an unresolved conflict uploads NOTHING: the server is exactly as it was, the status names the variable', async () => {
    const w = world();
    const { screen } = await open(w);
    editZ(screen, 'z-new');
    screen.press('c');
    await screen.until((f) => f.includes('Nothing was uploaded'));
    expect(screen.frame()).toContain('X');
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.server.state()).toEqual(w.before);
    // The folder is untouched too.
    expect(w.folder.env()).toEqual(FOLDER);
    await screen.finish();
  });

  test('quit-with-commit follows the same rule: blocked, nothing uploaded', async () => {
    const w = world();
    const { screen } = await open(w);
    editZ(screen, 'z-new');
    screen.press('q');
    expect(screen.frame()).toContain('uncommitted change');
    screen.press('c');
    await screen.until((f) => f.includes('Nothing was uploaded'));
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.server.state()).toEqual(w.before);
    // Still on the screen: Ctrl-C leaves it.
    await screen.finish();
  });

  test('mine: the server decrypts to the folder\'s value, the edit goes with it, and the remote row is pulled', async () => {
    const w = world();
    const { screen } = await open(w);
    editZ(screen, 'z-new');
    // From Z (where the edit left the cursor) back up to X.
    Array.from({ length: 2 }).forEach(() => screen.press('\x1b[A'));
    screen.press('m');
    expect(rowLine(screen.frame(), 'X')).toContain('conflict: mine');
    screen.press('c');
    await screen.until((f) => f.includes('Committed'));
    const values = serverValues(w.server.state(), DEV, KEY);
    expect(values.X).toBe(FOLDER.X);
    expect(values.Z).toBe('z-new');
    // Y was only changed by the other side: it stays theirs on the server, and the folder pulled it.
    expect(values.Y).toBe(SERVER.Y);
    expect(w.folder.env()).toEqual({ W: 'w-same', X: FOLDER.X, Y: SERVER.Y, Z: 'z-new' });
    // The screen re-read: nothing left to decide.
    expect(rowLine(screen.frame(), 'X')).toContain('in sync');
    expect(rowLine(screen.frame(), 'Y')).toContain('in sync');
    await screen.finish();
  });

  test('theirs: nothing is uploaded for it, the server keeps theirs, and the folder\'s .env takes it', async () => {
    const w = world();
    const { screen } = await open(w);
    goTo(screen, 'X');
    screen.press('t');
    expect(rowLine(screen.frame(), 'X')).toContain('conflict: theirs');
    screen.press('c');
    await screen.until((f) => f.includes('Committed'));
    expect(w.server.pushSecrets.mock.calls).toHaveLength(0);
    expect(w.server.state()).toEqual(w.before);
    expect(w.folder.env().X).toBe(SERVER.X);
    expect(w.folder.env().Y).toBe(SERVER.Y);
    await screen.finish();
  });

  test('the footer offers m / t on a conflict row, and not elsewhere', async () => {
    const w = world();
    const { screen } = await open(w);
    expect(screen.frame()).not.toContain('mine');
    goTo(screen, 'X');
    expect(screen.frame()).toContain('mine');
    expect(screen.frame()).toContain('theirs');
    screen.press('\x1b[B');
    expect(screen.frame()).not.toContain(' m mine');
    await screen.finish();
  });

  test('`capy edit NAME` opens this screen on NAME: a conflicting NAME starts with m / t on offer', async () => {
    const w = world();
    const loaded = await w.load();
    const state = focusedOn({ projectName: 'demo', branch: DEV, rows: loaded.rows, remoteAvailable: loaded.remoteAvailable, seen: loaded.seen }, 'X');
    const screen = screenOn(state, w.ctx);
    expect(screen.frame()).toContain('mine');
    expect(screen.frame()).toMatch(/▶ X /);
    await screen.finish();
  });

  test('m and t do nothing on a row that is not a conflict', async () => {
    const w = world();
    const { screen } = await open(w);
    goTo(screen, 'Y');
    screen.press('m');
    expect(rowLine(screen.frame(), 'Y')).toContain('remote');
    await screen.finish();
  });

  test('the server moves between showing and committing: the conflict is shown again, the old decision is NOT applied, nothing is overwritten', async () => {
    // Someone else saves X again right after the screen\'s first read.
    const w = world({ racing: (n) => (n === 1 ? [pushOf({ projectKey: KEY, branch: DEV, values: { ...SERVER, X: 'x-C' } })] : []) });
    const { screen } = await open(w);
    editZ(screen, 'z-typed');
    Array.from({ length: 2 }).forEach(() => screen.press('\x1b[A'));
    screen.press('m');
    screen.press('c');
    await screen.until((f) => f.includes('X changed on the server'));
    // What was typed is still there, uncommitted, across the re-read.
    expect(rowLine(screen.frame(), 'Z')).toContain('local');
    expect(screen.frame()).toContain('z-t...ped');
    // Nothing of ours is on the server: X is the newest value someone else saved.
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-C');
    expect(rowLine(screen.frame(), 'X')).toContain('conflict');
    expect(rowLine(screen.frame(), 'X')).not.toContain('mine');
    expect(w.folder.env().X).toBe(FOLDER.X);
    // Deciding again, against what is shown now, goes through.
    screen.press('m');
    screen.press('c');
    await screen.until((f) => f.includes('Committed'));
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe(FOLDER.X);
    expect(serverValues(w.server.state(), DEV, KEY).Z).toBe('z-typed');
    await screen.finish();
  });

  test('theirs when the server moved again: only the server\'s value is taken, nothing is uploaded, and the screen shows the newer change as `remote`', async () => {
    const w = world({ racing: (n) => (n === 1 ? [pushOf({ projectKey: KEY, branch: DEV, values: { ...SERVER, X: 'x-C' } })] : []) });
    const { screen } = await open(w);
    goTo(screen, 'X');
    screen.press('t');
    screen.press('c');
    await screen.until((f) => f.includes('Committed'));
    // The server is as the other writer left it; we wrote nothing.
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-C');
    expect(w.server.accepted()).toHaveLength(1);
    // The folder took what was decided on (x-A), so the newer x-C is still to be pulled: the row says so.
    expect(rowLine(screen.frame(), 'X')).toContain('remote');
    await screen.finish();
  });

  test('editing a `remote` row makes it a conflict with the server\'s value', async () => {
    const w = world();
    const { screen } = await open(w);
    goTo(screen, 'Y');
    screen.press('e');
    screen.press('y-typed');
    screen.press('\r');
    expect(rowLine(screen.frame(), 'Y')).toContain('conflict');
    await screen.finish();
  });
});

describe('editLoader / buildEditRows', () => {
  test('a read the server cannot answer leaves the rows `unknown` (nothing to compare against)', async () => {
    const w = world();
    const broken = { getDecryptData: async () => { throw new Error('offline'); }, pushSecrets: async () => ({ keep_hash: '' }) };
    const load = editLoader({
      pm: w.folder.pm,
      fileManager: w.folder.fileManager,
      serviceClient: broken as never,
      localMode: false,
      keep: w.folder.ctx.keep,
      branch: DEV,
      orgId: w.folder.ctx.orgId,
      projectId: w.folder.ctx.projectId,
      projectKey: KEY,
      configuredTargets: [],
    });
    const loaded = await load();
    expect(loaded.remoteAvailable).toBe(false);
    expect(loaded.rows.every((r) => r.status === 'unknown')).toBe(true);
  });

  test('UPDATED comes from the server\'s keep (when the value last changed there)', async () => {
    const w = world();
    const snapshot = await readSnapshot(w.server.client, w.folder.ctx.projectId, DEV, KEY);
    const rows = buildEditRows({
      localMode: false,
      branch: DEV,
      keep: w.folder.ctx.keep,
      localPlaintext: w.folder.env(),
      baseline: { entries: {}, keep: { ...(snapshot.keep as KeepFile), variables: { X: [{ resource_id: 'r', branch: DEV, value_hash: 'h', changed_at: new Date().toISOString() }] } }, available: true, seen: snapshot },
      configuredTargets: [],
    });
    expect(rows.find((r) => r.key === 'X')?.updatedLabel).not.toBe('—');
  });
});

describe('local-only mode is unchanged: committed-vs-working, no server', () => {
  test('a save is read back as committed, with local-mode wording', async () => {
    const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: OLD_SEED.keep as KeepFile, env: OLD, client: undefined });
    made(folder);
    const load = editLoader({
      pm: folder.pm,
      fileManager: folder.fileManager,
      serviceClient: undefined,
      localMode: true,
      keep: folder.ctx.keep,
      branch: DEV,
      orgId: folder.ctx.orgId,
      projectId: folder.ctx.projectId,
      projectKey: KEY,
      configuredTargets: [],
    });
    const before = await load();
    expect(before.remoteAvailable).toBe(false);
    expect(before.rows.every((r) => r.status === 'local' && r.updatedLabel === 'uncommitted')).toBe(true);
    await saveEdits({ ...folder.ctx }, folder.ctx.keep, { Z: 'z-local' }, noLog);
    const after = await load();
    expect(after.rows.find((r) => r.key === 'Z')).toMatchObject({ localValue: 'z-local', remoteValue: 'z-local', status: 'in sync', updatedLabel: 'committed' });
    // No server read, no three-way pin in local mode.
    expect(after.seen).toBeUndefined();
    expect(after.rows.every((r) => r.pinnedHash === undefined)).toBe(true);
  });
});
