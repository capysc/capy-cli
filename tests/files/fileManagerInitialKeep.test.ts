/**
 * `FileManager.writeInitialKeepFile` — the first-setup write. Unlike
 * `writeKeepFile` (tracked file only when absent), it puts the SAME content in
 * both the tracked `keep.lock` and the `.capy/keep.lock` working copy, always.
 *
 * Real files in a temp directory: the property under test is what is on disk.
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileManager, serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

const identity: KeepFile = {
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'demo',
  variables: {},
};

const pinned: KeepFile = {
  ...identity,
  variables: {
    API_KEY: [{ resource_id: 'res-api', branch: 'development', value_hash: 'aaaaaaaaaaaaaaaa' }],
    DB_URL: [{ resource_id: 'res-db', branch: 'development', value_hash: 'bbbbbbbbbbbbbbbb' }],
  },
};

// Each temp dir is recorded through a mock so cleanup needs no mutable list.
const dirs = mock((_: string) => undefined);

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-initial-keep-'));
  dirs(dir);
  return dir;
}

afterEach(() => {
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

describe('FileManager.writeInitialKeepFile', () => {
  const trackedOf = (root: string): string => join(root, 'keep.lock');
  const workingOf = (root: string): string => join(root, '.capy', 'keep.lock');
  const read = (path: string): string => readFileSync(path, 'utf-8');

  test('writes the tracked file and the working copy with identical content', () => {
    const root = freshRoot();
    new FileManager(root).writeInitialKeepFile(pinned);

    expect(existsSync(trackedOf(root))).toBe(true);
    expect(existsSync(workingOf(root))).toBe(true);
    expect(read(trackedOf(root))).toBe(read(workingOf(root)));
    expect(read(trackedOf(root))).toBe(serializeKeep(pinned));
    expect(Object.keys(JSON.parse(read(trackedOf(root))).variables).sort()).toEqual(['API_KEY', 'DB_URL']);
  });

  test('overwrites a tracked file that already exists with different content', () => {
    const root = freshRoot();
    const fileManager = new FileManager(root);
    fileManager.writeKeepFile(identity);
    expect(JSON.parse(read(trackedOf(root))).variables).toEqual({});

    fileManager.writeInitialKeepFile(pinned);

    expect(read(trackedOf(root))).toBe(serializeKeep(pinned));
    expect(read(workingOf(root))).toBe(serializeKeep(pinned));
  });

  test('overwrites a tracked file written by hand, not by capy', () => {
    const root = freshRoot();
    writeFileSync(trackedOf(root), '{"stale": true}\n', 'utf-8');

    new FileManager(root).writeInitialKeepFile(pinned);

    expect(read(trackedOf(root))).toBe(serializeKeep(pinned));
    expect(read(workingOf(root))).toBe(serializeKeep(pinned));
  });

  test('writeKeepFile still leaves an existing tracked file alone (the rule this method is the one exception to)', () => {
    const root = freshRoot();
    const fileManager = new FileManager(root);
    fileManager.writeKeepFile(identity);

    fileManager.writeKeepFile(pinned);

    expect(read(trackedOf(root))).toBe(serializeKeep(identity));
    expect(read(workingOf(root))).toBe(serializeKeep(pinned));
  });
});

describe('FileManager.writeInitialKeepFile after writeKeepFile, the first-setup order', () => {
  test('the tracked file ends up with the pins, not the empty first write', () => {
    const root = freshRoot();
    const fileManager = new FileManager(root);
    fileManager.writeKeepFile(identity);
    fileManager.writeInitialKeepFile(pinned);

    expect(JSON.parse(readFileSync(join(root, 'keep.lock'), 'utf-8')).variables).toMatchObject({
      API_KEY: [{ resource_id: 'res-api', branch: 'development' }],
      DB_URL: [{ resource_id: 'res-db', branch: 'development' }],
    });
  });
});
