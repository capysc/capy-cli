import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  isGitRepo,
  getStatus,
  hasKeepLockChanges,
  hasOtherChanges,
  stageAndCommit,
  currentBranch,
  checkoutNewBranch,
  checkoutBranch,
  stashOtherChanges,
  stashAllChanges,
  popStash,
  checkoutNewBranchFrom,
} from '../../src/deploy/git';
import { writeFileSync as fsWrite } from 'fs';

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

  test('clean tree: hasKeepLockChanges = false, hasOtherChanges = false', () => {
    expect(hasKeepLockChanges(ROOT)).toBe(false);
    expect(hasOtherChanges(ROOT)).toBe(false);
  });

  test('only keep.lock dirty', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    expect(hasKeepLockChanges(ROOT)).toBe(true);
    expect(hasOtherChanges(ROOT)).toBe(false);
  });

  test('only other files dirty', () => {
    writeFileSync(join(ROOT, 'src.ts'), 'export {};');
    expect(hasKeepLockChanges(ROOT)).toBe(false);
    expect(hasOtherChanges(ROOT)).toBe(true);
  });

  test('keep.lock + other files dirty: both flags true', () => {
    writeFileSync(join(ROOT, 'src.ts'), 'export {};');
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    expect(hasKeepLockChanges(ROOT)).toBe(true);
    expect(hasOtherChanges(ROOT)).toBe(true);
  });

  test('stage+commit only keep.lock leaves other dirty files alone', () => {
    writeFileSync(join(ROOT, 'src.ts'), 'export {};');
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    const r = stageAndCommit(ROOT, ['keep.lock'], 'chore(deploy): bump');
    expect(r.ok).toBe(true);
    // keep.lock is committed; src.ts is still untracked.
    const remaining = getStatus(ROOT);
    expect(remaining.map((e) => e.path)).toEqual(['src.ts']);
  });

  test('stash dance: stash → branch → commit keep.lock → return → pop', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{ "v": 1 }');
    writeFileSync(join(ROOT, 'src.ts'), 'export const x = 1;');
    const original = currentBranch(ROOT);

    // 1. Branch
    const co = checkoutNewBranch(ROOT, 'capy-deploy/test');
    expect(co.ok).toBe(true);

    // 2. Stash everything BUT keep.lock
    const stash = stashOtherChanges(ROOT);
    expect(stash.ok).toBe(true);
    expect(stash.stashed).toBe(true);
    // After stash: only keep.lock should remain in the working tree
    expect(getStatus(ROOT).map((e) => e.path)).toEqual(['keep.lock']);

    // 3. Commit keep.lock only
    const commit = stageAndCommit(ROOT, ['keep.lock'], 'chore(deploy): bump');
    expect(commit.ok).toBe(true);
    expect(getStatus(ROOT)).toEqual([]);

    // 4. Return to original branch
    const back = checkoutBranch(ROOT, original!);
    expect(back.ok).toBe(true);
    expect(currentBranch(ROOT)).toBe(original);

    // 5. Restore the stash — src.ts comes back, keep.lock stays old
    const pop = popStash(ROOT);
    expect(pop.ok).toBe(true);
    expect(getStatus(ROOT).map((e) => e.path).sort()).toEqual(['src.ts']);
  });

  test('stashOtherChanges is a no-op when nothing other than keep.lock is dirty', () => {
    writeFileSync(join(ROOT, 'keep.lock'), '{}');
    const r = stashOtherChanges(ROOT);
    expect(r.ok).toBe(true);
    expect(r.stashed).toBe(false);
    // Nothing was stashed — keep.lock is still dirty.
    expect(hasKeepLockChanges(ROOT)).toBe(true);
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

  test('stashAllChanges stashes everything (incl. keep.lock + untracked)', () => {
    fsWrite(join(ROOT, 'keep.lock'), '{}');
    fsWrite(join(ROOT, 'src.ts'), 'export {};');
    expect(getStatus(ROOT).length).toBeGreaterThan(0);
    const r = stashAllChanges(ROOT);
    expect(r.ok).toBe(true);
    expect(r.stashed).toBe(true);
    expect(getStatus(ROOT)).toEqual([]);
    // Restore so afterEach doesn't see leftover stash state in the repo.
    popStash(ROOT);
  });

  test('stashAllChanges no-ops on a clean tree', () => {
    const r = stashAllChanges(ROOT);
    expect(r.ok).toBe(true);
    expect(r.stashed).toBe(false);
  });

  test('checkoutNewBranchFrom branches off the named ref, not current HEAD', () => {
    // Set up: main has commit A; create a feature branch with extra commit B;
    // checkoutNewBranchFrom('deploy', 'main') should land on a branch whose
    // HEAD == main's HEAD, NOT include B.
    git(['checkout', '-b', 'feature'], ROOT);
    fsWrite(join(ROOT, 'feat.txt'), 'B');
    git(['add', 'feat.txt'], ROOT);
    git(['commit', '-q', '-m', 'B'], ROOT);
    const featHead = git(['rev-parse', 'HEAD'], ROOT).stdout.trim();
    const mainHead = git(['rev-parse', 'main'], ROOT).stdout.trim();
    expect(featHead).not.toBe(mainHead);

    // Branch off `main`, not feature's HEAD.
    const co = checkoutNewBranchFrom(ROOT, 'deploy', 'main');
    expect(co.ok).toBe(true);
    expect(currentBranch(ROOT)).toBe('deploy');
    const deployHead = git(['rev-parse', 'HEAD'], ROOT).stdout.trim();
    expect(deployHead).toBe(mainHead);
    // feat.txt should not exist on the deploy branch.
    expect(getStatus(ROOT)).toEqual([]);
  });
});
