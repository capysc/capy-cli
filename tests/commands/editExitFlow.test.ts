/**
 * Integration test for the `capy edit` session → PR exit flow
 * (src/commands/editExitFlow.ts), with REAL git in a temp dir — mirroring
 * the style of tests/deploy/deployFlow.test.ts for `capy deploy` CI mode,
 * whose worktree machinery this flow reuses.
 *
 * Covers the CAP-667 regression directly: the OLD behavior (auto-commit
 * keep.lock on whatever branch the user was on) left the tracked keep.lock
 * dirty in the user's own clone, and `git pull` there refused with "local
 * changes would be overwritten". The NEW flow never touches the user's
 * clone at all — it builds the commit(s) in an isolated worktree off
 * origin/<target> — so `git pull` in the clone keeps working.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { runEditExitFlow } from '../../src/commands/editExitFlow';
import { EditSaveRecord } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import { KeepFile } from '../../src/types/index';

// A fake `createPr` — the real one shells out to `gh`, which would either
// need real GitHub auth or fail unpredictably against a local bare-repo
// "origin" with no GitHub host. Injected via runEditExitFlow's `deps` seam
// so this test can verify the git side (branch/commits/push) for real while
// keeping PR creation itself deterministic and network-free.
const fakeCreatePr = (_cwd: string, _title: string, _body: string, base: string) => ({
  ok: true,
  url: `https://github.com/example/repo/pull/42`,
});

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function keepWith(vars: Record<string, { branch: string; hash: string }[]>): KeepFile {
  const variables: KeepFile['variables'] = {};
  for (const [name, entries] of Object.entries(vars)) {
    variables[name] = entries.map((e) => ({ resource_id: `r-${name}-${e.branch}`, branch: e.branch, value_hash: e.hash }));
  }
  return { version: '3', org_id: 'org-1', project_id: 'proj-1', project_name: 'test-project', variables };
}

describe('editExitFlow.runEditExitFlow (e2e — real git, no gh network calls)', () => {
  const TMP = join(tmpdir(), `capy-editexitflow-${process.pid}`);
  const ORIGIN = join(TMP, 'origin.git');
  const REPO = join(TMP, 'repo');

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    git(['init', '--bare', '-b', 'main', ORIGIN], TMP);
    git(['init', '-q', '-b', 'main', REPO], TMP);
    git(['config', 'user.email', 't@e.com'], REPO);
    git(['config', 'user.name', 'T'], REPO);
    git(['config', 'commit.gpgsign', 'false'], REPO);
    git(['remote', 'add', 'origin', ORIGIN], REPO);

    // main (the edit-session PR's target) carries a committed keep.lock with
    // no entry yet for the variables this session touches.
    const committedKeep = keepWith({});
    writeFileSync(join(REPO, 'keep.lock'), serializeKeep(committedKeep));
    git(['add', '.'], REPO);
    git(['commit', '-q', '-m', 'base'], REPO);
    git(['push', '-q', 'origin', 'main'], REPO);
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('two session saves → two commits on an isolated capy-edit-* branch off origin/main; clone untouched; git pull still works', async () => {
    const records: EditSaveRecord[] = [
      {
        branch: 'production',
        entries: [{ variable: 'API_KEY', entry: { resource_id: 'r-API_KEY-production', branch: 'production', value_hash: 'hash-1' } }],
      },
      {
        branch: 'production',
        entries: [{ variable: 'DB_URL', entry: { resource_id: 'r-DB_URL-production', branch: 'production', value_hash: 'hash-2' } }],
      },
    ];
    const localKeep = keepWith({});

    // Snapshot the clone's state before running the flow.
    const beforeBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO).stdout.trim();
    const beforeKeepContent = readFileSync(join(REPO, 'keep.lock'), 'utf-8');
    const beforeHead = git(['rev-parse', 'HEAD'], REPO).stdout.trim();

    const outcome = await runEditExitFlow(REPO, 'main', records, localKeep, { createPr: fakeCreatePr });

    expect(outcome.error).toBeUndefined();
    expect(outcome.opened).toBe(true);
    expect(outcome.commits).toBe(2);
    expect(outcome.prUrl).toBe('https://github.com/example/repo/pull/42');
    expect(outcome.branch).toMatch(/^capy-edit-/);
    expect(outcome.base).toBe('main');

    // The PR branch exists on origin, based on main, with exactly 2 commits
    // each touching only keep.lock.
    const branchName = outcome.branch!;
    expect(git(['rev-parse', '--verify', branchName], ORIGIN).code).toBe(0);

    const mergeBase = git(['merge-base', branchName, 'main'], ORIGIN).stdout.trim();
    const mainTip = git(['rev-parse', 'main'], ORIGIN).stdout.trim();
    expect(mergeBase).toBe(mainTip); // branched off main, not diverged from it

    const commitCount = git(['rev-list', '--count', `main..${branchName}`], ORIGIN).stdout.trim();
    expect(commitCount).toBe('2');

    const changedFiles = git(['diff', '--name-only', 'main', branchName], ORIGIN).stdout.trim().split('\n').filter(Boolean);
    expect(changedFiles).toEqual(['keep.lock']);

    // Content is both saves folded together onto main's (empty) keep.lock.
    const finalKeep = JSON.parse(git(['show', `${branchName}:keep.lock`], ORIGIN).stdout) as KeepFile;
    expect(finalKeep.variables.API_KEY[0].value_hash).toBe('hash-1');
    expect(finalKeep.variables.DB_URL[0].value_hash).toBe('hash-2');

    // Each individual commit message matches the existing format, and only
    // touches keep.lock.
    const log = git(['log', '--format=%s', `main..${branchName}`], ORIGIN).stdout.trim().split('\n');
    expect(log.every((msg) => msg === 'chore(capy): pin production secrets')).toBe(true);
    for (const rev of git(['rev-list', `main..${branchName}`], ORIGIN).stdout.trim().split('\n')) {
      const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', rev], ORIGIN).stdout.trim().split('\n');
      expect(files).toEqual(['keep.lock']);
    }

    // The clone's own HEAD, branch, working tree and tracked keep.lock are
    // completely unchanged — the whole point of building the PR in an
    // isolated worktree instead of on the user's own checkout.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO).stdout.trim()).toBe(beforeBranch);
    expect(git(['rev-parse', 'HEAD'], REPO).stdout.trim()).toBe(beforeHead);
    expect(readFileSync(join(REPO, 'keep.lock'), 'utf-8')).toBe(beforeKeepContent);
    expect(git(['status', '--porcelain'], REPO).stdout.trim()).toBe('');

    // No leftover worktree or local branch ref in the clone.
    expect(git(['worktree', 'list'], REPO).stdout.trim().split('\n')).toHaveLength(1); // just REPO itself
    expect(git(['branch', '--list', 'capy-edit-*'], REPO).stdout.trim()).toBe('');

    // THE REGRESSION THIS FIXES: the clone's tracked keep.lock was never
    // dirtied, so a plain `git pull` still succeeds (it used to refuse with
    // "local changes to keep.lock would be overwritten").
    const pull = git(['pull', '--ff-only', 'origin', 'main'], REPO);
    expect(pull.code).toBe(0);
  });

  test('a save that produces no diff vs the target is skipped — no commit, no PR', async () => {
    // main already carries this exact pin.
    const already = keepWith({ API_KEY: [{ branch: 'production', hash: 'same-hash' }] });
    writeFileSync(join(REPO, 'keep.lock'), serializeKeep(already));
    git(['add', '.'], REPO);
    git(['commit', '-q', '-m', 'seed existing pin'], REPO);
    git(['push', '-q', 'origin', 'main'], REPO);

    const records: EditSaveRecord[] = [
      {
        branch: 'production',
        entries: [{ variable: 'API_KEY', entry: { resource_id: 'r-API_KEY-production', branch: 'production', value_hash: 'same-hash' } }],
      },
    ];

    const outcome = await runEditExitFlow(REPO, 'main', records, already, { createPr: fakeCreatePr });

    expect(outcome.opened).toBe(false);
    expect(outcome.commits).toBe(0);
    expect(outcome.error).toBeUndefined();

    // No PR branch was pushed, and nothing was left behind locally.
    expect(git(['branch', '--list', 'capy-edit-*'], REPO).stdout.trim()).toBe('');
    expect(git(['worktree', 'list'], REPO).stdout.trim().split('\n')).toHaveLength(1);
  });

  test('scaffolds a fresh keep.lock (identity from the local keep) when the target branch has none yet', async () => {
    git(['checkout', '-q', '-b', 'no-keep-branch'], REPO);
    rmSync(join(REPO, 'keep.lock'));
    git(['add', '-A'], REPO);
    git(['commit', '-q', '-m', 'remove keep.lock on this branch'], REPO);
    git(['push', '-q', 'origin', 'no-keep-branch'], REPO);
    git(['checkout', '-q', 'main'], REPO);

    const localKeep = keepWith({});
    const records: EditSaveRecord[] = [
      {
        branch: 'production',
        entries: [{ variable: 'NEW_VAR', entry: { resource_id: 'r-new', branch: 'production', value_hash: 'h1' } }],
      },
    ];

    const outcome = await runEditExitFlow(REPO, 'no-keep-branch', records, localKeep, { createPr: fakeCreatePr });

    expect(outcome.opened).toBe(true);
    expect(outcome.commits).toBe(1);
    const finalKeep = JSON.parse(git(['show', `${outcome.branch}:keep.lock`], ORIGIN).stdout) as KeepFile;
    expect(finalKeep.org_id).toBe(localKeep.org_id);
    expect(finalKeep.variables.NEW_VAR[0].value_hash).toBe('h1');
  });
});
