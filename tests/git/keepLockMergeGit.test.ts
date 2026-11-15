/**
 * The keep.lock merge driver under REAL git: throwaway repos, the driver
 * installed by `installKeepLockMergeDriver`, and a `capy` shim on PATH that
 * runs this checkout's CLI. Git is the one calling the driver, with its own
 * `%O %A %B` files, so what is asserted is what a person's `git merge` does.
 *
 * The control for every conflict: the same repo and the same three versions
 * merged with the driver config removed, i.e. git's own text merge. Whenever
 * the driver cannot finish, the file must be byte-identical to that.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { installKeepLockMergeDriver } from '../../src/git/keepLockMergeInstall';
import { git, gitEnv, lockEntry, lockText, makeCapyShim, makeRepo, makeRoot } from '../helpers/keepLockGit';

const ROOT = makeRoot('capy-keep-merge-git-');
const SHIM = makeCapyShim(ROOT);
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
const ENV = gitEnv(HOME, SHIM);

/** PATH with git on it and no `capy` at all: the binary the config names cannot be found. */
const ENV_NO_CAPY: NodeJS.ProcessEnv = { ...gitEnv(HOME), PATH: '/usr/bin:/bin' };

/** A `capy` that exists but is an older build without the merge command: it prints nothing useful and exits 1. */
const OLD_CAPY_DIR = join(ROOT, 'old-capy-bin');
mkdirSync(OLD_CAPY_DIR, { recursive: true });
writeFileSync(join(OLD_CAPY_DIR, 'capy'), '#!/bin/sh\nexit 1\n');
chmodSync(join(OLD_CAPY_DIR, 'capy'), 0o755);
const ENV_OLD_CAPY: NodeJS.ProcessEnv = { ...gitEnv(HOME), PATH: `${OLD_CAPY_DIR}:/usr/bin:/bin` };

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const run = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = ENV) => git(cwd, args, env);

const write = (dir: string, file: string, content: string): void => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
};

const commit = (dir: string, message: string): void => {
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', message]);
};

type Texts = { readonly base: string; readonly ours: string; readonly theirs: string };

interface World {
  readonly repo: string;
  readonly merge: ReturnType<typeof git>;
  readonly file: string;
}

/**
 * From a repo whose HEAD is the base commit: `theirs` on a branch, `ours` on
 * the branch it started from, then `git merge` of the branch. Returns the merge
 * result and the keep.lock's content afterwards.
 */
function mergeBranches(repo: string, lockPath: string, texts: Texts, env: NodeJS.ProcessEnv): World {
  const start = run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  run(repo, ['checkout', '-q', '-b', 'feature']);
  write(repo, lockPath, texts.theirs);
  commit(repo, 'theirs');
  run(repo, ['checkout', '-q', start]);
  write(repo, lockPath, texts.ours);
  commit(repo, 'ours');
  const merge = run(repo, ['merge', 'feature', '--no-edit'], env);
  return { repo, merge, file: readFileSync(join(repo, lockPath), 'utf-8') };
}

/**
 * A repo with `base` committed and the driver installed, then the two sides
 * merged. `dropConfig` removes the driver command from the clone's config
 * afterwards: git's own text merge, the control.
 */
function mergeWorld(
  name: string,
  texts: Texts,
  options: { readonly lockPath?: string; readonly dropConfig?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): World {
  const lockPath = options.lockPath ?? 'keep.lock';
  const repo = makeRepo(ROOT, name);
  write(repo, lockPath, texts.base);
  expect(installKeepLockMergeDriver(repo).installed).toBe(true);
  if (options.dropConfig) run(repo, ['config', '--local', '--unset', 'merge.capy-keep-lock.driver']);
  commit(repo, 'base');
  return mergeBranches(repo, lockPath, texts, options.env ?? ENV);
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

// A true disagreement: the same entry's value_hash changed to different things.
const disagreeTexts: Texts = {
  base,
  ours: lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hOURS')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] }),
  theirs: lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hTHEIRS')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] }),
};

const output = (w: World): string => w.merge.stdout + w.merge.stderr;
const hasMarkers = (text: string): boolean => text.includes('<<<<<<< ') && text.includes('\n=======\n') && text.includes('>>>>>>> ');

describe('git merge with the keep.lock driver installed', () => {
  test('the real example merges with no prompt, to exactly the content the CLI would write', () => {
    const w = mergeWorld('example', { base, ours: exampleOurs, theirs: exampleTheirs });
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(exampleMerged);
    expect(run(w.repo, ['status', '--porcelain']).stdout).toBe('');
    expect(run(w.repo, ['rev-list', '--merges', '--count', 'HEAD']).stdout.trim()).toBe('1');
    expect(run(w.repo, ['show', 'HEAD:keep.lock']).stdout).toBe(exampleMerged);
  });

  test('the same example conflicts as TEXT without the driver, so it is the driver that merged it', () => {
    const w = mergeWorld('example-no-config', { base, ours: exampleOurs, theirs: exampleTheirs }, { dropConfig: true });
    expect(w.merge.code).not.toBe(0);
    expect(w.file).toContain('<<<<<<<');
  });

  test('a keep.lock in a project folder inside the repo is merged too', () => {
    const w = mergeWorld('subfolder', { base, ours: exampleOurs, theirs: exampleTheirs }, { lockPath: 'apps/web/keep.lock' });
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(exampleMerged);
  });

  test('both sides adding the file (no ancestor) merges', () => {
    const repo = makeRepo(ROOT, 'add-add');
    write(repo, 'README.md', 'x\n');
    installKeepLockMergeDriver(repo);
    commit(repo, 'base');
    const w = mergeBranches(repo, 'keep.lock', {
      base: '',
      ours: lockText({ ONE: [lockEntry('ONE', 'prod', 'o')] }),
      theirs: lockText({ TWO: [lockEntry('TWO', 'prod', 't')] }),
    }, ENV);
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(lockText({ ONE: [lockEntry('ONE', 'prod', 'o')], TWO: [lockEntry('TWO', 'prod', 't')] }));
  });

  test('a clone with the mapping but no driver in its git config falls back to git\'s text merge', () => {
    const farApartOurs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hA')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] });
    const farApartTheirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'h1')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] });
    const w = mergeWorld('no-config-text', { base, ours: farApartOurs, theirs: farApartTheirs }, { dropConfig: true });
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hA')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] }));
  });
});

describe('a merge the driver cannot finish leaves git\'s own text merge, markers included', () => {
  const control = (name: string, texts: Texts) => mergeWorld(`${name}-control`, texts, { dropConfig: true });

  test('a true value_hash disagreement: git reports a conflict, the file is git\'s text merge with markers, the code is on stderr', () => {
    const w = mergeWorld('disagree', disagreeTexts);
    const c = control('disagree', disagreeTexts);
    expect(w.merge.code).not.toBe(0);
    expect(run(w.repo, ['ls-files', '-u', 'keep.lock']).stdout).not.toBe('');
    expect(hasMarkers(w.file)).toBe(true);
    expect(w.file).toBe(c.file);
    expect(w.file).not.toBe(disagreeTexts.ours);
    expect(output(w)).toContain('VALUE_HASH_DIVERGED');
    expect(output(w)).toContain('ALPHA');
  });

  test('git\'s two sides of the conflict hold both our value and theirs (nothing dropped)', () => {
    const w = mergeWorld('disagree-both', disagreeTexts);
    expect(w.file).toContain('hOURS');
    expect(w.file).toContain('hTHEIRS');
  });

  test('the binary the config names is not on PATH: a conflict with markers, the same file as git\'s text merge, merged once', () => {
    const w = mergeWorld('no-binary', disagreeTexts, { env: ENV_NO_CAPY });
    const c = control('no-binary', disagreeTexts);
    expect(w.merge.code).not.toBe(0);
    expect(hasMarkers(w.file)).toBe(true);
    expect(w.file).toBe(c.file);
    expect(run(w.repo, ['ls-files', '-u', 'keep.lock']).stdout).not.toBe('');
  });

  test('no binary, and the sides do not overlap: the fallback is git\'s text merge, so it merges cleanly like git would', () => {
    const farApartOurs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'hA')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'h3')] });
    const farApartTheirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'h1')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] });
    const w = mergeWorld('no-binary-clean', { base, ours: farApartOurs, theirs: farApartTheirs }, { env: ENV_NO_CAPY });
    expect(w.merge.code).toBe(0);
    expect(w.file).toContain('hA');
    expect(w.file).toContain('hZ');
    expect(w.file).not.toContain('<<<<<<<');
  });

  test('a capy that does not know the command (older build) exits 1: still a marked conflict, merged once', () => {
    const w = mergeWorld('old-capy', disagreeTexts, { env: ENV_OLD_CAPY });
    const c = control('old-capy', disagreeTexts);
    expect(w.merge.code).not.toBe(0);
    expect(w.file).toBe(c.file);
    expect(hasMarkers(w.file)).toBe(true);
  });

  test('a side that is not a valid keep.lock: a marked conflict, the same as git\'s text merge', () => {
    const texts: Texts = { base, ours: exampleOurs, theirs: '{ not json' };
    const w = mergeWorld('invalid', texts);
    const c = control('invalid', texts);
    expect(w.merge.code).not.toBe(0);
    expect(w.file).toBe(c.file);
    expect(hasMarkers(w.file)).toBe(true);
    expect(output(w)).toContain('INVALID_KEEP_LOCK');
  });

  test('a conflict only the driver sees (text merges cleanly): git is told it is a conflict and nothing of either side is dropped', () => {
    const withFutureField = exampleOurs.replace('"project_name": "proj-name",', '"project_name": "proj-name",\n  "future_field": 1,');
    expect(withFutureField).not.toBe(exampleOurs);
    const farTheirs = lockText({ ALPHA: [lockEntry('ALPHA', 'prod', 'h1')], BRAVO: [lockEntry('BRAVO', 'prod', 'h2')], ZULU: [lockEntry('ZULU', 'prod', 'hZ')] });
    const texts: Texts = { base, ours: withFutureField, theirs: farTheirs };
    const w = mergeWorld('unknown-field', texts);
    const c = control('unknown-field', texts);
    expect(c.merge.code).toBe(0);
    expect(w.merge.code).not.toBe(0);
    expect(w.file).toBe(c.file);
    expect(w.file).toContain('future_field');
    expect(w.file).toContain('hZ');
    expect(output(w)).toContain('UNKNOWN_TOP_LEVEL_FIELD');
  });
});

describe('the driver command, as git runs it', () => {
  const files = (name: string, texts: Texts) => {
    const dir = join(ROOT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'O'), texts.base);
    writeFileSync(join(dir, 'A'), texts.ours);
    writeFileSync(join(dir, 'B'), texts.theirs);
    return dir;
  };
  /** Runs `capy merge-keep-lock` from an unrelated directory, with an empty HOME: no login, network, terminal or repo. */
  const drive = (dir: string, extra: readonly string[] = [], ancestor = join(dir, 'O')) =>
    spawnSync('capy', ['merge-keep-lock', ancestor, join(dir, 'A'), join(dir, 'B'), ...extra], {
      cwd: HOME,
      encoding: 'utf-8',
      env: { ...ENV, CAPY_API_URL: 'http://127.0.0.1:9' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const textMerge = (dir: string, ours: string, labels: readonly string[]) => {
    const copy = join(dir, 'A.expected');
    writeFileSync(copy, ours);
    spawnSync('git', ['merge-file', '-L', labels[0], '-L', labels[1], '-L', labels[2], copy, join(dir, 'O'), join(dir, 'B')], { env: ENV });
    return readFileSync(copy, 'utf-8');
  };

  test('clean merge: exit 0, the merged file written over %A, nothing else touched', () => {
    const dir = files('cmd-clean', { base, ours: exampleOurs, theirs: exampleTheirs });
    const r = drive(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toBe(exampleMerged);
    expect(readFileSync(join(dir, 'B'), 'utf-8')).toBe(exampleTheirs);
    expect(readFileSync(join(dir, 'O'), 'utf-8')).toBe(base);
  });

  test('conflict: exit 2, %A is git\'s text merge with markers (using the labels git passed), the reason on stderr', () => {
    const dir = files('cmd-conflict', disagreeTexts);
    const r = drive(dir, ['HEAD', 'abc1234', 'feature', '7']);
    expect(r.status).toBe(2);
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toBe(textMerge(dir, disagreeTexts.ours, ['HEAD', 'abc1234', 'feature']));
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toContain('<<<<<<< HEAD');
    expect(readFileSync(join(dir, 'A'), 'utf-8')).toContain('>>>>>>> feature');
    expect(r.stderr).toContain('VALUE_HASH_DIVERGED');
    expect(r.stderr).toContain('ALPHA');
    expect(r.stdout).toBe('');
  });

  test('labels git left unexpanded (an older git) fall back to plain names', () => {
    const dir = files('cmd-labels', disagreeTexts);
    drive(dir, ['%X', '%S', '%Y', '%L']);
    const a = readFileSync(join(dir, 'A'), 'utf-8');
    expect(a).toContain('<<<<<<< ours');
    expect(a).toContain('>>>>>>> theirs');
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

  test('an ancestor path that cannot be read is invalid input, not "no ancestor": a marked conflict, never a silent merge', () => {
    const dir = files('cmd-missing-base', {
      base: '',
      ours: lockText({ ONE: [lockEntry('ONE', 'prod', 'o')] }),
      theirs: lockText({ TWO: [lockEntry('TWO', 'prod', 't')] }),
    });
    const r = drive(dir, [], join(dir, 'does-not-exist'));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('INVALID_KEEP_LOCK base');
    const a = readFileSync(join(dir, 'A'), 'utf-8');
    expect(hasMarkers(a)).toBe(true);
    expect(a).toContain('"ONE"');
    expect(a).toContain('"TWO"');
  });

  test('is not listed in help: it is for git, not for people', () => {
    const help = spawnSync('capy', ['help', '--json'], { cwd: HOME, encoding: 'utf-8', env: ENV });
    expect(help.status).toBe(0);
    const commands = (JSON.parse(help.stdout) as { commands: { name: string }[] }).commands.map((c) => c.name);
    expect(commands).not.toContain('merge-keep-lock');
  });
});

describe('where git reads the installed mapping: linked worktrees and submodules', () => {
  const infoPathFrom = (dir: string): string => run(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']).stdout.trim();

  test('a linked worktree: the mapping goes to the shared git directory, git honours it there, and nothing appears in either work tree', () => {
    const main = makeRepo(ROOT, 'wt-main');
    write(main, 'keep.lock', base);
    write(main, 'README.md', 'x\n');
    commit(main, 'base');
    const wt = join(ROOT, 'wt-linked');
    expect(run(main, ['worktree', 'add', '-q', '-b', 'work', wt]).code).toBe(0);
    expect(installKeepLockMergeDriver(wt).installed).toBe(true);
    expect(infoPathFrom(wt)).toBe(infoPathFrom(main));
    expect(readFileSync(infoPathFrom(main), 'utf-8')).toBe('keep.lock merge=capy-keep-lock\n');
    expect(run(wt, ['status', '--porcelain']).stdout).toBe('');
    expect(run(main, ['status', '--porcelain']).stdout).toBe('');
    const w = mergeBranches(wt, 'keep.lock', { base, ours: exampleOurs, theirs: exampleTheirs }, ENV);
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(exampleMerged);
  });

  test('a submodule: the mapping goes to the module\'s own git directory, git honours it there, and the superproject stays clean', () => {
    const source = makeRepo(ROOT, 'sub-source');
    write(source, 'keep.lock', base);
    commit(source, 'base');
    const parent = makeRepo(ROOT, 'sub-parent');
    write(parent, 'README.md', 'x\n');
    commit(parent, 'init');
    const added = run(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub']);
    expect(added.code).toBe(0);
    commit(parent, 'add sub');
    const sub = join(parent, 'sub');
    expect(installKeepLockMergeDriver(sub).installed).toBe(true);
    const info = infoPathFrom(sub);
    expect(info).toContain(join('.git', 'modules', 'sub', 'info', 'attributes'));
    expect(readFileSync(info, 'utf-8')).toBe('keep.lock merge=capy-keep-lock\n');
    expect(run(parent, ['status', '--porcelain']).stdout).toBe('');
    expect(run(sub, ['status', '--porcelain']).stdout).toBe('');
    run(sub, ['checkout', '-q', '-b', 'work']);
    const w = mergeBranches(sub, 'keep.lock', { base, ours: exampleOurs, theirs: exampleTheirs }, ENV);
    expect(w.merge.code).toBe(0);
    expect(w.file).toBe(exampleMerged);
  });
});
