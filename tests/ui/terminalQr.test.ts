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
import { buildTerminalQr, readQrEnv, shouldRenderQr, renderTerminalQr, type QrEnv } from '../../src/ui/terminalQr';

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

describe('shouldRenderQr', () => {
  const size = { width: 27, height: 14 };
  const fits: QrEnv = { isTTY: true, columns: 80, rows: 24, noColor: false };

  test('renders on a real, wide-enough, colour-enabled TTY', () => {
    expect(shouldRenderQr(fits, size)).toBe(true);
  });

  test('skips when stdout is not a TTY (piped/redirected)', () => {
    expect(shouldRenderQr({ ...fits, isTTY: false }, size)).toBe(false);
  });

  test('skips under a NO_COLOR-style opt-out even on a wide TTY', () => {
    expect(shouldRenderQr({ ...fits, noColor: true }, size)).toBe(false);
  });

  test('skips when the terminal is narrower than the encoded block', () => {
    expect(shouldRenderQr({ ...fits, columns: size.width - 1 }, size)).toBe(false);
  });

  test('skips when the terminal is shorter than the encoded block', () => {
    expect(shouldRenderQr({ ...fits, rows: size.height - 1 }, size)).toBe(false);
  });

  test('renders when the terminal is EXACTLY the size of the block (no slack required)', () => {
    expect(shouldRenderQr({ ...fits, columns: size.width, rows: size.height }, size)).toBe(true);
  });
});

describe('readQrEnv', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test('reads isTTY/columns/rows/NO_COLOR off the real process', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 100;
    process.stdout.rows = 40;
    delete process.env.NO_COLOR;

    const env = readQrEnv();
    expect(env).toEqual({ isTTY: true, columns: 100, rows: 40, noColor: false });
  });

  test('falls back to 80x24 when columns/rows are unknown (matches the repo-wide convention)', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = undefined as unknown as number;
    process.stdout.rows = undefined as unknown as number;

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
    process.stdout.isTTY = undefined as unknown as true;
    expect(readQrEnv().isTTY).toBe(false);
  });
});

describe('renderTerminalQr — end to end', () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test('renders the golden block on a real wide TTY', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    delete process.env.NO_COLOR;

    expect(renderTerminalQr(PAIR_URL)).toBe(GOLDEN_PAIR_URL_QR);
  });

  test('returns null when piped (isTTY undefined, spawned-process shape)', () => {
    process.stdout.isTTY = undefined as unknown as true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });

  test('returns null on a narrow terminal even when it is a real TTY', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 20;
    process.stdout.rows = 24;

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });

  test('returns null under NO_COLOR even on a wide real TTY', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    process.env.NO_COLOR = '1';

    expect(renderTerminalQr(PAIR_URL)).toBeNull();
  });
});
