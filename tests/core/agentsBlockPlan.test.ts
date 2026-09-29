/**
 * Pure marker-text logic for `capy agents` (CAP-681). No filesystem here —
 * see tests/commands/agentsCommand.test.ts for the file-writing behavior
 * built on top of these functions.
 */
import { describe, test, expect } from 'bun:test';
import { ERROR_CODES } from '../../src/types/index';
import {
  AGENTS_BLOCK,
  AGENTS_BLOCK_BEGIN,
  AGENTS_BLOCK_END,
  blockForNewline,
  classifyMarkers,
  detectNewline,
  hasCurrentBlock,
  removeAgentsBlock,
  upsertAgentsBlock,
} from '../../src/core/agentsBlockPlan';

/** Unwraps an `{ok: true, ...}` result, failing the test with a readable message if it's a refusal. */
function unwrapOk<T extends { ok: boolean }>(result: T): Exclude<T, { ok: false }> {
  if (!result.ok) throw new Error(`expected ok:true, got refusal: ${JSON.stringify(result)}`);
  return result as Exclude<T, { ok: false }>;
}

describe('AGENTS_BLOCK', () => {
  test('is the exact verbatim block from the spec', () => {
    expect(AGENTS_BLOCK).toBe(
      [
        '<!-- capy:agents:begin -->',
        '## Secrets (Capy)',
        "This repo's secrets are managed by Capy.",
        '- Run `capy help --json` for every command, its options, and its error codes.',
        '- Always pass `--json` and branch on the `code` field, never on message text.',
        '- Never print, log, or commit secret values.',
        '<!-- capy:agents:end -->',
      ].join('\n'),
    );
  });
});

describe('detectNewline (majority vote, ties default to LF)', () => {
  test('LF-only content is LF', () => {
    expect(detectNewline('a\nb\n')).toBe('\n');
  });
  test('CRLF-only content is CRLF', () => {
    expect(detectNewline('a\r\nb\r\n')).toBe('\r\n');
  });
  test('a single stray CRLF pasted into an otherwise-LF file does NOT flip the whole file to CRLF', () => {
    // 4 lone-LF newlines vs 1 CRLF: LF wins the majority.
    expect(detectNewline('a\nb\nc\nd\ne\r\n')).toBe('\n');
  });
  test('more CRLF lines than lone-LF lines: CRLF wins', () => {
    expect(detectNewline('a\r\nb\r\nc\r\nd\n')).toBe('\r\n');
  });
  test('a tie defaults to LF', () => {
    expect(detectNewline('a\r\nb\n')).toBe('\n');
  });
  test('empty content defaults to LF', () => {
    expect(detectNewline('')).toBe('\n');
  });
});

describe('classifyMarkers', () => {
  test('absent: no markers at all', () => {
    expect(classifyMarkers('# hello\n')).toEqual({ kind: 'absent' });
  });
  test('present: exactly one begin and one end, in order', () => {
    const content = `before\n${AGENTS_BLOCK}\nafter\n`;
    expect(classifyMarkers(content).kind).toBe('present');
  });
  test('malformed: begin without end', () => {
    expect(classifyMarkers(`x\n${AGENTS_BLOCK_BEGIN}\ny\n`).kind).toBe('malformed');
  });
  test('malformed: end without begin', () => {
    expect(classifyMarkers(`x\n${AGENTS_BLOCK_END}\ny\n`).kind).toBe('malformed');
  });
  test('malformed: duplicated begin', () => {
    const content = `${AGENTS_BLOCK_BEGIN}\n${AGENTS_BLOCK_BEGIN}\n${AGENTS_BLOCK_END}\n`;
    expect(classifyMarkers(content).kind).toBe('malformed');
  });
  test('malformed: duplicated end', () => {
    const content = `${AGENTS_BLOCK_BEGIN}\n${AGENTS_BLOCK_END}\n${AGENTS_BLOCK_END}\n`;
    expect(classifyMarkers(content).kind).toBe('malformed');
  });
  test('malformed: end appears before begin', () => {
    const content = `${AGENTS_BLOCK_END}\nstuff\n${AGENTS_BLOCK_BEGIN}\n`;
    expect(classifyMarkers(content).kind).toBe('malformed');
  });

  describe('markers inside a fenced code block are inert (documentation examples)', () => {
    test('a marker pair shown only inside a ``` fence is treated as absent', () => {
      const content = [
        '# README',
        'Here is what the block looks like:',
        '```',
        AGENTS_BLOCK_BEGIN,
        '## Secrets (Capy)',
        AGENTS_BLOCK_END,
        '```',
        '',
      ].join('\n');
      expect(classifyMarkers(content)).toEqual({ kind: 'absent' });
      expect(hasCurrentBlock(content)).toBe(false);
    });

    test('a real marker pair outside the fence is still detected even when the fence also shows example markers', () => {
      const content = [
        '# README',
        'Example:',
        '```',
        AGENTS_BLOCK_BEGIN,
        AGENTS_BLOCK_END,
        '```',
        '',
        AGENTS_BLOCK,
        '',
      ].join('\n');
      const state = classifyMarkers(content);
      expect(state.kind).toBe('present');
      expect(hasCurrentBlock(content)).toBe(true);
    });

    test('upsertAgentsBlock inserts a real block rather than "updating" an example inside a fence', () => {
      const existing = ['# README', '```', AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, '```', ''].join('\n');
      const result = unwrapOk(upsertAgentsBlock(existing));
      expect(result.action).toBe('updated'); // absent (fenced doesn't count) -> block appended
      expect(result.content.startsWith(existing)).toBe(true);
      expect(result.content).toContain(AGENTS_BLOCK);
      // The original fenced example text is untouched.
      expect(result.content).toContain('```\n<!-- capy:agents:begin -->\n<!-- capy:agents:end -->\n```');
    });

    test('an unterminated fence runs to EOF, so a marker after an opening ``` with no closing fence is also inert', () => {
      const content = ['# README', '```', AGENTS_BLOCK].join('\n');
      expect(classifyMarkers(content)).toEqual({ kind: 'absent' });
    });

    test('~~~ fences are recognized too (both are valid CommonMark fence markers)', () => {
      const content = [
        '# README',
        'Here is what the block looks like:',
        '~~~',
        AGENTS_BLOCK_BEGIN,
        '## Secrets (Capy)',
        AGENTS_BLOCK_END,
        '~~~',
        '',
      ].join('\n');
      expect(classifyMarkers(content)).toEqual({ kind: 'absent' });
      expect(hasCurrentBlock(content)).toBe(false);
    });

    test('a real marker pair outside a ~~~ fence is still detected', () => {
      const content = ['# README', '~~~', AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END, '~~~', '', AGENTS_BLOCK, ''].join('\n');
      expect(classifyMarkers(content).kind).toBe('present');
      expect(hasCurrentBlock(content)).toBe(true);
    });
  });
});

describe('upsertAgentsBlock', () => {
  test('null (file does not exist) creates it', () => {
    const result = unwrapOk(upsertAgentsBlock(null));
    expect(result.action).toBe('created');
    expect(result.content.startsWith(AGENTS_BLOCK_BEGIN)).toBe(true);
    expect(result.content.endsWith('\n')).toBe(true);
  });

  test('existing file with no markers appends the block, preserving all prior bytes', () => {
    const existing = '# My repo\n\nSome docs here.\n';
    const result = unwrapOk(upsertAgentsBlock(existing));
    expect(result.action).toBe('updated');
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain(AGENTS_BLOCK);
  });

  test('is idempotent: running twice on an up-to-date file reports unchanged and produces byte-identical content', () => {
    const first = unwrapOk(upsertAgentsBlock('# repo\n'));
    const second = unwrapOk(upsertAgentsBlock(first.content));
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  test('replaces stale block content in place, preserving everything outside the markers', () => {
    const before = '# repo\n\n';
    const after = '\n## Other section\nkept as-is\n';
    const stale = `${before}${AGENTS_BLOCK_BEGIN}\nold stale content\n${AGENTS_BLOCK_END}${after}`;
    const result = unwrapOk(upsertAgentsBlock(stale));
    expect(result.action).toBe('updated');
    expect(result.content).toBe(`${before}${AGENTS_BLOCK}${after}`);
  });

  test('refuses on malformed markers without touching the content', () => {
    const malformed = `# repo\n${AGENTS_BLOCK_BEGIN}\nno end marker\n`;
    const result = upsertAgentsBlock(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe(ERROR_CODES.AGENTS_BLOCK_MALFORMED);
  });
});

describe('append <-> remove is an exact round trip', () => {
  // The whole point of the fixed (existing-independent) separator: these
  // pairs must restore the ORIGINAL byte-for-byte, for every combination of
  // newline style and trailing-newline state.
  const cases: Array<[string, string]> = [
    ['LF, no trailing newline', '# Title\n\nSome text'],
    ['LF, with a trailing newline', '# Title\n\nSome text\n'],
    ['LF, empty file', ''],
    ['LF, single line, no newline', 'just one line'],
    ['CRLF, no trailing newline', '# Title\r\n\r\nSome text'],
    ['CRLF, with a trailing newline', '# Title\r\n\r\nSome text\r\n'],
    ['LF, already has trailing blank lines', 'abc\n\n\n'],
  ];

  for (const [label, existing] of cases) {
    test(`${label}: upsert then remove restores the original exactly`, () => {
      const inserted = unwrapOk(upsertAgentsBlock(existing));
      const removed = unwrapOk(removeAgentsBlock(inserted.content));
      // The block was always present after upsert, so remove always reports
      // "removed" (it did remove something) — even when that leaves the file
      // empty, which is what "original was empty" looks like here.
      expect(removed.action).toBe('removed');
      expect(removed.content).toBe(existing);
    });
  }

  test('validator repro: "# Title\\n\\nSome text" round-trips exactly (no stray trailing newlines)', () => {
    const existing = '# Title\n\nSome text';
    const inserted = unwrapOk(upsertAgentsBlock(existing));
    const removed = unwrapOk(removeAgentsBlock(inserted.content));
    expect(removed.content).toBe(existing);
    expect(removed.content).not.toMatch(/\n\n\n$/);
  });

  test('the CRLF equivalent of the validator repro round-trips exactly', () => {
    const existing = '# Title\r\n\r\nSome text';
    const inserted = unwrapOk(upsertAgentsBlock(existing));
    const removed = unwrapOk(removeAgentsBlock(inserted.content));
    expect(removed.content).toBe(existing);
  });

  test('a file that is ONLY the block (created, never had other content) restores to empty', () => {
    const created = unwrapOk(upsertAgentsBlock(null));
    const removed = unwrapOk(removeAgentsBlock(created.content));
    expect(removed.action).toBe('removed');
    expect(removed.content).toBe('');
  });
});

describe('removeAgentsBlock', () => {
  test('absent: nothing to remove', () => {
    const existing = '# repo\nno block here\n';
    const result = unwrapOk(removeAgentsBlock(existing));
    expect(result.action).toBe('absent');
    expect(result.content).toBe(existing);
  });

  test('strips up to the fixed separator budget (2 before, 1 after), capped at what is actually present — block truly at EOF', () => {
    // Only 1 newline before the block (less than the 2-newline budget) and
    // nothing after at all — this IS the "appended at EOF" shape, so the
    // full inverse applies. Remove takes only what's there, never negative.
    const content = `# repo\n${AGENTS_BLOCK}`;
    const result = unwrapOk(removeAgentsBlock(content));
    expect(result.action).toBe('removed');
    expect(result.content).toBe('# repo');
  });

  test('refuses on malformed markers', () => {
    const malformed = `${AGENTS_BLOCK_END}\nstuff\n${AGENTS_BLOCK_BEGIN}\n`;
    const result = removeAgentsBlock(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe(ERROR_CODES.AGENTS_BLOCK_MALFORMED);
  });

  describe('an interior block (something follows it): never join the surrounding lines', () => {
    // Coordinator repro (FIX-FIRST round 3): unconditional stripping of up to
    // 2 newlines before / 1 after joined "text" and "More" into "textMore".
    // Fix: when `after` is non-empty, `before` is left completely untouched;
    // only the ONE newline that is never "content" — the mandatory
    // terminator ending the block's own last line — comes off `after`.

    test('LF: exactly one newline before, one after — before untouched, after loses only its own terminator', () => {
      const existing = `text\n${AGENTS_BLOCK}\nMore\n`;
      const result = unwrapOk(removeAgentsBlock(existing));
      expect(result.content).toBe('text\nMore\n');
    });

    test('LF: two newlines before (a real blank line) — before is STILL untouched, not eaten', () => {
      const existing = `text\n\n${AGENTS_BLOCK}\nMore\n`;
      const result = unwrapOk(removeAgentsBlock(existing));
      expect(result.content).toBe('text\n\nMore\n');
    });

    test('CRLF: the same shape, CRLF throughout', () => {
      const block = blockForNewline('\r\n');
      const existing = `text\r\n${block}\r\nMore\r\n`;
      const result = unwrapOk(removeAgentsBlock(existing));
      expect(result.content).toBe('text\r\nMore\r\n');
    });

    test('CRLF: two CRLF before (a real blank line) — before is still untouched', () => {
      const block = blockForNewline('\r\n');
      const existing = `text\r\n\r\n${block}\r\nMore\r\n`;
      const result = unwrapOk(removeAgentsBlock(existing));
      expect(result.content).toBe('text\r\n\r\nMore\r\n');
    });

    test('block at the very start of the file: nothing before to touch, only the terminator comes off after', () => {
      const existing = `${AGENTS_BLOCK}\nMore\n`;
      const result = unwrapOk(removeAgentsBlock(existing));
      expect(result.content).toBe('More\n');
    });

    test('block in the middle, right after a fenced code example: the fence\'s own closing newline survives', () => {
      const existing = ['# Docs', '```', 'some code', '```', '', AGENTS_BLOCK, 'More docs', ''].join('\n');
      const result = unwrapOk(removeAgentsBlock(existing));
      // Nothing before the block is touched — the fence's "```\n" (and the
      // blank line after it) survive exactly as they were.
      expect(result.content).toBe(['# Docs', '```', 'some code', '```', '', 'More docs', ''].join('\n'));
    });

    test('block appended at the very end (nothing follows): this is the OTHER case — the fixed budget applies, unlike the interior cases above', () => {
      // Via the real appendBlock path (upsertAgentsBlock on a file with no
      // markers yet) rather than a hand-crafted string, so this test can't
      // drift from what append actually produces.
      const inserted = unwrapOk(upsertAgentsBlock('text\n'));
      const result = unwrapOk(removeAgentsBlock(inserted.content));
      expect(result.content).toBe('text\n');
    });
  });
});

describe('hasCurrentBlock', () => {
  test('false when absent', () => {
    expect(hasCurrentBlock('# repo\n')).toBe(false);
  });
  test('true when present and current', () => {
    expect(hasCurrentBlock(`# repo\n\n${AGENTS_BLOCK}\n`)).toBe(true);
  });
  test('false when present but stale', () => {
    expect(hasCurrentBlock(`${AGENTS_BLOCK_BEGIN}\nstale\n${AGENTS_BLOCK_END}\n`)).toBe(false);
  });
  test('false when malformed', () => {
    expect(hasCurrentBlock(`${AGENTS_BLOCK_BEGIN}\nno end\n`)).toBe(false);
  });
});
