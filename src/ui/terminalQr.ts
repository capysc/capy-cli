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
 * HARD skips — the QR never renders, no matter the size — in priority
 * order:
 *   1. `process.stdout` must be a real TTY (piping/redirecting skips it —
 *      dumping half-block escapes into a log file or an agent's stdout
 *      parser helps no one and could confuse a naive line-based reader).
 *   2. No `NO_COLOR`-style opt-out (https://no-color.org — any non-empty
 *      value). The QR isn't colored, but it's the same category of "extra
 *      terminal decoration" the convention exists to let a user suppress.
 *
 * SOFT skip — too small for the window ({@link QrFit} `'too_small'`): a
 * long `capy transport` link encodes to a block that can be well over 100
 * columns / 60 rows, bigger than a normal terminal window. Silently
 * dropping the QR there defeats its one purpose (scan it with a phone) with
 * no indication anything is missing. So an undersized block STILL renders
 * — {@link renderTerminalQr} returns it plus a one-line hint to zoom the
 * terminal out — rather than being swallowed like the two hard skips above.
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
 * TTY/env checks — callers gate on {@link qrFit} before printing.
 * Exported separately from {@link renderTerminalQr} so tests can assert on
 * the encoding without touching `process.stdout`/`process.env`.
 */
/** Carries the callback's value out through the stack unwind below — never a reassigned binding. */
class QrTextCaptured {
  constructor(readonly text: string) {}
}

/**
 * Bridges qrcode-terminal's callback shape into a return value, with no
 * `let` anywhere, confined or otherwise.
 *
 * `generate` is synchronous despite the callback shape (see vendor/QRCode —
 * no I/O, pure computation): the callback fires before `generate` returns.
 * There is no non-callback form of this API, so rather than reassign a
 * closure variable from inside the callback, the callback throws the value
 * out as a {@link QrTextCaptured} and this function catches exactly that to
 * return it — construction (the thrown instance), not mutation.
 */
function generateQrText(data: string): string {
  try {
    qrcodeTerminal.generate(data, { small: true }, (out: string) => {
      throw new QrTextCaptured(out);
    });
  } catch (err) {
    if (err instanceof QrTextCaptured) return err.text;
    throw err;
  }
  // The library's callback is documented as always firing before `generate`
  // returns (see above) — this is unreached in practice, and a thrown error
  // here is far more honest than silently handing back an empty string.
  throw new Error('qrcode-terminal did not call back synchronously');
}

export function buildTerminalQr(data: string): RenderedQr {
  const text = generateQrText(data);
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
 * Read the ambient signals {@link qrFit} needs off the real process.
 * Isolated behind a function (rather than read inline) so tests build a
 * fake {@link QrEnv} instead of stubbing global `process` state — `qrFit`
 * itself stays a pure function either way.
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
 * Why a QR of `size` would or wouldn't render well in `env` — a typed
 * result instead of a boolean so callers can tell "deliberately off"
 * (`not_tty`/`no_color`, a hard skip either way) apart from "would be
 * useful but doesn't fit the window" (`too_small` — {@link renderTerminalQr}
 * still returns it, plus a hint, rather than dropping it). `fits` is the
 * only case with no caveats.
 */
export type QrFit = 'fits' | 'too_small' | 'not_tty' | 'no_color';

/**
 * Classify `size` against `env`. Pure and independently testable — no TTY
 * needed to exercise every branch.
 */
export function qrFit(env: QrEnv, size: { width: number; height: number }): QrFit {
  if (!env.isTTY) return 'not_tty';
  if (env.noColor) return 'no_color';
  if (env.columns < size.width || env.rows < size.height) return 'too_small';
  return 'fits';
}

/** COPY-FLAG (minimal-neutral, no approved copy on file for this one):
 *  printed right after an undersized QR so scanning is still possible. */
const TOO_SMALL_HINT = '  Zoom out (⌘− or Ctrl−) until the whole code is visible, then scan it with your phone.';

export interface RenderedTerminalQr {
  /** The half-block block itself — same contract as before (print as-is). */
  readonly text: string;
  /** Only set when {@link qrFit} returned `'too_small'` — print this right
   *  after `text`. Absent (not `undefined` written out) when the block fit
   *  cleanly, so callers can keep using a plain `if (qr.hint)` check. */
  readonly hint?: string;
}

/**
 * The one entry point call sites use: builds the QR for `data` and returns
 * the renderable block (plus a hint line when it's too big for the
 * terminal — see {@link QrFit}), or `null` when it should not be shown at
 * all (piped output, `NO_COLOR`). Never throws — a failed/garbled render is
 * a silent skip, never a crash of the ceremony around it; the caller's
 * unconditional plain-text print is the fallback either way.
 */
export function renderTerminalQr(data: string): RenderedTerminalQr | null {
  try {
    const qr = buildTerminalQr(data);
    const fit = qrFit(readQrEnv(), qr);
    if (fit === 'not_tty' || fit === 'no_color') return null;
    return fit === 'too_small' ? { text: qr.text, hint: TOO_SMALL_HINT } : { text: qr.text };
  } catch {
    return null;
  }
}
