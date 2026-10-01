/**
 * Pure centering layout for the full-screen QR view (`fullScreenQr.ts`,
 * CAP-692 follow-up). No I/O, no TTY/env reads — just arithmetic over
 * already-rendered lines, so it's independently unit-testable.
 */

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface QrScreenLayout {
  /** Every line to print, top to bottom, already padded/centered (or, when `fits` is false, left exactly as given — see below). */
  readonly lines: readonly string[];
  /** False when the content is taller or wider than `size` — callers still print `lines` from the top-left rather than skipping them (same "never silently drop the QR" rule `terminalQr.ts`'s `too_small` case follows). */
  readonly fits: boolean;
}

// Strips ANSI SGR (`\x1b[...m`) and OSC 8 hyperlink (`\x1b]8;;...\x1b\\`)
// escape sequences before measuring a line's on-screen width — both appear
// in the footer (the key hint is colored, the masked link is an OSC 8
// hyperlink), and neither occupies a terminal column.
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g;

/** On-screen width of `line`, ignoring ANSI/OSC escape sequences. */
export function visibleWidth(line: string): number {
  return [...line.replace(ANSI_OSC_RE, '')].length;
}

/** Centers `line` horizontally within `cols` columns (left-biased when the padding is odd). An empty line stays empty — there is nothing to visually center about a blank spacer. */
function centerLine(line: string, cols: number): string {
  if (line.length === 0) return line;
  const width = visibleWidth(line);
  if (width >= cols) return line;
  const left = Math.floor((cols - width) / 2);
  return `${' '.repeat(left)}${line}`;
}

/**
 * Lays out `qrLines` (the QR block, top to bottom) with `footerLines`
 * (masked link + key hints + expiry, etc.) directly under it, separated by
 * one blank line, for a `size`-sized screen:
 *
 *   - When everything fits (`content.length <= rows` and the widest line
 *     fits in `cols`): every line is horizontally centered, and the whole
 *     block is vertically centered (top-biased when the padding is odd).
 *   - When it doesn't fit: no padding/centering at all — `lines` is the
 *     content exactly as given, meant to be drawn from the terminal's
 *     top-left corner (`fits: false` tells the caller to also print a
 *     zoom-out hint, same as `terminalQr.ts`'s `too_small`).
 */
export function layoutQrScreen(
  size: TerminalSize,
  qrLines: readonly string[],
  footerLines: readonly string[],
): QrScreenLayout {
  const content: readonly string[] = [...qrLines, '', ...footerLines];
  const contentWidth = content.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
  const fits = content.length <= size.rows && contentWidth <= size.cols;

  if (!fits) {
    return { lines: content, fits: false };
  }

  const topPad = Math.floor((size.rows - content.length) / 2);
  const lines = [...Array.from({ length: topPad }, () => ''), ...content.map((l) => centerLine(l, size.cols))];
  return { lines, fits: true };
}
