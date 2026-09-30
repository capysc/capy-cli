/**
 * `src/ui/maskedLinkPrompt.ts` (CAP-684 follow-up — masked transport/pair
 * links). Three layers, tested separately:
 *
 *   1. `maskLink` — pure, no stdin/stdout at all.
 *   2. `handleMaskedLinkKey` — pure keypress→action reducer, no stdin.
 *   3. `startMaskedLinkPrompt` — the stdin-driven listener, exercised with a
 *      fake `stdin` (a plain `EventEmitter` plus mocked
 *      `setRawMode`/`resume`/`pause`/`setEncoding`) and a fake `stdout`
 *      (a `jest.fn()` write, read back from its own `.mock.calls` — no
 *      accumulator of our own to mutate). This sidesteps the real
 *      `process.stdin.setRawMode` throwing on a non-TTY-backed stream when
 *      `isTTY` is merely faked to `true` (see
 *      `tests/commands/deployDokploySystemStoreToken.test.ts`'s comment on
 *      why `keypressConfirm.ts` can't be driven that way either) — the
 *      fake here IS the "TTY", so `setRawMode` is just a mock, never the
 *      real syscall-backed one.
 *
 * The `capy pair` concurrency property ("the poll and the key listener run
 * at the same time, and `stop()` cleans up once the poll settles even if
 * the user never pressed a key") is proved here at the mechanism's own
 * level: a fake async "poll" runs alongside a live `startMaskedLinkPrompt`,
 * a keypress is handled mid-poll (proving the listener isn't blocked), and
 * `stop()` after the poll settles is shown to restore raw mode and detach
 * the listener.
 */
import { EventEmitter } from 'node:events';
import { describe, test, expect, mock } from 'bun:test';
import {
  maskLink,
  handleMaskedLinkKey,
  startMaskedLinkPrompt,
  isInteractiveLinkPrompt,
  type KeyStdin,
} from '../../src/ui/maskedLinkPrompt';
import { oscHyperlink } from '../../src/ui/osc8';

const TRANSPORT_URL = 'https://keep.capy.sc/transport#transport-1.aXY.Y3Q';
const PAIR_URL = 'https://keep.capy.sc/device?code=ABCD-EFGH';

describe('maskLink', () => {
  test('transport (fragment): hides everything after #, keeps origin + path', () => {
    expect(maskLink(TRANSPORT_URL, 'fragment')).toBe('https://keep.capy.sc/transport#…');
  });

  test('pair (query): hides everything after ?, keeps origin + path', () => {
    expect(maskLink(PAIR_URL, 'query')).toBe('https://keep.capy.sc/device?…');
  });

  test('fragment masking never leaks the query string, and vice versa', () => {
    const masked = maskLink(TRANSPORT_URL, 'fragment');
    expect(masked).not.toContain('aXY');
    expect(masked).not.toContain('Y3Q');
  });

  test('a url with no fragment is untouched by fragment masking (no bare …)', () => {
    expect(maskLink('https://keep.capy.sc/device?code=ABCD-EFGH', 'fragment')).toBe('https://keep.capy.sc/device');
  });

  test('a url with no query is untouched by query masking (no bare …)', () => {
    expect(maskLink('https://keep.capy.sc/transport#abc', 'query')).toBe('https://keep.capy.sc/transport');
  });
});

describe('oscHyperlink (OSC 8)', () => {
  test('wraps the FULL url as the click target, with the masked text visible', () => {
    const masked = maskLink(TRANSPORT_URL, 'fragment');
    const seq = oscHyperlink(TRANSPORT_URL, masked);
    // Structure: ESC ] 8 ; ; <url> ST <text> ESC ] 8 ; ; ST
    expect(seq).toBe(`\x1b]8;;${TRANSPORT_URL}\x1b\\${masked}\x1b]8;;\x1b\\`);
    // The click target is the full, unmasked url — never the masked text.
    expect(seq).toContain(TRANSPORT_URL);
    // The visible text segment is the masked form, not the full url a
    // second time.
    const visibleSegment = seq.split('\x1b\\')[1];
    expect(visibleSegment.startsWith(masked)).toBe(true);
    expect(visibleSegment).not.toContain('aXY.Y3Q');
  });
});

describe('handleMaskedLinkKey', () => {
  test('c → copy', () => {
    expect(handleMaskedLinkKey('c')).toEqual({ kind: 'copy' });
    expect(handleMaskedLinkKey('C')).toEqual({ kind: 'copy' });
  });

  test('r → reveal', () => {
    expect(handleMaskedLinkKey('r')).toEqual({ kind: 'reveal' });
    expect(handleMaskedLinkKey('R')).toEqual({ kind: 'reveal' });
  });

  test('q, Enter, Esc → done', () => {
    expect(handleMaskedLinkKey('q')).toEqual({ kind: 'done' });
    expect(handleMaskedLinkKey('Q')).toEqual({ kind: 'done' });
    expect(handleMaskedLinkKey('\r')).toEqual({ kind: 'done' });
    expect(handleMaskedLinkKey('\n')).toEqual({ kind: 'done' });
    expect(handleMaskedLinkKey('\u001b')).toEqual({ kind: 'done' });
  });

  test('Ctrl-C → exit', () => {
    expect(handleMaskedLinkKey('\u0003')).toEqual({ kind: 'exit' });
  });

  test('anything else → ignore', () => {
    expect(handleMaskedLinkKey('x')).toEqual({ kind: 'ignore' });
    expect(handleMaskedLinkKey('1')).toEqual({ kind: 'ignore' });
  });
});

describe('isInteractiveLinkPrompt', () => {
  test('true only when both stdin and stdout are real TTYs', () => {
    expect(isInteractiveLinkPrompt({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveLinkPrompt({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractiveLinkPrompt({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractiveLinkPrompt({ isTTY: undefined }, { isTTY: undefined })).toBe(false);
  });
});

/** A fake stdin: a real `EventEmitter` (so `.on('data', …)`/`.removeListener(...)` behave exactly like the real thing) plus mocked TTY-control methods, so `startMaskedLinkPrompt` never touches a real file descriptor. */
function fakeStdin(isTTY = true): KeyStdin & EventEmitter & { setRawMode: ReturnType<typeof mock>; resume: ReturnType<typeof mock>; pause: ReturnType<typeof mock>; setEncoding: ReturnType<typeof mock> } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY,
    setRawMode: mock(() => {}),
    resume: mock(() => {}),
    pause: mock(() => {}),
    setEncoding: mock(() => {}),
  }) as unknown as KeyStdin & EventEmitter & { setRawMode: ReturnType<typeof mock>; resume: ReturnType<typeof mock>; pause: ReturnType<typeof mock>; setEncoding: ReturnType<typeof mock> };
}

/** A fake stdout: every `write()` call recorded on the mock's own call log — read back via `.mock.calls`, never an accumulator this file owns/mutates. */
function fakeStdout() {
  const write = mock((_text: string) => {});
  return { write, text: () => write.mock.calls.map((c) => c[0] as string).join('') };
}

describe('startMaskedLinkPrompt — key handling (fake stdin)', () => {
  test('c calls the injected copy() with the FULL url and prints a confirmation', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const copy = mock(async (_text: string) => true);
    const handle = startMaskedLinkPrompt({
      fullUrl: TRANSPORT_URL,
      maskedUrl: maskLink(TRANSPORT_URL, 'fragment'),
      label: 'Open on your other device:',
      stdin,
      stdout,
      copy,
    });

    // The initial print (OSC 8 hyperlink line + hint) legitimately carries
    // the full url as the escape sequence's click TARGET — that's the
    // point of the hyperlink. What `c` must NOT do is print it again as
    // plain visible text, so the assertion below only looks at what `c`
    // itself writes, not the header printed before it.
    const callsBeforeC = stdout.write.mock.calls.length;

    stdin.emit('data', 'c');
    // copy() is awaited internally (fire-and-forget from onData's point of
    // view) — flush microtasks before asserting on its result.
    await Promise.resolve();
    await Promise.resolve();

    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(TRANSPORT_URL);
    const writtenByC = stdout.write.mock.calls.slice(callsBeforeC).map((c) => c[0] as string).join('');
    expect(writtenByC).toContain('Copied to clipboard');
    expect(writtenByC).not.toContain(TRANSPORT_URL);

    handle.stop();
  });

  test('r prints the full url', () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const handle = startMaskedLinkPrompt({
      fullUrl: PAIR_URL,
      maskedUrl: maskLink(PAIR_URL, 'query'),
      label: 'Approve on your other device:',
      stdin,
      stdout,
    });

    stdin.emit('data', 'r');
    expect(stdout.text()).toContain(PAIR_URL);

    handle.stop();
  });

  test('q resolves done and restores raw mode / detaches the listener', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const handle = startMaskedLinkPrompt({
      fullUrl: TRANSPORT_URL,
      maskedUrl: maskLink(TRANSPORT_URL, 'fragment'),
      label: 'Open on your other device:',
      stdin,
      stdout,
    });

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.listenerCount('data')).toBe(1);

    stdin.emit('data', 'q');
    await handle.done;

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  test('stop() is idempotent — safe to call again after q already cleaned up', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const handle = startMaskedLinkPrompt({
      fullUrl: TRANSPORT_URL,
      maskedUrl: maskLink(TRANSPORT_URL, 'fragment'),
      label: 'Open on your other device:',
      stdin,
      stdout,
    });
    stdin.emit('data', 'q');
    await handle.done;
    expect(() => handle.stop()).not.toThrow();
  });

  test('an unrecognized key is ignored — no crash, listener stays attached', () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const handle = startMaskedLinkPrompt({
      fullUrl: TRANSPORT_URL,
      maskedUrl: maskLink(TRANSPORT_URL, 'fragment'),
      label: 'Open on your other device:',
      stdin,
      stdout,
    });
    stdin.emit('data', 'x');
    expect(stdin.listenerCount('data')).toBe(1);
    handle.stop();
  });

  test('the printed hyperlink line carries the full url as its OSC 8 target and the masked text as the visible label', () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const handle = startMaskedLinkPrompt({
      fullUrl: TRANSPORT_URL,
      maskedUrl: maskLink(TRANSPORT_URL, 'fragment'),
      label: 'Open on your other device:',
      stdin,
      stdout,
    });
    const printed = stdout.text();
    expect(printed).toContain(`\x1b]8;;${TRANSPORT_URL}\x1b\\`);
    expect(printed).toContain(maskLink(TRANSPORT_URL, 'fragment'));
    handle.stop();
  });
});

describe('startMaskedLinkPrompt — concurrency with an async operation (capy pair shape)', () => {
  test('the listener keeps responding to keys while a concurrent "poll" is in flight, and stop() cleans up once it settles even though the user never pressed q', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const copy = mock(async (_text: string) => true);
    const handle = startMaskedLinkPrompt({
      fullUrl: PAIR_URL,
      maskedUrl: maskLink(PAIR_URL, 'query'),
      label: 'Approve on your other device:',
      stdin,
      stdout,
      copy,
    });

    // Simulate `pollDeviceToken`: a handful of pending ticks before it
    // resolves, standing in for the real interval-based device-grant poll.
    const poll = (async () => {
      await Promise.resolve();
      await Promise.resolve();
      return { token: 'jwt' };
    })();

    // While the "poll" is still pending, a keypress still reaches the
    // listener — proves it's event-driven, not blocked by/blocking the
    // concurrent await chain.
    stdin.emit('data', 'c');
    await Promise.resolve();
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);

    const result = await poll;
    expect(result).toEqual({ token: 'jwt' });

    // The user never pressed q/Enter/Esc — `done` has not resolved — but
    // the surrounding command still must clean up once its own await
    // settles, exactly like pairCommand's `finally { prompt?.stop(); }`.
    handle.stop();

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.listenerCount('data')).toBe(0);
  });
});
