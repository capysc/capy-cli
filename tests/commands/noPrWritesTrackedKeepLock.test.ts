/**
 * `--no-pr` on `capy add`, `capy edit` and `capy remove`: only the pull request is skipped. The tracked
 * `keep.lock` in the folder is brought up to date on disk (the bytes the PR would have carried) and left
 * modified and uncommitted. The report says `changed: true` only when those bytes changed.
 *
 * Driven through the BUILT cli (`dist/index.js`) against an isolated HOME, a mock service and a throwaway git
 * checkout (tests/helpers). Needs `bun run build` first. Names only: no secret value is asserted on or printed.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, BRANCH, type CliResult, type Harness } from '../helpers/pipedHarness';
import { gitEnv, git } from '../helpers/keepLockGit';
import { gitInit } from '../helpers/ghWorld';
import { planTrackedKeepLock } from '../../src/commands/keepLockPr';
import { serializeKeep } from '../../src/files/fileManager';
import type { KeepFile } from '../../src/types/index';

const NAME = 'NO_PR_TRACKED_TOKEN';
const OTHER = 'NO_PR_OTHER_TOKEN';

const json = (r: CliResult): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

/** A git checkout of the harness project with the tracked keep.lock committed as it is now. */
function checkout(h: Harness): void {
  gitInit(h.project, 'git@github.com:Acme/solo.git');
  commitKeepLock(h);
}

function commitKeepLock(h: Harness): void {
  const env = gitEnv(h.home);
  git(h.project, ['add', 'keep.lock'], env);
  git(h.project, ['commit', '-q', '-m', 'keep.lock'], env);
}

const gitIn = (h: Harness, args: readonly string[]) => git(h.project, args, gitEnv(h.home));

/** `git status --porcelain` for keep.lock only: ` M` modified-unstaged, `M ` staged, empty clean. */
const keepLockStatus = (h: Harness): string => gitIn(h, ['status', '--porcelain', '--', 'keep.lock']).stdout;

const commitCount = (h: Harness): string => gitIn(h, ['rev-list', '--count', 'HEAD']).stdout.trim();

const trackedKeep = (h: Harness): KeepFile => JSON.parse(h.keepLockText()) as KeepFile;
const namesOnBranch = (keep: KeepFile): readonly string[] =>
  Object.keys(keep.variables).filter((n) => keep.variables[n].some((e) => e.branch === BRANCH)).toSorted();

const workingCopy = (h: Harness): string => readFileSync(join(h.project, '.capy', 'keep.lock'), 'utf8');

/** `add NAME --no-pr` for real, then commit the tracked file so the next command starts from a clean checkout. */
async function addAndCommit(h: Harness, name: string): Promise<void> {
  const r = await h.run(['add', name, '--json', '--no-pr'], 'first-value\n');
  expect(r.code).toBe(0);
  commitKeepLock(h);
}

async function withWorld<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = await createHarness();
  try {
    return await fn(h);
  } finally {
    await h.dispose();
  }
}

describe('capy add NAME --no-pr writes the tracked keep.lock', () => {
  test('the name is in the tracked file, git shows it modified and unstaged, nothing is committed, the report says so', async () => {
    await withWorld(async (h) => {
      checkout(h);
      const commits = commitCount(h);
      const branches = gitIn(h, ['branch', '--list']).stdout;
      expect(namesOnBranch(trackedKeep(h))).toEqual([]);

      const r = await h.run(['add', NAME, '--json', '--no-pr'], 'v\n');

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: true, committed: false });
      expect(json(r).unanswered).toBeUndefined();
      expect(namesOnBranch(trackedKeep(h))).toEqual([NAME]);
      expect(h.keepLockText()).toBe(workingCopy(h));
      expect(keepLockStatus(h)).toBe(' M keep.lock\n');
      expect(gitIn(h, ['diff', '--cached', '--name-only']).stdout).toBe('');
      expect(commitCount(h)).toBe(commits);
      expect(gitIn(h, ['branch', '--list']).stdout).toBe(branches);
    });
  });

  test('the tracked file carries the same bytes as the serialized working copy (no value in it)', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await h.run(['add', NAME, '--json', '--no-pr'], 'v\n');
      expect(h.keepLockText()).toBe(serializeKeep(trackedKeep(h)));
      expect(h.keepLockText()).not.toContain('"v"');
    });
  });
});

describe('capy edit NAME --no-pr writes the tracked keep.lock', () => {
  test('a changed value moves its pin in the tracked file: modified, unstaged, uncommitted', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      const commits = commitCount(h);
      const before = h.keepLockText();

      const r = await h.run(['edit', NAME, '--json', '--no-pr'], 'second-value\n');

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: true, committed: false });
      expect(h.keepLockText()).not.toBe(before);
      expect(h.keepLockText()).toBe(workingCopy(h));
      expect(keepLockStatus(h)).toBe(' M keep.lock\n');
      expect(commitCount(h)).toBe(commits);
    });
  });

  test('the same value again changes nothing: changed false, tracked bytes and git status as they were', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      const before = h.keepLockText();

      const r = await h.run(['edit', NAME, '--json', '--no-pr'], 'first-value\n');

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: false });
      expect(h.keepLockText()).toBe(before);
      expect(keepLockStatus(h)).toBe('');
    });
  });
});

describe('capy remove NAME --no-pr writes the tracked keep.lock', () => {
  test('the removed name is gone from the tracked file, the other stays, git shows it modified and unstaged', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      await addAndCommit(h, OTHER);
      const commits = commitCount(h);
      expect(namesOnBranch(trackedKeep(h))).toEqual([OTHER, NAME].toSorted());

      const r = await h.run(['remove', NAME, '--yes', '--json', '--no-pr'], undefined);

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: true, committed: false });
      expect(json(r).unanswered).toBeUndefined();
      expect(namesOnBranch(trackedKeep(h))).toEqual([OTHER]);
      expect(h.keepLockText()).toBe(workingCopy(h));
      expect(keepLockStatus(h)).toBe(' M keep.lock\n');
      expect(gitIn(h, ['diff', '--cached', '--name-only']).stdout).toBe('');
      expect(commitCount(h)).toBe(commits);
    });
  });

  test('a run that changes nothing in the tracked file reports changed false and leaves it byte-identical', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      // Capy gets OTHER (the add writes the tracked file too), then the tracked file is restored to the committed
      // state: Capy has OTHER, the tracked file does not, so removing OTHER leaves the tracked bytes as they are.
      const r1 = await h.run(['add', OTHER, '--json', '--no-pr'], 'v\n');
      expect(r1.code).toBe(0);
      gitIn(h, ['checkout', '--', 'keep.lock']);
      const before = h.keepLockText();
      expect(namesOnBranch(trackedKeep(h))).toEqual([NAME]);
      const mtime = statSync(join(h.project, 'keep.lock')).mtimeMs;

      const r = await h.run(['remove', OTHER, '--yes', '--json', '--no-pr'], undefined);

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: false });
      expect(h.keepLockText()).toBe(before);
      expect(statSync(join(h.project, 'keep.lock')).mtimeMs).toBe(mtime);
      expect(keepLockStatus(h)).toBe('');
    });
  });

  test('--dry-run writes nothing and says what a real run would do: changed true when the tracked bytes would change', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      const before = h.keepLockText();
      const pushes = h.pushCount();

      const r = await h.run(['remove', NAME, '--json', '--dry-run', '--no-pr'], undefined);

      expect(r.code).toBe(0);
      expect(json(r)).toEqual({
        removed: [NAME],
        branch: BRANCH,
        dry_run: true,
        keep_lock: { changed: true, committed: false, would_pr: null },
      });
      expect(h.keepLockText()).toBe(before);
      expect(keepLockStatus(h)).toBe('');
      expect(h.pushCount()).toBe(pushes);
    });
  });

  test('--dry-run says changed false when the tracked file would not change', async () => {
    await withWorld(async (h) => {
      checkout(h);
      await addAndCommit(h, NAME);
      const r1 = await h.run(['add', OTHER, '--json', '--no-pr'], 'v\n');
      expect(r1.code).toBe(0);
      gitIn(h, ['checkout', '--', 'keep.lock']);
      const before = h.keepLockText();

      const r = await h.run(['remove', OTHER, '--json', '--dry-run', '--no-pr'], undefined);

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: false, committed: false, would_pr: null });
      expect(h.keepLockText()).toBe(before);
    });
  });
});

describe('what --no-pr keeps doing where there is no tracked file to bring up to date', () => {
  test('a folder that is not a git checkout: the tracked file is not written and the report is as before', async () => {
    await withWorld(async (h) => {
      const before = h.keepLockText();

      const r = await h.run(['add', NAME, '--json', '--no-pr'], 'v\n');

      expect(r.code).toBe(0);
      expect(json(r).keep_lock).toEqual({ changed: true, committed: false });
      expect(h.keepLockText()).toBe(before);
      expect(existsSync(join(h.project, '.capy', 'keep.lock'))).toBe(true);
    });
  });
});

describe('planTrackedKeepLock', () => {
  const keep = (projectId: string): KeepFile => ({ version: '3.0', org_id: 'o', project_id: projectId, project_name: 'demo', variables: {} });
  const records = [{ branch: 'dev', entries: [{ variable: 'A', entry: { resource_id: 'r1', branch: 'dev', value_hash: 'h' } }] }];
  const inGit = { isGitRepo: () => true };

  test('no tracked keep.lock: skip (nothing to write)', () => {
    const dir = join(import.meta.dir, 'does-not-exist-dir');
    expect(planTrackedKeepLock({ cwd: dir, records, localKeep: keep('p') }, inGit)).toEqual({ kind: 'skip' });
  });

  test('not a git checkout: skip', async () => {
    await withWorld(async (h) => {
      expect(planTrackedKeepLock({ cwd: h.project, records, localKeep: keep('proj_test_piped') }, { isGitRepo: () => false })).toEqual({ kind: 'skip' });
    });
  });

  test('another project\'s keep.lock: skip', async () => {
    await withWorld(async (h) => {
      expect(planTrackedKeepLock({ cwd: h.project, records, localKeep: keep('some_other_project') }, inGit)).toEqual({ kind: 'skip' });
    });
  });

  test('records the file does not carry yet: write, with the folded bytes', async () => {
    await withWorld(async (h) => {
      const plan = planTrackedKeepLock({ cwd: h.project, records, localKeep: keep('proj_test_piped') }, inGit);
      expect(plan.kind).toBe('write');
      expect(plan.kind === 'write' ? Object.keys((JSON.parse(plan.content) as KeepFile).variables) : []).toEqual(['A']);
    });
  });

  test('records the file already carries: unchanged', async () => {
    await withWorld(async (h) => {
      const nothing = [{ branch: 'dev', entries: [{ variable: 'NOT_THERE', entry: null }] }];
      expect(planTrackedKeepLock({ cwd: h.project, records: nothing, localKeep: keep('proj_test_piped') }, inGit)).toEqual({ kind: 'unchanged' });
    });
  });
});
