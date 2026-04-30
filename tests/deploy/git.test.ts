import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  isGitRepo,
  getStatus,
  guardWorkingTree,
  stageAndCommit,
  currentBranch,
  checkoutNewBranch,
} from '../../src/deploy/git';

const ROOT = join(tmpdir(), `capy-git-test-${process.pid}`);

function git(args: string[], cwd: string): { code: number; stdout: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

beforeEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  // initialize a clean repo with one initial commit so HEAD exists
  git(['init', '-q', '-b', 'main'], ROOT);
  git(['config', 'user.email', 'test@example.com'], ROOT);
  git(['config', 'user.name', 'Test'], ROOT);
  git(['config', 'commit.gpgsign', 'false'], ROOT);
  writeFileSync(join(ROOT, 'README.md'), '# test\n');
  git(['add', '.'], ROOT);
  git(['commit', '-q', '-m', 'init'], ROOT);
});

afterEach(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

describe('git helpers', () => {
  test('isGitRepo true inside repo, false outside', () => {
    expect(isGitRepo(ROOT)).toBe(true);
    const non = join(tmpdir(), `not-a-repo-${process.pid}`);
    mkdirSync(non, { recursive: true });
    expect(isGitRepo(non)).toBe(false);
    rmSync(non, { recursive: true, force: true });
  });

  test('clean working tree → guard passes with no changes', () => {
    const r = guardWorkingTree(ROOT);
    expect(r.ok).toBe(true);
    expect(r.blockingChanges).toEqual([]);
    expect(r.autoCommitChanges).toEqual([]);
  });

  test('only keep.lock dirty → guard passes; flagged for auto-commit', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    const r = guardWorkingTree(ROOT);
    expect(r.ok).toBe(true);
    expect(r.autoCommitChanges.map((e) => e.path)).toEqual(['keep.lock']);
    expect(r.blockingChanges).toEqual([]);
  });

  test('other files dirty → guard blocks them', () => {
    writeFileSync(join(ROOT, 'src.ts'), 'export {};');
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    const r = guardWorkingTree(ROOT);
    expect(r.ok).toBe(false);
    expect(r.blockingChanges.map((e) => e.path).sort()).toEqual(['src.ts']);
    expect(r.autoCommitChanges.map((e) => e.path)).toEqual(['keep.lock']);
  });

  test('stageAndCommit succeeds for tracked files', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    const r = stageAndCommit(ROOT, ['keep.lock'], 'chore(test): commit keep.lock');
    expect(r.ok).toBe(true);
    expect(getStatus(ROOT)).toEqual([]);
  });

  test('checkoutNewBranch switches branch', () => {
    const r = checkoutNewBranch(ROOT, 'capy-deploy/test-1');
    expect(r.ok).toBe(true);
    expect(currentBranch(ROOT)).toBe('capy-deploy/test-1');
  });

  test('checkoutNewBranch fails on duplicate', () => {
    checkoutNewBranch(ROOT, 'dup');
    git(['checkout', 'main'], ROOT);
    const r = checkoutNewBranch(ROOT, 'dup');
    expect(r.ok).toBe(false);
  });
});
