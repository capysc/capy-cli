/**
 * Terminal QR rendering for `capy pair` (CAP-409) — a Unicode half-block
 * (`▀`/`▄`) QR code so a headless box with no display (SSH'd into a
 * container) can still show something scannable, on the phone the human
 * will approve the pairing from.
 *
 * ACCELERANT ONLY. The plain URL and human code are ALWAYS printed by the
 * caller regardless of what this module returns — terminals mangle glyphs,
 * fonts vary, people pipe `capy pair`'s output, and some users cannot scan
 * a code at all. This module only ever adds pixels on top of that; nothing
 * here may become the only path to the code. See `pairCommand.ts`'s
 * `printPairingBlock` for the call site.
 *
 * DEPENDENCY CHOICE — `qrcode-terminal`, not `qrcode`:
 *   `qrcode` (the more actively-maintained, more general library) pulls
 *   `pngjs` (~650KB unpacked, a full PNG encoder we'd never use from a
 *   terminal-only render) and `yargs` (~235KB, only needed for its own CLI
 *   binary) as HARD dependencies — npm installs both for every consumer
 *   regardless of which render target is actually called. `qrcode-terminal`
 *   has zero dependencies, ~96KB unpacked total, Apache-2.0 licensed, and
 *   its `small: true` mode already renders exactly the half-block encoding
 *   this ticket asks for (two module rows per text line) — nothing to
 *   hand-roll. This CLI ships in an npm tarball installed on every machine
 *   that runs it, so the ~800KB saved is a real, not theoretical, saving.
 *   Verified against a known-good vector: see terminalQr.test.ts's "matches
 *   a known-good vector" case (byte-for-byte against the library's own
 *   documented example output).
 *
 * FALLBACK, in priority order — never render a QR that won't actually work:
 *   1. `process.stdout` must be a real TTY (piping/redirecting skips it —
 *      dumping half-block escapes into a log file or an agent's stdout
 *      parser helps no one and could confuse a naive line-based reader).
 *   2. No `NO_COLOR`-style opt-out (https://no-color.org — any non-empty
 *      value). The QR isn't colored, but it's the same category of "extra
 *      terminal decoration" the convention exists to let a user suppress.
 *   3. The terminal must be at least as wide/tall as the block the URL
 *      ACTUALLY encoded to — computed from the real encoded string via
 *      {@link buildTerminalQr}, never a hardcoded module count. A short
 *      URL needs a small QR; a longer one needs a bigger terminal, and the
 *      check reflects that.
 */
import qrcodeTerminal from 'qrcode-terminal';

export interface RenderedQr {
  /** The full half-block block, newline-terminated rows, including the
   *  library's own one-module quiet-zone border. */
  text: string;
  /** Widest rendered line, in terminal columns. */
  width: number;
  /** Number of rendered lines. */
  height: number;
}

/**
 * Pure: encode `data` as a half-block QR and measure the result. No I/O, no
 * TTY/env checks — callers gate on {@link shouldRenderQr} before printing.
 * Exported separately from {@link renderTerminalQr} so tests can assert on
 * the encoding without touching `process.stdout`/`process.env`.
 */
export function buildTerminalQr(data: string): RenderedQr {
  let text = '';
  // qrcode-terminal's `generate` is synchronous despite the callback shape
  // (see vendor/QRCode — no I/O, pure computation); the callback fires
  // before `generate` returns, so capturing into a closure is safe here.
  qrcodeTerminal.generate(data, { small: true }, (out: string) => {
    text = out;
  });
  const lines = text.split('\n').filter((l) => l.length > 0);
  const width = lines.reduce((max, l) => Math.max(max, [...l].length), 0);
  return { text, width, height: lines.length };
}

export interface QrEnv {
  isTTY: boolean;
  columns: number;
  rows: number;
  /** True when a `NO_COLOR`-style opt-out is set — see file header. */
  noColor: boolean;
}

/** https://no-color.org — any non-empty value opts out, regardless of content. */
function isNoColorSet(): boolean {
  return typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length > 0;
}

/**
 * Read the ambient signals {@link shouldRenderQr} needs off the real
 * process. Isolated behind a function (rather than read inline) so tests
 * build a fake {@link QrEnv} instead of stubbing global `process` state —
 * `shouldRenderQr` itself stays a pure function either way.
 */
export function readQrEnv(): QrEnv {
  return {
    isTTY: process.stdout.isTTY === true,
    // Same fallback the repo already uses for other size-aware terminal UI
    // (editScreen.ts, interactiveTable.ts): 80x24 when the size is unknown.
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    noColor: isNoColorSet(),
  };
}

/**
 * Decide whether a QR block of `size` will actually render usefully in
 * `env`. Pure and independently testable — no TTY needed to exercise every
 * branch.
 */
export function shouldRenderQr(env: QrEnv, size: { width: number; height: number }): boolean {
  if (!env.isTTY) return false;
  if (env.noColor) return false;
  if (env.columns < size.width) return false;
  if (env.rows < size.height) return false;
  return true;
}

/**
 * The one entry point call sites use: builds the QR for `data` and returns
 * the renderable block, or `null` when it should not be shown (piped
 * output, narrow terminal, `NO_COLOR`). Never throws — a failed/garbled
 * render is a silent skip, never a crash of the ceremony around it; the
 * caller's unconditional plain-text print is the fallback either way.
 */
export function renderTerminalQr(data: string): string | null {
  try {
    const qr = buildTerminalQr(data);
    if (!shouldRenderQr(readQrEnv(), qr)) return null;
    return qr.text;
  } catch {
    return null;
  }
}
