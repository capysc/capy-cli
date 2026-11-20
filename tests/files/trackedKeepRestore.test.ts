import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { KeepFile } from '../../src/types/index';

// Regression: deleting the tracked keep.lock while .capy/keep.lock exists left
// `capy` unable to bring it back. readKeepFile() still returns the working
// copy, so the server bootstrap was skipped and nothing rewrote the tracked
// file. CapyCommand.syncProject now restores it via writeKeepFile; these tests
// pin the on-disk contract that restore relies on.

const TEST_DIR = join(tmpdir(), `capy-tracked-keep-restore-${process.pid}`);

const keep: KeepFile = {
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'demo',
  variables: {
    API_KEY: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1' }],
  },
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('deleted tracked keep.lock with a working copy', () => {
  test('readKeepFile still returns the working copy (why the server bootstrap is skipped)', () => {
    new FileManager(TEST_DIR).writeKeepFile(keep);
    const pm = new ProjectManager(TEST_DIR);
    unlinkSync(pm.getKeepPath());

    expect(existsSync(pm.getKeepPath())).toBe(false);
    expect(pm.readKeepFile()).toMatchObject({ project_id: 'proj-1', variables: keep.variables });
  });

  test('writeKeepFile with the working copy restores the tracked file byte-for-byte', () => {
    const fm = new FileManager(TEST_DIR);
    fm.writeKeepFile(keep);
    const pm = new ProjectManager(TEST_DIR);
    const original = readFileSync(pm.getKeepPath(), 'utf-8');
    unlinkSync(pm.getKeepPath());

    fm.writeKeepFile(pm.readKeepFile()!);

    expect(readFileSync(pm.getKeepPath(), 'utf-8')).toBe(original);
  });

  test('writeKeepFile never rewrites an existing tracked file (CAP-303)', () => {
    const fm = new FileManager(TEST_DIR);
    fm.writeKeepFile(keep);
    const pm = new ProjectManager(TEST_DIR);
    writeFileSync(pm.getKeepPath(), '{"hand":"edited"}\n');

    fm.writeKeepFile(pm.readKeepFile()!);

    expect(readFileSync(pm.getKeepPath(), 'utf-8')).toBe('{"hand":"edited"}\n');
  });
});
