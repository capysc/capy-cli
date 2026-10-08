/**
 * Pure text-manipulation core for `capy agents` (CAP-681) — inserting,
 * updating, and removing the "how an AI coding agent uses Capy" block in
 * AGENTS.md / CLAUDE.md.
 *
 * Every function here takes a file's content as a string and returns a new
 * string (or a refusal) — no filesystem I/O, so the tricky part (idempotent
 * marker replace, byte-exact preservation of everything outside the markers,
 * CRLF vs LF, no-trailing-newline files, exact append<->remove round trip) is
 * unit-testable without touching disk. `src/commands/agentsCommand.ts` does
 * the reading/writing/prompting around this.
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
  '- Run `capy pair --json` in an interactive terminal/PTY. After browser approval, it asks "Enable this location as [email]?" before installing the session or keys. Show the returned email to the human and obtain explicit Yes/No approval before answering. Never automatically confirm or pipe `yes`; Enter defaults to No. No upfront email is required.',
  '- Never print, log, or commit secret values.',
  '- Use `capy run -- <command>` freely to execute this project’s own application, scripts, builds, or tests from its project directory. No per-variable selection is required.',
  '- Do not use this project’s `capy run` for unrelated administration or another project’s commands. Being in the project directory does not make an unrelated task part of the project. Run unrelated tools directly with their own authentication, without loading this project’s secrets.',
  '- To set a value, pipe it from the command that produces it: `<cmd> | capy edit NAME --json`. Never put a value in a command argument, an `echo`, or a heredoc — it would land in your context and the shell history.',
  AGENTS_BLOCK_END,
].join('\n');

export type Newline = '\r\n' | '\n';

/**
 * True majority vote between CRLF lines and lone-LF lines (a `\n` that isn't
 * part of a `\r\n`) — not "any `\r\n` present", which would call a file with
 * one stray CRLF pasted into an otherwise-LF file "CRLF". Ties (including no
 * newlines at all) default to LF.
 */
export function detectNewline(content: string): Newline {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const totalLfCount = (content.match(/\n/g) ?? []).length; // includes the \n half of every \r\n
  const loneLfCount = totalLfCount - crlfCount;
  return crlfCount > loneLfCount ? '\r\n' : '\n';
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

// ---------------------------------------------------------------------------
// Fenced code blocks: a marker string shown as a *documentation example*
// inside a ``` or ~~~ fence (both are valid CommonMark fence markers; e.g.
// someone's README explaining what this block looks like) must never be
// mistaken for a real, live marker pair. This is a line-based fence scanner
// (any line whose trimmed text starts with ``` or ~~~ toggles
// fenced/unfenced), not a full CommonMark parser — good enough to keep
// example text inert without trying to parse arbitrary Markdown.
// ---------------------------------------------------------------------------

function isFenceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

/** Start offset (into `content`) of every line, given `content.split('\n')`. */
function lineStartOffsets(lines: readonly string[]): number[] {
  return lines.reduce<number[]>((offsets, _line, i) => {
    if (i === 0) return [0];
    const previousStart = offsets[i - 1];
    const previousLine = lines[i - 1];
    return [...offsets, previousStart + previousLine.length + 1]; // +1 for the '\n' the split consumed
  }, []);
}

/** Pairs up consecutive fence-line indices — (open, close), (open, close), ... — an unterminated trailing fence closes at `lastLineIndex` (EOF). */
function pairFenceLines(fenceLineIndices: readonly number[], lastLineIndex: number): Array<readonly [number, number]> {
  const { pairs, pending } = fenceLineIndices.reduce<{
    pairs: Array<readonly [number, number]>;
    pending: number | null;
  }>(
    (acc, lineIndex) =>
      acc.pending === null
        ? { pairs: acc.pairs, pending: lineIndex }
        : { pairs: [...acc.pairs, [acc.pending, lineIndex] as const], pending: null },
    { pairs: [], pending: null },
  );
  return pending === null ? pairs : [...pairs, [pending, lastLineIndex] as const];
}

/** [start, end) byte ranges covering every fenced code block in `content`. */
function fencedCodeBlockRanges(content: string): Array<readonly [number, number]> {
  const lines = content.split('\n');
  const starts = lineStartOffsets(lines);
  const fenceLineIndices = lines
    .map((line, i) => (isFenceLine(line) ? i : -1))
    .filter((i) => i !== -1);
  const pairs = pairFenceLines(fenceLineIndices, lines.length - 1);

  return pairs.map(([openLine, closeLine]) => [starts[openLine], starts[closeLine] + lines[closeLine].length] as const);
}

function isInsideAnyRange(index: number, ranges: Array<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
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
 * guess at. Occurrences inside fenced code blocks (documentation examples)
 * are never counted as real markers.
 */
export function classifyMarkers(content: string): MarkerState {
  const fenced = fencedCodeBlockRanges(content);
  const beginIndices = allIndicesOf(content, AGENTS_BLOCK_BEGIN).filter((i) => !isInsideAnyRange(i, fenced));
  const endIndices = allIndicesOf(content, AGENTS_BLOCK_END).filter((i) => !isInsideAnyRange(i, fenced));

  if (beginIndices.length === 0 && endIndices.length === 0) return { kind: 'absent' };
  if (beginIndices.length !== 1 || endIndices.length !== 1) return { kind: 'malformed' };

  const [beginIndex] = beginIndices;
  const [endIndex] = endIndices;
  if (endIndex < beginIndex) return { kind: 'malformed' };
  return { kind: 'present', beginIndex, endIndex };
}

// ---------------------------------------------------------------------------
// Insertion / removal, designed as an EXACT inverse pair.
//
// `appendBlock` always adds a *fixed*, existing-content-independent amount of
// whitespace: two newlines before the block (none at all when `existing` is
// empty — there is nothing to separate from), one newline after it. Fixed
// (not "one newline if existing already ends with one, else two") is the
// whole point: if the separator's length depended on what `existing` already
// ended with, a `before` string like "abc\n\n" would be genuinely ambiguous
// on the way back — it's what you get from `existing = "abc\n"` (add 1) AND
// from `existing = "abc"` (add 2), and remove has no way to tell which.  A
// constant-length separator has no such ambiguity: remove always strips
// exactly that fixed budget (capped at what's actually there), so
// `removeAgentsBlock(appendBlock(x)) === x` for every `x`, every newline
// style, with or without a trailing newline.
// ---------------------------------------------------------------------------

const LEADING_SEPARATOR_NEWLINES = 2;
const TRAILING_TERMINATOR_NEWLINES = 1;

function appendBlock(existing: string, newline: Newline): string {
  const block = blockForNewline(newline);
  if (existing.length === 0) return block + newline;
  const separator = newline.repeat(LEADING_SEPARATOR_NEWLINES);
  const terminator = newline.repeat(TRAILING_TERMINATOR_NEWLINES);
  return existing + separator + block + terminator;
}

/** Strips up to `maxCount` trailing occurrences of `newline` from the end of `text` — never more than are actually there. */
function stripTrailingNewlines(text: string, newline: Newline, maxCount: number): string {
  if (maxCount <= 0 || !text.endsWith(newline)) return text;
  return stripTrailingNewlines(text.slice(0, -newline.length), newline, maxCount - 1);
}

/** Strips up to `maxCount` leading occurrences of `newline` from the start of `text` — never more than are actually there. */
function stripLeadingNewlines(text: string, newline: Newline, maxCount: number): string {
  if (maxCount <= 0 || !text.startsWith(newline)) return text;
  return stripLeadingNewlines(text.slice(newline.length), newline, maxCount - 1);
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
 * Deletes the marker span, plus whatever surrounding whitespace it's safe to
 * reclaim — which depends on whether anything follows the block:
 *
 * - Nothing follows it (the block is the last thing in the file, once its own
 *   mandatory one-newline terminator is accounted for): this is exactly the
 *   shape `appendBlock` produces, so this is its exact inverse —
 *   `removeAgentsBlock(appendBlock(x)) === x` — reclaiming up to the full
 *   fixed budget (2 newlines before, 1 after), capped at what's present.
 * - Something follows it (an interior block — hand-placed, produced by the
 *   in-place "updated" path, or simply appended-to by hand afterward):
 *   `before` is left COMPLETELY untouched — there is no reliable way to tell
 *   a deliberate blank line (or a fenced code block's own closing newline)
 *   from separator whitespace, so touching it at all risks corrupting real
 *   content (joining two lines together, or eating a fence's terminator).
 *   Only the ONE newline that is never "content" — the mandatory terminator
 *   ending the block's own last line, which has to exist for `after` to
 *   start its own line — is stripped, capped at 1.
 */
export function removeAgentsBlock(existing: string): RemoveResult {
  const state = classifyMarkers(existing);
  if (state.kind === 'malformed') {
    return { ok: false, code: ERROR_CODES.AGENTS_BLOCK_MALFORMED };
  }
  if (state.kind === 'absent') {
    return { ok: true, action: 'absent', content: existing };
  }
  const newline = detectNewline(existing);
  const rawBefore = existing.slice(0, state.beginIndex);
  const rawAfter = existing.slice(state.endIndex + AGENTS_BLOCK_END.length);

  const after = stripLeadingNewlines(rawAfter, newline, TRAILING_TERMINATOR_NEWLINES);
  const isAtFileEnd = after.length === 0;
  const before = isAtFileEnd ? stripTrailingNewlines(rawBefore, newline, LEADING_SEPARATOR_NEWLINES) : rawBefore;

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
