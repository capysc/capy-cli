import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { FileManager } from '../../src/files/fileManager';
import {
  addToSparseCheckout, escapeSparsePattern, planMissingGitignore, runGit,
  type GitRunner,
} from '../../src/files/trackedGitignore';
import { CapyError, ERROR_CODES } from '../../src/types/index';

// Real git in temp folders. A tracked `.gitignore` that sparse checkout keeps
// off disk must never be replaced by a fresh file holding only Capy's entries.

const ROOT = mkdtempSync(join(tmpdir(), 'capy-gitignore-sparse-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const git = (cwd: string, args: readonly string[]) =>
  spawnSync('git', [...args], { cwd, encoding: 'utf-8', env: GIT_ENV });

const gitOut = (cwd: string, args: readonly string[]): string => git(cwd, args).stdout;

// The entries `ensureCapyGitignore` asks for.
const CAPY_ENTRIES = [
  '.env',
  '!/.capy/',
  '/.capy/*',
  '!/.capy/deploy.json',
  '.env.pre-capy.old',
  '.env.*.decrypted',
] as const;

const ORIGINAL_LINES = ['node_modules/', 'dist/', '*.log'] as const;
const ORIGINAL = ORIGINAL_LINES.join('\n') + '\n';
const COMPLETE = ORIGINAL + '\n# Capy\n' + CAPY_ENTRIES.join('\n') + '\n';

interface Scenario {
  readonly top: string;
  readonly folder: string;
  readonly gitignorePath: string;
}

const freshDir = (): string => {
  const dir = join(ROOT, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A repo with `<sub>.gitignore` and `<sub>keep.lock` committed, files written but not yet sparse. */
const committedRepo = (sub: string, gitignore: string): Scenario => {
  const top = freshDir();
  const folder = join(top, sub);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.gitignore'), gitignore);
  writeFileSync(join(folder, 'keep.lock'), '{}\n');
  writeFileSync(join(folder, 'other.txt'), 'x\n');
  git(top, ['init', '-q', '.']);
  git(top, ['add', '-A']);
  git(top, ['commit', '-q', '-m', 'init']);
  return { top, folder, gitignorePath: join(folder, '.gitignore') };
};

/** Non-cone sparse checkout that lists only `<sub>keep.lock`, so `<sub>.gitignore` is off disk. */
const sparseRepo = (sub: string, gitignore: string): Scenario => {
  const scenario = committedRepo(sub, gitignore);
  const keepPattern = `/${escapeSparsePattern(sub)}keep.lock`;
  const set = git(scenario.top, ['sparse-checkout', 'set', '--no-cone', keepPattern]);
  expect(set.status).toBe(0);
  expect(existsSync(scenario.gitignorePath)).toBe(false);
  return scenario;
};

const sparseList = (top: string): string =>
  gitOut(top, ['sparse-checkout', 'list']);

const read = (path: string): string => readFileSync(path, 'utf-8');

/** Runs `fn` and returns what it wrote to stderr via console.error, line by line. */
const captureStderr = (fn: () => void): readonly string[] => {
  const spy = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    fn();
    return spy.mock.calls.map((args) => args.join(' '));
  } finally {
    spy.mockRestore();
  }
};

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof CapyError ? err.code : 'NOT_A_CAPY_ERROR';
  }
};

const run = (folder: string): void => new FileManager(folder).ensureCapyGitignore();

describe('no .gitignore on disk, nothing tracked: created as before', () => {
  test('not a git repo', () => {
    const folder = freshDir();
    run(folder);
    expect(read(join(folder, '.gitignore'))).toBe('\n# Capy\n' + CAPY_ENTRIES.join('\n') + '\n');
  });

  test('git repo, .gitignore untracked and absent', () => {
    const top = freshDir();
    git(top, ['init', '-q', '.']);
    writeFileSync(join(top, 'a.txt'), 'a\n');
    git(top, ['add', '-A']);
    git(top, ['commit', '-q', '-m', 'init']);
    run(top);
    expect(read(join(top, '.gitignore'))).toBe('\n# Capy\n' + CAPY_ENTRIES.join('\n') + '\n');
    expect(gitOut(top, ['status', '--porcelain'])).toBe('?? .gitignore\n');
  });
});

describe('normal checkout, tracked .gitignore on disk', () => {
  test('entries are appended and original lines kept', () => {
    const s = committedRepo('', ORIGINAL);
    const lines = captureStderr(() => run(s.folder));
    expect(lines).toEqual([]);
    expect(read(s.gitignorePath)).toBe(COMPLETE);
    expect(gitOut(s.top, ['diff', '--numstat', '--', '.gitignore'])).toBe('8\t0\t.gitignore\n');
  });
});

describe.each([
  ['top level', ''],
  ['nested folder', 'frontend/app/'],
  ['folder name with glob characters', 'frontend/app[1]/'],
  ['folder name with ! and #', 'a!b#/app*x/'],
])('non-cone sparse checkout, tracked .gitignore off disk (%s)', (_label, sub) => {
  test('index copy lacks the entries: file is added to the checkout, then appended to', () => {
    const s = sparseRepo(sub, ORIGINAL);
    const before = sparseList(s.top);
    const lines = captureStderr(() => run(s.folder));

    expect(lines).toHaveLength(1);
    const content = read(s.gitignorePath);
    expect(content.startsWith(ORIGINAL)).toBe(true);
    expect(content).toBe(COMPLETE);
    expect(content.endsWith(CAPY_ENTRIES.join('\n') + '\n')).toBe(true);

    // git sees only added lines, not a replaced file
    expect(gitOut(s.top, ['diff', '--numstat', '--', sub + '.gitignore'])).toBe(
      `8\t0\t${sub}.gitignore\n`,
    );
    const after = sparseList(s.top);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain(`/${escapeSparsePattern(sub)}.gitignore`);
    expect(git(s.folder, ['check-ignore', '-q', '.env']).status).toBe(0);
  });

  test('index copy already has every entry: nothing is written or changed', () => {
    const s = sparseRepo(sub, COMPLETE);
    const before = sparseList(s.top);
    const lines = captureStderr(() => run(s.folder));

    expect(lines).toEqual([]);
    expect(existsSync(s.gitignorePath)).toBe(false);
    expect(gitOut(s.top, ['status', '--porcelain'])).toBe('');
    expect(sparseList(s.top)).toBe(before);
    // git still applies the ignore rules from the index
    expect(git(s.folder, ['check-ignore', '-q', '.env']).status).toBe(0);
  });
});

describe('calling it twice', () => {
  test('second call after a sparse add is a no-op and prints nothing', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    captureStderr(() => run(s.folder));
    const content = read(s.gitignorePath);
    const list = sparseList(s.top);
    const lines = captureStderr(() => run(s.folder));
    expect(lines).toEqual([]);
    expect(read(s.gitignorePath)).toBe(content);
    expect(sparseList(s.top)).toBe(list);
  });

  test('second call when the index copy is complete is a no-op', () => {
    const s = sparseRepo('frontend/app/', COMPLETE);
    run(s.folder);
    run(s.folder);
    expect(existsSync(s.gitignorePath)).toBe(false);
    expect(gitOut(s.top, ['status', '--porcelain'])).toBe('');
  });
});

describe('tracked .gitignore that cannot be brought into the checkout', () => {
  test('cone mode: throws GITIGNORE_NOT_IN_CHECKOUT and writes nothing', () => {
    const s = committedRepo('frontend/app/', ORIGINAL);
    rmSync(s.gitignorePath);
    git(s.folder, ['update-index', '--skip-worktree', '.gitignore']);
    git(s.top, ['config', 'core.sparseCheckout', 'true']);
    git(s.top, ['config', 'core.sparseCheckoutCone', 'true']);
    const configBefore = read(join(s.top, '.git', 'config'));

    expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);
    expect(codeOf(() => run(s.folder))).toBe('GITIGNORE_NOT_IN_CHECKOUT');
    expect(existsSync(s.gitignorePath)).toBe(false);
    expect(read(join(s.top, '.git', 'config'))).toBe(configBefore);
    expect(gitOut(s.top, ['ls-files', '-t', '--', 'frontend/app/.gitignore'])).toBe(
      'S frontend/app/.gitignore\n',
    );
  });

  test('git refuses to update the index: throws GITIGNORE_NOT_IN_CHECKOUT and writes nothing', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    const lock = join(s.top, '.git', 'index.lock');
    const before = sparseList(s.top);
    writeFileSync(lock, '');
    try {
      expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(existsSync(s.gitignorePath)).toBe(false);
    expect(sparseList(s.top)).toBe(before);
    expect(gitOut(s.top, ['status', '--porcelain'])).toBe('');
  });
});

describe('tracked, deleted locally, not sparse', () => {
  test('index copy lacks the entries: file restored with original lines plus Capy entries', () => {
    const s = committedRepo('frontend/app/', ORIGINAL);
    rmSync(s.gitignorePath);
    const lines = captureStderr(() => run(s.folder));
    expect(lines).toEqual([]);
    expect(read(s.gitignorePath)).toBe(COMPLETE);
    expect(gitOut(s.top, ['diff', '--numstat', '--', 'frontend/app/.gitignore'])).toBe(
      '8\t0\tfrontend/app/.gitignore\n',
    );
  });

  test('index copy already has every entry: nothing is written', () => {
    const s = committedRepo('frontend/app/', COMPLETE);
    rmSync(s.gitignorePath);
    run(s.folder);
    expect(existsSync(s.gitignorePath)).toBe(false);
  });
});

/** True when something (file, directory or symlink, dangling or not) is at `path`. */
const lexists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** `git ls-files -t -s` for every tracked path, one line each. */
const indexState = (top: string): readonly string[] =>
  gitOut(top, ['ls-files', '-t', '-s']).split('\n').filter(Boolean);

const commitAll = (top: string): void => {
  git(top, ['init', '-q', '.']);
  git(top, ['add', '-A']);
  git(top, ['commit', '-q', '-m', 'init']);
};

/** The user puts an unmodified tracked file back on disk. */
const putOnDisk = (top: string, path: string): void => {
  mkdirSync(join(top, path, '..'), { recursive: true });
  writeFileSync(join(top, path), gitOut(top, ['show', `HEAD:${path}`]));
};

describe('sparse add changes nothing but .gitignore', () => {
  test('a clean tracked file the user put back on disk outside the sparse list stays on disk with its index flag', () => {
    const top = freshDir();
    mkdirSync(join(top, 'a'), { recursive: true });
    mkdirSync(join(top, 'b'), { recursive: true });
    writeFileSync(join(top, '.gitignore'), ORIGINAL);
    writeFileSync(join(top, 'keep.lock'), '{}\n');
    writeFileSync(join(top, 'a', 'x.txt'), 'x\n');
    writeFileSync(join(top, 'b', 'y.txt'), 'y\n');
    commitAll(top);
    expect(git(top, ['sparse-checkout', 'set', '--no-cone', '/a/']).status).toBe(0);
    expect(existsSync(join(top, '.gitignore'))).toBe(false);
    putOnDisk(top, 'b/y.txt');
    expect(gitOut(top, ['status', '--porcelain'])).toBe('');
    const before = indexState(top);
    expect(before.some((l) => l.startsWith('H ') && l.endsWith('\tb/y.txt'))).toBe(true);
    const listBefore = sparseList(top);

    captureStderr(() => run(top));

    expect(read(join(top, '.gitignore'))).toBe(COMPLETE);
    expect(read(join(top, 'b', 'y.txt'))).toBe('y\n');
    const changed = indexState(top).filter((line) => !before.includes(line));
    expect(changed).toHaveLength(1);
    expect(changed[0]?.startsWith('H ')).toBe(true);
    expect(changed[0]?.endsWith('\t.gitignore')).toBe(true);
    expect(sparseList(top).startsWith(listBefore)).toBe(true);
  });

  test('a clean tracked file excluded by an earlier pattern stays on disk with its index flag', () => {
    const top = freshDir();
    mkdirSync(join(top, 'app'), { recursive: true });
    mkdirSync(join(top, 'big'), { recursive: true });
    writeFileSync(join(top, 'app', '.gitignore'), ORIGINAL);
    writeFileSync(join(top, 'app', 'keep.lock'), '{}\n');
    writeFileSync(join(top, 'big', 'data'), 'data\n');
    commitAll(top);
    expect(
      git(top, ['sparse-checkout', 'set', '--no-cone', '/*', '!/app/.gitignore', '!/big/']).status,
    ).toBe(0);
    putOnDisk(top, 'big/data');
    expect(gitOut(top, ['status', '--porcelain'])).toBe('');
    const before = indexState(top);
    expect(before.some((l) => l.startsWith('H ') && l.endsWith('\tbig/data'))).toBe(true);

    captureStderr(() => run(join(top, 'app')));

    expect(read(join(top, 'app', '.gitignore'))).toBe(COMPLETE);
    expect(read(join(top, 'big', 'data'))).toBe('data\n');
    const changed = indexState(top).filter((line) => !before.includes(line));
    expect(changed).toHaveLength(1);
    expect(changed[0]?.endsWith('\tapp/.gitignore')).toBe(true);
  });

  test('a stale sparse list (edited by hand, not re-applied) is not re-applied by the add', () => {
    const top = freshDir();
    mkdirSync(join(top, 'app'), { recursive: true });
    mkdirSync(join(top, 'other'), { recursive: true });
    writeFileSync(join(top, 'app', '.gitignore'), ORIGINAL);
    writeFileSync(join(top, 'app', 'keep.lock'), '{}\n');
    writeFileSync(join(top, 'other', 'x'), 'x\n');
    commitAll(top);
    expect(
      git(top, ['sparse-checkout', 'set', '--no-cone', '/*', '!/app/.gitignore', '!/other/']).status,
    ).toBe(0);
    expect(existsSync(join(top, 'other', 'x'))).toBe(false);
    // the user drops the exclusion by hand and has not re-applied yet
    const listFile = join(top, '.git', 'info', 'sparse-checkout');
    writeFileSync(listFile, read(listFile).replace('!/other/\n', ''));
    const before = indexState(top);

    captureStderr(() => run(join(top, 'app')));

    expect(read(join(top, 'app', '.gitignore'))).toBe(COMPLETE);
    expect(existsSync(join(top, 'other', 'x'))).toBe(false);
    const changed = indexState(top).filter((line) => !before.includes(line));
    expect(changed).toHaveLength(1);
    expect(changed[0]?.endsWith('\tapp/.gitignore')).toBe(true);
  });
});

describe('after a sparse add', () => {
  test('a later sparse-checkout reapply keeps the file, and git shows only added lines', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    captureStderr(() => run(s.folder));
    expect(git(s.top, ['sparse-checkout', 'reapply']).status).toBe(0);
    expect(read(s.gitignorePath)).toBe(COMPLETE);
    expect(gitOut(s.top, ['ls-files', '-t', '--', 'frontend/app/.gitignore'])).toBe(
      'H frontend/app/.gitignore\n',
    );
    expect(gitOut(s.top, ['status', '--porcelain'])).toBe(' M frontend/app/.gitignore\n');
  });
});

describe('sparse add that cannot finish leaves nothing behind', () => {
  test.skipIf(process.getuid?.() === 0)('list file cannot be written: file removed again, flag restored', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    const listFile = join(s.top, '.git', 'info', 'sparse-checkout');
    const before = indexState(s.top);
    const listBefore = read(listFile);
    chmodSync(listFile, 0o444);
    try {
      expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);
    } finally {
      chmodSync(listFile, 0o644);
    }
    expect(lexists(s.gitignorePath)).toBe(false);
    expect(read(listFile)).toBe(listBefore);
    expect(indexState(s.top)).toEqual(before);
  });

  test('tracked symlink .gitignore that sparse checkout keeps off disk: refused, nothing written or changed', () => {
    const top = freshDir();
    mkdirSync(join(top, 'app'), { recursive: true });
    mkdirSync(join(top, 'shared'), { recursive: true });
    writeFileSync(join(top, 'shared', 'gitignore'), ORIGINAL);
    symlinkSync('../shared/gitignore', join(top, 'app', '.gitignore'));
    writeFileSync(join(top, 'app', 'keep.lock'), '{}\n');
    commitAll(top);
    expect(
      git(top, ['sparse-checkout', 'set', '--no-cone', '/*', '!/app/.gitignore', '!/shared/']).status,
    ).toBe(0);
    const listBefore = sparseList(top);
    const before = indexState(top);

    expect(codeOf(() => run(join(top, 'app')))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);

    expect(lexists(join(top, 'app', '.gitignore'))).toBe(false);
    expect(sparseList(top)).toBe(listBefore);
    expect(indexState(top)).toEqual(before);
  });

  test('sparse checkout is not enabled but the path is flagged skip-worktree: refused, config untouched', () => {
    const s = committedRepo('frontend/app/', ORIGINAL);
    rmSync(s.gitignorePath);
    git(s.top, ['update-index', '--skip-worktree', 'frontend/app/.gitignore']);
    const configBefore = read(join(s.top, '.git', 'config'));
    expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);
    expect(lexists(s.gitignorePath)).toBe(false);
    expect(read(join(s.top, '.git', 'config'))).toBe(configBefore);
  });
});

describe('restore from git keeps the tracked bytes exactly', () => {
  test('bytes that are not valid UTF-8 are written back unchanged', () => {
    const raw = Buffer.concat([Buffer.from('node_modules/\ncaf'), Buffer.from([0xe9]), Buffer.from('.txt\n')]);
    const s = committedRepo('', 'placeholder\n');
    writeFileSync(s.gitignorePath, raw);
    git(s.top, ['add', '-A']);
    git(s.top, ['commit', '-q', '-m', 'latin1']);
    rmSync(s.gitignorePath);

    run(s.folder);

    const written = readFileSync(s.gitignorePath);
    expect(written.subarray(0, raw.length).equals(raw)).toBe(true);
    expect(written.subarray(raw.length).toString('utf-8')).toBe(
      '\n# Capy\n' + CAPY_ENTRIES.join('\n') + '\n',
    );
    expect(gitOut(s.top, ['diff', '--numstat', '--', '.gitignore'])).toBe('8\t0\t.gitignore\n');
  });

  test('bytes that are not valid UTF-8 survive a sparse add too', () => {
    const raw = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('/\n')]);
    const s = committedRepo('app/', 'placeholder\n');
    writeFileSync(s.gitignorePath, raw);
    git(s.top, ['add', '-A']);
    git(s.top, ['commit', '-q', '-m', 'latin1']);
    expect(git(s.top, ['sparse-checkout', 'set', '--no-cone', '/app/keep.lock']).status).toBe(0);
    captureStderr(() => run(s.folder));
    const written = readFileSync(s.gitignorePath);
    expect(written.subarray(0, raw.length).equals(raw)).toBe(true);
  });

  test('a tracked symlink .gitignore deleted locally is not turned into a regular file', () => {
    const top = freshDir();
    writeFileSync(join(top, 'real'), ORIGINAL);
    symlinkSync('real', join(top, '.gitignore'));
    commitAll(top);
    rmSync(join(top, '.gitignore'));

    expect(codeOf(() => run(top))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);

    expect(lexists(join(top, '.gitignore'))).toBe(false);
    expect(read(join(top, 'real'))).toBe(ORIGINAL);
    expect(gitOut(top, ['status', '--porcelain'])).toBe(' D .gitignore\n');
  });

  test('line endings follow the repo eol attribute, as git would check the file out', () => {
    const top = freshDir();
    writeFileSync(join(top, '.gitattributes'), '.gitignore text eol=crlf\n');
    writeFileSync(join(top, '.gitignore'), ORIGINAL);
    commitAll(top);
    rmSync(join(top, '.gitignore'));
    git(top, ['checkout-index', '-f', '--', '.gitignore']);
    const checkedOut = readFileSync(join(top, '.gitignore'));
    rmSync(join(top, '.gitignore'));

    run(top);

    const written = readFileSync(join(top, '.gitignore'));
    expect(checkedOut.toString('utf-8')).toBe(ORIGINAL.replace(/\n/g, '\r\n'));
    expect(written.subarray(0, checkedOut.length).equals(checkedOut)).toBe(true);
  });
});

describe('escapeSparsePattern', () => {
  test('escapes git pattern syntax characters and leaves spaces alone', () => {
    expect(escapeSparsePattern('a b/c[1]/d*e?f\\g!h#/')).toBe('a b/c\\[1\\]/d\\*e\\?f\\\\g\\!h\\#/');
  });
});

describe.each(['yes', 'on', '1', 'TRUE', 'true'])(
  'cone mode written as core.sparseCheckoutCone=%s',
  (value) => {
    test('throws GITIGNORE_NOT_IN_CHECKOUT, writes nothing, leaves the cone list and config alone', () => {
      const s = committedRepo('app/', ORIGINAL);
      mkdirSync(join(s.top, 'src'), { recursive: true });
      writeFileSync(join(s.top, 'src', 'a.txt'), 'a\n');
      git(s.top, ['add', '-A']);
      git(s.top, ['commit', '-q', '-m', 'src']);
      expect(git(s.top, ['sparse-checkout', 'set', '--cone', 'src']).status).toBe(0);
      expect(git(s.top, ['config', '--worktree', 'core.sparseCheckoutCone', value]).status).toBe(0);
      expect(git(s.top, ['config', '--bool', '--get', 'core.sparseCheckoutCone']).stdout.trim()).toBe('true');
      expect(lexists(s.gitignorePath)).toBe(false);
      // the user made the folder again; its tracked .gitignore is still kept off disk
      mkdirSync(s.folder, { recursive: true });
      const listFile = join(s.top, '.git', 'info', 'sparse-checkout');
      const listBefore = read(listFile);
      const indexBefore = indexState(s.top);
      const configBefore = gitOut(s.top, ['config', '--list', '--show-scope']);

      expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);

      expect(lexists(s.gitignorePath)).toBe(false);
      expect(read(listFile)).toBe(listBefore);
      expect(indexState(s.top)).toEqual(indexBefore);
      expect(gitOut(s.top, ['config', '--list', '--show-scope'])).toBe(configBefore);
      // git still reads the list as a cone list
      const listed = git(s.top, ['sparse-checkout', 'list']);
      expect(listed.status).toBe(0);
      expect(listed.stderr).toBe('');
    });
  },
);

// Runs FileManager.updateGitignore in a child process, so the parent environment is left alone.
const SCRIPT = join(ROOT, 'update-gitignore-child.ts');
writeFileSync(
  SCRIPT,
  `import { FileManager } from ${JSON.stringify(join(__dirname, '..', '..', 'src', 'files', 'fileManager'))};\n` +
    'new FileManager(process.argv[2] ?? "").updateGitignore([".env"]);\n',
);
const runChild = (folder: string, extraEnv: Record<string, string>) =>
  spawnSync(process.execPath, [SCRIPT, folder], { encoding: 'utf-8', env: { ...GIT_ENV, ...extraEnv } });

const NEW_FILE = '\n# Capy\n.env\n';

describe.each([
  ['GIT_DIR', (r: string) => ({ GIT_DIR: join(r, '.git') })],
  ['GIT_DIR and GIT_WORK_TREE', (r: string) => ({ GIT_DIR: join(r, '.git'), GIT_WORK_TREE: r })],
])('%s points at another repository while the folder is not a git folder', (_label, envFor) => {
  test('a tracked .gitignore that sparse checkout keeps off disk in the other repo is left alone', () => {
    const other = sparseRepo('', ORIGINAL);
    const plain = freshDir();
    const listBefore = sparseList(other.top);
    const indexBefore = indexState(other.top);
    const configBefore = read(join(other.top, '.git', 'config'));

    const r = runChild(plain, envFor(other.top));

    expect(r.status).toBe(0);
    expect(read(join(plain, '.gitignore'))).toBe(NEW_FILE);
    expect(sparseList(other.top)).toBe(listBefore);
    expect(indexState(other.top)).toEqual(indexBefore);
    expect(read(join(other.top, '.git', 'config'))).toBe(configBefore);
    expect(gitOut(other.top, ['status', '--porcelain'])).toBe('');
    expect(lexists(other.gitignorePath)).toBe(false);
  });

  test('a tracked .gitignore the other repo lost locally is not copied into the folder', () => {
    const other = committedRepo('', ORIGINAL);
    rmSync(other.gitignorePath);
    const plain = freshDir();

    const r = runChild(plain, envFor(other.top));

    expect(r.status).toBe(0);
    expect(read(join(plain, '.gitignore'))).toBe(NEW_FILE);
    expect(lexists(other.gitignorePath)).toBe(false);
    expect(gitOut(other.top, ['status', '--porcelain'])).toBe(' D .gitignore\n');
  });
});

describe('another process wrote .gitignore between the plan and the apply', () => {
  test('its file, flag and list entry are kept and Capy changes nothing more', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    const plan = planMissingGitignore(s.folder, CAPY_ENTRIES);
    if (plan.kind !== 'sparse-add') throw new Error('expected sparse-add');
    // process A runs the whole update
    captureStderr(() => run(s.folder));
    const fileA = read(s.gitignorePath);
    const listA = sparseList(s.top);
    const indexA = indexState(s.top);

    // process B applies the plan it made before A finished
    const outcome = addToSparseCheckout(s.folder, s.gitignorePath, plan.listPath, plan.pattern);

    expect(outcome).not.toBe('ok');
    expect(outcome).not.toBe('rollback-failed');
    expect(read(s.gitignorePath)).toBe(fileA);
    expect(fileA).toBe(COMPLETE);
    expect(sparseList(s.top)).toBe(listA);
    expect(indexState(s.top)).toEqual(indexA);
    expect(git(s.folder, ['check-ignore', '-q', '.env']).status).toBe(0);
  });

  test('the file appears while git is writing it: the other file is not deleted', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    const plan = planMissingGitignore(s.folder, CAPY_ENTRIES);
    if (plan.kind !== 'sparse-add') throw new Error('expected sparse-add');
    const listBefore = sparseList(s.top);
    // the other process wins the race right before our checkout-index
    const racing: GitRunner = (args, cwd) => {
      if (args[0] === 'checkout-index') writeFileSync(s.gitignorePath, COMPLETE);
      return runGit(args, cwd);
    };

    const outcome = addToSparseCheckout(s.folder, s.gitignorePath, plan.listPath, plan.pattern, racing);

    expect(outcome).not.toBe('ok');
    expect(outcome).not.toBe('rollback-failed');
    expect(read(s.gitignorePath)).toBe(COMPLETE);
    expect(sparseList(s.top)).toBe(listBefore);
    expect(git(s.folder, ['check-ignore', '-q', '.env']).status).toBe(0);
  });

  test('git refuses to write and nothing is on disk: the flag is put back, nothing else changes', () => {
    const s = sparseRepo('frontend/app/', ORIGINAL);
    const plan = planMissingGitignore(s.folder, CAPY_ENTRIES);
    if (plan.kind !== 'sparse-add') throw new Error('expected sparse-add');
    const before = indexState(s.top);
    const listBefore = sparseList(s.top);
    const refusing: GitRunner = (args, cwd) =>
      args[0] === 'checkout-index' ? { stdout: '', stderr: '', code: 1 } : runGit(args, cwd);

    expect(addToSparseCheckout(s.folder, s.gitignorePath, plan.listPath, plan.pattern, refusing)).toBe('git-refused');

    expect(lexists(s.gitignorePath)).toBe(false);
    expect(indexState(s.top)).toEqual(before);
    expect(sparseList(s.top)).toBe(listBefore);
  });
});
