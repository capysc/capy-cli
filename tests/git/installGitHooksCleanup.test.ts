/** Isolated mocks: exercises installer cleanup without running Git or file I/O. */
import { afterEach, expect, mock, test } from 'bun:test';
import { CAPY_HOOK_START as start, CAPY_HOOK_END as end } from '../../src/git/planHookCleanup';

const root = '/synthetic-capy-hook-fixture/.git/hooks';
const prePush = `${root}/pre-push`;
const read = mock((_path: string) => '');
const write = mock((_path: string, _content: string, _encoding: string) => undefined);
const mkdir = mock(() => undefined);
const chmod = mock(() => undefined);
mock.module('child_process', () => ({ execSync: mock(() => '/synthetic-capy-hook-fixture/.git\n') }));
mock.module('fs', () => ({ existsSync: (path: string) => path === root || path === prePush,
  readFileSync: read, writeFileSync: write, mkdirSync: mkdir, chmodSync: chmod }));
import { installGitHooks } from '../../src/git/installGitHooks';

afterEach(() => {
  for (const fn of [read, write, mkdir, chmod]) fn.mockClear();
  read.mockImplementation(() => '');
});

test('installer removes every retired pre-push Capy block while preserving user bytes', () => {
  const block = `${start}\ncapy status\n${end}\n`;
  read.mockImplementation(() => `#!/bin/sh\n\n${block}  echo keep  \n${block}echo tail`);
  installGitHooks(true);
  expect(write.mock.calls.filter(([path]) => path === prePush)).toEqual([[prePush, '#!/bin/sh\n\n  echo keep  \necho tail', 'utf-8']]);
  expect(chmod.mock.calls).toHaveLength(2); // Only the newly installed post hooks.
  expect(mkdir).not.toHaveBeenCalled();
});

for (const content of [start, `${start}\n${start}\n${end}\n`, `echo '${start}'\necho '${end}'\n`]) {
  test('installer does not rewrite ambiguous or unowned pre-push content', () => {
    read.mockImplementation(() => content);
    installGitHooks(true);
    expect(write.mock.calls.filter(([path]) => path === prePush)).toEqual([]);
  });
}
