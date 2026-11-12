/**
 * The keep.lock merge driver under REAL git: throwaway repos, the driver
 * installed by `installKeepLockMergeDriver`, and a `capy` shim on PATH that
 * runs this checkout's CLI. Git is the one calling the driver, with its own
 * `%O %A %B` files, so what is asserted is what a person's `git merge` does.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { installKeepLockMergeDriver } from '../../src/git/keepLockMergeInstall';
import { git, gitEnv, lockEntry, lockText, makeCapyShim, makeRepo, makeRoot } from '../helpers/keepLockGit';

const ROOT = makeRoot('capy-keep-merge-git-');
const SHIM = makeCapyShim(ROOT);
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
const ENV = gitEnv(HOME, SHIM);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const run = (cwd: string, args: readonly string[]) => git(cwd, args, ENV);

const write = (dir: string, file: string, content: string): void => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
};

const commit = (dir: string, message: string): void => {
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', message]);
};

interface World {
  readonly repo: string;
  readonly merge: ReturnType<typeof git>;
  readonly oursText: string;
}

/**
 * base committed on main (with the driver installed), `theirs` on a branch,
 * `ours` on main, then `git merge` of the branch into main. `lockPath` is
 * where the keep.lock lives (a project folder inside the repo, or the root).
 */
function mergeWorld(
  name: string,
  texts: { readonly base: string; readonly ours: string; readonly theirs: string },
  options: { readonly lockPath?: string; readonly dropConfig?: boolean } = {},
): World {
  const lockPath = options.lockPath ?? 'keep.lock';
  const repo = makeRepo(ROOT, name);
  write(repo, lockPath, texts.base);
  const installed = installKeepLockMergeDriver(repo);
  expect(installed.installed).toBe(true);
  if (options.dropConfig) run(repo, ['config', '--local', '--unset', 'merge.capy-keep-lock.driver']);
  commit(repo, 'base');
  run(repo, ['checkout', '-q', '-b', 'feature']);
  write(repo, lockPath, texts.theirs);
  commit(repo, 'theirs');
  run(repo, ['checkout', '-q', 'main']);
  write(repo, lockPath, texts.ours);
  commit(repo, 'ours');
  const merge = run(repo, ['merge', 'feature', '--no-edit']);
  return { repo, merge, oursText: texts.ours };
}

const base = lockText({
  ALPHA: [lockEntry('ALPHA', 'prod', 'h1')],
  BRAVO: [lockEntry('BRAVO', 'prod', 'h2')],
  ZULU: [lockEntry('ZULU', 'prod', 'h3')],
});

// The case that conflicted as text: a new name on one side; on one entry, one
// side added changed_at and the other added targets.
const exampleOurs = lockText({
  ALPHA: [lockEntry('ALPHA', 'prod', 'h1')],
  BRAVO: [lockEntry('BRAVO', 'prod', 'h2', { changed_at: '2026-11-10T10:00:00.000Z' })],
  WORKOS_SUBDOMAIN: [lockEntry('WORKOS_SUBDOMAIN', 'prod', 'h9')],
  ZULU: [lockEntry('ZULU', 'prod', 'h3')],
});
const targets = [{ provider: 'dokploy', target: 'web', deployed_value_hash: 'h2', deployed_at: '2026-11-11T09:00:00.000Z' }];
const exampleTheirs = lockText({
  ALPHA: [lockEntry('ALPHA', 'prod', 'h1')],
  BRAVO: [lockEntry('BRAVO', 'prod', 'h2', { targets })],
  ZULU: [lockEntry('ZULU', 'prod', 'h3')],
});
const exampleMerged = lockText({
  ALPHA: [lockEntry('ALPHA', 'prod', 'h1')],
  BRAVO: [lockEntry('BRAVO', 'prod', 'h2', { changed_at: '2026-11-10T10:00:00.000Z', targets })],
  WORKOS_SUBDOMAIN: [lockEntry('WORKOS_SUBDOMAIN', 'prod', 'h9')],
  ZULU: [lockEntry('ZULU', 'prod', 'h3')],
});

describe('git merge with the keep.lock driver installed', () => {
  test('the real example merges with no prompt, to exactly the content the CLI would write', () => {
    const w = mergeWorld('example', { base, ours: exampleOurs, theirs: exampleTheirs });
    expect(w.merge.code).toBe(0);
    expect(readFileSync(join(w.repo, 'keep.lock'), 'utf-8')).toBe(exampleMerged);
    expect(run(w.repo, ['status', '--porcelain']).stdout).toBe('');
    expect(run(w.repo, ['rev-list', '--merges', '--count', 'HEAD']).stdout.trim()).toBe('1');
    expect(run(w.repo, ['show', 'HEAD:keep.lock']).stdout).toBe(exampleMerged);
  });

  test('the same example conflicts as TEXT without the driver, so it is the driver that merged it', () => {
    const w = mergeWorld('example-no-config', { base, ours: exampleOurs, theirs: exampleTheirs }, { dropConfig: true });
    expect(w.merge.code).not.toBe(0);
    expect(readFileSync(join(w.repo, 'keep.lock'), 'utf-8')).toContain('<<<<<<<');
  });

  test('a keep.lock in a project folder inside the repo is merged too', () => {
    const w = mergeWorld('subfolder', { base, ours: exampleOurs, theirs: exampleTheirs }, { lockPath: 'apps/web/keep.lock' });
    expect(w.merge.code).toBe(0);
    expect(readFileSync(join(w.repo, 'apps/web/keep.lock'), 'utf-8')).toBe(exampleMerged);
  });

  test('a true value_hash disagreement is a conflict: git reports it and the file is ours, untouched', () => {
    const ours = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hOURS')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] });
    const theirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hTHEIRS')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] });
    const w = mergeWorld('disagree', { base, ours, theirs });
    expect(w.merge.code).not.toBe(0);
    expect(run(w.repo, ['ls-files', '-u', 'keep.lock']).stdout).not.toBe('');
    expect(readFileSync(join(w.repo, 'keep.lock'), 'utf-8')).toBe(w.oursText);
    expect(w.merge.stdout + w.merge.stderr).toContain('VALUE_HASH_DIVERGED');
    expect(w.merge.stdout + w.merge.stderr).toContain('ALPHA');
  });

  test('a side that is not a valid keep.lock is a conflict, and the file is ours', () => {
    const w = mergeWorld('invalid', { base, ours: exampleOurs, theirs: '{ not json' });
    expect(w.merge.code).not.toBe(0);
    expect(readFileSync(join(w.repo, 'keep.lock'), 'utf-8')).toBe(exampleOurs);
    expect(w.merge.stdout + w.merge.stderr).toContain('INVALID_KEEP_LOCK');
  });

  test('both sides adding the file (no ancestor) merges', () => {
    const repo = makeRepo(ROOT, 'add-add');
    write(repo, 'README.md', 'x\n');
    installKeepLockMergeDriver(repo);
    commit(repo, 'base');
    run(repo, ['checkout', '-q', '-b', 'feature']);
    const theirs = lockText({ TWO: [lockEntry('TWO', 'prod', 't')] });
    write(repo, 'keep.lock', theirs);
    commit(repo, 'theirs');
    run(repo, ['checkout', '-q', 'main']);
    const ours = lockText({ ONE: [lockEntry('ONE', 'prod', 'o')] });
    write(repo, 'keep.lock', ours);
    commit(repo, 'ours');
    const merge = run(repo, ['merge', 'feature', '--no-edit']);
    expect(merge.code).toBe(0);
    expect(readFileSync(join(repo, 'keep.lock'), 'utf-8')).toBe(
      lockText({ ONE: [lockEntry('ONE', 'prod', 'o')], TWO: [lockEntry('TWO', 'prod', 't')] }),
    );
  });

  test('a clone with the mapping committed but no driver in its git config falls back to git\'s text merge', () => {
    const farApartOurs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hA')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] });
    const farApartTheirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'h1')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] });
    const w = mergeWorld('no-config-text', { base, ours: farApartOurs, theirs: farApartTheirs }, { dropConfig: true });
    expect(w.merge.code).toBe(0);
    expect(readFileSync(join(w.repo, 'keep.lock'), 'utf-8')).toBe(
      lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hA')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] }),
    );
  });
});

describe('the driver command, as git runs it', () => {
  const files = (name: string, texts: { readonly base: string; readonly ours: string; readonly theirs: string }) => {
    const dir = join(ROOT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'O'), texts.base);
    writeFileSync(join(dir, 'A'), texts.ours);
    writeFileSync(join(dir, 'B'), texts.theirs);
    return dir;
  };
  /** Runs `capy merge-keep-lock` from an unrelated directory, with an empty HOME: no login, network, terminal or repo. */
  const drive = (dir: string) =>
    spawnSync('capy', ['merge-keep-lock', join(dir, 'O'), join(dir, 'A'), join(dir, 'B')], {
      cwd: HOME,
      encoding: 'utf-8',
      env: { ...ENV, CAPY_API_URL: 'http://127.0.0.1:9' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  test('clean merge: exit 0, the merged file written over %A, nothing else touched', () => {
    const dir = files('cmd-clean', { base, ours: exampleOurs, theirs: exampleTheirs });
    const r = drive(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toBe(exampleMerged);
    expect(readFileSync(join(dir, 'B'), 'utf-8')).toBe(exampleTheirs);
    expect(readFileSync(join(dir, 'O'), 'utf-8')).toBe(base);
  });

  test('conflict: non-zero exit, %A byte-for-byte unchanged, the reason on stderr', () => {
    const ours = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'x1')] });
    const theirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'x2')] });
    const dir = files('cmd-conflict', { base: lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'x0')] }), ours, theirs });
    const r = drive(dir);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toBe(ours);
    expect(r.stderr).toContain('VALUE_HASH_DIVERGED');
    expect(r.stderr).toContain('ALPHA');
    expect(r.stdout).toBe('');
  });

  test('an empty ancestor file (git\'s add/add) is no ancestor', () => {
    const dir = files('cmd-empty-base', {
      base: '',
      ours: lockText({ ONE: [lockEntry('ONE', 'prod', 'o')] }),
      theirs: lockText({ TWO: [lockEntry('TWO', 'prod', 't')] }),
    });
    expect(drive(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toBe(lockText({ ONE: [lockEntry('ONE', 'prod', 'o')], TWO: [lockEntry('TWO', 'prod', 't')] }));
  });

  test('is not listed in help: it is for git, not for people', () => {
    const help = spawnSync('capy', ['help', '--json'], { cwd: HOME, encoding: 'utf-8', env: ENV });
    expect(help.status).toBe(0);
    const commands = (JSON.parse(help.stdout) as { commands: { name: string }[] }).commands.map((c) => c.name);
    expect(commands).not.toContain('merge-keep-lock');
  });
});
