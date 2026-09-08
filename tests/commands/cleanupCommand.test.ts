/** Isolated module mocks: no real Git commands, file writes, prompts or auth. */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { CAPY_HOOK_START as start, CAPY_HOOK_END as end } from '../../src/git/planHookCleanup';

const directory = '/synthetic-cleanup/.git';
const names = ['post-checkout', 'post-merge', 'pre-push'] as const;
const block = `${start}\ncapy status\n${end}\n`;
const regular = { dev: 1, ino: 2, nlink: 1, isFile: () => true, isDirectory: () => false };
const exec = mock(() => `${directory}\n`);
const lstat = mock((_path: string): typeof regular => regular);
const opened = mock((_path: string, _flags: number): number => 10);
const fstat = mock((_fd: number) => regular);
const read = mock((_fd: number): Buffer => Buffer.from(block));
const write = mock((_fd: number, _data: Buffer, _offset: number, length: number, _position: number) => length);
const truncate = mock((_fd: number, _size: number) => undefined);
const close = mock((_fd: number) => undefined);
mock.module('child_process', () => ({ execFileSync: exec }));
mock.module('fs', () => ({ constants: { O_RDONLY: 0, O_RDWR: 2, O_NOFOLLOW: 256 },
  lstatSync: lstat, openSync: opened, fstatSync: fstat, readFileSync: read,
  writeSync: write, ftruncateSync: truncate, closeSync: close }));
import { cleanupGitHooks } from '../../src/commands/cleanupCommand';

function configure(contents: Readonly<Partial<Record<typeof names[number], string>>>): void {
  exec.mockImplementation(() => `${directory}\n`);
  lstat.mockImplementation((path) => {
    if (path === `${directory}/hooks`) return { ...regular, isDirectory: () => true };
    const name = names.find((item) => path === `${directory}/hooks/${item}`);
    if (!name || contents[name] === undefined) throw { code: 'ENOENT' };
    return regular;
  });
  opened.mockImplementation((path) => 10 + names.findIndex((name) => path.endsWith(`/${name}`)));
  read.mockImplementation((fd) => Buffer.from(contents[names[fd - 10]!] ?? ''));
  fstat.mockImplementation(() => regular);
  write.mockImplementation((_fd, _data, _offset, length) => length);
}

beforeEach(() => configure({}));
afterEach(() => { for (const fn of [exec, lstat, opened, fstat, read, write, truncate, close]) fn.mockReset(); });

test('cleans all owned blocks without trimming user content or deleting empty files', () => {
  configure({ 'post-checkout': `#!/bin/sh\n\n${block} echo keep  \n${block}tail`, 'pre-push': block });
  expect(cleanupGitHooks()).toMatchObject({ ok: true, code: 'CLEANUP_DONE', changedHooks: ['post-checkout', 'pre-push'] });
  expect(write.mock.calls.map(([fd, data, offset, length, position]) => [fd, data.toString(), offset, length, position]))
    .toEqual([[10, '#!/bin/sh\n\n echo keep  \ntail', 0, 28, 0]]);
  expect(truncate.mock.calls).toEqual([[10, 28], [12, 0]]);
  expect(close).toHaveBeenCalledTimes(4);
});

test('unchanged repository is an idempotent success', () => {
  configure({ 'post-merge': '#!/bin/sh\necho unchanged' });
  expect(cleanupGitHooks()).toMatchObject({ ok: true, code: 'CLEANUP_UNCHANGED', changedHooks: [] });
  expect(write).not.toHaveBeenCalled();
  expect(truncate).not.toHaveBeenCalled();
});

test('cleans all three supported hook types', () => {
  configure({ 'post-checkout': block, 'post-merge': block, 'pre-push': block });
  expect(cleanupGitHooks()).toMatchObject({ ok: true, changedHooks: names });
  expect(truncate.mock.calls).toEqual([[10, 0], [11, 0], [12, 0]]);
});

test('later malformed hook refuses the entire preflight before earlier writes', () => {
  configure({ 'post-checkout': block, 'pre-push': start });
  expect(cleanupGitHooks()).toMatchObject({ ok: false, code: 'CLEANUP_REFUSED', changedHooks: [] });
  expect(truncate).not.toHaveBeenCalled();
});

test('shared worktree refuses without inspecting or changing hooks', () => {
  exec.mockImplementationOnce(() => `${directory}/worktrees/one`).mockImplementationOnce(() => directory);
  expect(cleanupGitHooks().code).toBe('CLEANUP_REFUSED');
  expect(lstat).not.toHaveBeenCalled();
});

test('missing Git repository is a closed failure', () => {
  exec.mockImplementation(() => { throw new Error('private diagnostic must not leak'); });
  const result = cleanupGitHooks();
  expect(result.code).toBe('CLEANUP_REFUSED');
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
  expect(opened).not.toHaveBeenCalled();
});

for (const unsafe of [{ ...regular, isFile: () => false }, { ...regular, nlink: 2 }]) {
  test('symlink or shared inode refuses before opening', () => {
    configure({ 'pre-push': block });
    lstat.mockImplementation((path) => path === `${directory}/hooks` ? { ...regular, isDirectory: () => true } : unsafe);
    expect(cleanupGitHooks().code).toBe('CLEANUP_REFUSED');
    expect(opened).not.toHaveBeenCalled();
  });
}

test('symlinked hooks directory is not followed', () => {
  lstat.mockImplementation(() => regular);
  expect(cleanupGitHooks().code).toBe('CLEANUP_REFUSED');
  expect(opened).not.toHaveBeenCalled();
});

test('changed content is refused on the write descriptor', () => {
  configure({ 'pre-push': block });
  read.mockImplementationOnce(() => Buffer.from(block)).mockImplementationOnce(() => Buffer.from('new owner hook'));
  expect(cleanupGitHooks().code).toBe('CLEANUP_FAILED');
  expect(truncate).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(2);
});

test('changed inode is refused before reading or writing replacement', () => {
  configure({ 'pre-push': block });
  fstat.mockImplementationOnce(() => regular).mockImplementationOnce(() => ({ ...regular, ino: 999 }));
  expect(cleanupGitHooks().code).toBe('CLEANUP_FAILED');
  expect(read).toHaveBeenCalledTimes(1);
  expect(truncate).not.toHaveBeenCalled();
});

test('invalid UTF-8 is refused without replacing unowned bytes', () => {
  configure({ 'pre-push': block });
  read.mockImplementation(() => Buffer.from([0xff]));
  expect(cleanupGitHooks().code).toBe('CLEANUP_REFUSED');
  expect(truncate).not.toHaveBeenCalled();
});

test('short writes continue at the explicit file offset', () => {
  configure({ 'pre-push': `${block}tail` });
  write.mockImplementationOnce(() => 2).mockImplementationOnce(() => 2);
  expect(cleanupGitHooks().code).toBe('CLEANUP_DONE');
  expect(write.mock.calls.map(([fd, _data, offset, length, position]) => [fd, offset, length, position]))
    .toEqual([[12, 0, 4, 0], [12, 2, 2, 2]]);
  expect(truncate.mock.calls).toEqual([[12, 4]]);
});

test('write failure reports completed hooks and does not claim atomic rollback', () => {
  configure({ 'post-checkout': block, 'pre-push': `${block}tail` });
  write.mockImplementation(() => { throw new Error('disk full'); });
  expect(cleanupGitHooks()).toMatchObject({ ok: false, code: 'CLEANUP_FAILED', changedHooks: ['post-checkout'] });
  expect(truncate.mock.calls).toEqual([[10, 0]]);
});
