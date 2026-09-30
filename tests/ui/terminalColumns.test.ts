import { describe, expect, it } from 'bun:test';
import { clipTerminalText, terminalWidth, wrapTerminalText } from '../../src/ui/terminalColumns';

describe('terminal columns', () => {
  it('measures wide characters, combining text, and emoji clusters', () => {
    expect(terminalWidth('王小明')).toBe(6);
    expect(terminalWidth('Cafe\u0301')).toBe(4);
    expect(terminalWidth('👩‍💻🇨🇦1️⃣')).toBe(6);
  });
  it('clips whole graphemes from either end', () => {
    expect(clipTerminalText('王小明', 3)).toBe('王');
    expect(clipTerminalText('王小明', 3, true)).toBe('明');
    expect(clipTerminalText('e\u0301👩‍💻x', 3)).toBe('e\u0301👩‍💻');
    expect(clipTerminalText('e\u0301👩‍💻x', 2, true)).toBe('x');
  });
  it('wraps at terminal columns without breaking graphemes', () => {
    expect(wrapTerminalText('王小明', 4)).toEqual(['王小', '明']);
    expect(wrapTerminalText('e\u0301👩‍💻x', 3)).toEqual(['e\u0301👩‍💻', 'x']);
    expect(wrapTerminalText('a王b', 1)).toEqual(['a', '…', 'b']);
  });
});
