/**
 * The typing half of a value entry, shared by `capy edit`'s edit dialog and the
 * `capy secrets` edit dialog (the layout is in ./valueDialog): one key in, the new
 * buffer out. Pure.
 *
 *   Backspace   removes the last character
 *   an escape sequence (arrows etc.) and any other control key changes nothing
 *   anything else: its printable characters are appended
 *
 * Every printable key types, letters included (`r`, `e`, `c`, `u` are just
 * letters here). The only keys that act as controls are Ctrl+R (reveal the old
 * value, see `isRevealKey`), Enter, Esc, Backspace and a bracketed paste, and the
 * dialog that owns the buffer decides what Enter and Esc do. There is no key that
 * clears the field: it starts empty.
 */
const ESC = '\x1b';

/** Ctrl+R: show or hide the old value. */
export const KEY_CTRL_R = '\x12';

export const isRevealKey = (key: string): boolean => key === KEY_CTRL_R;

/** The printable characters of `chunk` (control characters and DEL dropped). */
export function printableOnly(chunk: string): string {
  return Array.from(chunk)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}

export function stepEditBuffer(buffer: string, key: string): string {
  if (key === '\x7f' || key === '\b') return buffer.slice(0, -1);
  if (key.startsWith(ESC)) return buffer;
  return buffer + printableOnly(key);
}
