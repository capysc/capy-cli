import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { FileManager } from '../../src/files/fileManager';
import { escapeSparsePattern } from '../../src/files/trackedGitignore';
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

  test.skipIf(process.getuid?.() === 0)(
    'git sparse-checkout add fails: throws GITIGNORE_NOT_IN_CHECKOUT and writes nothing',
    () => {
      const s = sparseRepo('frontend/app/', ORIGINAL);
      const infoDir = join(s.top, '.git', 'info');
      const before = sparseList(s.top);
      chmodSync(infoDir, 0o555);
      try {
        expect(codeOf(() => run(s.folder))).toBe(ERROR_CODES.GITIGNORE_NOT_IN_CHECKOUT);
      } finally {
        chmodSync(infoDir, 0o755);
      }
      expect(existsSync(s.gitignorePath)).toBe(false);
      expect(sparseList(s.top)).toBe(before);
      expect(gitOut(s.top, ['status', '--porcelain'])).toBe('');
    },
  );
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

describe('escapeSparsePattern', () => {
  test('escapes git pattern syntax characters and leaves spaces alone', () => {
    expect(escapeSparsePattern('a b/c[1]/d*e?f\\g!h#/')).toBe('a b/c\\[1\\]/d\\*e\\?f\\\\g\\!h\\#/');
  });
});
