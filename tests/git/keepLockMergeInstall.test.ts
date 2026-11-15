/**
 * Installing the keep.lock merge driver: the clone's own attributes file
 * (`info/attributes`) and its local git config. Idempotent, content-preserving,
 * invisible to the working tree, and never a reason for the calling command to
 * fail.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  KEEP_LOCK_ATTRIBUTES_LINE,
  KEEP_LOCK_MERGE_CONFLICT_EXIT,
  installKeepLockMergeDriver,
  keepLockMergeDriverCommand,
  keepLockMergeMapping,
} from '../../src/git/keepLockMergeInstall';
import { hasOtherChanges } from '../../src/deploy/git';
import { FileManager } from '../../src/files/fileManager';
import { git, makeRepo, makeRoot } from '../helpers/keepLockGit';

const ROOT = makeRoot('capy-keep-merge-install-');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const DRIVER_KEY = 'merge.capy-keep-lock.driver';
const configValues = (repo: string): readonly string[] =>
  git(repo, ['config', '--local', '--get-all', DRIVER_KEY]).stdout.split('\n').filter((l) => l !== '');
const infoFile = (repo: string): string => join(repo, '.git', 'info', 'attributes');
const status = (repo: string): string => git(repo, ['status', '--porcelain']).stdout;

const commitAll = (repo: string): void => {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'c']);
};

describe('installKeepLockMergeDriver', () => {
  test('in a fresh repo: the mapping goes in the clone\'s info/attributes and the driver in local config', () => {
    const repo = makeRepo(ROOT, 'fresh');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'added', config: 'set' });
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
    expect(configValues(repo)).toEqual([keepLockMergeDriverCommand()]);
  });

  test('never creates or edits .gitattributes', () => {
    const fresh = makeRepo(ROOT, 'no-gitattributes');
    installKeepLockMergeDriver(fresh);
    expect(existsSync(join(fresh, '.gitattributes'))).toBe(false);
    const withFile = makeRepo(ROOT, 'keeps-gitattributes');
    writeFileSync(join(withFile, '.gitattributes'), '*.png binary\n');
    installKeepLockMergeDriver(withFile);
    expect(readFileSync(join(withFile, '.gitattributes'), 'utf-8')).toBe('*.png binary\n');
  });

  test('changes nothing in the working tree: git status is the same, and the deploy flow\'s hasOtherChanges stays false', () => {
    const repo = makeRepo(ROOT, 'clean-tree');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    writeFileSync(join(repo, 'keep.lock'), '{}\n');
    commitAll(repo);
    expect(status(repo)).toBe('');
    expect(hasOtherChanges(repo)).toBe(false);
    expect(installKeepLockMergeDriver(repo).installed).toBe(true);
    expect(status(repo)).toBe('');
    expect(hasOtherChanges(repo)).toBe(false);
    expect(installKeepLockMergeDriver(repo).installed).toBe(true);
    expect(status(repo)).toBe('');
  });

  test('leaves a tree that already has other changes exactly as it was', () => {
    const repo = makeRepo(ROOT, 'dirty-tree');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    commitAll(repo);
    writeFileSync(join(repo, 'notes.txt'), 'wip\n');
    const before = status(repo);
    installKeepLockMergeDriver(repo);
    expect(status(repo)).toBe(before);
  });

  test('is idempotent: a second and third call change no byte', () => {
    const repo = makeRepo(ROOT, 'idempotent');
    installKeepLockMergeDriver(repo);
    const attributes = readFileSync(infoFile(repo), 'utf-8');
    const config = readFileSync(join(repo, '.git', 'config'), 'utf-8');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'present' });
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'present' });
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(attributes);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf-8')).toBe(config);
    expect(configValues(repo)).toHaveLength(1);
  });

  test('preserves existing info/attributes content and line order, adding the line at the end', () => {
    const repo = makeRepo(ROOT, 'preserve');
    const existing = '# mine\n*.png binary\n\n*.md text eol=lf\n';
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(infoFile(repo), existing);
    installKeepLockMergeDriver(repo);
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`${existing}${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
  });

  test('an existing file with no trailing newline gets one before the new line, and loses nothing', () => {
    const repo = makeRepo(ROOT, 'no-newline');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(infoFile(repo), '*.png binary');
    installKeepLockMergeDriver(repo);
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`*.png binary\n${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
  });

  test('creates info/ when the repo has none', () => {
    const repo = makeRepo(ROOT, 'no-info-dir');
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true });
    expect(installKeepLockMergeDriver(repo).installed).toBe(true);
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
  });

  test('adds nothing when the mapping is already in info/attributes, wherever it sits', () => {
    const repo = makeRepo(ROOT, 'already');
    const existing = `*.png binary\n${KEEP_LOCK_ATTRIBUTES_LINE}\n*.md text\n`;
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(infoFile(repo), existing);
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'set' });
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(existing);
  });

  test('a mapping of ours already committed in .gitattributes is enough: info/attributes is not written', () => {
    const repo = makeRepo(ROOT, 'tracked-ours');
    writeFileSync(join(repo, '.gitattributes'), `${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'set' });
    expect(existsSync(infoFile(repo)) ? readFileSync(infoFile(repo), 'utf-8') : '').not.toContain('keep.lock');
    expect(configValues(repo)).toHaveLength(1);
  });

  test('a keep.lock already mapped to another merge setting in a tracked .gitattributes is the owner\'s choice: everything left alone', () => {
    const repo = makeRepo(ROOT, 'foreign-tracked');
    writeFileSync(join(repo, '.gitattributes'), 'keep.lock merge=union\n');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: false, code: 'FOREIGN_MERGE_ATTRIBUTE' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe('keep.lock merge=union\n');
    expect(existsSync(infoFile(repo)) ? readFileSync(infoFile(repo), 'utf-8') : '').not.toContain('keep.lock');
    expect(configValues(repo)).toEqual([]);
  });

  test('a keep.lock already mapped to another merge setting in info/attributes: everything left alone', () => {
    const repo = makeRepo(ROOT, 'foreign-info');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(infoFile(repo), 'keep.lock -merge\n');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: false, code: 'FOREIGN_MERGE_ATTRIBUTE' });
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe('keep.lock -merge\n');
    expect(configValues(repo)).toEqual([]);
  });

  test('an installed driver of ours is not rewritten: a repo used with two binary names does not flip between them', () => {
    const repo = makeRepo(ROOT, 'two-binaries');
    const staging = keepLockMergeDriverCommand('capy-staging');
    git(repo, ['config', '--local', DRIVER_KEY, staging]);
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'added', config: 'present' });
    expect(configValues(repo)).toEqual([staging]);
    expect(installKeepLockMergeDriver(repo).installed).toBe(true);
    expect(configValues(repo)).toEqual([staging]);
  });

  test('a driver config that is not one of ours is replaced, once, not duplicated', () => {
    const repo = makeRepo(ROOT, 'stale-config');
    git(repo, ['config', '--local', DRIVER_KEY, 'old-command %A']);
    installKeepLockMergeDriver(repo);
    expect(configValues(repo)).toEqual([keepLockMergeDriverCommand()]);
  });

  test('called from a subdirectory: one mapping for the whole clone', () => {
    const repo = makeRepo(ROOT, 'subdir');
    const sub = join(repo, 'apps', 'web');
    mkdirSync(sub, { recursive: true });
    expect(installKeepLockMergeDriver(sub).installed).toBe(true);
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
    expect(existsSync(join(sub, '.gitattributes'))).toBe(false);
  });

  test('outside a git repo: does nothing and writes nothing', () => {
    const dir = join(ROOT, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    expect(installKeepLockMergeDriver(dir)).toEqual({ installed: false, code: 'NOT_A_GIT_REPO' });
    expect(existsSync(join(dir, '.gitattributes'))).toBe(false);
  });

  test('a directory that does not exist is not a repo either, and does not throw', () => {
    expect(installKeepLockMergeDriver(join(ROOT, 'missing-dir'))).toEqual({ installed: false, code: 'NOT_A_GIT_REPO' });
  });

  test('a failure while installing is reported, never thrown', () => {
    const repo = makeRepo(ROOT, 'broken');
    // info/attributes is a directory: it cannot be read as the file or appended to.
    mkdirSync(infoFile(repo), { recursive: true });
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: false, code: 'INSTALL_FAILED' });
  });
});

describe('keepLockMergeMapping', () => {
  test('reads the effective merge setting for keep.lock lines only', () => {
    expect(keepLockMergeMapping('')).toBe('none');
    expect(keepLockMergeMapping('*.lock merge=union\n')).toBe('none');
    expect(keepLockMergeMapping('# keep.lock merge=capy-keep-lock\n')).toBe('none');
    expect(keepLockMergeMapping('keep.lock text\n')).toBe('none');
    expect(keepLockMergeMapping('keep.lock merge=capy-keep-lock\n')).toBe('ours');
    expect(keepLockMergeMapping('keep.lock   text   merge=capy-keep-lock\r\n')).toBe('ours');
    expect(keepLockMergeMapping('keep.lock merge=union\n')).toBe('foreign');
    expect(keepLockMergeMapping('keep.lock -merge\n')).toBe('foreign');
  });

  test('the last setting wins, as in git', () => {
    expect(keepLockMergeMapping('keep.lock merge=union\nkeep.lock merge=capy-keep-lock\n')).toBe('ours');
    expect(keepLockMergeMapping('keep.lock merge=capy-keep-lock\nkeep.lock merge=union\n')).toBe('foreign');
  });
});

describe('keepLockMergeDriverCommand', () => {
  test('runs this CLI\'s binary with the hidden command and git\'s placeholders, then falls back to git\'s own merge', () => {
    const line = keepLockMergeDriverCommand(undefined);
    expect(line.startsWith('capy merge-keep-lock %O %A %B %X %S %Y %L; ')).toBe(true);
    expect(line).toContain(`[ $s -eq ${KEEP_LOCK_MERGE_CONFLICT_EXIT} ] && exit ${KEEP_LOCK_MERGE_CONFLICT_EXIT}`);
    expect(line).toContain('git merge-file -L %X -L %S -L %Y --marker-size=%L %A %O %B');
    expect(keepLockMergeDriverCommand('capy-staging').startsWith('capy-staging merge-keep-lock ')).toBe(true);
  });

  test('a binary name that is not plainly a name is never put into a shell command', () => {
    expect(keepLockMergeDriverCommand('capy; rm -rf /').startsWith('capy merge-keep-lock ')).toBe(true);
    expect(keepLockMergeDriverCommand('').startsWith('capy merge-keep-lock ')).toBe(true);
  });
});

describe('the commands that write keep.lock', () => {
  const keepFile = {
    version: '3.0',
    org_id: 'org',
    project_id: 'proj',
    project_name: 'proj-name',
    variables: { ALPHA: [{ resource_id: 'abcde', branch: 'prod', value_hash: 'h1' }] },
  };

  test('writeKeepFile in a git repo installs the driver, without creating .gitattributes', () => {
    const repo = makeRepo(ROOT, 'write-installs');
    new FileManager(repo).writeKeepFile(keepFile);
    expect(existsSync(join(repo, 'keep.lock'))).toBe(true);
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(`${KEEP_LOCK_ATTRIBUTES_LINE}\n`);
    expect(existsSync(join(repo, '.gitattributes'))).toBe(false);
    expect(configValues(repo)).toEqual([keepLockMergeDriverCommand()]);
  });

  test('writeKeepFile adds no untracked file of its own beyond keep.lock and .capy/', () => {
    const repo = makeRepo(ROOT, 'write-status');
    new FileManager(repo).writeKeepFile(keepFile);
    const untracked = status(repo).split('\n').filter((l) => l !== '');
    expect(untracked.toSorted()).toEqual(['?? .capy/', '?? keep.lock']);
  });

  test('writeKeepFile outside a git repo writes keep.lock exactly as before and nothing else', () => {
    const dir = join(ROOT, 'write-no-repo');
    mkdirSync(dir, { recursive: true });
    new FileManager(dir).writeKeepFile(keepFile);
    expect(existsSync(join(dir, 'keep.lock'))).toBe(true);
    expect(existsSync(join(dir, '.capy', 'keep.lock'))).toBe(true);
    expect(existsSync(join(dir, '.gitattributes'))).toBe(false);
  });

  test('an install that fails does not fail writeKeepFile: both keep.lock copies are written as usual', () => {
    const repo = makeRepo(ROOT, 'write-install-fails');
    mkdirSync(infoFile(repo), { recursive: true });
    expect(() => new FileManager(repo).writeKeepFile(keepFile)).not.toThrow();
    expect(existsSync(join(repo, 'keep.lock'))).toBe(true);
    expect(readFileSync(join(repo, '.capy', 'keep.lock'), 'utf-8')).toBe(readFileSync(join(repo, 'keep.lock'), 'utf-8'));
  });

  test('writeKeepFile twice leaves the install unchanged', () => {
    const repo = makeRepo(ROOT, 'write-twice');
    const fm = new FileManager(repo);
    fm.writeKeepFile(keepFile);
    const attributes = readFileSync(infoFile(repo), 'utf-8');
    fm.writeKeepFile({ ...keepFile, project_name: 'renamed' });
    expect(readFileSync(infoFile(repo), 'utf-8')).toBe(attributes);
    expect(configValues(repo)).toHaveLength(1);
  });
});
