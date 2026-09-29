/**
 * MUST-FIX 2 (independent-validation review): after CAP-667, capy's regular
 * flows (sync/push/rotate/connect/edit) write fresh pins only into the
 * untracked working copy at `.capy/keep.lock` — the tracked `keep.lock` is
 * frozen after project init (FileManager.writeKeepFile). `capy deploy`'s
 * `readKeep` and its direct-mode "commit keep.lock on the current branch"
 * step both used to read/commit the TRACKED file directly, which is now
 * stale by the time a deploy runs.
 *
 * `readKeep` (deployCommand.ts) now routes through the same
 * `.capy/keep.lock`-then-tracked resolution as `ProjectManager.readKeepFile`
 * (verified below with real files, no mocks). `syncTrackedKeepForDirectDeploy`
 * (deployCommand.ts) catches the tracked file up to the working copy right
 * before direct mode decides whether keep.lock is dirty — verified below
 * with REAL git, end to end: the commit direct mode makes must carry the
 * up-to-date pins, and `.capy/keep.lock` itself must be untouched afterward.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { readKeep, syncTrackedKeepForDirectDeploy } from '../../src/commands/deployCommand';
import { hasKeepLockChanges, stageAndCommit, isGitRepo } from '../../src/deploy/git';
import { serializeKeep } from '../../src/files/fileManager';
import { KeepFile } from '../../src/types/index';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function keepWith(vars: Record<string, string>, branch: string): KeepFile {
  const variables: KeepFile['variables'] = {};
  for (const [name, hash] of Object.entries(vars)) {
    variables[name] = [{ resource_id: `r-${name}`, branch, value_hash: hash }];
  }
  return { version: '3', org_id: 'org-1', project_id: 'proj-1', project_name: 'test-project', variables };
}

describe('readKeep prefers .capy/keep.lock over the tracked file (CAP-667)', () => {
  const TMP = join(tmpdir(), `capy-readkeep-${process.pid}`);

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('falls back to the tracked file when .capy/keep.lock is absent', () => {
    const tracked = keepWith({ API_KEY: 'hash1' }, 'production');
    writeFileSync(join(TMP, 'keep.lock'), serializeKeep(tracked));

    const info = readKeep(TMP);

    expect(info?.variables).toEqual(['API_KEY']);
    expect(info?.branches).toEqual(['production']);
  });

  test('prefers .capy/keep.lock when present — the tracked file is frozen, the working copy has the fresh pins', () => {
    const tracked = keepWith({}, 'production'); // frozen: no variables
    writeFileSync(join(TMP, 'keep.lock'), serializeKeep(tracked));

    mkdirSync(join(TMP, '.capy'), { recursive: true });
    const working = keepWith({ API_KEY: 'hash1', DB_URL: 'hash2' }, 'production');
    writeFileSync(join(TMP, '.capy', 'keep.lock'), serializeKeep(working));

    const info = readKeep(TMP);

    expect(info?.variables.sort()).toEqual(['API_KEY', 'DB_URL']);
  });

  test('returns null when neither file exists', () => {
    expect(readKeep(TMP)).toBeNull();
  });
});

describe('syncTrackedKeepForDirectDeploy', () => {
  const TMP = join(tmpdir(), `capy-synctracked-${process.pid}`);

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('copies the working copy over the tracked file when they differ', () => {
    const tracked = keepWith({}, 'production');
    writeFileSync(join(TMP, 'keep.lock'), serializeKeep(tracked));
    mkdirSync(join(TMP, '.capy'), { recursive: true });
    const working = keepWith({ API_KEY: 'hash1' }, 'production');
    writeFileSync(join(TMP, '.capy', 'keep.lock'), serializeKeep(working));

    syncTrackedKeepForDirectDeploy(TMP);

    expect(readFileSync(join(TMP, 'keep.lock'), 'utf-8')).toBe(serializeKeep(working));
    // The working copy itself is never touched by this sync.
    expect(readFileSync(join(TMP, '.capy', 'keep.lock'), 'utf-8')).toBe(serializeKeep(working));
  });

  test('is a no-op when there is no working copy yet', () => {
    const tracked = keepWith({ API_KEY: 'hash1' }, 'production');
    const trackedContent = serializeKeep(tracked);
    writeFileSync(join(TMP, 'keep.lock'), trackedContent);

    syncTrackedKeepForDirectDeploy(TMP);

    expect(readFileSync(join(TMP, 'keep.lock'), 'utf-8')).toBe(trackedContent);
  });

  test('is a no-op when the tracked file already matches the working copy', () => {
    const keep = keepWith({ API_KEY: 'hash1' }, 'production');
    const content = serializeKeep(keep);
    writeFileSync(join(TMP, 'keep.lock'), content);
    mkdirSync(join(TMP, '.capy'), { recursive: true });
    writeFileSync(join(TMP, '.capy', 'keep.lock'), content);

    syncTrackedKeepForDirectDeploy(TMP);

    expect(readFileSync(join(TMP, 'keep.lock'), 'utf-8')).toBe(content);
  });
});

describe('deploy direct mode end-to-end: commits the up-to-date pins, not the frozen tracked file (real git)', () => {
  const TMP = join(tmpdir(), `capy-directdeploy-e2e-${process.pid}`);
  const REPO = join(TMP, 'repo');

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    git(['init', '-q', '-b', 'main', REPO], TMP);
    git(['config', 'user.email', 't@e.com'], REPO);
    git(['config', 'user.name', 'T'], REPO);
    git(['config', 'commit.gpgsign', 'false'], REPO);

    // Simulate the post-CAP-667 world: the tracked keep.lock was created
    // once at init (empty variables) and committed — exactly what
    // FileManager.writeKeepFile leaves behind, and exactly what direct-mode
    // deploy used to read and re-commit verbatim.
    // Same as `ensureCapyGitignore` leaves behind — `.capy/` (the working
    // copy's home) is gitignored in any real capy project.
    writeFileSync(join(REPO, '.gitignore'), '.env\n!/.capy/\n/.capy/*\n!/.capy/deploy.json\n');
    const frozenTracked = keepWith({}, 'production');
    writeFileSync(join(REPO, 'keep.lock'), serializeKeep(frozenTracked));
    git(['add', 'keep.lock', '.gitignore'], REPO);
    git(['commit', '-q', '-m', 'init'], REPO);

    // capy's regular flows since then (sync/push/edit) only ever wrote the
    // untracked working copy — this is the CURRENT, real state of the pins.
    mkdirSync(join(REPO, '.capy'), { recursive: true });
    const workingKeep = keepWith({ API_KEY: 'hash1', DB_URL: 'hash2' }, 'production');
    writeFileSync(join(REPO, '.capy', 'keep.lock'), serializeKeep(workingKeep));
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('without the fix: the tracked file looks clean (nothing to commit) even though pins have moved', () => {
    // This documents the regression this fix addresses — direct mode's own
    // dirty-check, run against the untouched tracked file.
    expect(hasKeepLockChanges(REPO)).toBe(false);
  });

  test('with the fix: syncing the tracked file to the working copy produces a real diff, and direct mode commits the up-to-date pins', () => {
    expect(isGitRepo(REPO)).toBe(true);

    syncTrackedKeepForDirectDeploy(REPO);

    // Now there IS something to commit — the actual bug fix.
    expect(hasKeepLockChanges(REPO)).toBe(true);

    const commit = stageAndCommit(REPO, ['keep.lock'], 'chore(deploy): test-target → production (test)');
    expect(commit.ok).toBe(true);

    // The committed tracked file carries the CURRENT pins, not the frozen ones.
    const committedContent = git(['show', 'HEAD:keep.lock'], REPO).stdout;
    const committed = JSON.parse(committedContent) as KeepFile;
    expect(Object.keys(committed.variables).sort()).toEqual(['API_KEY', 'DB_URL']);

    // The working copy is exactly what it was before — this only ever reads
    // from it, never writes to it.
    const workingKeep = keepWith({ API_KEY: 'hash1', DB_URL: 'hash2' }, 'production');
    expect(readFileSync(join(REPO, '.capy', 'keep.lock'), 'utf-8')).toBe(serializeKeep(workingKeep));

    // Working tree is clean after the commit — nothing left uncommitted.
    expect(git(['status', '--porcelain'], REPO).stdout.trim()).toBe('');
  });
});
