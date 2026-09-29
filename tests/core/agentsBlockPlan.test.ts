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

describe('detectNewline', () => {
  test('LF-only content is LF', () => {
    expect(detectNewline('a\nb\n')).toBe('\n');
  });
  test('any CRLF makes the whole file CRLF', () => {
    expect(detectNewline('a\r\nb\n')).toBe('\r\n');
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
    const state = classifyMarkers(content);
    expect(state.kind).toBe('present');
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
});

describe('upsertAgentsBlock', () => {
  test('null (file does not exist) creates it', () => {
    const result = upsertAgentsBlock(null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('created');
    expect(result.content.startsWith(AGENTS_BLOCK_BEGIN)).toBe(true);
    expect(result.content.endsWith('\n')).toBe(true);
  });

  test('existing file with no markers appends the block, preserving all prior bytes', () => {
    const existing = '# My repo\n\nSome docs here.\n';
    const result = upsertAgentsBlock(existing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('updated');
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain(AGENTS_BLOCK);
  });

  test('is idempotent: running twice on an up-to-date file reports unchanged and produces byte-identical content', () => {
    const first = upsertAgentsBlock('# repo\n');
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    const second = upsertAgentsBlock(first.content);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  test('replaces stale block content in place, preserving everything outside the markers', () => {
    const before = '# repo\n\n';
    const after = '\n## Other section\nkept as-is\n';
    const stale = `${before}${AGENTS_BLOCK_BEGIN}\nold stale content\n${AGENTS_BLOCK_END}${after}`;
    const result = upsertAgentsBlock(stale);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
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

  test('CRLF file with no trailing newline: the inserted block uses CRLF and the original bytes are preserved verbatim before it', () => {
    const existing = '# repo\r\nsome line with no trailing newline';
    const result = upsertAgentsBlock(existing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.content.startsWith(existing)).toBe(true);
    // Everything appended after the original bytes uses CRLF, matching the file.
    const appended = result.content.slice(existing.length);
    expect(appended).toBe('\r\n\r\n' + blockForNewline('\r\n') + '\r\n');
    expect(appended.includes('\r\n')).toBe(true);
  });

  test('replacing a block inside a CRLF file with no trailing newline at EOF preserves the CRLF tail byte-for-byte', () => {
    const crlfBlock = blockForNewline('\r\n');
    const before = '# repo\r\n\r\n';
    const after = '\r\nfinal line, no trailing newline';
    const existing = `${before}${crlfBlock}${after}`;
    const result = upsertAgentsBlock(existing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Already current (block content matches) -> unchanged, byte-identical.
    expect(result.action).toBe('unchanged');
    expect(result.content).toBe(existing);
  });
});

describe('removeAgentsBlock', () => {
  test('absent: nothing to remove', () => {
    const existing = '# repo\nno block here\n';
    const result = removeAgentsBlock(existing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('absent');
    expect(result.content).toBe(existing);
  });

  test('removes exactly the marker span, restoring surrounding content byte-for-byte', () => {
    const before = '# repo\r\n\r\n';
    const after = '\r\nfinal line, no trailing newline';
    const existing = `${before}${AGENTS_BLOCK}${after}`;
    const result = removeAgentsBlock(existing);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('removed');
    expect(result.content).toBe(before + after);
  });

  test('refuses on malformed markers', () => {
    const malformed = `${AGENTS_BLOCK_END}\nstuff\n${AGENTS_BLOCK_BEGIN}\n`;
    const result = removeAgentsBlock(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe(ERROR_CODES.AGENTS_BLOCK_MALFORMED);
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
