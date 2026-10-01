/**
 * `capy edit [NAME]`: which mode an invocation is in (spec tests 1, 2, 7), the
 * stdin reader's rules (spec tests 4, 5, 6) and the TUI's focus on NAME.
 *
 * The spawned-cli tests for the same behaviour are tests/commands/editPiped.test.ts;
 * these are the cheap, exact ones around them.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { decideEditMode, type EditModeFacts } from '../../src/commands/editPiped';
import { MAX_PIPED_BYTES, interpretPipedBytes, readPipedValue } from '../../src/commands/pipedValue';
import { EditScreen, focusedOn, type EditRow, type EditState } from '../../src/ui/editScreen';

const facts = (over: Partial<EditModeFacts>): EditModeFacts => ({
  hasName: false,
  web: false,
  stdinIsTTY: false,
  nonTty: false,
  ...over,
});

describe('decideEditMode', () => {
  test('1. a terminal and no name is the full-table TUI, or the browser editor with --web: unchanged', () => {
    expect(decideEditMode(facts({ stdinIsTTY: true }))).toBe('tui');
    expect(decideEditMode(facts({ stdinIsTTY: true, web: true }))).toBe('web');
  });

  test('2. a terminal and a name is still the TUI (focused on NAME), or the browser editor with --web', () => {
    expect(decideEditMode(facts({ stdinIsTTY: true, hasName: true }))).toBe('tui');
    expect(decideEditMode(facts({ stdinIsTTY: true, hasName: true, web: true }))).toBe('web');
  });

  test('a name with stdin not a terminal is piped mode, and --web is ignored', () => {
    expect(decideEditMode(facts({ hasName: true }))).toBe('piped');
    expect(decideEditMode(facts({ hasName: true, web: true }))).toBe('piped');
  });

  test('7. no name and no terminal is refused (EDIT_NEEDS_TTY) - the hang this fixes', () => {
    expect(decideEditMode(facts({}))).toBe('refuse');
  });

  test('no name, no terminal, --web stays the headless browser editor agents have always used', () => {
    expect(decideEditMode(facts({ web: true }))).toBe('web');
  });

  test('--non-tty takes the terminal off the table even when stdin is one', () => {
    expect(decideEditMode(facts({ stdinIsTTY: true, nonTty: true }))).toBe('refuse');
    // a name with nothing piped to read: refused, not a read from the keyboard
    expect(decideEditMode(facts({ stdinIsTTY: true, nonTty: true, hasName: true }))).toBe('refuse');
    // a real pipe plus --non-tty is the normal agent invocation
    expect(decideEditMode(facts({ nonTty: true, hasName: true }))).toBe('piped');
  });
});

describe('interpretPipedBytes (spec test 4, 5)', () => {
  const ok = (bytes: string | Buffer) => interpretPipedBytes(Buffer.from(bytes));

  test('strips exactly one trailing LF or CRLF and nothing else', () => {
    expect(ok('v\n')).toEqual({ ok: true, value: 'v' });
    expect(ok('v\r\n')).toEqual({ ok: true, value: 'v' });
    expect(ok('a\n\n')).toEqual({ ok: true, value: 'a\n' });
    expect(ok('a\r\n\r\n')).toEqual({ ok: true, value: 'a\r\n' });
    expect(ok('  a  ')).toEqual({ ok: true, value: '  a  ' });
    expect(ok('a\rb')).toEqual({ ok: true, value: 'a\rb' });
    expect(ok('a\r')).toEqual({ ok: true, value: 'a\r' });
    expect(ok('-----BEGIN-----\nx\n\ny\n-----END-----\n')).toEqual({ ok: true, value: '-----BEGIN-----\nx\n\ny\n-----END-----' });
  });

  test('empty after stripping is STDIN_EMPTY', () => {
    expect(ok('')).toMatchObject({ ok: false, code: 'STDIN_EMPTY' });
    expect(ok('\n')).toMatchObject({ ok: false, code: 'STDIN_EMPTY' });
    expect(ok('\r\n')).toMatchObject({ ok: false, code: 'STDIN_EMPTY' });
    // two line endings leave one, which is a (blank) value, not nothing
    expect(ok('\n\n')).toEqual({ ok: true, value: '\n' });
  });

  test('NUL and invalid UTF-8 are INVALID_FORMAT', () => {
    expect(ok('a\u0000b')).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
    expect(ok(Buffer.from([0xff, 0xfe]))).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
  });

  test('refusals never carry the value', () => {
    const r = ok('SECRET_SENTINEL\u0000');
    expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL');
  });
});

describe('readPipedValue (spec test 6)', () => {
  test('reads a value split over many chunks, in order', async () => {
    const r = await readPipedValue(Readable.from([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef\n')]));
    expect(r).toEqual({ ok: true, value: 'abcdef' });
  });

  test('a multi-byte character split across chunks survives', async () => {
    const bytes = Buffer.from('日本語');
    const r = await readPipedValue(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]));
    expect(r).toEqual({ ok: true, value: '日本語' });
  });

  test('exactly the cap is accepted; one byte more is STDIN_TOO_LARGE', async () => {
    const at = await readPipedValue(Readable.from([Buffer.alloc(MAX_PIPED_BYTES, 0x61)]));
    expect(at.ok).toBe(true);
    const over = await readPipedValue(Readable.from([Buffer.alloc(MAX_PIPED_BYTES + 1, 0x61)]));
    expect(over).toMatchObject({ ok: false, code: 'STDIN_TOO_LARGE' });
  });

  test('stops reading as soon as the cap is passed: the rest of the stream is never consumed', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pulled = spyOn({ next: () => chunk }, 'next');
    // 10,000 chunks (~640 MB) on offer; the reader must not take them all.
    const source = (async function* () {
      for (const _ of Array.from({ length: 10_000 })) yield pulled();
    })();
    const r = await readPipedValue(source);
    expect(r).toMatchObject({ ok: false, code: 'STDIN_TOO_LARGE' });
    // cap / chunk = 16 chunks fit; the 17th crosses it; then reading stops.
    expect(pulled.mock.calls.length).toBeLessThanOrEqual(17);
  });

  test('a stream that errors reads as an empty value, and the error text is not forwarded', async () => {
    const failing = (async function* () {
      yield Buffer.from('partial');
      throw new Error('EBADF: secret-looking-detail');
    })();
    const r = await readPipedValue(failing);
    expect(r).toMatchObject({ ok: false, code: 'STDIN_EMPTY' });
    expect(JSON.stringify(r)).not.toContain('secret-looking-detail');
  });

  test('many tiny chunks stay fast and exact', async () => {
    const tiny = Array.from({ length: 20_000 }, (_, i) => Buffer.from(String(i % 10)));
    const r = await readPipedValue(Readable.from(tiny));
    expect(r.ok && r.value.length).toBe(20_000);
  });
});

describe('capy edit NAME on a terminal: the TUI starts on NAME (spec test 2)', () => {
  const row = (key: string, value: string): EditRow => ({
    key,
    localValue: value,
    remoteValue: value,
    status: 'in sync',
    updatedLabel: '—',
  });
  const base = (): EditState => ({
    projectName: 'demo',
    branch: 'production',
    rows: [row('ALPHA', 'a'), row('BRAVO', 'b'), row('CHARLIE', 'c')],
    remoteAvailable: true,
  });

  test('focusedOn: an existing name puts the cursor on its row and adds nothing', () => {
    const state = focusedOn(base(), 'BRAVO');
    expect(state.focusKey).toBe('BRAVO');
    expect(state.entryKey).toBeUndefined();
    expect(state.rows.map((r) => r.key)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
  });

  test('focusedOn: an unknown name adds a placeholder row in sorted position and opens its entry', () => {
    const state = focusedOn(base(), 'BETA');
    expect(state.rows.map((r) => r.key)).toEqual(['ALPHA', 'BETA', 'BRAVO', 'CHARLIE']);
    expect(state.focusKey).toBe('BETA');
    expect(state.entryKey).toBe('BETA');
    expect(state.rows.find((r) => r.key === 'BETA')?.localValue).toBeUndefined();
  });

  test('focusedOn does not touch the state it was given', () => {
    const original = base();
    const before = JSON.stringify(original);
    focusedOn(original, 'ZULU');
    expect(JSON.stringify(original)).toBe(before);
  });

  /** Draws the screen once, quits it, and returns the first frame. */
  async function firstFrame(state: EditState): Promise<string> {
    const write = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      const done = new EditScreen().run(state, { saveLocalEdits: async () => ({}) });
      process.stdin.emit('data', Buffer.from('\x03')); // Ctrl-C: leave without saving
      await done;
      const frames = write.mock.calls.map((c) => String(c[0]));
      return frames.find((f) => f.includes('capy edit')) ?? '';
    } finally {
      write.mockRestore();
    }
  }
  const INVERSE = '\x1b[7m';
  const highlightedLine = (frame: string): string => frame.split('\n').find((l) => l.includes(INVERSE)) ?? '';

  test('regression: with no name the cursor starts on the first row, as before', async () => {
    const frame = await firstFrame(base());
    expect(highlightedLine(frame)).toContain('ALPHA');
  });

  test('with a name the cursor starts on that row', async () => {
    const frame = await firstFrame(focusedOn(base(), 'CHARLIE'));
    expect(highlightedLine(frame)).toContain('CHARLIE');
    expect(highlightedLine(frame)).not.toContain('ALPHA');
  });

  test('an unknown name opens its value entry, pre-filled with the name', async () => {
    const frame = await firstFrame(focusedOn(base(), 'DELTA'));
    expect(frame).toContain('DELTA');
    expect(frame).toContain('> _'); // the empty value entry is open
  });
});
