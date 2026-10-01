/**
 * `src/ui/fullScreenQr.ts` (CAP-692 follow-up) — the full-screen centered
 * QR view shared by `capy transport` and `capy pair`. Exercised with a
 * fake TTY stdin (a real `EventEmitter` plus mocked raw-mode controls,
 * same pattern `tests/ui/maskedLinkPrompt.test.ts` uses) and a fake
 * stdout/getSize/onResize/copy, so nothing here touches a real terminal.
 */
import { EventEmitter } from 'node:events';
import { describe, test, expect, mock } from 'bun:test';
import {
  startFullScreenQrView,
  isFullScreenQrEligible,
  printMaskedLinkFooter,
  type FullScreenQrOptions,
} from '../../src/ui/fullScreenQr';
import type { KeyStdin } from '../../src/ui/maskedLinkPrompt';
import type { RenderedTerminalQr } from '../../src/ui/terminalQr';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const CLEAR_AND_HOME = '\x1b[2J\x1b[H';

const QR: RenderedTerminalQr = { text: 'AA\nBB\n' };
const SIZE = { cols: 40, rows: 20 };
const FULL_URL = 'https://keep.capy.sc/transport#3.AAAAAAAAAAAAAAAAAAAAAA.secret-blob';
const MASKED_URL = 'https://keep.capy.sc/transport#…';
const LABEL = 'Open on your other device:';

/** Same fake-stdin shape `maskedLinkPrompt.test.ts` uses: a real `EventEmitter` so `.on('data', …)`/`.removeListener(...)`/`.listenerCount(...)` behave exactly like the real thing, plus mocked TTY-control methods. */
function fakeStdin(): KeyStdin & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    setRawMode: mock(() => {}),
    resume: mock(() => {}),
    pause: mock(() => {}),
    setEncoding: mock(() => {}),
  }) as unknown as KeyStdin & EventEmitter;
}

/** Every `write()` call recorded on the mock's own call log — read back via `.mock.calls`, never an accumulator this file owns/mutates. */
function fakeStdout() {
  const write = mock((_text: string) => {});
  return { write, text: () => write.mock.calls.map((c) => c[0] as string).join('') };
}

function baseOpts(overrides: Partial<FullScreenQrOptions> = {}): FullScreenQrOptions & { stdin: ReturnType<typeof fakeStdin>; stdout: ReturnType<typeof fakeStdout> } {
  return {
    fullUrl: FULL_URL,
    maskedUrl: MASKED_URL,
    label: LABEL,
    qr: QR,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    copy: mock(async () => true),
    getSize: mock(() => SIZE),
    onResize: mock(() => mock(() => {})),
    ...overrides,
  } as FullScreenQrOptions & { stdin: ReturnType<typeof fakeStdin>; stdout: ReturnType<typeof fakeStdout> };
}

describe('isFullScreenQrEligible', () => {
  test('true only when not --json, both ends a real TTY, and no NO_COLOR', () => {
    expect(isFullScreenQrEligible(false, { isTTY: true }, { isTTY: true }, false)).toBe(true);
  });

  test('false under --json even when both ends are a TTY', () => {
    expect(isFullScreenQrEligible(true, { isTTY: true }, { isTTY: true }, false)).toBe(false);
  });

  test('false when stdin is not a TTY', () => {
    expect(isFullScreenQrEligible(false, { isTTY: false }, { isTTY: true }, false)).toBe(false);
  });

  test('false when stdout is not a TTY', () => {
    expect(isFullScreenQrEligible(false, { isTTY: true }, { isTTY: false }, false)).toBe(false);
  });

  test('false when NO_COLOR is set, even with both ends a TTY', () => {
    expect(isFullScreenQrEligible(false, { isTTY: true }, { isTTY: true }, true)).toBe(false);
  });
});

describe('startFullScreenQrView — enter/leave sequence and restore', () => {
  test('hides the cursor, enters the alternate screen, then draws — in that order', () => {
    const opts = baseOpts();
    const view = startFullScreenQrView(opts);
    const written = opts.stdout.text();
    const hideAt = written.indexOf(HIDE_CURSOR);
    const enterAt = written.indexOf(ENTER_ALT_SCREEN);
    const clearAt = written.indexOf(CLEAR_AND_HOME);
    expect(hideAt).toBeGreaterThanOrEqual(0);
    expect(enterAt).toBeGreaterThan(hideAt);
    expect(clearAt).toBeGreaterThan(enterAt);
    expect(written).toContain('AA');
    view.stop();
  });

  test('q restores (show cursor, then leave alternate screen) and resolves done', async () => {
    const opts = baseOpts();
    const view = startFullScreenQrView(opts);
    opts.stdin.emit('data', 'q');
    await view.done;
    const written = opts.stdout.text();
    const showAt = written.lastIndexOf(SHOW_CURSOR);
    const leaveAt = written.lastIndexOf(LEAVE_ALT_SCREEN);
    expect(showAt).toBeGreaterThanOrEqual(0);
    expect(leaveAt).toBeGreaterThan(showAt);
  });

  test('stop() restores and resolves done even if the user never pressed a key, and is idempotent', async () => {
    const opts = baseOpts();
    const view = startFullScreenQrView(opts);
    view.stop();
    await view.done;
    expect(opts.stdout.text()).toContain(LEAVE_ALT_SCREEN);
    expect((opts.stdin as unknown as EventEmitter).listenerCount('data')).toBe(0);
    expect(() => view.stop()).not.toThrow();
  });

  test('restores the terminal if the initial draw throws, then rethrows the error', () => {
    const throwingWrite = mock((text: string) => {
      if (text.includes('AA')) throw new Error('boom');
    });
    const opts = baseOpts({ stdout: { write: throwingWrite } as any });
    expect(() => startFullScreenQrView(opts)).toThrow('boom');
    const written = throwingWrite.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain(HIDE_CURSOR);
    expect(written).toContain(ENTER_ALT_SCREEN);
    expect(written).toContain(SHOW_CURSOR);
    expect(written).toContain(LEAVE_ALT_SCREEN);
  });
});

describe('startFullScreenQrView — key handling', () => {
  test('r redraws with the full link wrapped to the terminal width beneath, without leaking a second stdin listener', () => {
    const wideUrl = `https://keep.capy.sc/transport#${'X'.repeat(100)}`;
    const opts = baseOpts({ fullUrl: wideUrl });
    const view = startFullScreenQrView(opts);
    expect((opts.stdin as unknown as EventEmitter).listenerCount('data')).toBe(1);

    opts.stdin.emit('data', 'r');

    expect((opts.stdin as unknown as EventEmitter).listenerCount('data')).toBe(1);
    const written = opts.stdout.text();
    expect(written).toContain('X'.repeat(SIZE.cols));
    view.stop();
  });

  test('c calls the injected copy() and appends a confirmation line WITHOUT a second full redraw', async () => {
    const opts = baseOpts();
    const view = startFullScreenQrView(opts);
    const clearCountBefore = opts.stdout.text().split(CLEAR_AND_HOME).length - 1;

    opts.stdin.emit('data', 'c');
    await Promise.resolve();
    await Promise.resolve();

    expect(opts.copy).toHaveBeenCalledTimes(1);
    expect(opts.copy).toHaveBeenCalledWith(FULL_URL);
    const written = opts.stdout.text();
    expect(written).toContain('Copied to clipboard');
    const clearCountAfter = written.split(CLEAR_AND_HOME).length - 1;
    expect(clearCountAfter).toBe(clearCountBefore);
    view.stop();
  });

  test('an unrecognized key is ignored — no crash, listener stays attached', () => {
    const opts = baseOpts();
    const view = startFullScreenQrView(opts);
    opts.stdin.emit('data', 'x');
    expect((opts.stdin as unknown as EventEmitter).listenerCount('data')).toBe(1);
    view.stop();
  });
});

describe('startFullScreenQrView — resize', () => {
  test('a resize (via the injected onResize) redraws at the current size without leaking listeners, and tears down its own resize subscription on the next transition', () => {
    const unsub1 = mock(() => {});
    const unsub2 = mock(() => {});
    const onResize = mock((_cb: () => void) => unsub1).mockImplementationOnce((_cb: () => void) => unsub1).mockImplementationOnce((_cb: () => void) => unsub2);
    const opts = baseOpts({ onResize: onResize as any });
    const view = startFullScreenQrView(opts);

    expect(onResize).toHaveBeenCalledTimes(1);
    const resizeCb = onResize.mock.calls[0][0] as () => void;
    const clearCountBefore = opts.stdout.text().split(CLEAR_AND_HOME).length - 1;

    resizeCb();

    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledTimes(2);
    const clearCountAfter = opts.stdout.text().split(CLEAR_AND_HOME).length - 1;
    expect(clearCountAfter).toBe(clearCountBefore + 1);
    expect((opts.stdin as unknown as EventEmitter).listenerCount('data')).toBe(1);

    view.stop();
    expect(unsub2).toHaveBeenCalledTimes(1);
  });
});

describe('printMaskedLinkFooter', () => {
  test('writes the masked link as an OSC 8 hyperlink (full url as click target), extra lines, and a trailing blank line', () => {
    const stdout = fakeStdout();
    printMaskedLinkFooter(stdout, { fullUrl: FULL_URL, maskedUrl: MASKED_URL, label: LABEL, extraLines: ['Expires soon'] });
    const text = stdout.text();
    expect(text).toContain(`\x1b]8;;${FULL_URL}\x1b\\`);
    expect(text).toContain(MASKED_URL);
    expect(text).toContain(LABEL);
    expect(text).toContain('Expires soon');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  test('with no extra lines, still ends with a trailing blank line', () => {
    const stdout = fakeStdout();
    printMaskedLinkFooter(stdout, { fullUrl: FULL_URL, maskedUrl: MASKED_URL, label: LABEL });
    expect(stdout.text().endsWith('\n\n')).toBe(true);
  });
});
