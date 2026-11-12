/**
 * Installing the keep.lock merge driver: `.gitattributes` and the clone's local
 * git config, idempotent, content-preserving, and never a reason for the
 * calling command to fail.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  KEEP_LOCK_GITATTRIBUTES_LINE,
  installKeepLockMergeDriver,
  keepLockMergeDriverCommand,
  keepLockMergeMapping,
} from '../../src/git/keepLockMergeInstall';
import { FileManager } from '../../src/files/fileManager';import { git, makeRepo, makeRoot } from '../helpers/keepLockGit';

const ROOT = makeRoot('capy-keep-merge-install-');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const configValues = (repo: string): readonly string[] =>
  git(repo, ['config', '--local', '--get-all', 'merge.capy-keep-lock.driver']).stdout.split('\n').filter((l) => l !== '');

describe('installKeepLockMergeDriver', () => {
  test('in a fresh repo: adds the mapping line and sets the driver in local config', () => {
    const repo = makeRepo(ROOT, 'fresh');
    const result = installKeepLockMergeDriver(repo);
    expect(result).toEqual({ installed: true, attributes: 'added', config: 'set' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(`${KEEP_LOCK_GITATTRIBUTES_LINE}\n`);
    expect(configValues(repo)).toEqual(['capy merge-keep-lock %O %A %B']);
  });

  test('is idempotent: a second and third call change nothing', () => {
    const repo = makeRepo(ROOT, 'idempotent');
    installKeepLockMergeDriver(repo);
    const attributes = readFileSync(join(repo, '.gitattributes'), 'utf-8');
    const config = readFileSync(join(repo, '.git', 'config'), 'utf-8');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'present' });
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: true, attributes: 'present', config: 'present' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(attributes);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf-8')).toBe(config);
    expect(configValues(repo)).toHaveLength(1);
  });

  test('preserves existing .gitattributes content and line order, adding the line at the end', () => {
    const repo = makeRepo(ROOT, 'preserve');
    const existing = '# attributes\n*.png binary\n\n*.md text eol=lf\n';
    writeFileSync(join(repo, '.gitattributes'), existing);
    installKeepLockMergeDriver(repo);
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(`${existing}${KEEP_LOCK_GITATTRIBUTES_LINE}\n`);
  });

  test('an existing file with no trailing newline gets one before the new line, and loses nothing', () => {
    const repo = makeRepo(ROOT, 'no-newline');
    writeFileSync(join(repo, '.gitattributes'), '*.png binary');
    installKeepLockMergeDriver(repo);
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(`*.png binary\n${KEEP_LOCK_GITATTRIBUTES_LINE}\n`);
  });

  test('adds nothing when the mapping is already there, wherever it sits in the file', () => {
    const repo = makeRepo(ROOT, 'already');
    const existing = `*.png binary\n${KEEP_LOCK_GITATTRIBUTES_LINE}\n*.md text\n`;
    writeFileSync(join(repo, '.gitattributes'), existing);
    const result = installKeepLockMergeDriver(repo);
    expect(result).toEqual({ installed: true, attributes: 'present', config: 'set' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(existing);
  });

  test('config that points somewhere else is corrected, not duplicated', () => {
    const repo = makeRepo(ROOT, 'stale-config');
    git(repo, ['config', '--local', 'merge.capy-keep-lock.driver', 'old-command %A']);
    installKeepLockMergeDriver(repo);
    expect(configValues(repo)).toEqual(['capy merge-keep-lock %O %A %B']);
  });

  test('a keep.lock already mapped to another merge setting is the owner\'s choice: left alone, nothing written', () => {
    const repo = makeRepo(ROOT, 'foreign');
    writeFileSync(join(repo, '.gitattributes'), 'keep.lock merge=union\n');
    expect(installKeepLockMergeDriver(repo)).toEqual({ installed: false, code: 'FOREIGN_MERGE_ATTRIBUTE' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe('keep.lock merge=union\n');
    expect(configValues(repo)).toEqual([]);
  });

  test('called from a subdirectory: the mapping goes to the repo root', () => {
    const repo = makeRepo(ROOT, 'subdir');
    const sub = join(repo, 'apps', 'web');
    mkdirSync(sub, { recursive: true });
    expect(installKeepLockMergeDriver(sub).installed).toBe(true);
    expect(existsSync(join(repo, '.gitattributes'))).toBe(true);
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
    // `.gitattributes` is a directory: it cannot be read as the file or appended to.
    mkdirSync(join(repo, '.gitattributes'));
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
  test('is this CLI\'s binary name, the hidden command and git\'s three placeholders', () => {
    expect(keepLockMergeDriverCommand(undefined)).toBe('capy merge-keep-lock %O %A %B');
    expect(keepLockMergeDriverCommand('capy-staging')).toBe('capy-staging merge-keep-lock %O %A %B');
  });

  test('a binary name that is not plainly a name is never put into a shell command', () => {
    expect(keepLockMergeDriverCommand('capy; rm -rf /')).toBe('capy merge-keep-lock %O %A %B');
    expect(keepLockMergeDriverCommand('')).toBe('capy merge-keep-lock %O %A %B');
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

  test('writeKeepFile in a git repo installs the driver', () => {
    const repo = makeRepo(ROOT, 'write-installs');
    new FileManager(repo).writeKeepFile(keepFile);
    expect(existsSync(join(repo, 'keep.lock'))).toBe(true);
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(`${KEEP_LOCK_GITATTRIBUTES_LINE}\n`);
    expect(configValues(repo)).toEqual(['capy merge-keep-lock %O %A %B']);
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
    mkdirSync(join(repo, '.gitattributes'));
    expect(() => new FileManager(repo).writeKeepFile(keepFile)).not.toThrow();
    expect(existsSync(join(repo, 'keep.lock'))).toBe(true);
    expect(readFileSync(join(repo, '.capy', 'keep.lock'), 'utf-8')).toBe(readFileSync(join(repo, 'keep.lock'), 'utf-8'));
  });

  test('writeKeepFile twice leaves the install unchanged', () => {
    const repo = makeRepo(ROOT, 'write-twice');
    const fm = new FileManager(repo);
    fm.writeKeepFile(keepFile);
    const attributes = readFileSync(join(repo, '.gitattributes'), 'utf-8');
    fm.writeKeepFile({ ...keepFile, project_name: 'renamed' });
    expect(readFileSync(join(repo, '.gitattributes'), 'utf-8')).toBe(attributes);
    expect(configValues(repo)).toHaveLength(1);
  });
});
