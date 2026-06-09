// CAP-55 regression: pasting a multi-line secret into the `capy edit` TUI must
// preserve newlines (so a PEM key pastes whole) rather than dropping them, and
// a multi-line buffer must still render on a single table row.
import { describe, it, expect } from 'bun:test';
import { sanitizePastedText, renderInlineValue } from '../../src/ui/editScreen';

describe('sanitizePastedText (CAP-55)', () => {
  it('preserves newlines in a pasted multi-line value', () => {
    const pem = '-----BEGIN-----\nabc\ndef\n-----END-----\n';
    expect(sanitizePastedText(pem)).toBe(pem);
  });

  it('folds CRLF and lone CR to LF', () => {
    expect(sanitizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps tabs but drops other control/escape characters', () => {
    // ESC (0x1b) and a stray bell (0x07) are stripped; tab and newline survive.
    expect(sanitizePastedText('a\tb\x1bc\x07\nd')).toBe('a\tbc\nd');
  });

  it('preserves non-ASCII printable characters', () => {
    expect(sanitizePastedText('café→π')).toBe('café→π');
  });
});

describe('renderInlineValue (CAP-55)', () => {
  it('collapses newlines to a single-line marker preserving length', () => {
    const out = renderInlineValue('a\nb\nc');
    expect(out).toBe('a↵b↵c');
    expect(out.length).toBe('a\nb\nc'.length);
  });

  it('renders tabs as spaces', () => {
    expect(renderInlineValue('a\tb')).toBe('a b');
  });

  it('leaves a single-line value untouched', () => {
    expect(renderInlineValue('sk_test_abc')).toBe('sk_test_abc');
  });
});
