/**
 * Pure text-manipulation core for `capy agents` (CAP-681) — inserting,
 * updating, and removing the "how an AI coding agent uses Capy" block in
 * AGENTS.md / CLAUDE.md.
 *
 * Every function here takes a file's content as a string and returns a new
 * string (or a refusal) — no filesystem I/O, so the tricky part (idempotent
 * marker replace, byte-exact preservation of everything outside the markers,
 * CRLF vs LF, no-trailing-newline files) is unit-testable without touching
 * disk. `src/commands/agentsCommand.ts` does the reading/writing/prompting
 * around this.
 */
import { ERROR_CODES } from '../types/index';

export const AGENTS_BLOCK_BEGIN = '<!-- capy:agents:begin -->';
export const AGENTS_BLOCK_END = '<!-- capy:agents:end -->';

// Verbatim block content (COPY-FLAG — Vince approves the wording in PR). Kept
// as an LF-joined template; `blockForNewline` adapts it to the target file's
// own line-ending convention.
export const AGENTS_BLOCK = [
  AGENTS_BLOCK_BEGIN,
  '## Secrets (Capy)',
  "This repo's secrets are managed by Capy.",
  '- Run `capy help --json` for every command, its options, and its error codes.',
  '- Always pass `--json` and branch on the `code` field, never on message text.',
  '- Never print, log, or commit secret values.',
  AGENTS_BLOCK_END,
].join('\n');

export type Newline = '\r\n' | '\n';

/** Majority-rules: any `\r\n` in the file means the file is CRLF. Defaults to LF for a fresh file. */
export function detectNewline(content: string): Newline {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** The canonical block, re-joined with the target file's own newline convention. */
export function blockForNewline(newline: Newline): string {
  return newline === '\n' ? AGENTS_BLOCK : AGENTS_BLOCK.split('\n').join(newline);
}

/** Every (non-overlapping) index at which `needle` occurs in `haystack`, recursively — no mutable accumulator. */
function allIndicesOf(haystack: string, needle: string, from = 0): number[] {
  const idx = haystack.indexOf(needle, from);
  if (idx === -1) return [];
  return [idx, ...allIndicesOf(haystack, needle, idx + needle.length)];
}

export type MarkerState =
  | { kind: 'absent' }
  | { kind: 'present'; beginIndex: number; endIndex: number }
  | { kind: 'malformed' };

/**
 * Classifies a file's marker pair: exactly one BEGIN and one END, END after
 * BEGIN, is the only shape the idempotent replace can safely act on. Zero of
 * both means "not set up yet". Anything else (one without the other,
 * duplicates, END before BEGIN) is hand-edited into a state we refuse to
 * guess at.
 */
export function classifyMarkers(content: string): MarkerState {
  const beginIndices = allIndicesOf(content, AGENTS_BLOCK_BEGIN);
  const endIndices = allIndicesOf(content, AGENTS_BLOCK_END);

  if (beginIndices.length === 0 && endIndices.length === 0) return { kind: 'absent' };
  if (beginIndices.length !== 1 || endIndices.length !== 1) return { kind: 'malformed' };

  const [beginIndex] = beginIndices;
  const [endIndex] = endIndices;
  if (endIndex < beginIndex) return { kind: 'malformed' };
  return { kind: 'present', beginIndex, endIndex };
}

/**
 * Appends the block to content that has none yet. Exactly one blank line
 * separates the existing content from the block; a file with no trailing
 * newline gets one added first so the block always starts its own line.
 * Nothing in `existing` is rewritten — this only concatenates.
 */
function appendBlock(existing: string, newline: Newline): string {
  const block = blockForNewline(newline);
  if (existing.length === 0) return block + newline;
  const endsWithNewline = existing.endsWith('\n'); // true for both "\n" and "\r\n" endings
  const separator = endsWithNewline ? newline : newline + newline;
  return existing + separator + block + newline;
}

export type UpsertAction = 'created' | 'updated' | 'unchanged';
export type UpsertResult =
  | { ok: true; action: UpsertAction; content: string }
  | { ok: false; code: string };

/**
 * `existing === null` means the file doesn't exist yet (action: "created").
 * Otherwise the block is inserted (no markers yet), replaced in place
 * (markers present, content differs), or left alone (markers present,
 * already correct) — every byte outside the marker span is preserved
 * exactly, by construction: it is only ever sliced, never reformatted.
 */
export function upsertAgentsBlock(existing: string | null): UpsertResult {
  if (existing === null) {
    return { ok: true, action: 'created', content: blockForNewline('\n') + '\n' };
  }

  const state = classifyMarkers(existing);
  if (state.kind === 'malformed') {
    return { ok: false, code: ERROR_CODES.AGENTS_BLOCK_MALFORMED };
  }

  const newline = detectNewline(existing);

  if (state.kind === 'absent') {
    return { ok: true, action: 'updated', content: appendBlock(existing, newline) };
  }

  const block = blockForNewline(newline);
  const before = existing.slice(0, state.beginIndex);
  const after = existing.slice(state.endIndex + AGENTS_BLOCK_END.length);
  const current = existing.slice(state.beginIndex, state.endIndex + AGENTS_BLOCK_END.length);

  if (current === block) {
    return { ok: true, action: 'unchanged', content: existing };
  }
  return { ok: true, action: 'updated', content: before + block + after };
}

export type RemoveAction = 'removed' | 'absent';
export type RemoveResult =
  | { ok: true; action: RemoveAction; content: string }
  | { ok: false; code: string };

/**
 * Deletes exactly the `[beginIndex, endIndex + END.length)` span and nothing
 * else — every byte before and after is untouched, so the surrounding
 * content is restored byte-for-byte.
 */
export function removeAgentsBlock(existing: string): RemoveResult {
  const state = classifyMarkers(existing);
  if (state.kind === 'malformed') {
    return { ok: false, code: ERROR_CODES.AGENTS_BLOCK_MALFORMED };
  }
  if (state.kind === 'absent') {
    return { ok: true, action: 'absent', content: existing };
  }
  const before = existing.slice(0, state.beginIndex);
  const after = existing.slice(state.endIndex + AGENTS_BLOCK_END.length);
  return { ok: true, action: 'removed', content: before + after };
}

/** True when the block (any newline style) is already present and current in `content`. */
export function hasCurrentBlock(content: string): boolean {
  const state = classifyMarkers(content);
  if (state.kind !== 'present') return false;
  const newline = detectNewline(content);
  const current = content.slice(state.beginIndex, state.endIndex + AGENTS_BLOCK_END.length);
  return current === blockForNewline(newline);
}
