/**
 * `src/ui/qrScreenLayout.ts` (CAP-692 follow-up, full-screen QR view) —
 * pure centering arithmetic, no I/O. Covers the fits/too-wide/too-tall
 * branches, odd/even padding rounding, footer placement, and the
 * ANSI/OSC-aware width measurement the real footer lines (a colored key
 * hint, an OSC 8 hyperlink) need.
 */
import { describe, test, expect } from 'bun:test';
import { layoutQrScreen, visibleWidth, type TerminalSize } from '../../src/ui/qrScreenLayout';
import { oscHyperlink } from '../../src/ui/osc8';

describe('visibleWidth', () => {
  test('plain text: counts characters', () => {
    expect(visibleWidth('hello')).toBe(5);
  });

  test('ignores ANSI SGR color codes', () => {
    expect(visibleWidth('\x1b[1;97mX\x1b[0m')).toBe(1);
    expect(visibleWidth('\x1b[90m(dim)\x1b[0m')).toBe(5);
  });

  test('ignores an OSC 8 hyperlink wrapper, counting only the visible text', () => {
    const wrapped = oscHyperlink('https://example.com/very/long/path', 'short');
    expect(visibleWidth(wrapped)).toBe(5);
  });

  test('empty string has zero width', () => {
    expect(visibleWidth('')).toBe(0);
  });
});

describe('layoutQrScreen — fits', () => {
  test('centers horizontally and vertically, blank separator between qr and footer', () => {
    const size: TerminalSize = { cols: 10, rows: 10 };
    const layout = layoutQrScreen(size, ['AB', 'CD'], ['X']);
    expect(layout.fits).toBe(true);
    // content = ['AB','CD','','X'] (4 lines) in a 10-row screen -> topPad = floor((10-4)/2) = 3.
    expect(layout.lines).toEqual(['', '', '', '    AB', '    CD', '', '    X']);
  });

  test('every footer line is centered independently, by its own width', () => {
    const size: TerminalSize = { cols: 20, rows: 20 };
    const layout = layoutQrScreen(size, ['##'], ['a', 'bb', 'ccc']);
    // Each non-empty line gets floor((20-width)/2) spaces of left padding.
    const nonBlank = layout.lines.filter((l) => l.trim().length > 0);
    expect(nonBlank).toEqual([
      `${' '.repeat(9)}##`,
      `${' '.repeat(9)}a`,
      `${' '.repeat(9)}bb`,
      `${' '.repeat(8)}ccc`,
    ]);
  });

  test('odd/even horizontal padding rounds down (left-biased)', () => {
    // cols=11 (odd) minus width=2 -> totalPad=9 (odd) -> left=floor(9/2)=4.
    const odd = layoutQrScreen({ cols: 11, rows: 100 }, ['AB'], []);
    expect(odd.lines.find((l) => l.includes('AB'))).toBe(`${' '.repeat(4)}AB`);

    // cols=12 (even) minus width=2 -> totalPad=10 (even) -> left=5.
    const even = layoutQrScreen({ cols: 12, rows: 100 }, ['AB'], []);
    expect(even.lines.find((l) => l.includes('AB'))).toBe(`${' '.repeat(5)}AB`);
  });

  test('odd/even vertical padding rounds down (top-biased)', () => {
    // content = ['Q', '', 'F'] -> 3 lines (qr + blank separator + one footer line).
    // rows=10 (diff: 10-3=7, odd) -> topPad = floor(7/2) = 3.
    const odd = layoutQrScreen({ cols: 20, rows: 10 }, ['Q'], ['F']);
    const firstContentIdx = odd.lines.findIndex((l) => l.includes('Q'));
    expect(firstContentIdx).toBe(3);

    // rows=11 (diff: 11-3=8, even) -> topPad = floor(8/2) = 4.
    const even = layoutQrScreen({ cols: 20, rows: 11 }, ['Q'], ['F']);
    const firstContentIdxEven = even.lines.findIndex((l) => l.includes('Q'));
    expect(firstContentIdxEven).toBe(4);
  });

  test('an empty spacer line is never padded (nothing to center about a blank line)', () => {
    const layout = layoutQrScreen({ cols: 40, rows: 40 }, ['Q'], ['F']);
    // The blank separator is the line right after the QR line among the
    // non-top-padding lines — it must stay exactly '', never spaces-only.
    const qrIdx = layout.lines.findIndex((l) => l.includes('Q'));
    expect(layout.lines[qrIdx + 1]).toBe('');
  });
});

describe('layoutQrScreen — does not fit', () => {
  test('too wide: no padding/centering at all, lines are the content as given', () => {
    const wide = 'Q'.repeat(50);
    const layout = layoutQrScreen({ cols: 10, rows: 100 }, [wide], ['footer']);
    expect(layout.fits).toBe(false);
    expect(layout.lines).toEqual([wide, '', 'footer']);
  });

  test('too tall: no padding/centering at all, lines are the content as given', () => {
    const qrLines = Array.from({ length: 10 }, (_, i) => `row${i}`);
    const layout = layoutQrScreen({ cols: 100, rows: 3 }, qrLines, ['footer']);
    expect(layout.fits).toBe(false);
    expect(layout.lines).toEqual([...qrLines, '', 'footer']);
  });

  test('too wide AND too tall still returns every line (never drops the QR)', () => {
    const qrLines = Array.from({ length: 5 }, () => 'X'.repeat(50));
    const layout = layoutQrScreen({ cols: 10, rows: 2 }, qrLines, ['footer']);
    expect(layout.fits).toBe(false);
    expect(layout.lines.length).toBe(qrLines.length + 1 + 1);
  });
});
