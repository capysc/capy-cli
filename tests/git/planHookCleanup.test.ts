import { expect, test } from 'bun:test';
import { CAPY_HOOK_START as start, CAPY_HOOK_END as end, planHookCleanup } from '../../src/git/planHookCleanup';

const block = `${start}\ncapy status\n${end}\n`;

test('preserves unrelated hook bytes, blank lines, indentation and missing final newline', () => {
  const before = '#!/bin/sh\n\n  echo before\n';
  const after = '\n  echo after  ';
  expect(planHookCleanup(before + block + after)).toEqual({ kind: 'changed', content: before + after, removedBlocks: 1 });
});

test('removes all complete Capy blocks, not just the first', () => {
  expect(planHookCleanup(block + 'echo keep\n' + block)).toEqual({ kind: 'changed', content: 'echo keep\n', removedBlocks: 2 });
});

test('preserves CRLF bytes outside the removed block', () => {
  expect(planHookCleanup(`#!/bin/sh\r\n${start}\r\ncapy status\r\n${end}\r\necho keep\r\n`))
    .toEqual({ kind: 'changed', content: '#!/bin/sh\r\necho keep\r\n', removedBlocks: 1 });
});

test('a hook containing only Capy code has an empty replacement, not a deletion instruction', () => {
  expect(planHookCleanup(block)).toEqual({ kind: 'changed', content: '', removedBlocks: 1 });
});

for (const content of [start, end, `${start}\n${start}\n${end}\n`, `${block}${start}\n`, `${end}\n${start}\n`]) {
  test('malformed ownership boundaries refuse the entire edit', () => {
    expect(planHookCleanup(content)).toEqual({ kind: 'invalid', reason: 'unbalanced-markers' });
  });
}

test('embedded marker text is not an owned block', () => {
  expect(planHookCleanup(`echo '${start}'\necho '${end}'\n`)).toEqual({ kind: 'unchanged' });
});

test('cleaning an already-cleaned hook is a no-op', () => {
  const result = planHookCleanup(`#!/bin/sh\n${block}echo keep\n`);
  expect(result.kind).toBe('changed');
  if (result.kind !== 'changed') throw new Error('EXPECTED_CHANGED');
  expect(planHookCleanup(result.content)).toEqual({ kind: 'unchanged' });
});
