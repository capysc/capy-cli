import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoCommitKeep } from '../../src/git/autoCommitKeep';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

function initRepo(dir: string): void {
  // Pin the initial branch name explicitly rather than relying on the
  // ambient init.defaultBranch config, so these tests behave the same
  // regardless of the machine's git config.
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

// None of these temp repos has an `origin` remote, so autoCommitKeep falls
// back to treating a local `main` (or `master`) as the default branch. Tests
// that want to exercise ordinary feature-branch commit behavior must move
// off of it explicitly — otherwise they'd silently start asserting the new
// default-branch protection instead of what they say they test.
function checkoutFeatureBranch(dir: string, name = 'feature'): void {
  git(dir, ['checkout', '-q', '-b', name]);
}

/** Runs `fn` with console.error captured, returning its value alongside the captured lines. */
function withCapturedStderr<T>(fn: () => T): { value: T; errLines: string[] } {
  const errLines: string[] = [];
  const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errLines.push(args.map(String).join(' '));
  });
  try {
    return { value: fn(), errLines };
  } finally {
    errSpy.mockRestore();
  }
}

describe('autoCommitKeep', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capy-autocommit-'));
    // The test harness exports CAPY_NO_AUTOCOMMIT=1 to protect the repo the
    // suite runs in; these tests exercise the real behavior in a temp dir.
    savedEnv = process.env.CAPY_NO_AUTOCOMMIT;
    delete process.env.CAPY_NO_AUTOCOMMIT;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.CAPY_NO_AUTOCOMMIT = savedEnv;
    else delete process.env.CAPY_NO_AUTOCOMMIT;
    rmSync(dir, { recursive: true, force: true });
  });

  test('commits a changed keep.lock with the pin message', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const result = autoCommitKeep('development', dir);

    expect(result.committed).toBe(true);
    expect(git(dir, ['log', '-1', '--format=%s']).trim()).toBe('chore(capy): pin development secrets');
    expect(git(dir, ['status', '--porcelain', '--', 'keep.lock']).trim()).toBe('');
  });

  test('commits a brand-new (untracked) keep.lock', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'README.md'), 'hi\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');

    // 'main' here is the Capy *keep* branch baked into the commit message,
    // unrelated to the git branch checked out (that's 'feature', above).
    const result = autoCommitKeep('main', dir);

    expect(result.committed).toBe(true);
    expect(git(dir, ['log', '-1', '--format=%s']).trim()).toBe('chore(capy): pin main secrets');
  });

  test('the commit contains ONLY keep.lock, never other staged work', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);

    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');
    writeFileSync(join(dir, 'feature.ts'), 'export {}\n');
    git(dir, ['add', 'feature.ts']); // half-staged feature in progress

    const result = autoCommitKeep('development', dir);

    expect(result.committed).toBe(true);
    const committedFiles = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    expect(committedFiles).toEqual(['keep.lock']);
    // The feature file is still staged, untouched.
    expect(git(dir, ['status', '--porcelain', '--', 'feature.ts']).trim()).toBe('A  feature.ts');
  });

  test('no-op when keep.lock is unchanged', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);

    const result = autoCommitKeep('development', dir);

    expect(result).toEqual({ committed: false, reason: 'unchanged' });
    expect(git(dir, ['log', '--format=%s']).trim()).toBe('init');
  });

  test('warns but does not throw outside a git repo', () => {
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    const result = autoCommitKeep('development', dir);
    expect(result).toEqual({ committed: false, reason: 'not_a_repo' });
  });

  test('skips when a merge is in progress', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');
    // Simulate an in-progress merge
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), git(dir, ['rev-parse', 'HEAD']));

    const result = autoCommitKeep('development', dir);

    expect(result).toEqual({ committed: false, reason: 'in_progress_operation' });
    expect(git(dir, ['log', '--format=%s']).trim()).toBe('init');
  });

  test('CAPY_NO_AUTOCOMMIT=1 disables it silently', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    process.env.CAPY_NO_AUTOCOMMIT = '1';

    const result = autoCommitKeep('development', dir);

    expect(result).toEqual({ committed: false, reason: 'disabled' });
  });

  test('quiet: true sends the committed line to stderr, never stdout', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const outLines: string[] = [];
    const errLines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outLines.push(args.map(String).join(' '));
    });
    const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    });
    try {
      const result = autoCommitKeep('development', dir, { quiet: true });
      expect(result.committed).toBe(true);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(outLines).toEqual([]);
    expect(errLines.some((l) => l.includes('keep.lock committed'))).toBe(true);
  });

  test('quiet omitted (default): the committed line still goes to stdout, unchanged', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const outLines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outLines.push(args.map(String).join(' '));
    });
    try {
      const result = autoCommitKeep('development', dir);
      expect(result.committed).toBe(true);
    } finally {
      logSpy.mockRestore();
    }

    expect(outLines.some((l) => l.includes('keep.lock committed'))).toBe(true);
  });

  test('on the default branch: no commit, keep.lock stays changed, a hint is printed', () => {
    initRepo(dir); // `git init` here checks out the local default branch (main), no origin remote
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const { value: result, errLines } = withCapturedStderr(() => autoCommitKeep('development', dir));

    expect(result).toEqual({ committed: false, reason: 'default_branch' });
    // keep.lock is left changed in the working tree, not committed.
    expect(git(dir, ['status', '--porcelain', '--', 'keep.lock']).trim()).toBe('M keep.lock');
    expect(git(dir, ['log', '--format=%s']).trim()).toBe('init');
    expect(errLines.length).toBeGreaterThan(0);
  });

  test('origin/HEAD unset, local main present: a checkout OTHER than main still commits', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    // No origin remote exists anywhere in this repo, so default-branch
    // resolution falls back to the local `main` branch. Moving off of it
    // (to a branch that is not main/master) must behave like any other
    // feature branch: commit as usual.
    checkoutFeatureBranch(dir, 'not-main');
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const result = autoCommitKeep('development', dir);

    expect(result.committed).toBe(true);
    expect(git(dir, ['log', '-1', '--format=%s']).trim()).toBe('chore(capy): pin development secrets');
  });

  test('origin/HEAD unset, local main present: checking out main again is blocked again', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir, 'not-main');
    git(dir, ['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'keep.lock'), '{"v":2}\n');

    const { value: result } = withCapturedStderr(() => autoCommitKeep('development', dir));

    expect(result).toEqual({ committed: false, reason: 'default_branch' });
  });

  test('never creates a no-op commit on a feature branch either', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    checkoutFeatureBranch(dir);

    const result = autoCommitKeep('development', dir);

    expect(result).toEqual({ committed: false, reason: 'unchanged' });
    expect(git(dir, ['log', '--format=%s']).trim()).toBe('init');
  });
});
