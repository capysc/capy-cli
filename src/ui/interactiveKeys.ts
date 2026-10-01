// Shared raw-terminal primitives for full-screen interactive views (`capy
// secrets`, `capy projects`, ...): the ANSI escape codes every such screen
// draws with, the named key tokens its reducer branches on, and the stdin
// chunk→key tokenizer those reducers are fed through.
//
// Extracted out of `secretsScreen.ts` (CAP-675/678) rather than left there,
// so a second type-to-search screen doesn't reimplement CSI-sequence
// parsing. `secretsScreen.ts` re-exports `tokenizeKeys` and
// `SECRETS_SCREEN_ANSI` from here, unchanged in shape and value — this is a
// pure code move, not a behavior change, and its own test suite (which
// imports both names from `secretsScreen.ts`, never from here directly)
// covers that nothing shifted.

export const ESC = '\x1b';
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const MOVE_HOME = `${ESC}[H`;
export const CLEAR_SCREEN = `${ESC}[2J`;
export const CLEAR_EOL = `${ESC}[K`;
export const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
export const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
export const INVERSE = `${ESC}[7m`;
export const RESET = `${ESC}[0m`;
export const DIM = `${ESC}[90m`;
export const BOLD = `${ESC}[1m`;

export const TERMINAL_SCREEN_ANSI = {
  ESC,
  HIDE_CURSOR,
  SHOW_CURSOR,
  MOVE_HOME,
  CLEAR_SCREEN,
  CLEAR_EOL,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} as const;

export const KEY_UP = `${ESC}[A`;
export const KEY_DOWN = `${ESC}[B`;
export const KEY_LEFT = `${ESC}[D`;
export const KEY_RIGHT = `${ESC}[C`;
export const KEY_HOME = `${ESC}[H`;
export const KEY_HOME2 = `${ESC}[1~`;
export const KEY_END = `${ESC}[F`;
export const KEY_END2 = `${ESC}[4~`;
export const KEY_PGUP = `${ESC}[5~`;
export const KEY_PGDN = `${ESC}[6~`;
export const KEY_SHIFT_TAB = `${ESC}[Z`;
export const KEY_TAB = '\t';
export const KEY_ESC = ESC;
export const KEY_ESC_ESC = `${ESC}${ESC}`;
export const KEY_CTRL_C = '\x03';
export const KEY_BACKSPACE = '\x7f';
export const KEY_BACKSPACE2 = '\b';

// ── Chunk tokenizing ─────────────────────────────────────────────────────────
//
// A single stdin `data` event can carry more than one keypress — a paste, a
// fast typist, or piped/scripted input can all deliver e.g. "APIFY\r" as one
// chunk. Every reducer here only ever consumes one token at a time, so the
// driver must split a chunk into tokens BEFORE feeding the reducer, in
// order, or everything after the first character is silently dropped. This
// is that split, kept pure and exported so it's testable on its own.

/** A byte belongs to a CSI sequence's parameter/intermediate region (ECMA-48): digits, `;`, `?`, etc. */
function isCsiParamByte(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

/** A byte that terminates a CSI sequence (ECMA-48 final byte range). */
function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Scans a CSI sequence (`ESC [ params... final`) starting at `rest[start]`
 * (the byte right after `ESC [`). Consumes up through the final byte as one
 * token. If the chunk ends before a final byte appears (the sequence is
 * split across two `data` events, or the chunk is simply truncated — e.g. a
 * bracketed-paste marker like `ESC[200~` counts as an ordinary CSI sequence
 * here since bracketed paste isn't enabled on these screens), whatever was
 * scanned is still returned as ONE token rather than falling through to
 * per-character tokenizing — that would otherwise chop something like an
 * unrecognized `ESC[200~` into stray `[`, `2`, `0`, `0`, `~` characters that
 * would each get typed into a search bar.
 */
function scanCsi(rest: string, start: number): { readonly token: string; readonly length: number } {
  if (start >= rest.length) return { token: rest, length: rest.length };
  const code = rest.charCodeAt(start);
  if (isCsiFinalByte(code)) return { token: rest.slice(0, start + 1), length: start + 1 };
  if (isCsiParamByte(code)) return scanCsi(rest, start + 1);
  // A byte outside both ranges means this was never a well-formed CSI
  // sequence — stop before it rather than consuming something unrelated.
  return { token: rest.slice(0, start), length: start };
}

/** `rest` starts with `ESC`. Reads exactly one escape-rooted token: a CSI sequence, an SS3 sequence (`ESC O <byte>`), a double `ESC ESC` (some terminals double-emit one physical Escape keypress this way), or a lone `ESC`. */
function readEscapeToken(rest: string): { readonly token: string; readonly length: number } {
  if (rest.length === 1) return { token: ESC, length: 1 };
  const second = rest[1];
  if (second === ESC) return { token: `${ESC}${ESC}`, length: 2 };
  if (second === '[') return scanCsi(rest, 2);
  if (second === 'O') return rest.length >= 3 ? { token: rest.slice(0, 3), length: 3 } : { token: rest, length: rest.length };
  // ESC followed by an ordinary character (e.g. an Alt+key combo some
  // terminals send this way) — treat the ESC as its own token; the next
  // character is tokenized on its own in the next recursive step.
  return { token: ESC, length: 1 };
}

/**
 * Splits one raw stdin chunk into key tokens, in the order they arrived.
 * Everything that isn't an escape sequence is split one Unicode code point
 * at a time — via `codePointAt`/`fromCodePoint`, not raw indexing, so a
 * surrogate-pair character (an emoji, say) is one token, not two broken
 * halves. Pure; a driver's only job is to feed each returned token through
 * its reducer in order.
 */
export function tokenizeKeys(chunk: string): readonly string[] {
  return tokenizeFrom(chunk, 0);
}

function tokenizeFrom(chunk: string, index: number): readonly string[] {
  if (index >= chunk.length) return [];

  if (chunk[index] === ESC) {
    const { token, length } = readEscapeToken(chunk.slice(index));
    return [token, ...tokenizeFrom(chunk, index + length)];
  }

  const codePoint = chunk.codePointAt(index);
  const char = codePoint === undefined ? chunk[index] : String.fromCodePoint(codePoint);
  return [char, ...tokenizeFrom(chunk, index + char.length)];
}
