/**
 * Placeholders in keep.lock: a name on a branch with NO value yet (an import could not read it).
 *
 * The properties, on an in-memory server (tests/helpers/fakeCapyServer.ts) and a real folder on disk:
 *   - a placeholder is a typed flag on the branch's keep entry with an empty hash; the blob holds no line for it,
 *     and no value or stand-in string appears anywhere;
 *   - it round-trips: server keep, the folder's keep.lock, and a fresh read of the folder all say the same;
 *   - `.env` gets one comment line for it (idempotent, layout preserved), and no variable;
 *   - sync does not treat it as pinned, missing or conflicting, and rebuilding the branch's pins keeps it;
 *   - writing a real value by any path (`capy edit`, `capy add --force`, the editor screen) removes the flag and the note.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { saveEdits } from '../../src/commands/editCommand';
import { writeAndSync, writeImportedAndSync, type ResolvedContext } from '../../src/commands/connectors/shared';
import { classifyPipedWrite, variableExists } from '../../src/commands/pipedWrite';
import { placeholderEnvNote, placeholderOf, placeholdersOnBranch } from '../../src/core/placeholder';
import { upsertEnvText } from '../../src/files/envUpsert';
import { hashValue } from '../../src/sync/compareSecrets';
import { commitFolder, keepForEnv, pinnedHashes } from '../../src/sync/commit';
import { SyncEngine } from '../../src/sync/syncEngine';
import type { KeepFile } from '../../src/types/index';
import { fakeCapyServer, seedServer, serverLine, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const DEV = 'development';
const MARKER = { provider: 'vercel', reason: 'sensitive_unreadable' } as const;
const SEED = seedServer({ projectKey: KEY, values: { [DEV]: { X: 'x-1', Y: 'y-1' }, production: { X: 'x-prod' } } });
const NOTE = placeholderEnvNote('SECRET_KEY', MARKER);

const globalDirName = `.capy-test-placeholders-${process.pid}`;
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

function world() {
  const server = fakeCapyServer({ initial: SEED });
  const folder = makeFolder({ projectKey: KEY, branch: DEV, keep: SEED.keep as KeepFile, env: { X: 'x-1', Y: 'y-1' }, client: server.client });
  made(folder);
  return { server, folder };
}

/** The folder as a connector's write sees it. */
const asContext = (folder: Folder, server: ReturnType<typeof fakeCapyServer>): ResolvedContext =>
  ({ ...folder.ctx, serviceClient: server.client, keep: folder.keep(), localPlaintext: folder.env() }) as unknown as ResolvedContext;

const envText = (folder: Folder): string => readFileSync(join(folder.dir, '.env'), 'utf-8');
const noteLines = (text: string): readonly string[] => text.split('\n').filter((l) => l === NOTE);

/** Records SECRET_KEY as a placeholder on the folder's branch, pushed. */
async function importPlaceholder(w: ReturnType<typeof world>): Promise<void> {
  await writeImportedAndSync(asContext(w.folder, w.server), [], {
    push: true,
    placeholders: [{ name: 'SECRET_KEY', marker: MARKER }],
  });
}

describe('recording a placeholder', () => {
  test('is a typed flag with an empty hash on the branch entry; the blob has no line for it; nothing else moves', async () => {
    const w = world();
    const before = w.server.state();
    await importPlaceholder(w);
    const after = w.server.state();

    const entry = after.keep?.variables.SECRET_KEY?.find((e) => e.branch === DEV);
    expect(entry).toMatchObject({ branch: DEV, value_hash: '', placeholder: MARKER });
    expect(entry).not.toHaveProperty('connector');
    expect(serverValues(after, DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-1' });
    expect(serverLine(after, DEV, 'SECRET_KEY')).toBeUndefined();
    expect(serverLine(after, DEV, 'X')).toBe(serverLine(before, DEV, 'X'));
    const entryOf = (state: typeof after, branch: string) => state.keep?.variables.X?.find((e) => e.branch === branch);
    expect(entryOf(after, DEV)?.value_hash).toBe(entryOf(before, DEV)?.value_hash);
    expect(entryOf(after, 'production')).toEqual(entryOf(before, 'production'));
  });

  test('round-trips: the folder\'s keep.lock equals the server\'s branch slice, and a fresh read still has the flag', async () => {
    const w = world();
    await importPlaceholder(w);
    const onServer = w.server.state().keep?.variables.SECRET_KEY?.find((e) => e.branch === DEV);
    const onDisk = w.folder.keep().variables.SECRET_KEY?.find((e) => e.branch === DEV);
    expect(onDisk).toEqual(onServer);
    expect(placeholderOf(w.folder.pm.readKeepFile(), 'SECRET_KEY', DEV)).toEqual(MARKER);
    expect(placeholdersOnBranch(w.folder.keep(), DEV).map((p) => p.name)).toEqual(['SECRET_KEY']);
  });

  test('never writes a value or a stand-in string: not in keep.lock, not in .env, not on the server', async () => {
    const w = world();
    await importPlaceholder(w);
    const everything = [
      readFileSync(join(w.folder.dir, '.capy', 'keep.lock'), 'utf-8'),
      envText(w.folder),
      JSON.stringify(w.server.state()),
    ].join('\n');
    expect(everything).not.toMatch(/\[vercel-sensitive-value\]|\[.*sensitive.*value.*\]/i);
    expect(w.folder.env()).toEqual({ X: 'x-1', Y: 'y-1' });
  });

  test('.env gets exactly one comment line and no variable; a second import writes nothing and changes nothing', async () => {
    const w = world();
    await importPlaceholder(w);
    const first = envText(w.folder);
    expect(noteLines(first)).toHaveLength(1);
    expect(first).not.toMatch(/^SECRET_KEY=/m);
    const pushesAfterFirst = w.server.tape.mock.calls.length;

    await importPlaceholder(w);
    // (A value line is re-encrypted on every write, so its ciphertext differs; the shape and the rest do not.)
    const shape = (text: string): string => text.replace(/=capy:([a-z0-9]+):[^\n]*/g, '=capy:$1:*');
    expect(shape(envText(w.folder))).toBe(shape(first));
    expect(w.server.tape.mock.calls.length).toBe(pushesAfterFirst);
  });

  test('a name that already has a value on the branch keeps it: the flag is never put over a value', async () => {
    const w = world();
    await writeImportedAndSync(asContext(w.folder, w.server), [], { push: true, placeholders: [{ name: 'X', marker: MARKER }] });
    expect(placeholderOf(w.server.state().keep, 'X', DEV)).toBeUndefined();
    expect(serverValues(w.server.state(), DEV, KEY).X).toBe('x-1');
    expect(w.server.state().keep?.variables.X?.find((e) => e.branch === DEV)?.value_hash).toBe(hashValue('x-1'));
  });

  test('the same name on another branch is its own entry: production keeps its value', async () => {
    const w = world();
    await importPlaceholder(w);
    expect(placeholderOf(w.server.state().keep, 'SECRET_KEY', 'production')).toBeUndefined();
    expect(w.server.state().keep?.variables.X?.find((e) => e.branch === 'production')?.value_hash).toBe(hashValue('x-prod'));
  });
});

describe('.env layout', () => {
  const existing = ['# my notes', '', 'A=1', '', '# --- infra ---', 'B=2 # keep', ''].join('\n');

  test('the note is appended once; every other line is byte for byte as it was, in the same order', () => {
    const out = upsertEnvText(existing, {}, [['A', '1'], ['B', '2']], { ensure: [NOTE], drop: [] });
    expect(out.startsWith(existing)).toBe(true);
    expect(out.slice(existing.length)).toBe(`${NOTE}\n`);
    expect(upsertEnvText(out, {}, [['A', '1'], ['B', '2']], { ensure: [NOTE], drop: [] })).toBe(out);
  });

  test('a note that is already somewhere stays where it is (no duplicate, no move)', () => {
    const text = ['A=1', NOTE, 'B=2', ''].join('\n');
    expect(upsertEnvText(text, {}, [['A', '1'], ['B', '2']], { ensure: [NOTE], drop: [] })).toBe(text);
  });

  test('a note to drop is removed and nothing else is', () => {
    const text = ['A=1', NOTE, 'B=2', ''].join('\n');
    expect(upsertEnvText(text, {}, [['A', '1'], ['B', '2']], { ensure: [], drop: [NOTE] })).toBe('A=1\nB=2\n');
  });

  test('a real file keeps the person\'s comments and order through an import', async () => {
    const w = world();
    const before = envText(w.folder);
    writeFileSync(join(w.folder.dir, '.env'), `# my notes\n${before}`);
    await importPlaceholder(w);
    const after = envText(w.folder);
    expect(after.startsWith('# my notes\n')).toBe(true);
    expect(noteLines(after)).toHaveLength(1);
    expect(after.indexOf('X=')).toBeLessThan(after.indexOf('Y='));
  });
});

describe('sync does not see a placeholder as a value', () => {
  test('it is not pinned, so it is never compared, restored or dropped with the pins', async () => {
    const w = world();
    await importPlaceholder(w);
    expect(Object.keys(pinnedHashes(w.folder.keep(), DEV)).sort()).toEqual(['X', 'Y']);
    expect(pinnedHashes(w.folder.keep(), DEV)).not.toHaveProperty('SECRET_KEY');
  });

  test('rebuilding the branch\'s pins from an env (retrieve / row-by-row) keeps the placeholder', async () => {
    const w = world();
    await importPlaceholder(w);
    const rebuilt = keepForEnv(w.folder.keep(), DEV, { X: 'x-1' });
    expect(placeholderOf(rebuilt, 'SECRET_KEY', DEV)).toEqual(MARKER);
    expect(rebuilt.variables.Y).toBeUndefined();
  });

  test('committing the folder\'s values (bare `capy`, commit local) leaves the placeholder alone', async () => {
    const w = world();
    await importPlaceholder(w);
    await commitFolder({ ...asContext(w.folder, w.server) }, { set: { Y: 'y-2' }, remove: [] });
    expect(placeholderOf(w.server.state().keep, 'SECRET_KEY', DEV)).toEqual(MARKER);
    expect(noteLines(envText(w.folder))).toHaveLength(1);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-2' });
  });

  test('the keep hash agrees between client and the server\'s copy (the flag does not perturb it)', async () => {
    const w = world();
    await importPlaceholder(w);
    expect(SyncEngine.computeKeepHash(w.folder.keep(), DEV)).toBe(SyncEngine.computeKeepHash(w.server.state().keep as KeepFile, DEV));
  });

  test('capy edit NAME / capy add NAME see it as existing (so --force is what writes it)', async () => {
    const w = world();
    await importPlaceholder(w);
    const ctx = asContext(w.folder, w.server);
    expect(variableExists(ctx, 'SECRET_KEY')).toBe(true);
    expect(classifyPipedWrite(ctx, 'SECRET_KEY', 'v')).toBe('updated');
  });
});

describe('a real value clears it', () => {
  const cleared = (w: ReturnType<typeof world>, value: string) => {
    const server = w.server.state();
    expect(placeholderOf(server.keep, 'SECRET_KEY', DEV)).toBeUndefined();
    expect(server.keep?.variables.SECRET_KEY?.find((e) => e.branch === DEV)).toMatchObject({ value_hash: hashValue(value) });
    expect(placeholderOf(w.folder.keep(), 'SECRET_KEY', DEV)).toBeUndefined();
    expect(serverValues(server, DEV, KEY).SECRET_KEY).toBe(value);
    expect(w.folder.env().SECRET_KEY).toBe(value);
    expect(noteLines(envText(w.folder))).toHaveLength(0);
  };

  test('capy edit NAME (piped), capy edit NAME (prompt) and capy add NAME --force: the single-variable save', async () => {
    const w = world();
    await importPlaceholder(w);
    await writeAndSync(asContext(w.folder, w.server), 'SECRET_KEY', 'real-value-1', { push: true });
    cleared(w, 'real-value-1');
  });

  test('the editor screen\'s save', async () => {
    const w = world();
    await importPlaceholder(w);
    const { keep: _keep, localPlaintext: _local, ...folder } = asContext(w.folder, w.server);
    await saveEdits(folder, w.folder.keep(), { SECRET_KEY: 'real-value-2' }, { record: () => undefined });
    cleared(w, 'real-value-2');
  });

  test('without pushing (--no-push): the folder\'s keep.lock and .env are cleared too', async () => {
    const w = world();
    await importPlaceholder(w);
    await writeAndSync({ ...asContext(w.folder, w.server) }, 'SECRET_KEY', 'real-value-3', { push: false });
    expect(placeholderOf(w.folder.keep(), 'SECRET_KEY', DEV)).toBeUndefined();
    expect(w.folder.env().SECRET_KEY).toBe('real-value-3');
    expect(noteLines(envText(w.folder))).toHaveLength(0);
  });

  test('removing the name (capy remove) drops the entry and the note', async () => {
    const w = world();
    await importPlaceholder(w);
    await commitFolder(asContext(w.folder, w.server), { set: {}, remove: ['SECRET_KEY'] });
    expect(w.server.state().keep?.variables.SECRET_KEY).toBeUndefined();
    expect(w.folder.keep().variables.SECRET_KEY).toBeUndefined();
    expect(noteLines(envText(w.folder))).toHaveLength(0);
    expect(serverValues(w.server.state(), DEV, KEY)).toEqual({ X: 'x-1', Y: 'y-1' });
  });
});
