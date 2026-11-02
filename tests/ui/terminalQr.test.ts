/**
 * CAP-409 QR follow-up — `src/ui/terminalQr.ts`.
 *
 * Not registered as ISOLATED (no `mock.module()`): every test here either
 * exercises pure functions or stubs `process.stdout`/`process.env`
 * directly and restores them in `afterEach`, the same non-isolated pattern
 * `tests/ui/handoffEvent.test.ts` already uses for the sibling CAP-386
 * module.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { buildTerminalQr, readQrEnv, qrFit, renderTerminalQr, type QrEnv } from '../../src/ui/terminalQr';

// Set process.stdout's TTY fields with defineProperty, never plain assignment:
// another test file in the same bun process may leave `isTTY` defined
// non-writable (CI's Linux runner exposed this), and assignment would throw.
type StdoutProp = 'isTTY' | 'columns' | 'rows';
function setStdout(prop: StdoutProp, value: unknown): void {
  Object.defineProperty(process.stdout, prop, { value, configurable: true, writable: true });
}


const PAIR_URL = 'https://keep.capy.sc/pair';

// Captured from a real `qrcode-terminal` `{small: true}` encode of PAIR_URL
// and eyeballed by hand: all three finder patterns (the nested-square
// corner markers every QR code has, regardless of payload) are visibly
// intact — top-left, top-right, and bottom-left corners of the block below
// each show the unmistakable "border, gap, filled square" silhouette. That
// visual check is the "known-good vector" proof for the chosen dependency;
// pinning the exact bytes here turns it into a permanent regression test —
// a future qrcode-terminal bump or a typo in our own wiring that silently
// corrupts the encoding fails this test instead of shipping a QR that
// LOOKS present but does not actually scan.
const GOLDEN_PAIR_URL_QR =
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n' +
  '█ ▄▄▄▄▄ █▄▀ ▀  ██▀█ ▄▄▄▄▄ █\n' +
  '█ █   █ █   █▀ ▀█ █ █   █ █\n' +
  '█ █▄▄▄█ █▄█▀ ▄██▄ █ █▄▄▄█ █\n' +
  '█▄▄▄▄▄▄▄█▄█ █ █▄█▄█▄▄▄▄▄▄▄█\n' +
  '█▄ ▄▄▀█▄█ █ ▄ █▄█▀▄█▀▄▄▄▀▄█\n' +
  '██▄▀▄▀▄▄▄   ▄▄  █ ▀█ ▀▀▀███\n' +
  '█▄█  █▀▄ █ ▄▀  ▀ ▀  ▀ █▄▄ █\n' +
  '█▀▄█▀ ▀▄▄ █▄ ██ ██ ▀▀ █▄▄▀█\n' +
  '███▄██▄▄█ ▄ ██ ▀█ ▄▄▄ ▄ ▄ █\n' +
  '█ ▄▄▄▄▄ ██▄▄█▄█▀▀ █▄█ █▄▄▄█\n' +
  '█ █   █ █▀ █▀▄█▄▀   ▄  ▀▀ █\n' +
  '█ █▄▄▄█ █ █▀▄▄▀ ▄▄█▄█ █ ▄██\n' +
  '█▄▄▄▄▄▄▄█▄▄▄▄▄▄▄▄██▄▄▄▄▄▄▄█\n';

describe('buildTerminalQr', () => {
  test('matches the known-good vector for the real pairing URL', () => {
    const qr = buildTerminalQr(PAIR_URL);
    expect(qr.text).toBe(GOLDEN_PAIR_URL_QR);
    expect(qr.width).toBe(27);
    expect(qr.height).toBe(14);
  });

  test('is deterministic — same input, same output, every time', () => {
    const a = buildTerminalQr(PAIR_URL);
    const b = buildTerminalQr(PAIR_URL);
    expect(a.text).toBe(b.text);
  });

  test('only ever emits the four half-block glyphs, spaces, and newlines', () => {
    const qr = buildTerminalQr(PAIR_URL);
    const allowed = new Set(['█', '▀', '▄', ' ', '\n']);
    for (const ch of qr.text) {
      expect(allowed.has(ch)).toBe(true);
    }
  });

  test('a longer payload encodes to a larger block — size is derived, not fixed', () => {
    const short = buildTerminalQr('a');
    const long = buildTerminalQr('https://keep.capy.sc/pair?with=a&lot=of&extra&query=parameters&that&make&this&url&much&longer&than&the&other&one&by&quite&a&margin');
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.height).toBeGreaterThan(short.height);
  });
});

describe('qrFit', () => {
  const size = { width: 27, height: 14 };
  const fits: QrEnv = { isTTY: true, columns: 80, rows: 24, noColor: false };

  test('fits on a real, wide-enough, colour-enabled TTY', () => {
    expect(qrFit(fits, size)).toBe('fits');
  });

  test('not_tty when stdout is not a TTY (piped/redirected) — hard skip even though it would fit', () => {
    expect(qrFit({ ...fits, isTTY: false }, size)).toBe('not_tty');
  });

  test('no_color under a NO_COLOR-style opt-out even on a wide TTY — hard skip even though it would fit', () => {
    expect(qrFit({ ...fits, noColor: true }, size)).toBe('no_color');
  });

  // CAP-684 QR follow-up (2026-09-30): a too-small terminal used to be a
  // silent skip (the exact bug report — a `capy transport` link's QR is
  // ~123x62 and got dropped on any normal-size window). It's now
  // `'too_small'`, a SOFT skip — `renderTerminalQr` still renders it.
  test('too_small when the terminal is narrower than the encoded block (still a real TTY, still colour-enabled)', () => {
    expect(qrFit({ ...fits, columns: size.width - 1 }, size)).toBe('too_small');
  });

  test('too_small when the terminal is shorter than the encoded block (still a real TTY, still colour-enabled)', () => {
    expect(qrFit({ ...fits, rows: size.height - 1 }, size)).toBe('too_small');
  });

  test('fits when the terminal is EXACTLY the size of the block (no slack required)', () => {
    expect(qrFit({ ...fits, columns: size.width, rows: size.height }, size)).toBe('fits');
  });
});

describe('readQrEnv', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    setStdout('isTTY', originalIsTTY);
    setStdout('columns', originalColumns);
    setStdout('rows', originalRows);
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test('reads isTTY/columns/rows/NO_COLOR off the real process', () => {
    setStdout('isTTY', true);
    setStdout('columns', 100);
    setStdout('rows', 40);
    delete process.env.NO_COLOR;

    const env = readQrEnv();
    expect(env).toEqual({ isTTY: true, columns: 100, rows: 40, noColor: false });
  });

  test('falls back to 80x24 when columns/rows are unknown (matches the repo-wide convention)', () => {
    setStdout('isTTY', true);
    setStdout('columns', undefined as unknown as number);
    setStdout('rows', undefined as unknown as number);

    const env = readQrEnv();
    expect(env.columns).toBe(80);
    expect(env.rows).toBe(24);
  });

  test('any non-empty NO_COLOR value is treated as opted out', () => {
    process.env.NO_COLOR = '1';
    expect(readQrEnv().noColor).toBe(true);
    process.env.NO_COLOR = '';
    expect(readQrEnv().noColor).toBe(false);
  });

  test('isTTY undefined (spawned-process shape) reads as false, never truthy-by-accident', () => {
    setStdout('isTTY', undefined as unknown as true);
    expect(readQrEnv().isTTY).toBe(false);
  });
});

describe('renderTerminalQr — end to end', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    setStdout('isTTY', originalIsTTY);
    setStdout('columns', originalColumns);
    setStdout('rows', originalRows);
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test('renders the golden block on a real wide TTY, with no hint', () => {
    setStdout('isTTY', true);
    setStdout('columns', 80);
    setStdout('rows', 24);
    delete process.env.NO_COLOR;

    expect(renderTerminalQr(PAIR_URL)).toEqual({ text: GOLDEN_PAIR_URL_QR });
  });

  test('returns null when piped (isTTY undefined, spawned-process shape) — hard skip even though it would fit', () => {
    setStdout('isTTY', undefined as unknown as true);
    setStdout('columns', 80);
    setStdout('rows', 24);

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });

  // CAP-684 QR follow-up (2026-09-30): this used to assert `toBeNull()` —
  // that was the exact silent-skip bug the user reported (a `capy
  // transport` link's QR is big enough to routinely exceed a normal
  // terminal window, and the QR just vanished with no indication). It now
  // still renders, plus a hint to zoom the terminal out.
  test('still renders on a narrow (too-small) real TTY, plus the zoom hint', () => {
    setStdout('isTTY', true);
    setStdout('columns', 20);
    setStdout('rows', 24);
    delete process.env.NO_COLOR;

    const result = renderTerminalQr(PAIR_URL);
    expect(result?.text).toBe(GOLDEN_PAIR_URL_QR);
    expect(result?.hint).toBe('  Zoom out (⌘− or Ctrl−) until the whole code is visible, then scan it with your phone.');
  });

  test('still renders on a too-short real TTY, plus the zoom hint', () => {
    setStdout('isTTY', true);
    setStdout('columns', 80);
    setStdout('rows', 4);
    delete process.env.NO_COLOR;

    const result = renderTerminalQr(PAIR_URL);
    expect(result?.text).toBe(GOLDEN_PAIR_URL_QR);
    expect(result?.hint).toBeTruthy();
  });

  test('returns null under NO_COLOR even on a wide real TTY — hard skip even though it would fit', () => {
    setStdout('isTTY', true);
    setStdout('columns', 80);
    setStdout('rows', 24);
    process.env.NO_COLOR = '1';

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });

  test('NO_COLOR still wins over too_small — no QR, no hint', () => {
    setStdout('isTTY', true);
    setStdout('columns', 20);
    setStdout('rows', 4);
    process.env.NO_COLOR = '1';

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });
});
