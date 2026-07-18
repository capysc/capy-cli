import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoCommitKeep } from '../../src/git/autoCommitKeep';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
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
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');

    const result = autoCommitKeep('main', dir);

    expect(result.committed).toBe(true);
    expect(git(dir, ['log', '-1', '--format=%s']).trim()).toBe('chore(capy): pin main secrets');
  });

  test('the commit contains ONLY keep.lock, never other staged work', () => {
    initRepo(dir);
    writeFileSync(join(dir, 'keep.lock'), '{"v":1}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);

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
});
