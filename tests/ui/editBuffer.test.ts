/**
 * The shared typing rule of the two edit dialogs (`capy edit` and `capy secrets`)
 * and `capy edit`'s dialog itself with the shared Old value / New value layout
 * (ui/valueDialog.ts). Every printable key types, letters included; Ctrl+R reveals
 * the old value on screen only; there is no key that clears the field.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { KEY_CTRL_R, isRevealKey, printableOnly, stepEditBuffer } from '../../src/ui/editBuffer';
import { EditScreen, type EditState } from '../../src/ui/editScreen';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const CTRL_U = '\x15';
const OLD = 'SENTINEL-old-value-4242';
const NEW = 'SENTINEL-new-value-9999';

describe('stepEditBuffer', () => {
  test('letters (including r, e, c, u) are appended', () => {
    expect(stepEditBuffer('ab', 'c')).toBe('abc');
    expect(stepEditBuffer('', 'e')).toBe('e');
    expect(['r', 'e', 'c', 'u'].reduce(stepEditBuffer, '')).toBe('recu');
  });

  test('Backspace removes the last character; arrows change nothing; control characters are dropped', () => {
    expect(stepEditBuffer('abc', '\x7f')).toBe('ab');
    expect(stepEditBuffer('abc', '\x1b[A')).toBe('abc');
    expect(stepEditBuffer('abc', 'd\x07e')).toBe('abcde');
    expect(printableOnly('a\u0000b\x7fc')).toBe('abc');
  });

  test('no key clears the field: Ctrl+U (and Ctrl+R) are ignored by the buffer', () => {
    expect(stepEditBuffer('some secret', CTRL_U)).toBe('some secret');
    expect(stepEditBuffer('some secret', KEY_CTRL_R)).toBe('some secret');
    expect(isRevealKey(KEY_CTRL_R)).toBe(true);
    expect(isRevealKey('r')).toBe(false);
  });
});

describe("`capy edit`'s edit dialog", () => {
  const rowOf = (over: Partial<EditState['rows'][number]> = {}): EditState['rows'][number] => ({
    key: 'API_KEY',
    localValue: OLD,
    remoteValue: undefined,
    status: 'unknown',
    updatedLabel: '—',
    ...over,
  });
  const stateOf = (rows: EditState['rows'], extra: Partial<EditState> = {}): EditState => ({
    projectName: 'demo',
    branch: 'development',
    remoteAvailable: false,
    rows,
    ...extra,
  });

  /** Runs the real screen against fake keystrokes: a frame after each key, plus everything ever written and logged. */
  async function drive(state: EditState, keys: readonly string[]) {
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const lastWrite = (): string => String(outSpy.mock.calls[outSpy.mock.calls.length - 1]?.[0] ?? '');
    const screen = new EditScreen();
    const done = screen.run(state, { saveLocalEdits: async () => ({}) });
    const frames = keys.map((k) => {
      process.stdin.emit('data', Buffer.from(k));
      return strip(lastWrite());
    });
    process.stdin.emit('data', Buffer.from('\x03'));
    await done;
    const written = outSpy.mock.calls.map((c) => String(c[0])).join('');
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
    [outSpy, logSpy, errSpy].forEach((s) => s.mockRestore());
    return { frames, written, logged };
  }

  const line = (frame: string, label: string): string => frame.split('\n').find((l) => l.includes(label)) ?? '';

  test('opens with the field EMPTY: Old value masked, New value a placeholder, hint with ctrl+r reveal', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e']);
    const [frame] = frames;
    expect(frame).toContain('Old value');
    expect(frame).toContain('New value');
    expect(line(frame, 'New value')).toContain('new value');
    expect(frame).toContain('ctrl+r reveal');
    expect(frame).toContain('Enter save');
    expect(frame).not.toContain(OLD);
    expect(frame).not.toContain('ctrl+u');
    expect(line(frame, 'Old value')).toContain('•'.repeat(16));
    expect(frame).not.toContain('['); // no box around the input
  });

  test('both rows start their value at the same column, empty or typed', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', 'x']);
    const oldColumn = (frame: string) => line(frame, 'Old value').indexOf('•');
    expect(oldColumn(frames[0])).toBe(line(frames[0], 'New value').indexOf('new value')); // the placeholder
    expect(oldColumn(frames[1])).toBe(line(frames[1], 'New value').indexOf('•')); // the masked input
    expect(oldColumn(frames[0])).toBeGreaterThan(0);
  });

  test('typing replaces the placeholder (masked, with a count); r, e, c, u are just letters', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', 'r', 'e', 'c', 'u']);
    expect(line(frames[1], 'New value')).not.toContain('new value');
    expect(line(frames[1], 'New value')).toContain('•');
    expect(line(frames[4], 'New value')).toContain('(4 characters)');
    expect(frames.join('\n')).not.toContain('recu');
  });

  test('Ctrl+R shows the old value on screen and toggles it back; the hint follows', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', KEY_CTRL_R, KEY_CTRL_R]);
    expect(line(frames[1], 'Old value')).toContain(OLD);
    expect(frames[1]).toContain('ctrl+r hide');
    expect(frames[2]).not.toContain(OLD);
    expect(frames[2]).toContain('ctrl+r reveal');
  });

  test('Ctrl+U is ignored: it does not clear what was typed', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', 'a', 'b', CTRL_U]);
    expect(line(frames[3], 'New value')).toContain('(2 characters)');
  });

  test('a new variable: Old value says (none), Ctrl+R does nothing, no reveal hint', async () => {
    const state = stateOf([{ ...rowOf({ key: 'FRESH_VAR', localValue: undefined }) }], { focusKey: 'FRESH_VAR', entryKey: 'FRESH_VAR' });
    const { frames } = await drive(state, ['', KEY_CTRL_R]);
    expect(line(frames[0], 'Old value')).toContain('(none)');
    expect(line(frames[1], 'Old value')).toContain('(none)');
    expect(frames[1]).not.toContain('ctrl+r');
  });

  test('an existing variable with no readable value: a short coded note, and Ctrl+R does nothing', async () => {
    const { frames } = await drive(stateOf([rowOf({ localValue: undefined, remoteValue: undefined })]), ['e', KEY_CTRL_R]);
    expect(line(frames[0], 'Old value')).toContain('unavailable (VARIABLE_NOT_FOUND)');
    expect(line(frames[1], 'Old value')).toContain('unavailable (VARIABLE_NOT_FOUND)');
  });

  test('Enter on an empty box saves nothing; Esc cancels', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', '\r', '\x1b']);
    expect(frames[1]).toContain('New value'); // still in the dialog
    expect(frames[2]).not.toContain('New value');
  });

  test('the revealed old value and the typed value never reach stdout after the screen is left, nor any log', async () => {
    const { written, logged } = await drive(stateOf([rowOf()]), ['e', KEY_CTRL_R, ...NEW.split('')]);
    // Everything the screen wrote after it left the alternate screen must be free of both values.
    const exitAt = written.lastIndexOf('\x1b[?1049l');
    expect(exitAt).toBeGreaterThan(-1);
    const afterExit = written.slice(exitAt);
    [OLD, NEW].forEach((v) => {
      expect(afterExit).not.toContain(v);
      expect(logged).not.toContain(v);
    });
    // Revealed, both values may be drawn, but only inside the alternate screen (the check above).
    expect(written).toContain(OLD);
    expect(written).toContain(NEW);
  });

  test('Ctrl+R reveals the typed value too (one toggle for both rows); hidden, it is dots again', async () => {
    const { frames } = await drive(stateOf([rowOf()]), ['e', 'a', 'b', KEY_CTRL_R, KEY_CTRL_R]);
    expect(line(frames[2], 'New value')).toContain('••');
    expect(line(frames[3], 'New value')).toContain('ab');
    expect(line(frames[3], 'New value')).toContain('(2 characters)');
    expect(line(frames[3], 'Old value')).toContain(OLD);
    expect(line(frames[4], 'New value')).not.toContain('ab');
    expect(line(frames[4], 'Old value')).not.toContain(OLD);
  });

  test('a new variable: no hint until something is typed, then Ctrl+R reveals just the new value', async () => {
    const state = stateOf([{ ...rowOf({ key: 'FRESH_VAR', localValue: undefined }) }], { focusKey: 'FRESH_VAR', entryKey: 'FRESH_VAR' });
    const { frames } = await drive(state, ['', KEY_CTRL_R, 'h', 'i', KEY_CTRL_R]);
    expect(frames[0]).not.toContain('ctrl+r');
    expect(frames[1]).not.toContain('ctrl+r'); // nothing to reveal yet: the key does nothing
    expect(frames[3]).toContain('ctrl+r reveal');
    expect(line(frames[4], 'New value')).toContain('hi');
    expect(line(frames[4], 'Old value')).toContain('(none)');
    expect(frames[4]).toContain('ctrl+r hide');
  });

  test('an unreadable old value: the hint and the toggle come with typed text', async () => {
    const { frames } = await drive(stateOf([rowOf({ localValue: undefined, remoteValue: undefined })]), ['e', 'x', KEY_CTRL_R]);
    expect(frames[0]).not.toContain('ctrl+r');
    expect(frames[1]).toContain('ctrl+r reveal');
    expect(line(frames[2], 'New value')).toContain('x');
    expect(line(frames[2], 'Old value')).toContain('unavailable (VARIABLE_NOT_FOUND)');
  });
});
