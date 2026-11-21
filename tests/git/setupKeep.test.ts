import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import { tracksKeepLock } from '../../src/git/keepTracking';
import { configureSetupTracking } from '../../src/git/setupKeep';
import { git, makeRepo, makeRoot } from '../helpers/keepLockGit';

const root = makeRoot('capy-setup-tracking-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('effective tracking for a folder', () => {
  test('a plain folder can be initialized before Git exists', () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    configureSetupTracking(plain, false);
    expect(tracksKeepLock(plain)).toBe(false);
    expect(readFileSync(join(plain, '.gitignore'), 'utf8').split('\n')).toContain('/keep.lock');
    git(plain, ['init', '-q']);
    expect(tracksKeepLock(plain)).toBe(false);
  });

  test('ignored root pins stay current when the working copy disappears', () => {
    const repo = makeRepo(root, 'pins');
    configureSetupTracking(repo, false);
    const fm = new FileManager(repo);
    const project = new ProjectManager(repo);
    const original = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'app', variables: {} };
    const updated = { ...original, variables: { API_KEY: [{ resource_id: 'r', value_hash: 'current' }] } };
    fm.writeKeepFile(original);
    fm.writeKeepFile(updated);
    expect(readFileSync(project.getKeepPath(), 'utf8')).toBe(readFileSync(project.getWorkingKeepPath(), 'utf8'));
    rmSync(project.getWorkingKeepPath());
    expect(project.readKeepFile()).toMatchObject(updated);
    expect(git(repo, ['ls-files', '--', 'keep.lock']).stdout.trim()).toBe('');
  });

  test('turning tracking off affects only that project in a monorepo; an indexed path wins', () => {
    const repo = makeRepo(root, 'nested');
    const nested = join(repo, 'backend');
    mkdirSync(nested);
    expect(tracksKeepLock(repo, 'backend/keep.lock')).toBe(true);
    configureSetupTracking(nested, false);
    expect(tracksKeepLock(repo, 'backend/keep.lock')).toBe(false);
    expect(tracksKeepLock(repo)).toBe(true);
    writeFileSync(join(nested, 'keep.lock'), '{}\n');
    git(repo, ['add', '--force', 'backend/keep.lock']);
    expect(tracksKeepLock(repo, 'backend/keep.lock')).toBe(true);
    expect(() => configureSetupTracking(nested, false)).toThrow('already has a tracked keep.lock');
  });

  test('explicit sharing can override an inherited ignore for the file', () => {
    const repo = makeRepo(root, 'share');
    writeFileSync(join(repo, '.gitignore'), '*.lock\n');
    expect(tracksKeepLock(repo)).toBe(false);
    configureSetupTracking(repo, true);
    expect(tracksKeepLock(repo)).toBe(true);
  });
});
