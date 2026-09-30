const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string): readonly string[] => Array.from(segmenter.segment(text), item => item.segment);

/** Count terminal cells without splitting combining characters or emoji sequences. */
function graphemeWidth(text: string): number {
  if (/^[\p{Mark}\p{Format}]*$/u.test(text)) return 0;
  if (!text.includes('\ufe0e') && (/\p{Emoji_Presentation}/u.test(text) || text.includes('\ufe0f'))) return 2;
  const code = text.codePointAt(0)!;
  const wide = code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff01 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x16fe0 && code <= 0x18dff)
    || (code >= 0x1aff0 && code <= 0x1afff)
    || (code >= 0x1b000 && code <= 0x1b2ff)
    || (code >= 0x20000 && code <= 0x3fffd)
  );
  return wide ? 2 : 1;
}

export const terminalWidth = (text: string): number => graphemes(text).reduce((width, part) => width + graphemeWidth(part), 0);

export function clipTerminalText(text: string, width: number, fromEnd = false): string {
  const parts = graphemes(text);
  const ordered = fromEnd ? parts.toReversed() : parts;
  return ordered.reduce((state, part) => {
    const nextWidth = state.width + graphemeWidth(part);
    if (state.done || nextWidth > width) return { ...state, done: true };
    return { text: fromEnd ? part + state.text : state.text + part, width: nextWidth, done: false };
  }, { text: '', width: 0, done: false }).text;
}

export function wrapTerminalText(text: string, width: number): readonly string[] {
  const result = graphemes(text).reduce((state, part) => {
    const visible = graphemeWidth(part) > width ? '…' : part;
    const partWidth = graphemeWidth(visible);
    if (state.width + partWidth <= width) return { ...state, line: state.line + visible, width: state.width + partWidth };
    return { lines: [...state.lines, state.line], line: visible, width: partWidth };
  }, { lines: [] as readonly string[], line: '', width: 0 });
  return [...result.lines, result.line];
}
