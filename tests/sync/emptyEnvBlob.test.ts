/**
 * A branch with no variables must still save.
 *
 * The service answers 400 to an empty `keep_file` or `env_blob` (`!env_blob`). A branch can have no variable and still
 * need a save: an import whose names are all placeholders (keep.lock holds them, the blob holds no line), or a
 * `--overwrite` that clears the last name. The blob used to be '' then, and the save was refused.
 *
 * On the in-memory server of tests/helpers/fakeCapyServer.ts, which refuses an empty payload the way the service does:
 *   - an empty branch and a placeholder-only branch push a non-empty `env_blob` and a non-empty, valid `keep_file`;
 *   - the pushed state reads back as no variables, without an error, by every reader the CLI has;
 *   - encrypting an empty value gives a non-empty ciphertext that decrypts to empty (it is not what the blob holds, and why).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import { rmSync } from 'fs';
import { Encryptor } from '../../src/crypto/encryptor';
import { getGlobalCapyDir } from '../../src/config/globalConfig';
import { writeImportedAndSync, type ResolvedContext } from '../../src/commands/connectors/shared';
import { placeholdersOnBranch } from '../../src/core/placeholder';
import { FileManager } from '../../src/files/fileManager';
import { EMPTY_ENV_BLOB, commitFolder, envBlobOf, readSnapshot } from '../../src/sync/commit';
import type { KeepFile } from '../../src/types/index';
import { fakeCapyServer, seedServer, serverValues } from '../helpers/fakeCapyServer';
import { makeFolder, removeFolder, type Folder } from '../helpers/folderWorld';

const KEY = Encryptor.generateKey();
const PREVIEW = 'preview';
const MARKER = { provider: 'vercel', reason: 'sensitive_unreadable' } as const;
/** `preview` holds two values; `production` holds one. */
const SEED = seedServer({ projectKey: KEY, values: { production: { X: 'x-prod' }, [PREVIEW]: { X: 'x-1', Y: 'y-1' } } });
/** Only `production` exists on the server: `preview` is a branch with nothing saved yet. */
const SEED_PRODUCTION_ONLY = seedServer({ projectKey: KEY, values: { production: { X: 'x-prod' } } });

const globalDirName = `.capy-test-empty-blob-${process.pid}`;
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

/** A folder on `preview` holding `env`, and a server that already holds `seed`. */
function world(env: Record<string, string>, seed = SEED) {
  const server = fakeCapyServer({ initial: seed });
  const folder = makeFolder({ projectKey: KEY, branch: PREVIEW, keep: seed.keep as KeepFile, env, client: server.client });
  made(folder);
  return { server, folder };
}

const asContext = (folder: Folder, server: ReturnType<typeof fakeCapyServer>): ResolvedContext =>
  ({ ...folder.ctx, serviceClient: server.client, keep: folder.keep(), localPlaintext: folder.env() }) as unknown as ResolvedContext;

describe('the blob of a branch with no variables', () => {
  test('is a non-empty comment line, and an empty set of lines is the only thing that makes it', () => {
    expect(EMPTY_ENV_BLOB.length).toBeGreaterThan(0);
    expect(envBlobOf({})).toBe(EMPTY_ENV_BLOB);
    expect(envBlobOf({ A: 'capy:r1:abc', B: 'capy:r2:def' })).toBe('A=capy:r1:abc\nB=capy:r2:def');
  });

  test('reads back as no variables by every reader: dotenv parse, the folder\'s own parse, and a line parser that skips what is not NAME=value', () => {
    expect(new FileManager().parseEnvContent(EMPTY_ENV_BLOB)).toEqual({});
    const lineParsed = EMPTY_ENV_BLOB.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && l.includes('='));
    expect(lineParsed).toEqual([]);
  });

  test('encrypting an empty value gives a non-empty ciphertext that decrypts to empty (the blob still cannot be one: it has no NAME to hang that line on)', () => {
    const cipher = Encryptor.encrypt('', KEY);
    expect(cipher.length).toBeGreaterThan(0);
    expect(Encryptor.decrypt(cipher, KEY)).toBe('');
  });
});

describe('an empty branch saves (clearing the last name)', () => {
  test('pushes a non-empty env_blob and a valid keep_file; the server accepts it and the branch reads back empty', async () => {
    const w = world({ X: 'x-1', Y: 'y-1' });
    await commitFolder(w.folder.ctx, { set: {}, remove: ['X', 'Y'] });

    const pushed = w.server.accepted();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].envBlob).toBe(EMPTY_ENV_BLOB);
    expect(pushed[0].keepFile.length).toBeGreaterThan(0);
    const keep = JSON.parse(pushed[0].keepFile) as KeepFile;
    expect(keep.project_id).toBe('proj');
    expect(Object.values(keep.variables).flat().filter((e) => e.branch === PREVIEW)).toEqual([]);
    expect(Object.values(keep.variables).flat().filter((e) => e.branch === 'production')).toHaveLength(1); // the other branch is untouched

    expect(serverValues(w.server.state(), PREVIEW, KEY)).toEqual({});
    expect(w.folder.env()).toEqual({});
  });

  test('round-trips: the next read of the branch decrypts to an empty env with no error, and a later write on it works', async () => {
    const w = world({ X: 'x-1', Y: 'y-1' });
    await commitFolder(w.folder.ctx, { set: {}, remove: ['X', 'Y'] });

    const snapshot = await readSnapshot(w.server.client, 'proj', PREVIEW, KEY);
    expect(snapshot.entries).toEqual({});
    expect(new FileManager(w.folder.dir).readEncryptedEnvFile(KEY)).toEqual({});

    await commitFolder({ ...w.folder.ctx, keep: w.folder.keep(), localPlaintext: w.folder.env() }, { set: { Z: 'z-1' }, remove: [] });
    expect(serverValues(w.server.state(), PREVIEW, KEY)).toEqual({ Z: 'z-1' });
  });
});

describe('a placeholder-only branch saves', () => {
  test('pushes a non-empty env_blob and a keep_file carrying the placeholder; the server accepts it', async () => {
    const w = world({}, SEED_PRODUCTION_ONLY);
    await writeImportedAndSync(asContext(w.folder, w.server), [], { push: true, placeholders: [{ name: 'HIDDEN', marker: MARKER }] });

    const pushed = w.server.accepted();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].envBlob).toBe(EMPTY_ENV_BLOB);
    const keep = JSON.parse(pushed[0].keepFile) as KeepFile;
    expect(placeholdersOnBranch(keep, PREVIEW).map((p) => [p.name, p.marker])).toEqual([['HIDDEN', MARKER]]);

    expect(serverValues(w.server.state(), PREVIEW, KEY)).toEqual({});
    expect(placeholdersOnBranch(w.server.state().keep, PREVIEW).map((p) => p.name)).toEqual(['HIDDEN']);
  });

  test('round-trips: the folder and a fresh read both say no variables and one placeholder, with no error', async () => {
    const w = world({}, SEED_PRODUCTION_ONLY);
    await writeImportedAndSync(asContext(w.folder, w.server), [], { push: true, placeholders: [{ name: 'HIDDEN', marker: MARKER }] });

    const snapshot = await readSnapshot(w.server.client, 'proj', PREVIEW, KEY);
    expect(snapshot.entries).toEqual({});
    expect(placeholdersOnBranch(snapshot.keep, PREVIEW).map((p) => p.name)).toEqual(['HIDDEN']);
    expect(w.folder.env()).toEqual({});
    expect(placeholdersOnBranch(w.folder.keep(), PREVIEW).map((p) => p.name)).toEqual(['HIDDEN']);
  });

  test('an empty set of values with an unrelated placeholder still keeps the branch\'s other values out of the blob (no stand-in line)', async () => {
    const w = world({}, SEED_PRODUCTION_ONLY);
    await writeImportedAndSync(asContext(w.folder, w.server), [], { push: true, placeholders: [{ name: 'HIDDEN', marker: MARKER }] });
    const blob = w.server.accepted()[0].envBlob;
    expect(blob).not.toContain('HIDDEN');
    expect(blob.split('\n').filter((l) => l.includes('='))).toEqual([]);
  });
});
